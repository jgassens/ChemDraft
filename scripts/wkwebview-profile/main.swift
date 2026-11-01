// macOS-only diagnostic runner. No Tauri install, signing, Node server or visible UI required.
import AppKit
import WebKit
import Network
import Darwin

func stderr(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

// HTTP is intentional: file:// module-worker/WASM access differs between WebKit releases.
// Bind only to loopback, use an ephemeral port and serve only canonical files inside dist.
final class AssetServer {
    private let root: URL
    private let listener: NWListener
    private let queue = DispatchQueue(label: "org.chemdraft.wkprofile.http")
    private var requests: [String: Int] = [:]
    private var failures: [String] = []
    var onReady: ((UInt16) -> Void)?
    var onError: ((String) -> Void)?

    init(root: URL) throws {
        self.root = root.standardizedFileURL.resolvingSymlinksInPath()
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
    }

    func start() {
        listener.stateUpdateHandler = { [weak self] state in
            guard let self = self else { return }
            switch state {
            case .ready:
                guard let port = self.listener.port?.rawValue else { return }
                DispatchQueue.main.async { self.onReady?(port) }
            case .failed(let error):
                DispatchQueue.main.async { self.onError?(error.localizedDescription) }
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self = self else { return }
            connection.start(queue: self.queue)
            self.receive(connection, buffered: Data())
        }
        listener.start(queue: queue)
    }

    func stop() { listener.cancel() }

    func diagnostics() -> [String: Any] {
        queue.sync { ["requestsByPath": requests, "failedRequests": failures] }
    }

    private func receive(_ connection: NWConnection, buffered: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            guard let self = self else { connection.cancel(); return }
            var buffer = buffered
            if let data = data { buffer.append(data) }
            if buffer.count > 65536 { self.send(connection, status: 431, type: "text/plain", body: Data()); return }
            if buffer.range(of: Data("\r\n\r\n".utf8)) != nil {
                self.respond(connection, request: buffer)
            } else if complete || error != nil {
                connection.cancel()
            } else {
                self.receive(connection, buffered: buffer)
            }
        }
    }

    private func respond(_ connection: NWConnection, request: Data) {
        let line = String(decoding: request, as: UTF8.self).components(separatedBy: "\r\n").first ?? ""
        let parts = line.split(separator: " ")
        guard parts.count == 3, parts[0] == "GET" || parts[0] == "HEAD" else {
            send(connection, status: 405, type: "text/plain", body: Data("GET or HEAD required".utf8)); return
        }
        let target = String(parts[1]).components(separatedBy: "?")[0]
        guard let path = target.removingPercentEncoding, path.hasPrefix("/"),
              !path.contains("\0"), !path.contains("\\") else {
            send(connection, status: 400, type: "text/plain", body: Data("Invalid path".utf8)); return
        }
        requests[path, default: 0] += 1
        let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL.resolvingSymlinksInPath()
        guard file.path.hasPrefix(root.path + "/") else {
            failures.append("403 \(path)")
            send(connection, status: 403, type: "text/plain", body: Data("Outside dist".utf8)); return
        }
        do {
            let body = try Data(contentsOf: file)
            let mime = ["html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8",
                        "mjs": "text/javascript; charset=utf-8", "wasm": "application/wasm",
                        "json": "application/json", "css": "text/css", "svg": "image/svg+xml",
                        "png": "image/png", "woff2": "font/woff2"][file.pathExtension.lowercased()] ?? "application/octet-stream"
            send(connection, status: 200, type: mime, body: body, head: parts[0] == "HEAD")
        } catch {
            failures.append("404 \(path): \(error.localizedDescription)")
            send(connection, status: 404, type: "text/plain", body: Data("Asset not found: \(path)".utf8))
        }
    }

    private func send(_ connection: NWConnection, status: Int, type: String, body: Data, head: Bool = false) {
        let reason = status == 200 ? "OK" : "Error"
        var response = Data("HTTP/1.1 \(status) \(reason)\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n".utf8)
        if !head { response.append(body) }
        connection.send(content: response, completion: .contentProcessed { _ in connection.cancel() })
    }
}

final class ProfileRunner: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    private let root: URL
    private let start = ProcessInfo.processInfo.systemUptime
    private var server: AssetServer?
    private var webView: WKWebView?
    private var window: NSWindow?
    private var activity: NSObjectProtocol?
    private var timeout: Timer?
    private var finished = false
    private var latestProgress: Any = ["stage": "starting"]
    private var completedMeasurements: [[String: Any]] = []

    init(root: URL) { self.root = root; super.init() }

    func applicationDidFinishLaunching(_ notification: Notification) {
        activity = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiated, .idleSystemSleepDisabled],
            reason: "Run WKWebView profiling page without App Nap"
        )
        timeout = Timer.scheduledTimer(withTimeInterval: 120, repeats: false) { [weak self] _ in
            self?.fail(stage: "timeout", message: "No final page report within 120 seconds; inspect latestProgress, completed measurements and HTTP failures.")
        }
        do {
            guard FileManager.default.fileExists(atPath: root.appendingPathComponent("wkprofile.html").path) else {
                fail(stage: "input", message: "Missing \(root.path)/wkprofile.html. Build with CHEMDRAFT_WKPROFILE=1 first."); return
            }
            let server = try AssetServer(root: root)
            self.server = server
            server.onReady = { [weak self] port in self?.load(port: port) }
            server.onError = { [weak self] error in self?.fail(stage: "http-listener", message: error) }
            server.start()
        } catch { fail(stage: "http-listener", message: error.localizedDescription) }
    }

    private func load(port: UInt16) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        if #available(macOS 14.0, *) {
            configuration.preferences.inactiveSchedulingPolicy = .none
        }
        configuration.userContentController.add(self, name: "report")
        configuration.userContentController.add(self, name: "progress")
        // Keep the attached view visible to WebKit while remaining unobtrusive and non-activating.
        let size = NSSize(width: 320, height: 240)
        let view = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: configuration)
        view.navigationDelegate = self
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.alphaValue = 0.01
        window.ignoresMouseEvents = true
        window.contentView = view
        if let screen = NSScreen.main {
            let origin = NSPoint(x: screen.visibleFrame.midX - size.width / 2,
                                 y: screen.visibleFrame.midY - size.height / 2)
            window.setFrameOrigin(origin)
        }
        self.window = window
        webView = view
        window.orderFrontRegardless()
        stderr("WKWebView profile window: occlusionState=\(window.occlusionState.rawValue) visible=\(window.isVisible)")
        let url = URL(string: "http://127.0.0.1:\(port)/wkprofile.html")!
        latestProgress = ["stage": "navigation", "url": url.absoluteString]
        stderr("WKWebView profile: \(url.absoluteString) (120 s timeout)")
        view.load(URLRequest(url: url))
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame else { return }
        if message.name == "progress" {
            latestProgress = message.body
            if let progress = message.body as? [String: Any] {
                if progress["stage"] as? String == "method-finished" { completedMeasurements.append(progress) }
                stderr("WKWebView profile: sample \(progress["sample"] ?? "?") \(progress["method"] ?? "?") \(progress["stage"] ?? "?")")
            }
        } else if message.name == "report" {
            guard let report = message.body as? [String: Any] else {
                fail(stage: "report", message: "Page posted a non-object report."); return
            }
            finish(report, exitCode: report["status"] as? String == "ok" ? 0 : 1)
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail(stage: "navigation", message: error.localizedDescription)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail(stage: "navigation", message: error.localizedDescription)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        fail(stage: "web-content-process", message: "WebKit content process terminated (crash, resource limit or OS sandbox denial).")
    }

    private func fail(stage: String, message: String) {
        finish(["schemaVersion": 1, "status": "error", "error": ["stage": stage, "message": message],
                "latestProgress": latestProgress, "measurements": completedMeasurements], exitCode: 1)
    }

    private func finish(_ report: [String: Any], exitCode: Int32) {
        guard !finished else { return }
        finished = true
        timeout?.invalidate()
        var output = report
        if output["measurements"] == nil { output["measurements"] = completedMeasurements }
        let http = server?.diagnostics() ?? [:]
        let requests = http["requestsByPath"] as? [String: Int] ?? [:]
        var resultCode = exitCode
        // HTTP and evaluation evidence remain independent: caching cannot disguise a second evaluation.
        if let workers = report["workers"] as? [[String: Any]] {
            let paths = workers.compactMap { ($0["entryUrl"] as? String).flatMap { URL(string: $0)?.path } }
            let counts = Dictionary(grouping: paths, by: { $0 }).mapValues { $0.count }
            output["workers"] = workers.map { worker -> [String: Any] in
                var row = worker
                let path = (worker["entryUrl"] as? String).flatMap { URL(string: $0)?.path } ?? ""
                let fetched = requests[path, default: 0]
                let instances = counts[path, default: 0]
                let evaluations = worker["evaluations"] as? Int ?? 0
                let passed = instances > 0 && fetched == instances && evaluations == 1
                row["entryPath"] = path
                row["fetches"] = fetched
                row["instances"] = instances
                row["fetchedOncePerInstance"] = fetched == instances && instances > 0
                row["evaluatedOnce"] = evaluations == 1
                row["status"] = passed ? "ok" : "error"
                if !passed { resultCode = 1 }
                return row
            }
            if resultCode != 0 && exitCode == 0 {
                output["status"] = "error"
                output["error"] = "Worker entry fetch/evaluation counts failed; inspect workers and runner.http."
            }
        }
        output["runner"] = ["os": ProcessInfo.processInfo.operatingSystemVersionString,
                            "processorCount": ProcessInfo.processInfo.processorCount,
                            "webKitVersion": Bundle(for: WKWebView.self).infoDictionary?["CFBundleVersion"] as? String ?? "unknown",
                            "distDirectory": root.path, "timeoutSeconds": 120,
                            "elapsedMs": (ProcessInfo.processInfo.systemUptime - start) * 1000,
                            "http": http,
                            "view": "offscreen attached WKWebView; no user input"] as [String: Any]
        do {
            let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
        } catch {
            resultCode = 1
            FileHandle.standardOutput.write(Data("{\"status\":\"error\",\"error\":\"Native report JSON serialization failed\"}\n".utf8))
            stderr(error.localizedDescription)
        }
        server?.stop()
        webView?.stopLoading()
        window?.orderOut(nil)
        if let activity = activity { ProcessInfo.processInfo.endActivity(activity) }
        Darwin.exit(resultCode)
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.count != 1 || arguments[0] == "--help" {
    stderr("Usage: wkprofile /absolute/or/relative/path/to/apps/desktop/dist/wkprofile")
    Darwin.exit(arguments.first == "--help" ? 0 : 2)
}
let root = URL(fileURLWithPath: arguments[0], isDirectory: true).standardizedFileURL.resolvingSymlinksInPath()
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
let runner = ProfileRunner(root: root)
application.delegate = runner
application.run()
