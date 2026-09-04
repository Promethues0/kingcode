# MDM 模式：让终端由系统托管，用户点图标就能用

这是「点 KingCode 图标就能用、不用挂着终端」的**唯一正规做法**。

> **先读第 0 步。** 这条路有一个可能直接否掉它的硬前置，别等申请到一半才发现。

## 为什么需要它

KingCode 的引擎是 Node。HarmonyOS 上：

- 应用沙箱（normal_hap 域）起不了 Node；
- hdc 的 shell 域被 SELinux 拒绝执行 `data_local_tmp` 标签的文件（连 toybox 拷过去都跑不了）；
- 只有系统自带的**终端**（`com.huawei.hmos.hishell`）那个域能 exec。

而终端会被系统在后台回收、窗口关掉就死，让第三方应用直接拉起它 / 让它脱离沙箱都被系统拦死
（五条死路的实测证据见 `../entry/src/main/ets/pages/Index.ets` 顶部注释）。

企业设备管理（EDM）的白名单正好治这些：

| API（`@kit.MDMKit` 的 `applicationManager`） | 作用 |
|---|---|
| `addAutoStartApps` | 开机自启：开机就把终端拉起来 |
| `addKeepAliveApps` | 保活：终端不被后台回收 |

把终端加进这两个白名单，它就常驻了，引擎随之常驻，用户点图标直接进。

---

## 0. 硬前置：你的设备够不够格

官方原文：企业MDM应用**仅支持在企业场景下使用**，设备需

- 在**华为 HEM 平台**注册管理，**或**
- 是搭载**鸿蒙电脑专业版 / 企业版**的 PC（华为擎云 qingyun.huawei.com 那条产品线）

普通零售版鸿蒙 PC 大概率不在此列。**先把这件事问清楚再动手**，否则证书申请下来也用不上。

自查留底（连着设备跑，附在后面申请邮件里让对接人判断最快）：

```bash
export PATH="$PATH:/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains"
hdc shell param get const.product.model
hdc shell param get const.product.software.version
```

另外两条资质是**分别授予**的，都要有：

1. 企业开发者账号 + 已完成**企业开发者实名认证**；
2. 你这个应用（按**包名**）被加入**企业MDM应用受邀名单**。

> ⚠️ 第 2 项是按包名授的。`com.kingcode.client` 一旦定下就别改——AGC 侧包名本身也不支持修改，
> 改名等于重走一遍受邀申请。

---

## 1. AGC 建应用

**证书、APP ID和Profile > APP ID > 新建**：应用类型选 *HarmonyOS应用*，包名填 `com.kingcode.client`。
（包名设置后不支持修改。）

建完回 APP ID 列表点**发布**，为它关联一个待发布的 HarmonyOS 应用——**「支持设备」是在这一步选的**，
下一步发邮件时标题里要填它。

> **`deviceTypes` 必须覆盖 AGC 勾选范围**，且 PC 的枚举值是 **`2in1`**（不是 "PC"/"pc"）。
> 本工程 `entry/src/main/module.json5` 已声明 `phone, tablet, 2in1`，**这一项不用改**。
> AGC 勾了 PC 而包里没 `2in1`，装机会失败。
>
> （本机 SDK 的 modulecheck schema 列的枚举是 `default / tablet / tv / wearable / car / 2in1`，
> 没有 `phone`；但本工程用 `phone` 一直构建装机正常，所以那份 schema 未必是当前生效的全集。
> 只有 `2in1` 这一条是本项目实机验证过的。）

抄下 **Developer ID / APP ID / 包名**：*开发与服务 > 项目列表 > 选中应用 > 项目设置 > 常规*。

## 2. 申请 MDM 证书与 Profile —— 不是自助的，要发邮件

控制台里没有自助入口。发信到 **agconnect@huawei.com**，标题是 **6 段**方括号：

```
[申请企业MDM应用发布证书和发布Profile]-[应用名称]-[应用包名]-[APP ID]-[Developer ID]-[支持设备]
```

正文写申请原因，附**支持设备截图**，并**抄送华为应用生态对接人员或硬件设备销售对接人员**。
约 1–3 个工作日安排对接人。

> 没有对接人怎么办：官方模板默认你已经有。现实起手式是先从鸿蒙电脑专业版/企业版销售侧
> （qingyun.huawei.com）或 HEM 商务拿到对接人，再发这封信——否则大概率石沉大海。
> （这条是操作建议，非官方流程。）

**别去 ACL 页面找它**：`ohos.permission.ENTERPRISE_MANAGE_APPLICATION` 不是 ACL 权限。
它的定义是 `availableType: MDM`、`availableLevel: system_basic`、`grantMode: system_grant`
（本机 SDK `previewer/common/resources/module.json` 的 definePermissions 里可查，MDM 类共 39 条）。
AGC 角色权限表里也**根本没有**「企业MDM应用发布证书/Profile」这两个子类——
看不到该类型多半就是资质还没开通。

**账号角色**要有「访问发布类证书」和「访问发布类Profile」权限（账号持有者/管理员默认全有；
运营/客服/财务/法务四个角色完全没有；「开发」角色能查看/创建/下载但不能删除）。

## 3. 生成密钥、拿到三样材料

DevEco：**Build > Generate Key and CSR**，产出 `.p12` + `.csr`。有效期建议 **25 年以上**。

> 这一步还会产出一个 **material 文件夹**（密码加密材料）。**备份时别只拷 .p12。**
> 企业MDM应用发布证书**每账号只有 1 张**，吊销**不可恢复**，且会连带作废由它签发的所有 Profile。
> `.p12` 与 material 属于不可再生资产，当密钥一样保管。

拿 CSR 去 AGC：**证书 > 新增证书**，类型选**企业MDM应用发布证书** → 下载 `.cer`。
再 **Profile > 添加**，类型选**企业MDM应用发布**，选上面那张证书 → 下载 `.p7b`。

> `.cer` 应当是**三张证书的链**：`grep -c 'BEGIN CERT' xxx.cer` 结果应为 3。
> 不是链会报 `should input a cert chain file`；链里公钥与 `.p12` 私钥不配对会报
> `verify certificate chain failed! Signature does not match.`（这条最容易被误读成 profile 的问题）。

## 4. 先验证再构建 ← 这步能省一整轮返工

```bash
cd ~/Projects/kingcode/harmony
./mdm/check-profile.sh /你下载的/kingcode-mdm.p7b
```

必须看到：

```
app-distribution-type  enterprise_mdm
type                   release
bundle-info 证书键        distribution-certificate
✅ 全部通过，可以拿去构建。
```

> **判据是顶层 `app-distribution-type`，不是 `bundle-info.app-feature`。**
> 这里踩过坑：SDK 的 debug/release 两份模板里 `app-feature` **都**写死成 `hos_normal_app`，
> 它根本不区分 MDM——拿它核对会把一张**正确的** MDM Profile 判成废的。
> 佐证：OpenHarmony EDM 源码用 `APP_TYPE_ENTERPRISE_MDM = "enterprise_mdm"` 按
> `appDistributionType` 判定；华为 `appDistributionType` 取值表也逐字含 `enterprise_mdm`。
>
> 另外注意 `enterprise_normal`（「企业应用发布」）**不是** `enterprise_mdm`（「企业MDM应用发布」），
> 选错拿不到 ENTERPRISE_* 权限。
>
> **本地全绿 ≠ 装得上**：自己拼一份 profile 能让 `sign-profile` / `verify-app` 全过，
> 只在装机时才炸 9568289。所以脚本也会核 `issuer`（华为签发的是 `app_gallery`）。

## 5. 配签名 —— 不用开 DevEco GUI

把 `mdm/signing-config.example.json5` 的内容替换掉 `build-profile.json5` 里的
`"signingConfigs": []`，填上五个路径与口令。hvigor 直接读它。

（也可以走 GUI：*File > Project Structure > Project > Signing Configs*，
**取消** "Automatically generate signature" 与 "Associate with registered application" 两个勾，
手填 Store file / Store password / Key alias / Key password / Profile file / Certpath file，
Sign alg 固定 `SHA256withECDSA`。）

> ⚠️ 填完的 `build-profile.json5` **别提交**——仓库里那份必须保持 `"signingConfigs": []`。

## 6. 构建装机

MDM Profile 的 `type` 是 **release**，所以要出 **release 产物**，debug 产物对不上会在校验环节报错。

```bash
./mdm.sh on
./build.sh --install
```

> **换签名必须先卸载。** 现在机器上装的是 DevEco 自动签名的 debug 包，换成 MDM release 签名后
> 签名主体变了，**覆盖安装会直接失败**。顺序：
> ```
> hdc shell edm disable-admin -n com.kingcode.client   # 如果之前激活过
> hdc uninstall com.kingcode.client
> ./build.sh --install
> ```

装完**在设备上复验**（`.p7b` 对不代表系统按 MDM 待遇发权限）：

```bash
./mdm/check-installed.sh
```

必须看到 `appDistributionType = enterprise_mdm`、`appProvisionType = release`，
以及 `ENTERPRISE_MANAGE_APPLICATION` 和 `enterpriseAdmin` 扩展都在。

> 脚本会把 `versionName/Code` 一并打出来：`bm dump` 读的是**当前已安装**的包，
> 新包 install 失败时它照样返回一整套漂亮字段——全是上一次那个旧包的。

## 7. 激活超级管理员

```bash
hdc shell edm enable-admin -n com.kingcode.client \
    -a com.kingcode.client.EnterpriseAdminAbility -t super
```

约束（官方）：

- 必须装在**首用户**（账户 ID 100）；
- 同一设备**只能激活一个**超级管理应用；
- **激活后应用无法被卸载**——要卸载先 `edm disable-admin -n com.kingcode.client`；
- `-t` 取值 `super` / `byod` / `da`（`da` 仅 PC/2in1，API 23 起）。

激活会触发扩展的 `onAdminEnabled`，它立刻把终端加进两个白名单并**读回来**：

```bash
hdc shell "hilog -x | grep 'EDM:'"
```

期望：

```
EDM: HiShell 已加进开机自启白名单
EDM: HiShell 已加进保活白名单
EDM: 读回 自启白名单 = ["com.huawei.hmos.hishell"]
EDM: 读回 保活白名单 = ["com.huawei.hmos.hishell"]
```

**最后两行是唯一凭据**——`edm` 没有查询子命令，公开 SDK 里也没有 `isAdminEnabled`。

## 8. 验收

重启一次，**不开终端**、直接点 KingCode 图标——应当直接进工作区。

---

## 其它要知道的

- **MDM 应用无法上架应用市场。** 三条安装路径：HEM 批量部署 / 鸿蒙电脑专业版·企业版开启
  离线应用安装开关后本地装 / 企业私有应用商店。商用另走「企业MDM应用商用申请」。
- **Profile 不能进 CI。** AGC 的 Provisioning 开放接口只支持指定设备发布/In-house/调试/发布
  四种 Profile，企业MDM档不在其中。
- **hdc 不在 PATH 上**，命令行单独用时要自己加：
  `export PATH="$PATH:/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains"`

## 没有企业账号 / 设备不够格时

维持默认形态：`kc-hmos autostart on` + 点图标。用户需要保证有一个终端窗口开着
（最小化即可，别关）。见主 README 的「客户端壳的默认体验」一节。

---

*本文的 AGC 流程与字段判据经 2026-09-04 的多源核对（华为官方文档、本机 DevEco SDK 模板与
权限定义、OpenHarmony EDM 源码）。标注「建议」的条目是操作经验，非官方条文。*
