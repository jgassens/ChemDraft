use std::{collections::HashMap, fs, path::PathBuf};

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu},
    Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSFloatingWindowLevel, NSWindow, NSWindowAnimationBehavior, NSWindowCollectionBehavior,
    NSWindowStyleMask,
};

const MAIN_WINDOW_LABEL: &str = "main";
const DEFAULT_TOOLSET_ID: &str = "core.main";
const TOOLSET_COMMAND_EVENT: &str = "chemdraft://palette-command";
const TOOLSET_WINDOW_STATE_EVENT: &str = "chemdraft://toolset-window-state";
const TOOLSET_TOGGLE_PREFIX: &str = "view.toolset.toggle.";
const TOOLSET_MANIFEST_JSON: &str = include_str!("../../src/toolsets/desktop-toolsets.json");
const TOOLSET_LAYOUT_STATE_FILENAME: &str = "toolbar-state.json";
const MENU_COMMAND_IDS: &[&str] = &[
    "document.new",
    "document.open",
    "document.save",
    "export.svg",
    "export.png",
    "view.toggleRulers",
    "view.toggleCrosshairs",
    "chemistry.validateSelection",
];

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolsetManifest {
    toolsets: Vec<ToolsetDefinition>,
}

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolsetDefinition {
    id: String,
    title: String,
    default_visible: bool,
    default_mode: String,
    preferred_window_size: Option<ToolsetWindowSize>,
}

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolsetWindowSize {
    width: f64,
    height: f64,
    min_width: Option<f64>,
    min_height: Option<f64>,
}

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

#[derive(Clone, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedToolsetState {
    #[serde(skip_serializing_if = "Option::is_none")]
    visible: Option<bool>,
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
        .menu(create_app_menu)
        .on_menu_event(|app, event| {
            let command_id = event.id().as_ref();
            if let Some(toolset_id) = command_id.strip_prefix(TOOLSET_TOGGLE_PREFIX) {
                if let Err(error) = toggle_toolset_window(app.clone(), toolset_id.to_string()) {
                    eprintln!("Could not toggle ChemDraft toolbar {toolset_id}: {error}");
                }
                return;
            }
            if command_id == "view.toggleRulers" || command_id == "view.toggleCrosshairs" {
                if let Err(error) = toggle_check_menu_item(app, command_id) {
                    eprintln!("Could not update ChemDraft menu check state {command_id}: {error}");
                }
            }
            if is_routed_menu_command(command_id) {
                if let Err(error) = emit_command_to_main(app, command_id) {
                    eprintln!("Could not route ChemDraft menu command {command_id}: {error}");
                }
            }
        })
        .on_window_event(|window, event| {
            if window.label() == MAIN_WINDOW_LABEL {
                if let WindowEvent::Focused(true) = event {
                    if let Err(error) = restore_visible_toolset_windows(window.app_handle()) {
                        eprintln!("Could not restore ChemDraft toolbar windows: {error}");
                    }
                }
                return;
            }

            let Some(toolset_id) = toolset_id_for_window_label(window.label()) else {
                return;
            };
            let app = window.app_handle();

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
            let layout_state = load_toolset_layout_state(app);

            for toolset in toolset_manifest().toolsets {
                let visible = toolset_visible(&toolset, &layout_state);
                if let Err(error) = sync_toolset_window_from_layout(app, &toolset, visible) {
                    eprintln!(
                        "Could not initialize ChemDraft toolbar state {}: {error}",
                        toolset.id
                    );
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_toolset_window,
            close_toolset_window,
            focus_toolset_window,
            toggle_toolset_window,
            list_toolset_window_states,
            route_toolset_command,
            open_tool_palette,
            close_tool_palette,
            focus_tool_palette,
            toggle_tool_palette,
            tool_palette_state,
            route_palette_command
        ])
        .run(tauri::generate_context!())
        .expect("error while running ChemDraft");
}

#[tauri::command]
fn open_toolset_window(
    app: tauri::AppHandle,
    toolset_id: String,
) -> Result<ToolsetWindowState, String> {
    ensure_toolset_window(&app, &toolset_id)?;
    persist_toolset_visibility(&app, &toolset_id, true)?;
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
fn focus_toolset_window(
    app: tauri::AppHandle,
    toolset_id: String,
) -> Result<ToolsetWindowState, String> {
    ensure_toolset_window(&app, &toolset_id)?;

    toolset_state(&app, &toolset_id)
}

#[tauri::command]
fn toggle_toolset_window(
    app: tauri::AppHandle,
    toolset_id: String,
) -> Result<ToolsetWindowState, String> {
    if let Some(window) = app.get_webview_window(&toolset_window_label(&toolset_id)) {
        if window.is_visible().unwrap_or(false) {
            return close_toolset_window(app, toolset_id);
        }
    }

    open_toolset_window(app, toolset_id)
}

#[tauri::command]
fn list_toolset_window_states(app: tauri::AppHandle) -> Result<Vec<ToolsetWindowState>, String> {
    Ok(toolset_manifest()
        .toolsets
        .into_iter()
        .map(|toolset| toolset_state(&app, &toolset.id))
        .collect::<Result<Vec<_>, _>>()?)
}

#[tauri::command]
fn route_toolset_command(app: tauri::AppHandle, command_id: String) -> Result<(), String> {
    if command_id.trim().is_empty() {
        return Err("Toolset command id cannot be empty.".to_string());
    }

    emit_command_to_main(&app, command_id.trim())
}

#[tauri::command]
fn open_tool_palette(app: tauri::AppHandle) -> Result<ToolsetWindowState, String> {
    open_toolset_window(app, DEFAULT_TOOLSET_ID.to_string())
}

#[tauri::command]
fn close_tool_palette(app: tauri::AppHandle) -> Result<ToolsetWindowState, String> {
    close_toolset_window(app, DEFAULT_TOOLSET_ID.to_string())
}

#[tauri::command]
fn focus_tool_palette(app: tauri::AppHandle) -> Result<ToolsetWindowState, String> {
    focus_toolset_window(app, DEFAULT_TOOLSET_ID.to_string())
}

#[tauri::command]
fn toggle_tool_palette(app: tauri::AppHandle) -> Result<ToolsetWindowState, String> {
    toggle_toolset_window(app, DEFAULT_TOOLSET_ID.to_string())
}

#[tauri::command]
fn tool_palette_state(app: tauri::AppHandle) -> Result<ToolsetWindowState, String> {
    toolset_state(&app, DEFAULT_TOOLSET_ID)
}

#[tauri::command]
fn route_palette_command(app: tauri::AppHandle, command_id: String) -> Result<(), String> {
    route_toolset_command(app, command_id)
}

fn emit_command_to_main<R: Runtime>(
    app: &tauri::AppHandle<R>,
    command_id: &str,
) -> Result<(), String> {
    let main = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "Main document window is not available.".to_string())?;

    main.emit(
        TOOLSET_COMMAND_EVENT,
        ToolsetCommandPayload {
            command_id: command_id.to_string(),
        },
    )
    .map_err(|error| error.to_string())
}

fn emit_toolset_window_state_to_main<R: Runtime>(
    app: &tauri::AppHandle<R>,
    state: &ToolsetWindowState,
) -> Result<(), String> {
    let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return Ok(());
    };

    main.emit(TOOLSET_WINDOW_STATE_EVENT, state.clone())
        .map_err(|error| error.to_string())
}

fn create_app_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let view_menu = create_view_menu(app)?;

    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                "File",
                true,
                &[
                    &MenuItem::with_id(app, "document.new", "New", true, Some("CmdOrCtrl+N"))?,
                    &MenuItem::with_id(app, "document.open", "Open...", true, Some("CmdOrCtrl+O"))?,
                    &MenuItem::with_id(app, "document.save", "Save", true, Some("CmdOrCtrl+S"))?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "export.svg", "Export SVG", true, None::<&str>)?,
                    &MenuItem::with_id(app, "export.png", "Export PNG", true, None::<&str>)?,
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
                ],
            )?,
            &view_menu,
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

fn create_view_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Submenu<R>> {
    let show_rulers = CheckMenuItem::with_id(
        app,
        "view.toggleRulers",
        "Show Rulers",
        true,
        false,
        Some("CmdOrCtrl+R"),
    )?;
    let show_crosshairs = CheckMenuItem::with_id(
        app,
        "view.toggleCrosshairs",
        "Show Crosshairs",
        true,
        true,
        Some("CmdOrCtrl+Shift+R"),
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let toolbars_menu = create_toolbars_menu(app)?;

    Submenu::with_items(
        app,
        "View",
        true,
        &[&show_rulers, &show_crosshairs, &separator, &toolbars_menu],
    )
}

fn create_toolbars_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Submenu<R>> {
    let menu = Submenu::new(app, "Toolbars", true)?;

    for toolset in toolset_manifest().toolsets {
        let item = CheckMenuItem::with_id(
            app,
            toolset_toggle_command_id(&toolset.id),
            &toolset.title,
            true,
            toolset.default_visible,
            None::<&str>,
        )?;
        menu.append(&item)?;
    }

    Ok(menu)
}

fn ensure_toolset_window<R: Runtime>(
    app: &tauri::AppHandle<R>,
    toolset_id: &str,
) -> Result<(), String> {
    let Some(toolset) = toolset_definition(toolset_id) else {
        return Err(format!("Toolset {toolset_id} is not registered."));
    };
    let label = toolset_window_label(toolset_id);

    if let Some(window) = app.get_webview_window(&label) {
        window.show().map_err(|error| error.to_string())?;
        configure_toolset_utility_window(&window)?;
        return Ok(());
    }

    let size = toolset
        .preferred_window_size
        .clone()
        .unwrap_or(ToolsetWindowSize {
            width: 96.0,
            height: 420.0,
            min_width: Some(96.0),
            min_height: Some(240.0),
        });
    let position = preferred_toolset_position(app, toolset_id);

    let window = WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::App(format!("index.html?window=toolset&toolsetId={toolset_id}").into()),
    )
    .title(format!("ChemDraft {}", toolset.title))
    .inner_size(size.width, size.height)
    .min_inner_size(
        size.min_width.unwrap_or(size.width),
        size.min_height.unwrap_or(size.height),
    )
    .accept_first_mouse(true)
    .focusable(false)
    .resizable(false)
    .decorations(false)
    .shadow(false)
    .skip_taskbar(true)
    .position(position.x, position.y)
    .build()
    .map_err(|error| error.to_string())?;

    configure_toolset_utility_window(&window)?;
    Ok(())
}

fn restore_visible_toolset_windows<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let layout_state = load_toolset_layout_state(app);

    for toolset in toolset_manifest().toolsets {
        let visible = toolset_visible(&toolset, &layout_state);
        sync_toolset_window_from_layout(app, &toolset, visible)?;
    }

    Ok(())
}

fn sync_toolset_window_from_layout<R: Runtime>(
    app: &tauri::AppHandle<R>,
    toolset: &ToolsetDefinition,
    visible: bool,
) -> Result<(), String> {
    if visible && toolset.default_mode == "floating" {
        ensure_toolset_window(app, &toolset.id)?;
        let state = toolset_state(app, &toolset.id)?;
        persist_toolset_visibility(app, &toolset.id, state.open)?;
        set_toolset_menu_checked(app, &toolset.id, state.open)?;
        let _ = emit_toolset_window_state_to_main(app, &state);
        return Ok(());
    }

    set_toolset_menu_checked(app, &toolset.id, false)
}

#[cfg(target_os = "macos")]
fn configure_toolset_utility_window<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    let ns_window_ptr = window.ns_window().map_err(|error| error.to_string())? as *mut NSWindow;
    let Some(ns_window) = (unsafe { ns_window_ptr.as_ref() }) else {
        return Err("Could not access native ChemDraft toolbar window.".to_string());
    };

    let style = ns_window.styleMask()
        | NSWindowStyleMask::UtilityWindow
        | NSWindowStyleMask::NonactivatingPanel;
    ns_window.setStyleMask(style);
    ns_window.setLevel(NSFloatingWindowLevel);
    ns_window.setHidesOnDeactivate(true);
    ns_window.setCanHide(true);
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
    ns_window.orderFront(None);

    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn configure_toolset_utility_window<R: Runtime>(
    _window: &tauri::WebviewWindow<R>,
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

fn toolset_manifest() -> ToolsetManifest {
    serde_json::from_str(TOOLSET_MANIFEST_JSON)
        .expect("desktop toolset manifest should be valid JSON")
}

fn toolset_definition(toolset_id: &str) -> Option<ToolsetDefinition> {
    toolset_manifest()
        .toolsets
        .into_iter()
        .find(|toolset| toolset.id == toolset_id)
}

fn toolset_index(toolset_id: &str) -> Option<usize> {
    toolset_manifest()
        .toolsets
        .iter()
        .position(|toolset| toolset.id == toolset_id)
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

fn toolset_id_for_window_label(label: &str) -> Option<String> {
    toolset_manifest()
        .toolsets
        .into_iter()
        .find(|toolset| toolset_window_label(&toolset.id) == label)
        .map(|toolset| toolset.id)
}

fn toolset_toggle_command_id(toolset_id: &str) -> String {
    format!("{TOOLSET_TOGGLE_PREFIX}{toolset_id}")
}

fn is_routed_menu_command(command_id: &str) -> bool {
    MENU_COMMAND_IDS.contains(&command_id) || command_id.starts_with(TOOLSET_TOGGLE_PREFIX)
}

fn toolset_visible(toolset: &ToolsetDefinition, layout_state: &ToolsetLayoutState) -> bool {
    layout_state
        .toolsets
        .get(&toolset.id)
        .and_then(|state| state.visible)
        .unwrap_or(toolset.default_visible)
}

fn preferred_toolset_position<R: Runtime>(
    app: &tauri::AppHandle<R>,
    toolset_id: &str,
) -> ToolsetWindowPosition {
    persisted_toolset_position(app, toolset_id)
        .unwrap_or_else(|| default_toolset_position(toolset_id))
}

fn default_toolset_position(toolset_id: &str) -> ToolsetWindowPosition {
    let offset = toolset_index(toolset_id).unwrap_or(0) as f64 * 18.0;
    ToolsetWindowPosition {
        x: 88.0 + offset,
        y: 154.0 + offset,
    }
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

fn persist_toolset_visibility<R: Runtime>(
    app: &tauri::AppHandle<R>,
    toolset_id: &str,
    visible: bool,
) -> Result<(), String> {
    update_toolset_layout_state(app, |layout_state| {
        layout_state
            .toolsets
            .entry(toolset_id.to_string())
            .or_default()
            .visible = Some(visible);
    })
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
    persist_toolset_visibility(app, toolset_id, false)?;
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

fn set_toolset_menu_checked<R: Runtime>(
    app: &tauri::AppHandle<R>,
    toolset_id: &str,
    checked: bool,
) -> Result<(), String> {
    let command_id = toolset_toggle_command_id(toolset_id);
    set_check_menu_item_checked(app, &command_id, checked)
}

fn toggle_check_menu_item<R: Runtime>(
    app: &tauri::AppHandle<R>,
    command_id: &str,
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

    let checked = check_item.is_checked().map_err(|error| error.to_string())?;
    check_item
        .set_checked(!checked)
        .map_err(|error| error.to_string())
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

    fn toolset(id: &str, default_visible: bool) -> ToolsetDefinition {
        ToolsetDefinition {
            id: id.to_string(),
            title: "Fixture Toolbar".to_string(),
            default_visible,
            default_mode: "floating".to_string(),
            preferred_window_size: None,
        }
    }

    #[test]
    fn persisted_visibility_overrides_manifest_defaults() {
        let mut state = ToolsetLayoutState::default();
        state.toolsets.insert(
            "core.fixture".to_string(),
            PersistedToolsetState {
                visible: Some(false),
                ..PersistedToolsetState::default()
            },
        );

        expect_false(toolset_visible(&toolset("core.fixture", true), &state));
        expect_true(toolset_visible(&toolset("core.other", true), &state));
    }

    #[test]
    fn toolset_labels_round_trip_to_ids() {
        expect_eq("toolset-core-main", &toolset_window_label("core.main"));
        expect_eq(
            Some("core.main".to_string()),
            toolset_id_for_window_label("toolset-core-main"),
        );
        expect_eq(None, toolset_id_for_window_label("main"));
    }

    #[test]
    fn default_positions_are_staggered_by_manifest_order() {
        let main = default_toolset_position("core.main");
        let structure = default_toolset_position("core.structure");

        expect_eq(88.0, main.x);
        expect_eq(154.0, main.y);
        expect_true(structure.x > main.x);
        expect_true(structure.y > main.y);
    }

    #[test]
    fn retina_positions_are_persisted_as_logical_points() {
        let position = logical_toolset_position_from_physical(520.0, 380.0, 2.0);

        expect_eq(260.0, position.x);
        expect_eq(190.0, position.y);
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
