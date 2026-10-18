//! Native traits for panels: clicks never activate, explicit input focus may make them key.

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
    use windows_sys::Win32::{
        Foundation::RECT,
        UI::{
            Shell::SetWindowSubclass,
            WindowsAndMessaging::{
                GetClientRect, GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE,
                SWP_NOACTIVATE, SWP_NOZORDER,
            },
        },
    };
    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
    // Main-thread-only. Same focus policy as Tao's focusable(false); keep it through input focus.
    unsafe {
        SetWindowLongPtrW(
            hwnd,
            GWL_EXSTYLE,
            extended_style(GetWindowLongPtrW(hwnd, GWL_EXSTYLE)),
        );
    }
    // Get WebView2's actual container, not an assumed first child. Both its HWND and controller
    // must be inset: shrinking just the controller leaves a child HWND covering the resize band.
    let parent = hwnd as usize;
    window
        .with_webview(move |webview| unsafe {
            let controller = webview.controller();
            let mut child = Default::default();
            if let Err(error) = controller.ParentWindow(&mut child) {
                eprintln!("Could not access panel WebView2 container: {error}");
                return;
            }
            let update: ResizeWebview = Box::new(move |hwnd| {
                let mut client = RECT::default();
                if GetClientRect(hwnd, &mut client) == 0 {
                    return;
                }
                let (bx, by) = resize_border(hwnd);
                let inset = geometry::inset_client(client.right, client.bottom, bx, by);
                let width = inset.right - inset.left;
                let height = inset.bottom - inset.top;
                SetWindowPos(
                    child.0,
                    std::ptr::null_mut(),
                    inset.left,
                    inset.top,
                    width,
                    height,
                    SWP_NOACTIVATE | SWP_NOZORDER,
                );
                // Infer WebView2's windows::RECT without introducing another windows dependency.
                let mut bounds = Default::default();
                if controller.Bounds(&mut bounds).is_ok() {
                    bounds.left = 0;
                    bounds.top = 0;
                    bounds.right = width;
                    bounds.bottom = height;
                    if let Err(error) = controller.SetBounds(bounds) {
                        eprintln!("Could not inset panel WebView2 bounds: {error}");
                    }
                }
            });
            let hwnd = parent as windows_sys::Win32::Foundation::HWND;
            update(hwnd);
            let data = Box::into_raw(Box::new(update));
            if SetWindowSubclass(hwnd, Some(resize_subclass), 1, data as usize) == 0 {
                drop(Box::from_raw(data));
                eprintln!(
                    "Could not install panel resize border: {}",
                    std::io::Error::last_os_error()
                );
            }
        })
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
type ResizeWebview = Box<dyn Fn(windows_sys::Win32::Foundation::HWND)>;

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
        Foundation::{POINT, RECT},
        UI::{
            Shell::{DefSubclassProc, GetWindowSubclass, RemoveWindowSubclass},
            WindowsAndMessaging::{
                GetClientRect, GetWindow, GW_OWNER, MA_NOACTIVATE, SIZE_MINIMIZED, WM_DPICHANGED,
                WM_ENTERSIZEMOVE, WM_MOUSEACTIVATE, WM_NCDESTROY, WM_NCHITTEST, WM_NCLBUTTONDOWN,
                WM_SIZE,
            },
        },
    };
    if message == WM_MOUSEACTIVATE {
        // NOACTIVATE, not NOACTIVATEANDEAT: WebView2 must still receive the click.
        return MA_NOACTIVATE as isize;
    }
    if message == WM_NCLBUTTONDOWN {
        // Non-client resize presses do not reach the DOM hook. Return an input's keyboard focus
        // to the actual owner before starting the native drag, including a press without movement.
        let owner = GetWindow(hwnd, GW_OWNER);
        focus_if_app_active(owner);
    }
    if message == WM_NCHITTEST {
        let mut rect = RECT::default();
        let mut point = POINT {
            x: (lparam as u16 as i16) as i32,
            y: ((lparam >> 16) as u16 as i16) as i32,
        };
        // ScreenToClient uses the same origin as the WebView inset and Tao's shadow top edge.
        #[link(name = "user32")]
        extern "system" {
            fn ScreenToClient(hwnd: windows_sys::Win32::Foundation::HWND, point: *mut POINT)
                -> i32;
        }
        if GetClientRect(hwnd, &mut rect) != 0 && ScreenToClient(hwnd, &mut point) != 0 {
            let (bx, by) = resize_border(hwnd);
            if let Some(hit) = geometry::resize_hit(
                point.x,
                point.y,
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
        drop(Box::from_raw(data as *mut ResizeWebview));
        return result;
    }
    // Wry resets the child to fill the client during WM_SIZE. Run AFTER it, including DPI moves.
    let result = DefSubclassProc(hwnd, message, wparam, lparam);
    if message == WM_ENTERSIZEMOVE {
        // Wry's parent subclass focuses WebView2 on entering a resize/move loop.
        focus_if_app_active(GetWindow(hwnd, GW_OWNER));
    }
    if (message == WM_SIZE && wparam != SIZE_MINIMIZED as usize) || message == WM_DPICHANGED {
        // A lower procedure may destroy the window while processing a resize/DPI event.
        let mut current_data = 0;
        if GetWindowSubclass(hwnd, Some(resize_subclass), id, &mut current_data) != 0 {
            (*(current_data as *const ResizeWebview))(hwnd);
        }
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
