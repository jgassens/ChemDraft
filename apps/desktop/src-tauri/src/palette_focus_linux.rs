//! GTK input arrives before the web process classifies a click. Preserve its GDK
//! timestamp and let the compositor confirm (or refuse) the subsequent presentation.

use super::{end, now, publish, publish_click, state, wall_time, End, GUARD};
use crate::{
    is_input_focus_window_label, panel_window, run_on_main_thread_blocking, MAIN_WINDOW_LABEL,
};
use gtk::{gdk, glib::translate::ToGlibPtr, prelude::*};
use std::os::raw::{c_char, c_int, c_long, c_uchar, c_uint, c_ulong, c_void};
use std::sync::Mutex;
use tauri::{Manager, Runtime, WebviewWindow};

/// The last time any ChemDraft toplevel lost focus, on `now()`'s clock; `None` before the
/// first loss. The field gate reads it, with the X focus holder (`x11_focus_holder`), to tell
/// the X11 focus handoff race from a click made while another application was in front
/// (`state::acquire_refusal`). Kept apart from `GUARD`
/// so a focus change GTK reports while the guard is locked can never deadlock.
static APP_FOCUS_LOST: Mutex<Option<u64>> = Mutex::new(None);

fn app_focus_lost_at() -> Option<u64> {
    *APP_FOCUS_LOST
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn install<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let native = window.gtk_window().map_err(|error| error.to_string())?;
    // GTK3 holds gesture controllers weakly. Keep one capture observer for the
    // lifetime of this widget across page reloads and repeated document reveals.
    const OBSERVER: &str = "chemdraft-palette-pointer-observer";
    // SAFETY: this private key only ever stores a GestureMultiPress on the GTK thread.
    if unsafe { native.data::<gtk::GestureMultiPress>(OBSERVER) }.is_some() {
        return Ok(());
    }
    let press = gtk::GestureMultiPress::new(&native);
    press.set_button(0);
    press.set_propagation_phase(gtk::PropagationPhase::Capture);
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    let owner = native.downgrade();
    if is_input_focus_window_label(&label) {
        native.set_focus_on_map(false);
        let source = label.clone();
        // A compositor can deliver keys to a refused presentation. Stop them
        // before GtkWindow dispatches a menu accelerator or WebKit forwards a shortcut.
        native.connect_key_press_event(move |_, _| {
            (!GUARD.lock().unwrap().allows_window_keys(&source)).into()
        });
    }
    press.connect_pressed(move |gesture, _, _, _| {
        let primary = gesture.current_button() == 1;
        if is_input_focus_window_label(&label)
            && (primary || crate::is_plugin_panel_window_label(&label))
        {
            let focused = owner.upgrade().is_some_and(|w| w.has_toplevel_focus());
            if focused && GUARD.lock().unwrap().has_confirmed_focus(&label) {
                // A second click in a key field needs no new acquisition or key guard.
                end(&app, "", End::Outside, None, 0);
                return;
            }
            let timestamp = gesture
                .last_event(gesture.current_sequence().as_ref())
                .map_or(0, |event| event.time());
            let event = GUARD
                .lock()
                .unwrap()
                .gtk_pointer(&label, now(), wall_time(), timestamp);
            publish_click(&app, &label, event);
        } else {
            end(&app, "", End::Outside, None, 0);
        }
    });
    // SAFETY: same key and type as above; GTK drops the value with the widget.
    unsafe { native.set_data(OBSERVER, press) };
    // Every ChemDraft webview window passes through here once (on page load), the document
    // included. `has-toplevel-focus` is the property `foreground_belongs_to_app` reads, so a
    // loss recorded here is exactly a window leaving that check.
    native.connect_has_toplevel_focus_notify(|window| {
        if !window.has_toplevel_focus() {
            *APP_FOCUS_LOST
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(now());
        }
    });

    if window.label() == MAIN_WINDOW_LABEL {
        let app = window.app_handle().clone();
        // Run before GtkWindow's default key-press handler forwards to its focused
        // WebKit child or dispatches menu accelerators. Field-window keys pass normally.
        native.connect_key_press_event(move |_, event| {
            let state = app.state::<panel_window::PanelFocusState>();
            let leased = state
                .0
                .lock()
                .unwrap()
                .values()
                .any(|lease| lease.is_held());
            let modifiers = event.state();
            let key = match event.keyval() {
                gdk::keys::constants::Delete | gdk::keys::constants::KP_Delete => "Delete".into(),
                gdk::keys::constants::BackSpace => "Backspace".into(),
                other => other
                    .to_unicode()
                    .filter(|c| !c.is_control())
                    .map(String::from)
                    .or_else(|| other.name().map(|name| name.to_string()))
                    .unwrap_or_default(),
            };
            state::blocks_document_key(
                super::blocks_document(),
                leased,
                &key,
                modifiers.intersects(gdk::ModifierType::META_MASK | gdk::ModifierType::SUPER_MASK),
                modifiers.contains(gdk::ModifierType::CONTROL_MASK),
                modifiers.contains(gdk::ModifierType::MOD1_MASK),
            )
            .into()
        });
    }
    Ok(())
}

#[link(name = "gdk-3")]
extern "C" {
    fn gdk_x11_window_get_xid(window: *mut gdk::ffi::GdkWindow) -> c_ulong;
    fn gdk_x11_display_get_xdisplay(display: *mut gdk::ffi::GdkDisplay) -> *mut c_void;
    fn gdk_x11_display_error_trap_push(display: *mut gdk::ffi::GdkDisplay);
    fn gdk_x11_display_error_trap_pop(display: *mut gdk::ffi::GdkDisplay) -> c_int;
}
#[link(name = "X11")]
extern "C" {
    fn XSetInputFocus(
        display: *mut c_void,
        focus: c_ulong,
        revert_to: c_int,
        time: c_ulong,
    ) -> c_int;
    fn XGetInputFocus(
        display: *mut c_void,
        focus_return: *mut c_ulong,
        revert_to_return: *mut c_int,
    ) -> c_int;
    fn XDefaultRootWindow(display: *mut c_void) -> c_ulong;
    fn XInternAtom(display: *mut c_void, name: *const c_char, only_if_exists: c_int) -> c_ulong;
    #[allow(clippy::too_many_arguments)]
    fn XGetWindowProperty(
        display: *mut c_void,
        window: c_ulong,
        property: c_ulong,
        long_offset: c_long,
        long_length: c_long,
        delete: c_int,
        req_type: c_ulong,
        actual_type_return: *mut c_ulong,
        actual_format_return: *mut c_int,
        nitems_return: *mut c_ulong,
        bytes_after_return: *mut c_ulong,
        prop_return: *mut *mut c_uchar,
    ) -> c_int;
    fn XQueryTree(
        display: *mut c_void,
        window: c_ulong,
        root_return: *mut c_ulong,
        parent_return: *mut c_ulong,
        children_return: *mut *mut c_ulong,
        nchildren_return: *mut c_uint,
    ) -> c_int;
    fn XFree(data: *mut c_void) -> c_int;
}

/// Read-only X queries for `x11_focus_holder`. Every method must run on GTK's main thread,
/// on an X11 display, inside a GDK error trap: a window can be destroyed between two
/// requests, and the trap turns the resulting BadWindow into a failed status here instead of
/// Xlib's default handler exiting the process. Each method frees what Xlib allocated.
struct XQuery(*mut c_void);

/// A failed X request (an error the trap absorbed, or a failed status).
struct XFailed;

impl XQuery {
    /// The first 32-bit item of `window`'s `property`: `Ok(None)` when the window lacks the
    /// property, `Ok(Some(0))` when it has no 32-bit items. Xlib returns format-32 data as an
    /// array of C longs.
    unsafe fn property(
        &self,
        window: c_ulong,
        property: c_ulong,
    ) -> Result<Option<c_ulong>, XFailed> {
        const SUCCESS: c_int = 0;
        const ANY_PROPERTY_TYPE: c_ulong = 0;
        let (mut kind, mut format, mut items, mut after) = (0, 0, 0, 0);
        let mut data: *mut c_uchar = std::ptr::null_mut();
        let status = XGetWindowProperty(
            self.0,
            window,
            property,
            0,
            1,
            0,
            ANY_PROPERTY_TYPE,
            &mut kind,
            &mut format,
            &mut items,
            &mut after,
            &mut data,
        );
        let first = if data.is_null() || format != 32 || items == 0 {
            0
        } else {
            data.cast::<c_ulong>().read()
        };
        if !data.is_null() {
            XFree(data.cast());
        }
        match status {
            SUCCESS if kind == 0 => Ok(None),
            SUCCESS => Ok(Some(first)),
            _ => Err(XFailed),
        }
    }

    /// `window`'s parent and children.
    unsafe fn tree(&self, window: c_ulong) -> Result<(c_ulong, Vec<c_ulong>), XFailed> {
        let (mut root, mut parent, mut count) = (0, 0, 0);
        let mut children: *mut c_ulong = std::ptr::null_mut();
        let ok = XQueryTree(
            self.0,
            window,
            &mut root,
            &mut parent,
            &mut children,
            &mut count,
        ) != 0;
        let list = if ok && !children.is_null() {
            std::slice::from_raw_parts(children, count as usize).to_vec()
        } else {
            Vec::new()
        };
        if !children.is_null() {
            XFree(children.cast());
        }
        if ok {
            Ok((parent, list))
        } else {
            Err(XFailed)
        }
    }

    /// Whether `window` is a client toplevel the window manager manages: ICCCM 4.1.3.1 has the
    /// window manager put `WM_STATE` on each one. `wm_state` is 0 when no client ever set it.
    unsafe fn managed(&self, window: c_ulong, wm_state: c_ulong) -> Result<bool, XFailed> {
        Ok(wm_state != 0 && self.property(window, wm_state)?.is_some())
    }

    /// Classifies the X focus window. `ours` lists the X window of every realized ChemDraft
    /// toplevel. Walking up from the focus window, a ChemDraft window means ChemDraft, and a
    /// managed client window means another client (focus may sit on a child of its toplevel).
    /// A window with neither may be a window manager frame, which holds the client one level
    /// down, or two under KWin's wrapper window, so those are checked the same way. A window
    /// that leads to no client at all belongs to the window manager: its no-focus window.
    /// Without any window manager there is no `WM_STATE` and every window reads as that, so
    /// only the time bound in `state::acquire_refusal` applies.
    unsafe fn classify(
        &self,
        focus: c_ulong,
        root: c_ulong,
        ours: &[c_ulong],
        wm_state: c_ulong,
    ) -> Result<state::FocusHolder, XFailed> {
        const NONE: c_ulong = 0;
        const POINTER_ROOT: c_ulong = 1;
        match focus {
            NONE => return Ok(state::FocusHolder::NoFocus),
            POINTER_ROOT => return Ok(state::FocusHolder::PointerRoot),
            _ if focus == root => return Ok(state::FocusHolder::Root),
            _ => {}
        }
        let mut window = focus;
        let mut client = None;
        let mut below = Vec::new();
        // X window trees are shallow; the bound only guards against a malformed reply.
        for depth in 0..64 {
            if ours.contains(&window) {
                return Ok(state::FocusHolder::ChemDraft(focus));
            }
            if client.is_none() && self.managed(window, wm_state)? {
                client = Some(window);
            }
            let (parent, children) = self.tree(window)?;
            if depth == 0 {
                below = children;
            }
            if parent == NONE || parent == root {
                break;
            }
            window = parent;
        }
        if let Some(client) = client {
            return Ok(state::FocusHolder::Other(client));
        }
        for level in 0..2 {
            let mut next = Vec::new();
            for child in below {
                if ours.contains(&child) {
                    return Ok(state::FocusHolder::ChemDraft(focus));
                }
                if self.managed(child, wm_state)? {
                    return Ok(state::FocusHolder::Other(child));
                }
                if level == 0 {
                    next.extend(self.tree(child)?.1);
                }
            }
            below = next;
        }
        Ok(state::FocusHolder::WindowManager(focus))
    }

    /// The X focus holder, and the root window's `_NET_ACTIVE_WINDOW` for the log. When X
    /// focus is on no client's window (or still on ChemDraft's), a `_NET_ACTIVE_WINDOW` that
    /// names another client means the window manager has made that client active, and it
    /// counts as the holder.
    unsafe fn focus_holder(
        &self,
        ours: &[c_ulong],
    ) -> Result<(state::FocusHolder, String), XFailed> {
        const ONLY_IF_EXISTS: c_int = 1;
        let root = XDefaultRootWindow(self.0);
        let (mut focus, mut revert) = (0, 0);
        XGetInputFocus(self.0, &mut focus, &mut revert);
        let wm_state = XInternAtom(self.0, c"WM_STATE".as_ptr(), ONLY_IF_EXISTS);
        let holder = self.classify(focus, root, ours, wm_state)?;
        let net_active = XInternAtom(self.0, c"_NET_ACTIVE_WINDOW".as_ptr(), ONLY_IF_EXISTS);
        let active = if net_active == 0 {
            None
        } else {
            self.property(root, net_active)?
        };
        Ok(match active {
            None => (holder, "unset".to_owned()),
            Some(0) => (holder, "none".to_owned()),
            Some(active) if ours.contains(&active) => (holder, format!("chemdraft(0x{active:x})")),
            Some(active) => (
                match holder {
                    state::FocusHolder::Other(_) => holder,
                    _ => state::FocusHolder::Other(active),
                },
                format!("other(0x{active:x})"),
            ),
        })
    }
}

/// Which X window holds the keyboard as a field acquisition runs (see `state::FocusHolder`
/// and `state::acquire_refusal`), and the root window's `_NET_ACTIVE_WINDOW` for the log.
/// Under XWayland a native Wayland application in front is invisible here: X focus then sits
/// on no client's window or on the ChemDraft window that last had it, readings the handoff can
/// produce too (the limit `state::acquire_refusal` documents).
fn x11_focus_holder(native: &gtk::ApplicationWindow) -> (state::FocusHolder, String) {
    let display = native.display();
    if !display.backend().is_x11() {
        return (state::FocusHolder::NotX11, "n/a".into());
    }
    let ours: Vec<c_ulong> = gtk::Window::list_toplevels()
        .iter()
        .filter_map(|widget| widget.window())
        .filter(|window| window.display() == display)
        .map(|window| {
            let window_ptr: *mut gdk::ffi::GdkWindow = window.to_glib_none().0;
            // SAFETY: a realized window on this X11 display, alive for the call.
            unsafe { gdk_x11_window_get_xid(window_ptr) }
        })
        .collect();
    let display_ptr: *mut gdk::ffi::GdkDisplay = display.to_glib_none().0;
    // SAFETY: GTK's main thread, on an X11 display (checked above), inside an error trap as
    // `XQuery` requires. Popping the trap synchronizes, so any X error is known here.
    let (result, error) = unsafe {
        gdk_x11_display_error_trap_push(display_ptr);
        let result = XQuery(gdk_x11_display_get_xdisplay(display_ptr)).focus_holder(&ours);
        (result, gdk_x11_display_error_trap_pop(display_ptr))
    };
    match result {
        Ok(found) if error == 0 => found,
        _ => (state::FocusHolder::Unknown, "unknown".into()),
    }
}

/// The palette refused the click's WM_TAKE_FOCUS: it was not yet accepting focus. A window
/// manager may then keep it as its pending focus target and drop the `_NET_ACTIVE_WINDOW`
/// request that `present_with_time` sends (KWin returns early for its most recently activated
/// window, XWayland clients in a Plasma Wayland session included). No focus-in arrives, and
/// the field never gets keys. ICCCM 4.1.7 lets a client focus its own window with the
/// timestamp of the button press that asked for it, so take the focus directly. The X server
/// ignores a stale timestamp. Native Wayland is unaffected.
///
/// Weston's XWM does not allow this: it resets any client focus change on a managed window to
/// the window the compositor last activated (its own no-focus window when there is none), and
/// it ignores `_NET_ACTIVE_WINDOW`. Under Weston only a pointer press that the compositor itself
/// sees can focus the palette. The returned text records what happened, for the diagnostic.
fn take_x11_click_focus(native: &gtk::ApplicationWindow, timestamp: u32) -> String {
    const REVERT_TO_PARENT: c_int = 2;

    let Some(window) = native.window() else {
        return "skipped:unrealized".into();
    };
    let display = window.display();
    let x11 = display.backend().is_x11();
    let Some(time) = state::click_focus_time(x11, timestamp) else {
        let reason = if x11 {
            "skipped:no-click-time"
        } else {
            "skipped:not-x11"
        };
        return reason.into();
    };
    let window_ptr: *mut gdk::ffi::GdkWindow = window.to_glib_none().0;
    let display_ptr: *mut gdk::ffi::GdkDisplay = display.to_glib_none().0;
    // SAFETY: GTK's main thread, on an X11 display (checked above) and a realized toplevel
    // that outlives these calls. The trap absorbs BadMatch if the window stopped being viewable;
    // popping it synchronizes once, so the X error code (0 for none) is known here.
    let (xid, error) = unsafe {
        let xid = gdk_x11_window_get_xid(window_ptr);
        gdk_x11_display_error_trap_push(display_ptr);
        XSetInputFocus(
            gdk_x11_display_get_xdisplay(display_ptr),
            xid,
            REVERT_TO_PARENT,
            c_ulong::from(time),
        );
        (xid, gdk_x11_display_error_trap_pop(display_ptr))
    };
    display.flush();
    format!("sent:window=0x{xid:x},time={time},x-error={error}")
}

/// Which X window holds the keyboard now, next to this palette's own, for the diagnostic.
/// A window manager that undid `take_x11_click_focus` shows up here as a foreign window.
fn x11_focus_report(native: &gtk::ApplicationWindow) -> String {
    let Some(window) = native.window() else {
        return "x-focus=unrealized".into();
    };
    let display = window.display();
    if !display.backend().is_x11() {
        return "x-focus=n/a".into();
    }
    let window_ptr: *mut gdk::ffi::GdkWindow = window.to_glib_none().0;
    let display_ptr: *mut gdk::ffi::GdkDisplay = display.to_glib_none().0;
    let mut focus: c_ulong = 0;
    let mut revert: c_int = 0;
    // SAFETY: GTK's main thread, on an X11 display (checked above); XGetInputFocus only
    // writes the two out-parameters, which live on this stack frame.
    let xid = unsafe {
        XGetInputFocus(
            gdk_x11_display_get_xdisplay(display_ptr),
            &mut focus,
            &mut revert,
        );
        gdk_x11_window_get_xid(window_ptr)
    };
    format!("x-focus=0x{focus:x} palette-window=0x{xid:x}")
}

/// One line per Linux field acquisition, written whatever the agent-bridge setting, so a
/// CI log shows where focus went without changing what the smoke tests. Field order: what
/// started it, the window system, whether a ChemDraft window had focus, when one last lost
/// focus relative to the press, which X window held the keyboard (and `_NET_ACTIVE_WINDOW`),
/// accept-focus before and after, the request the key guard made,
/// the X11 focus call, the presentation, the outcome, and the key guard at the end.
struct AcquireLog {
    label: String,
    trigger: String,
    backend: &'static str,
    app_foreground: Option<bool>,
    app_focus_lost: String,
    focus_holder: String,
    accept_before: Option<bool>,
    request: String,
    x11: String,
    present: Option<u32>,
}

impl AcquireLog {
    fn new(label: &str, click_sequence: Option<u64>, before: u64) -> Self {
        let click = click_sequence.map_or_else(|| "none".to_owned(), |s| s.to_string());
        Self {
            label: label.to_owned(),
            trigger: format!(
                "page-click={click} pointer-before={before} {}",
                GUARD.lock().unwrap().describe_pending_click()
            ),
            backend: "unknown",
            app_foreground: None,
            app_focus_lost: "unknown".into(),
            focus_holder: "not-queried".into(),
            accept_before: None,
            request: String::new(),
            x11: "not-called".into(),
            present: None,
        }
    }

    fn emit(&self, outcome: &str, end: &str) {
        let known =
            |value: Option<bool>| value.map_or_else(|| "unknown".to_owned(), |v| v.to_string());
        let (app_foreground, accept_before) =
            (known(self.app_foreground), known(self.accept_before));
        let present = self
            .present
            .map_or_else(|| "not-called".to_owned(), |time| format!("time={time}"));
        crate::palette_focus_acquire_log(format_args!(
            "linux-acquire label={} {} backend={} app-foreground={app_foreground} \
             app-focus-lost={} focus-holder={} accept-focus-before={accept_before} \
             request={} xsetinputfocus={} present-with-time={present} outcome={outcome} {end}",
            self.label,
            self.trigger,
            self.backend,
            self.app_focus_lost,
            self.focus_holder,
            self.request,
            self.x11
        ));
    }
}

fn backend_name(native: &gtk::ApplicationWindow) -> &'static str {
    match native.display().backend() {
        gdk::Backend::X11 => "x11",
        gdk::Backend::Wayland => "wayland",
        _ => "other",
    }
}

pub(crate) fn set_keyboard_popover(label: &str, keyboard: bool) {
    GUARD.lock().unwrap().set_keyboard_popover(label, keyboard);
}

pub(crate) fn has_confirmed_focus(label: &str) -> bool {
    GUARD.lock().unwrap().has_confirmed_focus(label)
}

// A reopened window can reuse both the Tauri label and the page's JS generations.
// Resolve the actual GTK widget before acting on a queued event or IPC completion.
fn current_window<R: Runtime>(
    window: &tauri::Window<R>,
) -> Option<(WebviewWindow<R>, gtk::ApplicationWindow)> {
    let target = window.app_handle().get_webview_window(window.label())?;
    let native = target.gtk_window().ok()?;
    (window.gtk_window().ok()? == native).then_some((target, native))
}

pub(crate) fn focus_changed<R: Runtime>(window: &tauri::Window<R>, active: bool) {
    let Some((target, native)) = current_window(window) else {
        return;
    };
    if active != (native.has_toplevel_focus() && native.is_visible()) {
        return;
    }
    if active {
        GUARD.lock().unwrap().focus_in(window.label(), now());
    } else {
        panel_window::activation(&target, false);
    }
}

pub(crate) async fn acquire(
    window: tauri::WebviewWindow,
    page_token: &str,
    generation: u64,
    click_sequence: Option<u64>,
    before: u64,
) -> Result<bool, String> {
    let page_token = page_token.to_owned();
    let target = window.clone();
    let started = now();
    let (request, mut log) = run_on_main_thread_blocking(&window, move || {
        let mut log = AcquireLog::new(target.label(), click_sequence, before);
        let Some((_, native)) = current_window(&target.as_ref().window()) else {
            log.request = "denied:window-replaced".into();
            return (None, log);
        };
        log.backend = backend_name(&native);
        log.accept_before = Some(native.accepts_focus());
        let Some(epoch) = panel_window::request(&target, generation, &page_token, true, false)
        else {
            log.request = "denied:stale-page-or-generation".into();
            return (None, log);
        };
        let request = GUARD.lock().unwrap().request_focus(
            target.label(),
            click_sequence,
            before,
            now(),
            native.has_toplevel_focus(),
        );
        let sequence = request.sequence();
        let kind = match &request {
            state::FocusRequest::Denied => "denied:no-current-gtk-click",
            state::FocusRequest::Focused(_) => "focused",
            state::FocusRequest::Present { .. } => "present",
        };
        log.request = kind.into();
        let app_foreground = crate::foreground_belongs_to_app();
        let lost_at = app_focus_lost_at();
        log.app_foreground = Some(app_foreground);
        log.app_focus_lost = state::describe_focus_loss(lost_at, &request);
        let (focus_holder, net_active) = x11_focus_holder(&native);
        log.focus_holder = format!("{} net-active={net_active}", focus_holder.describe());
        // Without a ChemDraft window in front, only this palette's own live GTK press (a
        // Present request) may take focus, and only with evidence of the X11 focus handoff
        // race: no other client holds X focus, and a ChemDraft window lost focus just before
        // the press. A click while another application is in front leaves the keys with that
        // application, as on Windows and macOS.
        let refusal = state::acquire_refusal(
            native.is_visible(),
            target.is_minimized().unwrap_or(true),
            app_foreground,
            focus_holder,
            lost_at,
            &request,
        );
        if let Some(refusal) = refusal {
            // Keep the guard's own verdict: it shows whether the GTK press matched.
            log.request = format!("{refusal}(guard:{kind})");
            return (Some((epoch, sequence, state::FocusRequest::Denied)), log);
        }
        if !matches!(request, state::FocusRequest::Denied) {
            native.set_accept_focus(true);
        }
        if let state::FocusRequest::Present { timestamp, .. } = &request {
            log.x11 = take_x11_click_focus(&native, *timestamp);
            native.present_with_time(*timestamp);
            log.present = Some(*timestamp);
        }
        (Some((epoch, sequence, request)), log)
    })?;
    let Some((epoch, sequence, request)) = request else {
        log.emit("not-requested", "");
        return Ok(false);
    };
    // Wait on the IPC task, leaving the GTK thread free to deliver Focused.
    let confirmed = request.confirmed().await;
    if log.request == "present" {
        log.request = if confirmed {
            "present:focus-in"
        } else {
            "present:timeout-or-cancelled"
        }
        .into();
    }
    let target = window.clone();
    run_on_main_thread_blocking(&window, move || {
        let elapsed = now().saturating_sub(started);
        let Some((_, native)) = current_window(&target.as_ref().window()) else {
            log.emit("window-replaced", &format!("elapsed-ms={elapsed}"));
            return Ok(false);
        };
        if !panel_window::is_current(&target, generation, epoch) {
            log.emit(
                "superseded",
                &format!("elapsed-ms={elapsed} {}", x11_focus_report(&native)),
            );
            return Ok(false);
        }
        let mut refusal = "";
        let result = (|| {
            refusal = if !confirmed {
                "no-focus-in"
            } else if !sequence.is_some_and(|seq| {
                GUARD
                    .lock()
                    .unwrap()
                    .ticket_is_current(target.label(), seq, now())
            }) {
                "stale-click"
            } else if !panel_window::holds_input_focus(&target) {
                "lease-lost"
            } else if !native.has_toplevel_focus() {
                "no-toplevel-focus"
            } else if !panel_window::is_active(&target)? {
                "window-inactive"
            } else {
                ""
            };
            if !refusal.is_empty() {
                return Ok(false);
            }
            let webview: &tauri::Webview = target.as_ref();
            webview.set_focus().map_err(|error| error.to_string())?;
            Ok(true)
        })();
        let (held, event) =
            GUARD
                .lock()
                .unwrap()
                .finish_focus(target.label(), sequence, now(), |eligible| {
                    panel_window::acquired(
                        &target,
                        generation,
                        epoch,
                        eligible && matches!(result, Ok(true)),
                    )
                });
        publish(target.app_handle(), event);
        if !held {
            native.set_accept_focus(false);
        }
        let outcome = match (&result, held) {
            (Err(_), _) => "error".to_owned(),
            (_, true) => "held".to_owned(),
            (Ok(true), false) => "refused:lease-not-settled".to_owned(),
            (Ok(false), false) => format!("refused:{refusal}"),
        };
        let window_keys = GUARD.lock().unwrap().allows_window_keys(target.label());
        log.emit(
            &outcome,
            &format!(
                "elapsed-ms={elapsed} toplevel-focus={} accept-focus-after={} {} \
                 key-guard=window-keys:{window_keys},document-blocked:{}",
                native.has_toplevel_focus(),
                native.accepts_focus(),
                x11_focus_report(&native),
                super::blocks_document(),
            ),
        );
        result.map(|_| held)
    })?
}
