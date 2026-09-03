# MDM 模式：让终端由系统托管，用户点图标就能用

这是「点 KingCode 图标就能用、不用挂着终端」的**唯一正规做法**。前提是有**华为企业开发者账号**。

## 为什么需要它

KingCode 的引擎是 Node。HarmonyOS 上：

- 应用沙箱（normal_hap 域）起不了 Node；
- hdc 的 shell 域被 SELinux 拒绝执行 `data_local_tmp` 标签的文件（连 toybox 拷过去都跑不了）；
- 只有系统自带的**终端**（`com.huawei.hmos.hishell`）那个域能 exec。

而终端会被系统在后台回收、窗口关掉就死，让第三方应用直接拉起它 / 让它脱离沙箱都被系统拦死
（五条死路的实测证据见 `../entry/src/main/ets/pages/Index.ets` 顶部注释）。

企业设备管理（EDM）的三个白名单正好治这三件事：

| API（`@kit.MDMKit` 的 `applicationManager`） | 作用 |
|---|---|
| `addAutoStartApps` | 开机自启：开机就把终端拉起来 |
| `addKeepAliveApps` | 保活：终端不被后台回收 |
| `addFreezeExemptedApps` | 免冻结（可选，进一步保险） |

把终端加进前两个白名单之后，它就常驻了，引擎随之常驻，用户点图标直接进。

## 卡在哪（个人证书为什么不行）

这些 API 要 **super administrator** 身份 + `ohos.permission.ENTERPRISE_MANAGE_APPLICATION`。
后者只有 **MDM 企业签名**（provision 的 `app-feature = hos_enterprise_mdm`）的包能拿到。
用 DevEco 自动签名（`hos_normal_app`）装带这条权限的包，会在装机时报：

```
9568289 install failed due to grant request permissions failed.
PermissionName: ohos.permission.ENTERPRISE_MANAGE_APPLICATION
```

**代码本身是对的**：`./mdm.sh on` 后 `assembleHap` 的 `CompileArkTS` 无报错，扩展、
`@kit.MDMKit`、两个 `add*Apps` 调用全部通过。缺的只有企业签名这一步。

## 完整流程（有企业账号时）

1. **AGC 建 MDM 应用**：华为AGC 控制台 → 用**企业账号**登录 → 创建应用，
   Bundle 填 `com.kingcode.client`，类型选 **MDM（移动设备管理）**。

2. **拿 MDM 证书与 Profile**：AGC → 证书/Profile 管理，申请 **MDM 类型**的发布证书（`.cer`）
   与 Provision Profile（`.p7b`，其 `app-feature` 为 `hos_enterprise_mdm`）。

3. **DevEco 里配 MDM 签名**：打开 `harmony/`，Project Structure → Signing Configs →
   **取消**自动签名，手动填第 2 步的 p12/证书/Profile。（自动签名只会给 `hos_normal_app`，
   拿不到 MDM 权限，必须手动配 MDM Profile。）

4. **打开 MDM 模式并构建**：
   ```
   cd harmony
   ./mdm.sh on            # 把扩展 + 权限加进 module.json5
   ./build.sh --install   # 用上面配好的 MDM 签名构建装机
   ```

5. **激活超级管理员**（一次性，连着电脑；终端里 `/system/bin` 不可见，必须走 hdc）：
   ```
   hdc shell edm enable-admin -n com.kingcode.client \
       -a com.kingcode.client.EnterpriseAdminAbility -t super
   ```
   激活会触发扩展的 `onAdminEnabled`，它立刻把终端加进开机自启 + 保活白名单
   （`hilog` 里能看到 `EDM: HiShell 已加进…白名单`）。

6. **重启一次**，验证：不开终端、直接点 KingCode 图标——应当直接进工作区。

撤销：`hdc shell edm disable-admin -n com.kingcode.client`，再 `./mdm.sh off` 回到普通包。

## 没有企业账号时

维持默认形态：`kc-hmos autostart on` + 点图标。用户需要保证有一个终端窗口开着
（最小化即可，别关）。见主 README 的「客户端壳的默认体验」一节。
