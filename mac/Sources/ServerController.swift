// dsh 引擎的生命周期：解析工具链 → 探活 → 需要时才拉起 → 退出时只收自己拉起的那个。
import Foundation

final class ServerController {
    enum State {
        case idle
        case starting(String)      // 状态文案
        case ready(URL)
        case failed(String)        // 面向人的失败原因
    }

    let port: Int
    private(set) var didSpawn = false
    private var process: Process?
    private let logURL: URL

    var onState: ((State) -> Void)?

    init(port: Int) {
        self.port = port
        let logDir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs", isDirectory: true)
        try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
        self.logURL = logDir.appendingPathComponent("KingCode.log")
    }

    var url: URL { URL(string: "http://127.0.0.1:\(port)")! }
    var logPath: String { logURL.path }

    // MARK: - 工具链解析

    /// 从 GUI 启动时进程 PATH 只有 /usr/bin:/bin 之类，node 必然找不到。
    /// 用登录 shell 现解一次真实 PATH（mise / homebrew / nvm 都能覆盖），
    /// 解不出来再落到常见目录清单。
    private static func loginPath() -> String {
        let fallback = [
            "/usr/local/bin", "/opt/homebrew/bin",
            NSHomeDirectory() + "/.local/bin",
            NSHomeDirectory() + "/.local/share/mise/shims",
            "/usr/bin", "/bin", "/usr/sbin", "/sbin",
        ].joined(separator: ":")

        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        guard FileManager.default.isExecutableFile(atPath: shell) else { return fallback }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: shell)
        task.arguments = ["-l", "-c", "printf %s \"$PATH\""]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        do {
            try task.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            task.waitUntilExit()
            let resolved = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            // 登录 shell 的 PATH 与兜底清单并集，谁都不漏
            return resolved.isEmpty ? fallback : resolved + ":" + fallback
        } catch {
            return fallback
        }
    }

    private static func firstExecutable(_ candidates: [String]) -> String? {
        candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    /// 找 node 可执行文件。
    private static func findNode(path: String) -> String? {
        let fromPath = path.split(separator: ":").map { String($0) + "/node" }
        return firstExecutable(["/usr/local/bin/node", "/opt/homebrew/bin/node"] + fromPath)
    }

    /// 找 dsh 的入口脚本（直接喂给 node，绕开 `#!/usr/bin/env node` 的查找）。
    private static func findDshEntry(path: String) -> String? {
        let home = NSHomeDirectory()
        let direct = [
            home + "/.local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js",
            "/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js",
            "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js",
        ]
        if let hit = firstExecutable(direct) ?? direct.first(where: { FileManager.default.fileExists(atPath: $0) }) {
            return hit
        }
        // 退一步：PATH 里的 dsh 若是软链，跟到真身
        for dir in path.split(separator: ":") {
            let candidate = String(dir) + "/dsh"
            guard FileManager.default.fileExists(atPath: candidate) else { continue }
            let resolved = (try? FileManager.default.destinationOfSymbolicLink(atPath: candidate))
                .map { URL(fileURLWithPath: candidate).deletingLastPathComponent()
                        .appendingPathComponent($0).standardizedFileURL.path }
            return resolved ?? candidate
        }
        return nil
    }

    // MARK: - 探活

    /// 端口上是否已经有人在服务。
    private func probe(timeout: TimeInterval = 1.2, completion: @escaping (Bool) -> Void) {
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        URLSession.shared.dataTask(with: request) { _, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            completion(ok)
        }.resume()
    }

    // MARK: - 启动

    func start() {
        onState?(.starting("正在连接 KingCode 引擎…"))
        probe { [weak self] alreadyUp in
            guard let self else { return }
            if alreadyUp {
                // 已经有一个在跑（比如终端里手动起的）——附着上去，退出时不动它
                DispatchQueue.main.async { self.onState?(.ready(self.url)) }
                return
            }
            DispatchQueue.main.async { self.spawn() }
        }
    }

    private func spawn() {
        let path = Self.loginPath()
        guard let node = Self.findNode(path: path) else {
            onState?(.failed("找不到 node。请确认已安装 Node.js（KingCode 需要它来运行 dsh 引擎）。"))
            return
        }
        guard let entry = Self.findDshEntry(path: path) else {
            onState?(.failed("找不到 dsh 引擎。请先安装：npm install -g @deepseek-ai/dsh"))
            return
        }

        onState?(.starting("正在启动 KingCode 引擎…"))

        let task = Process()
        task.executableURL = URL(fileURLWithPath: node)
        task.arguments = [entry, "--profile", "kingcode", "--port", String(port)]
        task.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser

        var env = ProcessInfo.processInfo.environment
        env["PATH"] = path
        env["HOME"] = NSHomeDirectory()
        // KingCode 自己的 harness home。dsh 默认的 ~/.dsh 跨产品共用：同机另一个 dsh
        // 产品的领域预设装在 $DSH_HOME/.agent-presets 下、默认预设写在 settings.yaml
        // 里，共用会让预设选择器列出别人的预设、新会话开在别人的预设上。路径与
        // profile/setup.sh、bin/kingcode.js 一致；用户显式设了的不覆盖。
        if env["DSH_HOME"]?.isEmpty ?? true {
            env["DSH_HOME"] = URL(fileURLWithPath: NSHomeDirectory())
                .appendingPathComponent(".kingcode").path
        }
        task.environment = env

        // 日志落盘，失败时给得出线索
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        if let handle = try? FileHandle(forWritingTo: logURL) {
            task.standardOutput = handle
            task.standardError = handle
        }

        task.terminationHandler = { [weak self] proc in
            guard let self else { return }
            DispatchQueue.main.async {
                // 正常退出（我们主动 terminate）不报错
                guard self.process != nil else { return }
                let tail = self.logTail()
                self.onState?(.failed("引擎意外退出（状态码 \(proc.terminationStatus)）。\n\(tail)"))
            }
        }

        do {
            try task.run()
            process = task
            didSpawn = true
            waitUntilReady()
        } catch {
            onState?(.failed("无法启动引擎：\(error.localizedDescription)"))
        }
    }

    /// 轮询到起得来为止；引擎首启要装配整棵插件树，给足 60 秒。
    private func waitUntilReady(deadline: Date = Date().addingTimeInterval(60)) {
        probe(timeout: 1.0) { [weak self] up in
            guard let self else { return }
            if up {
                DispatchQueue.main.async { self.onState?(.ready(self.url)) }
                return
            }
            guard Date() < deadline else {
                DispatchQueue.main.async {
                    self.onState?(.failed("引擎启动超时（60 秒）。\n\(self.logTail())"))
                }
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.waitUntilReady(deadline: deadline) }
        }
    }

    private func logTail(lines: Int = 8) -> String {
        guard let text = try? String(contentsOf: logURL, encoding: .utf8) else {
            return "日志：\(logURL.path)"
        }
        let tail = text.split(separator: "\n").suffix(lines).joined(separator: "\n")
        return tail.isEmpty ? "日志：\(logURL.path)" : tail
    }

    // MARK: - 收尾

    /// 只收自己拉起的引擎；附着到别人起的服务时什么都不做。
    func shutdown() {
        guard let task = process else { return }
        process = nil          // 先清空，让 terminationHandler 知道这是预期内退出
        guard task.isRunning else { return }
        task.terminate()
        // 给它一点时间优雅退出，超时再强杀
        let deadline = Date().addingTimeInterval(3)
        while task.isRunning && Date() < deadline {
            usleep(50_000)
        }
        if task.isRunning { kill(task.processIdentifier, SIGKILL) }
    }
}
