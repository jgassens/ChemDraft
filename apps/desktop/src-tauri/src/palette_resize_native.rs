//! Axis-aware native edge cursors and genuine user resize observation.

use super::palette_geometry::Orientation;

#[cfg(target_os = "macos")]
#[path = "palette_resize_macos.rs"]
mod macos;

pub(super) fn install<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    orientation: Orientation,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::install(window, orientation)
    }
    #[cfg(windows)]
    {
        windows::install(window, orientation)
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (window, orientation);
        Ok(())
    }
}

pub(super) fn forget(label: &str) {
    #[cfg(target_os = "macos")]
    macos::forget(label);
    #[cfg(not(target_os = "macos"))]
    let _ = label; // Windows releases its observer synchronously in WM_NCDESTROY.
}

pub(super) fn constrain<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    orientation: Orientation,
    minimum: (f64, f64),
    maximum: (f64, f64),
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::constrain(window, orientation, minimum, maximum)
    }
    #[cfg(windows)]
    {
        windows::constrain(window, orientation, minimum, maximum)
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (window, orientation, minimum, maximum);
        Ok(())
    }
}

#[cfg(windows)]
mod windows {
    use super::super::palette_resize_hit_test::{self as policy, Rect};
    use super::Orientation;
    use std::{cell::Cell, rc::Rc};
    use windows_sys::Win32::{
        Foundation::{HWND, POINT, RECT},
        Graphics::Gdi::{
            ClientToScreen, CombineRgn, CreateRectRgn, DeleteObject, EqualRgn, GetWindowRgn,
            SetWindowRgn,
        },
        UI::{
            HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi},
            Shell::{DefSubclassProc, GetWindowSubclass, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::{
                FindWindowExW, GetClientRect, SendMessageW, HTCLIENT, HTTRANSPARENT,
                SM_CXSIZEFRAME, WM_DPICHANGED, WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_MOUSEACTIVATE,
                WM_NCDESTROY, WM_NCHITTEST, WM_NCLBUTTONDOWN, WM_NCMBUTTONDOWN, WM_NCRBUTTONDOWN,
                WM_SIZE, WM_SIZING, WM_WINDOWPOSCHANGED,
            },
        },
    };

    struct Observer {
        orientation: Cell<Orientation>,
        enabled: Cell<bool>,
        sizing: Cell<bool>,
        resized: Rc<dyn Fn()>,
        finished: Rc<dyn Fn()>,
    }

    pub(super) fn install<R: tauri::Runtime>(
        window: &tauri::WebviewWindow<R>,
        orientation: Orientation,
    ) -> Result<(), String> {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0;
        let target = window.clone();
        let finish_target = window.clone();
        let data = Box::into_raw(Box::new(Observer {
            orientation: Cell::new(orientation),
            enabled: Cell::new(false),
            sizing: Cell::new(false),
            resized: Rc::new(move || {
                let webview: &tauri::Webview<R> = target.as_ref();
                super::super::palette_resize::user_resized(&webview.window());
            }),
            finished: Rc::new(move || {
                let webview: &tauri::Webview<R> = finish_target.as_ref();
                super::super::palette_resize::flush_pending(&webview.window());
            }),
        }));
        // SAFETY: on the window's UI thread. Data lives until the subclass sees WM_NCDESTROY.
        if unsafe { SetWindowSubclass(hwnd, Some(observe), 3, data as usize) } == 0 {
            unsafe { drop(Box::from_raw(data)) };
            return Err(format!(
                "Could not observe palette resizing: {}",
                std::io::Error::last_os_error()
            ));
        }
        // Tauri's shadowed undecorated window has a child input surface which otherwise
        // reports HTTOP over the title strip. Adapt that existing surface, never add a second one.
        let overlay = unsafe { overlay(hwnd) };
        if overlay.is_null()
            || unsafe { SetWindowSubclass(overlay, Some(overlay_proc), 3, hwnd as usize) } == 0
        {
            unsafe {
                RemoveWindowSubclass(hwnd, Some(observe), 3);
                drop(Box::from_raw(data));
            }
            return Err("Could not adapt the toolbar resize input surface.".into());
        }
        Ok(())
    }

    unsafe fn observer_data(hwnd: HWND) -> Option<usize> {
        let mut data = 0;
        (GetWindowSubclass(hwnd, Some(observe), 3, &mut data) != 0).then_some(data)
    }

    unsafe fn settings(hwnd: HWND) -> Option<(Orientation, bool)> {
        let observer = &*(observer_data(hwnd)? as *const Observer);
        Some((observer.orientation.get(), observer.enabled.get()))
    }

    pub(super) fn constrain<R: tauri::Runtime>(
        window: &tauri::Window<R>,
        orientation: Orientation,
        minimum: (f64, f64),
        maximum: (f64, f64),
    ) -> Result<(), String> {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0;
        // SAFETY: palette sizing and subclass installation/removal all run on this UI thread.
        unsafe {
            let data = observer_data(hwnd).ok_or("Toolbar resize observer is missing.")?;
            let observer = &*(data as *const Observer);
            observer.orientation.set(orientation);
            observer.enabled.set(
                orientation.length(minimum.0, minimum.1) < orientation.length(maximum.0, maximum.1),
            );
            update_region(hwnd)
        }
    }

    unsafe fn overlay(hwnd: HWND) -> HWND {
        let class: Vec<u16> = "TAURI_DRAG_RESIZE_BORDERS\0".encode_utf16().collect();
        let name: Vec<u16> = "TAURI_DRAG_RESIZE_WINDOW\0".encode_utf16().collect();
        FindWindowExW(hwnd, std::ptr::null_mut(), class.as_ptr(), name.as_ptr())
    }

    unsafe fn regions(hwnd: HWND) -> Option<[(policy::Edge, Rect); 2]> {
        let (orientation, enabled) = settings(hwnd)?;
        let mut rect = RECT::default();
        if !enabled || GetClientRect(hwnd, &mut rect) == 0 {
            return None;
        }
        let band = f64::from(GetSystemMetricsForDpi(
            SM_CXSIZEFRAME,
            GetDpiForWindow(hwnd),
        ));
        Some(policy::regions(
            orientation,
            f64::from(rect.right),
            f64::from(rect.bottom),
            band,
        ))
    }

    unsafe fn hit(hwnd: HWND, lparam: isize) -> Option<policy::Edge> {
        let (orientation, enabled) = settings(hwnd)?;
        let mut rect = RECT::default();
        let mut origin = POINT::default();
        if !enabled || GetClientRect(hwnd, &mut rect) == 0 || ClientToScreen(hwnd, &mut origin) == 0
        {
            return None;
        }
        // WM_NCHITTEST packs signed screen coordinates; negative monitor origins must stay signed.
        let x = (lparam as u16 as i16) as i32 - origin.x;
        let y = ((lparam >> 16) as u16 as i16) as i32 - origin.y;
        let band = f64::from(GetSystemMetricsForDpi(
            SM_CXSIZEFRAME,
            GetDpiForWindow(hwnd),
        ));
        policy::hit_test(
            orientation,
            f64::from(x),
            f64::from(y),
            f64::from(rect.right),
            f64::from(rect.bottom),
            band,
        )
    }

    unsafe fn update_region(hwnd: HWND) -> Result<(), String> {
        let overlay = overlay(hwnd);
        if overlay.is_null() {
            return Err("Toolbar resize input surface is missing.".into());
        }
        let desired = CreateRectRgn(0, 0, 0, 0);
        let current = CreateRectRgn(0, 0, 0, 0);
        if desired.is_null() || current.is_null() {
            if !desired.is_null() {
                DeleteObject(desired);
            }
            if !current.is_null() {
                DeleteObject(current);
            }
            return Err("Could not allocate the toolbar resize region.".into());
        }
        let result = (|| {
            if let Some(regions) = regions(hwnd) {
                for (_, rect) in regions {
                    let region = CreateRectRgn(
                        rect.x as i32,
                        rect.y as i32,
                        (rect.x + rect.width) as i32,
                        (rect.y + rect.height) as i32,
                    );
                    if region.is_null() {
                        return Err("Could not allocate a toolbar edge region.".into());
                    }
                    let combined = CombineRgn(
                        desired,
                        desired,
                        region,
                        windows_sys::Win32::Graphics::Gdi::RGN_OR,
                    );
                    DeleteObject(region);
                    if combined == 0 {
                        return Err("Could not combine toolbar edge regions.".into());
                    }
                }
            }
            // SetWindowRgn reenters WM_WINDOWPOSCHANGED. Compare first to stop feedback.
            if GetWindowRgn(overlay, current) != 0 && EqualRgn(current, desired) != 0 {
                return Ok(false);
            }
            if SetWindowRgn(overlay, desired, 1) == 0 {
                return Err("Could not set the toolbar resize region.".into());
            }
            Ok(true) // Windows owns the installed region.
        })();
        DeleteObject(current);
        if !matches!(result, Ok(true)) {
            DeleteObject(desired);
        }
        result.map(|_| ())
    }

    unsafe extern "system" fn overlay_proc(
        hwnd: HWND,
        message: u32,
        wparam: usize,
        lparam: isize,
        id: usize,
        parent: usize,
    ) -> isize {
        let parent = parent as HWND;
        match message {
            WM_NCDESTROY => {
                RemoveWindowSubclass(hwnd, Some(overlay_proc), id);
            }
            WM_MOUSEACTIVATE => return SendMessageW(parent, message, wparam, lparam),
            WM_NCHITTEST => {
                return policy::windows_hit(hit(parent, lparam), HTTRANSPARENT as isize)
            }
            WM_NCLBUTTONDOWN | WM_NCMBUTTONDOWN | WM_NCRBUTTONDOWN => {
                return hit(parent, lparam).map_or(0, |edge| {
                    SendMessageW(
                        parent,
                        message,
                        policy::windows_hit(Some(edge), HTCLIENT as isize) as usize,
                        lparam,
                    )
                });
            }
            _ => {}
        }
        let result = DefSubclassProc(hwnd, message, wparam, lparam);
        if message == WM_WINDOWPOSCHANGED {
            if let Err(error) = update_region(parent) {
                eprintln!("{error}");
            }
        }
        result
    }

    unsafe extern "system" fn observe(
        hwnd: HWND,
        message: u32,
        wparam: usize,
        lparam: isize,
        id: usize,
        data: usize,
    ) -> isize {
        if message == WM_NCDESTROY {
            RemoveWindowSubclass(hwnd, Some(observe), id);
            let result = DefSubclassProc(hwnd, message, wparam, lparam);
            drop(Box::from_raw(data as *mut Observer));
            return result;
        }
        if message == WM_NCHITTEST {
            // Call Tao first so caption/client movement semantics remain intact, then replace
            // all resize codes using our point/orientation policy (corners included).
            let fallback = DefSubclassProc(hwnd, message, wparam, lparam);
            return policy::windows_hit(hit(hwnd, lparam), fallback);
        }
        let observer = &*(data as *const Observer);
        match message {
            WM_ENTERSIZEMOVE | WM_EXITSIZEMOVE | WM_DPICHANGED => observer.sizing.set(false),
            // A title-strip move also enters the modal loop; only WM_SIZING confirms an edge drag.
            WM_SIZING => observer.sizing.set(true),
            _ => {}
        }
        // Clone before DefSubclassProc, which can destroy/reenter the window.
        let notify = (message == WM_SIZE && observer.sizing.replace(false))
            .then(|| observer.resized.clone());
        let finished = (message == WM_EXITSIZEMOVE).then(|| observer.finished.clone());
        let result = DefSubclassProc(hwnd, message, wparam, lparam);
        if matches!(message, WM_SIZE | WM_DPICHANGED) {
            if let Err(error) = update_region(hwnd) {
                eprintln!("{error}");
            }
        }
        if let Some(notify) = notify {
            notify();
        }
        if let Some(finished) = finished {
            finished();
        }
        result
    }
}
