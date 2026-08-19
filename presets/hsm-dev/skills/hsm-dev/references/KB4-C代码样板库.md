# KB4 · C 代码样板库

> 本文件的代码有两类，**已明确标注，不要混用**：
>
> * **【官方序列】** —— 调用顺序与参数取自厂商示例 `test.c` / `testSDF.cpp`（标注了源文件行号），
>   是真机上跑通过的；本文件在此基础上补了错误处理与资源释放。
> * **【按签名推导】** —— 厂商示例里没有的功能，仅按 `sdf.h` 签名编写，**上线前必须真机验证**。
>
> **本文件所有代码已用 `clang -fsyntax-only` 针对真实 `sdf.h` 做过语法与签名校验**
> （校验的是参数个数/类型是否与头文件一致，不代表运行期语义正确）。

---

## 一、工程骨架

### 1.1 统一头文件（解决 `size_t` 编译失败）

```c
/* hsm.h —— 项目内统一入口，所有用到密码机的文件都 include 这个，不要直接 include sdf.h */
#ifndef PROJECT_HSM_H
#define PROJECT_HSM_H

#include <stddef.h>     /* 必须在 sdf.h 之前：sdf.h 用了 size_t 却不自带任何 include */
#include <stdio.h>
#include <string.h>
#include "sdf.h"

/* 统一错误检查：单出口 + 对 SDR_NOTSUPPORT 特别提示 */
#define HSM_CHECK(call) do {                                                       \
    ret = (call);                                                                  \
    if (ret != SDR_OK) {                                                           \
        fprintf(stderr, "[HSM] %s 失败 ret=0x%08x%s\n", #call, ret,                \
                (ret == (int)SDR_NOTSUPPORT)                                       \
                  ? "  (不支持——先确认该接口是否为本版本库的未实现桩)" : "");      \
        goto cleanup;                                                              \
    }                                                                              \
} while (0)

#endif
```

### 1.2 最小可运行骨架【官方序列，test.c:697-753 / 2192-2204】

```c
#include "hsm.h"

int main(void)
{
    int   ret        = SDR_OK;
    void *hDev       = NULL;
    void *hSes       = NULL;
    unsigned char rnd[32] = {0};

    /* 1) 指定密码机地址。比依赖 serverip.ini 可靠得多，见 KB6 第九节 */
    HSM_CHECK(SDF_SetHSM_ex((unsigned char *)"10.50.89.155", 8880));

    /* 2) 设备 → 会话 */
    HSM_CHECK(SDF_OpenDevice(&hDev));
    HSM_CHECK(SDF_OpenSession(hDev, &hSes));

    /* 3) 冒烟：取 32 字节随机数。这也是健康检查的正确做法
     *    —— SDF_DevStatus 是空桩，不能用来判断设备是否可用 */
    HSM_CHECK(SDF_GenerateRandom(hSes, sizeof(rnd), rnd));
    printf("随机数取到 %zu 字节，首字节 0x%02x\n", sizeof(rnd), rnd[0]);

cleanup:
    /* 4) 逆序释放。注意：不要重复关闭，厂商示例里第二次 Close 是被刻意注释掉的 */
    if (hSes) SDF_CloseSession(hSes);
    if (hDev) SDF_CloseDevice(hDev);
    return ret;
}
```

**关于 `SDF_LoadLib()`**：不需要调用。两个官方示例都没调过它，而且它在本版本库里是空桩
（调了还会返回非 0，反而把正常流程判成失败）。

**多设备**：一个进程连两台密码机的做法是**用不同配置文件各开一个 Device 句柄**
（`SDF_OpenDeviceWithCfg(&hDev2, "/path/flkConfig2.ini")`），厂商示例里有注释掉的范例。

**多线程**【官方序列，test.c:2213-2552】：**每线程各自 `SDF_OpenDevice` + `SDF_OpenSession`，
句柄是线程私有局部变量，不共享**。这不只是性能考虑——杂凑上下文挂在 session 上，
共享 session 会直接报 `SDR_STEPERR`。

---

## 二、SM2 / ECC

### 2.1 完整签名验签流程【官方序列，test.c:838-925】

```c
int sm2_sign_verify_demo(void *hSes)
{
    int ret = SDR_OK;
    unsigned int  keyIndex = 1;                       /* 用户密钥从 1 开始 */
    int gotRight = 0;
    ECCrefPublicKey  pubSign;
    ECCSignature     sig;
    unsigned char hash[64] = {0};
    unsigned int  hashLen  = sizeof(hash);
    const char   *msg = "hello, hsm";
    /* SM2 默认签名者 ID。⚠️ 国标默认是 "1234567812345678"，
     * 而厂商示例用的是 "0123456789abcdef"——两端必须一致，否则验签必失败 */
    const char   *sm2id = "1234567812345678";

    memset(&pubSign, 0, sizeof(pubSign));
    memset(&sig, 0, sizeof(sig));

    /* 1) 取私钥使用权限（口令不少于 8 字节） */
    HSM_CHECK(SDF_GetPrivateKeyAccessRight(hSes, keyIndex,
                                           (unsigned char *)"11111111", 8));
    gotRight = 1;

    /* 2) 导出签名公钥——ZA 必须用签名者自己的公钥算 */
    HSM_CHECK(SDF_ExportSignPublicKey_ECC(hSes, keyIndex, &pubSign));

    /* 3) 三步式杂凑，带 ZA：把公钥和 ID 交给 HashInit，ZA 由库内部算
     *    HashUpdate 只喂业务原文，不要自己拼 ZA */
    HSM_CHECK(SDF_HashInit(hSes, SGD_SM3, &pubSign,
                           (unsigned char *)sm2id, (unsigned int)strlen(sm2id)));
    HSM_CHECK(SDF_HashUpdate(hSes, (unsigned char *)msg, (unsigned int)strlen(msg)));
    HSM_CHECK(SDF_HashFinal(hSes, hash, &hashLen));

    /* ⚠️ 厂商示例在这里硬编码 hashLen=32（test.c:888），说明它不信任 HashFinal 的回填。
     *    与其硬编码，不如断言——不对就立刻暴露，而不是签出一个错的东西 */
    if (hashLen != 32) {
        fprintf(stderr, "[HSM] SM3 摘要长度异常: %u（期望 32）\n", hashLen);
        ret = SDR_LENGTHERR;
        goto cleanup;
    }

    /* 4) 内部私钥签名：传的是 32 字节摘要，不是原文 */
    HSM_CHECK(SDF_InternalSign_ECC(hSes, keyIndex, hash, hashLen, &sig));

    /* 5) 两种验签都可以：设备内部公钥验，或用导出的公钥验 */
    HSM_CHECK(SDF_InternalVerify_ECC(hSes, keyIndex, hash, hashLen, &sig));
    HSM_CHECK(SDF_ExternalVerify_ECC(hSes, SGD_SM2_1, &pubSign, hash, hashLen, &sig));

    printf("SM2 签名验签通过\n");

cleanup:
    if (gotRight) SDF_ReleasePrivateKeyAccessRight(hSes, keyIndex);
    return ret;
}
```

**把签名值交给外部系统**：`sig.r` / `sig.s` 各 64 字节，**有效数据在 `[32..63]`**：

```c
unsigned char r32[32], s32[32];
memcpy(r32, sig.r + 32, 32);
memcpy(s32, sig.s + 32, 32);
/* 或者直接转 DER，跨系统更稳： */
unsigned char der[256]; unsigned int derLen = sizeof(der);
SDF_EncodeECCSignature(&sig, der, &derLen);
```

### 2.2 SM2 加解密【官方序列，test.c:925-968】

```c
int sm2_enc_dec_demo(void *hSes)
{
    int ret = SDR_OK;
    unsigned int keyIndex = 1;
    int gotRight = 0;
    ECCrefPublicKey pubEnc;
    ECCCipher       cipher;                 /* 300 字节定长结构，栈上分配即可 */
    unsigned char   plain[256] = {0};
    unsigned int    plainLen   = sizeof(plain);
    const char     *msg = "session-key-16by";   /* SM2 单次加密上限 136 字节 */

    memset(&pubEnc, 0, sizeof(pubEnc));
    memset(&cipher, 0, sizeof(cipher));

    /* 加密用「加密公钥」，与签名公钥是同一索引下的两把不同钥匙 */
    HSM_CHECK(SDF_ExportEncPublicKey_ECC(hSes, keyIndex, &pubEnc));

    /* 算法标识：加解密用 SGD_SM2_3，签名才用 SGD_SM2_1 */
    HSM_CHECK(SDF_ExternalEncrypt_ECC(hSes, SGD_SM2_3, &pubEnc,
                                      (unsigned char *)msg, (unsigned int)strlen(msg),
                                      &cipher));

    /* 用设备内部私钥解密，需要先取权限 */
    HSM_CHECK(SDF_GetPrivateKeyAccessRight(hSes, keyIndex,
                                           (unsigned char *)"11111111", 8));
    gotRight = 1;
    HSM_CHECK(SDF_InternalDecrypt_ECC(hSes, keyIndex, &cipher, plain, &plainLen));

    printf("SM2 解密得到 %u 字节: %.*s\n", plainLen, (int)plainLen, plain);

cleanup:
    if (gotRight) SDF_ReleasePrivateKeyAccessRight(hSes, keyIndex);
    return ret;
}
```

> **密文要发给第三方**：`ECCCipher` 是本 SDK 私有布局，必须先 `SDF_EncodeECCCipher` 转 DER。
> ⚠️ openApi 那边用的是 **C1C3C2 连续字节串**，与本结构体不通用（KB2 第 2.3 节）。

### 2.3 用外部 32 字节密钥做运算【官方序列，test.c:1934-1938】

```c
/* 外部 SM2 私钥（32 字节）→ SDK 结构体：有效数据右对齐放在 [32..63] */
ECCrefPrivateKey prv;
memset(&prv, 0, sizeof(prv));
memcpy(prv.D + 32, d32, 32);        /* ← +32 是关键，KB2 第一节 */
prv.bits = 256;
ret = SDF_ExternalDecrypt_ECC(hSes, SGD_SM2_3, &prv, &cipher, plain, &plainLen);
```

---

## 三、对称加解密

### 3.1 会话密钥的六种来源【官方序列，test.c:998-1379 / 2089】

```c
void *hKey = NULL;
unsigned char keyCipher[256] = {0};
unsigned int  keyCipherLen   = sizeof(keyCipher);   /* in/out：入参是缓冲区容量 */
ECCCipher     eccKey;

/* ① KEK 包装生成（最常用）
 *    ⚠️ 这里的 SGD_SM1_ECB 是「包装算法」，与后面业务加密用的算法无关 */
ret = SDF_GenerateKeyWithKEK(hSes, 128, SGD_SM1_ECB, 1,
                             keyCipher, &keyCipherLen, &hKey);

/* ② 对端用同一 KEK 解包，得到同一把会话密钥（注意长度是「值」不是指针） */
ret = SDF_ImportKeyWithKEK(hSes, SGD_SM1_ECB, 1, keyCipher, keyCipherLen, &hKey);

/* ③ 明文导入——密钥字节数决定算法族：8=DES / 16=SM4·AES128 / 24=3DES */
ret = SDF_ImportKey(hSes, (unsigned char *)"zxcvbnmasdfghjkl", 16, &hKey);

/* ④ 内部 ECC 公钥包装生成 */
memset(&eccKey, 0, sizeof(eccKey));
ret = SDF_GenerateKeyWithIPK_ECC(hSes, 1, 128, &eccKey, &hKey);

/* ⑤ 外部 ECC 公钥包装生成，对端用内部私钥导入 */
ret = SDF_GenerateKeyWithEPK_ECC(hSes, 128, SGD_SM2_3, &pubEnc, &eccKey, &hKey);
ret = SDF_ImportKeyWithISK_ECC(hSes, 1, &eccKey, &hKey);

/* ⑥ 直接取设备内部对称密钥句柄 */
ret = SDF_GetSymmKeyHandle(hSes, 1, &hKey);

/* 用完必须销毁。用 SDF_DestroyKey，不要用被标了「弃用」的 SDF_DestoryKey
 * （尽管厂商示例通篇在用那个错拼版本） */
SDF_DestroyKey(hSes, hKey);
```

### 3.2 SM4-CBC 加解密 + 填充【官方序列，test.c:20-39 / 1057-1069】

```c
/* 官方示例自带的 16 字节块 PKCS#7 填充（注释里写作 PKCS#5，实为 PKCS#7） */
static int hsm_pad(unsigned char *buf, unsigned int *len)
{
    unsigned int v = 16 - (*len % 16);
    memset(buf + *len, (int)v, v);
    *len += v;
    return 0;
}
static int hsm_unpad(unsigned char *buf, unsigned int *len)
{
    unsigned int v;
    if (*len == 0 || (*len % 16) != 0) return -1;
    v = buf[*len - 1];
    /* ⚠️ 官方版写的是 (v > 16 || v < 0)，而 v 是无符号，「< 0」恒假，
     *    填充值为 0 时不会被拦截。这里改成 v == 0 也拦截 */
    if (v == 0 || v > 16) return -1;
    *len -= v;
    memset(buf + *len, 0, v);
    return 0;
}

int sm4_cbc_demo(void *hSes, void *hKey)
{
    int ret = SDR_OK;
    unsigned char iv[16];
    unsigned char plain[64]  = {0};
    unsigned char cipher[128] = {0};
    unsigned int  plainLen, cipherLen = sizeof(cipher), outLen = sizeof(plain);

    strcpy((char *)plain, "12345678abcdefgh");
    plainLen = (unsigned int)strlen((char *)plain);
    hsm_pad(plain, &plainLen);              /* 库不做填充，必须自己补齐到 16 的倍数 */

    memset(iv, 0x01, sizeof(iv));           /* ← 加密前设 IV */
    HSM_CHECK(SDF_Encrypt(hSes, hKey, SGD_SMS4_CBC, iv,
                          plain, plainLen, cipher, &cipherLen));

    memset(iv, 0x01, sizeof(iv));           /* ← ★ 解密前必须重置！库把 IV 原地改写了 */
    HSM_CHECK(SDF_Decrypt(hSes, hKey, SGD_SMS4_CBC, iv,
                          cipher, cipherLen, plain, &outLen));
    hsm_unpad(plain, &outLen);

    printf("SM4-CBC 往返成功，明文 %u 字节\n", outLen);
cleanup:
    return ret;
}
```

**ECB 模式的 IV 传 `NULL`**：`SDF_Encrypt(hSes, hKey, SGD_SMS4_ECB, NULL, ...)`。

### 3.3 大文件流式加密【官方序列，test.c:505-631】

关键差别：**IV 只在循环外设置一次，循环内不重置**——靠库对 IV 的原地更新实现跨块 CBC 链接，
**只有最后一块做填充**。

```c
#define CHUNK (1024 * 1024)

int sm4_encrypt_file(void *hSes, void *hKey, FILE *in, FILE *out)
{
    int ret = SDR_OK;
    unsigned char *buf = NULL, *enc = NULL;
    unsigned char iv[16];
    size_t n;

    buf = (unsigned char *)malloc(CHUNK + 32);
    enc = (unsigned char *)malloc(CHUNK + 32);
    if (!buf || !enc) { ret = SDR_MEMORY_ERR; goto cleanup; }

    memset(iv, 0x01, sizeof(iv));            /* ★ 只设一次 */

    while ((n = fread(buf, 1, CHUNK, in)) > 0) {
        unsigned int inLen  = (unsigned int)n;
        unsigned int outLen = CHUNK + 32;
        if (n < CHUNK) hsm_pad(buf, &inLen);         /* 只有最后一块填充 */
        HSM_CHECK(SDF_Encrypt(hSes, hKey, SGD_SMS4_CBC, iv, buf, inLen, enc, &outLen));
        fwrite(enc, 1, outLen, out);                 /* 循环内不动 iv */
    }

cleanup:
    free(buf);
    free(enc);
    return ret;
}
```

### 3.4 MAC 与 HMAC【官方序列，test.c:1199 / 1908】

```c
/* MAC：走密钥句柄，算法用 *_MAC 系列，同样吃 IV */
unsigned char mac[64]; unsigned int macLen = sizeof(mac);
unsigned char iv[16]; memset(iv, 0x00, sizeof(iv));
ret = SDF_CalculateMAC(hSes, hKey, SGD_SMS4_MAC, iv,
                       (unsigned char *)"12345678abcdefgh", 16, mac, &macLen);

/* HMAC-SM3：密钥来自 KEK 索引，不是外部传入；算法必须是 SGD_SM3 */
unsigned char hmac[64]; unsigned int hmacLen = sizeof(hmac);
ret = SDF_Hmac_ex(hSes, SGD_SM3, /*uiKEKIndex=*/1,
                  (unsigned char *)"data", 4, hmac, &hmacLen);
```

⚠️ **不要用 `SGD_AES_MAC` 区分 AES 的 MAC 与 CTR**——两个宏值撞了（KB2 第 3.1 节）。

---

## 四、其它常用场景

### 4.1 纯杂凑（不带 ZA）【官方序列，test.c:1387】

```c
unsigned char h[64]; unsigned int hLen = sizeof(h);
ret = SDF_HashInit(hSes, SGD_SM3, NULL, NULL, 0);      /* ← 后三个参数传空 */
ret = SDF_HashUpdate(hSes, (unsigned char *)"abc", 3);
ret = SDF_HashFinal(hSes, h, &hLen);
```

同一 session 上**同时只能有一个杂凑运算在跑**（上下文挂在 session 上，没有独立 ctx 句柄）。

### 4.2 列出设备里实际有哪些密钥索引【官方序列，test.c:1980-2008】

**接入第一天就该跑这个**，比照着文档猜索引可靠：

```c
unsigned int keynums = 100;                 /* in/out：入参是数组容量，每次调用前重置 */
unsigned int keyids[100] = {0};
/* keyType: 1=RSA 2=SM2 3=对称 ; keyUsage: 0=签名 1=加密 */
ret = SDIF_ListKey(hSes, 1, 2, 0, &keynums, keyids);    /* SM2 签名密钥 */
for (unsigned int i = 0; i < keynums; i++) printf("SM2 签名密钥索引: %u\n", keyids[i]);

keynums = 100;                              /* ★ 必须重置 */
ret = SDIF_ListKey(hSes, 1, 3, 1, &keynums, keyids);    /* 对称密钥 */
```

### 4.3 设备能力自检【按签名推导 + 官方结构】

比"调一遍看错误码"可靠：

```c
DEVICEINFO di;
memset(&di, 0, sizeof(di));
ret = SDF_GetDeviceInfo(hSes, &di);
printf("厂商: %.40s  型号: %.16s  序列号: %.16s\n",
       di.IssuerName, di.DeviceName, di.DeviceSerial);
printf("支持 SM4-CBC : %s\n", (di.SymAlgAbility  & SGD_SMS4_CBC) ? "是" : "否");
printf("支持 SM1-ECB : %s\n", (di.SymAlgAbility  & SGD_SM1_ECB)  ? "是" : "否");
printf("支持 SM3     : %s\n", (di.HashAlgAbility & SGD_SM3)      ? "是" : "否");
printf("支持 SM2     : %s\n", (di.AsymAlgAbility[0] & SGD_SM2)   ? "是" : "否");
```

### 4.4 CTR 模式与数据库密钥【官方序列，test.c:1928-1961】

这组接口**不用句柄也不用索引，用 KeyID 字符串寻址**，与其它对称接口完全不同：

```c
unsigned char ctr[16];
unsigned char enc[1024]; unsigned int encLen = sizeof(enc);
unsigned char dec[1024]; unsigned int decLen = sizeof(dec);

memset(ctr, 0x31, sizeof(ctr));
ret = SDF_Encrypt_CTR(hSes, (unsigned char *)"demokey2", 8, ctr, sizeof(ctr),
                      data, dataLen, enc, &encLen);

memset(ctr, 0x31, sizeof(ctr));    /* ★ 与 IV 同理，解密前必须重置计数器 */
ret = SDF_Decrypt_CTR(hSes, (unsigned char *)"demokey2", 8, ctr, sizeof(ctr),
                      enc, encLen, dec, &decLen);
```

加解密两侧签名对称，都是 9 个参数：
`(hSes, pucKeyID, uiKeyIDLen, pucCount, uiCountLen, 输入, 输入长, 输出, &输出长)`。
配套的 `SDF_GetKey_ex(hSes, pucKeyID, uiKeyIDLen, &eccEncKey)` 用同一套 KeyID 体系取数据库加密密钥。

### 4.5 设备内文件区【官方序列，test.c:1502-1530】

```c
unsigned char *name = (unsigned char *)"flk.txt";
unsigned int   nameLen = (unsigned int)strlen((char *)name);   /* 不含结尾 \0 */
unsigned int   fileLen = 5;
unsigned char  buf[64] = {0};

ret = SDF_CreateFile(hSes, name, nameLen, 1024);   /* 已存在会返回 SDR_FILEEXISTS，可忽略 */
ret = SDF_WriteFile(hSes, name, nameLen, 0, 10, (unsigned char *)"0123456789");
ret = SDF_ReadFile(hSes, name, nameLen, 5, &fileLen, buf);  /* 偏移 5 读 5 字节 → "56789" */
ret = SDF_DeleteFile(hSes, name, nameLen);
```

⚠️ `WriteFile` 的长度是**值传递**，`ReadFile` 的是**指针（in/out）**——一字之差，别传错。

### 4.6 密钥协商三步【官方序列，test.c:1581-1613】

```c
void *hAgree = NULL, *hKeySponsor = NULL, *hKeyResponse = NULL;
ECCrefPublicKey spPub, spTmp, rsPub, rsTmp;
/* ① 发起方 */
ret = SDF_GenerateAgreementDataWithECC(hSes, 1, 128,
        (unsigned char *)"0123456789abcdef", 16, &spPub, &spTmp, &hAgree);
/* ② 响应方（真实场景在对端）——注意响应方 ID 在前、发起方 ID 在后 */
ret = SDF_GenerateAgreementDataAndKeyWithECC(hSes, 1, 128,
        (unsigned char *)"fedcba9876543210", 16,
        (unsigned char *)"0123456789abcdef", 16,
        &spPub, &spTmp, &rsPub, &rsTmp, &hKeyResponse);
/* ③ 发起方拿到响应方参数后计算出同一把密钥 */
ret = SDF_GenerateKeyWithECC(hSes, (unsigned char *)"fedcba9876543210", 16,
        &rsPub, &rsTmp, hAgree, &hKeySponsor);
/* 验证：用一把加密、另一把解密能还原，就说明协商成功 */
```

⚠️ `hAgree` **在头文件里找不到任何销毁函数**——高频协商场景必须向厂商确认怎么释放，
否则会积累到 `FLK_ERR_CONN_LIMIT`。

---

## 五、构建

### 5.1 厂商 Makefile 与它的坑

厂商版本（`Linux/Makefile`）关键一行：

```make
test: test.c
	$(CC) $(CFLAGS) $^ -o $@ -ldl -L. ./$(SDFSO)
```

它把 **`./libflk-x86.so` 这个带 `./` 的相对路径直接作为链接对象**，
这个字符串会原样写进可执行文件的 `DT_NEEDED`。
**后果：进程必须在含 .so 的目录下启动，`LD_LIBRARY_PATH` 也救不回来。**

另外厂商 Makefile 只认 `x86_64` 与 `aarch64` 两种 `uname -m`，
**`armv7l`、`loongarch64` 会直接报"不支持的架构"**。

### 5.2 生产用 Makefile（改掉上面的坑）

```make
CC      := gcc
CFLAGS  := -Wall -O2 -pthread -I.
ARCH    := $(shell uname -m)

ifeq ($(ARCH),x86_64)
    SDFLIB := flk-x86
else ifeq ($(ARCH),aarch64)
    SDFLIB := flk-arm
else
    $(error 不支持的架构: $(ARCH)。SDK 只提供 x86_64 与 aarch64 两个构建)
endif

# -l 形式 + $$ORIGIN，让可执行文件按「自身所在目录」找 .so，不再依赖当前工作目录
LDFLAGS := -L$(CURDIR) -l$(SDFLIB) -ldl -Wl,-rpath,'$$ORIGIN'

app: app.c
	$(CC) $(CFLAGS) $^ -o $@ $(LDFLAGS)

verify: app
	@echo "== 检查动态库依赖是否为 soname 而非 ./ 相对路径 =="
	@readelf -d app | grep NEEDED

clean:
	-rm -f app
```

> `-l$(SDFLIB)` 要求库文件名形如 `libflk-x86.so`——随包交付的正是这个名字，可直接用。

### 5.3 Windows

* 链接 `SDF.lib`（**它是 `SDF.dll` 的导入库，不是静态库**），运行期需要 `SDF.dll` 在 exe 目录或 PATH 上。
* 调用约定 **`__cdecl`**（头文件没有任何 `__stdcall`/`WINAPI`）。
* **不要定义 `SDF_EXPORTS`** ——那个宏只给编译 DLL 本身时用，定义了会把 `dllimport` 变成 `dllexport`。
* `SDF.dll` 依赖 `WS2_32`（证实是网络型密码机客户端）等系统库。
* 厂商 Windows 示例会打印"当前程序执行目录"，因为 SDK 要在 **exe 所在目录**找 `serverip.ini`。

### 5.4 上线前必做：空桩冒烟表

**这一步不能省。** 本 SDK 有 21 个函数是恒返回 `SDR_NOTSUPPORT` 的空桩，
而且"不在那张表里"也不等于"一定有实现"（KB6 第二节说明了检测方法的边界）。

做法：把项目要用到的每个 SDF 函数，用最小合法参数在真机上调一次，记录返回值：

```c
struct { const char *name; int ret; } smoke[] = {
    { "SDF_GenerateRandom",   SDF_GenerateRandom(hSes, 8, tmp) },
    { "SDF_GetDeviceInfo",    SDF_GetDeviceInfo(hSes, &di) },
    { "SDF_ExportSignPublicKey_ECC", SDF_ExportSignPublicKey_ECC(hSes, 1, &pub) },
    /* …把你要用的都列上… */
};
for (size_t i = 0; i < sizeof(smoke)/sizeof(smoke[0]); i++)
    printf("%-40s %s (0x%08x)\n", smoke[i].name,
           smoke[i].ret == SDR_OK ? "可用" :
           smoke[i].ret == (int)SDR_NOTSUPPORT ? "★未实现（空桩）" : "失败",
           smoke[i].ret);
```

**凡是打出"★未实现"的，立刻从设计里划掉，另找替代路径**（管理工具 / openApi / 换接口）。
在设计阶段花十分钟做这件事，比在联调期花三天查"为什么这个接口总是返回 2"划算得多。

---

## 六、厂商示例里**不要照抄**的几处

这几处在 `test.c` 里确实存在，抄进生产代码会出问题：

1. **错误处理直接 `return ret`**（case 4–9）——不关会话、不销毁句柄，是句柄泄漏的现成模板。
   用本文件的 `goto cleanup` 单出口。
2. **`SDF_DestoryKey`（拼写错误版）被用了 13 处**——头文件已把它标为「弃用」，新代码用 `SDF_DestroyKey`。
3. **`test.c:688` 把 `puiEncDataLength` 设成 10240，而 `pucEncData` 只有 1024 字节**——缓冲区不一致。
4. **`hashlen = 32;` 硬编码**（test.c:888）——改成断言，长度不对就报错，别默默签一个错的摘要。
5. **ZA 用外部公钥算、却拿去做内部私钥签名**（test.c:866 → 904）——密码学上不一致，
   示例能"通过"只是因为设备对传入的 32 字节摘要做原始签名、不重算 ZA。真实业务必须用签名者自己的公钥。
6. **`sm4_pboc_unpadding` 的 `(v > 16 || v < 0)` 判断**——`v` 是无符号，`< 0` 恒假，填充值 0 漏检。
7. **菜单 15/16 是死代码**——源文件里注释与 `if` 挤在同一物理行（编码转换事故），
   导致那两个分支永远走不到密码运算。看到那两段"没反应"不是设备问题。
8. **多线程 main 只 join 最后一个线程**，且 `switch` 各 case 刻意不写 `break` 做贯穿压测——不是正常写法。

> 顺带一提：`test.c` 是 **GBK 与 UTF-8 混合编码**的文件（第 2074–2188 行是 UTF-8，其余是 GBK），
> `sdf.h` 是 **UTF-8 with BOM**，`testSDF.cpp` 是纯 GBK + CRLF。
> **整体批量转码会破坏文件**，改造前先按行判定编码。
