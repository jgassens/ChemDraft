//! Native traits for panels: clicks never activate, explicit input focus may make them key.

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
    (style | (WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW) as isize) & !(WS_EX_APPWINDOW as isize)
}

#[cfg(windows)]
pub(crate) fn install_resize_hit_test<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    use windows_sys::Win32::UI::{
        Shell::SetWindowSubclass,
        WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE},
    };
    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
    // Main-thread-only. Same focus policy as Tao's focusable(false); keep it through input focus.
    unsafe {
        SetWindowLongPtrW(
            hwnd,
            GWL_EXSTYLE,
            extended_style(GetWindowLongPtrW(hwnd, GWL_EXSTYLE)),
        );
        if SetWindowSubclass(hwnd, Some(resize_subclass), 1, 0) == 0 {
            return Err(format!(
                "Could not install panel resize border: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn resize_hit(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    border_x: i32,
    border_y: i32,
) -> Option<isize> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        HTBOTTOM, HTBOTTOMLEFT, HTBOTTOMRIGHT, HTLEFT, HTRIGHT, HTTOP, HTTOPLEFT, HTTOPRIGHT,
    };
    if x < 0 || y < 0 || x >= width || y >= height {
        return None;
    }
    let left = x < border_x;
    let right = x >= width - border_x;
    let top = y < border_y;
    let bottom = y >= height - border_y;
    match (left, right, top, bottom) {
        (true, _, true, _) => Some(HTTOPLEFT as isize),
        (_, true, true, _) => Some(HTTOPRIGHT as isize),
        (true, _, _, true) => Some(HTBOTTOMLEFT as isize),
        (_, true, _, true) => Some(HTBOTTOMRIGHT as isize),
        (true, _, _, _) => Some(HTLEFT as isize),
        (_, true, _, _) => Some(HTRIGHT as isize),
        (_, _, true, _) => Some(HTTOP as isize),
        (_, _, _, true) => Some(HTBOTTOM as isize),
        _ => None,
    }
}

#[cfg(windows)]
unsafe extern "system" fn resize_subclass(
    hwnd: windows_sys::Win32::Foundation::HWND,
    message: u32,
    wparam: usize,
    lparam: isize,
    id: usize,
    _data: usize,
) -> isize {
    use windows_sys::Win32::{
        Foundation::RECT,
        UI::{
            HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi},
            Shell::{DefSubclassProc, RemoveWindowSubclass},
            WindowsAndMessaging::{
                GetWindow, GetWindowRect, IsZoomed, SetForegroundWindow, GW_OWNER, MA_NOACTIVATE,
                SM_CXFRAME, SM_CXPADDEDBORDER, SM_CYFRAME, WM_MOUSEACTIVATE, WM_NCDESTROY,
                WM_NCHITTEST, WM_NCLBUTTONDOWN,
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
        if !owner.is_null() {
            SetForegroundWindow(owner);
        }
    }
    if message == WM_NCHITTEST && IsZoomed(hwnd) == 0 {
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect) != 0 {
            let dpi = GetDpiForWindow(hwnd);
            let padding = GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);
            let border_x = GetSystemMetricsForDpi(SM_CXFRAME, dpi) + padding;
            let border_y = GetSystemMetricsForDpi(SM_CYFRAME, dpi) + padding;
            // Signed screen coordinates also cover monitors left/above the primary display.
            let x = (lparam as u16 as i16) as i32 - rect.left;
            let y = ((lparam >> 16) as u16 as i16) as i32 - rect.top;
            if let Some(hit) = resize_hit(
                x,
                y,
                rect.right - rect.left,
                rect.bottom - rect.top,
                border_x,
                border_y,
            ) {
                return hit;
            }
        }
    }
    if message == WM_NCDESTROY {
        RemoveWindowSubclass(hwnd, Some(resize_subclass), id);
    }
    DefSubclassProc(hwnd, message, wparam, lparam)
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
    fn windows_resize_band_covers_all_edges_and_corners_without_changing_center() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            HTBOTTOM, HTBOTTOMLEFT, HTBOTTOMRIGHT, HTLEFT, HTRIGHT, HTTOP, HTTOPLEFT, HTTOPRIGHT,
        };
        for (x, y, hit) in [
            (4, 40, HTLEFT),
            (96, 40, HTRIGHT),
            (50, 4, HTTOP),
            (50, 76, HTBOTTOM),
            (4, 4, HTTOPLEFT),
            (96, 4, HTTOPRIGHT),
            (4, 76, HTBOTTOMLEFT),
            (96, 76, HTBOTTOMRIGHT),
        ] {
            assert_eq!(super::resize_hit(x, y, 100, 80, 8, 8), Some(hit as isize));
        }
        assert_eq!(super::resize_hit(50, 40, 100, 80, 8, 8), None);
        assert_eq!(super::resize_hit(-1, 40, 100, 80, 8, 8), None);
    }
}
