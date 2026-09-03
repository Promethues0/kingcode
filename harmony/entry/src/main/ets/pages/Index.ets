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

const PREFS_NAME = 'kingcode';
const KEY_URL = 'engineUrl';
// 原生形态的默认引擎地址。端口与 kc-hmos 的 KC_PORT 默认值一致。
const DEFAULT_ENGINE = 'http://127.0.0.1:3081';

@Entry
@Component
struct Index {
  controller: webview.WebviewController = new webview.WebviewController();
  @State engineUrl: string = '';
  @State draft: string = 'http://';
  @State editing: boolean = true;
  @State mainFrameError: string = '';
  private prefs?: preferences.Preferences;

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
              this.mainFrameError = `连不上 ${this.engineUrl}（${e.error.getErrorInfo()}）。` +
                '本机形态：引擎多半没在跑——去 HiShell 里 kc-hmos start（注意那个窗口不能关）。' +
                '虚拟机形态：IP 可能变了，去虚拟机里跑 kingcode-web.sh url 重问地址，' +
                'IP 变了还要 restart 一次服务（信任名单是启动快照）。';
              this.editing = true;
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
            // ArkWeb 的 cookie 是每 30 秒周期性落盘的。换到 cookie 之后如果 30 秒内
            // 应用被杀（或者被 aa force-stop 掉），那枚 cookie 就丢了，下次开又是 401。
            // 页面加载完就强制落一次盘，把这个窗口关掉。
            try {
              webview.WebCookieManager.saveCookieSync();
            } catch (ignored) { /* 落盘失败不影响本次会话，下个周期还会再试 */ }
          })
        // 刻意**不放**「改地址」按钮：地址页是错误兜底，不是常驻入口。
        // 需要改地址的三种情况（引擎没起 / 401 / 403）下面三个回调都会自动把它翻出来，
        // 用户不需要、也不应该主动去找它——那只会让人以为每次都得填点什么。
      }
    }
    .width('100%')
    .height('100%')
  }
}
