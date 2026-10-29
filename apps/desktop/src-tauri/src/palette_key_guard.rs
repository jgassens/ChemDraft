//! A palette click precedes its webview's asynchronous focus IPC. Until the DOM
//! classifies that click, keys still addressed to the document must be dropped.
//! This runs before native accelerators as well as before webview key delivery.

use std::sync::Mutex;

static POINTER_OWNER: Mutex<Option<String>> = Mutex::new(None);

#[cfg(any(target_os = "macos", windows))]
pub(super) fn pointer(label: Option<&str>) {
    *POINTER_OWNER.lock().unwrap() = label.map(str::to_owned);
}

pub(super) fn release(label: &str) {
    let mut owner = POINTER_OWNER.lock().unwrap();
    if owner.as_deref() == Some(label) {
        *owner = None;
    }
}

pub(crate) fn blocks_document() -> bool {
    POINTER_OWNER.lock().unwrap().is_some()
}

#[cfg(any(target_os = "macos", windows))]
pub(super) fn is_palette(label: &str) -> bool {
    label.starts_with("toolset-") && super::super::is_input_focus_window_label(label)
}

#[cfg(target_os = "macos")]
pub(super) fn install<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    use objc2::{
        rc::Retained,
        runtime::{AnyObject, ProtocolObject},
    };
    use objc2_app_kit::{
        NSApplicationDidResignActiveNotification, NSEvent, NSEventMask, NSEventType, NSWindow,
    };
    use objc2_foundation::{NSNotification, NSNotificationCenter, NSObjectProtocol};
    use std::{cell::RefCell, ptr::NonNull};
    use tauri::Manager;

    thread_local! {
        // One application-local monitor, retained for the lifetime of the event loop.
        static MONITOR: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
        static DEACTIVATION: RefCell<Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>> = const { RefCell::new(None) };
    }
    MONITOR.with(|monitor| {
        if monitor.borrow().is_some() {
            return Ok(());
        }
        let app = window.app_handle().clone();
        let callback = block2::RcBlock::new(move |event: NonNull<NSEvent>| {
            let native = unsafe { event.as_ref() };
            let label = app
                .webview_windows()
                .into_iter()
                .find_map(|(label, window)| {
                    let pointer = window.ns_window().ok()? as *mut NSWindow;
                    let window = unsafe { pointer.as_ref() }?;
                    (window.windowNumber() == native.windowNumber()).then_some(label)
                });
            if matches!(native.r#type(), NSEventType::KeyDown | NSEventType::KeyUp) {
                if label.as_deref() == Some(super::super::MAIN_WINDOW_LABEL) && blocks_document() {
                    return std::ptr::null_mut();
                }
            } else if native.r#type() == NSEventType::LeftMouseDown {
                pointer(label.as_deref().filter(|label| is_palette(label)));
            } else {
                pointer(None);
            }
            event.as_ptr()
        });
        let token = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                NSEventMask::LeftMouseDown
                    | NSEventMask::RightMouseDown
                    | NSEventMask::OtherMouseDown
                    | NSEventMask::KeyDown
                    | NSEventMask::KeyUp,
                &callback,
            )
        }
        .ok_or("Could not guard palette keyboard acquisition.")?;
        *monitor.borrow_mut() = Some(token);
        let resigned = block2::RcBlock::new(move |_: NonNull<NSNotification>| pointer(None));
        DEACTIVATION.with(|observer| {
            *observer.borrow_mut() = Some(unsafe {
                NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                    Some(NSApplicationDidResignActiveNotification),
                    None,
                    None,
                    &resigned,
                )
            });
        });
        Ok(())
    })
}

#[cfg(windows)]
mod windows {
    use std::{cell::RefCell, rc::Rc};
    use tauri::Manager;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetAncestor, SetWindowsHookExW, GA_ROOT, HHOOK, MSG, PM_REMOVE,
        WH_GETMESSAGE, WM_KEYFIRST, WM_KEYLAST, WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_NCLBUTTONDOWN,
        WM_NCMBUTTONDOWN, WM_NCRBUTTONDOWN, WM_NULL, WM_RBUTTONDOWN,
    };

    type Observe = Rc<dyn Fn(usize, bool) -> bool>;
    thread_local! {
        static MONITOR: RefCell<Option<(HHOOK, Observe)>> = const { RefCell::new(None) };
    }

    unsafe extern "system" fn messages(code: i32, wparam: usize, lparam: isize) -> isize {
        if code >= 0 && wparam == PM_REMOVE as usize {
            let message = &mut *(lparam as *mut MSG);
            let key = (WM_KEYFIRST..=WM_KEYLAST).contains(&message.message);
            if matches!(
                message.message,
                WM_RBUTTONDOWN
                    | WM_MBUTTONDOWN
                    | WM_NCLBUTTONDOWN
                    | WM_NCRBUTTONDOWN
                    | WM_NCMBUTTONDOWN
            ) {
                super::pointer(None);
            } else if key || message.message == WM_LBUTTONDOWN {
                let observe =
                    MONITOR.with(|monitor| monitor.borrow().as_ref().map(|(_, f)| f.clone()));
                if let Some(observe) = observe {
                    if observe(GetAncestor(message.hwnd, GA_ROOT) as usize, key) {
                        // Remove the message before TranslateAccelerator/TranslateMessage,
                        // including character messages already queued by the webview.
                        message.message = WM_NULL;
                        message.wParam = 0;
                        message.lParam = 0;
                    }
                }
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }

    pub(crate) fn install<R: tauri::Runtime>(
        window: &tauri::WebviewWindow<R>,
    ) -> Result<(), String> {
        MONITOR.with(|monitor| {
            if monitor.borrow().is_some() {
                return Ok(());
            }
            let app = window.app_handle().clone();
            let observe: Observe = Rc::new(move |root, key| {
                let label = app
                    .webview_windows()
                    .into_iter()
                    .find_map(|(label, window)| {
                        (window.hwnd().ok()?.0 as usize == root).then_some(label)
                    });
                if key {
                    label.as_deref() == Some(super::super::super::MAIN_WINDOW_LABEL)
                        && super::blocks_document()
                } else {
                    super::pointer(label.as_deref().filter(|label| super::is_palette(label)));
                    false
                }
            });
            let hook = unsafe {
                SetWindowsHookExW(
                    WH_GETMESSAGE,
                    Some(messages),
                    std::ptr::null_mut(),
                    windows_sys::Win32::System::Threading::GetCurrentThreadId(),
                )
            };
            if hook.is_null() {
                return Err(format!(
                    "Could not guard palette keyboard acquisition: {}",
                    std::io::Error::last_os_error()
                ));
            }
            *monitor.borrow_mut() = Some((hook, observe));
            Ok(())
        })
    }
}

#[cfg(windows)]
pub(super) use windows::install;

#[cfg(not(any(target_os = "macos", windows)))]
pub(super) fn install<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    Ok(())
}
