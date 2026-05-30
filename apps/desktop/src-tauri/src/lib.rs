use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder,
};

const MAIN_WINDOW_LABEL: &str = "main";
const TOOL_PALETTE_LABEL: &str = "tool-palette";
const PALETTE_COMMAND_EVENT: &str = "chemdraft://palette-command";
const MENU_COMMAND_IDS: &[&str] = &[
    "document.new",
    "document.open",
    "document.save",
    "export.svg",
    "export.png",
    "view.toggleToolPalette",
    "view.toggleRulers",
    "view.toggleCrosshairs",
    "chemistry.validateSelection",
];

#[derive(serde::Serialize)]
struct PaletteWindowState {
    open: bool,
    focused: bool,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PaletteCommandPayload {
    command_id: String,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .menu(create_app_menu)
        .on_menu_event(|app, event| {
            let command_id = event.id().as_ref();
            if MENU_COMMAND_IDS.contains(&command_id) {
                if let Err(error) = emit_command_to_main(app, command_id) {
                    eprintln!("Could not route ChemDraft menu command {command_id}: {error}");
                }
            }
        })
        .setup(|app| {
            if let Err(error) = ensure_tool_palette(app.handle()) {
                eprintln!("Could not open ChemDraft tool palette: {error}");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
fn open_tool_palette(app: tauri::AppHandle) -> Result<PaletteWindowState, String> {
    ensure_tool_palette(&app)?;
    palette_state(&app)
}

#[tauri::command]
fn close_tool_palette(app: tauri::AppHandle) -> Result<PaletteWindowState, String> {
    if let Some(window) = app.get_webview_window(TOOL_PALETTE_LABEL) {
        window.close().map_err(|error| error.to_string())?;
    }

    Ok(PaletteWindowState {
        open: false,
        focused: false,
    })
}

#[tauri::command]
fn focus_tool_palette(app: tauri::AppHandle) -> Result<PaletteWindowState, String> {
    ensure_tool_palette(&app)?;

    if let Some(window) = app.get_webview_window(TOOL_PALETTE_LABEL) {
        window.set_focus().map_err(|error| error.to_string())?;
    }

    palette_state(&app)
}

#[tauri::command]
fn toggle_tool_palette(app: tauri::AppHandle) -> Result<PaletteWindowState, String> {
    if app.get_webview_window(TOOL_PALETTE_LABEL).is_some() {
        return close_tool_palette(app);
    }

    open_tool_palette(app)
}

#[tauri::command]
fn tool_palette_state(app: tauri::AppHandle) -> Result<PaletteWindowState, String> {
    palette_state(&app)
}

#[tauri::command]
fn route_palette_command(app: tauri::AppHandle, command_id: String) -> Result<(), String> {
    if command_id.trim().is_empty() {
        return Err("Palette command id cannot be empty.".to_string());
    }

    emit_command_to_main(&app, command_id.trim())
}

fn emit_command_to_main<R: Runtime>(app: &tauri::AppHandle<R>, command_id: &str) -> Result<(), String> {
    let main = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "Main document window is not available.".to_string())?;

    main.emit(
        PALETTE_COMMAND_EVENT,
        PaletteCommandPayload {
            command_id: command_id.to_string(),
        },
    )
    .map_err(|error| error.to_string())
}

fn create_app_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
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
            &Submenu::with_items(
                app,
                "View",
                true,
                &[
                    &MenuItem::with_id(
                        app,
                        "view.toggleToolPalette",
                        "Tool Palette",
                        true,
                        Some("CmdOrCtrl+Option+T"),
                    )?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "view.toggleRulers", "Rulers", true, Some("CmdOrCtrl+R"))?,
                    &MenuItem::with_id(
                        app,
                        "view.toggleCrosshairs",
                        "Crosshairs",
                        true,
                        Some("CmdOrCtrl+Shift+R"),
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

fn ensure_tool_palette(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(TOOL_PALETTE_LABEL) {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    WebviewWindowBuilder::new(
        app,
        TOOL_PALETTE_LABEL,
        WebviewUrl::App("index.html?window=tool-palette".into()),
    )
    .title("ChemDraft Tools")
    .inner_size(96.0, 820.0)
    .min_inner_size(96.0, 560.0)
    .resizable(false)
    .decorations(false)
    .shadow(false)
    .always_on_top(false)
    .skip_taskbar(false)
    .position(88.0, 154.0)
    .build()
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn palette_state(app: &tauri::AppHandle) -> Result<PaletteWindowState, String> {
    match app.get_webview_window(TOOL_PALETTE_LABEL) {
        Some(window) => Ok(PaletteWindowState {
            open: true,
            focused: window.is_focused().unwrap_or(false),
        }),
        None => Ok(PaletteWindowState {
            open: false,
            focused: false,
        }),
    }
}
