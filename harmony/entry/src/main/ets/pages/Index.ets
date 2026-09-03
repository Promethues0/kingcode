// KingCode 鸿蒙客户端 —— ArkWeb 壳。
//
// 角色与 mac/、win/ 两个客户端相同：引擎（dsh + KingCode 组合树）跑在别处，本应用
// 只是浏览器壳 + 记住引擎地址。**不内置引擎**：HarmonyOS 应用沙箱（normal_hap 域）里
// 起不了 Node，这一条对应用沙箱成立；但整机不成立——鸿蒙 PC 自带的终端 HiShell 是
// shell 域，那里能跑原生 Node，引擎可以不经虚拟机（见 deploy/harmonyos-native/）。
//
// 于是这个壳有两种连法：
// - **原生形态**：引擎就在本机的 HiShell 里，连 127.0.0.1——没有 IP 漂移、不用绑
//   0.0.0.0、loopback 还是安全上下文（剪贴板可用、设置面不降级）。推荐，也是默认。
// - **虚拟机形态**：引擎在融合开发引擎的 openEuler 虚拟机里，连虚拟机 IP——那个 IP
//   每次开机可能变，所以地址必须可改、必须记住。
//
// **默认体验要向 mac/win 客户端看齐：点图标直接进，不问地址、不让用户碰 token。**
// 做法是：原生形态下地址是固定已知的（127.0.0.1:3081，与 kc-hmos 的默认端口一致），
// 所以没存过地址时**直接试这个默认地址**，而不是先弹地址页。cookie 有 30 天、签名密钥
// 又落在 $DSH_HOME/.credentials.yaml 里跨引擎重启保留，所以换过一次 cookie 之后
// 这条路一直是通的。只有三种情况才落回地址页：连不上（引擎没起）、401（还没换过
// cookie 或密钥变了）、403（信任栅栏）。
//
// 做不到的那半件：**壳不能自己拉起引擎**。mac/win 客户端是自己 spawn `node dsh` 的，
// 而 HarmonyOS 应用沙箱（normal_hap 域）起不了 Node，HiShell 里也没有 aa/bm 让
// kc-hmos 反过来拉起本应用。所以引擎仍然要先在 HiShell 里 `kc-hmos start`。
//
// 两种形态都要过同一道会话认证（dsh 0.1.2-alpha.2 起，**loopback 也不豁免**）：
// 首次得用带 `?token=` 的完整地址换一枚 30 天的 cookie。所以这里除了网络失败
// （onErrorReceive），还必须认 HTTP 401（onHttpErrorReceive）——401 不是网络错误，
// 不接的话用户只会看到一行英文纯文本，地址页根本不出现。
import { webview } from '@kit.ArkWeb';
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const PREFS_NAME = 'kingcode';
const KEY_URL = 'engineUrl';
// 原生形态的默认引擎地址。端口与 kc-hmos 的 KC_PORT 默认值一致。
const DEFAULT_ENGINE = 'http://127.0.0.1:3081';
// 连不上引擎时不报错、改成守候：用户去打开一次终端（`kc-hmos autostart on` 的钩子会
// 把引擎带起来），这边每 3 秒敲一次门，起来了自己就进去了，不用再回来点什么。
// 上限放到 5 分钟——引擎首启要装配整棵插件树，慢机器上一分钟打不住。
const BOOT_TRIES = 100;
const BOOT_INTERVAL_MS = 3000;

@Entry
@Component
struct Index {
  controller: webview.WebviewController = new webview.WebviewController();
  @State engineUrl: string = '';
  @State draft: string = 'http://';
  @State editing: boolean = true;
  @State mainFrameError: string = '';
  @State booting: string = '';           // 非空 = 正在自动拉引擎，显示等待页
  private prefs?: preferences.Preferences;
  private bootTries: number = 0;
  private bootAsked: boolean = false;    // 守候链只起一条
  // 本次加载有没有失败过。**不能拿 onPageEnd 当成功信号**：加载失败时 ArkWeb 会渲染
  // 自己的错误页，onPageEnd 照样触发——第一版就是这么把守候面板提前撤掉的，
  // 结果用户对着一页白屏没有任何出路。
  private attemptFailed: boolean = false;

  async aboutToAppear(): Promise<void> {
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    this.prefs = await preferences.getPreferences(ctx, PREFS_NAME);
    const saved = this.prefs.getSync(KEY_URL, '') as string;
    if (saved.length > 0) {
      this.engineUrl = saved;
      this.draft = saved;
      this.editing = false;
      return;
    }
    // 没存过地址：**别先问用户**，直接试本机默认地址（见文件头注释）。
    // 失败/401/403 时下面那三个回调会把地址页翻出来，那时才需要人介入。
    this.engineUrl = DEFAULT_ENGINE;
    this.draft = DEFAULT_ENGINE;
    this.editing = false;
  }

  private ctx(): common.UIAbilityContext {
    return this.getUIContext().getHostContext() as common.UIAbilityContext;
  }

  /// 连不上本机引擎时的自愈：引擎只能活在 HiShell 里，而 HiShell 会被系统在后台回收，
  /// 所以「让用户自己留着一个终端窗口」不是个能用的方案。这里壳自己把 HiShell 拉起来
  /// ——`kc-hmos autostart on` 在 ~/.zshrc 里的钩子会顺手把引擎带起来——然后每 3 秒
  /// 重试一次加载，最多 60 秒。拉完立刻把自己切回前台，免得用户对着一个终端发愣。
  ///
  /// 只对 loopback 生效：虚拟机形态的引擎不在本机 HiShell 里，拉它没有意义。
  private isLocalEngine(): boolean {
    return this.engineUrl.indexOf('127.0.0.1') >= 0 || this.engineUrl.indexOf('localhost') >= 0;
  }

  /// **为什么不由壳自己去拉起 HiShell** —— 2026-09-03 在真机上把三条路都试死了，
  /// 记在这里免得以后有人再来一遍：
  ///
  /// 1. **让引擎跑在 hdc 的 shell 域**（uid 2000，不受 HiShell 生死影响）：SELinux 拒绝
  ///    `sh` 域执行 `data_local_tmp` 标签的任何文件——把 node 拷进 /data/local/tmp、
  ///    chmod 755 之后仍然 `Permission denied`，连 toybox 拷过去都跑不了。/data 本身
  ///    没有 noexec，是策略拦的。
  /// 2. **让引擎跑在本应用的沙箱里**：normal_hap 域起不了 Node。
  /// 3. **让本应用 startAbility 拉起 HiShell**：调用返回成功、窗管也真的建了 session
  ///    （`SCBSceneMissionManager --> startSceneTransition, to: EntryAbility/
  ///    com.huawei.hmos.hishell/entry/0`），但 HiShell 在 200~240 毫秒后自己干净退出
  ///    （appspawn `exit with code:0`），死因是它自己的
  ///    `HiShellFsUtil: writeConfig failed ... path is: unspecified/…`——它把自己的
  ///    模块解析成了 unspecified。Want 里补 moduleName: 'entry' 也一样死，所以不是
  ///    我们这边少传参数，是 HiShell 只认启动器/shell 域那种调用方。闭源，改不了。
  /// 4. **走 HiShell 的 FileOpen skill**（`bm dump` 看到它的 EntryAbility 声明了
  ///    `action=ohos.want.action.viewData` + `scheme=file` + `type=general.shell-script`
  ///    + `linkFeature=FileOpen`，本以为是另一条能绕开上面那个崩溃的入口）：从应用发
  ///    这条 want，HiShell 同样起不来；从 hdc 发，HiShell 能活但**并不执行**那个脚本，
  ///    只是把窗口切到前台。三种 URI 形式（`file:///…`、`file://docs/…`、
  ///    `file:///storage/media/…`）都试过，都不执行。
  /// 5. **企业设备管理（EDM）的白名单** —— 这是唯一一条「官方支持的系统能力」，而且
  ///    API 完全对得上需求：`@ohos.enterprise.applicationManager` 提供
  ///    `addAutoStartApps`（开机自启）、`addKeepAliveApps`（保活）、
  ///    `addFreezeExemptedApps`（免冻结）；设备上也确实有 `/system/bin/edm`，
  ///    `edm enable-admin -n <bundle> -a <ability> -t super` 就能就地激活超级管理员。
  ///    卡在签名：这些接口要 `ohos.permission.ENTERPRISE_MANAGE_APPLICATION`，
  ///    而带这条权限的 hap **装不上**——
  ///      `9568289 install failed due to grant request permissions failed.`
  ///      `PermissionName: ohos.permission.ENTERPRISE_MANAGE_APPLICATION`
  ///    它要 MDM 企业签名（provision 的 `app-feature: hos_enterprise_mdm`），
  ///    个人调试证书拿不到（装机报 9568289）。**有企业开发者账号的话这条路是通的**，
  ///    已实现为 harmony/mdm/ 套件（扩展 onAdminEnabled 里把终端加进开机自启+保活白名单，
  ///    ArkTS 编译已过，只差 MDM 签名）——是目前唯一能做到「终端由系统托管、用户完全不用管」的正规出口。
  /// 6. **让系统开机自启终端**（不走 EDM）：设备上没有 XDG autostart 目录，`settings list` 里没有
  ///    任何 boot/startup/autostart 项，设置应用的 13 个 ability 里也没有「启动管理 /
  ///    后台保活」这类入口。参考项目那套四层钩子自陈 1-3 分钟延迟且常要手工开一次终端。
  ///
  /// 于是只剩这条：**守着**。用户去开一次终端，这边自动连上。

  /// 定时重试加载。成功与否由 onPageEnd / onErrorReceive 决定，这里只负责再敲一次门。
  private scheduleRetry(): void {
    setTimeout(() => {
      if (this.booting.length === 0) { return; }   // 已经好了或者已经放弃
      this.bootTries++;
      if (this.bootTries > BOOT_TRIES) {
        this.booting = '';
        this.mainFrameError = `等了 ${Math.round(BOOT_TRIES * BOOT_INTERVAL_MS / 60000)} 分钟，` +
          `${this.engineUrl} 还是连不上。打开终端看一眼：kc-hmos status / kc-hmos doctor。`;
        this.editing = true;
        return;
      }
      this.booting = `引擎没在跑。去打开一次「终端」，这里会自动连上。（已等 ${this.bootTries * BOOT_INTERVAL_MS / 1000} 秒）`;
      this.attemptFailed = false;
      try { this.controller.loadUrl(this.engineUrl); } catch (ignored) { this.attemptFailed = true; }
      // **自己排下一轮**，别指望 onErrorReceive 每次都回调：loadUrl 打到一个死端口时
      // 它不一定再触发一次，链就断在 1/20 上了（第一版就是这么卡住的）。
      // 成功时 onPageEnd 会把 booting 清空，上面那个 early-return 会终止这条链。
      this.scheduleRetry();
    }, BOOT_INTERVAL_MS);
  }

  /// 主文档连不上时的入口：本机形态就自愈，其它形态照旧报错。
  private onEngineUnreachable(detail: string): void {
    if (!this.isLocalEngine()) {
      this.mainFrameError = `连不上 ${this.engineUrl}（${detail}）。` +
        '虚拟机形态：IP 可能变了，去虚拟机里跑 kingcode-web.sh url 重问地址，' +
        'IP 变了还要 restart 一次服务（信任名单是启动快照）。';
      this.editing = true;
      return;
    }
    if (this.booting.length === 0) {
      this.booting = '引擎没在跑。去打开一次「终端」，这里会自动连上。';
      this.bootTries = 0;
    }
    if (!this.bootAsked) {
      this.bootAsked = true;
      this.scheduleRetry();      // 只在这里起一条链，后面它自己续
    }
  }

  /// 存地址时去掉 `?token=`：token 是每个引擎进程一枚的一次性凭据，
  /// 存下来毫无用处——下次启动拿旧 token 去换 cookie 只会失败。真正跨启动有效的是
  /// 换回来的那枚 cookie。所以加载用完整地址，落盘只留干净的那半截。
  private withoutToken(url: string): string {
    const q = url.indexOf('?');
    return q >= 0 ? url.substring(0, q) : url;
  }

  private async saveAndConnect(): Promise<void> {
    let url = this.draft.trim();
    if (url.length === 0) { return; }
    // 只补协议，不做别的聪明事：地址是用户从 kingcode-web.sh url 抄来的
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'http://' + url;
    }
    this.mainFrameError = '';
    this.engineUrl = url;
    this.editing = false;
    if (this.prefs) {
      this.prefs.putSync(KEY_URL, this.withoutToken(url));
      await this.prefs.flush();
    }
    // Web 组件已挂载时切地址要显式 loadUrl；首次挂载由 src 自己加载
    try { this.controller.loadUrl(url); } catch (ignored) { /* 组件还没 attach，src 会处理 */ }
  }

  build() {
    Stack() {
      if (this.editing || this.engineUrl.length === 0) {
        // ── 地址页：首启或主动改地址时 ─────────────────────────────────
        Column({ space: 16 }) {
          Text('KingCode')
            .fontSize(34)
            .fontWeight(FontWeight.Bold)
          // ArkTS 的 Text 不渲染 markdown，这里不能写 ** **（会原样显示成星号，真机上验过）
          // 这一页现在是兜底：正常情况下壳直接连本机默认地址、根本不显示这里。
          Text('连不上本机引擎。先确认引擎在跑：在 HiShell 里 kc-hmos status。\n' +
               '还没换过会话 cookie 的话，把 kc-hmos url 打印的那条完整地址（含 ?token=）贴进来，\n' +
               '只需要这一次——之后 30 天点图标直接进。\n' +
               '引擎在融合开发引擎的虚拟机里：改用 kingcode-web.sh url（IP 每次开机可能变）')
            .fontSize(14)
            .opacity(0.7)
            .textAlign(TextAlign.Center)
          TextInput({ text: this.draft, placeholder: 'http://127.0.0.1:3081/?token=…' })
            .type(InputType.Normal)
            .width('70%')
            .onChange((v: string) => { this.draft = v; })
            .onSubmit(() => { this.saveAndConnect(); })
          Button('连接')
            .width(160)
            .onClick(() => { this.saveAndConnect(); })
          if (this.mainFrameError.length > 0) {
            Text(this.mainFrameError)
              .fontSize(13)
              .fontColor('#c0392b')
              .textAlign(TextAlign.Center)
              .width('70%')
          }
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
      } else {
        // ── 引擎页面 ───────────────────────────────────────────────────
        Web({ src: this.engineUrl, controller: this.controller })
          .domStorageAccess(true)      // dsh 前端用 localStorage 存 UI 状态
          .javaScriptAccess(true)
          .fileAccess(false)
          .width('100%')
          .height('100%')
          .onErrorReceive((e) => {
            // 只认主文档的失败；子资源 404 之类别把整页打成错误
            if (e.request.isMainFrame()) {
              this.attemptFailed = true;
              this.onEngineUnreachable(e.error.getErrorInfo());
            }
          })
          .onHttpErrorReceive((e) => {
            // HTTP 错误不走 onErrorReceive——401 在那边是「加载成功」，页面上只剩服务端
            // 那行英文纯文本，地址页不会出现，用户对着它无从下手。这里把两种状态码翻译
            // 成能照做的话。同样只认主文档。
            if (!e.request.isMainFrame()) {
              return;
            }
            const code: number = e.response.getResponseCode();
            if (code === 401 || code === 403) { this.attemptFailed = true; this.booting = ''; }
            if (code === 401) {
              this.mainFrameError = '引擎在跑，但这台机器还没换过会话 cookie（或引擎的签名密钥变过）。' +
                '在 HiShell 里跑 kc-hmos url，把打印出来的那条完整地址（含 ?token=）贴进来。' +
                '只需要这一次——换到 cookie 之后 30 天内点图标直接进，引擎重启也不用再贴。';
              this.editing = true;
            } else if (code === 403) {
              this.mainFrameError = `${this.engineUrl} 被引擎的信任栅栏拒了（403）。` +
                '引擎只信任启动那一刻的本机地址：IP 变过就 restart 一次服务；' +
                '或者改用 127.0.0.1（引擎跑在本机 HiShell 里时）。';
              this.editing = true;
            }
          })
          .onPageEnd(() => {
            // 只有「这一轮没报过错」才算真连上。失败页也会走到这里，见 attemptFailed 的注释。
            // 401 同样会到这里（HTTP 层算加载成功），但 onHttpErrorReceive 紧接着把
            // editing 翻起来，那条路自有提示。
            if (!this.attemptFailed) { this.booting = ''; }
            // ArkWeb 的 cookie 是每 30 秒周期性落盘的。换到 cookie 之后如果 30 秒内
            // 应用被杀（或者被 aa force-stop 掉），那枚 cookie 就丢了，下次开又是 401。
            // 页面加载完就强制落一次盘，把这个窗口关掉。
            try {
              webview.WebCookieManager.saveCookieSync();
            } catch (ignored) { /* 落盘失败不影响本次会话，下个周期还会再试 */ }
          })

        // **守候面板必须盖在 Web 上，不能替换它**：第一版把 Web 整个换掉了，
        // controller 没挂载，重试用的 loadUrl 全是空炮——真机上引擎明明起来了，
        // 面板还在数秒数（数到 105 秒）。Stack 后声明的节点在上层，正好盖住。
        if (this.booting.length > 0) {
          // 引擎没起来时 Web 底下是一页错误内容，面板必须用不透明背景整个盖住
          Column({ space: 16 }) {
            Text('KingCode')
              .fontSize(34)
              .fontWeight(FontWeight.Bold)
            Text(this.booting)
              .fontSize(14)
              .opacity(0.7)
              .textAlign(TextAlign.Center)
            Text('引擎跑在系统自带的「终端」里——HarmonyOS 的应用沙箱起不了 Node，\n' +
                 '本应用也没法替你把终端拉起来（试过，系统不让）。\n' +
                 '装过 kc-hmos autostart on 的话，打开终端它就会自己把引擎带起来；\n' +
                 '终端窗口切到后台就行，但别关——关了引擎跟着死。')
              .fontSize(13)
              .opacity(0.45)
              .textAlign(TextAlign.Center)
            Button('直接填地址')
              .width(160)
              .backgroundColor('#00000000')
              .fontColor('#3478f6')
              .onClick(() => { this.booting = ''; this.editing = true; })
          }
          .width('100%')
          .height('100%')
          .backgroundColor(Color.White)
          .justifyContent(FlexAlign.Center)
        }
        // 刻意**不放**「改地址」按钮：地址页是错误兜底，不是常驻入口。
        // 需要改地址的三种情况（引擎没起 / 401 / 403）下面三个回调都会自动把它翻出来，
        // 用户不需要、也不应该主动去找它——那只会让人以为每次都得填点什么。
      }
    }
    .width('100%')
    .height('100%')
  }
}
