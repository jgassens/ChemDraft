//! Native state read during move/resize, before tao's cached maximized state may have caught up.

use super::MainWindowGeometry;

/// Collect setup errors without allowing them to skip reveal or focus.
#[derive(Default)]
pub(super) struct SetupErrors(Vec<String>);

impl SetupErrors {
    pub(super) fn record<T, E: std::fmt::Display>(
        &mut self,
        step: &str,
        result: Result<T, E>,
    ) -> Option<T> {
        match result {
            Ok(value) => Some(value),
            Err(error) => {
                self.0.push(format!("{step}: {error}"));
                None
            }
        }
    }

    fn finish(self) -> Result<(), String> {
        if self.0.is_empty() {
            Ok(())
        } else {
            Err(self.0.join("; "))
        }
    }
}

pub(super) fn reveal_after_preparation(
    prepare: impl FnOnce(&mut SetupErrors) -> bool,
    show: impl FnOnce(bool) -> Result<(), String>,
    focus: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let mut errors = SetupErrors::default();
    let maximized = prepare(&mut errors);
    errors.record("show", show(maximized));
    errors.record("focus", focus());
    errors.finish()
}

#[derive(Default)]
pub(super) struct Snapshot {
    pub fullscreen: bool,
    pub minimized: bool,
    pub maximized: Option<bool>,
    pub normal_frame: Option<MainWindowGeometry>,
}

/// Reveal only after the normal placement is final. Unlike tao's maximize() on a hidden window,
/// SW_SHOWMAXIMIZED never re-hides it. Then synchronize tao's visibility flag without hiding or
/// changing the placed frame; later Tauri flag updates and focus require that cached flag.
#[cfg(windows)]
pub(super) fn show<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    maximized: bool,
) -> Result<(), String> {
    let mut errors = SetupErrors::default();
    if maximized {
        use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWMAXIMIZED};
        if let Some(hwnd) = errors.record("get native handle", window.hwnd()) {
            // SAFETY: the handle belongs to this live window. ShowWindow returns prior visibility,
            // not a success flag (zero is expected here, since the window is hidden).
            unsafe {
                ShowWindow(hwnd.0 as _, SW_SHOWMAXIMIZED);
            }
        }
    }
    errors.record("show", window.show());
    errors.finish()
}

#[cfg(not(windows))]
pub(super) fn show<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    maximized: bool,
) -> Result<(), String> {
    let mut errors = SetupErrors::default();
    // AppKit zoom changes a hidden frame without ordering the window onto the screen.
    if maximized {
        errors.record("maximize", window.maximize());
    }
    errors.record("show", window.show());
    errors.finish()
}

#[cfg(target_os = "macos")]
pub(super) fn snapshot<R: tauri::Runtime>(window: &tauri::Window<R>) -> Result<Snapshot, String> {
    use objc2_app_kit::{NSWindow, NSWindowStyleMask};

    objc2::MainThreadMarker::new()
        .ok_or_else(|| "Main window placement must be read on the main thread.".to_string())?;
    let pointer = window.ns_window().map_err(|error| error.to_string())? as *mut NSWindow;
    // SAFETY: the live Tauri window owns this NSWindow and move/resize runs on the main thread.
    let native = unsafe { pointer.as_ref() }
        .ok_or_else(|| "Could not access the native ChemDraft main window.".to_string())?;
    Ok(Snapshot {
        fullscreen: native.styleMask().contains(NSWindowStyleMask::FullScreen),
        minimized: native.isMiniaturized(),
        maximized: Some(native.isZoomed()),
        normal_frame: None,
    })
}

#[cfg(windows)]
pub(super) fn snapshot<R: tauri::Runtime>(window: &tauri::Window<R>) -> Result<Snapshot, String> {
    use windows_sys::Win32::{
        Foundation::RECT,
        Graphics::Gdi::{
            GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
        },
        UI::{
            HiDpi::{AdjustWindowRectExForDpi, GetDpiForWindow},
            WindowsAndMessaging::{
                GetMenu, GetWindowLongW, GetWindowPlacement, IsIconic, IsZoomed, GWL_EXSTYLE,
                GWL_STYLE, SW_SHOWMAXIMIZED, WINDOWPLACEMENT, WS_EX_TOOLWINDOW,
            },
        },
    };

    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as _;
    let mut placement = WINDOWPLACEMENT {
        length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
        ..Default::default()
    };
    // SAFETY: hwnd belongs to the live Tauri window; all output structs are initialized and sized.
    unsafe {
        if GetWindowPlacement(hwnd, &mut placement) == 0 {
            return Err(format!(
                "GetWindowPlacement failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        let maximized = placement.showCmd == SW_SHOWMAXIMIZED as u32 || IsZoomed(hwnd) != 0;
        let minimized = IsIconic(hwnd) != 0;
        let rect = placement.rcNormalPosition;
        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        // rcNormalPosition uses workspace coordinates for ordinary top-level windows, but screen
        // coordinates for tool windows. Add only the work-area inset, NOT the monitor's origin.
        // This covers taskbars on top/left as well as negative monitor origins.
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mut info) == 0 {
            return Err(format!(
                "GetMonitorInfoW failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        let work_offset = if ex_style & WS_EX_TOOLWINDOW == 0 {
            (
                info.rcWork.left - info.rcMonitor.left,
                info.rcWork.top - info.rcMonitor.top,
            )
        } else {
            (0, 0)
        };
        // The persisted contract is outer position + INNER size. Derive the normal decoration
        // thickness at this window's DPI; the live maximized borders are different and cannot be
        // subtracted from rcNormalPosition. Include the document's native menu.
        let mut decorations = RECT::default();
        if AdjustWindowRectExForDpi(
            &mut decorations,
            GetWindowLongW(hwnd, GWL_STYLE) as u32,
            (!GetMenu(hwnd).is_null()) as i32,
            ex_style,
            GetDpiForWindow(hwnd),
        ) == 0
        {
            return Err(format!(
                "AdjustWindowRectExForDpi failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        let normal_frame = normal_frame_from_workspace(
            (rect.left, rect.top, rect.right, rect.bottom),
            work_offset,
            (
                decorations.right - decorations.left,
                decorations.bottom - decorations.top,
            ),
            window.scale_factor().map_err(|error| error.to_string())?,
        )
        .ok_or_else(|| "GetWindowPlacement returned an invalid normal frame.".to_string())?;
        Ok(Snapshot {
            minimized,
            maximized: Some(maximized),
            normal_frame: Some(normal_frame),
            ..Default::default()
        })
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
pub(super) fn snapshot<R: tauri::Runtime>(_window: &tauri::Window<R>) -> Result<Snapshot, String> {
    Ok(Snapshot::default())
}

#[cfg(any(windows, test))]
fn normal_frame_from_workspace(
    rect: (i32, i32, i32, i32),
    work_offset: (i32, i32),
    decorations: (i32, i32),
    scale: f64,
) -> Option<MainWindowGeometry> {
    let width = f64::from(rect.2) - f64::from(rect.0) - f64::from(decorations.0);
    let height = f64::from(rect.3) - f64::from(rect.1) - f64::from(decorations.1);
    if !scale.is_finite() || scale <= 0.0 || width <= 0.0 || height <= 0.0 {
        return None;
    }
    Some(MainWindowGeometry {
        x: (f64::from(rect.0) + f64::from(work_offset.0)) / scale,
        y: (f64::from(rect.1) + f64::from(work_offset.1)) / scale,
        width: width / scale,
        height: height / scale,
        maximized: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preparation_failures_never_skip_show_or_focus() {
        use std::cell::RefCell;

        for failing_step in 0..8 {
            let calls = RefCell::new(Vec::new());
            let result = reveal_after_preparation(
                |errors| {
                    for step in 0..8 {
                        calls.borrow_mut().push(step);
                        errors.record(
                            &format!("prepare {step}"),
                            if step == failing_step {
                                Err("injected failure")
                            } else {
                                Ok(())
                            },
                        );
                    }
                    true
                },
                |maximized| {
                    assert!(maximized);
                    calls.borrow_mut().push(8);
                    Ok(())
                },
                || {
                    calls.borrow_mut().push(9);
                    Ok(())
                },
            );
            assert_eq!(*calls.borrow(), (0..10).collect::<Vec<_>>());
            assert_eq!(
                result,
                Err(format!("prepare {failing_step}: injected failure"))
            );
        }
    }

    #[test]
    fn reveal_failure_still_attempts_focus_and_collects_errors() {
        let focused = std::cell::Cell::new(false);
        let result = reveal_after_preparation(
            |errors| {
                errors.record("placement", Err::<(), _>("no monitors"));
                false
            },
            |_| Err("reveal failed".into()),
            || {
                focused.set(true);
                Err("focus failed".into())
            },
        );
        assert!(focused.get());
        assert_eq!(
            result,
            Err("placement: no monitors; show: reveal failed; focus: focus failed".into())
        );
    }

    #[test]
    fn normal_placement_accounts_for_taskbar_decorations_and_scale() {
        for offset in [(48, 0), (0, 48), (0, 0)] {
            // A display left of primary: the offset is the taskbar inset, not its -1920 origin.
            let frame = normal_frame_from_workspace((-1800, 100, -584, 938), offset, (16, 38), 2.0)
                .unwrap();
            assert_eq!(frame.x, (-1800.0 + f64::from(offset.0)) / 2.0);
            assert_eq!(frame.y, (100.0 + f64::from(offset.1)) / 2.0);
            assert_eq!((frame.width, frame.height), (600.0, 400.0));
        }
    }

    #[test]
    fn invalid_normal_placement_is_not_saved() {
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(
                normal_frame_from_workspace((0, 0, 1200, 800), (0, 0), (16, 38), scale).is_none()
            );
        }
        assert!(normal_frame_from_workspace((0, 0, 16, 38), (0, 0), (16, 38), 1.0).is_none());
    }
}
