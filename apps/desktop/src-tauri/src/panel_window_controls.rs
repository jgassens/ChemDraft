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

/// Hides a plugin panel on behalf of the document window (plugin disabled or uninstalled, panel
/// closed programmatically). Only the main window may call it, and only for panel labels.
pub(super) fn authorize_main_hide(caller: &str, target: &str) -> Result<(), String> {
    if caller != super::MAIN_WINDOW_LABEL {
        return Err("Only the document window may hide a panel on its behalf.".into());
    }
    if !super::is_plugin_panel_window_label(target) {
        return Err("Only a ChemDraft panel window can be hidden this way.".into());
    }
    Ok(())
}

#[tauri::command]
pub(super) async fn hide_plugin_panel_from_main(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    label: String,
) -> Result<(), String> {
    authorize_main_hide(window.label(), &label)?;
    // A panel that was never opened or is already gone has nothing to hide.
    let Some(target) = tauri::Manager::get_webview_window(&app, &label) else {
        return Ok(());
    };
    let task = target.clone();
    super::run_on_main_thread_blocking(&target, move || restore_then_hide(&task))?
}

fn restore_then_hide<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    ordered_restore_then_hide(
        || super::panel_full_size::before_hide(window),
        || window.hide().map_err(|error| error.to_string()),
    )
}

fn ordered_restore_then_hide(
    restore: impl FnOnce(),
    hide: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    restore();
    hide()
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

    #[test]
    fn only_the_document_window_may_hide_panels_for_it() {
        assert!(authorize_main_hide("main", "plugin-panel-v1x61x62").is_ok());
        for caller in [
            "plugin-panel-v1x61x62",
            "preferences",
            "toolset-core-main",
            "dialog-main-export",
            "",
        ] {
            assert!(
                authorize_main_hide(caller, "plugin-panel-v1x61x62").is_err(),
                "{caller}"
            );
        }
        for target in [
            "main",
            "preferences",
            "toolset-core-main",
            "plugin-panel-",
            "dialog-main-export",
            "",
        ] {
            assert!(authorize_main_hide("main", target).is_err(), "{target}");
        }
    }

    #[test]
    fn main_window_hide_restores_the_normal_frame_first() {
        let log = std::cell::RefCell::new(Vec::new());
        let result = ordered_restore_then_hide(
            || log.borrow_mut().push("restore"),
            || {
                log.borrow_mut().push("hide");
                Ok(())
            },
        );
        assert!(result.is_ok());
        assert_eq!(*log.borrow(), ["restore", "hide"]);
    }
}
