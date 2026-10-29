//! Native pointer observation and a bounded guard while the palette page classifies
//! a click. Webview key delivery is guarded in MainWindow on BOTH platforms.

use std::{
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Listener, Manager};

#[path = "palette_key_guard_state.rs"]
mod state;
pub(crate) use state::End;
pub(crate) use state::{blocks_menu, keeps_palette_focus};

static GUARD: Mutex<state::Guard> = Mutex::new(state::Guard::new());
const EVENT: &str = "chemdraft://palette-click-pending";

fn now() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

fn publish<R: tauri::Runtime>(app: &tauri::AppHandle<R>, label: &str, event: Option<state::Event>) {
    if let Some(event) = event {
        // The page echoes the click sequence with its classification/release. Main
        // drops only editing keydowns until this sequence is cleared or expires.
        let _ = app.emit_to(super::super::MAIN_WINDOW_LABEL, EVENT, event);
        if !label.is_empty() && label != super::super::MAIN_WINDOW_LABEL {
            let _ = app.emit_to(label, EVENT, event);
        }
    }
}

pub(super) fn end<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    label: &str,
    why: End,
    sequence: Option<u64>,
    before: u64,
) {
    let event = GUARD.lock().unwrap().end(label, why, sequence, before);
    publish(app, label, event);
}

/// The active document's WebView2 child may receive clicks without sending
/// WM_MOUSEACTIVATE to our thread. Its capture listener acknowledges the click.
pub(crate) fn observe_document_pointer_release<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Release {
        sequence: u64,
        pointer_before: u64,
    }
    let target = app.clone();
    app.listen("chemdraft://palette-click-outside", move |event| {
        if let Ok(release) = serde_json::from_str::<Release>(event.payload()) {
            end(
                &target,
                "",
                End::Released,
                (release.sequence != 0).then_some(release.sequence),
                release.pointer_before,
            );
        }
    });
}

pub(super) fn blocks_document() -> bool {
    GUARD.lock().unwrap().blocks(now())
}

#[cfg(any(target_os = "macos", windows))]
pub(super) fn pointer<R: tauri::Runtime>(app: &tauri::AppHandle<R>, label: Option<&str>) {
    let Some(label) = label.filter(|label| is_palette(label)) else {
        end(app, "", End::Outside, None, 0);
        return;
    };
    // There is no document-key race when this palette already holds the keyboard.
    if app
        .get_webview_window(label)
        .is_some_and(|window| super::holds_input_focus(&window))
    {
        end(app, label, End::Acquired, None, 0);
        return;
    }
    let wall_time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let event = GUARD.lock().unwrap().pointer(label, now(), wall_time);
    publish(app, label, Some(event));
    let app = app.clone();
    let label = label.to_owned();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(state::TIMEOUT_MS)).await;
        let expired = GUARD.lock().unwrap().timeout(event.sequence, now());
        publish(&app, &label, expired);
    });
}

#[cfg(any(target_os = "macos", windows))]
fn is_palette(label: &str) -> bool {
    label.starts_with("toolset-") && super::super::is_input_focus_window_label(label)
}

#[cfg(target_os = "macos")]
pub(super) fn install<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    use objc2::{
        rc::Retained,
        runtime::{AnyObject, ProtocolObject},
    };
    use objc2_app_kit::{
        NSApplicationDidResignActiveNotification, NSEvent, NSEventMask, NSEventModifierFlags,
        NSEventType, NSWindow,
    };
    use objc2_foundation::{NSNotification, NSNotificationCenter, NSObjectProtocol};
    use std::{cell::RefCell, ptr::NonNull};

    thread_local! {
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
            if native.r#type() == NSEventType::KeyDown {
                // Only KeyDown, never KeyUp. Menu equivalents may not reach the
                // webview, so this uses the same editing-key policy as MainWindow.
                let modifiers = native.modifierFlags();
                let key = native
                    .charactersIgnoringModifiers()
                    .map(|s| s.to_string())
                    .unwrap_or_default();
                if label.as_deref() == Some(super::super::MAIN_WINDOW_LABEL)
                    && blocks_document()
                    && state::editing_key(
                        &key,
                        modifiers.contains(NSEventModifierFlags::Command),
                        modifiers.contains(NSEventModifierFlags::Control),
                        modifiers.contains(NSEventModifierFlags::Option),
                    )
                {
                    return std::ptr::null_mut();
                }
            } else if native.r#type() == NSEventType::LeftMouseDown {
                pointer(&app, label.as_deref());
            } else {
                end(&app, "", End::Outside, None, 0);
            }
            event.as_ptr()
        });
        let token = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                NSEventMask::LeftMouseDown
                    | NSEventMask::RightMouseDown
                    | NSEventMask::OtherMouseDown
                    | NSEventMask::KeyDown,
                &callback,
            )
        }
        .ok_or("Could not guard palette keyboard acquisition.")?;
        *monitor.borrow_mut() = Some(token);
        let app = window.app_handle().clone();
        let resigned = block2::RcBlock::new(move |_: NonNull<NSNotification>| {
            end(&app, "", End::Deactivated, None, 0);
        });
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

// WebView2 keys belong to its browser process. Do not use a WH_GETMESSAGE hook
// on the app thread. Observe top-level mouse activation (also on the document)
// and notify the main webview, whose capture listener sees its actual keydowns.
#[cfg(windows)]
mod windows {
    use super::*;
    use std::rc::Rc;
    use windows_sys::Win32::UI::{
        Shell::{DefSubclassProc, GetWindowSubclass, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            WM_ACTIVATEAPP, WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_MOUSEACTIVATE, WM_NCDESTROY,
            WM_NCLBUTTONDOWN, WM_RBUTTONDOWN, WM_SHOWWINDOW,
        },
    };

    struct Observer {
        pointer: Rc<dyn Fn(bool)>,
        end: Rc<dyn Fn(End)>,
    }

    unsafe extern "system" fn observe(
        hwnd: windows_sys::Win32::Foundation::HWND,
        message: u32,
        wparam: usize,
        lparam: isize,
        id: usize,
        data: usize,
    ) -> isize {
        let observer = &*(data as *const Observer);
        if message == WM_MOUSEACTIVATE {
            let primary = ((lparam >> 16) & 0xffff) == WM_LBUTTONDOWN as isize;
            let pointer = observer.pointer.clone();
            pointer(primary);
        } else if matches!(message, WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_NCLBUTTONDOWN) {
            let end = observer.end.clone();
            end(End::Outside);
        } else if message == WM_ACTIVATEAPP && wparam == 0 {
            let end = observer.end.clone();
            end(End::Deactivated);
        } else if message == WM_SHOWWINDOW && wparam == 0 {
            let end = observer.end.clone();
            end(End::Hide);
        }
        if message == WM_NCDESTROY {
            let end = observer.end.clone();
            end(End::Destroy);
            RemoveWindowSubclass(hwnd, Some(observe), id);
            let result = DefSubclassProc(hwnd, message, wparam, lparam);
            drop(Box::from_raw(data as *mut Observer));
            return result;
        }
        DefSubclassProc(hwnd, message, wparam, lparam)
    }

    pub(super) fn install<R: tauri::Runtime>(
        window: &tauri::WebviewWindow<R>,
    ) -> Result<(), String> {
        let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
        const ID: usize = 3;
        let mut existing = 0;
        if unsafe { GetWindowSubclass(hwnd, Some(observe), ID, &mut existing) } != 0 {
            return Ok(());
        }
        let app = window.app_handle().clone();
        let label = window.label().to_owned();
        let end_app = app.clone();
        let end_label = label.clone();
        let data = Box::into_raw(Box::new(Observer {
            pointer: Rc::new(move |primary| pointer(&app, primary.then_some(label.as_str()))),
            end: Rc::new(move |why| {
                let label = if matches!(why, End::Deactivated) {
                    ""
                } else {
                    &end_label
                };
                end(&end_app, label, why, None, 0);
            }),
        }));
        if unsafe { SetWindowSubclass(hwnd, Some(observe), ID, data as usize) } == 0 {
            unsafe {
                drop(Box::from_raw(data));
            }
            return Err(format!(
                "Could not observe palette pointer intent: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
}

#[cfg(windows)]
pub(super) fn install<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    windows::install(window)
}

#[cfg(not(any(target_os = "macos", windows)))]
pub(super) fn install<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    Ok(())
}
