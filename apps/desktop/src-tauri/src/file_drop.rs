//! Files dropped from the system file manager onto the document window.
//!
//! Tauri emits `tauri://drag-drop` with wry's position, which on macOS is not the page's client
//! point. Tauri's title bar style `Visible` turns on a full-size content view, so the WKWebView's
//! frame extends under the title bar and WebKit insets the page by the obscured part
//! (`contentLayoutRect`). wry 0.55 reports `y = webview frame height - draggingLocation.y`: measured
//! from the top of the frame, title bar included, while CSS client coordinates start below the
//! inset. Every drop landed about one title bar below the pointer.
//!
//! The document window therefore never sees Tauri's event. Each drop is measured here while its
//! window event is handled (on the main thread, after tauri-plugin-fs has added the paths to its
//! scope, which it does on `RunEvent::WindowEvent` before window listeners run), then queued whole
//! for the page to drain (`file_drop_queue.rs`), so a drop made before the page listens is kept. On
//! macOS the position is corrected by the live inset read from the window at that moment; elsewhere
//! it is passed on as wry reports it:
//!
//! - Windows: `ScreenToClient` on the webview's container window, a child placed at the top-left of
//!   the frame's client area; the window menu is in the non-client area (`SetMenu`), so physical
//!   pixels relative to the page. The window's scale factor is read at the same moment and travels
//!   with the drop, so a drop drained after the window moved to a display with another scale still
//!   lands where it was dropped; the web side divides by it.
//! - Linux: GTK drag coordinates relative to the WebKitWebView widget, which sits below any menu bar
//!   in its own box; a client-side header bar is the window's title bar, outside the widget. These
//!   are logical pixels, CSS pixels at the default zoom.

use serde::Serialize;
use std::path::PathBuf;

/// How the payload's position is measured, relative to the page's top-left corner.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DropPositionUnits {
    /// CSS pixels (points on macOS, logical pixels on Linux): used as is.
    Css,
    /// Physical pixels (Windows): divided by the webview's device pixel ratio.
    Physical,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub(crate) struct DropPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentFileDropPayload {
    pub paths: Vec<PathBuf>,
    pub position: DropPoint,
    pub units: DropPositionUnits,
    /// The title-bar inset, in CSS pixels, already taken off `position.y` here (0 where none
    /// applies). The correction is made once, in Rust: the web side never applies another.
    pub top_inset_removed: f64,
    /// The window's scale factor (physical pixels per CSS pixel) when the drop happened, `None` when
    /// it could not be read. A `physical` position is divided by this, not by the scale the window
    /// has when the page drains the drop.
    pub scale_factor: Option<f64>,
}

/// A rectangle in AppKit window coordinates: points, origin at the window's bottom-left.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct WindowRect {
    pub y: f64,
    pub height: f64,
}

impl WindowRect {
    fn top(self) -> f64 {
        self.y + self.height
    }
}

/// The macOS geometry read at drop time, all in points.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct MacDropGeometry {
    /// The webview's frame height, which wry measured its `y` against.
    pub webview_frame_height: f64,
    /// The webview's bounds in window coordinates.
    pub webview_in_window: WindowRect,
    /// `NSWindow.contentLayoutRect`: the part of the window no title bar or toolbar covers.
    pub content_layout: WindowRect,
    /// Whether WebKit insets the page: a full-size content view under an opaque title bar.
    pub automatic_inset: bool,
}

/// The top inset WebKit gives the page: the part of the webview above the content layout rect, when
/// the content view is full size and the title bar is not transparent (WebKit's own rule for
/// `automaticallyAdjustsContentInsets`), else none.
pub(crate) fn mac_top_inset(geometry: &MacDropGeometry) -> f64 {
    if !geometry.automatic_inset {
        return 0.0;
    }
    let inset = geometry.webview_in_window.top() - geometry.content_layout.top();
    if inset.is_finite() {
        inset.max(0.0)
    } else {
        0.0
    }
}

/// wry's macOS `y` turned into the page's client `y`, and the inset taken off it. wry measured from
/// the top of a frame starting at the window's bottom edge; this undoes that, measures from the
/// webview's actual top edge, then removes the inset.
pub(crate) fn mac_client_y(wry_y: f64, geometry: &MacDropGeometry) -> (f64, f64) {
    let pointer_in_window = geometry.webview_frame_height - wry_y;
    let below_webview_top = geometry.webview_in_window.top() - pointer_in_window;
    let inset = mac_top_inset(geometry);
    (below_webview_top - inset, inset)
}

/// The payload for one drop. `mac` is the geometry read at drop time (macOS only; `None` leaves the
/// position as reported, as when the window could not be read); `scale_factor` the window's scale
/// at drop time.
pub(crate) fn document_drop_payload(
    paths: Vec<PathBuf>,
    position: (f64, f64),
    units: DropPositionUnits,
    mac: Option<&MacDropGeometry>,
    scale_factor: Option<f64>,
) -> DocumentFileDropPayload {
    let (x, wry_y) = position;
    let (y, top_inset_removed) = match mac {
        Some(geometry) => mac_client_y(wry_y, geometry),
        None => (wry_y, 0.0),
    };
    DocumentFileDropPayload {
        paths,
        position: DropPoint { x, y },
        units,
        top_inset_removed,
        scale_factor: scale_factor.filter(|scale| scale.is_finite() && *scale > 0.0),
    }
}

/// Measures a drop on the document window and queues it for its page. Called from the Builder's
/// window-event handler, which sees each drop once (the document webview is the window's content,
/// so Tauri delivers its drop as a window event only).
pub(crate) fn queue_document_drop<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    paths: &[PathBuf],
    position: tauri::PhysicalPosition<f64>,
) {
    // Windows reports physical pixels; macOS (points, corrected below) and Linux CSS pixels.
    let units = if cfg!(windows) {
        DropPositionUnits::Physical
    } else {
        DropPositionUnits::Css
    };
    #[cfg(target_os = "macos")]
    let geometry = match mac_drop_geometry(window) {
        Ok(geometry) => Some(geometry),
        Err(error) => {
            eprintln!("Could not read the document window for a file drop: {error}");
            None
        }
    };
    #[cfg(not(target_os = "macos"))]
    let geometry: Option<MacDropGeometry> = None;
    // Read now, with the position: by the time the page drains the drop the window may be on
    // another display.
    let scale_factor = match window.scale_factor() {
        Ok(scale) => Some(scale),
        Err(error) => {
            eprintln!("Could not read the document window's scale for a file drop: {error}");
            None
        }
    };
    let payload = document_drop_payload(
        paths.to_vec(),
        (position.x, position.y),
        units,
        geometry.as_ref(),
        scale_factor,
    );
    crate::file_drop_queue::record_document_drop(window, payload);
}

/// The window's live geometry: whatever the title bar is now (none in full screen, taller with a tab
/// bar), after any resize or move to another display.
#[cfg(target_os = "macos")]
fn mac_drop_geometry<R: tauri::Runtime>(
    window: &tauri::Window<R>,
) -> Result<MacDropGeometry, String> {
    use objc2::{ClassType, MainThreadMarker};
    use objc2_app_kit::{NSView, NSWindow, NSWindowStyleMask};
    use objc2_foundation::NSObjectProtocol;
    use objc2_web_kit::WKWebView;

    MainThreadMarker::new().ok_or("A file drop is handled on the main thread.")?;
    let pointer = window.ns_window().map_err(|error| error.to_string())? as *mut NSWindow;
    // SAFETY: this live Tauri window owns the NSWindow and we are on the main thread.
    let native = unsafe { pointer.as_ref() }.ok_or("Could not access the document window.")?;
    let content = native
        .contentView()
        .ok_or("The document window has no content view.")?;
    // wry puts the WKWebView inside its own content view; the content view stands in if it is gone.
    let webview = content
        .subviews()
        .iter()
        .find(|view| view.isKindOfClass(WKWebView::class()));
    let view: &NSView = webview.as_deref().unwrap_or(&content);
    let in_window = view.convertRect_toView(view.bounds(), None);
    let layout = native.contentLayoutRect();
    Ok(MacDropGeometry {
        webview_frame_height: view.frame().size.height,
        webview_in_window: WindowRect {
            y: in_window.origin.y,
            height: in_window.size.height,
        },
        content_layout: WindowRect {
            y: layout.origin.y,
            height: layout.size.height,
        },
        automatic_inset: native
            .styleMask()
            .contains(NSWindowStyleMask::FullSizeContentView)
            && !native.titlebarAppearsTransparent(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 800-point-tall window whose webview fills a full-size content view under a 28-point title
    /// bar: wry's `y` is measured from the window top, the page starts 28 points lower.
    fn titled(height: f64, title_bar: f64) -> MacDropGeometry {
        MacDropGeometry {
            webview_frame_height: height,
            webview_in_window: WindowRect { y: 0.0, height },
            content_layout: WindowRect {
                y: 0.0,
                height: height - title_bar,
            },
            automatic_inset: true,
        }
    }

    #[test]
    fn full_size_content_view_under_a_title_bar_removes_the_live_inset() {
        assert_eq!(mac_client_y(128.0, &titled(800.0, 28.0)), (100.0, 28.0));
        // A tab bar makes the title area taller; the inset follows it.
        assert_eq!(mac_client_y(160.0, &titled(800.0, 60.0)), (100.0, 60.0));
    }

    #[test]
    fn full_screen_has_no_inset() {
        assert_eq!(mac_client_y(100.0, &titled(900.0, 0.0)), (100.0, 0.0));
    }

    #[test]
    fn a_content_view_below_the_title_bar_is_left_alone() {
        // Without a full-size content view the webview's frame is the page: wry is already right.
        let geometry = MacDropGeometry {
            webview_frame_height: 772.0,
            webview_in_window: WindowRect {
                y: 0.0,
                height: 772.0,
            },
            content_layout: WindowRect {
                y: 0.0,
                height: 772.0,
            },
            automatic_inset: false,
        };
        assert_eq!(mac_client_y(100.0, &geometry), (100.0, 0.0));
        // A transparent title bar or a non-full-size window: WebKit does not inset, nor do we.
        assert_eq!(
            mac_client_y(
                128.0,
                &MacDropGeometry {
                    automatic_inset: false,
                    ..titled(800.0, 28.0)
                }
            ),
            (128.0, 0.0)
        );
    }

    #[test]
    fn a_webview_smaller_than_the_content_measures_from_its_own_top() {
        // The webview starts 50 points above the window's bottom and stops 100 points below its
        // top, clear of the 28-point title bar: no inset, and wry's frame-based y is shifted.
        let geometry = MacDropGeometry {
            webview_frame_height: 650.0,
            webview_in_window: WindowRect {
                y: 50.0,
                height: 650.0,
            },
            content_layout: WindowRect {
                y: 0.0,
                height: 772.0,
            },
            automatic_inset: true,
        };
        // The pointer 200 points below the window top: wry reports 650 - (800 - 200) = 50.
        assert_eq!(mac_client_y(50.0, &geometry), (100.0, 0.0));
    }

    #[test]
    fn a_webview_larger_than_the_content_removes_only_its_covered_part() {
        // The webview reaches 10 points above the window's top edge (inside a taller frame).
        let geometry = MacDropGeometry {
            webview_frame_height: 810.0,
            webview_in_window: WindowRect {
                y: 0.0,
                height: 810.0,
            },
            content_layout: WindowRect {
                y: 0.0,
                height: 772.0,
            },
            automatic_inset: true,
        };
        // The pointer 128 points below the window top: wry reports 810 - (800 - 128) = 138.
        assert_eq!(mac_client_y(138.0, &geometry), (100.0, 38.0));
    }

    #[test]
    fn the_payload_carries_units_and_states_the_inset_it_removed() {
        let paths = vec![PathBuf::from("/Users/me/mol.png")];
        let mac = document_drop_payload(
            paths.clone(),
            (40.0, 128.0),
            DropPositionUnits::Css,
            Some(&titled(800.0, 28.0)),
            Some(2.0),
        );
        assert_eq!(mac.position, DropPoint { x: 40.0, y: 100.0 });
        assert_eq!(mac.top_inset_removed, 28.0);
        let windows = document_drop_payload(
            paths.clone(),
            (80.0, 256.0),
            DropPositionUnits::Physical,
            None,
            Some(1.5),
        );
        assert_eq!(windows.position, DropPoint { x: 80.0, y: 256.0 });
        assert_eq!(windows.top_inset_removed, 0.0);
        let json = serde_json::to_value(&windows).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "paths": ["/Users/me/mol.png"], "position": { "x": 80.0, "y": 256.0 },
                "units": "physical", "topInsetRemoved": 0.0, "scaleFactor": 1.5
            })
        );
        let linux = document_drop_payload(paths, (3.0, 4.0), DropPositionUnits::Css, None, None);
        let linux = serde_json::to_value(&linux).unwrap();
        assert_eq!(linux["units"], "css");
        // An unread scale is sent as null: the web side falls back to its own ratio.
        assert_eq!(linux["scaleFactor"], serde_json::Value::Null);
    }

    #[test]
    fn a_scale_that_is_not_a_positive_number_is_not_sent() {
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            let payload = document_drop_payload(
                vec![PathBuf::from("C:\\mol.png")],
                (1.0, 2.0),
                DropPositionUnits::Physical,
                None,
                Some(scale),
            );
            assert_eq!(payload.scale_factor, None, "{scale}");
        }
    }

    #[test]
    fn a_non_finite_geometry_never_moves_the_point() {
        let geometry = MacDropGeometry {
            content_layout: WindowRect {
                y: f64::NAN,
                height: 0.0,
            },
            ..titled(800.0, 28.0)
        };
        assert_eq!(mac_top_inset(&geometry), 0.0);
    }

    /// Source text with every run of whitespace (line endings included) made one space, so the
    /// wiring checks below read the same on every host and checkout.
    fn squashed(source: &str) -> String {
        source.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    /// The Builder's window-event handler: everything between `.on_window_event(` and `.setup(`.
    fn window_event_handler(lib: &str) -> &str {
        lib.split(".on_window_event(|window, event| {")
            .nth(1)
            .expect("the Builder's window-event handler")
            .split(" .setup(move |app| {")
            .next()
            .unwrap()
    }

    const DROP_ARM: &str = "WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, position }) => { file_drop::queue_document_drop(window, paths, *position); }";

    #[test]
    fn the_document_window_alone_queues_each_drop_through_queue_document_drop() {
        let lib = squashed(include_str!("lib.rs"));
        let handler = window_event_handler(&lib);
        assert_eq!(
            handler.matches(DROP_ARM).count(),
            1,
            "one DragDrop Drop arm"
        );
        // Nothing else in the app queues a drop, so a drop reaches the page once.
        assert_eq!(lib.matches("file_drop::queue_document_drop(").count(), 1);
        assert_eq!(
            squashed(include_str!("file_drop.rs"))
                .split("#[cfg(test)]")
                .next()
                .unwrap()
                .matches("crate::file_drop_queue::record_document_drop(window, payload);")
                .count(),
            1
        );
        // The arm is inside the document window's branch, which returns before any other window's.
        let main_start = handler
            .find("if window.label() == MAIN_WINDOW_LABEL {")
            .expect("the document window's branch");
        let main_end = main_start
            + handler[main_start..]
                .find("_ => {} } return; }")
                .expect("the end of the document window's branch");
        let arm = handler.find(DROP_ARM).unwrap();
        assert!(main_start < arm && arm < main_end);
        assert_eq!(super::super::MAIN_WINDOW_LABEL, "main");
        // The geometry check ahead of the match takes only moves and resizes, never a drop.
        let drop = tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop {
            paths: vec![PathBuf::from("mol.png")],
            position: tauri::PhysicalPosition::new(1.0, 2.0),
        });
        assert!(!super::super::on_main_window_geometry_event_with(
            &super::super::QUIT,
            &drop,
            || panic!("a drop is not a geometry change")
        ));
        assert!(handler[main_start..arm]
            .contains("if on_main_window_geometry_event_with(&QUIT, event, || {"));
    }

    #[test]
    fn file_drop_reads_the_mac_geometry_live_at_each_drop() {
        let source = squashed(include_str!("file_drop.rs"));
        let emit = source
            .split("pub(crate) fn queue_document_drop<R: tauri::Runtime>(")
            .nth(1)
            .unwrap()
            .split("fn mac_drop_geometry<R: tauri::Runtime>(")
            .next()
            .unwrap();
        assert!(emit.contains(
            "#[cfg(target_os = \"macos\")] let geometry = match mac_drop_geometry(window) {"
        ));
        assert!(emit.contains(
            "#[cfg(not(target_os = \"macos\"))] let geometry: Option<MacDropGeometry> = None;"
        ));
        assert!(emit.contains("geometry.as_ref(), scale_factor,"));
        assert!(emit.contains("let units = if cfg!(windows) { DropPositionUnits::Physical } else { DropPositionUnits::Css };"));
        // The scale is read at the drop, beside the position, never when the page drains it.
        assert!(emit.contains("let scale_factor = match window.scale_factor() {"));
        assert!(emit.contains("crate::file_drop_queue::record_document_drop(window, payload);"));
        assert!(!emit.contains("emit_to("));
        // Read from the window each time, never kept: the title bar changes with full screen and tabs.
        let read = source
            .split("fn mac_drop_geometry<R: tauri::Runtime>(")
            .nth(1)
            .unwrap()
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        for live in [
            "window.ns_window()",
            "native.contentLayoutRect()",
            "native .styleMask()",
            "native.titlebarAppearsTransparent()",
        ] {
            assert!(
                read.contains(live),
                "mac_drop_geometry no longer reads {live}"
            );
        }
        let code = source.split("#[cfg(test)]").next().unwrap();
        for cache in ["static ", "OnceLock", "LazyLock", "thread_local!"] {
            assert!(!code.contains(cache), "file_drop.rs keeps state: {cache}");
        }
    }

    /// The inset rule (`automatic_inset`) assumes the document window's own title bar: no
    /// `titleBarStyle`, hidden title or transparent window from its config or its builder.
    #[test]
    fn file_drop_document_window_keeps_its_standard_title_bar() {
        for (name, config) in [
            ("tauri.conf.json", include_str!("../tauri.conf.json")),
            (
                "tauri.intel.conf.json",
                include_str!("../tauri.intel.conf.json"),
            ),
            (
                "tauri.windows.conf.json",
                include_str!("../tauri.windows.conf.json"),
            ),
            (
                "tauri.allusers.conf.json",
                include_str!("../tauri.allusers.conf.json"),
            ),
        ] {
            let config: serde_json::Value = serde_json::from_str(config).unwrap();
            let windows = config["app"]["windows"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            for window in windows {
                for key in ["titleBarStyle", "hiddenTitle", "transparent", "decorations"] {
                    assert!(window.get(key).is_none(), "{name}: a window sets {key}");
                }
            }
        }
        let lib = squashed(include_str!("lib.rs"));
        let create = lib
            .split("fn create_main_window<R: Runtime>(")
            .nth(1)
            .unwrap()
            .split(" fn ")
            .next()
            .unwrap();
        assert!(create.contains("WebviewWindowBuilder::from_config(app, config)"));
        for style in [
            "title_bar_style",
            "hidden_title",
            "transparent",
            "decorations",
        ] {
            assert!(!create.contains(style), "create_main_window sets {style}");
        }
        // The one title-bar style in lib.rs is the dialogs' own, and nothing restyles a live window.
        assert_eq!(
            lib.matches(".title_bar_style(").count(),
            lib.matches(".title_bar_style(dialog_windows::macos_dialog_title_bar_style())")
                .count()
        );
        assert!(!lib.contains("set_title_bar_style("));
        assert!(!lib.contains("setTitlebarAppearsTransparent"));
    }
}
