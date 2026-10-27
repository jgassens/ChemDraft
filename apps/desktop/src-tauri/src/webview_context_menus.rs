/// WebView2's browser menus can leave real pointer/keyboard input stuck after dismissal, including
/// the editing menu in text fields. Disable them natively; page-level contextmenu handling remains
/// a second layer. WKWebView and other platforms keep their existing behavior.
#[cfg(windows)]
pub(crate) fn disable_default_context_menus<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let label = window.label().to_string();
    if let Err(error) = window.with_webview(move |webview| {
        // SAFETY: with_webview runs on the webview's owning thread. The controller and all COM
        // interfaces obtained from it stay in this closure and belong to this live webview.
        // These inherent methods use wry's existing webview2-com dependency; no direct crate
        // dependency or extra Windows bindings are needed.
        let result = unsafe {
            webview
                .controller()
                .CoreWebView2()
                .and_then(|view| view.Settings())
                .and_then(|settings| settings.SetAreDefaultContextMenusEnabled(false))
        };
        if let Err(error) = result {
            // No general native release logger is installed. perf_log is bridge-gated timing
            // telemetry, and problem_reports records panics only; neither accepts warnings.
            // Keep the native warning fallback until the app has a release logging sink.
            eprintln!("Could not disable WebView2 default context menus for {label}: {error}");
        }
    }) {
        eprintln!(
            "Could not configure WebView2 default context menus for {}: {error}",
            window.label()
        );
    }
}

#[cfg(not(windows))]
pub(crate) fn disable_default_context_menus<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>) {}
