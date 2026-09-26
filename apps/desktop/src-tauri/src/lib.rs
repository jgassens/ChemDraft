mod export;
mod fonts;
mod installed_plugins;
mod opsin;
mod windows_clipboard;

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
#[cfg(target_os = "macos")]
use tauri_plugin_sparkle_updater::SparkleUpdaterExt;

const MAIN_WINDOW_LABEL: &str = "main";

/// Helper processes (the Engine 3D sidecar, OPSIN's JVM) are console programs. Spawned from a
/// GUI-subsystem app on Windows, each would flash a console window; CREATE_NO_WINDOW suppresses it.
/// A no-op elsewhere.
pub(crate) trait WithoutConsoleWindow {
    fn without_console_window(&mut self) -> &mut Self;
}

impl WithoutConsoleWindow for Command {
    fn without_console_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}
const SPIN3D_DEBUGGER_WINDOW_LABEL: &str = "spin3d-debugger";
const SPIN3D_DEBUGGER_WINDOW_ROUTE: &str = "/?window=spin3d-debugger";
const SPIN3D_DEBUGGER_TOGGLE_COMMAND_ID: &str = "view.toggle3dDebugger";
const PREFERENCES_WINDOW_LABEL: &str = "preferences";
const PREFERENCES_WINDOW_ROUTE: &str = "/?window=preferences";
const PREFERENCES_TOGGLE_COMMAND_ID: &str = "view.togglePreferences";
#[cfg(target_os = "macos")]
const CHECK_FOR_UPDATES_COMMAND_ID: &str = "app.checkForUpdates";
const DOM_COMMAND_EVENT: &str = "chemdraft:native-command";
#[cfg(target_os = "macos")]
const PALETTE_POINTER_EVENT: &str = "chemdraft://palette-pointer";
#[cfg(target_os = "macos")]
const PALETTE_POINTER_LEAVE_EVENT: &str = "chemdraft://palette-pointer-leave";
const OPEN_DOCUMENT_EVENT: &str = "chemdraft://open-document";
const TOOLSET_WINDOW_STATE_EVENT: &str = "chemdraft://toolset-window-state";
const TOOLSET_TOGGLE_PREFIX: &str = "view.toolset.toggle.";
/// Namespace for plugin command ids (manifest-enforced). Native menu clicks on ids with this prefix
/// are routed to the webview, which invokes the plugin command (ADR-0016).
const PLUGIN_COMMAND_PREFIX: &str = "plugin.";
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

/// File ▸ Exit off macOS (macOS quits from the application menu).
#[cfg_attr(target_os = "macos", allow(dead_code))]
const APP_QUIT_COMMAND_ID: &str = "app.quit";
/// Sent to the document window when the app is about to quit; it flushes its pending session
/// autosave and answers with `quit_after_flush`. Mirrors `QUIT_FLUSH_REQUEST_EVENT` in
/// apps/desktop/src/window-manager/index.ts.
#[cfg_attr(target_os = "macos", allow(dead_code))]
const QUIT_FLUSH_REQUEST_EVENT: &str = "chemdraft://flush-before-quit";
/// How long a quit waits for the document window's flush before quitting anyway.
#[cfg_attr(target_os = "macos", allow(dead_code))]
const QUIT_FLUSH_GRACE: Duration = Duration::from_secs(3);
/// Set once a quit has been requested, so repeated close clicks don't re-request it.
static QUIT_REQUESTED: AtomicBool = AtomicBool::new(false);

/// Quit off macOS without losing the last edits. The session autosave is an 800 ms debounce in the
/// webview and the app never prompts to save, so exiting straight away dropped anything edited in
/// the last moment. Ask the document window to flush first; it confirms through `quit_after_flush`,
/// and a grace timer quits regardless if the webview can't answer.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn request_quit<R: Runtime>(app: &tauri::AppHandle<R>) {
    if QUIT_REQUESTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let asked = app.get_webview_window(MAIN_WINDOW_LABEL).is_some()
        && app
            .emit_to(MAIN_WINDOW_LABEL, QUIT_FLUSH_REQUEST_EVENT, ())
            .is_ok();
    if !asked {
        quit_now(app);
        return;
    }
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(QUIT_FLUSH_GRACE);
        quit_now(&app);
    });
}

fn quit_now<R: Runtime>(app: &tauri::AppHandle<R>) {
    // Raised first so the palette teardown that follows isn't recorded as user closes.
    APP_QUITTING.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// The document window's answer to `QUIT_FLUSH_REQUEST_EVENT`: its session is written, quit now.
#[tauri::command]
fn quit_after_flush(app: tauri::AppHandle) {
    quit_now(&app);
}
const TOOLSET_LAYOUT_STATE_FILENAME: &str = "toolbar-state.json";
const TOOLSET_CUSTOMIZATION_STATE_FILENAME: &str = "toolbar-layout-state.json";
const DOCUMENT_SESSION_FILENAME: &str = "document-session.json";
const MENU_COMMAND_IDS: &[&str] = &[
    "edit.undo",
    "edit.redo",
    "clipboard.copyAs.smiles",
    "clipboard.copyAs.inchi",
    "clipboard.copyAs.inchiKey",
    "clipboard.copyAs.cdxml",
    "clipboard.copyAs.mol",
    "clipboard.copyAs.molV2000",
    "clipboard.copyAs.svg",
    "clipboard.copyAs.png",
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
    "analyze.molecularProperties",
    "chemistry.validateSelection",
    "structure.openInteractive3d",
    "plugins.manage",
];

/// A plugin's contributed menu item, synced from the webview (which owns the plugin registry) so the
/// native menu can include it. `id` is the `plugin.*` command id, routed back by prefix (ADR-0016).
#[derive(Clone, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginMenuItemInput {
    id: String,
    label: String,
    #[serde(default = "default_menu_item_enabled")]
    enabled: bool,
}

fn default_menu_item_enabled() -> bool {
    true
}

/// The plugin menu items last synced from the webview. Read by every menu rebuild so the items
/// survive toolset-driven rebuilds, not only plugin syncs.
#[derive(Default)]
struct PluginNativeMenuItems(std::sync::Mutex<Vec<PluginMenuItemInput>>);

/// The Toolbars-menu rows and View-toggle state last pushed by JS (`set_toolbars_menu`). Stored so a
/// plugin-menu sync (`sync_plugin_menu_items`) can rebuild the whole native menu from the same model
/// without waiting for the next toolbar push — the menu's source of truth stays the TS toolbar registry.
#[derive(Default)]
struct ToolbarsMenuModel(std::sync::Mutex<(Vec<ToolbarMenuEntry>, ViewMenuState)>);

/// Which keyboard-shortcut scheme the app runs under (mirrors the webview's persisted setting; JS
/// pushes it on startup and on change via `set_keybinding_scheme`). Read at menu-build time so the
/// few native accelerators that differ between the schemes stay in step with the webview registry.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum KeybindingScheme {
    #[default]
    ChemDraft,
    ChemDraw,
}

#[derive(Default)]
struct KeybindingSchemeState(std::sync::Mutex<KeybindingScheme>);

fn current_keybinding_scheme<R: Runtime>(app: &tauri::AppHandle<R>) -> KeybindingScheme {
    app.try_state::<KeybindingSchemeState>()
        .and_then(|state| state.0.lock().ok().map(|guard| *guard))
        .unwrap_or_default()
}

#[derive(Clone, Copy, Debug, serde::Serialize)]
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
    /// Last main document window frame. Saved on every move/resize, restored by
    /// `ensure_main_window_visible`; centering is only the fallback when nothing usable was saved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    main_window: Option<MainWindowGeometry>,
}

impl Default for ToolsetLayoutState {
    fn default() -> Self {
        Self {
            version: 1,
            toolsets: HashMap::new(),
            main_window: None,
        }
    }
}

/// Main window frame in logical points: outer (top-left) position + inner content size, matching
/// what `set_position`/`set_size` take, so a saved frame round-trips exactly.
#[derive(Clone, Copy, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MainWindowGeometry {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    /// Whether the window was maximized. The frame fields keep the NORMAL (restored) frame, so
    /// un-maximizing after a relaunch returns to where the user last had it. Absent in older files.
    #[serde(default)]
    maximized: bool,
}

/// Logical points of title bar that must remain on a monitor for the window to stay grabbable.
const MAIN_WINDOW_TITLE_GRAB_PT: f64 = 22.0;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Registered first, as the plugin requires. A second launch forwards its argv here (a document
    // double-clicked while ChemDraft runs) instead of starting a rival process on the same
    // app_data_dir. macOS routes such opens to the running app itself (RunEvent::Opened).
    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
        let cwd = PathBuf::from(cwd);
        if let Err(error) = handle_opened_document_args(app, argv.into_iter().skip(1), &cwd) {
            eprintln!("Could not open ChemDraft document from a second launch: {error}");
        }
        if let Err(error) = ensure_main_window_visible(app) {
            eprintln!("Could not show ChemDraft main window for a second launch: {error}");
        }
        if let Err(error) = focus_main_document_window_impl(app) {
            eprintln!("Could not focus ChemDraft document window for a second launch: {error}");
        }
    }));

    let builder = builder
        .manage(PendingOpenDocument::default())
        .manage(Engine3dSidecarSessions::default())
        .manage(ToolsetWindowDirectory::default())
        .manage(PluginNativeMenuItems::default())
        .manage(ToolbarsMenuModel::default())
        .manage(KeybindingSchemeState::default())
        // Take over the app's OWN `tauri://` origin so one handler serves both the document and any
        // staged plugin package (ADR-0029 §6 as amended; M36). This *replaces* Tauri's built-in
        // handler rather than adding a scheme — a new scheme would be a new origin, and M35 measured
        // that a plugin package only loads same-origin. The origin is unchanged, so no origin-keyed
        // state (localStorage, IndexedDB) is disturbed. See `installed_plugins` for the full rationale.
        .register_uri_scheme_protocol("tauri", installed_plugins::handle_tauri_request)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Host-owned network transport for the allowlisted plugin-update catalog. Installed plugin
        // workers remain under connect-src 'self' and never receive this capability.
        .plugin(tauri_plugin_http::init());

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_plugin_sparkle_updater::init());

    // Only macOS has an app-wide menu bar. Elsewhere an app-wide Tauri menu is attached to EVERY
    // window, which subclasses each palette/popover with muda's menu proc; see `install_app_menu`
    // for why that crashed. There the menu is attached to the document window in `setup` instead.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(create_app_menu);

    builder
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
            #[cfg(target_os = "macos")]
            if command_id == CHECK_FOR_UPDATES_COMMAND_ID {
                check_for_updates(app);
                return;
            }
            #[cfg(not(target_os = "macos"))]
            if command_id == APP_QUIT_COMMAND_ID {
                request_quit(app);
                return;
            }
            if is_routed_menu_command(command_id) {
                if let Err(error) = emit_menu_command(app, command_id) {
                    eprintln!("Could not route ChemDraft menu command {command_id}: {error}");
                }
            }
        })
        .on_window_event(|window, event| {
            if window.label() == MAIN_WINDOW_LABEL {
                match event {
                    // macOS: closing the document window hides it and the app lives on in the
                    // Dock (RunEvent::Reopen brings it back).
                    #[cfg(target_os = "macos")]
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        if let Err(error) = window.hide() {
                            eprintln!("Could not hide ChemDraft main window: {error}");
                        }
                    }
                    // Elsewhere there is no Dock to reopen from, and the hidden tooltip and
                    // prewarmed popovers would keep a windowless process alive: closing the
                    // document window quits — after the document flushes its pending autosave.
                    #[cfg(not(target_os = "macos"))]
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        request_quit(window.app_handle());
                    }
                    WindowEvent::Destroyed => {
                        // The close button only hides the main window, so its actual destruction
                        // means the app is dying — including SIGTERM teardowns that never fire
                        // ExitRequested. Raise the quit flag so palette destruction that follows
                        // isn't recorded as user closes.
                        APP_QUITTING.store(true, Ordering::SeqCst);
                    }
                    WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                        // Frames changed by quit teardown are not the user's; skip like palettes do.
                        // An early return rather than clippy's suggested match guard: a guard that
                        // fails falls through to the next arm, which is only equivalent as long as
                        // nothing below also matches Moved/Resized. This says what it means.
                        if APP_QUITTING.load(Ordering::SeqCst) {
                            return;
                        }
                        if let Err(error) = persist_main_window_geometry(window) {
                            eprintln!("Could not persist ChemDraft main window frame: {error}");
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
                // Minimizing the document minimizes its owned palettes too, and Windows parks a
                // minimized window far off-screen and reports that as a Moved. Persisting it saved
                // the palettes at (-16000, -16000), so the next launch clamped them to the screen
                // corner. Like persist_main_window_geometry, minimized frames are not user frames.
                WindowEvent::Moved(_) if toolset_frame_is_transient(app, window) => {}
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
            // Activation policy is a macOS Dock concept; other platforms have no equivalent.
            #[cfg(target_os = "macos")]
            if let Err(error) = app.set_activation_policy(tauri::ActivationPolicy::Regular) {
                eprintln!("Could not set ChemDraft activation policy: {error}");
            }

            #[cfg(not(target_os = "macos"))]
            if let Err(error) = create_app_menu(app).and_then(|menu| install_app_menu(app, menu)) {
                eprintln!("Could not install the ChemDraft menu: {error}");
            }

            if let Err(error) = ensure_main_window_visible(app) {
                eprintln!("Could not show ChemDraft main window: {error}");
            }

            if let Err(error) = focus_main_document_window_impl(app) {
                eprintln!("Could not focus ChemDraft document window: {error}");
            }

            // Off macOS a document opened from the shell arrives as a launch argument. Queued as
            // the pending document, which the window drains once it mounts.
            #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
            if let Ok(cwd) = std::env::current_dir() {
                let args = std::env::args_os()
                    .skip(1)
                    .map(|arg| arg.to_string_lossy().into_owned());
                if let Err(error) = handle_opened_document_args(app, args, &cwd) {
                    eprintln!("Could not open ChemDraft document from launch arguments: {error}");
                }
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
            load_document_session,
            save_document_session,
            set_toolbars_menu,
            focus_main_document_window,
            set_menu_checked,
            set_keybinding_scheme,
            plugin_storage_read,
            plugin_storage_write,
            open_plugin_panel_window,
            open_toolset_popover,
            prewarm_toolset_popover,
            show_toolset_tooltip_window,
            hide_toolset_tooltip_window,
            set_current_window_global_position,
            quit_after_flush,
            close_toolset_popover,
            set_toolset_window_focusable,
            route_toolset_command,
            sync_plugin_menu_items,
            read_clipboard_payload,
            write_clipboard_text_items,
            write_clipboard_image,
            toggle_spin3d_debugger_window,
            toggle_preferences_window,
            window_logical_position,
            agent_bridge_status,
            opsin::opsin_status,
            opsin::opsin_name_to_structure,
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
        .run(|app, event| {
            // Only the macOS/mobile arms below use `app`.
            #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
            let _ = app;
            match event {
                RunEvent::ExitRequested { .. } => {
                    APP_QUITTING.store(true, Ordering::SeqCst);
                }
                // Dock-icon click with no visible windows; a macOS-only event.
                #[cfg(target_os = "macos")]
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
            }
        });
}

#[cfg(target_os = "macos")]
fn check_for_updates<R: Runtime>(app: &tauri::AppHandle<R>) {
    let Some(updater) = app.sparkle_updater() else {
        // `tauri dev` runs the binary outside an application bundle, so Sparkle deliberately does
        // not start there. Packaged builds always have an updater unless their Info.plist is broken.
        eprintln!("Sparkle update checks are unavailable outside a packaged ChemDraft app.");
        return;
    };

    if let Err(error) = updater.check_for_updates() {
        eprintln!("Could not check for a ChemDraft update: {error}");
    }
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
    // Apply the last-used frame only when bringing the window up from hidden (launch, macOS
    // Reopen); center only when there is nothing to restore (first launch, or the saved frame is on
    // a display that's gone). A window already on screen — a second launch or an open-document
    // call — keeps its live frame: re-applying position/size clears tao's maximized state, so a
    // document opened from Explorer used to un-maximize the window.
    let already_on_screen = window.is_visible().unwrap_or(false);
    window.unminimize().map_err(|error| error.to_string())?;
    if !already_on_screen && !restore_main_window_geometry(&window) {
        window.center().map_err(|error| error.to_string())?;
    }
    window.show().map_err(|error| error.to_string())?;
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

// Every command that creates a window is `async`, and must stay so. Synchronous commands run on the
// main thread, and on Windows WebView2 creation needs that same thread: a sync command that builds a
// window deadlocks, leaving the window with no webview and every later IPC call unanswered
// (documented Tauri/wry limitation). Async commands build from a worker and Tauri marshals the
// window creation to the main thread.
//
// Two consequences of running on a worker:
// - Raw platform calls are NOT marshalled by Tauri. On macOS every NSWindow call these paths make
//   goes through `run_on_main_thread_blocking` (see `configure_toolset_utility_window`).
// - Commands no longer serialize on the main thread, so "does the window exist? else build it" can
//   interleave: two opens of one label both pass the check, and the loser's rollback deleted the
//   winner's directory entry (or two windows were built). `WINDOW_CREATION` makes each
//   check-then-build atomic. Only these async commands take it; the main thread never does, so
//   holding it across `build()` (which waits on the main thread) cannot deadlock.
static WINDOW_CREATION: Mutex<()> = Mutex::new(());

fn lock_window_creation() -> std::sync::MutexGuard<'static, ()> {
    WINDOW_CREATION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[tauri::command]
async fn open_toolset_window(
    app: tauri::AppHandle,
    toolset_id: String,
    window: Option<ToolsetWindowGeometry>,
) -> Result<ToolsetWindowState, String> {
    let _creation = lock_window_creation();
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
            // Best-effort, exactly like the `Moved` handler. Remembering where the palette was is
            // housekeeping; it must never be able to veto the close the user asked for. Once
            // `update_toolset_layout_state` began propagating read errors instead of swallowing
            // them as defaults, a `?` here meant an unreadable toolbar-state.json left the palette
            // on screen with its menu item still checked and no state event emitted.
            if let Err(error) = persist_toolset_position(&app, &toolset_id, position.x, position.y)
            {
                eprintln!(
                    "chemdraft: could not save the position of toolset {toolset_id}: {error}"
                );
            }
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

/// Read a file, distinguishing "not there yet" (`Ok(None)`) from a genuine read failure (`Err`).
/// Swallowing every error as "absent" is a data-loss trap: a transient or permission read miss then
/// looks like "no saved state", and the caller's next save overwrites the real file with defaults.
fn read_optional_file(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// Write `contents` to `path` atomically. A plain `fs::write` truncates then rewrites, so a crash or
/// power loss mid-write can leave a partial, unparseable file. Instead write a complete sibling temp
/// in the SAME directory (so the rename stays on one filesystem) and `rename` it over the target:
/// `rename(2)` atomically replaces the destination, leaving either the old complete file or the new
/// complete one, never a torn one. The temp name carries this process's pid AND a per-write counter:
/// the pid separates ChemDraft instances, and the counter separates concurrent writes *within* one
/// instance — Tauri runs commands on a thread pool, so a fire-and-forget autosave that outlives its
/// debounce can overlap the next one, and a shared temp name would let writer A's rename publish
/// writer B's half-written bytes, which is exactly the torn file this helper exists to prevent.
fn write_file_atomic(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    static WRITE_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let sequence = WRITE_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".{}.{}.tmp", std::process::id(), sequence));
    let tmp = PathBuf::from(tmp);
    // Clean up on BOTH failure paths. The rename arm already did; the write arm did not, so a
    // write that failed partway (a full disk, a quota) left its temp sibling behind next to the
    // real file — and the name carries a pid and a counter, so each attempt orphaned a new one.
    fs::write(&tmp, contents).map_err(|error| {
        let _ = fs::remove_file(&tmp);
        error.to_string()
    })?;
    fs::rename(&tmp, path).map_err(|error| {
        let _ = fs::remove_file(&tmp);
        error.to_string()
    })
}

#[tauri::command]
fn load_toolset_customization_state(
    app: tauri::AppHandle,
) -> Result<Option<serde_json::Value>, String> {
    let path = toolset_customization_state_path(&app)?;
    let Some(contents) = read_optional_file(&path)? else {
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
    let contents = serde_json::to_string_pretty(&state).map_err(|error| error.to_string())?;
    write_file_atomic(&path, &contents)
}

#[tauri::command]
fn load_document_session(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = document_session_path(&app)?;
    let Some(contents) = read_optional_file(&path)? else {
        return Ok(None);
    };

    serde_json::from_str(&contents)
        .map(Some)
        .map_err(|error| format!("Document session is invalid: {error}"))
}

/// The working document's autosave (serialized contents + file association). JS owns the envelope
/// and writes it on every edit so a relaunch resumes the last edited state; Rust just persists the
/// opaque JSON, exactly like the toolbar customization state.
#[tauri::command]
fn save_document_session(app: tauri::AppHandle, state: serde_json::Value) -> Result<(), String> {
    let path = document_session_path(&app)?;
    let contents = serde_json::to_string_pretty(&state).map_err(|error| error.to_string())?;
    write_file_atomic(&path, &contents)
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
    // Remember the pushed model so plugin-menu syncs can rebuild the full menu from it later
    // (reinstall_app_menu) without waiting for the next toolbar push. JS pushes on every toolbar
    // visibility or rulers/crosshairs toggle; most pushes only move checkmarks, and a full rebuild
    // swaps the whole menu bar (on Windows: two SetMenu calls, a resize of the document's client
    // area and two layout-file writes), so only a structural change rebuilds.
    let update = {
        let state = app.state::<ToolbarsMenuModel>();
        let mut guard = state.0.lock().map_err(|error| error.to_string())?;
        let update = classify_toolbars_menu_update(&guard, &entries, view_state);
        *guard = (entries.clone(), view_state);
        update
    };
    if update == ToolbarsMenuUpdate::Unchanged {
        return Ok(());
    }
    app.clone()
        .run_on_main_thread(move || {
            let result = if update == ToolbarsMenuUpdate::ChecksOnly {
                entries
                    .iter()
                    .map(|entry| (toolset_toggle_command_id(&entry.toolset_id), entry.visible))
                    .chain([
                        ("view.toggleRulers".to_string(), view_state.rulers_visible),
                        (
                            "view.toggleCrosshairs".to_string(),
                            view_state.crosshairs_visible,
                        ),
                    ])
                    .try_for_each(|(command_id, checked)| {
                        set_check_menu_item_checked_now(&app, &command_id, checked)
                    })
            } else {
                let plugin_items = current_plugin_menu_items(&app);
                create_app_menu_for_toolsets(&app, &entries, view_state, &plugin_items)
                    .and_then(|menu| install_app_menu(&app, menu))
                    .map_err(|error| error.to_string())
            };
            if let Err(error) = result {
                eprintln!("Could not update ChemDraft toolbar menu: {error}");
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
        assert!(is_valid_plugin_storage_id("mass-fragment_v2"));
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
    write_file_atomic(&path, &contents)
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
async fn open_plugin_panel_window(
    app: tauri::AppHandle,
    request: OpenPluginPanelRequest,
) -> Result<(), String> {
    if !is_valid_plugin_storage_id(&request.panel_id) {
        return Err(format!("Invalid plugin panel id \"{}\".", request.panel_id));
    }

    let label = format!("plugin-panel-{}", request.panel_id.replace('.', "-"));
    let _creation = lock_window_creation();
    if let Some(window) = app.get_webview_window(&label) {
        window.show().map_err(|error| error.to_string())?;
        configure_toolset_utility_window(&window, true)?;
        return Ok(());
    }

    let width = request.width.unwrap_or(380.0);
    let height = request.height.unwrap_or(520.0);
    let window = utility_window_builder(
        WebviewWindowBuilder::new(
            &app,
            &label,
            WebviewUrl::App(format!("/?window=pluginPanel&panelId={}", request.panel_id).into()),
        ),
        &app,
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
async fn open_toolset_popover(
    app: tauri::AppHandle,
    toolset_id: String,
    kind: String,
    x: f64,
    y: f64,
) -> Result<(), String> {
    let label = toolset_popover_window_label(&toolset_id);
    let _creation = lock_window_creation();
    if let Some(window) = app.get_webview_window(&label) {
        // Warm reuse: position it, but do NOT show yet — the palette pushes the requested content
        // right after this call, and the popover webview reveals itself once that content has
        // painted at the right size (getCurrentWindow().show(), permitted by
        // core:window:allow-show). Showing here would flash whatever the webview painted last
        // (a stale flyout, or a prewarmed window's empty shell) before the swap landed.
        //
        // Configure FIRST, position LAST: panel configuration (level, collection behavior)
        // can nudge an NSWindow's frame, and the first open after a prewarm used to land the
        // popover away from its anchor. An explicit LogicalPosition set is the final word in
        // both the warm and cold paths.
        configure_toolset_popover_window(&window, false)?;
        set_window_global_logical_position(&window, x, y)?;
        return Ok(());
    }

    build_toolset_popover_window(&app, &label, &toolset_id, &kind, false, x, y)
}

/// Builds a palette's popover window hidden, before any flyout/color press needs it. The cold build
/// is the expensive part of a popover open (a fresh webview loading the whole app bundle — easily a
/// second or more), which used to land on the FIRST press-and-hold as a long, sometimes-gave-up-
/// looking delay. Prewarming at palette startup moves that cost off the interaction entirely: every
/// user-visible open then takes the warm path (reposition + content push + self-reveal, a frame or
/// two). The `prewarm=1` route param tells the webview to stay hidden until real content arrives.
#[tauri::command]
async fn prewarm_toolset_popover(app: tauri::AppHandle, toolset_id: String) -> Result<(), String> {
    let label = toolset_popover_window_label(&toolset_id);
    let _creation = lock_window_creation();
    if app.get_webview_window(&label).is_some() {
        return Ok(());
    }

    build_toolset_popover_window(&app, &label, &toolset_id, "artColor", true, 0.0, 0.0)
}

fn build_toolset_popover_window(
    app: &tauri::AppHandle,
    label: &str,
    toolset_id: &str,
    kind: &str,
    prewarm: bool,
    x: f64,
    y: f64,
) -> Result<(), String> {
    let prewarm_param = if prewarm { "&prewarm=1" } else { "" };
    let window = utility_window_builder(
        WebviewWindowBuilder::new(
            app,
            label,
            WebviewUrl::App(
                format!(
                    "/?window=toolsetPopover&toolsetId={toolset_id}&kind={kind}{prewarm_param}"
                )
                .into(),
            ),
        ),
        app,
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
    // Re-assert the anchor as the FINAL step, mirroring the warm path: panel configuration
    // can nudge the frame, and builder-time positioning has proven less trustworthy than an
    // explicit post-build LogicalPosition set (first opens landed away from the anchor).
    // Prewarm builds pass (0, 0), where this is harmless — the warm open repositions.
    set_window_global_logical_position(&window, x, y)?;
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

#[derive(Clone, serde::Serialize)]
struct WindowLogicalPosition {
    x: f64,
    y: f64,
}

/// The calling window's outer position in global logical coordinates, read natively.
/// The JS route (outerPosition()/scaleFactor(), divide) proved fragile on the FIRST
/// call in a palette webview: the popover anchored through it landed at the raw
/// palette-local offset, as if the palette sat at the origin — and every later call
/// was fine. Native reads have no warm-up; the window server is the source of truth.
#[tauri::command]
fn window_logical_position(window: tauri::WebviewWindow) -> Result<WindowLogicalPosition, String> {
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let position = window
        .outer_position()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(scale);
    Ok(WindowLogicalPosition {
        x: position.x,
        y: position.y,
    })
}

const TOOLSET_TOOLTIP_WINDOW_LABEL: &str = "toolset-tooltip";

/// Place the (pre-built, hidden) tooltip window at global-logical `x`/`y` (when given) and order it
/// front. The tooltip webview invokes this after sizing itself: palettes and popovers become visible
/// through this same NSWindow::orderFront path, whereas Tauri's JS `show()` did not reliably display
/// the focusable(false) panel.
#[tauri::command]
fn show_toolset_tooltip_window(
    app: tauri::AppHandle,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    let Some(window) = app.get_webview_window(TOOLSET_TOOLTIP_WINDOW_LABEL) else {
        return Ok(());
    };
    // Placing and showing in one command halves the tooltip's IPC round trips (it used to be
    // monitor query → set size → set position → show, all strictly sequential).
    if let (Some(x), Some(y)) = (x, y) {
        set_window_global_logical_position(&window, x, y)?;
    }
    #[cfg(target_os = "macos")]
    {
        let ns_window_ptr = window.ns_window().map_err(|error| error.to_string())? as *mut NSWindow;
        if let Some(ns_window) = unsafe { ns_window_ptr.as_ref() } {
            ns_window.orderFront(None);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        // The tooltip is built `focused(false)` (utility_window_builder), so this is
        // ShowWindow(SW_SHOWNOACTIVATE) on Windows and never takes activation from the document.
        window.show().map_err(|error| error.to_string())?;
    }
    // SW_SHOWNOACTIVATE keeps the hidden window's old z-order, which left the tooltip behind the
    // palette it describes; raise it among the document's owned windows without activating it.
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        };
        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        // SAFETY: a z-order-only change on a live window.
        unsafe {
            SetWindowPos(
                hwnd.0 as _,
                HWND_TOP,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
    }
    Ok(())
}

/// Hide the tooltip window. Deliberately a sync command like `show_toolset_tooltip_window`: both
/// run on the main thread in the order the tooltip webview sent them. Hiding through the JS window
/// API instead took a different IPC path, so a hide sent right after a show could land first and
/// strand the tooltip visible over the palette.
#[tauri::command]
fn hide_toolset_tooltip_window(app: tauri::AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(TOOLSET_TOOLTIP_WINDOW_LABEL) else {
        return Ok(());
    };
    window.hide().map_err(|error| error.to_string())
}

/// A monitor's frame in physical pixels plus its scale factor.
#[derive(Clone, Copy, Debug)]
struct MonitorFrame {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
}

/// Convert a point in ChemDraft's "global logical" space — each monitor's logical frame is its
/// physical frame divided by ITS scale factor, the space `window_logical_position` and
/// `monitorLogicalBoundsAt` report in — to physical pixels, using the scale of the monitor that
/// contains the point. Tauri's `set_position(LogicalPosition)` converts with the moving window's
/// OWN current scale instead, so on mixed-DPI setups (e.g. a 150% display beside a 100% one) a
/// popover or tooltip anchored to a palette on one monitor landed hundreds of pixels away on the
/// other. On a single scale factor both conversions agree.
///
/// This space is not one-to-one: a higher-scale display to the right of (or below) a lower-scale
/// one has a logical frame that starts inside its neighbour's (a 200% display at physical x = 1920
/// spans logical 960..2880 beside a 100% primary's 0..1920). When several monitors contain the
/// point, the one at `current_scale` (the moving window's own) wins, so a palette dragged within
/// the overlap stays on its display instead of jumping; otherwise the first match. A point on no
/// monitor uses `current_scale`.
fn global_logical_to_physical(
    monitors: &[MonitorFrame],
    x: f64,
    y: f64,
    current_scale: f64,
) -> (f64, f64) {
    let effective_scale = |monitor: &MonitorFrame| {
        if monitor.scale > 0.0 {
            monitor.scale
        } else {
            1.0
        }
    };
    let containing = monitors
        .iter()
        .filter(|monitor| {
            let scale = effective_scale(monitor);
            let left = monitor.x / scale;
            let top = monitor.y / scale;
            x >= left
                && x < left + monitor.width / scale
                && y >= top
                && y < top + monitor.height / scale
        })
        .map(effective_scale)
        .collect::<Vec<_>>();
    let scale = containing
        .iter()
        .copied()
        .find(|scale| (scale - current_scale).abs() < f64::EPSILON)
        .or_else(|| containing.first().copied())
        .unwrap_or(current_scale);
    (x * scale, y * scale)
}

fn set_window_global_logical_position<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    x: f64,
    y: f64,
) -> Result<(), String> {
    let monitors = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| MonitorFrame {
            x: monitor.position().x as f64,
            y: monitor.position().y as f64,
            width: monitor.size().width as f64,
            height: monitor.size().height as f64,
            scale: monitor.scale_factor(),
        })
        .collect::<Vec<_>>();
    let current_scale = window.scale_factor().unwrap_or(1.0);
    let (physical_x, physical_y) = global_logical_to_physical(&monitors, x, y, current_scale);
    window
        .set_position(tauri::PhysicalPosition::new(
            physical_x.round() as i32,
            physical_y.round() as i32,
        ))
        .map_err(|error| error.to_string())
}

/// Move the calling window to a point in global logical coordinates (see
/// [`global_logical_to_physical`]). Replaces the JS `setPosition(new LogicalPosition(...))`, which
/// converted with the window's own scale factor.
#[tauri::command]
fn set_current_window_global_position(
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
) -> Result<(), String> {
    set_window_global_logical_position(&window, x, y)
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

    let window = utility_window_builder(
        WebviewWindowBuilder::new(
            app,
            TOOLSET_TOOLTIP_WINDOW_LABEL,
            WebviewUrl::App("/?window=toolsetTooltip".into()),
        ),
        app,
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
    #[cfg(not(target_os = "macos"))]
    window
        .set_ignore_cursor_events(true)
        .map_err(|error| error.to_string())?;
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

// On Windows the clipboard commands are `async` (a worker thread), so a clipboard held by another
// process (OpenClipboard retries for up to 100 ms), a slow source app rendering a format, or a
// large PNG→DIB conversion no longer freezes every window. The Win32 clipboard is per-thread: each
// call opens, uses and closes it on that one worker. macOS keeps these on the main thread, where
// NSPasteboard has always been used.
#[cfg(windows)]
#[tauri::command]
async fn read_clipboard_payload() -> Result<ClipboardReadPayload, String> {
    read_clipboard_payload_impl()
}

#[cfg(not(windows))]
#[tauri::command]
fn read_clipboard_payload() -> Result<ClipboardReadPayload, String> {
    read_clipboard_payload_impl()
}

#[cfg(windows)]
#[tauri::command]
async fn write_clipboard_text_items(
    app: tauri::AppHandle,
    items: Vec<ClipboardWriteTextItem>,
) -> Result<(), String> {
    write_clipboard_text_items_impl(&app, normalize_clipboard_write_text_items(items)?)
}

#[cfg(not(windows))]
#[tauri::command]
fn write_clipboard_text_items(
    app: tauri::AppHandle,
    items: Vec<ClipboardWriteTextItem>,
) -> Result<(), String> {
    write_clipboard_text_items_impl(&app, normalize_clipboard_write_text_items(items)?)
}

/// Copy As ▸ PNG: put raster image bytes on the system pasteboard as `public.png`.
#[cfg(windows)]
#[tauri::command]
async fn write_clipboard_image(app: tauri::AppHandle, png_bytes: Vec<u8>) -> Result<(), String> {
    write_clipboard_image_checked(&app, &png_bytes)
}

/// Copy As ▸ PNG: put raster image bytes on the system pasteboard as `public.png`.
#[cfg(not(windows))]
#[tauri::command]
fn write_clipboard_image(app: tauri::AppHandle, png_bytes: Vec<u8>) -> Result<(), String> {
    write_clipboard_image_checked(&app, &png_bytes)
}

fn write_clipboard_image_checked(app: &tauri::AppHandle, png_bytes: &[u8]) -> Result<(), String> {
    if png_bytes.is_empty() {
        return Err("Empty PNG payload.".to_string());
    }
    write_clipboard_image_impl(app, png_bytes)
}

/// The window that owns clipboard writes on Windows. EmptyClipboard with no owner leaves the
/// clipboard ownerless, and every SetClipboardData after it fails.
#[cfg(windows)]
fn clipboard_owner_window(app: &tauri::AppHandle) -> windows_sys::Win32::Foundation::HWND {
    app.get_webview_window(MAIN_WINDOW_LABEL)
        .and_then(|window| window.hwnd().ok())
        .map(|hwnd| hwnd.0 as windows_sys::Win32::Foundation::HWND)
        .unwrap_or(std::ptr::null_mut())
}

#[cfg(target_os = "macos")]
fn write_clipboard_image_impl(_app: &tauri::AppHandle, png_bytes: &[u8]) -> Result<(), String> {
    use objc2_foundation::NSData;

    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    let png_type = NSString::from_str("public.png");
    if pasteboard.setData_forType(Some(&NSData::with_bytes(png_bytes)), &png_type) {
        Ok(())
    } else {
        Err("Could not write PNG data to the clipboard.".to_string())
    }
}

#[cfg(windows)]
fn write_clipboard_image_impl(app: &tauri::AppHandle, png_bytes: &[u8]) -> Result<(), String> {
    windows_clipboard::native::write_png(clipboard_owner_window(app), png_bytes)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn write_clipboard_image_impl(_app: &tauri::AppHandle, _png_bytes: &[u8]) -> Result<(), String> {
    Err("Native clipboard image writes are only implemented for macOS and Windows.".to_string())
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
fn write_clipboard_text_items_impl(
    _app: &tauri::AppHandle,
    items: Vec<ClipboardWriteTextItem>,
) -> Result<(), String> {
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

/// Pasteboard flavors whose bytes are private containers, never directly pasteable text.
/// WebKit's custom-pasteboard-data is a binary blob (length-prefixed origin + type + payload)
/// that any WebKit view — Safari included — leaves behind on copy; "decoding" it produced the
/// CJK-mojibake text objects users saw when pasting between two ChemDraft instances.
// Platform-neutral decoding, shared by the macOS pasteboard reader and the Windows clipboard reader.
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
const OPAQUE_CLIPBOARD_TYPES: [&str; 4] = [
    "com.apple.WebKit.custom-pasteboard-data",
    "org.webkit.custom-pasteboard-data",
    // Chromium's (WebView2's) equivalents on Windows: a pickled map of custom MIME data, and a
    // frame token.
    "Chromium Web Custom MIME Data Format",
    "Chromium internal source RFH token",
];

#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
fn is_opaque_clipboard_type(pasteboard_type: &str) -> bool {
    OPAQUE_CLIPBOARD_TYPES.contains(&pasteboard_type)
}

#[cfg(target_os = "macos")]
fn clipboard_text_for_type(
    pasteboard: &NSPasteboard,
    pasteboard_type: &objc2_app_kit::NSPasteboardType,
) -> Option<String> {
    if is_opaque_clipboard_type(&pasteboard_type.to_string()) {
        return None;
    }

    if let Some(text) = pasteboard.stringForType(pasteboard_type) {
        let text = text.to_string();
        if !text.is_empty() {
            return Some(text);
        }
    }

    let data = pasteboard.dataForType(pasteboard_type)?;
    decode_clipboard_text_bytes(&data.to_vec())
}

#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
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
        // ChemDraw-style flavors end in a C-string terminator; strip it. An INTERIOR null is
        // different — text never contains one, so its presence means these bytes are binary.
        let text = text.trim_end_matches('\0');
        if !text.is_empty() && !text.contains('\0') {
            return Some(text.to_string());
        }
    }

    decode_utf16_bytes(bytes)
}

#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
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

#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
fn decode_utf16_bytes(bytes: &[u8]) -> Option<String> {
    if let Some(content) = bytes.strip_prefix(&[0xfe, 0xff]) {
        return decode_utf16_units(content, true);
    }
    if let Some(content) = bytes.strip_prefix(&[0xff, 0xfe]) {
        return decode_utf16_units(content, false);
    }

    // Without a BOM, only accept byte patterns real UTF-16 text actually has. Two shapes are
    // legitimate: mostly-Latin/mixed text puts a null in nearly every unit, concentrated on one
    // parity (that parity is the high-byte position, which tells us the endianness); mostly-CJK
    // or other wide-script text puts a null in almost NONE of its units on either parity, since
    // those code points' high bytes are non-zero — so a low null density on BOTH parities is just
    // as real a signal as a lopsided one, it just can't tell us the endianness by itself. Binary
    // blobs (plists, CDX, image headers) fall in neither bucket: they scatter a meaningful number
    // of nulls across both parities in comparable amounts.
    let pair_count = bytes.len() / 2;
    if pair_count == 0 {
        return None;
    }
    let even_nulls = bytes.iter().step_by(2).filter(|byte| **byte == 0).count();
    let odd_nulls = bytes
        .iter()
        .skip(1)
        .step_by(2)
        .filter(|byte| **byte == 0)
        .count();
    let (dominant, other, dominant_is_big_endian) = if even_nulls >= odd_nulls {
        (even_nulls, odd_nulls, true)
    } else {
        (odd_nulls, even_nulls, false)
    };

    if dominant * 2 >= pair_count && other * 8 <= pair_count {
        return decode_utf16_units(bytes, dominant_is_big_endian);
    }
    if (even_nulls + odd_nulls) * 8 <= pair_count {
        // Nulls are too sparse on both sides to reveal which parity is the high byte from
        // content alone. Byte-swapped CJK often decodes to SOME other real (non-control) script
        // rather than failing outright, so "try both, take whichever passes" would silently
        // prefer whichever order happens first even when it's wrong — try this platform's native
        // order (macOS pasteboard UTF-16 without a BOM is little-endian) first, and only fall
        // back to big-endian, which a non-native source could still have written. This is the
        // decoder's lowest-confidence path (short binary payloads can decode into valid-looking
        // units), so its results get extra scrutiny beyond the ordinary plausibility filter.
        return decode_utf16_units(bytes, false)
            .filter(|text| utf16_sparse_text_is_convincing(text))
            .or_else(|| {
                decode_utf16_units(bytes, true).filter(|text| utf16_sparse_text_is_convincing(text))
            });
    }
    None
}

/// Extra scrutiny for the no-BOM sparse-null path only: real prose and chemistry text never
/// contains private-use or noncharacter code points, while binary bytes and byte-swapped UTF-16
/// frequently decode into exactly those ranges. (BOM'd and null-parity-detected payloads skip
/// this — their encoding evidence is strong enough that PUA glyphs, e.g. icon fonts, pass.)
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
fn utf16_sparse_text_is_convincing(text: &str) -> bool {
    text.chars().all(|character| {
        let code_point = character as u32;
        let private_use = (0xe000..=0xf8ff).contains(&code_point)
            || (0xf0000..=0xffffd).contains(&code_point)
            || (0x100000..=0x10fffd).contains(&code_point);
        let noncharacter =
            (0xfdd0..=0xfdef).contains(&code_point) || (code_point & 0xfffe) == 0xfffe;
        !private_use && !noncharacter
    })
}

#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
fn decode_utf16_units(content: &[u8], big_endian: bool) -> Option<String> {
    if content.len() < 2 || !content.len().is_multiple_of(2) {
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
        .filter(|text| !text.is_empty() && text_is_plausible_clipboard_text(text))
}

/// Rejects strings that only a mis-decode produces: control characters (beyond whitespace)
/// and replacement characters never occur in text a user meant to paste, while every
/// legitimate UTF-16 clipboard payload (molfiles, CDXML, SMILES, prose) is clean of them.
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
fn text_is_plausible_clipboard_text(text: &str) -> bool {
    text.chars().all(|character| {
        character == '\t'
            || character == '\n'
            || character == '\r'
            || character == '\u{0c}'
            || (character != '\u{fffd}' && !character.is_control())
    })
}

#[cfg(windows)]
fn read_clipboard_payload_impl() -> Result<ClipboardReadPayload, String> {
    windows_clipboard::native::read_payload()
}

#[cfg(windows)]
fn write_clipboard_text_items_impl(
    app: &tauri::AppHandle,
    items: Vec<ClipboardWriteTextItem>,
) -> Result<(), String> {
    windows_clipboard::native::write_text_items(clipboard_owner_window(app), &items)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn read_clipboard_payload_impl() -> Result<ClipboardReadPayload, String> {
    Ok(ClipboardReadPayload {
        types: Vec::new(),
        text_items: Vec::new(),
    })
}

#[cfg(not(any(target_os = "macos", windows)))]
fn write_clipboard_text_items_impl(
    _app: &tauri::AppHandle,
    _items: Vec<ClipboardWriteTextItem>,
) -> Result<(), String> {
    Err("Native clipboard writes are only implemented for macOS and Windows.".to_string())
}

#[tauri::command]
async fn toggle_spin3d_debugger_window(app: tauri::AppHandle) -> Result<(), String> {
    let _creation = lock_window_creation();
    if let Some(window) = app.get_webview_window(SPIN3D_DEBUGGER_WINDOW_LABEL) {
        if toggle_should_hide(&window) {
            return window.hide().map_err(|error| error.to_string());
        }
    }

    ensure_spin3d_debugger_window(&app).map(|_| ())
}

/// Whether a Preferences / 3D Debugger toggle should hide its window (otherwise it is shown and
/// brought forward).
///
/// macOS and Linux keep the original rule: a visible window is hidden. On Windows a visible window
/// can be out of sight — behind the document, which is where it lands as soon as the document is
/// clicked — and hiding it then made Ctrl+, look like it did nothing. Focus can't tell the cases
/// apart (the toggle always arrives from the document's menu or keyboard, so the document is always
/// the focused window), so Windows asks whether the document window covers it instead.
fn toggle_should_hide<R: Runtime>(window: &tauri::WebviewWindow<R>) -> bool {
    #[cfg(windows)]
    {
        toggle_hides_window(
            window.is_visible().unwrap_or(false),
            window.is_minimized().unwrap_or(false),
            window_is_covered_by_document(window),
        )
    }
    #[cfg(not(windows))]
    {
        window.is_visible().unwrap_or(false)
    }
}

/// The platform-neutral core of [`toggle_should_hide`] on Windows: only a window the user can
/// actually see is hidden.
#[cfg_attr(not(windows), allow(dead_code))]
fn toggle_hides_window(visible: bool, minimized: bool, covered_by_document: bool) -> bool {
    visible && !minimized && !covered_by_document
}

/// Whether two `(left, top, right, bottom)` rectangles overlap (touching edges don't).
#[cfg_attr(not(windows), allow(dead_code))]
fn rects_overlap(a: (i32, i32, i32, i32), b: (i32, i32, i32, i32)) -> bool {
    a.0 < b.2 && b.0 < a.2 && a.1 < b.3 && b.1 < a.3
}

/// True when the document window is above `window` in z-order and overlaps it.
#[cfg(windows)]
fn window_is_covered_by_document<R: Runtime>(window: &tauri::WebviewWindow<R>) -> bool {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindow, GetWindowRect, GW_HWNDPREV};

    let Some(main) = window.app_handle().get_webview_window(MAIN_WINDOW_LABEL) else {
        return false;
    };
    let (Ok(main_hwnd), Ok(target_hwnd)) = (main.hwnd(), window.hwnd()) else {
        return false;
    };
    let main_hwnd = main_hwnd.0 as windows_sys::Win32::Foundation::HWND;
    let target_hwnd = target_hwnd.0 as windows_sys::Win32::Foundation::HWND;

    // Walk up from the document; meeting the target means the target is above it.
    let mut above = main_hwnd;
    loop {
        // SAFETY: GetWindow only reads the window manager's z-order list.
        above = unsafe { GetWindow(above, GW_HWNDPREV) };
        if above.is_null() {
            break;
        }
        if above == target_hwnd {
            return false;
        }
    }

    let mut main_rect = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    let mut target_rect = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    // SAFETY: both handles are live Tauri windows; the RECTs are valid out-pointers.
    let read = unsafe {
        GetWindowRect(main_hwnd, &mut main_rect) != 0
            && GetWindowRect(target_hwnd, &mut target_rect) != 0
    };
    read && rects_overlap(
        (
            main_rect.left,
            main_rect.top,
            main_rect.right,
            main_rect.bottom,
        ),
        (
            target_rect.left,
            target_rect.top,
            target_rect.right,
            target_rect.bottom,
        ),
    )
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
async fn toggle_preferences_window(app: tauri::AppHandle) -> Result<(), String> {
    let _creation = lock_window_creation();
    if let Some(window) = app.get_webview_window(PREFERENCES_WINDOW_LABEL) {
        if toggle_should_hide(&window) {
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
        if is_runnable_sidecar(&candidate) {
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
    if is_runnable_sidecar(&bundled) {
        Some(bundled)
    } else {
        None
    }
}

/// Marker text every `binaries/` placeholder carries (see binaries/README.md).
const SIDECAR_PLACEHOLDER_MARKER: &[u8] = b"avogadro3d-sidecar placeholder";

/// A file that can actually be started as the sidecar. The `binaries/` placeholders for targets
/// without a real build (Intel macOS, Linux) are small `#!/bin/sh … exit 2` scripts: `is_file`
/// accepted them, so status said "bundled" and every session failed when the script exited. They
/// are recognised by their marker on every platform; Windows additionally requires a PE image
/// (a text placeholder there failed to start with OS error 193).
fn is_runnable_sidecar(path: &Path) -> bool {
    if !path.is_file() || is_sidecar_placeholder(path) {
        return false;
    }
    #[cfg(windows)]
    {
        is_pe_image(path)
    }
    #[cfg(not(windows))]
    {
        true
    }
}

fn is_sidecar_placeholder(path: &Path) -> bool {
    let mut head = Vec::with_capacity(512);
    let read = fs::File::open(path).and_then(|file| file.take(512).read_to_end(&mut head));
    read.is_ok()
        && head
            .windows(SIDECAR_PLACEHOLDER_MARKER.len())
            .any(|window| window == SIDECAR_PLACEHOLDER_MARKER)
}

/// `MZ` DOS header whose e_lfanew (offset 0x3C) points at a `PE\0\0` signature. Reads only those
/// bytes — the real sidecar is a megabyte, and status is checked on every Interactive 3D start.
#[cfg(windows)]
fn is_pe_image(path: &Path) -> bool {
    use std::io::{Seek, SeekFrom};

    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut header = [0u8; 0x40];
    if file.read_exact(&mut header).is_err() || &header[..2] != b"MZ" {
        return false;
    }
    let offset = u32::from_le_bytes([header[0x3c], header[0x3d], header[0x3e], header[0x3f]]);
    let mut signature = [0u8; 4];
    file.seek(SeekFrom::Start(u64::from(offset))).is_ok()
        && file.read_exact(&mut signature).is_ok()
        && &signature == b"PE\0\0"
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
        .without_console_window()
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

/// A routed Edit-menu history item: command id, label, and accelerator.
struct EditHistoryMenuItem {
    command_id: &'static str,
    label: &'static str,
    accelerator: &'static str,
}

/// Edit ▸ Undo / Redo, in menu order. Routed rather than AppKit-predefined: the predefined items send
/// undo: to the webview's text undo manager, which never reaches the drawing's history.
const EDIT_HISTORY_MENU_ITEMS: [EditHistoryMenuItem; 2] = [
    EditHistoryMenuItem {
        command_id: "edit.undo",
        label: "Undo",
        accelerator: "CmdOrCtrl+Z",
    },
    EditHistoryMenuItem {
        command_id: "edit.redo",
        label: "Redo",
        accelerator: "CmdOrCtrl+Shift+Z",
    },
];

fn edit_history_menu_item<R: Runtime>(
    app: &tauri::AppHandle<R>,
    item: &EditHistoryMenuItem,
) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(
        app,
        item.command_id,
        item.label,
        true,
        Some(item.accelerator),
    )
}

fn is_edit_history_command(command_id: &str) -> bool {
    EDIT_HISTORY_MENU_ITEMS
        .iter()
        .any(|item| item.command_id == command_id)
}

/// Which window a routed menu command is delivered to. Everything goes to the main document window,
/// except Undo / Redo: those follow the key window, as AppKit's predefined items did, so ⌘Z in a
/// palette's text field undoes that text. The secondary window forwards to the main window itself
/// when it has no text field focused (`installSecondaryWindowEditHistory` in the webview).
fn menu_command_target_label<'a>(command_id: &str, focused_label: Option<&'a str>) -> &'a str {
    match focused_label {
        Some(label) if is_edit_history_command(command_id) => label,
        _ => MAIN_WINDOW_LABEL,
    }
}

fn emit_menu_command<R: Runtime>(
    app: &tauri::AppHandle<R>,
    command_id: &str,
) -> Result<(), String> {
    let focused_label = app
        .webview_windows()
        .into_iter()
        .find(|(_, window)| window.is_focused().unwrap_or(false))
        .map(|(label, _)| label);
    let target_label = menu_command_target_label(command_id, focused_label.as_deref());
    if target_label == MAIN_WINDOW_LABEL {
        return emit_command_to_main(app, command_id);
    }
    let target = app
        .get_webview_window(target_label)
        .ok_or_else(|| format!("Window {target_label} is not available."))?;
    dispatch_dom_command_event(
        &target,
        &ToolsetCommandPayload {
            command_id: command_id.to_string(),
        },
    )
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
    deliver_opened_document(app, payload)
}

/// Document paths passed on the command line (Windows/Linux shell opens, and argv forwarded from a
/// second launch). Flags are skipped; the first existing `.chemdraft`/`.cdxml` file wins,
/// mirroring the first-file-URL rule of the macOS path.
#[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
fn handle_opened_document_args<R: Runtime>(
    app: &tauri::AppHandle<R>,
    args: impl IntoIterator<Item = String>,
    cwd: &Path,
) -> Result<(), String> {
    let path = args
        .into_iter()
        .filter(|arg| !arg.starts_with('-'))
        .map(|arg| cwd.join(arg))
        .find(|path| is_openable_document_path(path));
    let Some(path) = path else {
        return Ok(());
    };
    deliver_opened_document(app, open_document_payload_from_path(&path)?)
}

#[cfg_attr(
    any(target_os = "macos", target_os = "ios", target_os = "android"),
    allow(dead_code)
)]
fn is_openable_document_path(path: &Path) -> bool {
    let extension_ok = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("chemdraft") || extension.eq_ignore_ascii_case("cdxml")
        });
    extension_ok && path.is_file()
}

/// Queue an opened document for the window to drain on mount (cold start), bring the window up,
/// and deliver it to an already-listening window.
fn deliver_opened_document<R: Runtime>(
    app: &tauri::AppHandle<R>,
    payload: NativeOpenDocumentPayload,
) -> Result<(), String> {
    // The file was read here in Rust, which no fs scope governs — but Save writes it back through
    // the fs plugin's writeTextFile, which only allows $HOME/$DOCUMENT/$DESKTOP/$DOWNLOAD/$TEMP. A
    // document double-clicked on another drive or a share (D:\…, \\server\…) opened fine and then
    // could not be saved in place. Grant this one file, exactly as the dialog plugin does for a
    // file the user picks.
    allow_opened_document_in_scope(app, Path::new(&payload.path));

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
    open_document_payload_from_path(&path).map(Some)
}

fn open_document_payload_from_path(path: &Path) -> Result<NativeOpenDocumentPayload, String> {
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let display_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Untitled.chemdraft")
        .to_string();

    Ok(NativeOpenDocumentPayload {
        path: path.to_string_lossy().to_string(),
        display_name,
        contents,
    })
}

fn allow_opened_document_in_scope<R: Runtime>(app: &tauri::AppHandle<R>, path: &Path) {
    use tauri_plugin_fs::FsExt;
    if let Some(scope) = app.try_fs_scope() {
        if let Err(error) = scope.allow_file(path) {
            eprintln!(
                "Could not allow {} in the fs scope: {error}",
                path.display()
            );
        }
    }
    if let Some(scopes) = app.try_state::<tauri::scope::Scopes>() {
        if let Err(error) = scopes.allow_file(path) {
            eprintln!(
                "Could not allow {} in the asset scope: {error}",
                path.display()
            );
        }
    }
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
#[derive(Clone, Copy, Debug, PartialEq)]
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

/// Sync the webview's plugin Analyze menu items into the native menu (ADR-0016): store them, then
/// rebuild + reinstall the app menu so they appear natively. Clicks route back by the `plugin.`
/// prefix through the existing native→webview command bridge.
#[tauri::command]
fn sync_plugin_menu_items(
    app: tauri::AppHandle,
    items: Vec<PluginMenuItemInput>,
) -> Result<(), String> {
    {
        let state = app.state::<PluginNativeMenuItems>();
        let mut guard = state.0.lock().map_err(|error| error.to_string())?;
        // The webview re-sends the list on every plugin host/panel change (each report push, panel
        // open/close), almost always unchanged. A rebuild swaps the whole menu bar — on Windows two
        // SetMenu calls that resize the document's client area — so identical syncs are dropped.
        if *guard == items {
            return Ok(());
        }
        *guard = items;
    }
    reinstall_app_menu(&app)
}

/// How a Toolbars-menu push differs from the menu already installed.
#[derive(Debug, PartialEq)]
enum ToolbarsMenuUpdate {
    /// Same rows, same checkmarks: nothing to do.
    Unchanged,
    /// Same rows (ids and titles, in order); only checkmarks changed — flip them in place.
    ChecksOnly,
    /// Rows were added, removed, reordered or renamed: rebuild the menu.
    Rebuild,
}

fn classify_toolbars_menu_update(
    previous: &(Vec<ToolbarMenuEntry>, ViewMenuState),
    next_entries: &[ToolbarMenuEntry],
    next_view: ViewMenuState,
) -> ToolbarsMenuUpdate {
    let (previous_entries, previous_view) = previous;
    let same_rows = previous_entries.len() == next_entries.len()
        && previous_entries
            .iter()
            .zip(next_entries)
            .all(|(old, new)| old.toolset_id == new.toolset_id && old.title == new.title);
    if !same_rows {
        ToolbarsMenuUpdate::Rebuild
    } else if previous_entries.as_slice() == next_entries && *previous_view == next_view {
        ToolbarsMenuUpdate::Unchanged
    } else {
        ToolbarsMenuUpdate::ChecksOnly
    }
}

/// Rebuild and install the app menu on the main thread from the last JS-pushed toolbar model plus the
/// current plugin menu items. Toolbar rows and View-toggle state come from `ToolbarsMenuModel` (what
/// `set_toolbars_menu` last stored), so a plugin sync never resets the Toolbars submenu or the View
/// checkmarks while JS remains the source of truth for both.
/// Store the webview-owned keybinding scheme and rebuild the native menu so its accelerators match.
/// JS pushes this on startup and whenever the Preferences toggle changes; the scheme itself is
/// persisted by the webview (localStorage), so Rust only mirrors it.
#[tauri::command]
fn set_keybinding_scheme(app: tauri::AppHandle, scheme: String) -> Result<(), String> {
    let parsed = match scheme.as_str() {
        "chemdraft" => KeybindingScheme::ChemDraft,
        "chemdraw" => KeybindingScheme::ChemDraw,
        other => return Err(format!("unknown keybinding scheme: {other}")),
    };
    let state = app.state::<KeybindingSchemeState>();
    let changed = {
        let mut guard = state.0.lock().map_err(|error| error.to_string())?;
        let changed = *guard != parsed;
        *guard = parsed;
        changed
    };
    if changed {
        reinstall_app_menu(&app)?;
    }
    Ok(())
}

/// Install a (re)built app menu. Must run on the main thread (every caller does: `setup`, and the
/// `run_on_main_thread` closures of `set_toolbars_menu` / `reinstall_app_menu`).
///
/// macOS has one app-wide menu bar. Elsewhere the menu belongs to the document window alone and is
/// set on that window, never app-wide. An app-wide Tauri menu is attached to EVERY window, and
/// attaching a muda menu to a Win32 window subclasses it with `menu_subclass_proc`, whose
/// `dwrefdata` points at the `Menu`. `remove_menu` clears the bar but never removes that subclass,
/// and muda's `Drop` only unsubclasses windows still attached — so every palette, popover and the
/// tooltip, stripped of the app-wide bar, kept a pointer to a menu that the next rebuild freed. The
/// next WM_NCACTIVATE/WM_NCPAINT read it: an access violation in `menu_subclass_proc` at startup
/// (rebuilds racing palette creation) and in GDI32 at exit.
///
/// With the menu on the document window only, no other window is ever subclassed. The document
/// window itself is safe across a rebuild: on the main thread Tauri runs the queued detach/attach
/// inline, and `Window::set_menu` holds the previous menu while the new one re-points the subclass,
/// so the old menu is only freed once nothing refers to it. Keep this on the main thread.
fn install_app_menu<R: Runtime>(app: &tauri::AppHandle<R>, menu: Menu<R>) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    app.set_menu(menu)?;
    #[cfg(not(target_os = "macos"))]
    {
        let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
            return Ok(());
        };
        window.set_menu(menu)?;
    }
    Ok(())
}

fn reinstall_app_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let app = app.clone();
    app.clone()
        .run_on_main_thread(move || {
            let (entries, view_state) = current_toolbars_menu_model(&app);
            let plugin_items = current_plugin_menu_items(&app);
            let result = create_app_menu_for_toolsets(&app, &entries, view_state, &plugin_items)
                .and_then(|menu| install_app_menu(&app, menu));
            if let Err(error) = result {
                eprintln!("Could not update ChemDraft plugin menu: {error}");
            }
        })
        .map_err(|error| error.to_string())
}

/// Build the Analyze submenu: the static "Validate Selected Structure" item plus any plugin items
/// (synced from the webview), separated. Plugin `id`s are `plugin.*` command ids routed by prefix.
fn build_analyze_submenu<R: Runtime>(
    app: &tauri::AppHandle<R>,
    plugin_items: &[PluginMenuItemInput],
) -> tauri::Result<Submenu<R>> {
    // "Molecular Inspector", matching `commands.ts`'s canonical title and the toolset it opens. The
    // native menu said "Molecular Properties" while the command registry, the palette and the window
    // title all said "Molecular Inspector" — one command id wearing two names depending on which
    // surface a user reached it from. `true` for enabled is correct and deliberate: the command is
    // NOT gated on a selection, because the window has its own empty state.
    let properties = MenuItem::with_id(
        app,
        "analyze.molecularProperties",
        "Molecular Inspector\u{2026}",
        true,
        None::<&str>,
    )?;
    let validate = MenuItem::with_id(
        app,
        "chemistry.validateSelection",
        "Validate Selected Structure",
        true,
        None::<&str>,
    )?;
    // Separates the core Analyze commands from the plugin-contributed items below them.
    let core_separator = PredefinedMenuItem::separator(app)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let plugin_menu_items = plugin_items
        .iter()
        .map(|item| {
            MenuItem::with_id(
                app,
                item.id.as_str(),
                item.label.as_str(),
                item.enabled,
                None::<&str>,
            )
        })
        .collect::<tauri::Result<Vec<_>>>()?;

    let mut items: Vec<&dyn tauri::menu::IsMenuItem<R>> =
        vec![&properties, &core_separator, &validate];
    if !plugin_menu_items.is_empty() {
        items.push(&separator);
        for item in &plugin_menu_items {
            items.push(item);
        }
    }
    Submenu::with_items(app, "Analyze", true, &items)
}

fn create_app_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    // Empty Toolbars submenu; JS pushes the real rows via set_toolbars_menu once it loads. Plugin
    // items are read from state so menu rebuilds after a plugin sync keep them (ADR-0016).
    let plugin_items = current_plugin_menu_items(app);
    create_app_menu_for_toolsets(app, &[], ViewMenuState::default(), &plugin_items)
}

/// The plugin menu items last synced from the webview (empty until the first sync). Read on every menu
/// build so toolset-driven rebuilds keep the plugin items too (ADR-0016).
fn current_plugin_menu_items<R: Runtime>(app: &tauri::AppHandle<R>) -> Vec<PluginMenuItemInput> {
    app.try_state::<PluginNativeMenuItems>()
        .and_then(|state| state.0.lock().ok().map(|items| items.clone()))
        .unwrap_or_default()
}

/// The toolbar rows + View state last pushed by `set_toolbars_menu` (defaults until the first push).
fn current_toolbars_menu_model<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> (Vec<ToolbarMenuEntry>, ViewMenuState) {
    app.try_state::<ToolbarsMenuModel>()
        .and_then(|state| state.0.lock().ok().map(|model| model.clone()))
        .unwrap_or_default()
}

fn create_app_menu_for_toolsets<R: Runtime>(
    app: &tauri::AppHandle<R>,
    entries: &[ToolbarMenuEntry],
    view_state: ViewMenuState,
    plugin_items: &[PluginMenuItemInput],
) -> tauri::Result<Menu<R>> {
    #[cfg(target_os = "macos")]
    let native_app_menu = create_native_app_menu(app)?;
    let page_setup_menu = create_page_setup_menu(app)?;
    let view_menu = create_view_menu(app, entries, view_state)?;
    let analyze_menu = build_analyze_submenu(app, plugin_items)?;
    let plugins_menu = Submenu::with_items(
        app,
        "Plugins",
        true,
        &[&MenuItem::with_id(
            app,
            "plugins.manage",
            "Add or Remove Plugins...",
            true,
            None::<&str>,
        )?],
    )?;

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
                        Some(match current_keybinding_scheme(app) {
                            KeybindingScheme::ChemDraft => "CmdOrCtrl+Shift+E",
                            #[cfg(target_os = "macos")]
                            KeybindingScheme::ChemDraw => "Ctrl+Command+E",
                            // "Command" is the Windows/Super key off macOS. The shortcut engine
                            // folds Cmd into Ctrl there, so the ChemDraw scheme's chord is Ctrl+E.
                            #[cfg(not(target_os = "macos"))]
                            KeybindingScheme::ChemDraw => "CmdOrCtrl+E",
                        }),
                    )?,
                    &PredefinedMenuItem::separator(app)?,
                    #[cfg(target_os = "macos")]
                    &MenuItem::with_id(
                        app,
                        CHECK_FOR_UPDATES_COMMAND_ID,
                        "Check for Updates…",
                        true,
                        None::<&str>,
                    )?,
                    #[cfg(target_os = "macos")]
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::close_window(app, None)?,
                    // A routed item, not PredefinedMenuItem::quit: on Windows muda's predefined Quit
                    // is a bare PostQuitMessage, which ends the event loop before the document
                    // window can flush its pending session autosave (see request_quit).
                    #[cfg(not(target_os = "macos"))]
                    &MenuItem::with_id(app, APP_QUIT_COMMAND_ID, "Exit", true, None::<&str>)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    // Routed, not predefined: AppKit's undo:/redo: selectors reach only the
                    // webview's text undo manager, never the drawing's history. The webview sends
                    // a focused text field's undo back to the field (editHistoryRouting.ts).
                    &edit_history_menu_item(app, &EDIT_HISTORY_MENU_ITEMS[0])?,
                    &edit_history_menu_item(app, &EDIT_HISTORY_MENU_ITEMS[1])?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &Submenu::with_items(
                        app,
                        "Copy As",
                        true,
                        &[
                            &MenuItem::with_id(
                                app,
                                "clipboard.copyAs.smiles",
                                "SMILES",
                                true,
                                Some("CmdOrCtrl+Alt+C"),
                            )?,
                            &MenuItem::with_id(
                                app,
                                "clipboard.copyAs.inchi",
                                "InChI",
                                true,
                                None::<&str>,
                            )?,
                            &MenuItem::with_id(
                                app,
                                "clipboard.copyAs.inchiKey",
                                "InChI Key",
                                true,
                                None::<&str>,
                            )?,
                            &MenuItem::with_id(
                                app,
                                "clipboard.copyAs.cdxml",
                                "CDXML Text",
                                true,
                                Some("CmdOrCtrl+D"),
                            )?,
                            &MenuItem::with_id(
                                app,
                                "clipboard.copyAs.mol",
                                "MOL Text",
                                true,
                                Some("CmdOrCtrl+Alt+O"),
                            )?,
                            &MenuItem::with_id(
                                app,
                                "clipboard.copyAs.molV2000",
                                "MOL V2000 Text",
                                true,
                                Some("CmdOrCtrl+Alt+Shift+O"),
                            )?,
                            &MenuItem::with_id(
                                app,
                                "clipboard.copyAs.svg",
                                "SVG",
                                true,
                                None::<&str>,
                            )?,
                            &MenuItem::with_id(
                                app,
                                "clipboard.copyAs.png",
                                "PNG",
                                true,
                                None::<&str>,
                            )?,
                        ],
                    )?,
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
            &analyze_menu,
            &plugins_menu,
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
            // macOS keeps About in the application menu; elsewhere Help is its home.
            &Submenu::with_items(
                app,
                "Help",
                true,
                &[
                    #[cfg(not(target_os = "macos"))]
                    &PredefinedMenuItem::about(app, None, Some(about_metadata(app)))?,
                ],
            )?,
        ],
    )
}

fn about_metadata<R: Runtime>(app: &tauri::AppHandle<R>) -> AboutMetadata<'static> {
    let config = app.config();
    AboutMetadata {
        name: Some("ChemDraft".to_string()),
        version: Some(app.package_info().version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config
            .bundle
            .publisher
            .clone()
            .map(|publisher| vec![publisher]),
        ..Default::default()
    }
}

#[cfg(target_os = "macos")]
fn create_native_app_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Submenu<R>> {
    let package_info = app.package_info();
    let about_metadata = about_metadata(app);

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
    let scheme = current_keybinding_scheme(app);
    let show_rulers = CheckMenuItem::with_id(
        app,
        "view.toggleRulers",
        "Show Rulers",
        true,
        view_state.rulers_visible,
        Some(match scheme {
            KeybindingScheme::ChemDraft => "CmdOrCtrl+R",
            KeybindingScheme::ChemDraw => "CmdOrCtrl+;",
        }),
    )?;
    let show_crosshairs = CheckMenuItem::with_id(
        app,
        "view.toggleCrosshairs",
        "Show Crosshairs",
        true,
        view_state.crosshairs_visible,
        Some(match scheme {
            KeybindingScheme::ChemDraft => "CmdOrCtrl+Shift+R",
            KeybindingScheme::ChemDraw => "Alt+CmdOrCtrl+X",
        }),
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
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
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
        // Already built — but it may have been created (or dragged) offscreen earlier, or the
        // display it lived on may have been unplugged while it was hidden. Re-clamp on the way in,
        // so re-opening from View ▸ Toolbars is always enough to recover a lost palette.
        recover_offscreen_toolset_window(app, &window);
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
    // Either way it's clamped onto an attached monitor — a position saved on a display that's since
    // been unplugged would otherwise open the palette offscreen with no way to get it back.
    let position = clamp_toolset_position(
        app,
        persisted_toolset_position(app, toolset_id).unwrap_or(default_position),
        width,
        height,
    );

    // Record label -> id so the Moved/Destroyed handlers and enumeration can resolve the toolset
    // without the manifest (the label itself is lossy).
    if let Ok(mut labels) = app.state::<ToolsetWindowDirectory>().labels.lock() {
        labels.insert(label.clone(), toolset_id.to_string());
    }

    let window = match utility_window_builder(
        WebviewWindowBuilder::new(
            app,
            label.clone(),
            WebviewUrl::App(format!("/?window=toolset&toolsetId={toolset_id}").into()),
        ),
        app,
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

/// Run `task` on the main thread and wait for its result. AppKit is main-thread-only, and the
/// window-creating commands are `async` (a tokio worker — required for WebView2 on Windows), so every
/// raw NSWindow call they reach must be marshalled. Tauri runs the closure inline when already on the
/// main thread, so this is also safe to call from there (the result is sent before `recv` blocks).
#[cfg(target_os = "macos")]
fn run_on_main_thread_blocking<R: Runtime, T: Send + 'static>(
    window: &tauri::WebviewWindow<R>,
    task: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            let _ = sender.send(task());
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv()
        .map_err(|_| "The main thread dropped a window-configuration task.".to_string())
}

#[cfg(target_os = "macos")]
fn configure_toolset_utility_window<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    order_front: bool,
) -> Result<(), String> {
    let target = window.clone();
    run_on_main_thread_blocking(window, move || {
        configure_toolset_utility_window_on_main_thread(&target, order_front)
    })?
}

#[cfg(target_os = "macos")]
fn configure_toolset_utility_window_on_main_thread<R: Runtime>(
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
#[cfg(target_os = "macos")]
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PalettePointerPayload {
    toolset_id: String,
    x: f64,
    y: f64,
}

#[cfg(target_os = "macos")]
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

/// Off macOS there is no panel treatment to apply after the build: everything a utility window
/// needs is set on its builder by [`utility_window_builder`]. (No menu bar needs stripping either —
/// the app menu is attached to the document window only; see `install_app_menu`.)
#[cfg(not(target_os = "macos"))]
fn configure_toolset_utility_window<R: Runtime>(
    _window: &tauri::WebviewWindow<R>,
    _order_front: bool,
) -> Result<(), String> {
    Ok(())
}

/// Builder settings every floating utility window (palettes, popovers, the tooltip, plugin panels)
/// shares. On Windows:
/// - **owned by the document window**, given to tao at build time: an owned window stays above its
///   owner, hides while it is minimized and is destroyed with it — and tao creates it as a popup
///   without `WS_EX_APPWINDOW`. (Setting `GWLP_HWNDPARENT` afterwards left tao believing the window
///   was unowned, so it kept `WS_EX_APPWINDOW` — an Alt+Tab entry per palette — and re-applied it
///   on every style change.)
/// - **not focused when shown**: tao then shows it with `SW_SHOWNOACTIVATE`. With the default
///   `focused(true)` every show was `SW_SHOW`, which activated the palette (despite
///   `focusable(false)`), greyed the document's title bar and took its keystrokes.
fn utility_window_builder<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    app: &tauri::AppHandle<R>,
) -> WebviewWindowBuilder<'a, R, M> {
    #[cfg(windows)]
    {
        let builder = builder.focused(false);
        match app
            .get_webview_window(MAIN_WINDOW_LABEL)
            .and_then(|main| main.hwnd().ok())
        {
            Some(owner) => builder.owner_raw(owner),
            None => builder,
        }
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        builder
    }
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
    MENU_COMMAND_IDS.contains(&command_id)
        || command_id.starts_with(TOOLSET_TOGGLE_PREFIX)
        || command_id.starts_with(PLUGIN_COMMAND_PREFIX)
}

/// How much of a palette must land on a monitor for the user to be able to grab and move it.
const TOOLSET_WINDOW_MIN_VISIBLE_PX: f64 = 48.0;

/// A monitor's bounds in the same logical points palette positions are persisted in.
fn monitor_logical_bounds(monitor: &tauri::Monitor) -> (f64, f64, f64, f64) {
    let scale = monitor.scale_factor();
    let origin = monitor.position().to_logical::<f64>(scale);
    let size = monitor.size().to_logical::<f64>(scale);
    (
        origin.x,
        origin.y,
        origin.x + size.width,
        origin.y + size.height,
    )
}

/// True when the rect overlaps some attached monitor enough to be seen and dragged.
fn toolset_position_is_reachable(
    monitors: &[tauri::Monitor],
    position: &ToolsetWindowPosition,
    width: f64,
    height: f64,
) -> bool {
    monitors.iter().any(|monitor| {
        let (left, top, right, bottom) = monitor_logical_bounds(monitor);
        let overlap_w = (position.x + width).min(right) - position.x.max(left);
        let overlap_h = (position.y + height).min(bottom) - position.y.max(top);
        overlap_w >= TOOLSET_WINDOW_MIN_VISIBLE_PX && overlap_h >= TOOLSET_WINDOW_MIN_VISIBLE_PX
    })
}

/// Pull a palette position back onto an attached monitor.
///
/// Positions are persisted in logical points, so a toolbar last parked on an external display comes
/// back at coordinates that no longer exist once that display is unplugged. The window is then
/// created successfully and painted into nowhere — which reads to the user as "the toolbar won't
/// open" even though View ▸ Toolbars shows it checked, with no UI path to recover it. Clamp onto the
/// primary monitor (the one that's certainly present) whenever the saved spot is unreachable.
fn clamp_toolset_position<R: Runtime>(
    app: &tauri::AppHandle<R>,
    position: ToolsetWindowPosition,
    width: f64,
    height: f64,
) -> ToolsetWindowPosition {
    let monitors = match app.available_monitors() {
        Ok(monitors) if !monitors.is_empty() => monitors,
        // No monitor info (headless, or the platform refused): trust the saved position rather than
        // moving a window the user may have deliberately placed.
        _ => return position,
    };

    if toolset_position_is_reachable(&monitors, &position, width, height) {
        return position;
    }

    let target = app
        .primary_monitor()
        .ok()
        .flatten()
        .unwrap_or_else(|| monitors[0].clone());
    let (left, top, right, bottom) = monitor_logical_bounds(&target);
    // max() before min() so a palette taller/wider than the monitor still pins to the top-left
    // corner instead of inverting to a negative offset.
    ToolsetWindowPosition {
        x: position.x.min(right - width).max(left),
        y: position.y.min(bottom - height).max(top),
    }
}

/// Move an already-built palette back onscreen if its current spot is unreachable. Best-effort: a
/// window we can't measure or move is left exactly as it is rather than teleported on a guess.
fn recover_offscreen_toolset_window<R: Runtime>(
    app: &tauri::AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
) {
    let Some(position) = current_toolset_window_position(window) else {
        return;
    };
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let size = size.to_logical::<f64>(scale);
    // `position` is Copy on this branch (the clamping helpers wanted it), so main's `.clone()` here is
    // a lint neither side trips alone -- main's struct is Clone-only. A merge artifact, not a bug.
    let clamped = clamp_toolset_position(app, position, size.width, size.height);
    if (clamped.x - position.x).abs() < 0.5 && (clamped.y - position.y).abs() < 0.5 {
        return;
    }

    let _ = window.set_position(tauri::LogicalPosition::new(clamped.x, clamped.y));
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

/// Whether a palette's current frame is a transient OS state (it or the document window it belongs
/// to is minimized) that must not be persisted as the palette's position.
fn toolset_frame_is_transient<R: Runtime>(
    app: &tauri::AppHandle<R>,
    window: &tauri::Window<R>,
) -> bool {
    let palette_minimized = window.is_minimized().unwrap_or(false);
    let document_minimized = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .is_some_and(|main| main.is_minimized().unwrap_or(false));
    toolset_frame_state_is_transient(palette_minimized, document_minimized)
}

/// The decision behind [`toolset_frame_is_transient`]. Only Windows ties palettes to the document's
/// minimized state (owned windows are minimized and parked at (-16000, -16000) with their owner). A
/// macOS palette stays visible and draggable while the document is in the Dock, and those moves are
/// real user moves.
fn toolset_frame_state_is_transient(palette_minimized: bool, document_minimized: bool) -> bool {
    palette_minimized || (cfg!(windows) && document_minimized)
}

fn current_toolset_window_position<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Option<ToolsetWindowPosition> {
    if window.is_minimized().unwrap_or(false) {
        return None;
    }
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

/// What a main-window resize or move should persist.
#[derive(Debug, PartialEq)]
enum MainWindowGeometryUpdate {
    /// Fullscreen or minimized: a transient OS state, not a user-chosen frame.
    Skip,
    /// Maximized: not the user's frame either (on Windows it even starts off-screen, at the
    /// invisible border), so record only the flag and keep the saved normal frame.
    MarkMaximized,
    /// A normal frame: save it, clearing the maximized flag.
    SaveFrame,
}

fn main_window_geometry_update(
    fullscreen: bool,
    minimized: bool,
    maximized: bool,
) -> MainWindowGeometryUpdate {
    if fullscreen || minimized {
        MainWindowGeometryUpdate::Skip
    } else if maximized {
        MainWindowGeometryUpdate::MarkMaximized
    } else {
        MainWindowGeometryUpdate::SaveFrame
    }
}

fn persist_main_window_geometry<R: Runtime>(window: &tauri::Window<R>) -> Result<(), String> {
    match main_window_geometry_update(
        window.is_fullscreen().unwrap_or(false),
        window.is_minimized().unwrap_or(false),
        window.is_maximized().unwrap_or(false),
    ) {
        MainWindowGeometryUpdate::Skip => return Ok(()),
        MainWindowGeometryUpdate::MarkMaximized => {
            return update_toolset_layout_state(window.app_handle(), |layout_state| {
                if let Some(geometry) = layout_state.main_window.as_mut() {
                    geometry.maximized = true;
                }
            });
        }
        MainWindowGeometryUpdate::SaveFrame => {}
    }
    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return Ok(());
    };
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let scale_factor = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    update_toolset_layout_state(window.app_handle(), |layout_state| {
        layout_state.main_window = Some(MainWindowGeometry {
            x: position.x as f64 / scale_factor,
            y: position.y as f64 / scale_factor,
            width: size.width as f64 / scale_factor,
            height: size.height as f64 / scale_factor,
            maximized: false,
        });
    })
}

/// Apply the saved main-window frame. Returns false when nothing usable was saved — first launch,
/// a degenerate frame, or a frame whose title bar is on no attached monitor — so the caller can
/// fall back to centering.
fn restore_main_window_geometry<R: Runtime>(window: &tauri::WebviewWindow<R>) -> bool {
    let Some(geometry) = load_toolset_layout_state(window.app_handle()).main_window else {
        return false;
    };
    if !(geometry.width > 0.0
        && geometry.height > 0.0
        && geometry.x.is_finite()
        && geometry.y.is_finite())
    {
        return false;
    }
    if !main_window_geometry_reachable(window, &geometry) {
        return false;
    }
    // macOS fullscreen owns the frame; report success so the caller doesn't center underneath it.
    if window.is_fullscreen().unwrap_or(false) {
        return true;
    }
    let restored = window
        .set_position(tauri::LogicalPosition::new(geometry.x, geometry.y))
        .and_then(|_| window.set_size(tauri::LogicalSize::new(geometry.width, geometry.height)))
        .is_ok();
    // Maximize after the normal frame is in place, so un-maximizing returns to it.
    if restored && geometry.maximized {
        let _ = window.maximize();
    }
    restored
}

/// True when the saved frame's title-bar strip lands on some attached monitor (compared in each
/// monitor's own logical space), so a frame saved on a since-detached display is rejected rather
/// than restored somewhere the user can't grab it.
fn main_window_geometry_reachable<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    geometry: &MainWindowGeometry,
) -> bool {
    let Ok(monitors) = window.available_monitors() else {
        // Can't enumerate displays — trust the frame rather than discard the user's layout.
        return true;
    };
    if monitors.is_empty() {
        return true;
    }
    monitors.iter().any(|monitor| {
        let scale_factor = monitor.scale_factor();
        let scale_factor = if scale_factor.is_finite() && scale_factor > 0.0 {
            scale_factor
        } else {
            1.0
        };
        let position = monitor.position();
        let size = monitor.size();
        let min_x = position.x as f64 / scale_factor;
        let min_y = position.y as f64 / scale_factor;
        title_bar_reachable_in_monitor(
            geometry,
            min_x,
            min_y,
            min_x + size.width as f64 / scale_factor,
            min_y + size.height as f64 / scale_factor,
        )
    })
}

fn title_bar_reachable_in_monitor(
    geometry: &MainWindowGeometry,
    monitor_min_x: f64,
    monitor_min_y: f64,
    monitor_max_x: f64,
    monitor_max_y: f64,
) -> bool {
    let title_center_x = geometry.x + geometry.width / 2.0;
    title_center_x >= monitor_min_x
        && title_center_x <= monitor_max_x
        && geometry.y >= monitor_min_y - 1.0
        && geometry.y + MAIN_WINDOW_TITLE_GRAB_PT <= monitor_max_y
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
    // Read-then-write, so a read failure must NOT become a write. This used to swallow every read
    // error as `default()`, and a transient failure during a window `Moved` event then wrote those
    // defaults over toolbar-state.json -- losing every saved position and visibility. Same trap the
    // write side was rewired to avoid; propagate instead, and the mutation is simply skipped.
    let mut layout_state = read_toolset_layout_state(app)?;
    update(&mut layout_state);
    save_toolset_layout_state(app, &layout_state)
}

/// What a layout-state read means, separated from where it came from so it can be tested directly.
///
/// Absent is not a failure: there is no file until the first save, and defaults are correct. Present
/// but unparseable falls back to defaults too -- writes are atomic, so this is not a half-written
/// file but genuinely unusable content, and returning defaults lets the next save repair it. An IO
/// error is the case that must NOT turn into a value: the file may be perfectly good and merely
/// unreadable right now, so it is returned as an error for a caller about to write to refuse on.
fn toolset_layout_state_from_read(
    read: Result<Option<String>, String>,
) -> Result<ToolsetLayoutState, String> {
    let Some(contents) = read? else {
        return Ok(ToolsetLayoutState::default());
    };
    Ok(serde_json::from_str(&contents).unwrap_or_default())
}

fn read_toolset_layout_state<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<ToolsetLayoutState, String> {
    let path = toolset_layout_state_path(app)?;
    toolset_layout_state_from_read(read_optional_file(&path))
}

/// Best-effort read for callers that only inspect the state and never write it back.
fn load_toolset_layout_state<R: Runtime>(app: &tauri::AppHandle<R>) -> ToolsetLayoutState {
    read_toolset_layout_state(app).unwrap_or_default()
}

fn save_toolset_layout_state<R: Runtime>(
    app: &tauri::AppHandle<R>,
    layout_state: &ToolsetLayoutState,
) -> Result<(), String> {
    let path = toolset_layout_state_path(app)?;
    let contents = serde_json::to_string_pretty(layout_state).map_err(|error| error.to_string())?;
    write_file_atomic(&path, &contents)
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

fn document_session_path<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join(DOCUMENT_SESSION_FILENAME))
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
    // Off macOS the menu lives on the document window, not the app (see `install_app_menu`).
    #[cfg(target_os = "macos")]
    let menu = app.menu();
    #[cfg(not(target_os = "macos"))]
    let menu = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .and_then(|window| window.menu());
    let Some(menu) = menu else {
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

    #[cfg(windows)]
    #[test]
    fn sidecar_placeholders_are_not_runnable_on_windows() {
        let dir = std::env::temp_dir().join(format!("chemdraft-sidecar-pe-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("temp dir");
        let placeholder = dir.join("placeholder.exe");
        fs::write(&placeholder, "ChemDraft avogadro3d-sidecar placeholder.").expect("placeholder");
        let mut pe = vec![0u8; 0x80];
        pe[..2].copy_from_slice(b"MZ");
        pe[0x3c] = 0x40;
        pe[0x40..0x44].copy_from_slice(b"PE\0\0");
        let image = dir.join("image.exe");
        fs::write(&image, &pe).expect("image");

        assert!(!is_runnable_sidecar(&placeholder));
        assert!(is_runnable_sidecar(&image));
        assert!(!is_runnable_sidecar(&dir.join("missing.exe")));
        assert!(is_runnable_sidecar(
            &std::env::current_exe().expect("test exe")
        ));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn committed_sidecar_placeholders_are_never_runnable() {
        let binaries = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
        for triple in [
            "x86_64-apple-darwin",
            "x86_64-unknown-linux-gnu",
            "aarch64-unknown-linux-gnu",
        ] {
            let placeholder = binaries.join(format!("avogadro3d-sidecar-{triple}"));
            assert!(is_sidecar_placeholder(&placeholder), "{triple}");
            assert!(!is_runnable_sidecar(&placeholder), "{triple}");
        }
        for real in [
            "avogadro3d-sidecar-aarch64-apple-darwin",
            "avogadro3d-sidecar-x86_64-pc-windows-msvc.exe",
        ] {
            assert!(!is_sidecar_placeholder(&binaries.join(real)), "{real}");
        }
    }

    #[test]
    fn a_minimized_palette_or_document_frame_is_never_persisted_where_windows_parks_it() {
        assert!(!toolset_frame_state_is_transient(false, false));
        assert!(toolset_frame_state_is_transient(true, false));
        assert!(toolset_frame_state_is_transient(true, true));
        // Windows minimizes owned palettes with the document and parks them off-screen; macOS
        // leaves them visible and draggable, so a move then is a real user move.
        assert_eq!(toolset_frame_state_is_transient(false, true), cfg!(windows));
    }

    #[test]
    fn a_maximized_main_window_records_the_flag_and_keeps_its_normal_frame() {
        use MainWindowGeometryUpdate::*;
        assert_eq!(main_window_geometry_update(false, false, false), SaveFrame);
        assert_eq!(
            main_window_geometry_update(false, false, true),
            MarkMaximized
        );
        // Transient states win over maximized: a minimized maximized window saves nothing.
        assert_eq!(main_window_geometry_update(false, true, true), Skip);
        assert_eq!(main_window_geometry_update(true, false, true), Skip);
        assert_eq!(main_window_geometry_update(true, false, false), Skip);

        // Layout files written before the flag existed still parse, as not maximized.
        let legacy: MainWindowGeometry =
            serde_json::from_str(r#"{"x":10,"y":20,"width":800,"height":600}"#)
                .expect("legacy geometry should parse");
        assert!(!legacy.maximized);
        let current: MainWindowGeometry =
            serde_json::from_str(r#"{"x":10,"y":20,"width":800,"height":600,"maximized":true}"#)
                .expect("current geometry should parse");
        assert!(current.maximized);
    }

    #[test]
    fn toggles_hide_only_a_window_the_user_can_see() {
        assert!(toggle_hides_window(true, false, false));
        assert!(!toggle_hides_window(false, false, false));
        assert!(!toggle_hides_window(true, true, false));
        assert!(!toggle_hides_window(true, false, true));
        assert!(rects_overlap((0, 0, 100, 100), (50, 50, 150, 150)));
        assert!(!rects_overlap((0, 0, 100, 100), (100, 0, 200, 100)));
        assert!(!rects_overlap((0, 0, 100, 100), (200, 200, 300, 300)));
    }

    #[test]
    fn global_logical_points_convert_with_their_monitors_scale() {
        // 150% laptop at the origin (logical 0..1920); 100% display to its right from physical
        // x = 2880 (logical 2880..4800). The logical frames do not overlap.
        let disjoint = [
            MonitorFrame {
                x: 0.0,
                y: 0.0,
                width: 2880.0,
                height: 1800.0,
                scale: 1.5,
            },
            MonitorFrame {
                x: 2880.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
                scale: 1.0,
            },
        ];
        // The window's own scale does not matter once only one monitor contains the point.
        assert_eq!(
            global_logical_to_physical(&disjoint, 1000.0, 100.0, 1.0),
            (1500.0, 150.0)
        );
        assert_eq!(
            global_logical_to_physical(&disjoint, 3000.0, 100.0, 1.5),
            (3000.0, 100.0)
        );

        // 100% primary at the origin; 200% display to its right from physical x = 1920, whose
        // logical frame (960..2880) overlaps the primary's (0..1920).
        let monitors = [
            MonitorFrame {
                x: 0.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
                scale: 1.0,
            },
            MonitorFrame {
                x: 1920.0,
                y: 0.0,
                width: 3840.0,
                height: 2160.0,
                scale: 2.0,
            },
        ];
        // Inside the overlap the moving window's own display wins: a palette at physical
        // x = 2400 on the 200% display reports logical 1200 and must stay there...
        assert_eq!(
            global_logical_to_physical(&monitors, 1200.0, 100.0, 2.0),
            (2400.0, 200.0)
        );
        // ...while a window on the primary at logical 1200 stays on the primary.
        assert_eq!(
            global_logical_to_physical(&monitors, 1200.0, 100.0, 1.0),
            (1200.0, 100.0)
        );
        // Outside the overlap only one monitor contains the point, whatever the window's scale.
        assert_eq!(
            global_logical_to_physical(&monitors, 500.0, 100.0, 2.0),
            (500.0, 100.0)
        );
        assert_eq!(
            global_logical_to_physical(&monitors, 2400.0, 100.0, 1.0),
            (4800.0, 200.0)
        );
        // Off every monitor: the fallback scale.
        assert_eq!(
            global_logical_to_physical(&monitors, -50.0, -50.0, 1.5),
            (-75.0, -75.0)
        );
    }

    #[test]
    fn toolbars_menu_pushes_rebuild_only_on_structural_change() {
        let entry = |id: &str, visible: bool| ToolbarMenuEntry {
            toolset_id: id.to_string(),
            title: id.to_string(),
            visible,
        };
        let view = ViewMenuState::default();
        let previous = (
            vec![entry("core.main", true), entry("core.art", false)],
            view,
        );
        assert_eq!(
            classify_toolbars_menu_update(&previous, &previous.0, view),
            ToolbarsMenuUpdate::Unchanged
        );
        assert_eq!(
            classify_toolbars_menu_update(
                &previous,
                &[entry("core.main", true), entry("core.art", true)],
                view
            ),
            ToolbarsMenuUpdate::ChecksOnly
        );
        assert_eq!(
            classify_toolbars_menu_update(
                &previous,
                &previous.0,
                ViewMenuState {
                    rulers_visible: false,
                    ..view
                }
            ),
            ToolbarsMenuUpdate::ChecksOnly
        );
        assert_eq!(
            classify_toolbars_menu_update(&previous, &[entry("core.main", true)], view),
            ToolbarsMenuUpdate::Rebuild
        );
        let mut renamed = previous.0.clone();
        renamed[1].title = "Art (renamed)".to_string();
        assert_eq!(
            classify_toolbars_menu_update(&previous, &renamed, view),
            ToolbarsMenuUpdate::Rebuild
        );
    }

    #[test]
    fn openable_document_paths_are_existing_chemdraft_or_cdxml_files() {
        let dir = std::env::temp_dir().join(format!("chemdraft-open-args-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("temp dir");
        for name in ["a.chemdraft", "b.CDXML", "c.txt"] {
            fs::write(dir.join(name), "<CDXML/>").expect("fixture");
        }

        assert!(is_openable_document_path(&dir.join("a.chemdraft")));
        assert!(is_openable_document_path(&dir.join("b.CDXML")));
        assert!(!is_openable_document_path(&dir.join("c.txt")));
        assert!(!is_openable_document_path(&dir.join("missing.cdxml")));
        assert!(!is_openable_document_path(&dir));

        let payload = open_document_payload_from_path(&dir.join("a.chemdraft")).expect("payload");
        assert_eq!(payload.display_name, "a.chemdraft");
        assert_eq!(payload.contents, "<CDXML/>");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn layout_state_read_error_never_becomes_defaults() {
        // An absent file is not a failure: defaults are correct until the first save.
        let absent = toolset_layout_state_from_read(Ok(None)).expect("absent is not an error");
        assert_eq!(absent.toolsets.len(), 0);
        assert!(absent.main_window.is_none());

        // Unparseable content falls back to defaults so the next save can repair the file. Writes
        // are atomic, so this is genuinely bad content rather than a half-written one.
        let corrupt = toolset_layout_state_from_read(Ok(Some("{not json".to_string())))
            .expect("corrupt content falls back to defaults");
        assert_eq!(corrupt.toolsets.len(), 0);

        // An IO error must stay an error. Turning it into defaults is what let a transient read
        // failure during a window Moved event overwrite every saved position and visibility.
        let failed = toolset_layout_state_from_read(Err("permission denied".to_string()));
        assert!(
            failed.is_err(),
            "an IO error must not be reported as a usable state"
        );

        // And a good file still round-trips.
        let saved = ToolsetLayoutState {
            version: 1,
            toolsets: HashMap::new(),
            main_window: Some(MainWindowGeometry {
                x: 12.0,
                y: 34.0,
                width: 800.0,
                height: 600.0,
                maximized: false,
            }),
        };
        let json = serde_json::to_string(&saved).expect("serialize");
        let loaded = toolset_layout_state_from_read(Ok(Some(json))).expect("valid state parses");
        assert_eq!(loaded.main_window.map(|frame| frame.x), Some(12.0));
    }

    #[test]
    fn read_optional_file_distinguishes_absent_from_present() {
        let dir =
            std::env::temp_dir().join(format!("chemdraft-read-optional-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("state.json");

        // Absent file → Ok(None), NOT an error — so a caller never mistakes a transient miss for
        // "no saved state" and clobbers the real file with defaults.
        expect_true(matches!(read_optional_file(&path), Ok(None)));

        fs::write(&path, "{\"v\":1}").expect("seed file");
        match read_optional_file(&path) {
            Ok(Some(contents)) => expect_eq("{\"v\":1}", &contents),
            other => panic!("expected Ok(Some(..)), got {other:?}"),
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_file_atomic_replaces_completely_creates_parents_and_leaves_no_temp() {
        let dir =
            std::env::temp_dir().join(format!("chemdraft-write-atomic-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        // Parent dir does not exist yet — write_file_atomic must create it.
        let path = dir.join("nested").join("state.json");

        write_file_atomic(&path, "first").expect("first write");
        expect_eq("first", &fs::read_to_string(&path).expect("read first"));

        // Overwriting a longer payload fully replaces the file (never torn).
        write_file_atomic(&path, "second-longer-payload").expect("second write");
        expect_eq(
            "second-longer-payload",
            &fs::read_to_string(&path).expect("read second"),
        );

        // No sibling temp file lingers after a successful commit.
        let leftover_temps = fs::read_dir(path.parent().expect("parent"))
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp"))
            .count();
        expect_eq(&0usize.to_string(), &leftover_temps.to_string());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_atomic_writes_to_one_path_never_publish_a_torn_file() {
        // Tauri runs commands on a thread pool, so two writes to the same path can overlap inside
        // one process. With a pid-only temp name they shared a temp file and one rename could
        // publish the other's half-written bytes; the per-write counter keeps them separate.
        let dir =
            std::env::temp_dir().join(format!("chemdraft-write-concurrent-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("state.json");
        let short = "s".repeat(64);
        let long = "L".repeat(64_000);

        let mut handles = Vec::new();
        for index in 0..8 {
            let path = path.clone();
            let payload = if index % 2 == 0 {
                short.clone()
            } else {
                long.clone()
            };
            handles.push(std::thread::spawn(move || {
                for _ in 0..12 {
                    write_file_atomic(&path, &payload).expect("concurrent write");
                }
            }));
        }
        for handle in handles {
            handle.join().expect("writer thread");
        }

        // Whatever landed last, it must be exactly one of the complete payloads — never a splice.
        let final_contents = fs::read_to_string(&path).expect("read final");
        if final_contents != short && final_contents != long {
            panic!(
                "torn write: {} bytes matching neither payload",
                final_contents.len()
            );
        }

        let leftover_temps = fs::read_dir(path.parent().expect("parent"))
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp"))
            .count();
        expect_eq(&0usize.to_string(), &leftover_temps.to_string());

        let _ = fs::remove_dir_all(&dir);
    }

    /// Every custom command registered with `generate_handler!` needs BOTH a generated permission
    /// file and a capability grant, or Tauri's deny-by-default ACL rejects the invoke — and because
    /// the JS side swallows invoke rejections, the feature simply does nothing with no error
    /// anywhere. That is how the popover reveal and cold-start "Open With" each shipped broken. This
    /// cross-checks the registered list against both, so the next omission fails here instead of in
    /// a user's hands. (build.rs's list only *generates* the permission files, which are committed,
    /// so it is deliberately not the thing asserted.)
    #[test]
    fn registered_commands_have_permissions_and_capability_grants() {
        let lib_source = include_str!("lib.rs");
        let capability = include_str!("../capabilities/default.json");

        let handler_start = lib_source
            .find("generate_handler![")
            .expect("generate_handler! invocation");
        let handler_body = &lib_source[handler_start..];
        let handler_end = handler_body.find(']').expect("generate_handler! close");
        let registered: Vec<String> = handler_body[.."generate_handler![".len() + handler_end]
            .lines()
            .skip(1)
            .filter_map(|line| {
                let name = line.trim().trim_end_matches(',').trim();
                // Module-qualified commands (export::, fonts::) carry their own permissions.
                if name.is_empty()
                    || name.contains("::")
                    || name.contains('[')
                    || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                {
                    None
                } else {
                    Some(name.to_string())
                }
            })
            .collect();
        assert!(
            registered.len() > 10,
            "expected to parse the handler list, got {registered:?}"
        );

        let permissions_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("permissions")
            .join("autogenerated");
        for command in registered {
            let permission_file = permissions_dir.join(format!("{command}.toml"));
            assert!(
                permission_file.exists(),
                "command `{command}` is registered but has no generated permission at {}; add it to \
                 build.rs's app-manifest list so the permission is generated",
                permission_file.display()
            );
            let permission = format!("allow-{}", command.replace('_', "-"));
            assert!(
                capability.contains(&format!("\"{permission}\"")),
                "command `{command}` is registered but `{permission}` is not granted in \
                 capabilities/default.json, so every invoke is denied and the JS silently swallows it"
            );
        }
    }

    #[test]
    fn toolset_window_labels_are_stable_and_sanitized() {
        expect_eq("toolset-core-main", &toolset_window_label("core.main"));
        expect_eq(
            "toolset-plugin-fixture",
            &toolset_window_label("plugin.fixture"),
        );
    }

    #[test]
    fn saved_main_window_frame_on_the_monitor_is_reachable() {
        let geometry = MainWindowGeometry {
            x: 100.0,
            y: 50.0,
            width: 1280.0,
            height: 820.0,
            maximized: false,
        };
        expect_true(title_bar_reachable_in_monitor(
            &geometry, 0.0, 0.0, 1728.0, 1117.0,
        ));
    }

    #[test]
    fn saved_main_window_frame_off_a_detached_display_is_rejected() {
        // Frame saved on a monitor to the left of the (now only) built-in display.
        let geometry = MainWindowGeometry {
            x: -2000.0,
            y: 50.0,
            width: 1280.0,
            height: 820.0,
            maximized: false,
        };
        expect_false(title_bar_reachable_in_monitor(
            &geometry, 0.0, 0.0, 1728.0, 1117.0,
        ));
    }

    #[test]
    fn saved_main_window_frame_below_the_dock_edge_is_rejected() {
        // Title bar would sit under the bottom of the display — nothing left to grab.
        let geometry = MainWindowGeometry {
            x: 100.0,
            y: 1110.0,
            width: 1280.0,
            height: 820.0,
            maximized: false,
        };
        expect_false(title_bar_reachable_in_monitor(
            &geometry, 0.0, 0.0, 1728.0, 1117.0,
        ));
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

        // Plugin command ids (ADR-0016) route generically by their `plugin.` namespace, so a plugin's
        // native menu items reach the webview without any core edit.
        expect_true(is_routed_menu_command(
            "plugin.massFragment.analyzeSelectedStructure",
        ));
        expect_true(is_routed_menu_command(
            "plugin.molscribeOcsr.recognizeImage",
        ));
        expect_false(is_routed_menu_command("definitely.not.a.routed.command"));
    }

    #[test]
    fn plugin_manager_menu_command_is_routed() {
        expect_true(is_routed_menu_command("plugins.manage"));
    }

    /// Edit ▸ Undo/Redo must reach the drawing's history. AppKit's predefined items send undo: to
    /// the webview's text undo manager instead, which knows nothing about document changes.
    #[test]
    fn undo_redo_edit_menu_commands_are_routed_with_mac_shortcuts() {
        let items: Vec<(&str, &str, &str)> = EDIT_HISTORY_MENU_ITEMS
            .iter()
            .map(|item| (item.command_id, item.label, item.accelerator))
            .collect();
        assert_eq!(
            items,
            vec![
                ("edit.undo", "Undo", "CmdOrCtrl+Z"),
                ("edit.redo", "Redo", "CmdOrCtrl+Shift+Z"),
            ]
        );
        for item in &EDIT_HISTORY_MENU_ITEMS {
            expect_true(is_routed_menu_command(item.command_id));
            expect_true(is_edit_history_command(item.command_id));
        }
        expect_false(is_edit_history_command("edit.selectAll"));
    }

    /// ⌘Z in a palette's text field must undo that text, not the drawing: Undo / Redo follow the key
    /// window, while every other routed command still goes to the document window.
    #[test]
    fn undo_redo_follow_the_key_window_and_other_commands_go_to_main() {
        assert_eq!(
            menu_command_target_label("edit.undo", Some("toolset-core-main")),
            "toolset-core-main"
        );
        assert_eq!(
            menu_command_target_label("edit.redo", Some("preferences")),
            "preferences"
        );
        assert_eq!(
            menu_command_target_label("edit.undo", Some(MAIN_WINDOW_LABEL)),
            MAIN_WINDOW_LABEL
        );
        assert_eq!(
            menu_command_target_label("edit.undo", None),
            MAIN_WINDOW_LABEL
        );
        assert_eq!(
            menu_command_target_label("edit.selectAll", Some("toolset-core-main")),
            MAIN_WINDOW_LABEL
        );
        assert_eq!(
            menu_command_target_label("clipboard.copyAs.smiles", Some("preferences")),
            MAIN_WINDOW_LABEL
        );
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
            capability_permission_identifier(permission) == Some("dialog:allow-save")
        }));
        expect_true(permissions.iter().any(|permission| {
            capability_permission_identifier(permission) == Some("fs:allow-write-text-file")
        }));
        expect_true(permissions.iter().any(|permission| {
            capability_permission_identifier(permission) == Some("fs:allow-write-file")
        }));
        expect_true(permissions.iter().any(|permission| {
            capability_permission_identifier(permission) == Some("allow-rasterize-svg")
        }));
    }

    #[test]
    fn default_capability_allows_atomic_plugin_catalog_writes() {
        let capability = include_str!("../capabilities/default.json");
        let parsed: serde_json::Value =
            serde_json::from_str(capability).expect("default capability should parse");
        let permissions = parsed
            .pointer("/permissions")
            .and_then(serde_json::Value::as_array)
            .expect("default capability should declare permissions");

        for permission_id in ["fs:allow-write-text-file", "fs:allow-rename"] {
            let permission = permissions
                .iter()
                .find(|permission| {
                    capability_permission_identifier(permission) == Some(permission_id)
                })
                .unwrap_or_else(|| panic!("missing scoped permission {permission_id}"));
            let paths = permission
                .pointer("/allow")
                .and_then(serde_json::Value::as_array)
                .unwrap_or_else(|| panic!("{permission_id} should declare an allow scope"));

            for expected_path in [
                "$APPDATA/installed-plugins.json",
                "$APPDATA/installed-plugins.json.tmp",
            ] {
                expect_true(paths.iter().any(|entry| {
                    entry.pointer("/path").and_then(serde_json::Value::as_str)
                        == Some(expected_path)
                }));
            }
        }
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

    /// NSIS ignores `rank`, so a Windows `.cdxml` association is never "Alternate": a per-user install
    /// writes HKCU's `.cdxml` default, which outranks ChemDraw's machine-wide registration. The
    /// Windows override (merged over tauri.conf.json, arrays replaced) must register `.chemdraft` only.
    #[test]
    fn windows_bundle_never_claims_cdxml() {
        let config = include_str!("../tauri.windows.conf.json");
        let parsed: serde_json::Value =
            serde_json::from_str(config).expect("windows tauri config should parse");
        let extensions = parsed
            .pointer("/bundle/fileAssociations")
            .and_then(serde_json::Value::as_array)
            .expect("the windows override must replace bundle.fileAssociations")
            .iter()
            .filter_map(|association| association.get("ext"))
            .filter_map(serde_json::Value::as_array)
            .flatten()
            .filter_map(serde_json::Value::as_str)
            .collect::<Vec<_>>();
        assert_eq!(extensions, ["chemdraft"]);
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
        // Windows accepts only a real PE image as the sidecar (see is_runnable_sidecar); the running
        // test binary is one, and it is never written or removed here.
        #[cfg(windows)]
        let (path, owned) = (std::env::current_exe().expect("test executable"), false);
        #[cfg(not(windows))]
        let (path, owned) = {
            let path = std::env::temp_dir()
                .join(format!("chemdraft-engine3d-status-{}", std::process::id()));
            fs::write(&path, "").expect("fixture should write");
            (path, true)
        };

        let status = engine3d_sidecar_status_from(Some(path.to_string_lossy().to_string()));

        expect_true(status.available);
        expect_eq("environment", status.source.as_str());
        expect_eq(ENGINE3D_PROTOCOL_VERSION, status.protocol_version);
        expect_eq(
            Some(path.to_string_lossy().to_string()),
            status.resolved_path,
        );

        if owned {
            let _ = fs::remove_file(path);
        }
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
    fn clipboard_byte_decoder_accepts_bomless_majority_cjk_payloads() {
        // CJK code points rarely null-pad either byte of a UTF-16 unit, so the null-parity ratio
        // that flags mostly-Latin text can't fire here — this is the exact "paste between two
        // ChemDraft instances mangles Chinese text" shape the decoder must still accept.
        let text = "苯甲酸";
        let bytes = text
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();

        expect_eq(Some(text.to_string()), decode_clipboard_text_bytes(&bytes));
    }

    #[test]
    fn clipboard_byte_decoder_rejects_sparse_binary_that_decodes_into_private_use_glyphs() {
        // Null-free binary bytes reach the low-confidence sparse-null path; when they decode
        // into private-use code points (as byte-swapped or arbitrary data often does), the
        // extra-scrutiny filter must reject them instead of pasting them as "text".
        let bytes = vec![0xe1, 0xe1, 0xe1, 0xe1, 0xe1, 0xe1]; // decodes to U+E1E1 (PUA) x3 either order

        expect_eq(None, decode_clipboard_text_bytes(&bytes));
    }

    #[test]
    fn clipboard_byte_decoder_accepts_bom_prefixed_utf16_payloads() {
        let text = "苯甲酸";
        let mut bytes = vec![0xff, 0xfe];
        bytes.extend(text.encode_utf16().flat_map(u16::to_le_bytes));

        expect_eq(Some(text.to_string()), decode_clipboard_text_bytes(&bytes));
    }

    #[test]
    fn clipboard_byte_decoder_rejects_null_heavy_binary_blobs() {
        // The shape of a WebKit custom-pasteboard-data / binary-plist blob: length-prefixed
        // fields whose null bytes land on BOTH parities. The old heuristic decoded blobs like
        // this as UTF-16 and produced CJK mojibake "text" that pasted as a text object.
        let mut bytes = vec![0x01, 0x00, 0x00, 0x00, 0x29, 0x00, 0x00, 0x00];
        bytes.extend(b"null:acff5040-3cd6-47ec-8888-000000000000".to_vec());
        bytes.extend(vec![
            0x00, 0x62, 0x70, 0x00, 0x00, 0x13, 0x37, 0x00, 0x81, 0x92,
        ]);

        expect_eq(None, decode_clipboard_text_bytes(&bytes));
    }

    #[test]
    fn clipboard_byte_decoder_rejects_bomless_utf16_with_scattered_nulls() {
        // 50% nulls overall (old trigger) but split across both parities — binary, not text.
        let bytes = vec![
            0x00, 0x41, 0x42, 0x00, 0x00, 0x43, 0x44, 0x00, 0x00, 0x45, 0x46, 0x00,
        ];

        expect_eq(None, decode_clipboard_text_bytes(&bytes));
    }

    #[test]
    fn webkit_custom_pasteboard_container_is_opaque() {
        expect_true(is_opaque_clipboard_type(
            "com.apple.WebKit.custom-pasteboard-data",
        ));
        expect_true(is_opaque_clipboard_type(
            "org.webkit.custom-pasteboard-data",
        ));
        expect_false(is_opaque_clipboard_type(
            "application/x-chemdraft-selection+json",
        ));
        expect_false(is_opaque_clipboard_type("com.mdli.molfile"));
        expect_false(is_opaque_clipboard_type("text/plain"));
    }

    /// Round-trips the real NSPasteboard, so it stomps the user's clipboard — run explicitly
    /// with `cargo test -- --ignored`. This is the cross-instance copy/paste contract: what
    /// one ChemDraft process writes natively, another must read back verbatim, and a WebKit
    /// custom-pasteboard container left by a webview copy must yield NO text item instead of
    /// UTF-16 mojibake.
    #[test]
    #[ignore]
    #[cfg(target_os = "macos")]
    fn native_pasteboard_round_trips_chemdraft_selection_and_skips_webkit_container() {
        use objc2_foundation::NSData;

        let selection_json = r#"{"kind":"chemdraft-selection","objects":[{"type":"molecule","atoms":[{"el":"C"},{"el":"O"}]}]}"#;
        write_clipboard_text_items_impl(vec![ClipboardWriteTextItem {
            r#type: "application/x-chemdraft-selection+json".to_string(),
            text: selection_json.to_string(),
        }])
        .expect("native clipboard write should succeed");

        // What a webview copy leaves behind: binary, null-sprinkled container data.
        let mut container_bytes: Vec<u8> = vec![0x01, 0x00, 0x00, 0x00, 0x29, 0x00, 0x00, 0x00];
        container_bytes.extend(b"null:acff5040-3cd6-47ec".to_vec());
        container_bytes.extend(vec![
            0x00, 0x62, 0x70, 0x00, 0x00, 0x13, 0x37, 0x00, 0x81, 0x92,
        ]);
        let pasteboard = NSPasteboard::generalPasteboard();
        let container_type = NSString::from_str("com.apple.WebKit.custom-pasteboard-data");
        expect_true(
            pasteboard
                .setData_forType(Some(&NSData::with_bytes(&container_bytes)), &container_type),
        );

        let payload = read_clipboard_payload_impl().expect("native clipboard read should succeed");

        let selection_item = payload
            .text_items
            .iter()
            .find(|item| item.r#type == "application/x-chemdraft-selection+json")
            .expect("selection flavor should read back");
        expect_eq(selection_json.to_string(), selection_item.text.clone());
        expect_true(
            payload
                .types
                .iter()
                .any(|kind| kind == "com.apple.WebKit.custom-pasteboard-data"),
        );
        expect_true(
            !payload
                .text_items
                .iter()
                .any(|item| item.r#type == "com.apple.WebKit.custom-pasteboard-data"),
        );
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

    fn capability_permission_identifier(permission: &serde_json::Value) -> Option<&str> {
        permission.as_str().or_else(|| {
            permission
                .pointer("/identifier")
                .and_then(serde_json::Value::as_str)
        })
    }

    fn expect_false(value: bool) {
        assert!(!value);
    }

    fn expect_eq<T: PartialEq + std::fmt::Debug>(expected: T, actual: T) {
        assert_eq!(expected, actual);
    }
}
