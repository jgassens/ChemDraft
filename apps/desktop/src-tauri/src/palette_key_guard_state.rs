//! Pure pending-click policy. Times are supplied by the caller so timeout and IPC
//! ordering are testable without AppKit, WebView2 or a Tauri event loop.

pub(super) const TIMEOUT_MS: u64 = 1_000;

#[derive(Clone, Debug)]
struct Pending {
    label: String,
    sequence: u64,
    started: u64,
    wall_time: u64,
}

#[derive(Default)]
pub(super) struct Guard {
    #[cfg(any(target_os = "macos", windows, test))]
    sequence: u64,
    pending: Option<Pending>,
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
            #[cfg(any(target_os = "macos", windows, test))]
            sequence: 0,
            pending: None,
        }
    }

    #[cfg(any(target_os = "macos", windows, test))]
    pub fn pointer(&mut self, label: &str, now: u64, wall_time: u64) -> Event {
        self.sequence += 1;
        self.pending = Some(Pending {
            label: label.to_owned(),
            sequence: self.sequence,
            started: now,
            wall_time,
        });
        Event {
            sequence: self.sequence,
            pending: true,
            expires_at: wall_time + TIMEOUT_MS,
        }
    }

    pub fn blocks(&self, now: u64) -> bool {
        self.pending
            .as_ref()
            .is_some_and(|p| now.saturating_sub(p.started) < TIMEOUT_MS)
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

    #[cfg(any(target_os = "macos", windows, test))]
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

pub(crate) fn keeps_palette_focus(label: &str, held: bool) -> bool {
    label.starts_with("toolset-") && held
}

/// AppKit supplies charactersIgnoringModifiers, including private-use function keys.
#[cfg(any(target_os = "macos", test))]
pub(super) fn editing_key(key: &str, command: bool, control: bool, alt: bool) -> bool {
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
