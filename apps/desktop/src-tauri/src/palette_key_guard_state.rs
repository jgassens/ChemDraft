//! Pure pending-click policy. Times are supplied by the caller so timeout and IPC
//! ordering are testable without AppKit, WebView2 or a Tauri event loop.

pub(super) const TIMEOUT_MS: u64 = 1_000;

#[derive(Debug)]
struct Pending {
    label: String,
    sequence: u64,
    started: u64,
    wall_time: u64,
    #[cfg(any(target_os = "linux", test))]
    native_time: u32,
    #[cfg(any(target_os = "linux", test))]
    presentation: Option<Presentation>,
}

#[cfg(any(target_os = "linux", test))]
#[derive(Debug)]
struct Presentation {
    sequence: u64,
    deadline: u64,
    confirmation: Option<tokio::sync::oneshot::Sender<()>>,
}

#[derive(Default)]
pub(super) struct Guard {
    #[cfg(any(target_os = "linux", target_os = "macos", windows, test))]
    sequence: u64,
    pending: Option<Pending>,
    #[cfg(any(target_os = "linux", test))]
    confirmed_focus: Option<(String, u64)>,
    #[cfg(any(target_os = "linux", test))]
    keyboard_popover: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Event {
    pub sequence: u64,
    pub pending: bool,
    pub expires_at: u64,
}

#[derive(Clone, Copy)]
pub(crate) enum End {
    Acquired,
    Refused,
    Released,
    Drag,
    Hide,
    Destroy,
    Deactivated,
    Outside,
}

impl Guard {
    pub const fn new() -> Self {
        Self {
            #[cfg(any(target_os = "linux", target_os = "macos", windows, test))]
            sequence: 0,
            pending: None,
            #[cfg(any(target_os = "linux", test))]
            confirmed_focus: None,
            #[cfg(any(target_os = "linux", test))]
            keyboard_popover: None,
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos", windows, test))]
    pub fn pointer(&mut self, label: &str, now: u64, wall_time: u64) -> Event {
        self.sequence += 1;
        self.pending = Some(Pending {
            label: label.to_owned(),
            sequence: self.sequence,
            started: now,
            wall_time,
            #[cfg(any(target_os = "linux", test))]
            native_time: 0,
            #[cfg(any(target_os = "linux", test))]
            presentation: None,
        });
        Event {
            sequence: self.sequence,
            pending: true,
            expires_at: wall_time + TIMEOUT_MS,
        }
    }

    pub fn blocks_for(&self, now: u64, belongs_to_owner: impl FnOnce(&str) -> bool) -> bool {
        self.pending.as_ref().is_some_and(|p| {
            now.saturating_sub(p.started) < TIMEOUT_MS && belongs_to_owner(&p.label)
        })
    }

    #[cfg(any(target_os = "linux", target_os = "macos", windows, test))]
    pub fn blocks(&self, now: u64) -> bool {
        self.blocks_for(now, |_| true)
    }

    fn clear(&mut self) -> Option<(String, Event)> {
        let pending = self.pending.take()?;
        Some((
            pending.label,
            Event {
                sequence: pending.sequence,
                pending: false,
                expires_at: 0,
            },
        ))
    }

    pub fn end(
        &mut self,
        label: &str,
        why: End,
        sequence: Option<u64>,
        before: u64,
    ) -> Option<(String, Event)> {
        #[cfg(any(target_os = "linux", test))]
        if matches!(
            why,
            End::Deactivated | End::Hide | End::Destroy | End::Released
        ) && self.has_confirmed_focus(label)
        {
            self.confirmed_focus = None;
        }
        #[cfg(any(target_os = "linux", test))]
        if matches!(why, End::Hide | End::Destroy) {
            self.set_keyboard_popover(label, false);
        }
        let pending = self.pending.as_ref()?;
        if matches!(why, End::Outside) || (matches!(why, End::Deactivated) && label.is_empty()) {
            return self.clear();
        }
        if pending.label != label && !(label.is_empty() && matches!(why, End::Released)) {
            return None;
        }
        // The page captures both values BEFORE queuing IPC. An old release must
        // never clear a later click, even in the same palette. A strict timestamp
        // comparison is a conservative fallback only for pointer classification
        // (before == 0 means no pointerdown). Escape, blur and observer cleanup
        // without a sequence cannot clear a pending click. An ambiguous
        // same-millisecond click expires on the native timer.
        if matches!(why, End::Released | End::Refused)
            && !match sequence {
                Some(sequence) => sequence == pending.sequence,
                None => before != 0 && pending.wall_time < before,
            }
        {
            return None;
        }
        // Acquired is reported only after native focus succeeds: this window is
        // now key, including if another click arrived during the focus operation.
        self.clear()
    }

    #[cfg(any(target_os = "linux", target_os = "macos", windows, test))]
    pub fn timeout(&mut self, sequence: u64, now: u64) -> Option<(String, Event)> {
        if self
            .pending
            .as_ref()
            .is_some_and(|p| p.sequence == sequence)
            && !self.blocks(now)
        {
            self.clear()
        } else {
            None
        }
    }

    /// A document page's pointerdown outside its palettes: release the pending click only if one
    /// of that document's own palettes holds it (`owns` maps a palette label to that answer), with
    /// the same sequence and timestamp rules as any other `Released`.
    pub fn release_for(
        &mut self,
        owns: impl FnOnce(&str) -> bool,
        sequence: Option<u64>,
        before: u64,
    ) -> Option<(String, Event)> {
        if !self.pending.as_ref().is_some_and(|p| owns(&p.label)) {
            return None;
        }
        self.end("", End::Released, sequence, before)
    }
}

// A GTK presentation completes on a later window event. Keeping the reply with the
// click lets the existing hide, outside-click and expiry paths cancel the wait.
#[cfg(any(target_os = "linux", test))]
pub(super) enum FocusRequest {
    Denied,
    Focused(u64),
    Present {
        sequence: u64,
        timestamp: u32,
        /// When the GTK observer saw the press, on the caller's monotonic clock.
        pressed_at: u64,
        remaining_ms: u64,
        confirmed: tokio::sync::oneshot::Receiver<()>,
    },
}

#[cfg(any(target_os = "linux", test))]
impl FocusRequest {
    pub fn sequence(&self) -> Option<u64> {
        match self {
            Self::Denied => None,
            Self::Focused(sequence) | Self::Present { sequence, .. } => Some(*sequence),
        }
    }

    pub async fn confirmed(self) -> bool {
        match self {
            Self::Denied => false,
            Self::Focused(_) => true,
            Self::Present {
                confirmed,
                remaining_ms,
                ..
            } => matches!(
                tokio::time::timeout(std::time::Duration::from_millis(remaining_ms), confirmed)
                    .await,
                Ok(Ok(()))
            ),
        }
    }
}

#[cfg(any(target_os = "linux", test))]
impl Guard {
    pub fn has_confirmed_focus(&self, label: &str) -> bool {
        self.confirmed_focus
            .as_ref()
            .is_some_and(|(owner, _)| owner == label)
    }

    pub fn set_keyboard_popover(&mut self, label: &str, keyboard: bool) {
        if keyboard {
            self.keyboard_popover = Some(label.to_owned());
        } else if self.keyboard_popover.as_deref() == Some(label) {
            self.keyboard_popover = None;
        }
    }

    /// The native press the guard holds, for the acquisition diagnostic. `gtk-click=none`
    /// means no press reached the GTK observer, or a later event already ended it.
    pub fn describe_pending_click(&self) -> String {
        match &self.pending {
            Some(p) => format!(
                "gtk-click={}#{} gtk-time={}",
                p.label, p.sequence, p.native_time
            ),
            None => "gtk-click=none".to_owned(),
        }
    }

    pub fn allows_window_keys(&self, label: &str) -> bool {
        self.has_confirmed_focus(label) || self.keyboard_popover.as_deref() == Some(label)
    }

    pub fn gtk_pointer(&mut self, label: &str, now: u64, wall_time: u64, timestamp: u32) -> Event {
        if self.has_confirmed_focus(label) {
            self.confirmed_focus = None;
        }
        // Palette fields share their in-flight IPC across clicks. Keep its original
        // ticket and deadline. Plugin panels request a new generation on every click.
        let presentation = self
            .pending
            .as_mut()
            .filter(|p| p.label == label && !crate::is_plugin_panel_window_label(label))
            .and_then(|p| p.presentation.take())
            .filter(|p| now < p.deadline);
        let event = self.pointer(label, now, wall_time);
        let pending = self.pending.as_mut().unwrap();
        pending.native_time = timestamp;
        pending.presentation = presentation;
        event
    }

    // GTK focus events have no acquisition ID. They can wake a waiter, but only
    // its completion can authorize keys, after rechecking the click and native focus.
    pub fn focus_in(&mut self, label: &str, now: u64) {
        if let Some(reply) = self
            .pending
            .as_mut()
            .filter(|p| p.label == label)
            .and_then(|p| p.presentation.as_mut())
            .filter(|p| now < p.deadline)
            .and_then(|p| p.confirmation.take())
        {
            let _ = reply.send(());
        }
    }

    pub fn ticket_is_current(&self, label: &str, sequence: u64, now: u64) -> bool {
        self.confirmed_focus
            .as_ref()
            .is_some_and(|(owner, seq)| owner == label && *seq == sequence)
            || self
                .pending
                .as_ref()
                .filter(|p| p.label == label)
                .and_then(|p| p.presentation.as_ref())
                .is_some_and(|p| p.sequence == sequence && now < p.deadline)
    }

    pub fn finish_focus(
        &mut self,
        label: &str,
        sequence: Option<u64>,
        now: u64,
        settle_lease: impl FnOnce(bool) -> bool,
    ) -> (bool, Option<(String, Event)>) {
        let held =
            settle_lease(sequence.is_some_and(|seq| self.ticket_is_current(label, seq, now)));
        if let Some(sequence) = sequence.filter(|_| held) {
            self.confirmed_focus = Some((label.to_owned(), sequence));
        } else if self
            .confirmed_focus
            .as_ref()
            .is_some_and(|(owner, seq)| owner == label && sequence.is_none_or(|s| s == *seq))
        {
            self.confirmed_focus = None;
        }
        let click = self
            .pending
            .as_ref()
            .filter(|p| {
                p.label == label
                    && p.presentation
                        .as_ref()
                        .is_some_and(|p| Some(p.sequence) == sequence)
            })
            .map(|p| p.sequence);
        let event = if click.is_some() {
            self.end(
                label,
                if held { End::Acquired } else { End::Refused },
                click,
                0,
            )
        } else {
            None
        };
        (held, event)
    }

    pub fn request_focus(
        &mut self,
        label: &str,
        sequence: Option<u64>,
        before: u64,
        now: u64,
        native_focused: bool,
    ) -> FocusRequest {
        self.set_keyboard_popover(label, false);
        // A second control in a key window will not produce another focus-in event.
        if let Some((_, sequence)) = self
            .confirmed_focus
            .as_ref()
            .filter(|(owner, _)| native_focused && owner == label)
        {
            return FocusRequest::Focused(*sequence);
        }
        let Some(p) = self.pending.as_mut().filter(|p| {
            p.label == label
                && p.native_time != 0
                && match sequence {
                    // The pointerdown may still have the preceding click's sequence if the
                    // native event is in flight. Its wall time can identify the newer click.
                    Some(seq) => p.sequence == seq || (seq < p.sequence && p.wall_time < before),
                    None => before == 0 || p.wall_time <= before,
                }
        }) else {
            return FocusRequest::Denied;
        };
        let remaining_ms = TIMEOUT_MS.saturating_sub(now.saturating_sub(p.started));
        if remaining_ms == 0 {
            return FocusRequest::Denied;
        }
        // A delayed presentation may already have made the window key. A fresh
        // click can acquire it without waiting for another focus-in transition.
        let mut presentation = Presentation {
            sequence: p.sequence,
            deadline: p.started + TIMEOUT_MS,
            confirmation: None,
        };
        let request = if native_focused {
            FocusRequest::Focused(p.sequence)
        } else {
            let (reply, confirmed) = tokio::sync::oneshot::channel();
            presentation.confirmation = Some(reply);
            FocusRequest::Present {
                sequence: p.sequence,
                timestamp: p.native_time,
                pressed_at: p.started,
                remaining_ms,
                confirmed,
            }
        };
        p.presentation = Some(presentation);
        request
    }
}

/// An X11 client may take the focus for its own window only with the server timestamp of
/// the press that asked for it. GDK_CURRENT_TIME (0) is never a valid click time, and native
/// Wayland has no such request.
#[cfg(any(target_os = "linux", test))]
pub(super) fn click_focus_time(x11: bool, timestamp: u32) -> Option<u32> {
    (x11 && timestamp != 0).then_some(timestamp)
}

/// How long before a palette press a ChemDraft toplevel may have lost focus for the press to
/// count as part of a click inside ChemDraft. The focus handoff happens inside the dispatch of
/// the press: the window manager handles the button press and moves focus, and GTK sees the
/// loss, so it lands within milliseconds of the press, or after it (`app-focus-lost=` in the
/// acquire log records the real figure). A person switching away first takes longer: the
/// Keystroke-Level Model (Card, Moran and Newell, 1980) puts moving a hand from the keyboard to
/// the mouse alone at 400 ms, before any pointing. 300 ms leaves the handoff ample room on a
/// loaded machine and stays under that.
#[cfg(any(target_os = "linux", test))]
pub(super) const FOCUS_HANDOFF_MS: u64 = 300;

/// Whether a ChemDraft toplevel lost focus close enough to the press, for an acquisition that
/// finds no ChemDraft toplevel focused. `lost_at` is the last time any ChemDraft toplevel lost
/// focus and `pressed_at` the press, both on the same monotonic clock. A loss after the press
/// means the app was in front when the user pressed; one up to `FOCUS_HANDOFF_MS` before it
/// can be the window manager handing the click to the palette. Never losing focus means
/// ChemDraft never had it, and an older loss means another application was in front.
#[cfg(any(target_os = "linux", test))]
pub(super) fn focus_handoff(lost_at: Option<u64>, pressed_at: u64) -> bool {
    lost_at.is_some_and(|lost| pressed_at.saturating_sub(lost) <= FOCUS_HANDOFF_MS)
}

/// Which X window holds the keyboard when a field acquisition runs, classified from
/// `XGetInputFocus` and the root window's `_NET_ACTIVE_WINDOW`. The ids are X window ids
/// (Xlib's `Window`, a C `unsigned long`), kept for the acquire log.
#[cfg(any(target_os = "linux", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum FocusHolder {
    /// A ChemDraft X window: one of its toplevels or a child of one.
    ChemDraft(std::os::raw::c_ulong),
    /// X focus is `None`.
    NoFocus,
    /// X focus is `PointerRoot`.
    PointerRoot,
    /// X focus is the root window.
    Root,
    /// An X window no client manages (no `WM_STATE` on it, its ancestors or its frame's
    /// client): the window manager's own no-focus window.
    WindowManager(std::os::raw::c_ulong),
    /// Another client's window holds X focus, or `_NET_ACTIVE_WINDOW` names one.
    Other(std::os::raw::c_ulong),
    /// The GDK backend is not X11 (native Wayland), so there is no X focus to read.
    NotX11,
    /// An X query failed, so the holder cannot be known.
    Unknown,
}

#[cfg(any(target_os = "linux", test))]
impl FocusHolder {
    /// The value of the acquire log's `focus-holder=` field.
    pub fn describe(self) -> String {
        match self {
            Self::ChemDraft(xid) => format!("chemdraft(0x{xid:x})"),
            Self::NoFocus => "none".to_owned(),
            Self::PointerRoot => "pointer-root".to_owned(),
            Self::Root => "root".to_owned(),
            Self::WindowManager(xid) => format!("wm(0x{xid:x})"),
            Self::Other(xid) => format!("other(0x{xid:x})"),
            Self::NotX11 => "n/a".to_owned(),
            Self::Unknown => "unknown".to_owned(),
        }
    }
}

/// Where the last ChemDraft focus loss falls relative to the press, for the acquire log.
#[cfg(any(target_os = "linux", test))]
pub(super) fn describe_focus_loss(lost_at: Option<u64>, request: &FocusRequest) -> String {
    let FocusRequest::Present { pressed_at, .. } = request else {
        return "n/a".to_owned();
    };
    match lost_at {
        None => "never".to_owned(),
        Some(lost) if lost > *pressed_at => format!("{}ms-after-press", lost - pressed_at),
        Some(lost) => format!("{}ms-before-press", pressed_at - lost),
    }
}

/// Why a Linux field acquisition stops before it touches native focus, or `None` to go on.
/// `app_foreground` is whether any ChemDraft toplevel holds focus when the IPC runs,
/// `focus_holder` which X window holds the keyboard then, and `app_focus_lost_at` the last
/// time a ChemDraft toplevel lost focus (see `focus_handoff`).
///
/// Linux matches Windows and macOS (owner decision, 2026-11-21): a click on a palette field
/// while another application is really in front does not take the keyboard; the user clicks a
/// ChemDraft window first. The one exception is the X11 focus handoff race. A window manager
/// can move X focus off the document while it offers the click to the palette (which is not
/// yet accepting focus), so no ChemDraft toplevel holds focus when the IPC runs even though
/// ChemDraft was in front at the press. Without app focus, then, only a `Present` request goes
/// on, and only with positive evidence of that race:
///
/// - the X focus holder is a ChemDraft window, or nobody's (`None`, `PointerRoot`, the root
///   window, or the window manager's no-focus window). Another client's window refuses, since
///   that application is in front (`denied:other-app-focused`), and so does a failed X query
///   (`denied:focus-holder-unknown`);
/// - and a ChemDraft toplevel lost focus at most `FOCUS_HANDOFF_MS` before the press, or after
///   it.
///
/// `request_focus` returns `Present` only for a GTK button press on this same window, with a
/// server timestamp, less than `TIMEOUT_MS` old, so a JavaScript-only, delayed or zero-time
/// request has no live press and stays refused. The X server ignores the click-time
/// `XSetInputFocus` if focus changed after the press, so a later switch to another
/// application wins.
///
/// Known limit, XWayland only: a native Wayland application in front is invisible to X. The
/// compositor's X window manager then leaves X focus on its no-focus window, on `None`, or
/// on the ChemDraft window that last had it, and `_NET_ACTIVE_WINDOW` names no X window, the
/// same readings the handoff itself can produce. Only the time bound applies there: a palette
/// click within `FOCUS_HANDOFF_MS` of switching from ChemDraft to a native Wayland
/// application can still take focus. Under native Wayland (`NotX11`) ChemDraft makes no X
/// focus call, and the compositor alone decides whether the presentation gets focus.
#[cfg(any(target_os = "linux", test))]
pub(super) fn acquire_refusal(
    visible: bool,
    minimized: bool,
    app_foreground: bool,
    focus_holder: FocusHolder,
    app_focus_lost_at: Option<u64>,
    request: &FocusRequest,
) -> Option<&'static str> {
    if !visible {
        Some("denied:hidden")
    } else if minimized {
        Some("denied:minimized")
    } else if app_foreground {
        None
    } else {
        match request {
            FocusRequest::Present { .. } if matches!(focus_holder, FocusHolder::Other(_)) => {
                Some("denied:other-app-focused")
            }
            FocusRequest::Present { .. } if focus_holder == FocusHolder::Unknown => {
                Some("denied:focus-holder-unknown")
            }
            FocusRequest::Present { pressed_at, .. }
                if focus_handoff(app_focus_lost_at, *pressed_at) =>
            {
                None
            }
            FocusRequest::Present { .. } => Some("denied:app-not-focused-at-press"),
            _ => Some("denied:app-not-focused"),
        }
    }
}

#[cfg(any(target_os = "linux", test))]
pub(super) fn blocks_document_key(
    pending: bool,
    leased: bool,
    key: &str,
    meta: bool,
    ctrl: bool,
    alt: bool,
) -> bool {
    (pending || leased)
        && (editing_key(key, meta, ctrl, alt)
            || (!meta
                && !alt
                && matches!(
                    key.strip_prefix("KP_").unwrap_or(key),
                    "Left"
                        | "Right"
                        | "Up"
                        | "Down"
                        | "Home"
                        | "End"
                        | "Page_Up"
                        | "Page_Down"
                        | "Tab"
                        | "ISO_Left_Tab"
                        | "Return"
                        | "Enter"
                        | "Escape"
                )))
}

pub(crate) fn blocks_menu(pending: bool, document_target: bool, command: &str) -> bool {
    pending
        && document_target
        && matches!(
            command,
            "edit.selectAll"
                | "clipboard.cut"
                | "clipboard.paste"
                | "edit.cut"
                | "edit.paste"
                | "edit.delete"
                | "edit.clear"
                | "edit.deleteSelection"
                | "edit.deleteHoveredNativeTarget"
                | "edit.undo"
                | "edit.redo"
        )
}

/// Panel IPC and native document keys use the same pending-click policy.
pub(crate) fn blocks_forwarded_shortcut(
    pending: bool,
    key: &str,
    meta: bool,
    ctrl: bool,
    alt: bool,
) -> bool {
    pending && editing_key(key, meta, ctrl, alt)
}

pub(crate) fn keeps_palette_focus(label: &str, held: bool) -> bool {
    label.starts_with("toolset-") && held
}

/// AppKit supplies charactersIgnoringModifiers, including private-use function keys.
pub(super) fn editing_key(key: &str, command: bool, control: bool, alt: bool) -> bool {
    // Panel IPC uses browser key names; normalize them to AppKit equivalents.
    let key = match key {
        "Backspace" => "\u{8}",
        "Delete" => "\u{f728}",
        _ => key,
    };
    if matches!(key, "\u{8}" | "\u{7f}" | "\u{f728}") {
        return true;
    }
    if command || control {
        return !alt
            && matches!(
                key.to_ascii_lowercase().as_str(),
                "a" | "x" | "v" | "z" | "y"
            );
    }
    let mut chars = key.chars();
    chars
        .next()
        .is_some_and(|c| !c.is_control() && !(('\u{f700}'..='\u{f8ff}').contains(&c)))
        && chars.next().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn x11_click_focus_uses_only_a_real_click_time() {
        assert_eq!(click_focus_time(true, 42), Some(42));
        assert_eq!(click_focus_time(true, 0), None);
        assert_eq!(click_focus_time(false, 42), None);
        assert_eq!(click_focus_time(false, 0), None);
    }

    const LABELS: [&str; 2] = [
        "toolset-core-drawnStructureSettings",
        "plugin-panel-example",
    ];

    /// A live GTK press on `label` at monotonic time 100 (X time 511_203), asked for at 120.
    fn live_press(label: &str) -> FocusRequest {
        let mut guard = Guard::new();
        let click = guard.gtk_pointer(label, 100, 1_000, 511_203);
        guard.request_focus(label, Some(click.sequence), 1_000, 120, false)
    }

    /// X focus holders the handoff race can leave: still a ChemDraft window, or nobody's.
    /// Native Wayland has no X focus to read.
    const HANDOFF_HOLDERS: [FocusHolder; 6] = [
        FocusHolder::ChemDraft(0x2a0_0007),
        FocusHolder::NoFocus,
        FocusHolder::PointerRoot,
        FocusHolder::Root,
        FocusHolder::WindowManager(0x60_0001),
        FocusHolder::NotX11,
    ];

    /// A terminal's window: another X client holds the keyboard.
    const TERMINAL: FocusHolder = FocusHolder::Other(0x3c0_0004);

    #[test]
    fn the_x11_focus_handoff_race_lets_the_palette_press_take_focus() {
        // The document had focus. As it hands the click to the palette, the window manager
        // moves X focus off the document, so no ChemDraft toplevel holds focus when the IPC
        // runs. The press still came from inside ChemDraft.
        for label in LABELS {
            let request = live_press(label);
            assert!(matches!(
                request,
                FocusRequest::Present {
                    timestamp: 511_203,
                    pressed_at: 100,
                    ..
                }
            ));
            for holder in HANDOFF_HOLDERS {
                // The document lost focus just before the press, at the press, or after it
                // (GTK may process the focus-out after the button press).
                for lost_at in [99, 100, 110, 125] {
                    assert_eq!(
                        acquire_refusal(true, false, false, holder, Some(lost_at), &request),
                        None,
                        "{label} {holder:?} lost at {lost_at}"
                    );
                }
                // Up to FOCUS_HANDOFF_MS before the press, inclusive. Time 0 is the earliest
                // monotonic reading, so it needs a later press.
                let mut guard = Guard::new();
                let click = guard.gtk_pointer(label, FOCUS_HANDOFF_MS + 5, 1_000, 511_203);
                let late = guard.request_focus(
                    label,
                    Some(click.sequence),
                    1_000,
                    FOCUS_HANDOFF_MS + 20,
                    false,
                );
                assert_eq!(
                    acquire_refusal(true, false, false, holder, Some(5), &late),
                    None,
                    "{label} {holder:?}"
                );
            }
            assert_eq!(describe_focus_loss(Some(99), &request), "1ms-before-press");
            assert_eq!(describe_focus_loss(Some(125), &request), "25ms-after-press");
            // With ChemDraft still focused, neither the X holder nor focus loss matters.
            for holder in HANDOFF_HOLDERS
                .into_iter()
                .chain([TERMINAL, FocusHolder::Unknown])
            {
                assert_eq!(
                    acquire_refusal(true, false, true, holder, None, &request),
                    None
                );
            }
        }
    }

    #[test]
    fn alt_tab_to_another_app_then_a_palette_click_does_not_take_focus() {
        // Kimi review of 0b210e2b: Alt+Tab from ChemDraft to a terminal, then click a visible
        // palette field within a second. The recent ChemDraft focus loss alone satisfied the
        // old one-second handoff rule, so XSetInputFocus took the keyboard from the terminal.
        // Parity with Windows and macOS (owner decision, 2026-11-21): the terminal holds X
        // focus, so the click is refused however recent the loss.
        for label in LABELS {
            let mut guard = Guard::new();
            let click = guard.gtk_pointer(label, 5_000, 9_000, 511_203);
            let request = guard.request_focus(label, Some(click.sequence), 9_000, 5_020, false);
            assert!(matches!(request, FocusRequest::Present { .. }));
            for since_loss in [0, 50, FOCUS_HANDOFF_MS, 600, 999] {
                assert_eq!(
                    acquire_refusal(
                        true,
                        false,
                        false,
                        TERMINAL,
                        Some(5_000 - since_loss),
                        &request
                    ),
                    Some("denied:other-app-focused"),
                    "{label} {since_loss}ms after the switch"
                );
                // A failed X query cannot prove the handoff either.
                assert_eq!(
                    acquire_refusal(
                        true,
                        false,
                        false,
                        FocusHolder::Unknown,
                        Some(5_000 - since_loss),
                        &request
                    ),
                    Some("denied:focus-holder-unknown"),
                    "{label} {since_loss}ms"
                );
            }
        }
    }

    #[test]
    fn a_palette_press_while_another_app_is_in_front_does_not_take_focus() {
        // Parity with Windows and macOS (owner decision, 2026-11-21): another application is
        // really in front, so the keys stay with it and the user must click ChemDraft first.
        // eea7e344 allowed every live press here; this test fails against that rule. Even
        // with no foreign X window holding focus (a native Wayland application in front of
        // XWayland reads that way), a loss older than FOCUS_HANDOFF_MS is no handoff.
        for label in LABELS {
            let mut guard = Guard::new();
            let click = guard.gtk_pointer(label, 5_000, 9_000, 511_203);
            let request = guard.request_focus(label, Some(click.sequence), 9_000, 5_020, false);
            assert!(matches!(request, FocusRequest::Present { .. }));
            for holder in HANDOFF_HOLDERS {
                // ChemDraft never had focus in this session.
                assert_eq!(
                    acquire_refusal(true, false, false, holder, None, &request),
                    Some("denied:app-not-focused-at-press"),
                    "{label} {holder:?}"
                );
                // ChemDraft lost focus more than the handoff window before the press,
                // including losses the old one-second window accepted.
                for lost_at in [0, 2_000, 4_400, 5_000 - FOCUS_HANDOFF_MS - 1] {
                    assert_eq!(
                        acquire_refusal(true, false, false, holder, Some(lost_at), &request),
                        Some("denied:app-not-focused-at-press"),
                        "{label} {holder:?} lost at {lost_at}"
                    );
                }
            }
            assert_eq!(describe_focus_loss(None, &request), "never");
            assert_eq!(
                describe_focus_loss(Some(2_000), &request),
                "3000ms-before-press"
            );
        }
    }

    #[test]
    fn hidden_minimized_and_unbacked_requests_stay_refused() {
        // Hidden and minimized windows are refused whatever the focus history or X holder.
        for label in LABELS {
            let request = live_press(label);
            for holder in HANDOFF_HOLDERS
                .into_iter()
                .chain([TERMINAL, FocusHolder::Unknown])
            {
                for (foreground, lost_at) in [(true, None), (false, Some(100)), (false, None)] {
                    assert_eq!(
                        acquire_refusal(false, false, foreground, holder, lost_at, &request),
                        Some("denied:hidden")
                    );
                    assert_eq!(
                        acquire_refusal(true, true, foreground, holder, lost_at, &request),
                        Some("denied:minimized")
                    );
                }
            }
        }
        // Requests without a live press on this palette are refused without app focus,
        // even when the document lost focus a moment ago and nobody holds X focus.
        let label = LABELS[0];
        let refused = |guard: &mut Guard, sequence, now| {
            let request = guard.request_focus(label, sequence, 100, now, false);
            assert!(matches!(request, FocusRequest::Denied));
            assert_eq!(describe_focus_loss(Some(now), &request), "n/a");
            for holder in HANDOFF_HOLDERS.into_iter().chain([TERMINAL]) {
                assert_eq!(
                    acquire_refusal(true, false, false, holder, Some(now), &request),
                    Some("denied:app-not-focused"),
                    "{holder:?}"
                );
            }
            acquire_refusal(
                true,
                false,
                false,
                FocusHolder::NoFocus,
                Some(now),
                &request,
            )
        };
        // JS-only: the page asks with no GTK press at all.
        let mut guard = Guard::new();
        assert_eq!(
            refused(&mut guard, None, 20),
            Some("denied:app-not-focused")
        );
        assert_eq!(
            refused(&mut guard, Some(1), 20),
            Some("denied:app-not-focused")
        );
        // A press with no server timestamp cannot be proved to be the user's.
        let click = guard.gtk_pointer(label, 10, 100, 0);
        assert_eq!(
            refused(&mut guard, Some(click.sequence), 20),
            Some("denied:app-not-focused")
        );
        // A press on another window, or one that has expired, is not this request's.
        let mut guard = Guard::new();
        let click = guard.gtk_pointer("toolset-core-main", 10, 100, 42);
        assert_eq!(
            refused(&mut guard, Some(click.sequence), 20),
            Some("denied:app-not-focused")
        );
        let mut guard = Guard::new();
        let click = guard.gtk_pointer(label, 10, 100, 42);
        assert_eq!(
            refused(&mut guard, Some(click.sequence), 10 + TIMEOUT_MS),
            Some("denied:app-not-focused")
        );
        // An outside click or hide ended the press before the IPC arrived.
        let mut guard = Guard::new();
        let click = guard.gtk_pointer(label, 10, 100, 42);
        guard.end("", End::Outside, None, 0);
        assert_eq!(
            refused(&mut guard, Some(click.sequence), 20),
            Some("denied:app-not-focused")
        );
        // With ChemDraft focused, a request without a press passes the gate but presents
        // nothing (unchanged): only `Present` ever calls XSetInputFocus.
        assert_eq!(
            acquire_refusal(
                true,
                false,
                true,
                FocusHolder::NoFocus,
                None,
                &FocusRequest::Denied
            ),
            None
        );
    }

    #[test]
    fn the_acquire_log_names_the_x_focus_holder() {
        let described: Vec<String> = HANDOFF_HOLDERS
            .into_iter()
            .chain([TERMINAL, FocusHolder::Unknown])
            .map(FocusHolder::describe)
            .collect();
        assert_eq!(
            described,
            [
                "chemdraft(0x2a00007)",
                "none",
                "pointer-root",
                "root",
                "wm(0x600001)",
                "n/a",
                "other(0x3c00004)",
                "unknown",
            ]
        );
    }

    #[test]
    fn acquisition_diagnostic_names_the_native_click() {
        let mut guard = Guard::new();
        assert_eq!(guard.describe_pending_click(), "gtk-click=none");
        let click = guard.gtk_pointer("toolset-structure", 10, 100, 42);
        assert_eq!(
            guard.describe_pending_click(),
            format!("gtk-click=toolset-structure#{} gtk-time=42", click.sequence)
        );
        guard.end("", End::Outside, None, 0);
        assert_eq!(guard.describe_pending_click(), "gtk-click=none");
    }

    #[test]
    fn presentation_uses_the_native_click_and_waits_for_its_window() {
        use tokio::sync::oneshot::error::TryRecvError;
        for label in ["toolset-structure", "plugin-panel-example"] {
            let mut guard = Guard::new();
            assert!(matches!(
                guard.request_focus(label, None, 0, 10, true),
                FocusRequest::Denied
            ));
            let click = guard.gtk_pointer(label, 10, 100, 42);
            let FocusRequest::Present {
                timestamp,
                remaining_ms,
                mut confirmed,
                ..
            } = guard.request_focus(label, Some(click.sequence), 0, 20, false)
            else {
                panic!("expected a pending focus request");
            };
            assert_eq!(timestamp, 42);
            assert_eq!(remaining_ms, TIMEOUT_MS - 10);
            guard.focus_in("another-window", 21);
            assert_eq!(confirmed.try_recv(), Err(TryRecvError::Empty));
            if !crate::is_plugin_panel_window_label(label) {
                // The palette frontend shares a single acquisition across a double-click.
                assert_ne!(
                    guard.gtk_pointer(label, 22, 112, 54).sequence,
                    click.sequence
                );
            }
            guard.focus_in(label, 23);
            assert_eq!(confirmed.try_recv(), Ok(()));
            if !crate::is_plugin_panel_window_label(label) {
                // A click can also precede the queued UI-thread completion.
                guard.gtk_pointer(label, 24, 114, 56);
            }
            assert!(!guard.allows_window_keys(label));
            assert!(
                guard
                    .finish_focus(label, Some(click.sequence), 24, |eligible| eligible)
                    .0
            );
            assert!(guard.allows_window_keys(label));
            assert!(matches!(
                guard.request_focus(label, None, 0, 30, true),
                FocusRequest::Focused(_)
            ));
            guard.end(label, End::Deactivated, None, 0);
            assert!(matches!(
                guard.request_focus(label, None, 0, 31, true),
                FocusRequest::Denied
            ));
        }
    }

    #[test]
    fn timeout_hide_and_other_clicks_deny_unconfirmed_focus() {
        use tokio::sync::oneshot::error::TryRecvError;
        let label = "toolset-inspector";
        for end in [End::Hide, End::Destroy, End::Deactivated, End::Outside] {
            let mut guard = Guard::new();
            guard.gtk_pointer(label, 0, 100, 7);
            let FocusRequest::Present { mut confirmed, .. } =
                guard.request_focus(label, None, 0, 1, false)
            else {
                panic!("expected a pending focus request");
            };
            guard.end(label, end, None, 0);
            guard.focus_in(label, 2);
            assert_eq!(confirmed.try_recv(), Err(TryRecvError::Closed));
        }
        let mut guard = Guard::new();
        let click = guard.gtk_pointer(label, 0, 100, 7);
        assert!(matches!(
            guard.request_focus(label, Some(click.sequence + 1), 0, 1, false),
            FocusRequest::Denied
        ));
        let FocusRequest::Present { mut confirmed, .. } =
            guard.request_focus(label, None, 0, 0, false)
        else {
            panic!("expected a pending focus request");
        };
        guard.focus_in(label, TIMEOUT_MS);
        assert_eq!(confirmed.try_recv(), Err(TryRecvError::Empty));
        guard.timeout(click.sequence, TIMEOUT_MS);
        assert_eq!(confirmed.try_recv(), Err(TryRecvError::Closed));
        assert!(matches!(
            guard.request_focus(label, None, 0, TIMEOUT_MS, false),
            FocusRequest::Denied
        ));
    }

    #[tokio::test]
    async fn missing_focus_event_has_a_bounded_ipc_reply() {
        let mut guard = Guard::new();
        guard.gtk_pointer("palette", 0, 100, 7);
        let request = guard.request_focus("palette", None, 0, TIMEOUT_MS - 1, false);
        assert!(!request.confirmed().await);
        guard.focus_in("palette", TIMEOUT_MS + 1);
        guard.end("palette", End::Hide, None, 0);
        assert!(
            !guard
                .request_focus("palette", None, 0, TIMEOUT_MS + 2, false)
                .confirmed()
                .await
        );
    }

    #[tokio::test]
    async fn a_click_in_another_window_revokes_the_first_presentation() {
        let mut guard = Guard::new();
        let first = guard.gtk_pointer("palette", 0, 100, 7);
        let waiting = guard.request_focus("palette", Some(first.sequence), 101, 1, false);
        guard.gtk_pointer("panel", 2, 102, 9);
        guard.focus_in("palette", 3);
        assert!(!waiting.confirmed().await);
        // A delayed IPC predating this panel click cannot borrow its timestamp.
        assert!(matches!(
            guard.request_focus("panel", None, 101, 4, false),
            FocusRequest::Denied
        ));
        let waiting = guard.request_focus("panel", None, 103, 4, false);
        guard.focus_in("panel", 5);
        assert!(waiting.confirmed().await);
    }

    #[test]
    fn refused_and_expired_presentations_cannot_authorize_keys_on_late_focus_in() {
        for label in ["plugin-panel-example", "toolset-inspector"] {
            for expired in [false, true] {
                let mut guard = Guard::new();
                let click = guard.gtk_pointer(label, 0, 100, 7);
                let request = guard.request_focus(label, Some(click.sequence), 101, 1, false);
                if expired {
                    guard.timeout(click.sequence, TIMEOUT_MS);
                } else {
                    guard.finish_focus(label, request.sequence(), 2, |_| false);
                }
                guard.focus_in(label, TIMEOUT_MS + 1);
                assert!(!guard.blocks(TIMEOUT_MS + 1));
                assert!(!guard.allows_window_keys(label));
                assert!(matches!(
                    guard.request_focus(label, None, 0, TIMEOUT_MS + 2, true),
                    FocusRequest::Denied
                ));
                // Even a completion that sampled focus before expiry cannot commit later.
                assert!(
                    !guard
                        .finish_focus(label, request.sequence(), TIMEOUT_MS + 3, |eligible| {
                            eligible
                        })
                        .0
                );
                assert!(!guard.has_confirmed_focus(label));

                // The user can acquire the now physically focused window with a fresh click.
                let retry = guard.gtk_pointer(label, TIMEOUT_MS + 4, 1200, 8);
                let request =
                    guard.request_focus(label, Some(retry.sequence), 1201, TIMEOUT_MS + 5, true);
                assert!(matches!(request, FocusRequest::Focused(_)));
                assert!(
                    guard
                        .finish_focus(label, request.sequence(), TIMEOUT_MS + 6, |eligible| {
                            eligible
                        })
                        .0
                );
                assert!(guard.allows_window_keys(label));
            }
        }
    }

    #[test]
    fn closing_a_window_cancels_even_a_grant_already_queued_for_its_page() {
        for label in ["plugin-panel-example", "toolset-inspector"] {
            for close in [End::Hide, End::Destroy] {
                let mut guard = Guard::new();
                let click = guard.gtk_pointer(label, 0, 100, 7);
                let first = guard.request_focus(label, Some(click.sequence), 101, 1, false);
                guard.focus_in(label, 2);
                guard.end(label, close, None, 0);
                guard.focus_in(label, 3);
                assert!(!guard.allows_window_keys(label));

                let reopened = guard.gtk_pointer(label, 4, 104, 8);
                let next = guard.request_focus(label, Some(reopened.sequence), 105, 5, false);
                assert!(
                    !guard
                        .finish_focus(label, first.sequence(), 6, |eligible| eligible)
                        .0
                );
                assert!(guard.blocks(6));
                assert!(!guard.allows_window_keys(label));
                guard.focus_in(label, 7);
                assert!(
                    guard
                        .finish_focus(label, next.sequence(), 8, |eligible| eligible)
                        .0
                );
                assert!(guard.allows_window_keys(label));
            }
        }
    }

    #[tokio::test]
    async fn superseded_grant_cannot_commit_or_clear_the_second_acquisition() {
        for label in ["plugin-panel-example", "toolset-inspector"] {
            let mut guard = Guard::new();
            let first = guard.gtk_pointer(label, 0, 100, 7);
            let request = guard.request_focus(label, Some(first.sequence), 101, 1, false);
            guard.focus_in(label, 2);
            assert!(request.confirmed().await);
            let second = guard.gtk_pointer(label, 3, 103, 8);
            let retry = guard.request_focus(label, Some(second.sequence), 104, 4, false);
            // GTK cannot tag focus-in with an epoch. The notification can wake the
            // retry, but only the retry can explicitly acquire the now-focused window.
            guard.focus_in(label, 5);
            assert!(retry.confirmed().await);
            assert!(!guard.allows_window_keys(label));
            assert!(
                !guard
                    .finish_focus(label, Some(first.sequence), 6, |eligible| eligible)
                    .0
            );
            assert!(guard.blocks(6));
            assert!(
                guard
                    .finish_focus(label, Some(second.sequence), 7, |eligible| eligible)
                    .0
            );
            assert!(
                !guard
                    .finish_focus(label, Some(first.sequence), 8, |eligible| eligible)
                    .0
            );
            assert!(guard.allows_window_keys(label));
        }
    }

    #[test]
    fn keyboard_popover_navigation_needs_no_field_and_ends_on_close_or_mouse_reopen() {
        let label = "toolset-popover-stereo";
        let mut guard = Guard::new();
        for close in [true, false] {
            guard.set_keyboard_popover(label, true);
            assert!(guard.allows_window_keys(label));
            assert!(!guard.has_confirmed_focus(label));
            if close {
                guard.end(label, End::Hide, None, 0);
            } else {
                guard.set_keyboard_popover(label, false);
            }
            assert!(!guard.allows_window_keys(label));
        }
    }

    #[test]
    fn document_key_presses_guard_the_field_before_and_after_confirmation() {
        for (pending, leased) in [(true, false), (false, true)] {
            for key in [
                "3",
                "0",
                "n",
                "Delete",
                "Backspace",
                "Return",
                "Left",
                "KP_Up",
                "ISO_Left_Tab",
            ] {
                assert!(blocks_document_key(
                    pending, leased, key, false, false, false
                ));
                assert!(!blocks_document_key(false, false, key, false, false, false));
            }
            assert!(blocks_document_key(
                pending, leased, "a", false, true, false
            ));
            assert!(!blocks_document_key(
                pending, leased, "s", false, true, false
            ));
        }
    }

    #[test]
    fn every_terminal_path_clears_pending_only() {
        for why in [
            End::Acquired,
            End::Refused,
            End::Released,
            End::Drag,
            End::Hide,
            End::Destroy,
            End::Deactivated,
            End::Outside,
        ] {
            let mut guard = Guard::new();
            let event = guard.pointer("toolset-a", 10, 100);
            assert!(guard.blocks(10));
            assert!(
                !guard
                    .end("toolset-a", why, Some(event.sequence), 100)
                    .unwrap()
                    .1
                    .pending
            );
            assert!(!guard.blocks(11));
        }
    }

    #[test]
    fn delayed_releases_refusals_and_timers_cannot_clear_a_later_click() {
        let mut guard = Guard::new();
        let first = guard.pointer("toolset-a", 0, 100);
        let second = guard.pointer("toolset-a", 10, 110);
        for why in [End::Released, End::Refused] {
            assert!(guard
                .end("toolset-a", why, Some(first.sequence), 200)
                .is_none());
            // Same-millisecond ambiguity fails closed, not by clearing the new click.
            assert!(guard.end("toolset-a", why, None, 110).is_none());
        }
        assert!(guard.timeout(first.sequence, 1_001).is_none());
        assert!(guard.blocks(1_001));
        assert!(guard.end("toolset-b", End::Hide, None, 0).is_none());
        assert!(guard.timeout(second.sequence, 1_009).is_none());
        assert!(!guard.blocks(1_010)); // Native monitor's clock needs no timer delivery.
        assert!(!guard.timeout(second.sequence, 1_010).unwrap().1.pending);
    }

    #[test]
    fn a_document_page_releases_only_a_click_pending_in_its_own_palettes() {
        let mut guard = Guard::new();
        let office = "office-utility-office-object-17--toolset-core-main";
        let click = guard.pointer(office, 0, 100);
        let owner_is = |document: &'static str| {
            move |label: &str| {
                label == document || label.starts_with(&format!("office-utility-{document}--"))
            }
        };
        // Another document's page (the main window, or a different Office editor) cannot clear it.
        assert!(guard
            .release_for(owner_is("main"), Some(click.sequence), 200)
            .is_none());
        assert!(guard
            .release_for(owner_is("office-object-18"), Some(click.sequence), 200)
            .is_none());
        assert!(guard.blocks(10));
        // Its own page cannot clear a later click with an older sequence.
        assert!(guard
            .release_for(owner_is("office-object-17"), Some(click.sequence + 1), 200)
            .is_none());
        let (label, event) = guard
            .release_for(owner_is("office-object-17"), Some(click.sequence), 200)
            .unwrap();
        assert_eq!(label, office);
        assert!(!event.pending);
        assert!(!guard.blocks(10));
        assert!(guard
            .release_for(owner_is("office-object-17"), Some(click.sequence), 200)
            .is_none());
    }

    #[test]
    fn timestamp_fallback_and_acquisition_allow_no_stuck_guard() {
        let mut guard = Guard::new();
        guard.pointer("toolset-a", 0, 100);
        assert!(guard.end("toolset-a", End::Released, None, 101).is_some());
        guard.pointer("toolset-a", 0, 100);
        assert!(guard.end("toolset-a", End::Acquired, None, 0).is_some());
        assert!(!guard.blocks(1));
    }

    #[test]
    fn external_clears_notify_the_palette_that_owned_the_click() {
        for why in [End::Outside, End::Deactivated, End::Released] {
            let mut guard = Guard::new();
            let click = guard.pointer("toolset-a", 0, 100);
            // Document-page and app-wide notifications have no palette label.
            let (label, cleared) = guard.end("", why, None, 101).unwrap();
            assert_eq!(label, "toolset-a");
            assert_eq!(cleared.sequence, click.sequence);
            assert!(!cleared.pending);
            assert!(!guard.blocks(1));
        }
    }

    #[test]
    fn sequence_less_non_pointer_finishes_cannot_clear_a_new_click() {
        for why in [End::Released, End::Refused] {
            let mut guard = Guard::new();
            guard.pointer("toolset-a", 0, 100);
            let newer = guard.pointer("toolset-a", 10, 110);
            // Escape, blur and MutationObserver finishes omit pointerBefore; IPC
            // maps that absence to zero, even if they run after the newer click.
            assert!(guard.end("toolset-a", why, None, 0).is_none());
            assert!(guard.blocks(11));
            // A classification from pointerdown can use the timestamp fallback.
            let (label, cleared) = guard.end("toolset-a", why, None, 111).unwrap();
            assert_eq!(label, "toolset-a");
            assert_eq!(cleared.sequence, newer.sequence);
            assert!(!cleared.pending);
        }
    }

    #[test]
    fn only_editing_menu_commands_are_suppressed_and_only_while_pending() {
        for command in [
            "edit.selectAll",
            "clipboard.cut",
            "clipboard.paste",
            "edit.delete",
            "edit.clear",
            "edit.undo",
            "edit.redo",
        ] {
            assert!(blocks_menu(true, true, command));
            assert!(!blocks_menu(false, true, command));
            assert!(!blocks_menu(true, false, command));
        }
        for command in [
            "document.save",
            "document.saveAs",
            "document.open",
            "document.close",
            "app.quit",
            "app.hide",
            "export.open",
            "view.toggleRulers",
            "clipboard.copy",
            "clipboard.copyAs.smiles",
            "preferences.open",
        ] {
            assert!(!blocks_menu(true, true, command), "{command}");
        }
    }

    #[test]
    fn acquired_and_refused_clicks_restore_document_menus() {
        for why in [End::Acquired, End::Refused] {
            let mut guard = Guard::new();
            let click = guard.pointer("toolset-a", 0, 100);
            assert!(blocks_menu(guard.blocks(1), true, "edit.selectAll"));
            assert!(!blocks_menu(guard.blocks(1), true, "document.save"));
            guard.end("toolset-a", why, Some(click.sequence), 100);
            for command in [
                "edit.selectAll",
                "edit.undo",
                "document.save",
                "export.open",
            ] {
                assert!(!blocks_menu(guard.blocks(2), true, command));
            }
        }
    }

    #[test]
    fn app_loss_clears_any_owner_but_panel_loss_only_clears_that_panel() {
        let mut guard = Guard::new();
        guard.pointer("toolset-b", 0, 100);
        assert!(guard.end("toolset-a", End::Deactivated, None, 0).is_none());
        assert!(guard.blocks(1));
        assert!(guard.end("", End::Deactivated, None, 0).is_some());
        assert!(!guard.blocks(2));
    }

    #[test]
    fn toolset_routes_commands_without_refocusing_a_held_palette() {
        assert!(keeps_palette_focus("toolset-core-main", true));
        assert!(!keeps_palette_focus("toolset-core-main", false));
        assert!(!keeps_palette_focus("main", true));
        assert!(!keeps_palette_focus("plugin-panel-a", true));
    }

    #[test]
    fn mac_key_equivalents_preserve_app_shortcuts() {
        for key in ["a", "A", "x", "v", "z", "Z", "y"] {
            assert!(editing_key(key, true, false, false));
            assert!(editing_key(key, false, true, false));
        }
        for key in ["s", "S", "q", "h", "w", "o", ",", "c", "m"] {
            assert!(!editing_key(key, true, false, false));
        }
        for key in ["k", "K", "3", " ", "\u{8}", "\u{7f}", "\u{f728}"] {
            assert!(editing_key(key, false, false, false));
        }
        for key in ["\u{1b}", "\t", "\r", "\u{f700}"] {
            assert!(!editing_key(key, false, false, false));
        }
    }
}

#[cfg(test)]
mod forwarded_shortcut_tests {
    use super::*;
    #[test]
    fn panel_forwarding_respects_pending_palette_clicks() {
        for (key, meta, ctrl, alt) in [
            ("3", false, false, false),
            ("N", false, false, false),
            ("Delete", false, false, false),
            ("z", true, false, false),
            ("v", false, true, false),
        ] {
            assert!(
                blocks_forwarded_shortcut(true, key, meta, ctrl, alt),
                "{key}"
            );
            assert!(!blocks_forwarded_shortcut(false, key, meta, ctrl, alt));
        }
        for (key, meta, ctrl, alt) in [
            ("s", true, false, false),
            ("r", false, true, false),
            ("c", true, false, false),
            ("ArrowDown", false, false, false),
            ("Escape", false, false, false),
        ] {
            assert!(
                !blocks_forwarded_shortcut(true, key, meta, ctrl, alt),
                "{key}"
            );
        }
    }
}
