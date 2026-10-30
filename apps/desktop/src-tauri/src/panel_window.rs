//! Native panel traits and guarded hand-back after WebView2 pointer activation.

use std::{collections::HashMap, sync::Mutex};
use tauri::{Emitter, Manager};

#[path = "panel_focus_lease.rs"]
mod focus_lease;
#[path = "panel_focus_return.rs"]
mod focus_return;
#[path = "panel_window_installation.rs"]
mod installation;
#[path = "palette_key_guard.rs"]
mod key_guard;
pub(crate) use installation::finish_installation;
pub(crate) use key_guard::{
    keeps_palette_focus, observe_document_pointer_release, End as PointerGuardEnd,
};

pub(crate) fn palette_blocks_menu(document_target: bool, command: &str) -> bool {
    key_guard::blocks_menu(key_guard::blocks_document(), document_target, command)
}

/// Pointer observation alone does not alter window styles or input leases.
pub(crate) fn install_pointer_guard<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    key_guard::install(window)
}
#[cfg(target_os = "macos")]
#[path = "panel_focus_macos.rs"]
mod macos;

#[derive(Default)]
pub(crate) struct PanelFocusState(Mutex<HashMap<String, focus_lease::Lease>>);

pub(crate) fn end_pointer_guard<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    label: &str,
    why: PointerGuardEnd,
    sequence: Option<u64>,
    before: u64,
) {
    key_guard::end(app, label, why, sequence, before);
}

/// Hiding is terminal even when a select popup already resigned key status.
/// Invalidate native acquisition and notify the still-mounted page before hiding.
pub(crate) fn end_for_hide<R: tauri::Runtime>(app: &tauri::AppHandle<R>, label: &str) {
    key_guard::end(app, label, PointerGuardEnd::Hide, None, 0);
    if let Some(window) = app.get_webview_window(label) {
        activation_with_reason(&window, false, "hide");
    }
}

pub(crate) fn holds_input_focus<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> bool {
    window
        .state::<PanelFocusState>()
        .0
        .lock()
        .unwrap()
        .get(window.label())
        .is_some_and(focus_lease::Lease::is_held)
}

/// A release is explicit: native deactivation, teardown and rejected acquisitions do not
/// ask for focus. Recheck the lease and native destination when queued work actually runs.
pub(crate) fn return_focus_after_interaction<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    requested: bool,
) -> Result<(), String> {
    let held = holds_input_focus(window);
    let log_skip = |app_active, source_focused| {
        let reason = focus_return::skip_reason(requested, held, app_active, source_focused)
            .unwrap_or("document-unavailable");
        super::palette_focus_log(format_args!(
            "hand-back label={} result=skipped reason={reason}",
            window.label()
        ));
    };
    #[cfg(windows)]
    {
        if let Some(document) = window
            .app_handle()
            .get_webview_window(super::MAIN_WINDOW_LABEL)
        {
            if focus_return::should_return(
                requested,
                held,
                super::foreground_belongs_to_app(),
                true,
            ) {
                // The HWND pair is rechecked inside, including native chooser ownership.
                return_focus_to_document(
                    window.hwnd().map_err(|error| error.to_string())?.0,
                    &document,
                    window.label(),
                )?;
            } else {
                log_skip(super::foreground_belongs_to_app(), true);
            }
        } else {
            log_skip(super::foreground_belongs_to_app(), true);
        }
    }
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSApplication, NSWindow};
        let marker =
            objc2::MainThreadMarker::new().ok_or("Panel focus requires the main thread.")?;
        let pointer = window.ns_window().map_err(|error| error.to_string())? as *mut NSWindow;
        let panel = unsafe { pointer.as_ref() }.ok_or("Could not access native panel window.")?;
        if focus_return::should_return(
            requested,
            held,
            NSApplication::sharedApplication(marker).isActive(),
            panel.isKeyWindow(),
        ) {
            if let Some(document) = window
                .app_handle()
                .get_webview_window(super::MAIN_WINDOW_LABEL)
            {
                // makeKeyWindow resigns the palette without activating a background app.
                super::focus_native_document_window(&document)?;
                let webview: &tauri::Webview<R> = document.as_ref();
                webview.set_focus().map_err(|error| error.to_string())?;
                super::palette_focus_log(format_args!(
                    "hand-back label={} result=returned reason=explicit-release",
                    window.label()
                ));
            } else {
                log_skip(true, true);
            }
        } else {
            log_skip(
                NSApplication::sharedApplication(marker).isActive(),
                panel.isKeyWindow(),
            );
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        if focus_return::should_return(
            requested,
            held,
            super::foreground_belongs_to_app(),
            window.is_focused().unwrap_or(false),
        ) {
            super::focus_main_document_window_impl(
                window.app_handle(),
                super::MainWindowFocusMode::OnlyIfAppActive,
            )?;
            super::palette_focus_log(format_args!(
                "hand-back label={} result=returned reason=explicit-release",
                window.label()
            ));
        } else {
            log_skip(
                super::foreground_belongs_to_app(),
                window.is_focused().unwrap_or(false),
            );
        }
    }
    Ok(())
}

pub(crate) fn reset_for_webview<R: tauri::Runtime>(window: &tauri::Window<R>) {
    key_guard::end(
        window.app_handle(),
        window.label(),
        PointerGuardEnd::Destroy,
        None,
        0,
    );
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
    reason: &'static str,
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
    select_interaction: bool,
) -> Option<u64> {
    let state = window.state::<PanelFocusState>();
    let mut leases = state.0.lock().unwrap();
    let lease = leases.entry(window.label().to_string()).or_default();
    let epoch = page_token.parse().ok()?;
    if !lease.request(generation, epoch, editing) {
        return None;
    }
    lease.select_interaction = cfg!(target_os = "macos") && editing && select_interaction;
    Some(epoch)
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
    activation_with_reason(window, active, "window");
}

fn activation_with_reason<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    active: bool,
    reason: &'static str,
) {
    super::palette_focus_log(format_args!(
        "activation label={} active={active} reason={reason}",
        window.label()
    ));
    if !active {
        key_guard::end(
            window.app_handle(),
            window.label(),
            PointerGuardEnd::Deactivated,
            None,
            0,
        );
    }
    let (generation, preserve_select) = {
        let state = window.state::<PanelFocusState>();
        let mut leases = state.0.lock().unwrap();
        let lease = leases.entry(window.label().to_string()).or_default();
        let preserve_select = !active && reason == "window" && lease.suspend_select();
        let generation = if active || preserve_select {
            Some(lease.generation)
        } else {
            lease.deactivate()
        };
        (generation, preserve_select)
    };
    if let Some(generation) = generation {
        if !active && !preserve_select {
            let _ = window.set_focusable(false);
        }
        let event = FocusEvent {
            kind: if active { "activated" } else { "deactivated" },
            generation,
            reason,
        };
        if let Err(error) = window.emit_to(window.label(), "chemdraft://plugin-panel-focus", event)
        {
            eprintln!("Could not notify panel focus: {error}");
        }
    }
}

// Key resignation alone cannot distinguish an AppKit popup from leaving the
// palette. The native pointer monitor and app notification supply those explicit
// terminal transitions, including when the select has already lost key status.
#[cfg(target_os = "macos")]
pub(super) fn end_select_interactions<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    except: Option<&str>,
    reason: &'static str,
) {
    for (label, window) in app.webview_windows() {
        if except == Some(label.as_str()) {
            continue;
        }
        let select = app
            .state::<PanelFocusState>()
            .0
            .lock()
            .unwrap()
            .get(&label)
            .is_some_and(|lease| lease.select_interaction);
        if select {
            activation_with_reason(&window, false, reason);
        }
    }
}

pub(crate) fn forget<R: tauri::Runtime>(window: &tauri::Window<R>) {
    key_guard::end(
        window.app_handle(),
        window.label(),
        PointerGuardEnd::Destroy,
        None,
        0,
    );
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
    label: &str,
) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, IsIconic, IsWindowVisible, SetForegroundWindow,
    };
    let owner = document.hwnd().map_err(|error| error.to_string())?.0;
    let foreground = unsafe { GetForegroundWindow() };
    // Do not take focus from another ChemDraft panel/dialog either.
    if !geometry::foreground_can_return_to_document(
        foreground as usize,
        panel as usize,
        owner as usize,
    ) {
        super::palette_focus_log(format_args!(
            "hand-back label={label} result=skipped reason=another-window-focused"
        ));
        return Ok(());
    }
    // SetActiveWindow alone can leave the palette as the foreground window after a
    // WebView2 select or Tao drag. Transfer foreground explicitly, only from our exact
    // source/document pair. Do not use Tao's force activation/synthetic Alt fallback.
    let returned = unsafe {
        super::foreground_belongs_to_app()
            && GetForegroundWindow() == foreground
            && IsWindowVisible(owner) != 0
            && IsIconic(owner) == 0
            && (foreground == owner || SetForegroundWindow(owner) != 0)
            && GetForegroundWindow() == owner
    };
    if returned {
        let webview: &tauri::Webview<R> = document.as_ref();
        webview.set_focus().map_err(|error| error.to_string())?;
    }
    super::palette_focus_log(format_args!(
        "hand-back label={label} result={} reason={}",
        if returned { "returned" } else { "skipped" },
        if returned {
            "explicit-release"
        } else {
            "foreground-changed-or-document-unavailable"
        }
    ));
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn macos_style(
    style: objc2_app_kit::NSWindowStyleMask,
) -> objc2_app_kit::NSWindowStyleMask {
    style | objc2_app_kit::NSWindowStyleMask::NonactivatingPanel
}

#[cfg(target_os = "macos")]
pub(crate) fn install_input_focus<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    key_guard::install(window)?;
    macos::observe(window)
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(crate) fn install_input_focus<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    key_guard::install(window)
}

#[cfg(not(windows))]
pub(crate) fn install_resize_hit_test<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    install_input_focus(window)
}

#[cfg(windows)]
fn extended_style(style: isize) -> isize {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };
    // Tao may rewrite TOOLWINDOW on show; document ownership still keeps panels off the taskbar.
    (style | (WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW) as isize) & !(WS_EX_APPWINDOW as isize)
}

/// Focus observation is shared by resizable reports, tool palettes and colour popovers.
/// It must not depend on a resize overlay (popovers do not have one).
#[cfg(windows)]
pub(crate) fn install_input_focus<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    use windows_sys::Win32::UI::{
        Shell::SetWindowSubclass,
        WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE},
    };
    key_guard::install(window)?;
    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
    let target = window.clone();
    let drag_target = window.clone();
    let data = Box::into_raw(Box::new(FocusObserver {
        activation: std::rc::Rc::new(move |active| activation(&target, active)),
        drag_finished: std::rc::Rc::new(move || {
            // The palette's title/background press ended its lease without returning focus.
            // Hand back only after Tao's drag loop; guard any newer lease or foreground owner.
            if drag_target.label().starts_with("toolset-") {
                if let Err(error) = return_focus_after_interaction(&drag_target, true) {
                    eprintln!("Could not return palette keyboard focus after drag: {error}");
                }
            }
        }),
    }));
    unsafe {
        SetWindowLongPtrW(
            hwnd,
            GWL_EXSTYLE,
            extended_style(GetWindowLongPtrW(hwnd, GWL_EXSTYLE)),
        );
        if SetWindowSubclass(hwnd, Some(focus_subclass), 2, data as usize) == 0 {
            drop(Box::from_raw(data));
            return Err(format!(
                "Could not observe utility window focus: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
struct FocusObserver {
    activation: std::rc::Rc<dyn Fn(bool)>,
    drag_finished: std::rc::Rc<dyn Fn()>,
}

#[cfg(windows)]
unsafe extern "system" fn focus_subclass(
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
            WA_INACTIVE, WM_ACTIVATE, WM_ACTIVATEAPP, WM_EXITSIZEMOVE, WM_NCDESTROY,
        },
    };
    // Observe focus without overriding mouse activation. Palettes keep WS_EX_NOACTIVATE,
    // but WebView2 must be allowed to activate them for a native colour picker. Forcing
    // MA_NOACTIVATE here (newly installed on palettes) prevents that popup from opening.
    // Ordinary command clicks still return focus through the guarded pointer hand-back.
    // Observe genuine top-level loss synchronously, including during acquisition.
    // WebView2 child focus transitions are not lease boundaries.
    if message == WM_ACTIVATE || (message == WM_ACTIVATEAPP && wparam == 0) {
        let active = message == WM_ACTIVATE && (wparam & 0xffff) != WA_INACTIVE as usize;
        let notify = (*(data as *const FocusObserver)).activation.clone();
        notify(active);
    }
    if message == WM_NCDESTROY {
        RemoveWindowSubclass(hwnd, Some(focus_subclass), id);
        let result = DefSubclassProc(hwnd, message, wparam, lparam);
        drop(Box::from_raw(data as *mut FocusObserver));
        return result;
    }
    // Clone before invoking Tao: nested message handling can destroy the observer.
    let drag_finished = (message == WM_EXITSIZEMOVE)
        .then(|| (*(data as *const FocusObserver)).drag_finished.clone());
    let result = DefSubclassProc(hwnd, message, wparam, lparam);
    if let Some(drag_finished) = drag_finished {
        drag_finished();
    }
    result
}

#[cfg(windows)]
pub(crate) fn install_resize_hit_test<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::{RemoveWindowSubclass, SetWindowSubclass};
    install_input_focus(window)?;
    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
    let document = window
        .app_handle()
        .get_webview_window(super::MAIN_WINDOW_LABEL)
        .ok_or_else(|| "Main document window is not available.".to_string())?;
    let parent = hwnd as usize;
    let lease_panel = window.clone();
    let data = Box::into_raw(Box::new(PanelSubclass {
        return_focus: std::rc::Rc::new(move || {
            activation(&lease_panel, false);
            if let Err(error) =
                return_focus_to_document(parent as _, &document, lease_panel.label())
            {
                eprintln!("Could not return panel keyboard focus: {error}");
            }
        }),
    }));
    unsafe {
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
        let overlay = resize_overlay(hwnd);
        if overlay.is_null() || SetWindowSubclass(overlay, Some(overlay_subclass), 1, parent) == 0 {
            RemoveWindowSubclass(hwnd, Some(resize_subclass), 1);
            drop(Box::from_raw(data));
            return Err("Could not adapt Tauri's panel resize overlay.".into());
        }
        if let Err(error) = update_resize_overlay(hwnd) {
            RemoveWindowSubclass(overlay, Some(overlay_subclass), 1);
            RemoveWindowSubclass(hwnd, Some(resize_subclass), 1);
            drop(Box::from_raw(data));
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(windows)]
struct PanelSubclass {
    return_focus: std::rc::Rc<dyn Fn()>,
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
unsafe fn resize_overlay(
    parent: windows_sys::Win32::Foundation::HWND,
) -> windows_sys::Win32::Foundation::HWND {
    use windows_sys::Win32::UI::WindowsAndMessaging::FindWindowExW;
    let class: Vec<u16> = "TAURI_DRAG_RESIZE_BORDERS\0".encode_utf16().collect();
    let name: Vec<u16> = "TAURI_DRAG_RESIZE_WINDOW\0".encode_utf16().collect();
    FindWindowExW(parent, std::ptr::null_mut(), class.as_ptr(), name.as_ptr())
}

/// Widen the INPUT region of Tauri's existing child, not the parent's non-client frame.
/// Tauri 2.11.2 otherwise clips this child to SM_CYFRAME (without SM_CXPADDEDBORDER),
/// so a larger hit test alone cannot receive presses throughout the system resize band.
#[cfg(windows)]
unsafe fn update_resize_overlay(
    parent: windows_sys::Win32::Foundation::HWND,
) -> Result<(), String> {
    use windows_sys::Win32::{
        Foundation::{HWND, RECT},
        UI::WindowsAndMessaging::{GetClientRect, GetWindowRect},
    };
    // These entry points are gated behind windows-sys's otherwise unused GDI feature.
    type Region = *mut std::ffi::c_void;
    #[link(name = "gdi32")]
    extern "system" {
        fn CreateRectRgn(left: i32, top: i32, right: i32, bottom: i32) -> Region;
        fn EqualRgn(first: Region, second: Region) -> i32;
        fn DeleteObject(object: Region) -> i32;
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetWindowRgn(hwnd: HWND, region: Region) -> i32;
        fn SetWindowRgn(hwnd: HWND, region: Region, redraw: i32) -> i32;
    }
    let overlay = resize_overlay(parent);
    let mut window_rect = RECT::default();
    let mut overlay_rect = RECT::default();
    let mut client_rect = RECT::default();
    if overlay.is_null()
        || GetWindowRect(parent, &mut window_rect) == 0
        || GetWindowRect(overlay, &mut overlay_rect) == 0
        || GetClientRect(parent, &mut client_rect) == 0
    {
        return Err("Could not measure panel resize overlay.".into());
    }
    let (_, border) = resize_border(parent);
    let region = geometry::top_overlay_rect(
        client_rect.right - client_rect.left,
        client_rect.bottom - client_rect.top,
        overlay_rect.top - window_rect.top,
        border,
    );
    let desired = CreateRectRgn(region.left, region.top, region.right, region.bottom);
    let current = CreateRectRgn(0, 0, 0, 0);
    if desired.is_null() || current.is_null() {
        if !desired.is_null() {
            DeleteObject(desired);
        }
        if !current.is_null() {
            DeleteObject(current);
        }
        return Err("Could not allocate panel resize region.".into());
    }
    // SetWindowRgn sends WM_WINDOWPOSCHANGED too. Comparing first makes that nested
    // callback a no-op and avoids repainting on ordinary moves of an unchanged band.
    let unchanged = GetWindowRgn(overlay, current) != 0 && EqualRgn(current, desired) != 0;
    DeleteObject(current);
    if unchanged {
        DeleteObject(desired);
    } else if SetWindowRgn(overlay, desired, 1) == 0 {
        DeleteObject(desired);
        return Err("Could not set panel resize region.".into());
    }
    // On success Windows owns `desired`; never delete the installed region.
    Ok(())
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
            HTCLIENT, MA_NOACTIVATE, WM_DPICHANGED, WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE,
            WM_MOUSEACTIVATE, WM_NCDESTROY, WM_NCHITTEST, WM_NCLBUTTONDOWN, WM_NCMBUTTONDOWN,
            WM_NCRBUTTONDOWN, WM_SETTINGCHANGE, WM_SIZE,
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
    if message == WM_NCDESTROY {
        RemoveWindowSubclass(hwnd, Some(resize_subclass), id);
        let result = DefSubclassProc(hwnd, message, wparam, lparam);
        drop(Box::from_raw(data as *mut PanelSubclass));
        return result;
    }
    let result = DefSubclassProc(hwnd, message, wparam, lparam);
    // Run after Tauri's WM_SIZE handler rewrites the overlay region. DPI/settings
    // changes also refresh the metrics even if the client size has not changed.
    if matches!(message, WM_SIZE | WM_DPICHANGED | WM_SETTINGCHANGE) {
        if let Err(error) = update_resize_overlay(hwnd) {
            eprintln!("{error}");
        }
    }
    if let Some(return_focus) = return_focus {
        // Wry focuses WebView2 on entering a native move/resize loop. Hand back AFTER it,
        // and again after the gesture, including a title press that never becomes a drag.
        return_focus();
    }
    result
}

/// Tauri owns this overlay's size/lifetime. Its original shadow handler returns
/// HTTOP for every pixel in SM_CYFRAME, swallowing title presses and corner directions.
/// The adapted region and hit test reserve the system resize border and delegate the
/// title interior below it to WebView2, without changing Tao's client origin.
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
            WM_WINDOWPOSCHANGED,
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
    let result = DefSubclassProc(hwnd, message, wparam, lparam);
    // Tauri also resets the region outside WM_SIZE when updating shadows, and sizes
    // this child asynchronously. Catch both through its position/region notification.
    if message == WM_WINDOWPOSCHANGED {
        if let Err(error) = update_resize_overlay(parent) {
            eprintln!("{error}");
        }
    }
    result
}

#[cfg(windows)]
unsafe fn panel_resize_hit(
    hwnd: windows_sys::Win32::Foundation::HWND,
    lparam: isize,
) -> Option<geometry::ResizeHit> {
    use windows_sys::Win32::{Foundation::RECT, UI::WindowsAndMessaging::GetWindowRect};
    let mut rect = RECT::default();
    if GetWindowRect(hwnd, &mut rect) == 0 {
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
