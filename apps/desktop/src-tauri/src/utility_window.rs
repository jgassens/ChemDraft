use tauri::{AppHandle, Runtime, WebviewWindow};

#[derive(Clone, Copy)]
pub(super) enum Kind {
    Toolbar,
    Popover,
    Tooltip,
    FileWarnings,
}

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, PartialEq, Eq)]
enum TypeHint {
    Utility,
    Tooltip,
}

#[cfg(any(target_os = "linux", test))]
struct Policy {
    hint: TypeHint,
    skip_taskbar: bool,
    skip_pager: bool,
    focus_on_map: bool,
}

#[cfg(any(target_os = "linux", test))]
fn linux_policy(kind: Kind, native_wayland: bool) -> Policy {
    Policy {
        // Keep the Wayland tooltip a transient toplevel. The compositor places it without
        // a popup grab or global anchor.
        hint: match kind {
            Kind::Tooltip if !native_wayland => TypeHint::Tooltip,
            Kind::Toolbar | Kind::Popover | Kind::Tooltip | Kind::FileWarnings => TypeHint::Utility,
        },
        skip_taskbar: true,
        skip_pager: true,
        focus_on_map: false,
    }
}

#[cfg(target_os = "linux")]
pub(super) fn uses_native_wayland<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    super::run_on_main_thread_blocking(app, || {
        use gtk::gdk::prelude::DisplayExtManual;
        gtk::gdk::Display::default().is_some_and(|display| display.backend().is_wayland())
    })
}

#[cfg(not(target_os = "linux"))]
pub(super) fn uses_native_wayland<R: Runtime>(_app: &AppHandle<R>) -> Result<bool, String> {
    Ok(false)
}

#[cfg(target_os = "linux")]
pub(super) fn prepare<R: Runtime>(
    window: &WebviewWindow<R>,
    kind: Kind,
    native_wayland: bool,
) -> Result<(), String> {
    let target = window.clone();
    let prepared = super::run_on_main_thread_blocking(window, move || {
        use gtk::{gdk::WindowTypeHint, prelude::GtkWindowExt};

        let native = target.gtk_window().map_err(|error| error.to_string())?;
        let policy = linux_policy(kind, native_wayland);
        native.set_type_hint(match policy.hint {
            TypeHint::Utility => WindowTypeHint::Utility,
            TypeHint::Tooltip => WindowTypeHint::Tooltip,
        });
        native.set_skip_taskbar_hint(policy.skip_taskbar);
        native.set_skip_pager_hint(policy.skip_pager);
        // The transient parent supplies relative stacking. Leave GTK's focus acceptance
        // under the existing input lease so a palette field can take the keyboard on demand.
        native.set_focus_on_map(policy.focus_on_map);
        Ok(())
    })
    .and_then(|result| result);
    super::panel_window::finish_installation(prepared, || {
        window.destroy().map_err(|error| error.to_string())
    })
}

#[cfg(not(target_os = "linux"))]
pub(super) fn prepare<R: Runtime>(
    _window: &WebviewWindow<R>,
    _kind: Kind,
    _native_wayland: bool,
) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "linux")]
pub(super) fn set_visible<R: Runtime>(
    window: &WebviewWindow<R>,
    visible: bool,
) -> Result<(), String> {
    let target = window.clone();
    super::run_on_main_thread_blocking(window, move || {
        use gtk::prelude::WidgetExt;

        let native = target.gtk_window().map_err(|error| error.to_string())?;
        // Use the same GTK calls as Tao's queued visibility requests. The popover reveal
        // reads visibility before returning to the webview, so it needs the change now.
        if visible {
            native.show_all();
        } else {
            native.hide();
        }
        Ok(())
    })?
}

#[cfg(not(target_os = "linux"))]
pub(super) fn set_visible<R: Runtime>(
    window: &WebviewWindow<R>,
    visible: bool,
) -> Result<(), String> {
    if visible {
        window.show()
    } else {
        window.hide()
    }
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{linux_policy, Kind, TypeHint};

    #[test]
    fn linux_utility_hints_and_flags_cover_every_window_kind() {
        for (kind, x11_hint) in [
            (Kind::Toolbar, TypeHint::Utility),
            (Kind::Popover, TypeHint::Utility),
            (Kind::Tooltip, TypeHint::Tooltip),
            (Kind::FileWarnings, TypeHint::Utility),
        ] {
            let x11 = linux_policy(kind, false);
            let wayland = linux_policy(kind, true);
            assert_eq!(x11.hint, x11_hint);
            assert_eq!(wayland.hint, TypeHint::Utility);
            for policy in [x11, wayland] {
                assert!(policy.skip_taskbar);
                assert!(policy.skip_pager);
                assert!(!policy.focus_on_map);
            }
        }
    }
}
