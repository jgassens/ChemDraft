//! Native panel traits and guarded hand-back after WebView2 pointer activation.

#[cfg(any(windows, test))]
#[path = "panel_window_geometry.rs"]
mod geometry;

/// SetActiveWindow changes activation only within our UI thread; unlike tao's set_focus it
/// never calls SetForegroundWindow or synthesizes Alt. A late IPC is dropped in the background.
#[cfg(windows)]
pub(crate) fn focus_if_app_active(hwnd: windows_sys::Win32::Foundation::HWND) -> bool {
    use windows_sys::Win32::{
        System::Threading::GetCurrentProcessId,
        UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
        },
    };
    // windows-sys gates this user32 entry point behind the otherwise unused keyboard feature.
    #[link(name = "user32")]
    extern "system" {
        fn SetActiveWindow(
            hwnd: windows_sys::Win32::Foundation::HWND,
        ) -> windows_sys::Win32::Foundation::HWND;
    }
    unsafe {
        // Preserve Tao's visible/non-minimized gate, including utility suspension for dialogs.
        if hwnd.is_null() || IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 {
            return false;
        }
        let foreground = GetForegroundWindow();
        let mut process = 0;
        let known =
            !foreground.is_null() && GetWindowThreadProcessId(foreground, &mut process) != 0;
        geometry::with_owned_foreground(known.then_some(process), GetCurrentProcessId(), || {
            SetActiveWindow(hwnd);
        })
    }
}

/// Toolbar-style hand-back, without Tao's force_window_active / synthetic Alt fallback.
/// Called when a lease ends, a non-lease pointer gesture completes or idle activation settles. Activation alone
/// is not enough: keyboard focus must also leave the panel's WebView2 child HWND.
#[cfg(windows)]
pub(crate) fn return_focus_to_document<R: tauri::Runtime>(
    panel: windows_sys::Win32::Foundation::HWND,
    document: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    let owner = document.hwnd().map_err(|error| error.to_string())?.0;
    let foreground = unsafe { GetForegroundWindow() };
    // Do not take focus from another ChemDraft panel/dialog either.
    if !geometry::foreground_can_return_to_document(
        foreground as usize,
        panel as usize,
        owner as usize,
    ) {
        return Ok(());
    }
    if focus_if_app_active(owner) {
        let webview: &tauri::Webview<R> = document.as_ref();
        webview.set_focus().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn macos_style(
    style: objc2_app_kit::NSWindowStyleMask,
) -> objc2_app_kit::NSWindowStyleMask {
    style | objc2_app_kit::NSWindowStyleMask::NonactivatingPanel
}

#[cfg(not(windows))]
pub(crate) fn install_resize_hit_test<R: tauri::Runtime>(
    _window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
fn extended_style(style: isize) -> isize {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };
    // Tao may rewrite TOOLWINDOW on show; document ownership still keeps panels off the taskbar.
    (style | (WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW) as isize) & !(WS_EX_APPWINDOW as isize)
}

#[cfg(windows)]
pub(crate) fn install_resize_hit_test<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    use windows_sys::Win32::UI::{
        Shell::SetWindowSubclass,
        WindowsAndMessaging::{
            GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, SWP_FRAMECHANGED,
            SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
        },
    };
    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
    let document = window
        .app_handle()
        .get_webview_window(super::MAIN_WINDOW_LABEL)
        .ok_or_else(|| "Main document window is not available.".to_string())?;
    let parent = hwnd as usize;
    let panel = window.clone();
    let data = Box::into_raw(Box::new(PanelSubclass {
        return_focus: std::rc::Rc::new(move || {
            if let Err(error) = return_focus_to_document(parent as _, &document) {
                eprintln!("Could not return panel keyboard focus: {error}");
            }
        }),
        activated: std::rc::Rc::new(move || {
            // Do not redirect in WM_ACTIVATE: it can precede an input's trusted pointerdown.
            // The webview decides after a task, using its lease/request generations.
            if let Err(error) =
                panel.emit_to(panel.label(), "chemdraft://plugin-panel-activated", ())
            {
                eprintln!("Could not notify panel activation: {error}");
            }
        }),
    }));
    unsafe {
        SetWindowLongPtrW(
            hwnd,
            GWL_EXSTYLE,
            extended_style(GetWindowLongPtrW(hwnd, GWL_EXSTYLE)),
        );
        if SetWindowSubclass(hwnd, Some(resize_subclass), 1, data as usize) == 0 {
            drop(Box::from_raw(data));
            return Err(format!(
                "Could not install panel resize border: {}",
                std::io::Error::last_os_error()
            ));
        }
        // Recalculate the native frame. Wry continues to fill the entire client; there is
        // no exposed parent-client margin to paint (or turn black during live resizing).
        SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER,
        );
    }
    Ok(())
}

#[cfg(windows)]
struct PanelSubclass {
    return_focus: std::rc::Rc<dyn Fn()>,
    activated: std::rc::Rc<dyn Fn()>,
}

#[cfg(windows)]
unsafe fn resize_border(hwnd: windows_sys::Win32::Foundation::HWND) -> (i32, i32) {
    use windows_sys::Win32::UI::{
        HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi},
        WindowsAndMessaging::{IsZoomed, SM_CXFRAME, SM_CXPADDEDBORDER, SM_CYFRAME},
    };
    if IsZoomed(hwnd) != 0 {
        return (0, 0);
    }
    let dpi = GetDpiForWindow(hwnd);
    let padding = GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);
    (
        GetSystemMetricsForDpi(SM_CXFRAME, dpi) + padding,
        GetSystemMetricsForDpi(SM_CYFRAME, dpi) + padding,
    )
}

#[cfg(windows)]
unsafe extern "system" fn resize_subclass(
    hwnd: windows_sys::Win32::Foundation::HWND,
    message: u32,
    wparam: usize,
    lparam: isize,
    id: usize,
    data: usize,
) -> isize {
    use windows_sys::Win32::{
        Foundation::RECT,
        UI::{
            Shell::{DefSubclassProc, RemoveWindowSubclass},
            WindowsAndMessaging::{
                GetWindowRect, IsZoomed, MA_NOACTIVATE, NCCALCSIZE_PARAMS, WA_INACTIVE,
                WM_ACTIVATE, WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_MOUSEACTIVATE, WM_NCCALCSIZE,
                WM_NCDESTROY, WM_NCHITTEST, WM_NCLBUTTONDOWN, WM_NCMBUTTONDOWN, WM_NCRBUTTONDOWN,
            },
        },
    };
    if message == WM_MOUSEACTIVATE {
        // NOACTIVATE, not NOACTIVATEANDEAT: WebView2 must still receive the click.
        return MA_NOACTIVATE as isize;
    }
    let non_client_press = matches!(
        message,
        WM_NCLBUTTONDOWN | WM_NCMBUTTONDOWN | WM_NCRBUTTONDOWN
    );
    // Copy the callback before DefSubclassProc: a nested move/resize loop may destroy the panel.
    let return_focus = (non_client_press || matches!(message, WM_ENTERSIZEMOVE | WM_EXITSIZEMOVE))
        .then(|| (*(data as *const PanelSubclass)).return_focus.clone());
    if non_client_press {
        // A native border/title press ends a lease even without movement. No DOM event arrives.
        if let Some(return_focus) = &return_focus {
            return_focus();
        }
    }
    if message == WM_NCCALCSIZE && IsZoomed(hwnd) == 0 {
        // Reserve the system's non-client resize frame, outside the visible content.
        // Tao's undecorated-shadow path retains left/right/bottom but covers the top with
        // the child webview. Keep the same normal border on all four sides, no caption.
        let rect = if wparam != 0 {
            &mut (*(lparam as *mut NCCALCSIZE_PARAMS)).rgrc[0]
        } else {
            &mut *(lparam as *mut RECT)
        };
        let (bx, by) = resize_border(hwnd);
        let client =
            geometry::resize_client(rect.right - rect.left, rect.bottom - rect.top, bx, by);
        rect.right = rect.left + client.right;
        rect.bottom = rect.top + client.bottom;
        rect.left += client.left;
        rect.top += client.top;
        return 0;
    }
    if message == WM_NCHITTEST {
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect) != 0 {
            let (bx, by) = resize_border(hwnd);
            if let Some(hit) = geometry::resize_hit(
                (lparam as u16 as i16) as i32,
                ((lparam >> 16) as u16 as i16) as i32,
                geometry::Rect {
                    left: rect.left,
                    top: rect.top,
                    right: rect.right,
                    bottom: rect.bottom,
                },
                bx,
                by,
            ) {
                return hit as isize;
            }
        }
    }
    if message == WM_NCDESTROY {
        RemoveWindowSubclass(hwnd, Some(resize_subclass), id);
        let result = DefSubclassProc(hwnd, message, wparam, lparam);
        drop(Box::from_raw(data as *mut PanelSubclass));
        return result;
    }
    // Copy before calling lower procedures, which may destroy the window.
    let activated = (message == WM_ACTIVATE && (wparam & 0xffff) != WA_INACTIVE as usize)
        .then(|| (*(data as *const PanelSubclass)).activated.clone());
    let result = DefSubclassProc(hwnd, message, wparam, lparam);
    if let Some(return_focus) = return_focus {
        // Wry focuses WebView2 on entering a native move/resize loop. Hand back AFTER it,
        // and again after the gesture, including a title press that never becomes a drag.
        return_focus();
    }
    if let Some(activated) = activated {
        activated();
    }
    result
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_keeps_resize_traits_and_adds_nonactivation() {
        use objc2_app_kit::NSWindowStyleMask;
        let original = NSWindowStyleMask::Resizable | NSWindowStyleMask::Borderless;
        let style = super::macos_style(original);
        assert!(style.contains(NSWindowStyleMask::NonactivatingPanel));
        assert!(style.contains(NSWindowStyleMask::Resizable));
        assert_eq!(style, original | NSWindowStyleMask::NonactivatingPanel);
    }

    #[cfg(windows)]
    #[test]
    fn windows_style_never_activates_or_creates_taskbar_entry() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
        };
        let style = super::extended_style(WS_EX_APPWINDOW as isize);
        assert_ne!(style & WS_EX_NOACTIVATE as isize, 0);
        assert_ne!(style & WS_EX_TOOLWINDOW as isize, 0);
        assert_eq!(style & WS_EX_APPWINDOW as isize, 0);
    }

    #[cfg(windows)]
    #[test]
    fn portable_resize_results_match_win32_hit_codes() {
        use super::geometry::ResizeHit;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            HTBOTTOM, HTBOTTOMLEFT, HTBOTTOMRIGHT, HTLEFT, HTRIGHT, HTTOP, HTTOPLEFT, HTTOPRIGHT,
        };
        for (hit, native) in [
            (ResizeHit::Left, HTLEFT),
            (ResizeHit::Right, HTRIGHT),
            (ResizeHit::Top, HTTOP),
            (ResizeHit::Bottom, HTBOTTOM),
            (ResizeHit::TopLeft, HTTOPLEFT),
            (ResizeHit::TopRight, HTTOPRIGHT),
            (ResizeHit::BottomLeft, HTBOTTOMLEFT),
            (ResizeHit::BottomRight, HTBOTTOMRIGHT),
        ] {
            assert_eq!(hit as isize, native as isize);
        }
    }
}
