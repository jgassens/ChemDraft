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

/// Fix an X11/XWayland content-fit palette at `size`, and mark its position as user-chosen.
///
/// Linux palettes stay GTK-resizable: GTK 3 holds a non-resizable X11 window to at least 200x200.
/// Min = max size hints are what keep the user from resizing them instead. Set them before every
/// content-fit resize, because GTK clamps a resize to the window's current hints.
///
/// The same hints carry USPosition/PPosition. Without them KWin places a palette as a new window
/// each time it is mapped again, for example after a Save or Open dialog hid it
/// (utility_suspension), and that new position was then saved. Every
/// gtk_window_set_geometry_hints call replaces the whole set, so size and position go together.
/// Tao only rewrites these hints from set_min_size/set_max_size, which palettes never call.
#[cfg(target_os = "linux")]
pub(super) fn pin_content_fit_frame<R: Runtime>(
    window: &tauri::Window<R>,
    size: tauri::Size,
) -> Result<(), String> {
    let target = window.clone();
    super::run_on_main_thread_blocking(window, move || {
        use gtk::{
            gdk,
            prelude::{GtkWindowExt, WidgetExt},
        };

        let native = target.gtk_window().map_err(|error| error.to_string())?;
        // Tao's own set_size conversion: GTK sizes are logical at the window's integer scale.
        let (width, height): (i32, i32) = size
            .to_logical::<i32>(f64::from(native.scale_factor()))
            .into();
        let geometry = gdk::Geometry::new(
            width,
            height,
            width,
            height,
            0,
            0,
            0,
            0,
            0.0,
            0.0,
            gdk::Gravity::NorthWest,
        );
        native.set_geometry_hints(
            None::<&gtk::Window>,
            Some(&geometry),
            gdk::WindowHints::MIN_SIZE
                | gdk::WindowHints::MAX_SIZE
                | gdk::WindowHints::POS
                | gdk::WindowHints::USER_POS,
        );
        Ok(())
    })?
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
