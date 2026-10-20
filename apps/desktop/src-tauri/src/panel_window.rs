//! Native panel traits and guarded hand-back after WebView2 pointer activation.

use std::{collections::HashMap, sync::Mutex};
use tauri::{Emitter, Manager};

#[path = "panel_focus_lease.rs"]
mod focus_lease;
#[path = "panel_window_installation.rs"]
mod installation;
pub(crate) use installation::finish_installation;
#[cfg(target_os = "macos")]
#[path = "panel_focus_macos.rs"]
mod macos;

#[derive(Default)]
pub(crate) struct PanelFocusState(Mutex<HashMap<String, focus_lease::Lease>>);

pub(crate) fn reset_for_webview<R: tauri::Runtime>(window: &tauri::Window<R>) {
    window
        .state::<PanelFocusState>()
        .0
        .lock()
        .unwrap()
        .entry(window.label().to_string())
        .or_default()
        .reset();
    let _ = window.set_focusable(false);
}

#[derive(Clone, serde::Serialize)]
struct FocusEvent {
    kind: &'static str,
    generation: u64,
}

// Read synchronously during page registration, before any asynchronous focus IPC.
// Send as a string so JavaScript treats the native epoch as an opaque token.
pub(crate) fn page_token<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> String {
    window
        .state::<PanelFocusState>()
        .0
        .lock()
        .unwrap()
        .entry(window.label().to_string())
        .or_default()
        .epoch
        .to_string()
}

pub(crate) fn request<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    generation: u64,
    page_token: &str,
    editing: bool,
) -> Option<u64> {
    let state = window.state::<PanelFocusState>();
    let mut leases = state.0.lock().unwrap();
    let lease = leases.entry(window.label().to_string()).or_default();
    let epoch = page_token.parse().ok()?;
    lease.request(generation, epoch, editing).then_some(epoch)
}

pub(crate) fn acquired<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    generation: u64,
    epoch: u64,
    focused: bool,
) -> bool {
    window
        .state::<PanelFocusState>()
        .0
        .lock()
        .unwrap()
        .entry(window.label().to_string())
        .or_default()
        .acquired(generation, epoch, focused)
}

pub(crate) fn is_current<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    generation: u64,
    epoch: u64,
) -> bool {
    window
        .state::<PanelFocusState>()
        .0
        .lock()
        .unwrap()
        .get(window.label())
        .is_some_and(|lease| lease.is_current(generation, epoch))
}

// Called synchronously from WM_ACTIVATE/WM_ACTIVATEAPP or AppKit key notifications,
// never from WebView2 child focus messages or delayed Tauri Focused events.
pub(crate) fn activation<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>, active: bool) {
    let generation = {
        let state = window.state::<PanelFocusState>();
        let mut leases = state.0.lock().unwrap();
        let lease = leases.entry(window.label().to_string()).or_default();
        if active {
            Some(lease.generation)
        } else {
            lease.deactivate()
        }
    };
    if let Some(generation) = generation {
        if !active {
            let _ = window.set_focusable(false);
        }
        let event = FocusEvent {
            kind: if active { "activated" } else { "deactivated" },
            generation,
        };
        if let Err(error) = window.emit_to(window.label(), "chemdraft://plugin-panel-focus", event)
        {
            eprintln!("Could not notify panel focus: {error}");
        }
    }
}

pub(crate) fn forget<R: tauri::Runtime>(window: &tauri::Window<R>) {
    window
        .state::<PanelFocusState>()
        .0
        .lock()
        .unwrap()
        .remove(window.label());
    #[cfg(target_os = "macos")]
    macos::forget(window.label());
}

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
        }) && GetForegroundWindow() == hwnd
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

#[cfg(target_os = "macos")]
pub(crate) fn install_resize_hit_test<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    macos::observe(window)
}

#[cfg(not(any(windows, target_os = "macos")))]
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
    use windows_sys::Win32::UI::{
        Shell::{RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{FindWindowExW, GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE},
    };
    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
    let document = window
        .app_handle()
        .get_webview_window(super::MAIN_WINDOW_LABEL)
        .ok_or_else(|| "Main document window is not available.".to_string())?;
    let parent = hwnd as usize;
    let panel = window.clone();
    let lease_panel = window.clone();
    let data = Box::into_raw(Box::new(PanelSubclass {
        return_focus: std::rc::Rc::new(move || {
            activation(&lease_panel, false);
            if let Err(error) = return_focus_to_document(parent as _, &document) {
                eprintln!("Could not return panel keyboard focus: {error}");
            }
        }),
        activation: std::rc::Rc::new(move |active| activation(&panel, active)),
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
        // Keep Tao's NCCALCSIZE unchanged: Win10 MUST retain a zero top inset
        // while WS_CAPTION is present; Win11 uses its DPI-scaled one-pixel inset.
        // Adapt the existing Tauri overlay, never install a competing resize surface.
        let class: Vec<u16> = "TAURI_DRAG_RESIZE_BORDERS\0".encode_utf16().collect();
        let name: Vec<u16> = "TAURI_DRAG_RESIZE_WINDOW\0".encode_utf16().collect();
        let overlay = FindWindowExW(hwnd, std::ptr::null_mut(), class.as_ptr(), name.as_ptr());
        if overlay.is_null() || SetWindowSubclass(overlay, Some(overlay_subclass), 1, parent) == 0 {
            RemoveWindowSubclass(hwnd, Some(resize_subclass), 1);
            drop(Box::from_raw(data));
            return Err("Could not adapt Tauri's panel resize overlay.".into());
        }
    }
    Ok(())
}

#[cfg(windows)]
struct PanelSubclass {
    return_focus: std::rc::Rc<dyn Fn()>,
    activation: std::rc::Rc<dyn Fn(bool)>,
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
    use windows_sys::Win32::UI::{
        Shell::{DefSubclassProc, RemoveWindowSubclass},
        WindowsAndMessaging::{
            HTCLIENT, MA_NOACTIVATE, WA_INACTIVE, WM_ACTIVATE, WM_ACTIVATEAPP, WM_ENTERSIZEMOVE,
            WM_EXITSIZEMOVE, WM_MOUSEACTIVATE, WM_NCDESTROY, WM_NCHITTEST, WM_NCLBUTTONDOWN,
            WM_NCMBUTTONDOWN, WM_NCRBUTTONDOWN,
        },
    };
    if message == WM_MOUSEACTIVATE {
        // NOACTIVATE, not NOACTIVATEANDEAT: WebView2 must still receive the click.
        return MA_NOACTIVATE as isize;
    }
    if message == WM_NCHITTEST {
        // Share the overlay's geometry and bypass Tao's broad HTTOP client strip.
        return panel_resize_hit(hwnd, lparam).map_or(HTCLIENT as isize, |hit| hit as isize);
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
    // A top-level deactivation is genuine even during acquisition. WebView2's
    // transient child blur is not WM_ACTIVATE, and must never release a lease.
    if message == WM_ACTIVATE || (message == WM_ACTIVATEAPP && wparam == 0) {
        let active = message == WM_ACTIVATE && (wparam & 0xffff) != WA_INACTIVE as usize;
        let notify = (*(data as *const PanelSubclass)).activation.clone();
        notify(active);
    }
    if message == WM_NCDESTROY {
        RemoveWindowSubclass(hwnd, Some(resize_subclass), id);
        let result = DefSubclassProc(hwnd, message, wparam, lparam);
        drop(Box::from_raw(data as *mut PanelSubclass));
        return result;
    }
    let result = DefSubclassProc(hwnd, message, wparam, lparam);
    if let Some(return_focus) = return_focus {
        // Wry focuses WebView2 on entering a native move/resize loop. Hand back AFTER it,
        // and again after the gesture, including a title press that never becomes a drag.
        return_focus();
    }
    result
}

/// Tauri owns this overlay's size/region/lifetime. Its original shadow handler returns
/// HTTOP for every pixel in SM_CYFRAME, swallowing title presses and corner directions.
/// Delegate the title interior to WebView2; only the outer one-DIP edge is a top grip.
#[cfg(windows)]
unsafe extern "system" fn overlay_subclass(
    hwnd: windows_sys::Win32::Foundation::HWND,
    message: u32,
    wparam: usize,
    lparam: isize,
    id: usize,
    parent: usize,
) -> isize {
    use windows_sys::Win32::UI::{
        Shell::{DefSubclassProc, RemoveWindowSubclass},
        WindowsAndMessaging::{
            SendMessageW, HTTRANSPARENT, MA_NOACTIVATE, WM_MOUSEACTIVATE, WM_NCDESTROY,
            WM_NCHITTEST, WM_NCLBUTTONDOWN, WM_NCMBUTTONDOWN, WM_NCRBUTTONDOWN,
        },
    };
    let parent = parent as windows_sys::Win32::Foundation::HWND;
    if message == WM_MOUSEACTIVATE {
        return MA_NOACTIVATE as isize;
    }
    if message == WM_NCDESTROY {
        RemoveWindowSubclass(hwnd, Some(overlay_subclass), id);
        return DefSubclassProc(hwnd, message, wparam, lparam);
    }
    if matches!(
        message,
        WM_NCHITTEST | WM_NCLBUTTONDOWN | WM_NCMBUTTONDOWN | WM_NCRBUTTONDOWN
    ) {
        let hit = panel_resize_hit(parent, lparam);
        if message == WM_NCHITTEST {
            return hit.map_or(HTTRANSPARENT as isize, |hit| hit as isize);
        }
        if let Some(hit) = hit {
            // Forward actual packed screen coordinates, not a pointer to POINTS.
            return SendMessageW(parent, message, hit as usize, lparam);
        }
        return 0;
    }
    DefSubclassProc(hwnd, message, wparam, lparam)
}

#[cfg(windows)]
unsafe fn panel_resize_hit(
    hwnd: windows_sys::Win32::Foundation::HWND,
    lparam: isize,
) -> Option<geometry::ResizeHit> {
    use windows_sys::Win32::{
        Foundation::{POINT, RECT},
        UI::{HiDpi::GetDpiForWindow, WindowsAndMessaging::GetWindowRect},
    };
    // windows-sys gates this user32 API behind the otherwise unused GDI feature.
    #[link(name = "user32")]
    extern "system" {
        fn ClientToScreen(hwnd: windows_sys::Win32::Foundation::HWND, point: *mut POINT) -> i32;
    }
    let mut rect = RECT::default();
    let mut client = POINT::default();
    if GetWindowRect(hwnd, &mut rect) == 0 || ClientToScreen(hwnd, &mut client) == 0 {
        return None;
    }
    let (bx, by) = resize_border(hwnd);
    geometry::resize_hit(
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
        geometry::top_resize_height(client.y - rect.top, GetDpiForWindow(hwnd), by),
    )
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
