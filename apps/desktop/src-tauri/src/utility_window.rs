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
        // GTK sizes are logical at the window's integer scale. Round up, never to nearest, so the
        // min = max pin always covers the physical frame (GitHub #304).
        use super::{logical_extent_covering, physical_extent_covering};
        let gtk_scale = f64::from(native.scale_factor());
        let whole = |logical: f64| i32::try_from(physical_extent_covering(logical, 1.0));
        let (width, height) = match size {
            tauri::Size::Physical(size) => (
                logical_extent_covering(size.width, gtk_scale),
                logical_extent_covering(size.height, gtk_scale),
            ),
            // Already in GTK units: only round up to whole units.
            tauri::Size::Logical(size) => (
                whole(size.width).unwrap_or(i32::MAX),
                whole(size.height).unwrap_or(i32::MAX),
            ),
        };
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

/// Make `window` transient for `owner`, the window it must stay stacked above.
///
/// A popover that is transient for the document window is constrained only to sit above the
/// document. On KDE Plasma (XWayland) KWin maps it with focus-stealing prevention, which stacks it
/// under the active application's windows, so it opened behind the palette that owns it. KWin, like
/// other window managers, keeps a transient above its parent, so a popover transient for its
/// palette stays above that palette. Setting the parent changes no focus or activation state.
#[cfg(target_os = "linux")]
pub(super) fn set_transient_owner<R: Runtime>(
    window: &WebviewWindow<R>,
    owner: &WebviewWindow<R>,
) -> Result<(), String> {
    let target = window.clone();
    let owner = owner.clone();
    super::run_on_main_thread_blocking(window, move || {
        use gtk::prelude::{Cast, GtkWindowExt};

        let native = target.gtk_window().map_err(|error| error.to_string())?;
        let owner = owner.gtk_window().map_err(|error| error.to_string())?;
        let owner: &gtk::Window = owner.upcast_ref();
        // Rewriting an unchanged parent would only churn WM_TRANSIENT_FOR on every open.
        if native.transient_for().as_ref() != Some(owner) {
            native.set_transient_for(Some(owner));
        }
        Ok(())
    })?
}

/// Ask the window manager to raise a just-shown window, without activating it.
///
/// gdk_window_raise only sends a restack request (XRaiseWindow on X11; nothing on Wayland). Unlike
/// gtk_window_present it neither requests activation (_NET_ACTIVE_WINDOW) nor moves focus. KWin
/// honours a raise from the active application, so the window lands above that application's other
/// windows, and its transient parent (`set_transient_owner`) still keeps it above its owner.
#[cfg(target_os = "linux")]
pub(super) fn raise<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let target = window.clone();
    super::run_on_main_thread_blocking(window, move || {
        use gtk::prelude::WidgetExt;

        let native = target.gtk_window().map_err(|error| error.to_string())?;
        if let Some(surface) = native.window() {
            surface.raise();
        }
        Ok(())
    })?
}

/// Whether the window manager places a palette again each time it is mapped, so ChemDraft must
/// hold it where it was (palette_map_pin). X11 and XWayland only: a native Wayland client has no
/// global position, and macOS and Windows show a window where it was.
#[cfg(target_os = "linux")]
pub(super) fn map_replaces_position<R: Runtime>(app: &AppHandle<R>) -> bool {
    !uses_native_wayland(app).unwrap_or(true)
}

#[cfg(not(target_os = "linux"))]
pub(super) fn map_replaces_position<R: Runtime>(_app: &AppHandle<R>) -> bool {
    false
}

/// Move a mapped X11 palette to `position` (physical pixels, its outer top-left), as a pager would.
///
/// A plain move (gtk_window_move, XMoveWindow) is a client configure request, and KWin pulls a
/// window that lies inside the work area back into it after one (`keepInArea` in
/// `X11Window::configureRequest`), which is exactly the clamp being undone. `_NET_MOVERESIZE_WINDOW`
/// is handled as a request from a tool, which KWin applies as given; other EWMH window managers
/// treat it as an ordinary move. North-west gravity makes the position the frame's top-left, the
/// same point Tao reports as the outer position. Returns what it did, for the diagnostic.
#[cfg(target_os = "linux")]
pub(super) fn move_mapped<R: Runtime>(
    window: &tauri::Window<R>,
    position: (i32, i32),
) -> Result<String, String> {
    let target = window.clone();
    super::run_on_main_thread_blocking(window, move || {
        use gtk::{gdk::prelude::DisplayExtManual, glib::translate::ToGlibPtr, prelude::WidgetExt};

        let native = target.gtk_window().map_err(|error| error.to_string())?;
        let Some(surface) = native.window() else {
            return Ok("skipped:unrealized".to_string());
        };
        let display = surface.display();
        if !display.backend().is_x11() {
            return Ok("skipped:not-x11".to_string());
        }
        let window_ptr: *mut gtk::gdk::ffi::GdkWindow = surface.to_glib_none().0;
        let display_ptr: *mut gtk::gdk::ffi::GdkDisplay = display.to_glib_none().0;
        // SAFETY: GTK's main thread, an X11 display (checked above) and a realized toplevel that
        // outlives the call.
        let error = unsafe { send_net_moveresize(display_ptr, window_ptr, position) };
        display.flush();
        Ok(format!("sent:_NET_MOVERESIZE_WINDOW,x-error={error}"))
    })?
}

#[cfg(not(target_os = "linux"))]
pub(super) fn move_mapped<R: Runtime>(
    _window: &tauri::Window<R>,
    _position: (i32, i32),
) -> Result<String, String> {
    Ok("skipped:not-linux".to_string())
}

/// Xlib's XClientMessageEvent with 32-bit data, which Xlib passes as C longs.
#[cfg(target_os = "linux")]
#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code)] // Read by Xlib, never by Rust.
struct XClientMessageEvent {
    kind: std::os::raw::c_int,
    serial: std::os::raw::c_ulong,
    send_event: std::os::raw::c_int,
    display: *mut std::os::raw::c_void,
    window: std::os::raw::c_ulong,
    message_type: std::os::raw::c_ulong,
    format: std::os::raw::c_int,
    data: [std::os::raw::c_long; 5],
}

/// Xlib's XEvent: every event travels in a buffer of 24 longs.
#[cfg(target_os = "linux")]
#[repr(C)]
#[allow(dead_code)] // Read by Xlib, never by Rust.
union XEvent {
    client: XClientMessageEvent,
    pad: [std::os::raw::c_long; 24],
}

/// Send `_NET_MOVERESIZE_WINDOW` for `window` to the root window, and return the X error code the
/// GDK trap caught (0 for none).
///
/// SAFETY: GTK's main thread, an X11 `display`, and a realized `window` on it.
#[cfg(target_os = "linux")]
unsafe fn send_net_moveresize(
    display: *mut gtk::gdk::ffi::GdkDisplay,
    window: *mut gtk::gdk::ffi::GdkWindow,
    (x, y): (i32, i32),
) -> std::os::raw::c_int {
    use std::os::raw::c_long;

    const CLIENT_MESSAGE: std::os::raw::c_int = 33;
    const SUBSTRUCTURE_NOTIFY_MASK: c_long = 1 << 19;
    const SUBSTRUCTURE_REDIRECT_MASK: c_long = 1 << 20;
    const NORTH_WEST_GRAVITY: c_long = 1;
    const SET_X: c_long = 1 << 8;
    const SET_Y: c_long = 1 << 9;
    // EWMH source indication 2: a pager or other direct user action.
    const FROM_PAGER: c_long = 2 << 12;

    let xdisplay = gdk_x11_display_get_xdisplay(display);
    let xid = gdk_x11_window_get_xid(window);
    gdk_x11_display_error_trap_push(display);
    let message_type = XInternAtom(xdisplay, c"_NET_MOVERESIZE_WINDOW".as_ptr(), 0);
    let mut event = XEvent { pad: [0; 24] };
    event.client = XClientMessageEvent {
        kind: CLIENT_MESSAGE,
        serial: 0,
        send_event: 1,
        display: xdisplay,
        window: xid,
        message_type,
        format: 32,
        data: [
            NORTH_WEST_GRAVITY | SET_X | SET_Y | FROM_PAGER,
            c_long::from(x),
            c_long::from(y),
            0,
            0,
        ],
    };
    XSendEvent(
        xdisplay,
        XDefaultRootWindow(xdisplay),
        0,
        SUBSTRUCTURE_NOTIFY_MASK | SUBSTRUCTURE_REDIRECT_MASK,
        &mut event,
    );
    gdk_x11_display_error_trap_pop(display)
}

// From libgdk-3 (gdk/x11/gdkx11display.h, gdkx11window.h), which gdk-sys already links. The
// signatures are gdkx11-sys 0.18's; a GdkX11Display/GdkX11Window is its GdkDisplay/GdkWindow.
#[cfg(target_os = "linux")]
unsafe extern "C" {
    fn gdk_x11_display_get_user_time(display: *mut gtk::gdk::ffi::GdkDisplay) -> u32;
    fn gdk_x11_window_set_user_time(window: *mut gtk::gdk::ffi::GdkWindow, timestamp: u32);
    fn gdk_x11_window_get_xid(window: *mut gtk::gdk::ffi::GdkWindow) -> std::os::raw::c_ulong;
    fn gdk_x11_display_get_xdisplay(
        display: *mut gtk::gdk::ffi::GdkDisplay,
    ) -> *mut std::os::raw::c_void;
    fn gdk_x11_display_error_trap_push(display: *mut gtk::gdk::ffi::GdkDisplay);
    fn gdk_x11_display_error_trap_pop(
        display: *mut gtk::gdk::ffi::GdkDisplay,
    ) -> std::os::raw::c_int;
}

// libX11 (Xlib.h); the same declarations as palette_focus_linux.rs, plus XSendEvent.
#[cfg(target_os = "linux")]
#[link(name = "X11")]
unsafe extern "C" {
    fn XInternAtom(
        display: *mut std::os::raw::c_void,
        name: *const std::os::raw::c_char,
        only_if_exists: std::os::raw::c_int,
    ) -> std::os::raw::c_ulong;
    fn XDefaultRootWindow(display: *mut std::os::raw::c_void) -> std::os::raw::c_ulong;
    fn XSendEvent(
        display: *mut std::os::raw::c_void,
        window: std::os::raw::c_ulong,
        propagate: std::os::raw::c_int,
        event_mask: std::os::raw::c_long,
        event: *mut XEvent,
    ) -> std::os::raw::c_int;
}

/// The X11 user time of the input that opened each popover, by window label. Recorded when the
/// open is requested (`record_opening_user_time`) and taken by the reveal that maps the popover
/// (`stamp_user_time`), so a later press during a cold open can never stand in for the opening one.
#[cfg(any(target_os = "linux", test))]
#[derive(Default)]
struct OpeningUserTimes(std::collections::HashMap<String, u32>);

#[cfg(any(target_os = "linux", test))]
impl OpeningUserTimes {
    /// A new opening always replaces the last one; an opening with no user time (no input on
    /// the display yet, or a native Wayland display) clears it, so no older time is reused.
    fn record(&mut self, label: &str, time: Option<u32>) {
        match time.filter(|time| *time != 0) {
            Some(time) => {
                self.0.insert(label.to_string(), time);
            }
            None => {
                self.0.remove(label);
            }
        }
    }

    fn take(&mut self, label: &str) -> Option<u32> {
        self.0.remove(label)
    }
}

#[cfg(target_os = "linux")]
fn opening_user_times() -> std::sync::MutexGuard<'static, OpeningUserTimes> {
    static TIMES: std::sync::LazyLock<std::sync::Mutex<OpeningUserTimes>> =
        std::sync::LazyLock::new(Default::default);
    TIMES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Record the user time of the press or key that is opening the popover `label`, at the moment
/// the open is requested. The palette or document webview sends the request from that input's own
/// handler, so the display's latest user time is that input: GDK updated it while delivering the
/// event, before the webview saw it. X11 only (XWayland included).
#[cfg(target_os = "linux")]
pub(super) fn record_opening_user_time<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
) -> Result<(), String> {
    let time = super::run_on_main_thread_blocking(app, || {
        use gtk::{gdk::prelude::DisplayExtManual, glib::translate::ToGlibPtr};

        let display = gtk::gdk::Display::default().filter(|display| display.backend().is_x11())?;
        // SAFETY: on the GTK main thread, with a live display that is an X11 object (checked
        // above). The stash keeps it alive for the call.
        Some(unsafe { gdk_x11_display_get_user_time(display.to_glib_none().0) })
    })?;
    opening_user_times().record(label, time);
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub(super) fn record_opening_user_time<R: Runtime>(
    _app: &AppHandle<R>,
    _label: &str,
) -> Result<(), String> {
    Ok(())
}

/// Stamp a popover with the user time of the input that opened it before it is mapped, so the
/// window manager treats the map as the answer to that input (B7 follow-up).
///
/// `prepare` turns GTK's focus-on-map off, and GDK then writes `_NET_WM_USER_TIME` 0: "never
/// activate this window". KWin's focus-stealing prevention refuses activation for user time 0 even
/// within the active application, and marks a refused window `_NET_WM_STATE_DEMANDS_ATTENTION`
/// unless it is a dock, toolbar or notification type. So a newly created "ChemDraft tools" flyout
/// kept the flag. A popover the user has clicked carries a real user time from GDK's own input
/// handling, which is why a reused one did not. With a real time KWin allows the map, and still
/// moves no focus: it focuses a newly mapped window only when it is a normal window or a dialog,
/// never a UTILITY one (Mutter never focuses a utility window on map either). This is no
/// `present()` and no activation request.
///
/// The time is the one `record_opening_user_time` captured when this opening was requested, never
/// the display's latest input at reveal time, which on a cold open may be a later press. The window
/// is realized first if it is not yet, so its first map always carries the stamp. Nothing recorded
/// (a native Wayland display, or no input yet) leaves the window unstamped.
#[cfg(target_os = "linux")]
pub(super) fn stamp_user_time<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let Some(time) = opening_user_times().take(window.label()) else {
        return Ok(());
    };
    let target = window.clone();
    super::run_on_main_thread_blocking(window, move || {
        use gtk::{gdk::prelude::DisplayExtManual, glib::translate::ToGlibPtr, prelude::WidgetExt};

        let native = target.gtk_window().map_err(|error| error.to_string())?;
        // The webview normally realizes its window when it is built. If it has not, realize it
        // now: the stamp must be on the GdkWindow before its first map, never after.
        if !native.is_realized() {
            native.realize();
        }
        let surface = native
            .window()
            .ok_or("The popover window could not be realized for its user time.")?;
        if !surface.display().backend().is_x11() {
            return Ok(());
        }
        // SAFETY: on the GTK main thread, with a live, realized X11 window (checked above). The
        // stash keeps it alive for the call.
        unsafe { gdk_x11_window_set_user_time(surface.to_glib_none().0, time) };
        Ok(())
    })?
}

/// Whether a GDK leave-notify on a palette's toplevel GdkWindow means the pointer left the palette.
///
/// `window_system_crossing` is a crossing the window system reported (GDK_CROSSING_NORMAL, GRAB or
/// UNGRAB): the pointer moved to another window, another window was mapped or raised over the
/// palette, or another client grabbed the pointer. GTK's own grab and state crossings are not.
/// `into_child` is GDK_NOTIFY_INFERIOR: the pointer moved into the webview's child window, inside
/// the palette.
#[cfg(any(target_os = "linux", test))]
fn leave_ends_palette_hover(window_system_crossing: bool, into_child: bool) -> bool {
    window_system_crossing && !into_child
}

/// Call `handler` whenever the pointer leaves `window`, or another window covers it under the
/// pointer.
///
/// WebKitGTK does not reliably turn those crossings into a DOM pointerleave, so a palette tooltip
/// could stay on screen after the pointer had gone (B5). X11 reports both as a LeaveNotify on the
/// palette's toplevel, which GTK delivers here. The handler runs on the GTK main thread.
#[cfg(target_os = "linux")]
pub(super) fn on_pointer_leave<R: Runtime>(
    window: &WebviewWindow<R>,
    handler: impl Fn() + Send + 'static,
) -> Result<(), String> {
    let target = window.clone();
    super::run_on_main_thread_blocking(window, move || {
        use gtk::{
            gdk, glib,
            prelude::{WidgetExt, WidgetExtManual},
        };

        let native = target.gtk_window().map_err(|error| error.to_string())?;
        // GtkWindow already selects crossing events; make sure, as the handler depends on them.
        native.add_events(gdk::EventMask::LEAVE_NOTIFY_MASK);
        native.connect_leave_notify_event(move |_, event| {
            let window_system_crossing = matches!(
                event.mode(),
                gdk::CrossingMode::Normal | gdk::CrossingMode::Grab | gdk::CrossingMode::Ungrab
            );
            if leave_ends_palette_hover(
                window_system_crossing,
                event.detail() == gdk::NotifyType::Inferior,
            ) {
                handler();
            }
            // Tao and WebKit keep their own crossing handling.
            glib::Propagation::Proceed
        });
        Ok(())
    })?
}

/// macOS feeds palette hover from its own pointer poll (start_palette_pointer_feed), and Windows
/// delivers hover to the palettes natively; neither needs this.
#[cfg(not(target_os = "linux"))]
pub(super) fn on_pointer_leave<R: Runtime>(
    _window: &WebviewWindow<R>,
    _handler: impl Fn() + Send + 'static,
) -> Result<(), String> {
    Ok(())
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
    use super::{leave_ends_palette_hover, linux_policy, Kind, OpeningUserTimes, TypeHint};

    #[test]
    fn a_popover_reveal_takes_the_user_time_of_its_own_opening() {
        let mut times = OpeningUserTimes::default();
        times.record("toolset-popover-a", Some(100));
        times.record("toolset-popover-b", Some(150));
        // A later opening of the same popover replaces the earlier one.
        times.record("toolset-popover-a", Some(120));
        assert_eq!(times.take("toolset-popover-a"), Some(120));
        // Taken once: a second reveal without a new opening never reuses it.
        assert_eq!(times.take("toolset-popover-a"), None);
        assert_eq!(times.take("toolset-popover-b"), Some(150));
        // An opening with no input time (0) or no X11 display clears an older time.
        times.record("toolset-popover-a", Some(130));
        times.record("toolset-popover-a", Some(0));
        assert_eq!(times.take("toolset-popover-a"), None);
        times.record("toolset-popover-a", Some(140));
        times.record("toolset-popover-a", None);
        assert_eq!(times.take("toolset-popover-a"), None);
    }

    #[test]
    fn the_user_time_is_captured_at_the_open_request_and_applied_before_the_map() {
        let lib = include_str!("lib.rs");
        let open = &lib[lib.find("async fn open_toolset_popover(").unwrap()..];
        let open = &open[..open.find("\n}\n").unwrap()];
        let record = open
            .find("utility_window::record_opening_user_time(&app, &label)")
            .unwrap();
        assert!(record < open.find("lock_window_creation()").unwrap());
        let reveal = &lib[lib.find("fn show_toolset_popover_window(").unwrap()..];
        let stamp = reveal
            .find("utility_window::stamp_user_time(&window)?;")
            .unwrap();
        assert!(
            stamp
                < reveal
                    .find("utility_window::set_visible(&window, true)?;")
                    .unwrap()
        );
        let source = include_str!("utility_window.rs");
        assert!(
            !source[source.find("pub(super) fn stamp_user_time").unwrap()..]
                .split("\n}\n")
                .next()
                .unwrap()
                .contains("gdk_x11_display_get_user_time")
        );
    }

    #[test]
    fn only_a_window_system_leave_out_of_the_palette_ends_its_hover() {
        // Pointer moved to another window, or a window was mapped over the palette.
        assert!(leave_ends_palette_hover(true, false));
        // Pointer moved into the webview's own child window: still inside the palette.
        assert!(!leave_ends_palette_hover(true, true));
        // GTK's own grab or state crossings leave the pointer where it was.
        assert!(!leave_ends_palette_hover(false, false));
        assert!(!leave_ends_palette_hover(false, true));
    }

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
