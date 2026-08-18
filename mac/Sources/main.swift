// KingCode for macOS —— dsh 引擎的原生外壳。
// 用法：直接启动即可；`--make-iconset <dir>` 供 build.sh 生成图标。
import AppKit
import WebKit

// MARK: - 图标生成模式（构建期用，不进 GUI 流程）

if CommandLine.arguments.count >= 3, CommandLine.arguments[1] == "--make-iconset" {
    let dir = URL(fileURLWithPath: CommandLine.arguments[2])
    do {
        try KMark.writeIconset(to: dir)
        print("iconset 已生成：\(dir.path)")
        exit(0)
    } catch {
        FileHandle.standardError.write("图标生成失败：\(error)\n".data(using: .utf8)!)
        exit(1)
    }
}

// MARK: - 应用

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var launchView: LaunchView!
    private let server: ServerController

    override init() {
        let port = Int(ProcessInfo.processInfo.environment["KINGCODE_PORT"] ?? "") ?? 3081
        server = ServerController(port: port)
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()

        launchView.logPath = server.logPath
        launchView.showStarting("正在连接 KingCode 引擎…")

        server.onState = { [weak self] state in
            guard let self else { return }
            switch state {
            case .idle:
                break
            case .starting(let text):
                self.launchView.showStarting(text)
            case .ready(let url):
                // 插件 bundle 的 URL 不带版本，走缓存会看到旧的品牌层；
                // 本地回环，忽略缓存没有代价。
                var request = URLRequest(url: url)
                request.cachePolicy = .reloadIgnoringLocalCacheData
                self.webView.load(request)
            case .failed(let reason):
                self.launchView.showFailure(reason)
            }
        }
        server.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        server.shutdown()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // MARK: 窗口

    private func buildWindow() {
        let frame = NSRect(x: 0, y: 0, width: 1180, height: 780)
        // 不要 .fullSizeContentView：那会让 WKWebView 铺到标题栏下面，
        // 拖拽区被网页吃掉，窗口就挪不动了（拖不到扩展屏是致命的）。
        // 只留 titlebarAppearsTransparent —— 标题栏透出窗口底色，视觉上仍
        // 与内容连成一片，但它还是一条真正可拖拽的标题栏。
        window = NSWindow(contentRect: frame,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "KingCode"
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.minSize = NSSize(width: 720, height: 520)
        window.backgroundColor = Palette.windowBackground
        window.delegate = self
        window.setFrameAutosaveName("KingCodeMainWindow")

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        // 引擎自带的 Web UI 需要剪贴板与本地存储；同源本地服务，默认策略即可
        webView = WKWebView(frame: frame, configuration: config)
        webView.navigationDelegate = self
        webView.autoresizingMask = [.width, .height]
        webView.setValue(false, forKey: "drawsBackground")  // 让底色透出来，避免加载瞬间白闪
        webView.isHidden = true

        launchView = LaunchView(frame: frame)
        launchView.autoresizingMask = [.width, .height]

        let container = NSView(frame: frame)
        container.addSubview(webView)
        container.addSubview(launchView)
        window.contentView = container

        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard launchView.superview != nil else { return }
        webView.isHidden = false
        // 淡出启动页，避免生硬跳变
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.28
            launchView.animator().alphaValue = 0
        }, completionHandler: {
            self.launchView.removeFromSuperview()
        })
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        launchView.showFailure("页面加载失败：\(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        launchView.showFailure("无法连接引擎：\(error.localizedDescription)")
    }

    /// 外部链接交给系统浏览器，别在客户端里跑丢。
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url,
           let host = url.host,
           host != "127.0.0.1", host != "localhost" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    // MARK: 菜单（不建菜单栏则 Cmd+C/V/Q 全部失灵）

    /// 用 reloadFromOrigin 而非 reload：改了品牌层插件后要能真的看到新的。
    @objc private func reloadPage() { webView.reloadFromOrigin() }

    @objc private func openInBrowser() { NSWorkspace.shared.open(server.url) }

    @objc private func openLogFile() {
        NSWorkspace.shared.selectFile(server.logPath, inFileViewerRootedAtPath: "")
    }

    private func buildMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 KingCode", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 KingCode", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 KingCode", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        mainMenu.addItem(appItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        mainMenu.addItem(editItem)

        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "显示")
        viewMenu.addItem(withTitle: "重新载入", action: #selector(reloadPage), keyEquivalent: "r")
        viewMenu.addItem(.separator())
        let fullScreen = viewMenu.addItem(withTitle: "进入全屏幕", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        viewItem.submenu = viewMenu
        mainMenu.addItem(viewItem)

        let toolsItem = NSMenuItem()
        let toolsMenu = NSMenu(title: "引擎")
        toolsMenu.addItem(withTitle: "在浏览器中打开", action: #selector(openInBrowser), keyEquivalent: "")
        toolsMenu.addItem(withTitle: "显示引擎日志", action: #selector(openLogFile), keyEquivalent: "")
        toolsItem.submenu = toolsMenu
        mainMenu.addItem(toolsItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowItem.submenu = windowMenu
        mainMenu.addItem(windowItem)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = mainMenu
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
