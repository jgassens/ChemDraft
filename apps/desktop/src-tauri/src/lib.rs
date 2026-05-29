use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const MAIN_WINDOW_LABEL: &str = "main";
const TOOL_PALETTE_LABEL: &str = "tool-palette";
const PALETTE_COMMAND_EVENT: &str = "chemdraft://palette-command";

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

    let main = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "Main document window is not available.".to_string())?;

    main.emit(
        PALETTE_COMMAND_EVENT,
        PaletteCommandPayload {
            command_id: command_id.trim().to_string(),
        },
    )
    .map_err(|error| error.to_string())
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
    .inner_size(104.0, 520.0)
    .min_inner_size(96.0, 420.0)
    .resizable(false)
    .decorations(false)
    .shadow(true)
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
