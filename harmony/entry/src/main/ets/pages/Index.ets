// KingCode 鸿蒙客户端 —— ArkWeb 壳。
//
// 角色与 mac/、win/ 两个客户端相同：引擎（dsh + KingCode 组合树）跑在融合开发引擎的
// openEuler 虚拟机里，本应用只是浏览器壳 + 记住引擎地址。**不内置引擎**：HarmonyOS
// 应用沙箱里没有 Node、起不了子进程，这不是选择而是边界。
//
// 与 mac/win 壳的一处关键差异：它们连 127.0.0.1（引擎同机），这里连的是**虚拟机的
// IP**——而融合开发引擎的虚拟机 IP 每次开机可能变，所以地址必须可改、必须记住，
// 且要在页面打不开时给出「先查 IP 再改地址」的指引，而不是让人对着白屏猜。
//
// 明文 HTTP + 非 loopback = 不安全上下文。crypto.randomUUID 的坑由服务端垫片
// （plugins/insecure-context-shim.js）治，本壳不需要也不应该再注入什么。
import { webview } from '@kit.ArkWeb';
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';

const PREFS_NAME = 'kingcode';
const KEY_URL = 'engineUrl';

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
    }
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
      this.prefs.putSync(KEY_URL, url);
      await this.prefs.flush();
    }
    // Web 组件已挂载时切地址要显式 loadUrl；首次挂载由 src 自己加载
    try { this.controller.loadUrl(url); } catch (ignored) { /* 组件还没 attach，src 会处理 */ }
  }

  build() {
    Stack({ alignContent: Alignment.TopEnd }) {
      if (this.editing || this.engineUrl.length === 0) {
        // ── 地址页：首启或主动改地址时 ─────────────────────────────────
        Column({ space: 16 }) {
          Text('KingCode')
            .fontSize(34)
            .fontWeight(FontWeight.Bold)
          Text('引擎跑在融合开发引擎的虚拟机里。地址问虚拟机：\n~/kingcode/deploy/harmonyos-pc/kingcode-web.sh url\n（虚拟机 IP 每次开机可能变，连不上先重问一次）')
            .fontSize(14)
            .opacity(0.7)
            .textAlign(TextAlign.Center)
          TextInput({ text: this.draft, placeholder: 'http://<虚拟机IP>:3081' })
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
                '虚拟机 IP 可能变了：去虚拟机里跑 kingcode-web.sh url 重问地址；' +
                'IP 变了还要 restart 一次服务（信任名单是启动快照）。';
              this.editing = true;
            }
          })

        // 右上角一枚不挡事的小按钮：改地址
        Button('⚙')
          .fontSize(16)
          .width(40)
          .height(40)
          .margin({ top: 10, right: 10 })
          .opacity(0.55)
          .onClick(() => {
            this.draft = this.engineUrl;
            this.editing = true;
          })
      }
    }
    .width('100%')
    .height('100%')
  }
}
