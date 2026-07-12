mod export;
mod fonts;

use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, TryRecvError},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use tauri::{
    menu::{
        AboutMetadata, CheckMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu,
    },
    webview::PageLoadEvent,
    Emitter, Manager, RunEvent, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

#[cfg(target_os = "macos")]
use objc2::MainThreadMarker;
#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSEvent, NSFloatingWindowLevel, NSPasteboard, NSPasteboardTypeString, NSWindow,
    NSWindowAnimationBehavior, NSWindowCollectionBehavior, NSWindowLevel, NSWindowStyleMask,
};
#[cfg(target_os = "macos")]
use objc2_foundation::NSString;

const MAIN_WINDOW_LABEL: &str = "main";
const SPIN3D_DEBUGGER_WINDOW_LABEL: &str = "spin3d-debugger";
const SPIN3D_DEBUGGER_WINDOW_ROUTE: &str = "/?window=spin3d-debugger";
const SPIN3D_DEBUGGER_TOGGLE_COMMAND_ID: &str = "view.toggle3dDebugger";
const PREFERENCES_WINDOW_LABEL: &str = "preferences";
const PREFERENCES_WINDOW_ROUTE: &str = "/?window=preferences";
const PREFERENCES_TOGGLE_COMMAND_ID: &str = "view.togglePreferences";
const DOM_COMMAND_EVENT: &str = "chemdraft:native-command";
#[cfg(target_os = "macos")]
const PALETTE_POINTER_EVENT: &str = "chemdraft://palette-pointer";
#[cfg(target_os = "macos")]
const PALETTE_POINTER_LEAVE_EVENT: &str = "chemdraft://palette-pointer-leave";
const OPEN_DOCUMENT_EVENT: &str = "chemdraft://open-document";
const TOOLSET_WINDOW_STATE_EVENT: &str = "chemdraft://toolset-window-state";
const TOOLSET_TOGGLE_PREFIX: &str = "view.toolset.toggle.";
const AGENT_BRIDGE_ENV_VAR: &str = "CHEMDRAFT_AGENT_BRIDGE";
const AGENT_BRIDGE_CLI_ARG: &str = "--chemdraft-agent-bridge";
const ENGINE3D_PROTOCOL_VERSION: u32 = 2;
const ENGINE3D_SIDECAR_BASENAME: &str = "avogadro3d-sidecar";
const ENGINE3D_SIDECAR_ENV_VAR: &str = "CHEMDRAFT_ENGINE3D_SIDECAR";
const ENGINE3D_MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
const ENGINE3D_MAX_BATCH_LINES: usize = 128;
const ENGINE3D_SESSION_OUTPUT_TIMEOUT: Duration = Duration::from_millis(250);
const ENGINE3D_SESSION_OUTPUT_QUIET: Duration = Duration::from_millis(20);
// A poll that finds nothing buffered returns after this instead of blocking the full output
// timeout, so idle client polling never ties up a worker thread (or a session lock) for 250ms.
const ENGINE3D_SESSION_POLL_EMPTY_TIMEOUT: Duration = Duration::from_millis(30);
static ENGINE3D_SESSION_COUNTER: AtomicU64 = AtomicU64::new(1);
/// Set once app exit begins. Quit teardown destroys every palette window; without this guard those
/// Destroyed events would be recorded as user closes (visible: false) and clobber the saved
/// open-palette set that the next launch restores.
static APP_QUITTING: AtomicBool = AtomicBool::new(false);
const TOOLSET_LAYOUT_STATE_FILENAME: &str = "toolbar-state.json";
const TOOLSET_CUSTOMIZATION_STATE_FILENAME: &str = "toolbar-layout-state.json";
const MENU_COMMAND_IDS: &[&str] = &[
    "document.new",
    "document.open",
    "document.save",
    "document.saveAs",
    "export.open",
    "page.setSize.letter",
    "page.setSize.legal",
    "page.setSize.a4",
    "page.setSize.a3",
    "page.setSize.a2",
    "page.setSize.a1",
    "page.setSize.a0",
    "page.setSize.a5",
    "page.setSizeCustom",
    "page.setOrientation.portrait",
    "page.setOrientation.landscape",
    "view.toggleRulers",
    "view.toggleCrosshairs",
    "view.customizeToolbars",
    "view.customizeMainToolbar",
    "layout.group",
    "layout.ungroup",
    SPIN3D_DEBUGGER_TOGGLE_COMMAND_ID,
    PREFERENCES_TOGGLE_COMMAND_ID,
    "structure.cleanup2d",
    "chemistry.validateSelection",
    "structure.openInteractive3d",
];

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolsetWindowPosition {
    x: f64,
    y: f64,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolsetWindowState {
    toolset_id: String,
    open: bool,
    focused: bool,
    position: Option<ToolsetWindowPosition>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolsetCommandPayload {
    command_id: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeOpenDocumentPayload {
    path: String,
    display_name: String,
    contents: String,
}

#[derive(Default)]
struct PendingOpenDocument {
    payload: Mutex<Option<NativeOpenDocumentPayload>>,
}

#[derive(Default)]
struct Engine3dSidecarSessions {
    // Each session is behind its own Arc<Mutex>, so the map lock is only held for the brief
    // lookup + clone — never across the (up to 250ms) output wait. That keeps start/stop and
    // other sessions from serializing behind one session's blocking collect.
    sessions: Mutex<HashMap<String, Arc<Mutex<Engine3dManagedSession>>>>,
}

#[derive(Default)]
struct ToolsetWindowDirectory {
    // Palette window LABEL -> real toolset id. The label is lossy (non-alphanumerics collapse to
    // '-'), so it can't be reversed by parsing — we record the mapping when the window is created.
    // This lets label->id resolution and window enumeration stop scanning the manifest.
    labels: Mutex<HashMap<String, String>>,
}

struct Engine3dManagedSession {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout_rx: Receiver<String>,
    stderr_rx: Receiver<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipboardTextItem {
    r#type: String,
    text: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipboardReadPayload {
    types: Vec<String>,
    text_items: Vec<ClipboardTextItem>,
}

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClipboardWriteTextItem {
    r#type: String,
    text: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentBridgeStatus {
    enabled: bool,
    source: String,
    env_var: String,
    cli_arg: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Engine3dSidecarStatus {
    available: bool,
    protocol_version: u32,
    source: String,
    env_var: String,
    env_override_path: Option<String>,
    resolved_path: Option<String>,
    bundled_binary_name: String,
    target_triple: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Engine3dSidecarSessionOutput {
    process_session_id: String,
    stdout_lines: Vec<String>,
    stderr: String,
    exited: bool,
    exit_code: Option<i32>,
}

#[derive(Clone, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedToolsetState {
    // Window geometry only. Palette *visibility* is owned by the TypeScript side and persisted to
    // toolbar-layout-state.json (toolsetOverrides[].visible); Rust must not write a second, stale
    // copy here. Old files may still carry a `visible` key — serde ignores it on read.
    #[serde(skip_serializing_if = "Option::is_none")]
    x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    y: Option<f64>,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolsetLayoutState {
    version: u32,
    toolsets: HashMap<String, PersistedToolsetState>,
}

impl Default for ToolsetLayoutState {
    fn default() -> Self {
        Self {
            version: 1,
            toolsets: HashMap::new(),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PendingOpenDocument::default())
        .manage(Engine3dSidecarSessions::default())
        .manage(ToolsetWindowDirectory::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .menu(create_app_menu)
        .on_page_load(|webview, payload| {
            if webview.label() == MAIN_WINDOW_LABEL
                && matches!(payload.event(), PageLoadEvent::Finished)
            {
                // WKWebView applies index.html's initial `<title>ChemDraft</title>` after setup,
                // overwriting the label set by ensure_main_window_visible. Reassert the baked
                // worktree title at the page-load boundary so the actual macOS title bar, not only
                // the web document/build stamp, identifies this checkout.
                let _ = webview.window().set_title(&main_window_title());
            }
        })
        .on_menu_event(|app, event| {
            // Single brain: every menu click (toolset toggles included) routes to the JS
            // command dispatcher, which owns visibility and pushes checkmarks back via
            // `set_menu_checked`. Rust no longer opens palettes or special-cases toolsets.
            let command_id = event.id().as_ref();
            if is_routed_menu_command(command_id) {
                if let Err(error) = emit_command_to_main(app, command_id) {
                    eprintln!("Could not route ChemDraft menu command {command_id}: {error}");
                }
            }
        })
        .on_window_event(|window, event| {
            if window.label() == MAIN_WINDOW_LABEL {
                match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        if let Err(error) = window.hide() {
                            eprintln!("Could not hide ChemDraft main window: {error}");
                        }
                    }
                    _ => {}
                }
                return;
            }

            let app = window.app_handle();
            let Some(toolset_id) = toolset_id_for_window_label(app, window.label()) else {
                return;
            };

            match event {
                WindowEvent::Moved(position) => {
                    let logical_position = logical_toolset_position_from_physical(
                        position.x as f64,
                        position.y as f64,
                        window.scale_factor().unwrap_or(1.0),
                    );
                    if let Err(error) = persist_toolset_position(
                        app,
                        &toolset_id,
                        logical_position.x,
                        logical_position.y,
                    ) {
                        eprintln!(
                            "Could not persist ChemDraft toolset position {toolset_id}: {error}"
                        );
                    }
                }
                WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed => {
                    // Only a user close reaches the saved layout state; quit teardown must not.
                    if APP_QUITTING.load(Ordering::SeqCst) {
                        return;
                    }
                    if let Err(error) = mark_toolset_window_closed(app, &toolset_id) {
                        eprintln!(
                            "Could not update ChemDraft toolbar menu state {toolset_id}: {error}"
                        );
                    }
                }
                _ => {}
            }
        })
        .setup(|app| {
            let app = app.handle();
            // The Toolbars menu starts empty and is filled by JS (set_toolbars_menu) once the main
            // window loads; Rust no longer parses the manifest or applies customization for it.
            if let Err(error) = app.set_activation_policy(tauri::ActivationPolicy::Regular) {
                eprintln!("Could not set ChemDraft activation policy: {error}");
            }

            if let Err(error) = ensure_main_window_visible(app) {
                eprintln!("Could not show ChemDraft main window: {error}");
            }

            if let Err(error) = focus_main_document_window_impl(app) {
                eprintln!("Could not focus ChemDraft document window: {error}");
            }

            // Palettes never become key, so hover must be fed to their webviews (see
            // start_palette_pointer_feed's doc for why the OS won't deliver it).
            start_palette_pointer_feed(app.clone());

            if let Err(error) = build_toolset_tooltip_window(app) {
                eprintln!("Could not build the ChemDraft tooltip window: {error}");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_toolset_window,
            close_toolset_window,
            list_toolset_window_states,
            load_toolset_customization_state,
            save_toolset_customization_state,
            set_toolbars_menu,
            focus_main_document_window,
            set_menu_checked,
            plugin_storage_read,
            plugin_storage_write,
            open_plugin_panel_window,
            open_toolset_popover,
            show_toolset_tooltip_window,
            close_toolset_popover,
            set_toolset_window_focusable,
            route_toolset_command,
            read_clipboard_payload,
            write_clipboard_text_items,
            toggle_spin3d_debugger_window,
            toggle_preferences_window,
            agent_bridge_status,
            engine3d_sidecar_status,
            engine3d_sidecar_start_session,
            engine3d_sidecar_send_session,
            engine3d_sidecar_poll_session,
            engine3d_sidecar_stop_session,
            take_pending_open_document,
            export::rasterize_svg,
            fonts::list_system_fonts
        ])
        .build(tauri::generate_context!())
        .expect("error while building ChemDraft")
        .run(|app, event| match event {
            RunEvent::ExitRequested { .. } => {
                APP_QUITTING.store(true, Ordering::SeqCst);
            }
            RunEvent::Reopen { .. } => {
                if let Err(error) = ensure_main_window_visible(app) {
                    eprintln!("Could not reopen ChemDraft main window: {error}");
                }
            }
            #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
            RunEvent::Opened { urls } => {
                if let Err(error) = handle_opened_document_urls(app, urls) {
                    eprintln!("Could not open ChemDraft document from OS event: {error}");
                }
            }
            _ => {}
        });
}

fn ensure_main_window_visible<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let window = match app.get_webview_window(MAIN_WINDOW_LABEL) {
        Some(window) => window,
        None => create_main_window(app)?,
    };

    // Tauri auto-creates the config "main" window at startup (title "ChemDraft" from tauri.conf.json),
    // so create_main_window's set_title never runs on that path — apply the worktree-labeled title
    // here on the window we actually resolved, so every worktree's window is distinguishable.
    let _ = window.set_title(&main_window_title());
    window
        .set_decorations(true)
        .map_err(|error| error.to_string())?;
    configure_document_webview(&window)?;
    window
        .set_focusable(true)
        .map_err(|error| error.to_string())?;
    window
        .set_skip_taskbar(false)
        .map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.center().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn configure_document_webview<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    window
        .with_webview(|webview| unsafe {
            let view: &objc2_web_kit::WKWebView = &*webview.inner().cast();
            view.setAllowsMagnification(false);
            view.setMagnification(1.0);
        })
        .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "macos"))]
fn configure_document_webview<R: Runtime>(_window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    Ok(())
}

fn focus_main_document_window_impl<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<tauri::WebviewWindow<R>, String> {
    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "Main document window is not available.".to_string())?;

    window
        .set_focusable(true)
        .map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    focus_native_document_window(&window)?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(window)
}

#[cfg(target_os = "macos")]
fn focus_native_document_window<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    let ns_window_ptr = window.ns_window().map_err(|error| error.to_string())? as *mut NSWindow;
    let Some(ns_window) = (unsafe { ns_window_ptr.as_ref() }) else {
        return Err("Could not access native ChemDraft document window.".to_string());
    };

    ns_window.makeMainWindow();
    ns_window.makeKeyWindow();
    ns_window.makeKeyAndOrderFront(None);
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn focus_native_document_window<R: Runtime>(
    _window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    Ok(())
}

/// The main window title, suffixed with the worktree label run-app baked in at build time (e.g.
/// "ChemDraft — chemdraw-toolbars [refactor/toolbars]"). With several ChemDraft worktrees building
/// an identically-named app, this is what tells the running windows apart in the title bar,
/// Mission Control, and cmd-tab. Falls back to plain "ChemDraft" when unlabeled. See AGENTS.md.
fn main_window_title() -> String {
    match option_env!("CHEMDRAFT_WORKTREE_LABEL") {
        Some(label) if !label.trim().is_empty() => format!("ChemDraft — {}", label.trim()),
        _ => "ChemDraft".to_string(),
    }
}

fn create_main_window<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<tauri::WebviewWindow<R>, String> {
    let title = main_window_title();
    if let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW_LABEL)
    {
        // The config (tauri.conf.json) fixes the title to "ChemDraft"; override it post-build so the
        // worktree label shows even on this primary path.
        let window = WebviewWindowBuilder::from_config(app, config)
            .map_err(|error| error.to_string())?
            .build()
            .map_err(|error| error.to_string())?;
        let _ = window.set_title(&title);
        return Ok(window);
    }

    WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, WebviewUrl::App("/".into()))
        .title(&title)
        .inner_size(1280.0, 820.0)
        .min_inner_size(900.0, 640.0)
        .resizable(true)
        .accept_first_mouse(true)
        .visible(true)
        .center()
        .build()
        .map_err(|error| error.to_string())
}

/// Window geometry supplied by JS (which owns the toolbar registry) when opening a palette, so Rust
/// doesn't have to read the manifest for the title/size. `title` is the toolset title; Rust adds the
/// "ChemDraft " prefix. The initial size is a starting point — PaletteWindow resizes to fit content.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolsetWindowGeometry {
    title: String,
    width: f64,
    height: f64,
    // Default top-left for a first-ever placement (JS staggers by registry order); a persisted
    // position overrides it.
    x: f64,
    y: f64,
}

#[tauri::command]
fn open_toolset_window(
    app: tauri::AppHandle,
    toolset_id: String,
    window: Option<ToolsetWindowGeometry>,
) -> Result<ToolsetWindowState, String> {
    ensure_toolset_window(&app, &toolset_id, window.as_ref())?;
    set_toolset_menu_checked(&app, &toolset_id, true)?;

    let state = toolset_state(&app, &toolset_id)?;
    let _ = emit_toolset_window_state_to_main(&app, &state);
    Ok(state)
}

#[tauri::command]
fn close_toolset_window(
    app: tauri::AppHandle,
    toolset_id: String,
) -> Result<ToolsetWindowState, String> {
    let window = app.get_webview_window(&toolset_window_label(&toolset_id));
    if let Some(window) = window.as_ref() {
        if let Some(position) = current_toolset_window_position(window) {
            persist_toolset_position(&app, &toolset_id, position.x, position.y)?;
        }
    }

    let state = mark_toolset_window_closed(&app, &toolset_id)?;

    if let Some(window) = window {
        window.hide().map_err(|error| error.to_string())?;
    }

    Ok(state)
}

#[tauri::command]
fn list_toolset_window_states(app: tauri::AppHandle) -> Result<Vec<ToolsetWindowState>, String> {
    // Report the state of every palette window we've opened this session (from the directory),
    // rather than scanning the manifest. The JS reconciler only cares about which are open.
    let toolset_ids: Vec<String> = {
        let directory = app.state::<ToolsetWindowDirectory>();
        let labels = directory.labels.lock().map_err(|error| error.to_string())?;
        labels.values().cloned().collect()
    };
    toolset_ids
        .iter()
        .map(|toolset_id| toolset_state(&app, toolset_id))
        .collect()
}

#[tauri::command]
fn load_toolset_customization_state(
    app: tauri::AppHandle,
) -> Result<Option<serde_json::Value>, String> {
    let path = toolset_customization_state_path(&app)?;
    let Ok(contents) = fs::read_to_string(path) else {
        return Ok(None);
    };

    serde_json::from_str(&contents)
        .map(Some)
        .map_err(|error| format!("Toolbar customization state is invalid: {error}"))
}

/// JS owns toolbar customization now (visibility, layout, user toolsets). It serializes the whole
/// `ToolsetLayoutState` and persists it here; Rust just writes the opaque JSON to disk.
#[tauri::command]
fn save_toolset_customization_state(
    app: tauri::AppHandle,
    state: serde_json::Value,
) -> Result<(), String> {
    let path = toolset_customization_state_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let contents = serde_json::to_string_pretty(&state).map_err(|error| error.to_string())?;
    fs::write(path, contents).map_err(|error| error.to_string())
}

/// JS pushes the Toolbars menu model (which toolsets exist, their titles, current visibility) and
/// Rust rebuilds the app menu with that Toolbars submenu — so the menu's source of truth is the TS
/// toolbar registry, not Rust's manifest copy. Runs on the main thread; per-toggle checkmark flips
/// still go through set_menu_checked (in place, no rebuild).
#[tauri::command]
fn set_toolbars_menu(
    app: tauri::AppHandle,
    entries: Vec<ToolbarMenuEntry>,
    rulers_visible: bool,
    crosshairs_visible: bool,
) -> Result<(), String> {
    // JS carries the current View-toggle state so the whole-menu rebuild preserves the Show Rulers /
    // Show Crosshairs checkmarks (they aren't re-mirrored by set_menu_checked like toolset toggles).
    let view_state = ViewMenuState {
        rulers_visible,
        crosshairs_visible,
    };
    app.clone()
        .run_on_main_thread(move || {
            match create_app_menu_for_toolsets(&app, &entries, view_state)
                .and_then(|menu| app.set_menu(menu).map(|_| ()))
            {
                Ok(()) => {}
                Err(error) => eprintln!("Could not update ChemDraft toolbar menu: {error}"),
            }
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn focus_main_document_window(app: tauri::AppHandle) -> Result<(), String> {
    focus_main_document_window_impl(&app).map(|_| ())
}

/// JS owns menu check state now: after the main window changes toolset visibility it
/// pushes each toggle's checkmark here. Takes the full menu command id
/// (e.g. `view.toolset.toggle.core.main`) so it works for any check menu item.
#[tauri::command]
fn set_menu_checked(
    app: tauri::AppHandle,
    command_id: String,
    checked: bool,
) -> Result<(), String> {
    let command_id = command_id.trim();
    if command_id.is_empty() {
        return Err("Menu command id cannot be empty.".to_string());
    }
    set_check_menu_item_checked(&app, command_id, checked)
}

/// Guards the storage path against traversal: plugin ids become directory names, so the
/// charset is restricted and dot-leading names (".", "..", hidden dirs) are rejected.
fn is_valid_plugin_storage_id(plugin_id: &str) -> bool {
    !plugin_id.is_empty()
        && !plugin_id.starts_with('.')
        && plugin_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

#[cfg(test)]
mod plugin_storage_id_tests {
    use super::is_valid_plugin_storage_id;

    #[test]
    fn accepts_reverse_domain_plugin_ids() {
        assert!(is_valid_plugin_storage_id("org.chemdraft.fixture"));
        assert!(is_valid_plugin_storage_id("nmr-predictor_v2"));
    }

    #[test]
    fn rejects_path_traversal_shapes() {
        assert!(!is_valid_plugin_storage_id(""));
        assert!(!is_valid_plugin_storage_id(".."));
        assert!(!is_valid_plugin_storage_id(".hidden"));
        assert!(!is_valid_plugin_storage_id("a/b"));
        assert!(!is_valid_plugin_storage_id("a\\b"));
        assert!(!is_valid_plugin_storage_id("a b"));
    }
}

const PLUGIN_STORAGE_MAX_BYTES: usize = 5 * 1024 * 1024;

fn plugin_storage_path<R: Runtime>(
    app: &tauri::AppHandle<R>,
    plugin_id: &str,
) -> Result<PathBuf, String> {
    if !is_valid_plugin_storage_id(plugin_id) {
        return Err(format!("Invalid plugin id \"{plugin_id}\"."));
    }
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("plugins")
        .join(plugin_id)
        .join("storage.json"))
}

#[tauri::command]
fn plugin_storage_read(app: tauri::AppHandle, plugin_id: String) -> Result<Option<String>, String> {
    let path = plugin_storage_path(&app, &plugin_id)?;
    match std::fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn plugin_storage_write(
    app: tauri::AppHandle,
    plugin_id: String,
    contents: String,
) -> Result<(), String> {
    if contents.len() > PLUGIN_STORAGE_MAX_BYTES {
        return Err(format!(
            "Plugin storage payload exceeds {PLUGIN_STORAGE_MAX_BYTES} bytes."
        ));
    }
    let path = plugin_storage_path(&app, &plugin_id)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(&path, contents).map_err(|error| error.to_string())
}

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenPluginPanelRequest {
    panel_id: String,
    title: String,
    width: Option<f64>,
    height: Option<f64>,
}

/// Plugin panel windows get the same floating-utility treatment as toolset palettes: they
/// float above the document while the app is active and hide with it on deactivate.
#[tauri::command]
fn open_plugin_panel_window(
    app: tauri::AppHandle,
    request: OpenPluginPanelRequest,
) -> Result<(), String> {
    if !is_valid_plugin_storage_id(&request.panel_id) {
        return Err(format!("Invalid plugin panel id \"{}\".", request.panel_id));
    }

    let label = format!("plugin-panel-{}", request.panel_id.replace('.', "-"));
    if let Some(window) = app.get_webview_window(&label) {
        window.show().map_err(|error| error.to_string())?;
        configure_toolset_utility_window(&window, true)?;
        return Ok(());
    }

    let width = request.width.unwrap_or(380.0);
    let height = request.height.unwrap_or(520.0);
    let window = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App(format!("/?window=pluginPanel&panelId={}", request.panel_id).into()),
    )
    .title(format!("ChemDraft {}", request.title))
    .inner_size(width, height)
    .min_inner_size(280.0, 200.0)
    .accept_first_mouse(true)
    .focusable(toolset_window_focusable())
    .resizable(true)
    .decorations(false)
    .shadow(false)
    .skip_taskbar(true)
    .build()
    .map_err(|error| error.to_string())?;

    configure_toolset_utility_window(&window, true)?;
    Ok(())
}

/// Opens (or repositions + reshows) a small floating popover window for a palette — e.g. the
/// Art color picker. A webview can't paint outside its own window, so palette popovers that are
/// taller/wider than the little palette window clip at its edge; giving the popover its OWN
/// floating window lets it overflow and float over the document, the native macOS way. The
/// window is opaque (a transparent one gets re-clipped to the main window on macOS) with a real
/// drop shadow so it reads as a panel drawn over the palette. `x`/`y` are logical screen
/// coordinates of the anchor (the palette computes them from its own window position + the
/// swatch's client rect).
#[tauri::command]
fn open_toolset_popover(
    app: tauri::AppHandle,
    toolset_id: String,
    kind: String,
    x: f64,
    y: f64,
) -> Result<(), String> {
    let label = toolset_popover_window_label(&toolset_id);
    if let Some(window) = app.get_webview_window(&label) {
        // Warm reuse: the webview already has content, so position + show immediately.
        window
            .set_position(tauri::LogicalPosition::new(x, y))
            .map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        configure_toolset_popover_window(&window, true)?;
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App(
            format!("/?window=toolsetPopover&toolsetId={toolset_id}&kind={kind}").into(),
        ),
    )
    .title("ChemDraft color picker")
    // The JS side sizes this to the popover content (setCurrentWindowLogicalSize); start with a
    // sensible color-picker footprint so the first paint isn't jarringly wrong.
    .inner_size(320.0, 300.0)
    .min_inner_size(96.0, 56.0)
    .accept_first_mouse(true)
    // Unlike the button-only palettes, the color picker has hex/RGB text inputs, so its window
    // must be able to take keyboard focus. It stays a NonactivatingPanel (see below), so
    // becoming key doesn't yank the app's activation away from the document.
    .focusable(true)
    .resizable(false)
    .decorations(false)
    .skip_taskbar(true)
    // Build hidden on the FIRST open so the cold webview doesn't flash a blank 320x300 window while
    // it loads. The popover reveals itself (getCurrentWindow().show()) once it has painted its real
    // content at the right size — see PalettePopoverWindow.
    .visible(false)
    .position(x, y)
    .build()
    .map_err(|error| error.to_string())?;

    configure_toolset_popover_window(&window, false)?;
    Ok(())
}

/// Same floating NonactivatingPanel treatment as the palettes, but focusable so the color
/// picker's text inputs work. `configure_toolset_utility_window` force-sets focusable(false),
/// so re-assert focusable(true) afterwards.
fn configure_toolset_popover_window<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    order_front: bool,
) -> Result<(), String> {
    configure_toolset_utility_window(window, order_front)?;
    window
        .set_focusable(true)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn close_toolset_popover(app: tauri::AppHandle, toolset_id: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&toolset_popover_window_label(&toolset_id)) {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn toolset_popover_window_label(toolset_id: &str) -> String {
    format!("toolset-popover-{}", toolset_id.replace('.', "-"))
}

/// Toggle a palette window's focusability. Palettes ship `focusable(false)` (they never steal key
/// status — see `toolset_window_focusable`), but the in-place customize gallery's search field needs
/// keyboard focus. Mirrors the popover precedent: `configure_toolset_popover_window` re-asserts
/// `set_focusable(true)` on a NonactivatingPanel and the color-picker hex input proves a text field
/// then receives input without the panel activating the app. The palette re-asserts `false` on exit.
#[tauri::command]
fn set_toolset_window_focusable(
    app: tauri::AppHandle,
    toolset_id: String,
    focusable: bool,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&toolset_window_label(&toolset_id)) {
        window
            .set_focusable(focusable)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

const TOOLSET_TOOLTIP_WINDOW_LABEL: &str = "toolset-tooltip";

/// Order the (pre-built, hidden) tooltip window front. The tooltip webview invokes this after
/// sizing + positioning itself: palettes and popovers become visible through this same
/// NSWindow::orderFront path, whereas Tauri's JS `show()` did not reliably display the
/// focusable(false) panel.
#[tauri::command]
fn show_toolset_tooltip_window(app: tauri::AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(TOOLSET_TOOLTIP_WINDOW_LABEL) else {
        return Ok(());
    };
    #[cfg(target_os = "macos")]
    {
        let ns_window_ptr = window.ns_window().map_err(|error| error.to_string())? as *mut NSWindow;
        if let Some(ns_window) = unsafe { ns_window_ptr.as_ref() } {
            ns_window.orderFront(None);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        window.show().map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Pre-build the single shared floating tooltip window, hidden. Palettes can't paint a tooltip
/// outside their content-fit windows (same constraint that gives popovers their own window), so
/// all of them share this one: a palette broadcasts text + anchor, the tooltip webview sizes and
/// positions itself, shows, and hides again on the hide broadcast (see PaletteTooltipWindow).
/// Built at startup so the first hover doesn't pay the cold-webview load. The `toolset-` label
/// prefix gives it the palette capability set; it is NOT in the ToolsetWindowDirectory, so the
/// pointer feed never treats it as a hoverable palette.
fn build_toolset_tooltip_window(app: &tauri::AppHandle) -> Result<(), String> {
    if app
        .get_webview_window(TOOLSET_TOOLTIP_WINDOW_LABEL)
        .is_some()
    {
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(
        app,
        TOOLSET_TOOLTIP_WINDOW_LABEL,
        WebviewUrl::App("/?window=toolsetTooltip".into()),
    )
    .title("ChemDraft tooltip")
    // The JS side sizes this to the rendered text before every show.
    .inner_size(120.0, 26.0)
    .min_inner_size(16.0, 14.0)
    .accept_first_mouse(false)
    .focusable(false)
    .resizable(false)
    .decorations(false)
    .skip_taskbar(true)
    .visible(false)
    .build()
    .map_err(|error| error.to_string())?;

    configure_toolset_utility_window(&window, false)?;
    // Pure chrome: click-through and invisible to hit-testing. Without this, the tooltip appearing
    // under the cursor would win windowNumberAtPoint in the pointer feed, read as "cursor left the
    // palette", hide itself, and flicker.
    #[cfg(target_os = "macos")]
    {
        if let Ok(ns_window_ptr) = window.ns_window() {
            if let Some(ns_window) = unsafe { (ns_window_ptr as *mut NSWindow).as_ref() } {
                ns_window.setIgnoresMouseEvents(true);
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn route_toolset_command(app: tauri::AppHandle, command_id: String) -> Result<(), String> {
    let command_id = command_id.trim();
    if command_id.is_empty() {
        return Err("Toolset command id cannot be empty.".to_string());
    }

    emit_command_to_main(&app, command_id)?;
    if let Err(error) = focus_main_document_window_impl(&app) {
        eprintln!(
            "Could not refocus ChemDraft document after toolbar command {command_id}: {error}"
        );
    }
    Ok(())
}

#[tauri::command]
fn read_clipboard_payload() -> Result<ClipboardReadPayload, String> {
    read_clipboard_payload_impl()
}

#[tauri::command]
fn write_clipboard_text_items(items: Vec<ClipboardWriteTextItem>) -> Result<(), String> {
    write_clipboard_text_items_impl(normalize_clipboard_write_text_items(items)?)
}

fn normalize_clipboard_write_text_items(
    items: Vec<ClipboardWriteTextItem>,
) -> Result<Vec<ClipboardWriteTextItem>, String> {
    let mut seen_types = Vec::<String>::new();
    let mut normalized_items = Vec::<ClipboardWriteTextItem>::new();

    for item in items {
        let item_type = item.r#type.trim().to_string();
        if item_type.is_empty() || item.text.is_empty() || seen_types.contains(&item_type) {
            continue;
        }

        seen_types.push(item_type.clone());
        normalized_items.push(ClipboardWriteTextItem {
            r#type: item_type,
            text: item.text,
        });
    }

    if normalized_items.is_empty() {
        return Err("Clipboard write requires at least one text item.".to_string());
    }

    Ok(normalized_items)
}

#[cfg(target_os = "macos")]
fn read_clipboard_payload_impl() -> Result<ClipboardReadPayload, String> {
    let pasteboard = NSPasteboard::generalPasteboard();
    let types = pasteboard
        .types()
        .map(|types| {
            types
                .to_vec()
                .into_iter()
                .map(|pasteboard_type| pasteboard_type.to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let text_items = pasteboard
        .types()
        .map(|types| {
            types
                .to_vec()
                .into_iter()
                .filter_map(|pasteboard_type| {
                    clipboard_text_for_type(&pasteboard, &pasteboard_type).map(|text| {
                        ClipboardTextItem {
                            r#type: pasteboard_type.to_string(),
                            text,
                        }
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(ClipboardReadPayload { types, text_items })
}

#[cfg(target_os = "macos")]
fn write_clipboard_text_items_impl(items: Vec<ClipboardWriteTextItem>) -> Result<(), String> {
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();

    let failed_types = items
        .iter()
        .filter_map(|item| {
            if set_clipboard_text_item(&pasteboard, item) {
                None
            } else {
                Some(item.r#type.clone())
            }
        })
        .collect::<Vec<_>>();

    if failed_types.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Could not write clipboard text for type(s): {}",
            failed_types.join(", ")
        ))
    }
}

#[cfg(target_os = "macos")]
fn set_clipboard_text_item(pasteboard: &NSPasteboard, item: &ClipboardWriteTextItem) -> bool {
    let text = NSString::from_str(&item.text);
    if item.r#type == "text/plain" {
        return pasteboard.setString_forType(&text, unsafe { NSPasteboardTypeString });
    }

    let pasteboard_type = NSString::from_str(&item.r#type);
    pasteboard.setString_forType(&text, &pasteboard_type)
}

#[cfg(target_os = "macos")]
fn clipboard_text_for_type(
    pasteboard: &NSPasteboard,
    pasteboard_type: &objc2_app_kit::NSPasteboardType,
) -> Option<String> {
    if let Some(text) = pasteboard.stringForType(pasteboard_type) {
        let text = text.to_string();
        if !text.is_empty() {
            return Some(text);
        }
    }

    let data = pasteboard.dataForType(pasteboard_type)?;
    decode_clipboard_text_bytes(&data.to_vec())
}

fn decode_clipboard_text_bytes(bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() {
        return None;
    }

    if looks_like_utf16_bytes(bytes) {
        if let Some(text) = decode_utf16_bytes(bytes) {
            return Some(text);
        }
    }

    if let Ok(text) = String::from_utf8(bytes.to_vec()) {
        if !text.is_empty() {
            return Some(text);
        }
    }

    decode_utf16_bytes(bytes)
}

fn looks_like_utf16_bytes(bytes: &[u8]) -> bool {
    if bytes.starts_with(&[0xfe, 0xff]) || bytes.starts_with(&[0xff, 0xfe]) {
        return true;
    }

    if bytes.len() < 4 {
        return false;
    }

    let null_count = bytes.iter().filter(|byte| **byte == 0).count();
    null_count * 4 >= bytes.len()
}

fn decode_utf16_bytes(bytes: &[u8]) -> Option<String> {
    let (big_endian, content) = if bytes.starts_with(&[0xfe, 0xff]) {
        (true, &bytes[2..])
    } else if bytes.starts_with(&[0xff, 0xfe]) {
        (false, &bytes[2..])
    } else {
        let even_nulls = bytes.iter().step_by(2).filter(|byte| **byte == 0).count();
        let odd_nulls = bytes
            .iter()
            .skip(1)
            .step_by(2)
            .filter(|byte| **byte == 0)
            .count();
        if even_nulls > odd_nulls {
            (true, bytes)
        } else if odd_nulls > even_nulls {
            (false, bytes)
        } else {
            return None;
        }
    };

    if content.len() < 2 || content.len() % 2 != 0 {
        return None;
    }

    let units = content
        .chunks_exact(2)
        .map(|chunk| {
            if big_endian {
                u16::from_be_bytes([chunk[0], chunk[1]])
            } else {
                u16::from_le_bytes([chunk[0], chunk[1]])
            }
        })
        .collect::<Vec<_>>();
    String::from_utf16(&units)
        .ok()
        .filter(|text| !text.is_empty())
}

#[cfg(not(target_os = "macos"))]
fn read_clipboard_payload_impl() -> Result<ClipboardReadPayload, String> {
    Ok(ClipboardReadPayload {
        types: Vec::new(),
        text_items: Vec::new(),
    })
}

#[cfg(not(target_os = "macos"))]
fn write_clipboard_text_items_impl(_items: Vec<ClipboardWriteTextItem>) -> Result<(), String> {
    Err("Native clipboard writes are only implemented for macOS.".to_string())
}

#[tauri::command]
fn toggle_spin3d_debugger_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(SPIN3D_DEBUGGER_WINDOW_LABEL) {
        if window.is_visible().unwrap_or(false) {
            return window.hide().map_err(|error| error.to_string());
        }
    }

    ensure_spin3d_debugger_window(&app).map(|_| ())
}

fn ensure_spin3d_debugger_window<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<tauri::WebviewWindow<R>, String> {
    if let Some(window) = app.get_webview_window(SPIN3D_DEBUGGER_WINDOW_LABEL) {
        window.show().map_err(|error| error.to_string())?;
        window.unminimize().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(window);
    }

    WebviewWindowBuilder::new(
        app,
        spin3d_debugger_window_label(),
        WebviewUrl::App(spin3d_debugger_window_route().into()),
    )
    .title("ChemDraft 3D Debugger")
    .inner_size(720.0, 460.0)
    .min_inner_size(520.0, 320.0)
    .resizable(true)
    .accept_first_mouse(true)
    .visible(true)
    .center()
    .build()
    .map_err(|error| error.to_string())
}

fn spin3d_debugger_window_label() -> &'static str {
    SPIN3D_DEBUGGER_WINDOW_LABEL
}

fn spin3d_debugger_window_route() -> &'static str {
    SPIN3D_DEBUGGER_WINDOW_ROUTE
}

#[tauri::command]
fn toggle_preferences_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PREFERENCES_WINDOW_LABEL) {
        if window.is_visible().unwrap_or(false) {
            return window.hide().map_err(|error| error.to_string());
        }
    }

    ensure_preferences_window(&app).map(|_| ())
}

fn ensure_preferences_window<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<tauri::WebviewWindow<R>, String> {
    if let Some(window) = app.get_webview_window(PREFERENCES_WINDOW_LABEL) {
        window.show().map_err(|error| error.to_string())?;
        window.unminimize().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(window);
    }

    WebviewWindowBuilder::new(
        app,
        PREFERENCES_WINDOW_LABEL,
        WebviewUrl::App(PREFERENCES_WINDOW_ROUTE.into()),
    )
    .title("ChemDraft Preferences")
    .inner_size(460.0, 360.0)
    .min_inner_size(360.0, 280.0)
    .resizable(true)
    .accept_first_mouse(true)
    .visible(true)
    .center()
    .build()
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn agent_bridge_status() -> AgentBridgeStatus {
    let env_value = std::env::var(AGENT_BRIDGE_ENV_VAR).ok();
    agent_bridge_status_from(env_value.as_deref(), std::env::args())
}

fn agent_bridge_status_from<I, S>(env_value: Option<&str>, args: I) -> AgentBridgeStatus
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let source = if agent_bridge_flag_enabled(env_value) {
        "environment"
    } else if args
        .into_iter()
        .any(|arg| arg.as_ref() == AGENT_BRIDGE_CLI_ARG)
    {
        "argument"
    } else {
        "disabled"
    };

    AgentBridgeStatus {
        enabled: source != "disabled",
        source: source.to_string(),
        env_var: AGENT_BRIDGE_ENV_VAR.to_string(),
        cli_arg: AGENT_BRIDGE_CLI_ARG.to_string(),
    }
}

fn agent_bridge_flag_enabled(value: Option<&str>) -> bool {
    matches!(
        value.map(|value| value.trim().to_ascii_lowercase()),
        Some(value) if matches!(value.as_str(), "1" | "true" | "yes" | "on" | "enabled")
    )
}

#[tauri::command]
fn engine3d_sidecar_status() -> Engine3dSidecarStatus {
    engine3d_sidecar_status_from(std::env::var(ENGINE3D_SIDECAR_ENV_VAR).ok())
}

#[tauri::command]
fn engine3d_sidecar_start_session(
    lines: Vec<String>,
    sessions: tauri::State<'_, Engine3dSidecarSessions>,
) -> Result<Engine3dSidecarSessionOutput, String> {
    let lines = normalize_engine3d_protocol_lines(lines, true)?;
    let path = resolve_engine3d_sidecar_path(std::env::var(ENGINE3D_SIDECAR_ENV_VAR).ok())
        .ok_or_else(|| {
            format!(
                "Interactive 3D sidecar is not configured. Set {ENGINE3D_SIDECAR_ENV_VAR} to a sidecar executable or bundle {}.",
                engine3d_bundled_binary_name()
            )
        })?;

    start_engine3d_sidecar_session_from_path(&path, &lines, &sessions)
}

#[tauri::command]
fn engine3d_sidecar_send_session(
    process_session_id: String,
    lines: Vec<String>,
    sessions: tauri::State<'_, Engine3dSidecarSessions>,
) -> Result<Engine3dSidecarSessionOutput, String> {
    let lines = normalize_engine3d_protocol_lines(lines, false)?;
    send_engine3d_sidecar_session_lines(&process_session_id, &lines, &sessions)
}

#[tauri::command]
fn engine3d_sidecar_poll_session(
    process_session_id: String,
    sessions: tauri::State<'_, Engine3dSidecarSessions>,
) -> Result<Engine3dSidecarSessionOutput, String> {
    poll_engine3d_sidecar_session(&process_session_id, &sessions)
}

#[tauri::command]
fn engine3d_sidecar_stop_session(
    process_session_id: String,
    sessions: tauri::State<'_, Engine3dSidecarSessions>,
) -> Result<Engine3dSidecarSessionOutput, String> {
    stop_engine3d_sidecar_session(&process_session_id, &sessions)
}

fn engine3d_sidecar_status_from(env_override: Option<String>) -> Engine3dSidecarStatus {
    let resolved_path = resolve_engine3d_sidecar_path(env_override.clone());
    let source = if resolved_path.is_some() && env_override.is_some() {
        "environment"
    } else if resolved_path.is_some() {
        "bundled"
    } else {
        "missing"
    };

    Engine3dSidecarStatus {
        available: resolved_path.is_some(),
        protocol_version: ENGINE3D_PROTOCOL_VERSION,
        source: source.to_string(),
        env_var: ENGINE3D_SIDECAR_ENV_VAR.to_string(),
        env_override_path: env_override,
        resolved_path: resolved_path.map(|path| path.to_string_lossy().to_string()),
        bundled_binary_name: engine3d_bundled_binary_name(),
        target_triple: engine3d_target_triple().to_string(),
    }
}

fn normalize_engine3d_protocol_lines(
    lines: Vec<String>,
    allow_empty: bool,
) -> Result<Vec<String>, String> {
    if lines.is_empty() && !allow_empty {
        return Err("Interactive 3D protocol batch cannot be empty.".to_string());
    }
    if lines.len() > ENGINE3D_MAX_BATCH_LINES {
        return Err(format!(
            "Interactive 3D protocol batch cannot exceed {ENGINE3D_MAX_BATCH_LINES} messages."
        ));
    }

    lines
        .into_iter()
        .map(|line| {
            if line.contains('\n') || line.contains('\r') {
                return Err(
                    "Interactive 3D protocol messages must be one JSON object per line."
                        .to_string(),
                );
            }
            if line.len() > ENGINE3D_MAX_MESSAGE_BYTES {
                return Err(format!(
                    "Interactive 3D protocol message exceeds {ENGINE3D_MAX_MESSAGE_BYTES} bytes."
                ));
            }
            Ok(line)
        })
        .collect()
}

fn resolve_engine3d_sidecar_path(env_override: Option<String>) -> Option<PathBuf> {
    // Development / explicit override: an absolute path to a locally built sidecar wins.
    if let Some(path) = env_override {
        let candidate = PathBuf::from(path.trim());
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    // Packaged app: Tauri bundles the `externalBin` sidecar (target-triple suffix stripped) next to
    // the main executable. Resolve it there so a normally launched bundle finds its sidecar instead
    // of reporting Interactive 3D unavailable when the env override is unset.
    let executable_dir = std::env::current_exe().ok()?;
    let executable_dir = executable_dir.parent()?;
    let sidecar_name = if cfg!(windows) {
        "avogadro3d-sidecar.exe"
    } else {
        "avogadro3d-sidecar"
    };
    let bundled = executable_dir.join(sidecar_name);
    if bundled.is_file() {
        Some(bundled)
    } else {
        None
    }
}

fn start_engine3d_sidecar_session_from_path(
    path: &Path,
    lines: &[String],
    sessions: &Engine3dSidecarSessions,
) -> Result<Engine3dSidecarSessionOutput, String> {
    stop_all_engine3d_sidecar_sessions(sessions)?;

    let process_session_id = format!(
        "engine3d-sidecar-{}-{}",
        std::process::id(),
        ENGINE3D_SESSION_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let mut child = Command::new(path)
        .arg("--stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start interactive 3D sidecar: {error}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Interactive 3D sidecar stdout is not available.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Interactive 3D sidecar stderr is not available.".to_string())?;
    let mut session = Engine3dManagedSession {
        stdin: child.stdin.take(),
        child,
        stdout_rx: spawn_engine3d_line_reader(stdout),
        stderr_rx: spawn_engine3d_line_reader(stderr),
    };

    write_engine3d_protocol_lines(&mut session, lines)?;
    let mut output = collect_engine3d_session_output(
        &process_session_id,
        &mut session,
        ENGINE3D_SESSION_OUTPUT_TIMEOUT,
        ENGINE3D_SESSION_OUTPUT_TIMEOUT,
    );
    let mut guard = sessions
        .sessions
        .lock()
        .map_err(|_| "Interactive 3D sidecar session state is poisoned.".to_string())?;
    guard.insert(process_session_id.clone(), Arc::new(Mutex::new(session)));
    output.process_session_id = process_session_id;
    Ok(output)
}

fn stop_all_engine3d_sidecar_sessions(sessions: &Engine3dSidecarSessions) -> Result<(), String> {
    let process_session_ids = {
        let guard = sessions
            .sessions
            .lock()
            .map_err(|_| "Interactive 3D sidecar session state is poisoned.".to_string())?;
        guard.keys().cloned().collect::<Vec<_>>()
    };

    for process_session_id in process_session_ids {
        let _ = stop_engine3d_sidecar_session(&process_session_id, sessions);
    }

    Ok(())
}

/// Look up a session handle, holding the map lock only long enough to clone the Arc.
fn engine3d_session_handle(
    process_session_id: &str,
    sessions: &Engine3dSidecarSessions,
) -> Result<Arc<Mutex<Engine3dManagedSession>>, String> {
    let guard = sessions
        .sessions
        .lock()
        .map_err(|_| "Interactive 3D sidecar session state is poisoned.".to_string())?;
    guard
        .get(process_session_id)
        .cloned()
        .ok_or_else(|| "Interactive 3D sidecar session is not active.".to_string())
}

fn send_engine3d_sidecar_session_lines(
    process_session_id: &str,
    lines: &[String],
    sessions: &Engine3dSidecarSessions,
) -> Result<Engine3dSidecarSessionOutput, String> {
    let handle = engine3d_session_handle(process_session_id, sessions)?;
    let mut session = handle
        .lock()
        .map_err(|_| "Interactive 3D sidecar session state is poisoned.".to_string())?;
    write_engine3d_protocol_lines(&mut session, lines)?;
    Ok(collect_engine3d_session_output(
        process_session_id,
        &mut session,
        ENGINE3D_SESSION_OUTPUT_TIMEOUT,
        ENGINE3D_SESSION_OUTPUT_TIMEOUT,
    ))
}

fn poll_engine3d_sidecar_session(
    process_session_id: &str,
    sessions: &Engine3dSidecarSessions,
) -> Result<Engine3dSidecarSessionOutput, String> {
    let handle = engine3d_session_handle(process_session_id, sessions)?;
    let mut session = handle
        .lock()
        .map_err(|_| "Interactive 3D sidecar session state is poisoned.".to_string())?;
    // A poll only drains what is already buffered, so return quickly when nothing is waiting
    // instead of blocking the full output timeout on an idle session.
    Ok(collect_engine3d_session_output(
        process_session_id,
        &mut session,
        ENGINE3D_SESSION_OUTPUT_TIMEOUT,
        ENGINE3D_SESSION_POLL_EMPTY_TIMEOUT,
    ))
}

fn stop_engine3d_sidecar_session(
    process_session_id: &str,
    sessions: &Engine3dSidecarSessions,
) -> Result<Engine3dSidecarSessionOutput, String> {
    let handle = {
        let mut guard = sessions
            .sessions
            .lock()
            .map_err(|_| "Interactive 3D sidecar session state is poisoned.".to_string())?;
        guard
            .remove(process_session_id)
            .ok_or_else(|| "Interactive 3D sidecar session is not active.".to_string())?
    };
    let mut session = handle
        .lock()
        .map_err(|_| "Interactive 3D sidecar session state is poisoned.".to_string())?;
    drop(session.stdin.take());
    let graceful_started = Instant::now();
    loop {
        if session
            .child
            .try_wait()
            .map_err(|error| format!("Could not poll interactive 3D sidecar: {error}"))?
            .is_some()
        {
            break;
        }
        if graceful_started.elapsed() >= ENGINE3D_SESSION_OUTPUT_TIMEOUT {
            break;
        }
        thread::sleep(Duration::from_millis(5));
    }
    if session
        .child
        .try_wait()
        .map_err(|error| format!("Could not poll interactive 3D sidecar: {error}"))?
        .is_none()
    {
        let _ = session.child.kill();
    }
    let _ = session.child.wait();
    Ok(collect_engine3d_session_output(
        process_session_id,
        &mut session,
        ENGINE3D_SESSION_OUTPUT_TIMEOUT,
        ENGINE3D_SESSION_OUTPUT_TIMEOUT,
    ))
}

fn write_engine3d_protocol_lines(
    session: &mut Engine3dManagedSession,
    lines: &[String],
) -> Result<(), String> {
    let stdin = session
        .stdin
        .as_mut()
        .ok_or_else(|| "Interactive 3D sidecar stdin is not available.".to_string())?;
    for line in lines {
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .map_err(|error| format!("Could not write interactive 3D protocol: {error}"))?;
    }
    stdin
        .flush()
        .map_err(|error| format!("Could not flush interactive 3D protocol: {error}"))
}

fn collect_engine3d_session_output(
    process_session_id: &str,
    session: &mut Engine3dManagedSession,
    timeout: Duration,
    empty_timeout: Duration,
) -> Engine3dSidecarSessionOutput {
    let started = Instant::now();
    let mut last_output = started;
    let mut saw_output = false;
    let mut stdout_lines = Vec::new();
    let mut stderr_lines = Vec::new();

    loop {
        let mut drained = false;
        drained |= drain_engine3d_receiver(&session.stdout_rx, &mut stdout_lines);
        drained |= drain_engine3d_receiver(&session.stderr_rx, &mut stderr_lines);
        if drained {
            saw_output = true;
            last_output = Instant::now();
        }
        if saw_output {
            // Output is flowing: return once it has been quiet briefly (a coalesced batch).
            if last_output.elapsed() >= ENGINE3D_SESSION_OUTPUT_QUIET {
                break;
            }
        } else if started.elapsed() >= empty_timeout {
            // Nothing has arrived yet: give up early rather than blocking the full timeout.
            break;
        }
        if started.elapsed() >= timeout {
            break;
        }
        thread::sleep(Duration::from_millis(5));
    }

    let status = session.child.try_wait().ok().flatten();
    let exited = status.is_some();
    let exit_code = status.and_then(|status| status.code());

    Engine3dSidecarSessionOutput {
        process_session_id: process_session_id.to_string(),
        stdout_lines,
        stderr: stderr_lines.join("\n"),
        exited,
        exit_code,
    }
}

fn drain_engine3d_receiver(receiver: &Receiver<String>, lines: &mut Vec<String>) -> bool {
    let mut drained = false;
    loop {
        match receiver.try_recv() {
            Ok(line) => {
                lines.push(line);
                drained = true;
            }
            Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => return drained,
        }
    }
}

fn spawn_engine3d_line_reader<R>(pipe: R) -> Receiver<String>
where
    R: Read + Send + 'static,
{
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let reader = BufReader::new(pipe);
        for line in reader.lines() {
            let Ok(line) = line else {
                break;
            };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    rx
}

fn engine3d_bundled_binary_name() -> String {
    let stem = format!("{}-{}", ENGINE3D_SIDECAR_BASENAME, engine3d_target_triple());
    if cfg!(target_os = "windows") {
        format!("{stem}.exe")
    } else {
        stem
    }
}

fn engine3d_target_triple() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "x86_64-unknown-linux-gnu"
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        "aarch64-unknown-linux-gnu"
    } else {
        "unknown"
    }
}

#[tauri::command]
fn take_pending_open_document(
    state: tauri::State<'_, PendingOpenDocument>,
) -> Result<Option<NativeOpenDocumentPayload>, String> {
    let mut pending = state.payload.lock().map_err(|error| error.to_string())?;
    Ok(pending.take())
}

fn emit_command_to_main<R: Runtime>(
    app: &tauri::AppHandle<R>,
    command_id: &str,
) -> Result<(), String> {
    let main = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "Main document window is not available.".to_string())?;
    let payload = ToolsetCommandPayload {
        command_id: command_id.to_string(),
    };

    // Single delivery: dispatch the `native-command` DOM event straight into the main webview, which
    // the JS `listenForToolsetCommands` DOM listener consumes exactly once. (We used to also emit over
    // the tauri event bus, which fanned out to several listeners and required a JS-side deduper.)
    dispatch_dom_command_event(&main, &payload)
}

fn dispatch_dom_command_event<R: Runtime>(
    main: &tauri::WebviewWindow<R>,
    payload: &ToolsetCommandPayload,
) -> Result<(), String> {
    let payload_json = serde_json::to_string(payload).map_err(|error| error.to_string())?;
    let event_json = serde_json::to_string(DOM_COMMAND_EVENT).map_err(|error| error.to_string())?;
    main.eval(format!(
        "window.dispatchEvent(new CustomEvent({event_json}, {{ detail: {payload_json} }}));"
    ))
    .map_err(|error| error.to_string())
}

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
fn handle_opened_document_urls<R: Runtime>(
    app: &tauri::AppHandle<R>,
    urls: Vec<tauri::Url>,
) -> Result<(), String> {
    let mut opened_payload = None;
    for url in urls {
        if let Some(payload) = open_document_payload_from_url(&url)? {
            opened_payload = Some(payload);
            break;
        }
    }
    let Some(payload) = opened_payload else {
        return Ok(());
    };
    let state = app.state::<PendingOpenDocument>();
    {
        let mut pending = state.payload.lock().map_err(|error| error.to_string())?;
        *pending = Some(payload.clone());
    }

    if let Err(error) = ensure_main_window_visible(app) {
        eprintln!("Could not show ChemDraft main window for opened document: {error}");
    }
    emit_open_document_to_main(app, &payload)
}

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
fn open_document_payload_from_url(
    url: &tauri::Url,
) -> Result<Option<NativeOpenDocumentPayload>, String> {
    if url.scheme() != "file" {
        return Ok(None);
    }
    let path = url
        .to_file_path()
        .map_err(|_| format!("Opened URL is not a local file path: {url}"))?;
    let contents = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let display_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Untitled.chemdraft")
        .to_string();

    Ok(Some(NativeOpenDocumentPayload {
        path: path.to_string_lossy().to_string(),
        display_name,
        contents,
    }))
}

fn emit_open_document_to_main<R: Runtime>(
    app: &tauri::AppHandle<R>,
    payload: &NativeOpenDocumentPayload,
) -> Result<(), String> {
    // Deliver via the Tauri event for a running window; a cold start (window not yet
    // listening) is covered by the pending-document state drained on mount. We deliberately
    // do not `eval` document contents into the webview to avoid a script-injection surface.
    app.emit_to(MAIN_WINDOW_LABEL, OPEN_DOCUMENT_EVENT, payload.clone())
        .map_err(|error| error.to_string())
}

fn emit_toolset_window_state_to_main<R: Runtime>(
    app: &tauri::AppHandle<R>,
    state: &ToolsetWindowState,
) -> Result<(), String> {
    if app.get_webview_window(MAIN_WINDOW_LABEL).is_none() {
        return Ok(());
    }

    app.emit_to(MAIN_WINDOW_LABEL, TOOLSET_WINDOW_STATE_EVENT, state.clone())
        .map_err(|error| error.to_string())
}

/// The checkable View-menu toggle states that must survive a full menu rebuild. `set_toolbars_menu`
/// rebuilds the whole bar via `set_menu`, which recreates the Show Rulers / Show Crosshairs items;
/// carrying their real state here keeps them from snapping back to a hardcoded default (the checkmark
/// would otherwise desync and then invert on the next click). JS is the source of truth and passes
/// the current values; the startup menu uses the defaults, which match the app's initial state.
#[derive(Clone, Copy)]
struct ViewMenuState {
    rulers_visible: bool,
    crosshairs_visible: bool,
}

impl Default for ViewMenuState {
    fn default() -> Self {
        Self {
            rulers_visible: true,
            crosshairs_visible: true,
        }
    }
}

fn create_app_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    // Empty Toolbars submenu; JS pushes the real rows via set_toolbars_menu once it loads.
    create_app_menu_for_toolsets(app, &[], ViewMenuState::default())
}

fn create_app_menu_for_toolsets<R: Runtime>(
    app: &tauri::AppHandle<R>,
    entries: &[ToolbarMenuEntry],
    view_state: ViewMenuState,
) -> tauri::Result<Menu<R>> {
    #[cfg(target_os = "macos")]
    let native_app_menu = create_native_app_menu(app)?;
    let page_setup_menu = create_page_setup_menu(app)?;
    let view_menu = create_view_menu(app, entries, view_state)?;

    Menu::with_items(
        app,
        &[
            #[cfg(target_os = "macos")]
            &native_app_menu,
            &Submenu::with_items(
                app,
                "File",
                true,
                &[
                    &MenuItem::with_id(app, "document.new", "New", true, Some("CmdOrCtrl+N"))?,
                    &MenuItem::with_id(app, "document.open", "Open...", true, Some("CmdOrCtrl+O"))?,
                    &MenuItem::with_id(app, "document.save", "Save", true, Some("CmdOrCtrl+S"))?,
                    &MenuItem::with_id(
                        app,
                        "document.saveAs",
                        "Save As...",
                        true,
                        Some("CmdOrCtrl+Shift+S"),
                    )?,
                    &PredefinedMenuItem::separator(app)?,
                    &page_setup_menu,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(
                        app,
                        "export.open",
                        "Export...",
                        true,
                        Some("CmdOrCtrl+Shift+E"),
                    )?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::close_window(app, None)?,
                    #[cfg(not(target_os = "macos"))]
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "layout.group", "Group", true, Some("CmdOrCtrl+G"))?,
                    &MenuItem::with_id(
                        app,
                        "layout.ungroup",
                        "Ungroup",
                        true,
                        Some("CmdOrCtrl+Shift+G"),
                    )?,
                ],
            )?,
            &view_menu,
            &Submenu::with_items(
                app,
                "Structure",
                true,
                &[
                    &MenuItem::with_id(
                        app,
                        "structure.cleanup2d",
                        "Clean up Structure 2D",
                        true,
                        Some("CmdOrCtrl+Shift+K"),
                    )?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(
                        app,
                        "structure.openInteractive3d",
                        "Interactive 3D Workspace...",
                        true,
                        None::<&str>,
                    )?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Analyze",
                true,
                &[&MenuItem::with_id(
                    app,
                    "chemistry.validateSelection",
                    "Validate Selected Structure",
                    true,
                    None::<&str>,
                )?],
            )?,
            &Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?,
            &Submenu::with_items(app, "Help", true, &[])?,
        ],
    )
}

#[cfg(target_os = "macos")]
fn create_native_app_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Submenu<R>> {
    let package_info = app.package_info();
    let config = app.config();
    let about_metadata = AboutMetadata {
        name: Some("ChemDraft".to_string()),
        version: Some(package_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config
            .bundle
            .publisher
            .clone()
            .map(|publisher| vec![publisher]),
        ..Default::default()
    };

    Submenu::with_items(
        app,
        package_info.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about_metadata))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )
}

fn create_page_setup_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Submenu<R>> {
    let paper_size_menu = Submenu::with_items(
        app,
        "Paper Size",
        true,
        &[
            &MenuItem::with_id(app, "page.setSize.letter", "US Letter", true, None::<&str>)?,
            &MenuItem::with_id(app, "page.setSize.legal", "US Legal", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "page.setSize.a4", "A4", true, None::<&str>)?,
            &MenuItem::with_id(app, "page.setSize.a3", "A3", true, None::<&str>)?,
            &MenuItem::with_id(app, "page.setSize.a2", "A2", true, None::<&str>)?,
            &MenuItem::with_id(app, "page.setSize.a1", "A1", true, None::<&str>)?,
            &MenuItem::with_id(app, "page.setSize.a0", "A0", true, None::<&str>)?,
            &MenuItem::with_id(app, "page.setSize.a5", "A5", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "page.setSizeCustom",
                "Custom Size…",
                true,
                None::<&str>,
            )?,
        ],
    )?;
    let orientation_menu = Submenu::with_items(
        app,
        "Orientation",
        true,
        &[
            &MenuItem::with_id(
                app,
                "page.setOrientation.portrait",
                "Portrait",
                true,
                None::<&str>,
            )?,
            &MenuItem::with_id(
                app,
                "page.setOrientation.landscape",
                "Landscape",
                true,
                None::<&str>,
            )?,
        ],
    )?;

    Submenu::with_items(
        app,
        "Page Setup",
        true,
        &[&paper_size_menu, &orientation_menu],
    )
}

fn create_view_menu<R: Runtime>(
    app: &tauri::AppHandle<R>,
    entries: &[ToolbarMenuEntry],
    view_state: ViewMenuState,
) -> tauri::Result<Submenu<R>> {
    let preferences = MenuItem::with_id(
        app,
        PREFERENCES_TOGGLE_COMMAND_ID,
        "Preferences…",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let preferences_separator = PredefinedMenuItem::separator(app)?;
    // Real checked state (from JS), not a hardcoded true — otherwise a full-menu rebuild would
    // re-check these while the feature is off, desyncing the menu from the document.
    let show_rulers = CheckMenuItem::with_id(
        app,
        "view.toggleRulers",
        "Show Rulers",
        true,
        view_state.rulers_visible,
        Some("CmdOrCtrl+R"),
    )?;
    let show_crosshairs = CheckMenuItem::with_id(
        app,
        "view.toggleCrosshairs",
        "Show Crosshairs",
        true,
        view_state.crosshairs_visible,
        Some("CmdOrCtrl+Shift+R"),
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let debugger_separator = PredefinedMenuItem::separator(app)?;
    let debugger = MenuItem::with_id(
        app,
        SPIN3D_DEBUGGER_TOGGLE_COMMAND_ID,
        "3D Debugger",
        true,
        None::<&str>,
    )?;
    let toolbars_menu = create_toolbars_menu(app, entries)?;
    let customize_toolbars = MenuItem::with_id(
        app,
        "view.customizeToolbars",
        "Customize Toolbars...",
        true,
        None::<&str>,
    )?;
    let customize_main_toolbar = MenuItem::with_id(
        app,
        "view.customizeMainToolbar",
        "Customize Main Toolbar...",
        true,
        None::<&str>,
    )?;

    Submenu::with_items(
        app,
        "View",
        true,
        &[
            &preferences,
            &preferences_separator,
            &show_rulers,
            &show_crosshairs,
            &separator,
            &debugger,
            &debugger_separator,
            &toolbars_menu,
            &customize_toolbars,
            &customize_main_toolbar,
        ],
    )
}

/// One Toolbars-menu row. JS is the source of truth for the toolset set + titles now and pushes
/// these via `set_toolbars_menu`; the startup menu derives the same shape from the manifest until
/// the manifest is removed from Rust.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolbarMenuEntry {
    toolset_id: String,
    title: String,
    visible: bool,
}

fn create_toolbars_menu<R: Runtime>(
    app: &tauri::AppHandle<R>,
    entries: &[ToolbarMenuEntry],
) -> tauri::Result<Submenu<R>> {
    let menu = Submenu::new(app, "Toolbars", true)?;

    for entry in entries {
        let item = CheckMenuItem::with_id(
            app,
            toolset_toggle_command_id(&entry.toolset_id),
            &entry.title,
            true,
            entry.visible,
            None::<&str>,
        )?;
        menu.append(&item)?;
    }

    Ok(menu)
}

fn ensure_toolset_window<R: Runtime>(
    app: &tauri::AppHandle<R>,
    toolset_id: &str,
    geometry: Option<&ToolsetWindowGeometry>,
) -> Result<(), String> {
    let label = toolset_window_label(toolset_id);

    if let Some(window) = app.get_webview_window(&label) {
        window.show().map_err(|error| error.to_string())?;
        configure_toolset_utility_window(&window, true)?;
        return Ok(());
    }

    // Title / size / default position all come from JS (which owns the toolbar registry). A None
    // geometry means a caller that isn't a normal open (focus of a not-yet-created window, or a
    // legacy alias); give it a generic placeholder instead of reading the manifest.
    let (title, width, height, default_position) = match geometry {
        Some(geometry) => (
            format!("ChemDraft {}", geometry.title),
            geometry.width,
            geometry.height,
            ToolsetWindowPosition {
                x: geometry.x,
                y: geometry.y,
            },
        ),
        None => (
            "ChemDraft Toolbar".to_string(),
            200.0,
            400.0,
            ToolsetWindowPosition { x: 88.0, y: 154.0 },
        ),
    };
    // A persisted position wins (the user moved it before); otherwise the JS-supplied default.
    let position = persisted_toolset_position(app, toolset_id).unwrap_or(default_position);

    // Record label -> id so the Moved/Destroyed handlers and enumeration can resolve the toolset
    // without the manifest (the label itself is lossy).
    if let Ok(mut labels) = app.state::<ToolsetWindowDirectory>().labels.lock() {
        labels.insert(label.clone(), toolset_id.to_string());
    }

    let window = match WebviewWindowBuilder::new(
        app,
        label.clone(),
        WebviewUrl::App(format!("/?window=toolset&toolsetId={toolset_id}").into()),
    )
    .title(title)
    .inner_size(width, height)
    // The window is sized to its actual palette content by the JS side (PaletteWindow
    // applySize). The manifest's min sizes were tuned for the old docked/web layout and are far too
    // large for a content-fit floating window (e.g. Art's 760), which left a big blank area beside
    // the tools — so keep only a tiny hard floor here.
    .min_inner_size(96.0, 56.0)
    .accept_first_mouse(true)
    .focusable(toolset_window_focusable())
    .resizable(true)
    .decorations(false)
    .shadow(false)
    .skip_taskbar(true)
    .position(position.x, position.y)
    .build()
    {
        Ok(window) => window,
        Err(error) => {
            // Roll back the directory entry we optimistically inserted above, so a failed build
            // doesn't leave a phantom label -> id mapping that enumeration and label resolution
            // would treat as a real (but nonexistent) window.
            if let Ok(mut labels) = app.state::<ToolsetWindowDirectory>().labels.lock() {
                labels.remove(&label);
            }
            return Err(error.to_string());
        }
    };

    configure_toolset_utility_window(&window, true)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn configure_toolset_utility_window<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    order_front: bool,
) -> Result<(), String> {
    let ns_window_ptr = window.ns_window().map_err(|error| error.to_string())? as *mut NSWindow;
    let Some(ns_window) = (unsafe { ns_window_ptr.as_ref() }) else {
        return Err("Could not access native ChemDraft toolbar window.".to_string());
    };

    let style = ns_window.styleMask()
        | NSWindowStyleMask::UtilityWindow
        | NSWindowStyleMask::NonactivatingPanel;
    ns_window.setStyleMask(style);
    ns_window.setLevel(toolset_utility_window_level());
    ns_window.setHidesOnDeactivate(toolset_window_hides_on_deactivate());
    ns_window.setCanHide(true);
    ns_window.setIgnoresMouseEvents(false);
    ns_window.setAcceptsMouseMovedEvents(true);
    ns_window.setAnimationBehavior(NSWindowAnimationBehavior::UtilityWindow);

    let mut collection_behavior = ns_window.collectionBehavior();
    collection_behavior.insert(
        NSWindowCollectionBehavior::Transient
            | NSWindowCollectionBehavior::Auxiliary
            | NSWindowCollectionBehavior::IgnoresCycle
            | NSWindowCollectionBehavior::MoveToActiveSpace,
    );
    collection_behavior.remove(NSWindowCollectionBehavior::CanJoinAllApplications);
    ns_window.setCollectionBehavior(collection_behavior);
    window
        .set_focusable(toolset_window_focusable())
        .map_err(|error| error.to_string())?;
    // A hidden pre-warm build (the popover's first creation) sets its NSPanel traits here but must
    // NOT be ordered front yet — it reveals itself once its webview has painted real content, so the
    // user never sees a blank window loading. Every other caller shows immediately.
    if order_front {
        ns_window.orderFront(None);
    }

    Ok(())
}

/// Local (top-left origin, logical px) pointer position inside a palette window. Tagged with the
/// toolset id because a plain JS `listen()` receives events regardless of the emit target — each
/// palette filters to its own id (the same pattern the popover-content events use).
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PalettePointerPayload {
    toolset_id: String,
    x: f64,
    y: f64,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PalettePointerLeavePayload {
    toolset_id: String,
}

/// Feed hover into the palette webviews. The palettes are non-activating panels that never become
/// the key window (deliberately — clicking them must not steal the document's focus), and macOS
/// only routes mouseMoved/hover to the key window; WKWebView's own tracking is key-window-scoped
/// too, so CSS :hover, pointerenter, and therefore tooltips simply never fire in them (adding our
/// own NSTrackingArea was tried and WebKit still swallowed it). Instead: poll the real cursor on
/// the main thread, hit-test which palette window is frontmost under it (windowNumberAtPoint sees
/// every on-screen window, so anything overlapping a palette correctly suppresses hover), and push
/// window-local coordinates into that palette; PaletteWindow synthesizes pointerover/out from them.
#[cfg(target_os = "macos")]
fn start_palette_pointer_feed(app: tauri::AppHandle) {
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct FeedState {
        /// (window label, toolset id) currently under the cursor.
        last: Option<(String, String)>,
        last_x: f64,
        last_y: f64,
    }

    fn emit_leave(app: &tauri::AppHandle, label: &str, toolset_id: String) {
        let _ = app.emit_to(
            label,
            PALETTE_POINTER_LEAVE_EVENT,
            PalettePointerLeavePayload { toolset_id },
        );
    }

    let state: Arc<Mutex<FeedState>> = Arc::new(Mutex::new(FeedState::default()));
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(60));
        let app_handle = app.clone();
        let state = Arc::clone(&state);
        let _ = app.run_on_main_thread(move || {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            // Bottom-left-origin global screen points; NSWindow frames share the same space.
            let mouse = NSEvent::mouseLocation();
            let front_window_number =
                NSWindow::windowNumberAtPoint_belowWindowWithWindowNumber(mouse, 0, mtm);

            let entries: Vec<(String, String)> = app_handle
                .state::<ToolsetWindowDirectory>()
                .labels
                .lock()
                .map(|labels| {
                    labels
                        .iter()
                        .map(|(label, toolset_id)| (label.clone(), toolset_id.clone()))
                        .collect()
                })
                .unwrap_or_default();

            let mut hovered: Option<(String, PalettePointerPayload)> = None;
            for (label, toolset_id) in entries {
                let Some(window) = app_handle.get_webview_window(&label) else {
                    continue;
                };
                if !window.is_visible().unwrap_or(false) {
                    continue;
                }
                let Ok(ns_window_ptr) = window.ns_window() else {
                    continue;
                };
                let Some(ns_window) = (unsafe { (ns_window_ptr as *mut NSWindow).as_ref() }) else {
                    continue;
                };
                if ns_window.windowNumber() != front_window_number {
                    continue;
                }
                // Borderless panel: content rect == frame, so frame-local is webview-local. Flip
                // the y axis to the web's top-left origin; points == CSS px.
                let frame = ns_window.frame();
                hovered = Some((
                    label,
                    PalettePointerPayload {
                        toolset_id,
                        x: mouse.x - frame.origin.x,
                        y: frame.size.height - (mouse.y - frame.origin.y),
                    },
                ));
                break;
            }

            let Ok(mut state) = state.lock() else {
                return;
            };
            match hovered {
                Some((label, payload)) => {
                    let changed = state
                        .last
                        .as_ref()
                        .map(|(last_label, _)| last_label != &label)
                        .unwrap_or(true);
                    let moved = (payload.x - state.last_x).abs() >= 1.0
                        || (payload.y - state.last_y).abs() >= 1.0;
                    if changed {
                        if let Some((previous_label, previous_toolset)) = state.last.take() {
                            emit_leave(&app_handle, &previous_label, previous_toolset);
                        }
                    }
                    if changed || moved {
                        let _ = app_handle.emit_to(
                            label.as_str(),
                            PALETTE_POINTER_EVENT,
                            payload.clone(),
                        );
                        state.last_x = payload.x;
                        state.last_y = payload.y;
                        state.last = Some((label, payload.toolset_id));
                    }
                }
                None => {
                    if let Some((previous_label, previous_toolset)) = state.last.take() {
                        emit_leave(&app_handle, &previous_label, previous_toolset);
                    }
                }
            }
        });
    });
}

#[cfg(not(target_os = "macos"))]
fn start_palette_pointer_feed(_app: tauri::AppHandle) {}

fn toolset_window_focusable() -> bool {
    false
}

#[cfg(target_os = "macos")]
fn toolset_utility_window_level() -> NSWindowLevel {
    NSFloatingWindowLevel
}

#[cfg(target_os = "macos")]
fn toolset_window_hides_on_deactivate() -> bool {
    true
}

#[cfg(not(target_os = "macos"))]
fn configure_toolset_utility_window<R: Runtime>(
    _window: &tauri::WebviewWindow<R>,
    _order_front: bool,
) -> Result<(), String> {
    Ok(())
}

fn toolset_state<R: Runtime>(
    app: &tauri::AppHandle<R>,
    toolset_id: &str,
) -> Result<ToolsetWindowState, String> {
    match app.get_webview_window(&toolset_window_label(toolset_id)) {
        Some(window) => {
            let visible = window.is_visible().unwrap_or(false);
            Ok(ToolsetWindowState {
                toolset_id: toolset_id.to_string(),
                open: visible,
                focused: visible && window.is_focused().unwrap_or(false),
                position: current_toolset_window_position(&window)
                    .or_else(|| persisted_toolset_position(app, toolset_id)),
            })
        }
        None => Ok(ToolsetWindowState {
            toolset_id: toolset_id.to_string(),
            open: false,
            focused: false,
            position: persisted_toolset_position(app, toolset_id),
        }),
    }
}

fn toolset_window_label(toolset_id: &str) -> String {
    let suffix: String = toolset_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect();
    format!("toolset-{suffix}")
}

fn toolset_id_for_window_label<R: Runtime>(
    app: &tauri::AppHandle<R>,
    label: &str,
) -> Option<String> {
    app.state::<ToolsetWindowDirectory>()
        .labels
        .lock()
        .ok()?
        .get(label)
        .cloned()
}

fn toolset_toggle_command_id(toolset_id: &str) -> String {
    format!("{TOOLSET_TOGGLE_PREFIX}{toolset_id}")
}

fn is_routed_menu_command(command_id: &str) -> bool {
    MENU_COMMAND_IDS.contains(&command_id) || command_id.starts_with(TOOLSET_TOGGLE_PREFIX)
}

fn persisted_toolset_position<R: Runtime>(
    app: &tauri::AppHandle<R>,
    toolset_id: &str,
) -> Option<ToolsetWindowPosition> {
    let layout_state = load_toolset_layout_state(app);
    layout_state.toolsets.get(toolset_id).and_then(|state| {
        Some(ToolsetWindowPosition {
            x: state.x?,
            y: state.y?,
        })
    })
}

fn current_toolset_window_position<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Option<ToolsetWindowPosition> {
    let position = window.outer_position().ok()?;
    Some(logical_toolset_position(
        window,
        position.x as f64,
        position.y as f64,
    ))
}

fn logical_toolset_position<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    physical_x: f64,
    physical_y: f64,
) -> ToolsetWindowPosition {
    logical_toolset_position_from_physical(
        physical_x,
        physical_y,
        window.scale_factor().unwrap_or(1.0),
    )
}

fn logical_toolset_position_from_physical(
    physical_x: f64,
    physical_y: f64,
    scale_factor: f64,
) -> ToolsetWindowPosition {
    let scale_factor = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };

    ToolsetWindowPosition {
        x: physical_x / scale_factor,
        y: physical_y / scale_factor,
    }
}

fn persist_toolset_position<R: Runtime>(
    app: &tauri::AppHandle<R>,
    toolset_id: &str,
    x: f64,
    y: f64,
) -> Result<(), String> {
    update_toolset_layout_state(app, |layout_state| {
        let state = layout_state
            .toolsets
            .entry(toolset_id.to_string())
            .or_default();
        state.x = Some(x);
        state.y = Some(y);
    })
}

fn mark_toolset_window_closed<R: Runtime>(
    app: &tauri::AppHandle<R>,
    toolset_id: &str,
) -> Result<ToolsetWindowState, String> {
    set_toolset_menu_checked(app, toolset_id, false)?;

    let state = ToolsetWindowState {
        toolset_id: toolset_id.to_string(),
        open: false,
        focused: false,
        position: persisted_toolset_position(app, toolset_id),
    };
    let _ = emit_toolset_window_state_to_main(app, &state);

    Ok(state)
}

fn update_toolset_layout_state<R: Runtime>(
    app: &tauri::AppHandle<R>,
    update: impl FnOnce(&mut ToolsetLayoutState),
) -> Result<(), String> {
    let mut layout_state = load_toolset_layout_state(app);
    update(&mut layout_state);
    save_toolset_layout_state(app, &layout_state)
}

fn load_toolset_layout_state<R: Runtime>(app: &tauri::AppHandle<R>) -> ToolsetLayoutState {
    let Ok(path) = toolset_layout_state_path(app) else {
        return ToolsetLayoutState::default();
    };
    let Ok(contents) = fs::read_to_string(path) else {
        return ToolsetLayoutState::default();
    };

    serde_json::from_str(&contents).unwrap_or_default()
}

fn save_toolset_layout_state<R: Runtime>(
    app: &tauri::AppHandle<R>,
    layout_state: &ToolsetLayoutState,
) -> Result<(), String> {
    let path = toolset_layout_state_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let contents = serde_json::to_string_pretty(layout_state).map_err(|error| error.to_string())?;
    fs::write(path, contents).map_err(|error| error.to_string())
}

fn toolset_layout_state_path<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join(TOOLSET_LAYOUT_STATE_FILENAME))
}

fn toolset_customization_state_path<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join(TOOLSET_CUSTOMIZATION_STATE_FILENAME))
}

fn set_toolset_menu_checked<R: Runtime>(
    app: &tauri::AppHandle<R>,
    toolset_id: &str,
    checked: bool,
) -> Result<(), String> {
    let command_id = toolset_toggle_command_id(toolset_id);
    set_check_menu_item_checked(app, &command_id, checked)
}

fn set_check_menu_item_checked<R: Runtime>(
    app: &tauri::AppHandle<R>,
    command_id: &str,
    checked: bool,
) -> Result<(), String> {
    let _ = set_check_menu_item_checked_now(app, command_id, checked);

    let app = app.clone();
    let command_id = command_id.to_string();

    app.clone()
        .run_on_main_thread(move || {
            if let Err(error) = set_check_menu_item_checked_now(&app, &command_id, checked) {
                eprintln!("Could not update ChemDraft menu check state {command_id}: {error}");
            }
        })
        .map_err(|error| error.to_string())
}

fn set_check_menu_item_checked_now<R: Runtime>(
    app: &tauri::AppHandle<R>,
    command_id: &str,
    checked: bool,
) -> Result<(), String> {
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    let Some(item) = find_menu_item_by_id(menu.items().unwrap_or_default(), command_id) else {
        return Ok(());
    };
    let Some(check_item) = item.as_check_menuitem() else {
        return Ok(());
    };

    check_item
        .set_checked(checked)
        .map_err(|error| error.to_string())
}

fn find_menu_item_by_id<R: Runtime>(
    items: Vec<MenuItemKind<R>>,
    command_id: &str,
) -> Option<MenuItemKind<R>> {
    for item in items {
        if item.id().as_ref() == command_id {
            return Some(item);
        }

        if let Some(submenu) = item.as_submenu() {
            if let Some(found) =
                find_menu_item_by_id(submenu.items().unwrap_or_default(), command_id)
            {
                return Some(found);
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toolset_window_labels_are_stable_and_sanitized() {
        expect_eq("toolset-core-main", &toolset_window_label("core.main"));
        expect_eq(
            "toolset-plugin-fixture",
            &toolset_window_label("plugin.fixture"),
        );
    }

    #[test]
    fn toolset_windows_do_not_take_focus_from_document_window() {
        expect_false(toolset_window_focusable());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn toolset_utility_windows_float_above_document_windows() {
        expect_true(toolset_utility_window_level() > objc2_app_kit::NSNormalWindowLevel);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn toolset_utility_windows_hide_when_app_deactivates() {
        expect_true(toolset_window_hides_on_deactivate());
    }

    #[test]
    fn retina_positions_are_persisted_as_logical_points() {
        let position = logical_toolset_position_from_physical(520.0, 380.0, 2.0);

        expect_eq(260.0, position.x);
        expect_eq(190.0, position.y);
    }

    #[test]
    fn page_setup_menu_commands_are_routed() {
        for command_id in [
            "page.setSize.letter",
            "page.setSize.legal",
            "page.setSize.a4",
            "page.setSize.a3",
            "page.setSize.a2",
            "page.setSize.a1",
            "page.setSize.a0",
            "page.setSize.a5",
            "page.setOrientation.portrait",
            "page.setOrientation.landscape",
        ] {
            expect_true(is_routed_menu_command(command_id));
        }
        expect_false(is_routed_menu_command("page.setSize.custom"));
    }

    #[test]
    fn export_menu_commands_are_routed() {
        expect_true(is_routed_menu_command("export.open"));
        expect_false(is_routed_menu_command("export.pdf"));
        expect_false(is_routed_menu_command("export.png"));
    }

    #[test]
    fn clipboard_edit_menu_commands_are_system_owned() {
        expect_false(is_routed_menu_command("clipboard.cut"));
        expect_false(is_routed_menu_command("clipboard.copy"));
        expect_false(is_routed_menu_command("clipboard.paste"));
    }

    #[test]
    fn default_capability_allows_native_export_file_writes() {
        let capability = include_str!("../capabilities/default.json");
        let parsed: serde_json::Value =
            serde_json::from_str(capability).expect("default capability should parse");
        let permissions = parsed
            .pointer("/permissions")
            .and_then(serde_json::Value::as_array)
            .expect("default capability should declare permissions");

        expect_true(permissions.iter().any(|permission| {
            permission
                .as_str()
                .is_some_and(|permission| permission == "dialog:allow-save")
        }));
        expect_true(permissions.iter().any(|permission| {
            permission
                .as_str()
                .is_some_and(|permission| permission == "fs:allow-write-text-file")
        }));
        expect_true(permissions.iter().any(|permission| {
            permission
                .as_str()
                .is_some_and(|permission| permission == "fs:allow-write-file")
        }));
        expect_true(permissions.iter().any(|permission| {
            permission
                .as_str()
                .is_some_and(|permission| permission == "allow-rasterize-svg")
        }));
    }

    #[test]
    fn default_capability_allows_toolset_startup_commands() {
        let capability = include_str!("../capabilities/default.json");
        let parsed: serde_json::Value =
            serde_json::from_str(capability).expect("default capability should parse");
        let permissions = parsed
            .pointer("/permissions")
            .and_then(serde_json::Value::as_array)
            .expect("default capability should declare permissions");

        for expected_permission in [
            "allow-load-toolset-customization-state",
            "allow-list-toolset-window-states",
            "allow-route-toolset-command",
            "allow-read-clipboard-payload",
            "allow-write-clipboard-text-items",
            "allow-open-toolset-window",
            "allow-close-toolset-window",
        ] {
            expect_true(permissions.iter().any(|permission| {
                permission
                    .as_str()
                    .is_some_and(|permission| permission == expected_permission)
            }));
        }
    }

    #[test]
    fn default_capability_allows_only_narrow_engine3d_commands() {
        let capability = include_str!("../capabilities/default.json");
        let parsed: serde_json::Value =
            serde_json::from_str(capability).expect("default capability should parse");
        let permissions = parsed
            .pointer("/permissions")
            .and_then(serde_json::Value::as_array)
            .expect("default capability should declare permissions");

        for expected_permission in [
            "allow-engine3d-sidecar-status",
            "allow-engine3d-sidecar-start-session",
            "allow-engine3d-sidecar-send-session",
            "allow-engine3d-sidecar-poll-session",
            "allow-engine3d-sidecar-stop-session",
        ] {
            expect_true(permissions.iter().any(|permission| {
                permission
                    .as_str()
                    .is_some_and(|permission| permission == expected_permission)
            }));
        }
        expect_false(permissions.iter().any(|permission| {
            permission
                .as_str()
                .is_some_and(|permission| permission.contains("shell"))
        }));
    }

    #[test]
    fn bundle_config_declares_chemical_file_associations() {
        let config = include_str!("../tauri.conf.json");
        let parsed: serde_json::Value =
            serde_json::from_str(config).expect("tauri config should parse");
        let associations = parsed
            .pointer("/bundle/fileAssociations")
            .and_then(serde_json::Value::as_array)
            .expect("bundle.fileAssociations should exist");
        let extension_sets = associations
            .iter()
            .filter_map(|association| association.get("ext"))
            .filter_map(serde_json::Value::as_array)
            .map(|extensions| {
                extensions
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();

        expect_true(
            extension_sets
                .iter()
                .any(|extensions| extensions.contains(&"chemdraft")),
        );
        expect_true(
            extension_sets
                .iter()
                .any(|extensions| extensions.contains(&"cdxml")),
        );
    }

    #[test]
    fn bundle_config_declares_target_triple_sidecar_basename() {
        let config = include_str!("../tauri.conf.json");
        let parsed: serde_json::Value =
            serde_json::from_str(config).expect("tauri config should parse");
        let external_bins = parsed
            .pointer("/bundle/externalBin")
            .and_then(serde_json::Value::as_array)
            .expect("bundle.externalBin should exist");

        expect_true(external_bins.iter().any(|entry| {
            entry
                .as_str()
                .is_some_and(|entry| entry == "binaries/avogadro3d-sidecar")
        }));
        expect_true(engine3d_bundled_binary_name().starts_with(ENGINE3D_SIDECAR_BASENAME));
        expect_true(engine3d_bundled_binary_name().contains(engine3d_target_triple()));
    }

    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
    #[test]
    fn opened_file_urls_read_document_payloads() {
        let path = std::env::temp_dir().join(format!(
            "chemdraft-open-test-{}.chemdraft",
            std::process::id()
        ));
        fs::write(&path, "<CDXML/>").expect("fixture should write");
        let url = tauri::Url::from_file_path(&path).expect("fixture path should become file URL");
        let payload = open_document_payload_from_url(&url)
            .expect("file URL should read")
            .expect("file URL should produce payload");

        expect_eq(path.to_string_lossy().to_string(), payload.path);
        expect_eq(
            path.file_name().unwrap().to_string_lossy().to_string(),
            payload.display_name,
        );
        expect_eq("<CDXML/>".to_string(), payload.contents);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn structure_menu_commands_are_routed() {
        expect_true(is_routed_menu_command("structure.cleanup2d"));
        expect_true(is_routed_menu_command("structure.openInteractive3d"));
    }

    #[test]
    fn layout_menu_commands_are_routed() {
        expect_true(is_routed_menu_command("layout.group"));
        expect_true(is_routed_menu_command("layout.ungroup"));
    }

    #[test]
    fn spin3d_debugger_menu_command_is_routed() {
        expect_true(is_routed_menu_command(SPIN3D_DEBUGGER_TOGGLE_COMMAND_ID));
    }

    #[test]
    fn spin3d_debugger_window_route_is_not_a_toolset_window() {
        expect_eq(SPIN3D_DEBUGGER_WINDOW_LABEL, spin3d_debugger_window_label());
        expect_eq(SPIN3D_DEBUGGER_WINDOW_ROUTE, spin3d_debugger_window_route());
        // The debugger window must never be mistaken for a toolset palette window:
        // every toolset window label carries the `toolset-` prefix (see toolset_window_label).
        expect_false(spin3d_debugger_window_label().starts_with("toolset-"));
    }

    #[test]
    fn agent_bridge_is_disabled_without_explicit_launch_gate() {
        let status = agent_bridge_status_from(None, ["ChemDraft"]);

        expect_false(status.enabled);
        expect_eq("disabled", status.source.as_str());
    }

    #[test]
    fn agent_bridge_can_be_enabled_by_environment_flag() {
        let status = agent_bridge_status_from(Some("true"), ["ChemDraft"]);

        expect_true(status.enabled);
        expect_eq("environment", status.source.as_str());
    }

    #[test]
    fn agent_bridge_can_be_enabled_by_launch_argument() {
        let status = agent_bridge_status_from(None, ["ChemDraft", AGENT_BRIDGE_CLI_ARG]);

        expect_true(status.enabled);
        expect_eq("argument", status.source.as_str());
    }

    #[test]
    fn engine3d_sidecar_status_tracks_env_override_without_running_shell() {
        let path =
            std::env::temp_dir().join(format!("chemdraft-engine3d-status-{}", std::process::id()));
        fs::write(&path, "").expect("fixture should write");

        let status = engine3d_sidecar_status_from(Some(path.to_string_lossy().to_string()));

        expect_true(status.available);
        expect_eq("environment", status.source.as_str());
        expect_eq(ENGINE3D_PROTOCOL_VERSION, status.protocol_version);
        expect_eq(
            Some(path.to_string_lossy().to_string()),
            status.resolved_path,
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn engine3d_protocol_batches_are_bounded_ndjson() {
        expect_true(normalize_engine3d_protocol_lines(vec!["{}".to_string()], false).is_ok());
        expect_true(normalize_engine3d_protocol_lines(vec![], false).is_err());
        expect_true(normalize_engine3d_protocol_lines(vec![], true).is_ok());
        expect_true(normalize_engine3d_protocol_lines(vec!["{}\n{}".to_string()], false).is_err());
        expect_true(
            normalize_engine3d_protocol_lines(
                vec!["x".repeat(ENGINE3D_MAX_MESSAGE_BYTES + 1)],
                false,
            )
            .is_err(),
        );
        expect_true(
            normalize_engine3d_protocol_lines(
                vec!["{}".to_string(); ENGINE3D_MAX_BATCH_LINES + 1],
                false,
            )
            .is_err(),
        );
    }

    #[cfg(unix)]
    #[test]
    fn engine3d_sidecar_session_manager_round_trips_fake_protocol() {
        use std::os::unix::fs::PermissionsExt;

        let path =
            std::env::temp_dir().join(format!("chemdraft-engine3d-fake-{}.sh", std::process::id()));
        fs::write(
            &path,
            "#!/bin/sh\necho ready-event\nwhile IFS= read -r line; do\n  echo \"$line\"\ndone\n",
        )
        .expect("fixture should write");
        let mut permissions = fs::metadata(&path)
            .expect("fixture should exist")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&path, permissions).expect("fixture should be executable");

        let sessions = Engine3dSidecarSessions::default();
        let start = start_engine3d_sidecar_session_from_path(
            &path,
            &[
                "{\"protocolVersion\":2,\"requestId\":\"r1\",\"type\":\"createSession\"}"
                    .to_string(),
            ],
            &sessions,
        )
        .expect("fake sidecar should start");
        let start_poll = poll_engine3d_sidecar_session(&start.process_session_id, &sessions)
            .expect("fake sidecar should still be active");
        let start_lines = start
            .stdout_lines
            .iter()
            .chain(start_poll.stdout_lines.iter())
            .cloned()
            .collect::<Vec<_>>();
        let mut start_lines = start_lines;
        for _ in 0..10 {
            if start_lines.contains(&"ready-event".to_string())
                && start_lines.contains(
                    &"{\"protocolVersion\":2,\"requestId\":\"r1\",\"type\":\"createSession\"}"
                        .to_string(),
                )
            {
                break;
            }
            thread::sleep(Duration::from_millis(20));
            let polled = poll_engine3d_sidecar_session(&start.process_session_id, &sessions)
                .expect("fake sidecar should still be active while waiting for startup output");
            start_lines.extend(polled.stdout_lines);
        }
        expect_true(start_lines.contains(&"ready-event".to_string()));
        expect_true(start_lines.contains(
            &"{\"protocolVersion\":2,\"requestId\":\"r1\",\"type\":\"createSession\"}".to_string(),
        ));

        let sent = send_engine3d_sidecar_session_lines(
            &start.process_session_id,
            &["{\"protocolVersion\":2,\"requestId\":\"r2\",\"type\":\"updateDrag\",\"sessionId\":\"s1\",\"atomId\":\"a1\",\"target\":{\"x\":1,\"y\":2,\"z\":3}}".to_string()],
            &sessions,
        )
        .expect("fake sidecar should receive forwarded command");
        let sent_poll = poll_engine3d_sidecar_session(&start.process_session_id, &sessions)
            .expect("fake sidecar should still be active after send");
        let sent_lines = sent
            .stdout_lines
            .iter()
            .chain(sent_poll.stdout_lines.iter())
            .cloned()
            .collect::<Vec<_>>();
        let mut sent_lines = sent_lines;
        for _ in 0..10 {
            if sent_lines
                .contains(&"{\"protocolVersion\":2,\"requestId\":\"r2\",\"type\":\"updateDrag\",\"sessionId\":\"s1\",\"atomId\":\"a1\",\"target\":{\"x\":1,\"y\":2,\"z\":3}}".to_string())
            {
                break;
            }
            thread::sleep(Duration::from_millis(20));
            let polled = poll_engine3d_sidecar_session(&start.process_session_id, &sessions)
                .expect("fake sidecar should still be active while waiting for forwarded output");
            sent_lines.extend(polled.stdout_lines);
        }

        expect_true(
            sent_lines
                .contains(&"{\"protocolVersion\":2,\"requestId\":\"r2\",\"type\":\"updateDrag\",\"sessionId\":\"s1\",\"atomId\":\"a1\",\"target\":{\"x\":1,\"y\":2,\"z\":3}}".to_string()),
        );

        let stopped = stop_engine3d_sidecar_session(&start.process_session_id, &sessions)
            .expect("fake sidecar should stop");
        expect_eq(start.process_session_id.clone(), stopped.process_session_id);
        expect_true(poll_engine3d_sidecar_session(&start.process_session_id, &sessions).is_err());

        let _ = fs::remove_file(path);
    }

    #[cfg(unix)]
    #[test]
    fn engine3d_sidecar_captures_stderr_without_protocol_output() {
        use std::os::unix::fs::PermissionsExt;

        let path = std::env::temp_dir().join(format!(
            "chemdraft-engine3d-stderr-fake-{}.sh",
            std::process::id()
        ));
        fs::write(&path, "#!/bin/sh\necho fake-sidecar-log >&2\n").expect("fixture should write");
        let mut permissions = fs::metadata(&path)
            .expect("fixture should exist")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&path, permissions).expect("fixture should be executable");

        let sessions = Engine3dSidecarSessions::default();
        let started = start_engine3d_sidecar_session_from_path(&path, &[], &sessions)
            .expect("fake sidecar should start");

        let mut stderr_text = started.stderr;
        for _ in 0..10 {
            if stderr_text.contains("fake-sidecar-log") {
                break;
            }
            thread::sleep(Duration::from_millis(20));
            if let Ok(polled) =
                poll_engine3d_sidecar_session(&started.process_session_id, &sessions)
            {
                if !polled.stderr.is_empty() {
                    stderr_text.push('\n');
                    stderr_text.push_str(&polled.stderr);
                }
            }
        }
        expect_true(stderr_text.contains("fake-sidecar-log"));

        let _ = stop_engine3d_sidecar_session(&started.process_session_id, &sessions);
        let _ = fs::remove_file(path);
    }

    #[cfg(unix)]
    #[test]
    fn engine3d_sidecar_start_replaces_stale_sessions() {
        use std::os::unix::fs::PermissionsExt;

        let path = std::env::temp_dir().join(format!(
            "chemdraft-engine3d-replace-fake-{}.sh",
            std::process::id()
        ));
        fs::write(
            &path,
            "#!/bin/sh\necho ready-event\nwhile IFS= read -r line; do\n  echo \"$line\"\ndone\n",
        )
        .expect("fixture should write");
        let mut permissions = fs::metadata(&path)
            .expect("fixture should exist")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&path, permissions).expect("fixture should be executable");

        let sessions = Engine3dSidecarSessions::default();
        let first = start_engine3d_sidecar_session_from_path(
            &path,
            &[
                "{\"protocolVersion\":2,\"requestId\":\"r1\",\"type\":\"createSession\"}"
                    .to_string(),
            ],
            &sessions,
        )
        .expect("first fake sidecar should start");
        let second = start_engine3d_sidecar_session_from_path(
            &path,
            &[
                "{\"protocolVersion\":2,\"requestId\":\"r2\",\"type\":\"createSession\"}"
                    .to_string(),
            ],
            &sessions,
        )
        .expect("second fake sidecar should replace first");

        expect_true(poll_engine3d_sidecar_session(&first.process_session_id, &sessions).is_err());
        expect_true(poll_engine3d_sidecar_session(&second.process_session_id, &sessions).is_ok());

        let _ = stop_engine3d_sidecar_session(&second.process_session_id, &sessions);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn clipboard_byte_decoder_accepts_control_prefixed_utf8_payloads() {
        let text = decode_clipboard_text_bytes(b"\x04$RXN\x06M  END")
            .expect("control-prefixed UTF-8 should decode");

        expect_true(text.contains("$RXN"));
        expect_true(text.contains("M  END"));
    }

    #[test]
    fn clipboard_byte_decoder_accepts_utf16_payloads() {
        let text = "M  END";
        let bytes = text
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();

        expect_eq(Some(text.to_string()), decode_clipboard_text_bytes(&bytes));
    }

    #[test]
    fn clipboard_write_items_are_normalized_before_native_write() {
        let items = normalize_clipboard_write_text_items(vec![
            ClipboardWriteTextItem {
                r#type: " application/vnd.chemdraft.selection+json ".to_string(),
                text: "{}".to_string(),
            },
            ClipboardWriteTextItem {
                r#type: "text/plain".to_string(),
                text: "{}".to_string(),
            },
            ClipboardWriteTextItem {
                r#type: "text/plain".to_string(),
                text: "duplicate".to_string(),
            },
            ClipboardWriteTextItem {
                r#type: "".to_string(),
                text: "missing type".to_string(),
            },
        ])
        .expect("valid clipboard write items should normalize");

        expect_eq(
            vec![
                "application/vnd.chemdraft.selection+json".to_string(),
                "text/plain".to_string(),
            ],
            items
                .iter()
                .map(|item| item.r#type.clone())
                .collect::<Vec<_>>(),
        );
    }

    fn expect_true(value: bool) {
        assert!(value);
    }

    fn expect_false(value: bool) {
        assert!(!value);
    }

    fn expect_eq<T: PartialEq + std::fmt::Debug>(expected: T, actual: T) {
        assert_eq!(expected, actual);
    }
}
