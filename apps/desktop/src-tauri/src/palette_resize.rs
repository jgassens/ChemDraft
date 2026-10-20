//! Native resize provenance. A generic Resized event is never evidence of user intent.
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{Emitter, Manager, Runtime};

/// Only a native user resize start can mint a completion token. Consuming it also
/// makes duplicate end notifications harmless; lifecycle changes invalidate older tokens.
#[cfg(any(windows, target_os = "macos", test))]
#[derive(Default)]
struct Gesture {
    lifecycle: Option<u64>,
}

#[cfg(any(windows, target_os = "macos", test))]
impl Gesture {
    fn begin(&mut self, lifecycle: u64) {
        self.lifecycle = Some(lifecycle);
    }

    fn cancel(&mut self) {
        self.lifecycle = None;
    }

    fn complete(&mut self, lifecycle: u64) -> bool {
        self.lifecycle.take() == Some(lifecycle)
    }

    #[cfg(any(windows, test))]
    fn active(&self) -> bool {
        self.lifecycle.is_some()
    }
}

static LIFECYCLE: AtomicU64 = AtomicU64::new(0);

pub(super) fn invalidate<R: Runtime>(app: &tauri::AppHandle<R>) {
    LIFECYCLE.fetch_add(1, Ordering::SeqCst);
    for window in app.webview_windows().into_values() {
        if super::toolset_id_for_window_label(app, window.label()).is_some() {
            emit(&window, "cancel");
        }
    }
}

#[derive(Clone, serde::Serialize)]
struct Payload {
    phase: &'static str,
    width: f64,
    height: f64,
}

fn emit<R: Runtime>(window: &tauri::WebviewWindow<R>, phase: &'static str) {
    if phase != "cancel" && !super::can_save_palette_frame(window) {
        emit(window, "cancel");
        return;
    }
    if let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) {
        let _ = window.emit_to(
            window.label(),
            "chemdraft://palette-native-resize",
            Payload {
                phase,
                width: size.width as f64 / scale,
                height: size.height as f64 / scale,
            },
        );
    }
}

pub(super) fn capability(label: &str) -> tauri::ipc::CapabilityBuilder {
    tauri::ipc::CapabilityBuilder::new(format!("{label}-resize"))
        .window(label)
        .permission("core:window:allow-start-resize-dragging")
        .permission("core:window:allow-set-min-size")
        .permission("allow-can-persist-toolset-size")
}

pub(super) fn grant<R: Runtime>(app: &tauri::AppHandle<R>, label: &str) -> Result<(), String> {
    app.add_capability(capability(label))
        .map_err(|error| error.to_string())
}

pub(super) fn install<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    #[cfg(windows)]
    {
        let target = window.clone();
        super::run_on_main_thread_blocking(window, move || windows::install(target))??;
    }
    #[cfg(not(windows))]
    let _ = window;
    Ok(())
}

#[cfg(windows)]
mod windows {
    use super::*;
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        UI::{
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::{
                WM_DPICHANGED, WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_NCDESTROY, WM_SHOWWINDOW,
                WM_SIZING,
            },
        },
    };

    struct State<R: Runtime> {
        window: tauri::WebviewWindow<R>,
        gesture: Gesture,
        invalid: bool,
        loop_lifecycle: u64,
    }

    pub(super) fn install<R: Runtime>(window: tauri::WebviewWindow<R>) -> Result<(), String> {
        let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as HWND;
        let state = Box::into_raw(Box::new(State {
            window,
            gesture: Gesture::default(),
            invalid: false,
            loop_lifecycle: 0,
        }));
        if unsafe { SetWindowSubclass(hwnd, Some(callback::<R>), 0x43445253, state as usize) } == 0
        {
            unsafe {
                drop(Box::from_raw(state));
            }
            return Err("Could not observe native toolbar resizing.".into());
        }
        Ok(())
    }

    unsafe extern "system" fn callback<R: Runtime>(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        id: usize,
        data: usize,
    ) -> LRESULT {
        let state = &mut *(data as *mut State<R>);
        match message {
            WM_ENTERSIZEMOVE => {
                state.gesture.cancel();
                state.invalid = false;
                state.loop_lifecycle = LIFECYCLE.load(Ordering::SeqCst);
            }
            WM_SIZING
                if !state.invalid
                    && !state.gesture.active()
                    && state.loop_lifecycle == LIFECYCLE.load(Ordering::SeqCst) =>
            {
                state.gesture.begin(state.loop_lifecycle);
                emit(&state.window, "start");
            }
            // A monitor transition can occur during the same native size/move loop.
            WM_DPICHANGED => {
                state.invalid = true;
                state.gesture.cancel();
                emit(&state.window, "cancel");
            }
            WM_SHOWWINDOW if wparam == 0 => {
                state.invalid = true;
                state.gesture.cancel();
                emit(&state.window, "cancel");
            }
            WM_EXITSIZEMOVE => {
                if state.gesture.complete(LIFECYCLE.load(Ordering::SeqCst)) && !state.invalid {
                    emit(&state.window, "end");
                }
            }
            WM_NCDESTROY => {
                RemoveWindowSubclass(hwnd, Some(callback::<R>), id);
                drop(Box::from_raw(data as *mut State<R>));
            }
            _ => {}
        }
        DefSubclassProc(hwnd, message, wparam, lparam)
    }
}

#[cfg(target_os = "macos")]
pub(super) fn observe<R: Runtime>(app: tauri::AppHandle<R>) {
    use objc2_foundation::{NSNotification, NSNotificationCenter, NSString};
    use std::{
        collections::HashMap,
        ptr::NonNull,
        sync::{Arc, Mutex},
    };
    let gestures = Arc::new(Mutex::new(HashMap::<usize, Gesture>::new()));
    let center = NSNotificationCenter::defaultCenter();
    // Process-lifetime observers avoid replacing Tao's NSWindow delegate. Each notification is
    // resolved against the current native window, so destruction cannot retain a stale webview.
    for (name, phase) in [
        ("NSWindowWillStartLiveResizeNotification", "start"),
        ("NSWindowDidEndLiveResizeNotification", "end"),
        ("NSWindowDidChangeBackingPropertiesNotification", "cancel"),
        ("NSWindowWillCloseNotification", "cancel"),
        ("NSWindowDidMiniaturizeNotification", "cancel"),
        ("NSApplicationWillHideNotification", "cancel-all"),
    ] {
        let app = app.clone();
        let gestures = gestures.clone();
        let block = block2::RcBlock::new(move |notification: NonNull<NSNotification>| {
            if phase == "cancel-all" {
                invalidate(&app);
                if let Ok(mut active) = gestures.lock() {
                    active.clear();
                }
                return;
            }
            let Some(object) = (unsafe { notification.as_ref() }).object() else {
                return;
            };
            let pointer = &*object as *const _ as usize;
            let Ok(mut active) = gestures.lock() else {
                return;
            };
            let window = app.webview_windows().into_values().find(|window| {
                window
                    .ns_window()
                    .is_ok_and(|native| native as usize == pointer)
                    && super::toolset_id_for_window_label(&app, window.label()).is_some()
            });
            let Some(window) = window else {
                active.remove(&pointer);
                return;
            };
            if phase == "cancel" {
                if let Some(mut gesture) = active.remove(&pointer) {
                    gesture.cancel();
                }
                drop(active);
                emit(&window, "cancel");
            } else if phase == "start" {
                let mut gesture = Gesture::default();
                gesture.begin(LIFECYCLE.load(Ordering::SeqCst));
                active.insert(pointer, gesture);
                drop(active);
                emit(&window, "start");
            } else if active
                .remove(&pointer)
                .is_some_and(|mut gesture| gesture.complete(LIFECYCLE.load(Ordering::SeqCst)))
            {
                drop(active);
                emit(&window, "end");
            }
        });
        unsafe {
            std::mem::forget(center.addObserverForName_object_queue_usingBlock(
                Some(&NSString::from_str(name)),
                None,
                None,
                &block,
            ));
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub(super) fn observe<R: Runtime>(_app: tauri::AppHandle<R>) {}

#[cfg(test)]
mod tests {
    use super::Gesture;

    #[test]
    fn resize_or_move_notifications_without_user_resize_never_complete() {
        let mut gesture = Gesture::default();
        assert!(!gesture.active());
        // Content fitting, minimum-size changes and move-only loops mint no token.
        assert!(!gesture.complete(7));
        gesture.cancel();
        assert!(!gesture.complete(7));
    }

    #[test]
    fn user_resize_completes_exactly_once() {
        let mut gesture = Gesture::default();
        gesture.begin(7);
        assert!(gesture.active());
        assert!(gesture.complete(7));
        assert!(!gesture.active());
        assert!(!gesture.complete(7));
    }

    #[test]
    fn dpi_or_hide_cancellation_rejects_late_completion() {
        let mut gesture = Gesture::default();
        gesture.begin(7);
        gesture.cancel();
        assert!(!gesture.complete(7));
        // A later independent native resize can still complete.
        gesture.begin(7);
        assert!(gesture.complete(7));
    }

    #[test]
    fn suspension_or_close_invalidates_the_previous_lifecycle() {
        let mut gesture = Gesture::default();
        gesture.begin(7);
        assert!(!gesture.complete(8));
        // A delayed duplicate cannot become valid by presenting the old epoch again.
        assert!(!gesture.complete(7));
        gesture.begin(8);
        assert!(gesture.complete(8));
    }
}
