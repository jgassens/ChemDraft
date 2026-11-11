//! Read-only geometry for placing inserts around ChemDraft's document-owned dialogs and panels.

use serde::Serialize;
use tauri::Manager;

#[derive(Clone, Copy, Debug, Serialize)]
pub(crate) struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CanvasOcclusion {
    document_frame: Rect,
    webview_offset: (f64, f64),
    screen_units_per_css_pixel: f64,
    covering_rects: Vec<Rect>,
}

fn authorize(label: &str) -> Result<(), String> {
    if super::is_document_window(label) {
        Ok(())
    } else {
        Err("Only the document window can read canvas occlusion geometry".into())
    }
}

fn covers_canvas(label: &str, visible: bool, minimized: bool) -> bool {
    visible
        && !minimized
        && (super::dialog_windows::is_dialog_label(label)
            || super::is_plugin_panel_window_label(label))
}

// Tao's macOS physical coordinates are desktop points multiplied by EACH window's backing
// scale. Divide each frame by its own scale to recover a common desktop point space. Windows
// uses one physical desktop coordinate space already: dividing global positions there breaks
// mixed-DPI overlap detection. CSS-local conversion uses the DOCUMENT's scale in either case.
fn screen_unit_scale(macos: bool, backing_scale: f64) -> f64 {
    if macos {
        backing_scale
    } else {
        1.0
    }
}

#[tauri::command]
pub(crate) fn document_canvas_occlusion(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<CanvasOcclusion, String> {
    authorize(window.label())?;
    let read_error =
        |error: tauri::Error| format!("Could not read canvas window geometry: {error}");
    let scale = window.scale_factor().map_err(read_error)?;
    let unit = screen_unit_scale(cfg!(target_os = "macos"), scale);
    let outer = window.outer_position().map_err(read_error)?;
    let inner = window.inner_position().map_err(read_error)?;
    let size = window.outer_size().map_err(read_error)?;
    let mut covering_rects = Vec::new();
    for candidate in app.webview_windows().into_values() {
        if !covers_canvas(
            candidate.label(),
            candidate.is_visible().unwrap_or(false),
            candidate.is_minimized().unwrap_or(true),
        ) {
            continue;
        }
        // A utility can close between enumeration and sampling; it no longer covers the page.
        let (Ok(position), Ok(size), Ok(scale)) = (
            candidate.outer_position(),
            candidate.outer_size(),
            candidate.scale_factor(),
        ) else {
            continue;
        };
        let unit = screen_unit_scale(cfg!(target_os = "macos"), scale);
        covering_rects.push(Rect {
            x: f64::from(position.x) / unit,
            y: f64::from(position.y) / unit,
            width: f64::from(size.width) / unit,
            height: f64::from(size.height) / unit,
        });
    }
    Ok(CanvasOcclusion {
        document_frame: Rect {
            x: f64::from(outer.x) / unit,
            y: f64::from(outer.y) / unit,
            width: f64::from(size.width) / unit,
            height: f64::from(size.height) / unit,
        },
        webview_offset: (
            (f64::from(inner.x) - f64::from(outer.x)) / unit,
            (f64::from(inner.y) - f64::from(outer.y)) / unit,
        ),
        screen_units_per_css_pixel: scale / unit,
        covering_rects,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_main_can_read_and_only_visible_dialogs_and_panels_cover() {
        assert!(authorize("main").is_ok());
        for label in [
            "preferences",
            "dialog-main-structureTemplates-0",
            "plugin-panel-proposals",
        ] {
            assert!(authorize(label).is_err());
            assert!(covers_canvas(label, true, false));
            assert!(!covers_canvas(label, false, false));
            assert!(!covers_canvas(label, true, true));
        }
        for label in [
            "main",
            "toolset-core-main",
            "toolset-tooltip",
            "dialog-main-forged-0",
        ] {
            assert!(!covers_canvas(label, true, false));
        }
    }

    #[test]
    fn mixed_dpi_frames_share_one_desktop_space_on_both_platforms() {
        // The same desktop point (1100) reported from two differently scaled windows.
        for scale in [1.0, 1.5, 2.0] {
            assert_eq!(1100.0 * scale / screen_unit_scale(true, scale), 1100.0);
            assert_eq!(2200.0 / screen_unit_scale(false, scale), 2200.0);
            assert_eq!(scale / screen_unit_scale(true, scale), 1.0);
            assert_eq!(scale / screen_unit_scale(false, scale), scale);
        }
    }

    #[test]
    fn geometry_capability_is_main_only() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/canvas-occlusion.json")).unwrap();
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        assert_eq!(
            capability["permissions"],
            serde_json::json!(["allow-document-canvas-occlusion"])
        );
    }
}
