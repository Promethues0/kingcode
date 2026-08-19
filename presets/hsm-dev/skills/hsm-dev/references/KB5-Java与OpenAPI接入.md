# KB5 · Java 与 openApi 两条非 C 接入路线

> C 语言之外，这台密码机还有两条接入路线，**性质完全不同，不要混为一谈**：
>
> | 路线 | 形态 | 密码运算在哪 | 有没有会话/授权 | 依据文档 |
> |---|---|---|---|---|
> | **Java（JNI）** | 本地库 + JNI，和 C 完全同一套语义 | 客户端库 → 密码机 | 有（Device/Session/私钥权限） | Java 版说明书 v1.5（**2022-07-22，最旧**） |
> | **openApi** | HTTP + JSON，无状态 | 密码机侧 | **完全没有** | openApi 说明文档 V04R25C01（2025-08-07 修订 02） |
>
> **选型一句话**：要完整密码能力、要会话与私钥授权、要高性能 → 走 SDF（C/Java）；
> 要跨语言、要 P7/证书/批量、**要后量子 Aigis-sig** → 只能走 openApi。

---

# 第一部分 · Java 接入

## 1.1 先看清楚：Java SDK 的交付件不在这批材料里

Java 说明书（P65「编译选项」，全章只有 5 行）写明需要：

```
Windows 下编译：引入 jni.jar 并在链接库中加入 jni_CDE_SDF_win.dll
Linux   下编译：引入 jni.jar 并在链接库中加入 libjni_CDE_SDF.so
Demo 可以参考 testsdf.java
```

**这四个文件（`jni.jar`、`jni_CDE_SDF_win.dll`、`libjni_CDE_SDF.so`、`testsdf.java`）
在本次交付的 Windows/ 与 Linux/ 目录里一个都没有。**

但实测发现 **JNI 入口已经编译进了随包交付的库本身**：`libflk-x86.so`、`libflk-arm.so`、
`SDF.dll`（x64 与 x86）各自导出 **223 个** `Java_jni_CDE_1SDF_*` 符号，两平台方法集完全一致。

由 JNI 命名规则（`Java_` + 包名 + `_` + 类名 + `_` + 方法名，`_1` 是转义的下划线）可反推：

* **包名 `jni`，类名 `CDE_SDF`** —— 即 `jni.CDE_SDF`
* 223 个本地方法分四族：`SDF_*`（GM/T 0018 运算）、`CDE_SDF_*`（设备管理/密钥生命周期/管理员操作员）、
  `CDE_SOF_*` 与 `SOF_*`（GM/T 0020 应用层：P7、数字信封、时间戳）、`PQC_*`（3 个，空桩）

**同时可确定**：Java 说明书 1.8 节的 `flk_*`（二次封装）和 1.9 节的 `Map` 风格接口（三次封装）
**在 native 层没有任何对应符号**——它们是 `jni.jar` 里的**纯 Java 包装代码**。
拿不到 jar 就用不了这两层，这不是配置问题，是文件缺失。

### 两条可行路径

**路径 A（推荐）：向厂商索取 `jni.jar` + `testsdf.java`。** 索取时一并问清三件事：
① jar 是否与 SDK 4.2.0 配套（Java 文档是 2022 年的，落后约 3 年）；
② 1.9 节那个接口到底叫 `SDF_Set_HsmIp` 还是 `SDF_SetDevIP_ex`（文档目录与正文自相矛盾）；
③ 各 `[out]` 缓冲区的最小长度（文档从头到尾没给过，见 1.5）。

**路径 B（应急可行）：自己声明 native 方法直接绑现有库。**
223 个入口就在 `libflk-*.so` / `SDF.dll` 里，自建绑定即可调通 native 层，
只是拿不到 `flk_*` 便利封装。**包名必须是 `jni`、类名必须是 `CDE_SDF`**，否则符号名对不上：

```java
package jni;

public class CDE_SDF {
    static {
        // 用绝对路径 load，不要用 loadLibrary（库名 libflk-x86 / libflk-arm 与平台相关）
        System.load("/opt/hsm/libflk-x86.so");
    }
    public static native int SDF_SetHSM_ex(byte[] ip, int port);
    public static native int SDF_OpenDevice(long[] phDeviceHandle);
    public static native int SDF_OpenSession(long hDeviceHandle, long[] phSessionHandle);
    public static native int SDF_GenerateRandom(long hSessionHandle, int uiLength, byte[] pucRandom);
    public static native int SDF_CloseSession(long hSessionHandle);
    public static native int SDF_CloseDevice(long hDeviceHandle);
    // …按需补，方法名必须与 native 符号逐字一致（含下面 1.3 列的拼写错误）
}
```

## 1.2 【致命】两个方法必然抛 `UnsatisfiedLinkError`

`CDE_SDF_ImportPKCS12Key` 与 `SDF_InitDevice_ex` 这两个 JNI 入口**被 C++ 名字修饰了**
（源码漏写 `extern "C"`），JVM 按未修饰名找不到符号 → **首次调用时抛 `UnsatisfiedLinkError`**，
编译期和加载期都不报。Linux 与 Windows 全平台一致。详细证据见 KB6 第四节。

**绕开**：设备初始化走管理工具或 openApi；PKCS#12 导入改用 `SDF_ImportECCKeyPair_ex`，
或在 Java 侧自行解析 P12 后再导入。

## 1.3 Java 侧的方法名带着三个拼写错误，必须照抄

native 层的符号就是错的，Java 方法名只能跟着错：

| 正确拼写（C 头文件） | **Java/JNI 必须用的拼写** |
|---|---|
| `SDF_ExternalEncrypt_ECC` | **`SDF_ExternalEncrytp_ECC`**（Encrypt → Encrytp） |
| `SDF_DestroyKey` | **`SDF_DestoryKey`**（Destroy → Destory） |
| `SDF_SignMessageDetach_ex` | **`SDF_SignMessageDetch_ex`**（Detach → Detch） |

> Java 文档里还有 `flk_DestorySeSKey`（同样是 Destory）。
> **C 侧两个拼写都存在**（`SDF_DestroyKey` 是正确的，`SDF_DestoryKey` 被头文件注释标了「弃用」）；
> **JNI 侧只有错的那个**。

另外 Java 层有几个 C 头文件里没有的方法名，如 `SDF_EncryptWithKEKIndex` / `SDF_DecryptWithKEKIndex`
（C 侧对应的是 `SDF_EncryptByKEK` / `SDF_DecryptByKEK`）。**两侧不是一一对应，别按 C 的名字去 Java 里找。**

## 1.4 类型映射规律

| C 侧 | Java 侧 | 说明 |
|---|---|---|
| `void **phHandle`（出参句柄） | `long[] phHandle` | **长度 1 的数组**承载出参 |
| `void *hHandle`（入参句柄） | `long hHandle` | 标量 |
| `unsigned int *puiLength`（出参） | `int[] puiLength` | 长度 1 的数组 |
| `unsigned int uiLength`（入参） | `int uiLength` | 标量 |
| `unsigned char *puc`（缓冲区） | `byte[] puc` | **调用方必须预分配** |
| `DEVICEINFO *` / `ECCrefPublicKey *` 等结构体指针 | 同名 Java 类对象引用 | **不能传 null，必须先 `new`**，由 JNI 回填字段 |
| 返回码 | `int` | 0 成功，**不抛异常** |
| `prime[2][128]` / `pexp[2][128]`（二维） | `byte[256]`（一维拉平） | p 在前 128、q 在后 128（文档未明说，需实测） |
| `unsigned char AsymAlgAbility[8]` | `int[2]` | [0]=算法位或、[1]=最大模长位或 |

⚠️ **`pui` 前缀不等于指针**，Java 侧同样成立：
`SDF_ImportKeyWithISK_RSA(..., int puiKeyLength, ...)` 和 `SDF_ImportKeyWithKEK(..., int puiKeyLength, ...)`
的 `puiKeyLength` 是**标量入参**，不要 `new int[1]`。
反过来 `flk_ImportSeSKeyWithSM2(byte[] key, int[] puiLen, long[] handle)` 的 `puiLen` 虽标 `[in]`
却是 `int[]`，**必须**传长度为 1 的数组。

⚠️ 传 `null` 给结构体参数会得到 `FLK_ERR_DEVICEINFO(0x01050003)` 之类的"结构指向空"错误；
若看到 **`0x0106xxxx` 段**的错误码，含义是 **JNI 层没能读写 Java 对象字段**（类型/字段对不上或传了 null）
——这段错误码**任何一份文档里都查不到**，只在 `sdf.h` 里有定义。

## 1.5 Java 文档最危险的三处空白

1. **所有 `[out]` 缓冲区的最小长度，文档从头到尾没给过一个**（唯一例外是 `flk_ImportSeSKeyWithSM2`
   明写"输入 256 字节"）。缓冲区开小了会发生什么（返回错误码还是 JVM 崩溃）也没说。
   **这是本文档最危险的空白**——JNI 层越界写会直接 crash 掉整个 JVM，不是抛异常。
2. **线程安全零处提及**：句柄能否跨线程共享、是否需要 per-thread session，一个字都没有。
   按 C 侧官方压测样例的做法：**每个线程各自 OpenDevice + OpenSession，句柄不共享**。
3. **1.9 层 `String` 参数的字符编码未定义**（UTF-8 还是 GBK），
   中文明文场景会直接导致跨系统解密乱码。

## 1.6 【重大】Java 文档的错误码表是错的，别用

Java 说明书附录 A 的错误码表与随库交付的 `sdf.h` 在 `0x01000017` 之后**整体错位**，
9 个码的含义全部对不上。最要命的是 `0x0100001D`：
**按 Java 文档是"通讯错误"（团队会去查网络），按头文件是"输入参数错误"（问题在自己代码里）。**

完整对照见 KB6 第五节。**排错一律以 KB3（按头文件整理）为准。**

## 1.7 三次封装层（1.9 节）的返回值判断

1.9 层返回 `Map`，错误码放在 `CODE` 键里，**类型是 `String` 不是 int**：

```java
Map<String,Object> r = sdf.flk_GenSeSKeyWithSM2();
if (!"0".equals(r.get("CODE"))) { /* 失败 */ }   // ← 必须比较字符串 "0"，不能 == 0
long keyHandle   = (Long)   r.get("PH_KEY_HANDLE");
String sessionB64= (String) r.get("SESSION_CIPHER");   // Base64
```

例外：`flk_VerifySignWithSM2`（1.9.9）仍返回 `int`。
`CODE` 字符串是十进制还是十六进制（`"16777217"` 还是 `"0x01000001"`），**文档未说明，需实测**。

`flk_SM4Enc` / `flk_SM4Dec` **固定 CBC 模式**，不可选；返回值里 `ENCRYPT_TEXT` / `SESSION_CIPHER` 是 Base64。

⚠️ Java 文档 1.8.6 `flk_SM4Dec` 的参数 in/out 方向标注**与解密语义完全矛盾**
（密文标 `[in|out]`、密文长度标 `[out]`、明文标 `[in]`），属文档缺陷，实际方向必须实测。

---

# 第二部分 · openApi 接入

## 2.1 形态与基本约定

* **协议**：HTTP / HTTPS，**JSON over POST**，不是资源型 REST（路径是动词化的 RPC 风格）。
* **端口**：**http = 9090，https = 9443**；host 是密码机的**业务 IP**。
* **请求头**：文档只定义了一个 —— `Content-Type: application/json;charset=UTF-8`。
* **方法**：61 个接口中 **60 个 POST**，唯一 GET 是健康检查 `GET /base/health`。
* **编码**：密钥、IV、密文、签名、杂凑、随机数、证书、CSR **统一 Base64**，全文无 HEX。
* **返回结构**：

```json
{ "code": 200, "msg": "success", "data": {…} }
```

`code == 200` 为成功；**失败时不返回 `data` 且 `code` 不是 200**（多个接口都有这条独立注记）。
`msg` 不固定是 `success`，部分接口返回中文（如「获取对称密钥成功！」）。

⚠️ **结构例外**：对称加解密类接口（`sysEncrypt` / `sysDecrypt` / `sysEncryptKeyNum` /
`sysDecryptKeyNum` / `sysEncrypt(Decrypt)/identification`）的 **`iv` 与 `code`/`msg`/`data` 同级**，
不在 `data` 里面。分段加密时要用它。

* **错误码**：不是 HTTP 状态码，是设备层错误码，与 `sdf.h` 同一套（`SDR_*` / `FLK_ERR_*` / `SDR_ZAYK_*` / `STF_TS_*`），
  但文档里写成了**去掉前导 0 的十六进制**（`100001d` 即 `0x0100001D`）。查含义直接用 KB3。
* **分页与时间格式**：文档未定义任何分页字段，接口中也不含任何时间字段。

## 2.2 【最高优先级】openApi 没有任何身份认证

这是接入前必须先解决的一件事，不是可以往后放的细节。

**逐字核对全文的结论**：openApi 文档**没有任何认证/鉴权章节**——
没有 token、没有 API Key、没有 AK/SK、没有签名头、没有时间戳/nonce 防重放、
没有双向 TLS 或客户端证书要求、没有 IP 白名单、没有登录接口。**唯一规定的请求头就是 `Content-Type`。**

对照 SDF 侧：C 接口要 `SDF_GetPrivateKeyAccessRight(索引, 口令)` 才能用内部私钥；
而 **openApi 直接传 `"privateKey": "1"` 就能驱动内部 1 号私钥签名**，中间没有任何授权步骤。

**含义**：按文档字面，**9090/9443 端口一旦网络可达，任何人都能用设备里的全部密钥做运算**
（签名、解密、导出公钥、生成密钥、导入密钥对）。

**处方（三条都要做）**：

1. **接入前向厂商书面确认 openApi 的访问控制方式**——是真的没有，还是文档漏写了。
   这个答案会直接影响网络方案和密评结论，不能靠猜。
2. **在网络层做硬隔离**：openApi 端口只对应用服务器网段开放，绝不暴露到办公网或互联网；
   优先只开 9443 并在前面加反向代理做 mTLS / IP 白名单 / 限流。
3. **写进密评材料时如实描述**：这条属于"密码服务接口无身份鉴别"，
   在 GB/T 39786 的网络和通信、设备和计算两个层面都会被问到，别等测评时才发现。

## 2.3 61 个接口一览

**对称（15 个）** —— 前缀 `/api/crypto/`，密钥有三种寻址方式，**这是理解这套 API 的关键**：

| 寻址方式 | 传什么 | 生成接口 | 加解密接口 |
|---|---|---|---|
| **密钥密文** | Base64 密钥密文（由内部 KEK-1 加密） | `getSymmetricKey` | `sysEncrypt` / `sysDecrypt` |
| **密钥号** | 内部密钥索引，如 `"1"` | （管理面预置） | `sysEncryptKeyNum` / `sysDecryptKeyNum` |
| **密钥标识** | 自定义字符串，如 `"sm4_1"` | `POST /api/key/symmetric/identification` | `sysEncrypt/identification` / `sysDecrypt/identification` |

⚠️ **三种方式都用同一个字段名 `key`**，靠参数表的"说明"列区分。
`publicKey` / `privateKey` 同样一词多义（有时是 Base64 密钥值，有时是索引号）。
**读接口时必须逐个对参数表，不能按字段名推断语义。**

批量版另有 4 个：`external/symmetricEncryptBatch`、`external/symmetricDecryptBatch`、
`sysEncrypt/identification/batch`、`sysDecrypt/identification/batch`——
入参 `data` 是 JSON 数组，`skipFields` 指定哪些字段不加密（**字段级加密，很实用**）。

还有 3 个会话密钥转换接口：`getSymmetricKeyWithPubKeyEncKey`（生成并用外部公钥加密输出）、
`symmetry/decrypt/externalKey`、`sessionKey/transferKeyPucKey2KekKey`（外部公钥密钥 → 内部 KEK 密钥）。

**非对称（26 个）**：

* 基础：`getAsymmetricKey`、`exportPublicKey`、`import/keypair`、`asyEncrypt`、`asyDecrypt`、`sign`、`verify`
* 按密钥号：`asyEncryptKeyNum`、`asyDecryptKeyNum`、`signKeyNum`、`verifyKeyNum`
* **免哈希版**：`signKeyNum/nohash`、`verifyKeyNum/nohash` —— ⚠️ **data 长度必须正好 32**（传的是摘要）
* P7 / 证书：`signMsg`、`verifySignedMsg`、`analysis/p7signature`、`cert/encrypt`、`cert/decrypt`、
  `sign/p7detch`、`verify/p7detch`（**路径是 `p7detch` 不是 p7detach，照抄别"纠正"**）
* CSR：`cert/gencsr`（单证书，keyType 支持 SM2/RSA）、`cert/gencsrex`（双证书）、`cert/genenccsr`（加密证书）
* 证书解析：`cert/analysis/getpubkey`、`cert/parse/prikeycert`
* UKey：`POST /signature/verify/ukey`（**无 `/api` 前缀**，验浙江 CA 的 UKey 签名，
  入参是 `&` 分隔的四段 Base64：签名值 & 证书 & 原文 SM3 & 原文加密值）

**摘要（7 个）**：`hash`、`hmac`、`hmacWithEncKey`、`hmac/sm3hmac`、
`/api/key/hmac/identification`、`hmacWithIdent`、`hmac/ident/batch`

⚠️ **命名陷阱**：路径 `/api/crypto/hmac` 的功能**不是 HMAC，是 SM2 签名预处理（Z 值 + SM3）**，
它的 `key` 是**公钥索引**。真正的 HMAC 在 `hmacWithEncKey`（密文密钥）和 `hmac/sm3hmac`（明文密钥）。

**ECC / SM9（8 个）**：`/api/ecc/{encrypt,decrypt,sign,verify}`、`/api/sm9/{encrypt,decrypt,sign,verify}`，
全部按 `keyIndex` 寻址。⚠️ **这两组的签名值字段名是 `sign`，而 SM2/PQC 组是 `signature`。**

**PQC 后量子（3 个）**：`/api/pqc/getKeyPair`、`/api/pqc/sign`、`/api/pqc/verify`
——`algorithmType` 只支持 **`Aigis-sig`**，`mode` 只支持 **1 / 2 / 3**，密钥按 `keyIndex` 存设备里。
**这是全套材料中唯一可用的后量子通路**（SDK 侧是空桩，见 KB6 第三节）。签名值约 3.4KB Base64。

**其他（2 个）**：`genRandom`（随机数）、`GET /base/health`（健康检查，返回 `"healthy"`）。

## 2.4 关键参数约束（逐条来自文档）

| 约束 | 适用 |
|---|---|
| 对称算法只支持 **sm1、sm4** | 全部对称接口 |
| 「推荐 cbc，**国密不允许使用 ecb 模式**」 | 文档自己写的原话 |
| IV **Base64 解码后必须 16 字节**，cbc/cfb/ofb 时不能为空 | 全部对称接口 |
| 填充只支持 **PKCS5Padding / NoPadding** | 全部对称接口 |
| 对称密钥 Base64 解码后 **16 字节** | `getSymmetricKey` |
| SM2 公钥解码后 **64 字节 = x(32)+y(32)**；私钥解码后 **48 字节 = D(32)+填充(16)**，经内部 KEK-1 加密 | `getAsymmetricKey` |
| SM2 密文是 **C1C3C2** 格式 | `asyEncrypt` / `asyDecrypt` / `*KeyNum` |
| 非对称运算只支持 **sm2**（RSA 只出现在 CSR 的 keyType） | 全部非对称接口 |
| `pucId` 长度 **≤128** | 签名/验签 |
| 密钥标识 **长度 ≤28，仅英文数字下划线** | identification 系列 |
| HMAC 密钥长度 **16 的倍数、最大 128**；HMAC 结果固定 **32 字节** | hmac 系列 |
| 杂凑数据 **建议 ≤100M**，更大要分块自己比较 | `hash`（openApi 无多步杂凑接口） |
| nohash 签名/验签的 `data` **长度必须是 32** | `*/nohash` |
| 导入密钥对 `keyType`：**0=签名、1=加密** | `import/keypair` |
| P7 解析 `type`：**1=公钥证书、2=原文、3=签名值** | `analysis/p7signature` |
| **内部 KEK 固定 1 号** | 密钥生成类接口 |

## 2.5 openApi 文档本身的坑（照抄示例会直接失败）

1. **大量示例用了中文全角引号**（`“code”`、`”sm2”`），**直接复制粘贴会 JSON 解析失败**。
2. 多处 JSON 示例缺右引号 / 缺右花括号 / 多余逗号（1.2.5、1.2.6、1.2.10、1.2.15、1.4.1、1.7.1）。
3. `1.6.1` 响应示例把 `true` 写成 `ture`。
4. `1.3.14` 返回表写 `plainText`，示例写 `plaintext`（小写 t）。
5. `1.2.4` 的 `secretKey` 类型标成了 `Boolean`，实际是 String。
6. 返回字段大小写不统一：`Iv` / `iv`、`Data` / `data`。
7. `1.5.2` / `1.5.6` 的用途写"使用**公钥**对数据进行解密"，语义写反了（应为私钥）。
8. 「调用示例 → postman 调用接口」整节是**图片**，无文字内容。
9. 文档修订 02（2025-08-07）只写了"修改部分接口"，**没列改了哪些**——接入前应向厂商索取 01→02 差异。

## 2.6 openApi 与 SDF 的能力差集（选型依据）

**只有 openApi 有的**：密钥标识（字符串）寻址、批量加解密与字段级 skipFields、
CSR 生成（单/双/加密证书）、P7 全家桶、UKey 验签、**PQC(Aigis-sig)**、SM9 运算、健康检查。

**只有 SDF 有的**：设备/会话生命周期、**私钥使用权限申请与释放**、设备内文件区读写、
密钥协商、数字信封转换、会话密钥句柄管理与销毁、**多步杂凑**（openApi 只有单次，所以才有 100M 分块建议）、
RSA 运算、MAC（openApi 只有 HMAC）、运行期设置密码机 IP/端口。

**两边都没有的（但设备上确实存在）**：设备初始化、管理员/操作员管理与登录、密钥备份恢复与门限、
日志查询、集群、网络配置、时间戳服务。

> 怎么知道这些功能存在的？**openApi 的错误码表里有它们的专属错误码**——
> `SDR_ZAYK_MGRCOUNTERROR 备份时管理员数目不符合要求`、`SDR_ZAYK_KTDERROR 门限拆分错误`、
> `SDR_TJGX_MANAGER_INDEX_ERROR 请插入正确的管理员ukey`、`STF_TS_*` 一整组时间戳码。
> 有错误码就说明设备里有这套逻辑，只是**两套接口都没暴露入口**。
> 它们走哪条通道（Web 管理界面 / UKey + 管理工具 / 另一套管理 API），
> **两份文档都没说，必须向厂商确认**——这通常是交付期最先卡住的一环。

## 2.7 一个可直接跑的 openApi 冒烟脚本

```bash
HSM=10.50.89.155
# 0) 活着吗
curl -s "http://$HSM:9090/base/health"
# → {"code":200,"msg":"success","data":"healthy"}

# 1) 随机数
curl -s -X POST "http://$HSM:9090/api/crypto/genRandom" \
  -H 'Content-Type: application/json;charset=UTF-8' \
  -d '{"length":16}'

# 2) 生成对称密钥（返回的是被内部 KEK-1 加密的密钥密文，要自己存好）
curl -s -X POST "http://$HSM:9090/api/crypto/getSymmetricKey" \
  -H 'Content-Type: application/json;charset=UTF-8' \
  -d '{"algorithmType":"sm4"}'

# 3) 用它加密（注意 iv 解码后必须 16 字节；响应里的 iv 与 data 是同级字段）
curl -s -X POST "http://$HSM:9090/api/crypto/sysEncrypt" \
  -H 'Content-Type: application/json;charset=UTF-8' \
  -d '{"algorithmType":"sm4","data":"1234567812345678","encMode":"cbc",
       "iv":"AAAAAAAAAAAAAAAAAAAAAA==","key":"<第2步返回的 data>",
       "padMode":"PKCS5Padding","plainIsEncode":false}'

# 4) 后量子签名（全套材料里唯一可用的 PQC 通路）
curl -s -X POST "http://$HSM:9090/api/pqc/sign" \
  -H 'Content-Type: application/json;charset=UTF-8' \
  -d '{"keyIndex":1,"algorithmType":"Aigis-sig","mode":1,
       "data":"hello","plainIsEncode":false}'
```

> 手写这些 JSON，**不要从 PDF 里复制**——文档示例带中文全角引号（见 2.5 第 1 条）。
