use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder,
};

const MAIN_WINDOW_LABEL: &str = "main";
const DEFAULT_TOOLSET_ID: &str = "core.main";
const TOOLSET_COMMAND_EVENT: &str = "chemdraft://palette-command";
const TOOLSET_TOGGLE_PREFIX: &str = "view.toolset.toggle.";
const TOOLSET_MANIFEST_JSON: &str = include_str!("../../src/toolsets/desktop-toolsets.json");
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolsetWindowState {
    toolset_id: String,
    open: bool,
    focused: bool,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolsetCommandPayload {
    command_id: String,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .menu(create_app_menu)
        .on_menu_event(|app, event| {
            let command_id = event.id().as_ref();
            if is_routed_menu_command(command_id) {
                if let Err(error) = emit_command_to_main(app, command_id) {
                    eprintln!("Could not route ChemDraft menu command {command_id}: {error}");
                }
            }
        })
        .setup(|app| {
            for toolset in toolset_manifest().toolsets {
                if toolset.default_visible && toolset.default_mode == "floating" {
                    if let Err(error) = ensure_toolset_window(app.handle(), &toolset.id) {
                        eprintln!("Could not open ChemDraft toolset {}: {error}", toolset.id);
                    }
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
fn open_toolset_window(app: tauri::AppHandle, toolset_id: String) -> Result<ToolsetWindowState, String> {
    ensure_toolset_window(&app, &toolset_id)?;
    toolset_state(&app, &toolset_id)
}

#[tauri::command]
fn close_toolset_window(app: tauri::AppHandle, toolset_id: String) -> Result<ToolsetWindowState, String> {
    if let Some(window) = app.get_webview_window(&toolset_window_label(&toolset_id)) {
        window.close().map_err(|error| error.to_string())?;
    }

    Ok(ToolsetWindowState {
        toolset_id,
        open: false,
        focused: false,
    })
}

#[tauri::command]
fn focus_toolset_window(app: tauri::AppHandle, toolset_id: String) -> Result<ToolsetWindowState, String> {
    ensure_toolset_window(&app, &toolset_id)?;

    if let Some(window) = app.get_webview_window(&toolset_window_label(&toolset_id)) {
        window.set_focus().map_err(|error| error.to_string())?;
    }

    toolset_state(&app, &toolset_id)
}

#[tauri::command]
fn toggle_toolset_window(app: tauri::AppHandle, toolset_id: String) -> Result<ToolsetWindowState, String> {
    if app.get_webview_window(&toolset_window_label(&toolset_id)).is_some() {
        return close_toolset_window(app, toolset_id);
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

fn emit_command_to_main<R: Runtime>(app: &tauri::AppHandle<R>, command_id: &str) -> Result<(), String> {
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
            toolset.title,
            true,
            toolset.default_visible,
            None::<&str>,
        )?;
        menu.append(&item)?;
    }

    Ok(menu)
}

fn ensure_toolset_window(app: &tauri::AppHandle, toolset_id: &str) -> Result<(), String> {
    let Some(toolset) = toolset_definition(toolset_id) else {
        return Err(format!("Toolset {toolset_id} is not registered."));
    };
    let label = toolset_window_label(toolset_id);

    if let Some(window) = app.get_webview_window(&label) {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let size = toolset.preferred_window_size.unwrap_or(ToolsetWindowSize {
        width: 96.0,
        height: 420.0,
        min_width: Some(96.0),
        min_height: Some(240.0),
    });
    let offset = toolset_index(toolset_id).unwrap_or(0) as f64 * 18.0;

    WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::App(format!("index.html?window=toolset&toolsetId={toolset_id}").into()),
    )
    .title(format!("ChemDraft {}", toolset.title))
    .inner_size(size.width, size.height)
    .min_inner_size(size.min_width.unwrap_or(size.width), size.min_height.unwrap_or(size.height))
    .resizable(false)
    .decorations(false)
    .shadow(false)
    .always_on_top(false)
    .skip_taskbar(false)
    .position(88.0 + offset, 154.0 + offset)
    .build()
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn toolset_state(app: &tauri::AppHandle, toolset_id: &str) -> Result<ToolsetWindowState, String> {
    match app.get_webview_window(&toolset_window_label(toolset_id)) {
        Some(window) => Ok(ToolsetWindowState {
            toolset_id: toolset_id.to_string(),
            open: true,
            focused: window.is_focused().unwrap_or(false),
        }),
        None => Ok(ToolsetWindowState {
            toolset_id: toolset_id.to_string(),
            open: false,
            focused: false,
        }),
    }
}

fn toolset_manifest() -> ToolsetManifest {
    serde_json::from_str(TOOLSET_MANIFEST_JSON).expect("desktop toolset manifest should be valid JSON")
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

fn toolset_toggle_command_id(toolset_id: &str) -> String {
    format!("{TOOLSET_TOGGLE_PREFIX}{toolset_id}")
}

fn is_routed_menu_command(command_id: &str) -> bool {
    MENU_COMMAND_IDS.contains(&command_id) || command_id.starts_with(TOOLSET_TOGGLE_PREFIX)
}
