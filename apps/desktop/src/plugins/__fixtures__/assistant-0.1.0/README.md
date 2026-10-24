# Real Assistant 0.1.0 regression fixture

`entry.js`, `manifest.json`, and `LICENSE` are unmodified extractions of the owner's
`chemdraft-assistant-0.1.0.zip` (SHA-256
`5949aed730e83cbb31b14aaa7dd548a855cf13b3671bfe7ad6636adb2d9512a2`).
The packaged source commit is `247ec7297218d4781032a670ac4b48b58ef5dbb2`.

This is test input, never a bundled or installed production plugin. The integration test executes
the real entry in an isolated VM with a structured-cloning Worker transport, loads it through
`loadPackagedPlugin` / `PluginWorkerBridge` / the desktop runtime, and drives MainWindow's menu and
overlay actions through native report replay into `PluginPanelWindow` / `PluginReportRenderer`.
Only native IPC and Worker transport are replaced; no plugin handlers or reports are fabricated.
Both macOS and Windows installed-package origins are exercised. Native WebKit/WebView2 execution
and the Rust IPC boundary still need a packaged-app smoke test.

The upstream LICENSE includes inherited database boilerplate; this fixture contains no database
or NMR worker. It retains that file verbatim rather than editing upstream licensing assertions.
