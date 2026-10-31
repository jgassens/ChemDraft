use tauri::Runtime;

pub(super) fn authorize(label: &str) -> Result<(), String> {
    if super::is_plugin_panel_window_label(label) {
        Ok(())
    } else {
        Err("Only a ChemDraft panel window may control its window.".into())
    }
}

#[tauri::command]
pub(super) async fn hide_plugin_panel_window(window: tauri::WebviewWindow) -> Result<(), String> {
    authorize(window.label())?;
    let target = window.clone();
    super::run_on_main_thread_blocking(&window, move || {
        let webview: &tauri::Webview = target.as_ref();
        hide(&webview.window())
    })?
}

fn hide<R: Runtime>(window: &tauri::Window<R>) -> Result<(), String> {
    // Retain the existing close order: restore the normal frame before hiding the live webview.
    super::panel_full_size::set(window, false, 0.0, 0.0)?;
    window.hide().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_panel_callers_can_hide_their_own_window() {
        for label in [
            "main",
            "preferences",
            "toolset-core-main",
            "plugin-panel-",
            "dialog-main-export",
        ] {
            assert!(authorize(label).is_err(), "{label}");
        }
        assert!(authorize("plugin-panel-v1x61x62").is_ok());
    }
}
