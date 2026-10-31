use std::{collections::HashMap, sync::Mutex};
use tauri::{Emitter, Manager, Runtime};

use super::panel_window_frame::{Frame, Placement};

pub(super) const EVENT: &str = "chemdraft://plugin-panel-full-size";

pub(super) fn authorize(label: &str) -> Result<(), String> {
    if super::is_plugin_panel_window_label(label) {
        Ok(())
    } else {
        Err("Only a ChemDraft panel window may control its full size state.".into())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
pub(super) struct Status {
    pub enabled: bool,
}

#[derive(Default)]
pub(super) struct State(Mutex<HashMap<String, Enlargement>>);

impl State {
    fn restore(
        &self,
        label: &str,
        apply: impl FnOnce(Frame) -> Result<(), String>,
    ) -> Result<bool, String> {
        let normal = self
            .0
            .lock()
            .unwrap()
            .entry(label.into())
            .or_default()
            .begin_restore();
        let Some(normal) = normal else {
            return Ok(false);
        };
        // Release the lock for native callbacks, but retain the guard and normal frame until the
        // synchronous application and persistence finish, including any reentrant hide callback.
        let result = apply(normal);
        self.0
            .lock()
            .unwrap()
            .entry(label.into())
            .or_default()
            .finish_restore(result.is_ok());
        result.map(|()| true)
    }
}

#[derive(Default)]
struct Enlargement {
    normal: Option<Frame>,
    restoring: bool,
}

impl Enlargement {
    fn enable(&mut self, normal: Frame) -> bool {
        if self.normal.is_some() {
            return false;
        }
        self.normal = Some(normal);
        true
    }

    fn for_save(&self, live: impl FnOnce() -> Option<Frame>) -> Option<Frame> {
        self.normal.clone().or_else(live)
    }

    fn begin_restore(&mut self) -> Option<Frame> {
        if self.restoring {
            return None;
        }
        let normal = self.normal.clone()?;
        self.restoring = true;
        Some(normal)
    }

    fn finish_restore(&mut self, success: bool) {
        if success {
            self.normal = None;
        }
        self.restoring = false;
    }
}

pub(super) fn frame_for_save<R: Runtime>(window: &tauri::Window<R>) -> Option<Frame> {
    let normal = window
        .state::<State>()
        .0
        .lock()
        .unwrap()
        .get(window.label())
        .and_then(|state| state.for_save(|| None));
    normal.or_else(|| super::current_plugin_panel_geometry(window))
}

#[cfg(target_os = "macos")]
pub(super) fn apply<R: Runtime>(
    window: &tauri::Window<R>,
    placement: Placement,
) -> Result<(), String> {
    use objc2_app_kit::{NSScreen, NSWindow};
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    let mtm = objc2::MainThreadMarker::new().ok_or("Panel placement requires the main thread.")?;
    let pointer = window.ns_window().map_err(|error| error.to_string())? as *mut NSWindow;
    // SAFETY: this live Tauri window owns the NSWindow and we are on the main thread.
    let native = unsafe { pointer.as_ref() }.ok_or("Could not access the native panel window.")?;
    // The first screen carries the menu bar and defines AppKit's global coordinate origin.
    let primary = NSScreen::screens(mtm)
        .firstObject()
        .ok_or("The primary screen is unavailable.")?;
    let content = NSRect::new(
        NSPoint::new(0.0, 0.0),
        NSSize::new(
            f64::from(placement.size.0) / placement.scale,
            f64::from(placement.size.1) / placement.scale,
        ),
    );
    let outer = native.frameRectForContentRect(content);
    let frame = placement.appkit_frame(
        primary.frame().size.height,
        (
            outer.size.width - content.size.width,
            outer.size.height - content.size.height,
        ),
    );
    native.setFrame_display(
        NSRect::new(
            NSPoint::new(frame.x, frame.y),
            NSSize::new(frame.width, frame.height),
        ),
        true,
    );
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub(super) fn apply<R: Runtime>(
    window: &tauri::Window<R>,
    placement: Placement,
) -> Result<(), String> {
    // On the UI thread Tauri dispatches inline; Win32 completes each SetWindowPos before returning.
    placement.apply(
        |(x, y)| {
            window
                .set_position(tauri::PhysicalPosition::new(x, y))
                .map_err(|e| e.to_string())
        },
        |(width, height)| {
            window
                .set_size(tauri::PhysicalSize::new(width, height))
                .map_err(|e| e.to_string())
        },
    )
}

fn notify<R: Runtime>(window: &tauri::Window<R>, enabled: bool) -> Status {
    let status = Status { enabled };
    if let Err(error) = window.emit_to(window.label(), EVENT, status) {
        eprintln!("Could not notify panel full size state: {error}");
    }
    status
}

// Called only on the UI thread. Retain the normal frame until native frame application and its
// persistence succeed; synchronous native move/resize callbacks must never observe the large frame.
pub(super) fn set<R: Runtime>(
    window: &tauri::Window<R>,
    enabled: bool,
    width: f64,
    height: f64,
) -> Result<Status, String> {
    let state = window.state::<State>();
    let already_enabled = state
        .0
        .lock()
        .unwrap()
        .get(window.label())
        .is_some_and(|s| s.normal.is_some());
    if enabled == already_enabled {
        return Ok(Status { enabled });
    }
    if !enabled {
        return restore(window);
    }
    if window.is_minimized().map_err(|e| e.to_string())?
        || window.is_fullscreen().map_err(|e| e.to_string())?
    {
        return Err("Restore the panel before enlarging it.".into());
    }
    let normal =
        super::current_plugin_panel_geometry(window).ok_or("Could not read the panel frame.")?;
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("The panel's monitor is unavailable.")?;
    let monitor = super::panel_window_frame::Monitor::from_native(&monitor);
    let inner = window.inner_size().map_err(|e| e.to_string())?;
    let outer = window.outer_size().map_err(|e| e.to_string())?;
    let border = (
        f64::from(outer.width.saturating_sub(inner.width)) / monitor.scale,
        f64::from(outer.height.saturating_sub(inner.height)) / monitor.scale,
    );
    let placement = normal
        .enlarged(width, height, border, &monitor)
        .ok_or("Invalid full size dimensions or monitor work area.")?;
    state
        .0
        .lock()
        .unwrap()
        .entry(window.label().into())
        .or_default()
        .enable(normal.clone());
    // Write before resizing as well: a crash while enlarged must retain the latest normal frame.
    if let Err(error) =
        super::save_plugin_panel_frame(window, normal).and_then(|()| apply(window, placement))
    {
        let _ = restore(window);
        return Err(error);
    }
    Ok(notify(window, true))
}

fn restore<R: Runtime>(window: &tauri::Window<R>) -> Result<Status, String> {
    let state = window.state::<State>();
    let restored = state.restore(window.label(), |normal| {
        let (placement, restored) =
            super::plugin_panel_restore_geometry(window.app_handle(), &normal)
                .ok_or("Could not place the restored panel on an attached monitor.")?;
        apply(window, placement)?;
        // Save the target rather than reading back a minimized owner's parking coordinates.
        super::save_plugin_panel_frame(window, restored)
    })?;
    Ok(if restored {
        notify(window, false)
    } else {
        Status { enabled: false }
    })
}

pub(super) fn will_hide<R: Runtime>(window: &tauri::Window<R>) {
    if let Err(error) = set(window, false, 0.0, 0.0) {
        // Preserve the normal frame even if the OS refuses a move during teardown.
        if let Some(normal) = frame_for_save(window) {
            let _ = super::save_plugin_panel_frame(window, normal);
        }
        eprintln!(
            "Could not restore panel {} before hiding: {error}",
            window.label()
        );
    }
    if let Err(error) = super::persist_plugin_panel_geometry(window) {
        eprintln!(
            "Could not persist panel {} before hiding: {error}",
            window.label()
        );
    }
}

pub(super) fn restore_all<R: Runtime>(app: &tauri::AppHandle<R>) {
    for (label, window) in app.webview_windows() {
        if super::is_plugin_panel_window_label(&label) {
            let webview: &tauri::Webview<R> = window.as_ref();
            will_hide(&webview.window());
        }
    }
}

pub(super) fn forget<R: Runtime>(window: &tauri::Window<R>) {
    window
        .state::<State>()
        .0
        .lock()
        .unwrap()
        .remove(window.label());
}

#[cfg(test)]
mod tests {
    use super::super::panel_window_frame::MonitorIdentity;
    use super::*;

    fn frame(width: f64) -> Frame {
        Frame {
            monitor: MonitorIdentity {
                name: Some("display".into()),
                position: (1920, 0),
                size: (3840, 2160),
            },
            x: 100.0,
            y: 50.0,
            width,
            height: 500.0,
        }
    }

    #[test]
    fn full_size_authorization_uses_only_the_injected_panel_label() {
        assert!(authorize("plugin-panel-v1x61x62").is_ok());
        for label in [
            "main",
            "preferences",
            "toolset-core-main",
            "plugin-panel-",
            "dialog-export",
            "",
        ] {
            assert!(authorize(label).is_err(), "{label}");
        }
    }

    #[test]
    fn enlarged_and_restoring_states_persist_only_the_original_normal_frame() {
        let normal = frame(600.0);
        let mut state = Enlargement::default();
        assert_eq!(
            state.for_save(|| Some(normal.clone())),
            Some(normal.clone())
        );
        assert!(state.enable(normal.clone()));
        assert!(!state.enable(frame(1200.0)));
        assert_eq!(
            state.for_save(|| panic!("must not read the enlarged frame")),
            Some(normal.clone())
        );
        assert_eq!(state.begin_restore(), Some(normal.clone()));
        assert_eq!(state.begin_restore(), None);
        assert_eq!(state.for_save(|| Some(frame(1200.0))), Some(normal.clone()));
        state.finish_restore(false);
        assert_eq!(state.begin_restore(), Some(normal));
        state.finish_restore(true);
        assert_eq!(state.begin_restore(), None);
        assert_eq!(state.for_save(|| Some(frame(700.0))), Some(frame(700.0)));
    }

    #[test]
    fn restore_holds_guard_through_injected_apply_and_save_with_reentrant_hide() {
        let normal = frame(600.0);
        let state = State::default();
        state
            .0
            .lock()
            .unwrap()
            .entry("panel".into())
            .or_default()
            .enable(normal.clone());
        let live = std::cell::RefCell::new(frame(1200.0));
        let persisted = std::cell::RefCell::new(Vec::new());
        let hide = || {
            assert!(!state
                .restore("panel", |_| panic!("must not reenter frame application"))
                .unwrap());
            let states = state.0.lock().unwrap();
            assert!(states["panel"].restoring);
            persisted
                .borrow_mut()
                .push(states["panel"].for_save(|| Some(live.borrow().clone())));
        };
        assert!(state
            .restore("panel", |target| {
                assert_eq!(target, normal);
                // A hide before or during the native operation still sees the saved normal frame.
                hide();
                Placement {
                    position: (2200, 160),
                    size: (1200, 1000),
                    scale: 2.0,
                }
                .apply(
                    |_| {
                        hide();
                        Ok::<(), String>(())
                    },
                    |_| {
                        hide();
                        *live.borrow_mut() = target;
                        Ok(())
                    },
                )?;
                // Persistence also runs before the guard is released.
                hide();
                Ok(())
            })
            .unwrap());
        assert_eq!(*persisted.borrow(), vec![Some(normal); 4]);
        let states = state.0.lock().unwrap();
        assert!(!states["panel"].restoring);
        assert!(states["panel"].normal.is_none());
        assert_eq!(
            states["panel"].for_save(|| Some(live.borrow().clone())),
            Some(frame(600.0))
        );
    }

    #[test]
    fn failed_injected_restore_keeps_normal_frame_and_allows_retry() {
        let state = State::default();
        state
            .0
            .lock()
            .unwrap()
            .entry("panel".into())
            .or_default()
            .enable(frame(600.0));
        let error = "Native frame application failed.";
        assert_eq!(
            state.restore("panel", |_| Err(error.into())),
            Err(error.into())
        );
        {
            let states = state.0.lock().unwrap();
            assert!(!states["panel"].restoring);
            assert_eq!(
                states["panel"].for_save(|| Some(frame(1200.0))),
                Some(frame(600.0))
            );
        }
        assert!(state.restore("panel", |_| Ok(())).unwrap());
        assert!(!state
            .restore("panel", |_| panic!("already restored"))
            .unwrap());
    }

    #[test]
    fn each_panel_has_independent_full_size_state_and_status_contract() {
        let mut states = HashMap::<String, Enlargement>::new();
        states.entry("a".into()).or_default().enable(frame(600.0));
        states.entry("b".into()).or_default().enable(frame(700.0));
        states.get_mut("a").unwrap().begin_restore();
        states.get_mut("a").unwrap().finish_restore(true);
        assert!(states["a"].normal.is_none());
        assert_eq!(states["b"].normal, Some(frame(700.0)));
        assert_eq!(
            serde_json::to_value(Status { enabled: false }).unwrap(),
            serde_json::json!({"enabled": false})
        );
    }
}
