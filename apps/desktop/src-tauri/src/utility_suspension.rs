use std::collections::{HashMap, HashSet};

/// An explicit document-group anchor, never the desktop's global frontmost position.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RestorePlacement {
    Below(String),
    Above(String),
    AboveDocument,
}

/// Shared by native prompts and, in future, in-app modal dialogs. A suspension is temporary;
/// logical toolbar visibility and persisted frames must remain unchanged throughout restoration.
#[derive(Default)]
pub(crate) struct UtilitySuspension {
    depth: usize,
    restoring: bool,
    restoring_windows: bool,
    visibility: HashMap<String, bool>,
    restore: HashSet<String>,
    /// Bottom to top, retained for the whole cycle, including already-restored siblings.
    restore_order: Vec<String>,
    recovery_positions: HashMap<String, HashSet<(i32, i32)>>,
    deferred_panels: HashMap<String, super::OpenPluginPanelRequest>,
}

impl UtilitySuspension {
    pub(crate) fn active(&self) -> bool {
        self.depth != 0 || self.restoring
    }

    pub(crate) fn visible(&self, label: &str, actual: bool) -> bool {
        self.visibility.get(label).copied().unwrap_or(actual)
    }

    pub(crate) fn begin(
        &mut self,
        windows: impl IntoIterator<Item = (String, bool, bool)>,
        top_to_bottom: Option<Vec<String>>,
    ) -> bool {
        let already_active = self.active();
        self.depth += 1;
        if already_active {
            return false;
        }
        for (label, visible, minimized) in windows {
            self.visibility.insert(label.clone(), visible);
            if visible && !minimized {
                self.restore.insert(label.clone());
                self.restore_order.push(label);
            }
        }
        if let Some(order) = top_to_bottom {
            let fallback = std::mem::take(&mut self.restore_order);
            let mut seen = HashSet::new();
            self.restore_order = order
                .into_iter()
                .rev()
                .chain(fallback)
                .filter(|label| self.restore.contains(label) && seen.insert(label.clone()))
                .collect();
        }
        true
    }

    pub(crate) fn defer_panel(&mut self, label: String, request: super::OpenPluginPanelRequest) {
        self.defer_show(label.clone());
        self.deferred_panels.insert(label, request);
    }

    pub(crate) fn has_deferred_panel(&self, label: &str) -> bool {
        self.deferred_panels.contains_key(label)
    }

    /// Drain on the creation worker after the main-thread restore transaction. Building on the
    /// main thread deadlocks WebView2; building during a prompt orders macOS children onscreen.
    pub(crate) fn take_deferred_panels(
        &mut self,
    ) -> Option<HashMap<String, super::OpenPluginPanelRequest>> {
        if self.depth != 0 || self.restoring_windows {
            return None;
        }
        Some(std::mem::take(&mut self.deferred_panels))
    }

    /// Enroll a requested reveal in restoration, without constructing or parenting a window.
    pub(crate) fn defer_show(&mut self, label: String) {
        self.visibility.insert(label.clone(), true);
        if self.restore.insert(label.clone()) && !self.restore_order.contains(&label) {
            self.restore_order.push(label);
        }
    }

    /// A native close can hide a reusable panel rather than destroying it. Neither kind of close
    /// should bring the window back when the prompt ends.
    pub(crate) fn closed(&mut self, label: &str) {
        self.restore.remove(label);
        self.restore_order.retain(|entry| entry != label);
        self.visibility.remove(label);
        self.deferred_panels.remove(label);
    }

    /// Keep restoration active after the last prompt ends, including while the owner is minimized.
    pub(crate) fn release(&mut self, quitting: bool) -> Option<Vec<String>> {
        if quitting {
            self.depth = 0;
            self.restoring = false;
            self.restoring_windows = false;
            self.visibility.clear();
            self.restore.clear();
            self.restore_order.clear();
            self.recovery_positions.clear();
            self.deferred_panels.clear();
            return None;
        }
        if self.depth == 0 {
            return None;
        }
        self.depth -= 1;
        if self.depth == 0 {
            self.restoring = true;
        }
        self.pending_restore()
    }

    /// Used by owner/utility restore events without releasing another prompt acquisition.
    pub(crate) fn pending_restore(&self) -> Option<Vec<String>> {
        (self.depth == 0 && self.restoring && !self.restoring_windows).then(|| {
            self.restore_order
                .iter()
                .filter(|label| self.restore.contains(*label))
                .cloned()
                .collect()
        })
    }

    pub(crate) fn start_restore(&mut self) {
        self.restoring_windows = true;
    }

    /// Retries must use the original order, not just the still-pending subset. Prefer the nearest
    /// restored sibling above us; if none is available, use the nearest below, then the owner.
    /// The caller checks actual visibility too: a restored sibling may since have closed/minimized.
    pub(crate) fn restore_placement(
        &self,
        label: &str,
        available: impl Fn(&str) -> bool,
    ) -> RestorePlacement {
        if let Some(index) = self.restore_order.iter().position(|entry| entry == label) {
            let restored = |entry: &&String| !self.restore.contains(*entry) && available(entry);
            if let Some(above) = self.restore_order[index + 1..].iter().find(restored) {
                return RestorePlacement::Below(above.clone());
            }
            if let Some(below) = self.restore_order[..index].iter().rev().find(restored) {
                return RestorePlacement::Above(below.clone());
            }
        }
        RestorePlacement::AboveDocument
    }

    pub(crate) fn restored(&mut self, label: &str) {
        self.restore.remove(label);
    }

    pub(crate) fn recovery_move(&mut self, label: &str, position: (i32, i32)) {
        self.recovery_positions
            .entry(label.to_string())
            .or_default()
            .insert(position);
    }

    /// Native Moved notifications can arrive after finish_restore. Keep their coordinates until
    /// a different (user) move, including duplicate notifications for the same recovery position.
    pub(crate) fn persist_move(&mut self, label: &str, position: (i32, i32)) -> bool {
        if self.active() {
            return false;
        }
        if self
            .recovery_positions
            .get(label)
            .is_some_and(|positions| positions.contains(&position))
        {
            return false;
        }
        self.recovery_positions.remove(label);
        true
    }

    pub(crate) fn finish_restore(&mut self) {
        self.restoring_windows = false;
        if self.depth == 0 && self.restore.is_empty() {
            self.restoring = false;
            self.visibility.clear();
            self.restore_order.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> Vec<(String, bool, bool)> {
        vec![
            ("toolbar".into(), true, false),
            ("popover".into(), true, false),
            ("hidden".into(), false, false),
            ("minimized".into(), true, true),
        ]
    }

    #[test]
    fn native_order_records_bottom_to_top_instead_of_snapshot_or_window_type_order() {
        let mut state = UtilitySuspension::default();
        state.begin(
            [
                ("toolset-rings".into(), true, false),
                ("plugin-panel-report".into(), true, false),
                ("toolset-art".into(), true, false),
                ("hidden".into(), false, false),
                ("minimized".into(), true, true),
            ],
            Some(vec![
                "hidden".into(),
                "toolset-rings".into(),
                "minimized".into(),
                "plugin-panel-report".into(),
                "toolset-art".into(),
            ]),
        );
        let expected = vec!["toolset-art", "plugin-panel-report", "toolset-rings"];
        assert_eq!(state.release(false).unwrap(), expected);
        // Waiting for the owner to return must not discard or reorder the snapshot.
        state.finish_restore();
        assert_eq!(state.pending_restore().unwrap(), expected);
    }

    /// Model relative native insertion, with another app and its dialog above the document group.
    fn place(state: &mut UtilitySuspension, stack: &mut Vec<String>, label: &str) {
        let placement =
            state.restore_placement(label, |sibling| stack.iter().any(|s| s == sibling));
        let (anchor, below) = match placement {
            RestorePlacement::Below(sibling) => (sibling, true),
            RestorePlacement::Above(sibling) => (sibling, false),
            RestorePlacement::AboveDocument => ("document".into(), false),
        };
        stack.retain(|entry| entry != label);
        let index = stack.iter().position(|entry| entry == &anchor).unwrap();
        stack.insert(index + usize::from(below), label.into());
        state.restored(label);
    }

    fn document_stack() -> Vec<String> {
        vec![
            "foreign-dialog".into(),
            "foreign-app".into(),
            "document".into(),
        ]
    }

    #[test]
    fn minimized_art_retry_stays_below_already_restored_rings_and_foreign_windows() {
        let mut state = UtilitySuspension::default();
        state.begin(
            [("Art".into(), true, false), ("Rings".into(), true, false)],
            Some(vec!["Rings".into(), "Art".into()]),
        );
        state.release(false).unwrap();
        let mut stack = document_stack();
        state.start_restore();
        // Art became minimized during the prompt; Rings is the only successful first-pass show.
        place(&mut state, &mut stack, "Rings");
        state.finish_restore();
        assert_eq!(state.pending_restore().unwrap(), vec!["Art"]);
        assert_eq!(
            state.restore_placement("Art", |_| true),
            RestorePlacement::Below("Rings".into())
        );
        state.start_restore();
        place(&mut state, &mut stack, "Art");
        state.finish_restore();
        assert_eq!(
            stack,
            vec!["foreign-dialog", "foreign-app", "Rings", "Art", "document"]
        );
        assert!(!state.active());
    }

    #[test]
    fn three_windows_in_two_passes_keep_order_for_every_first_pass_subset() {
        // Cover retries above, below and between restored siblings, including two pending windows.
        for first_pass in [
            vec!["Top"],
            vec!["Middle"],
            vec!["Bottom"],
            vec!["Top", "Middle"],
            vec!["Top", "Bottom"],
            vec!["Middle", "Bottom"],
        ] {
            let mut state = UtilitySuspension::default();
            state.begin(
                ["Top", "Middle", "Bottom"].map(|label| (label.into(), true, false)),
                Some(vec!["Top".into(), "Middle".into(), "Bottom".into()]),
            );
            state.release(false).unwrap();
            let mut stack = document_stack();
            state.start_restore();
            for label in first_pass {
                place(&mut state, &mut stack, label);
            }
            state.finish_restore();
            let retry = state.pending_restore().unwrap();
            state.start_restore();
            for label in retry.into_iter().rev() {
                place(&mut state, &mut stack, &label);
            }
            state.finish_restore();
            assert_eq!(
                stack,
                vec![
                    "foreign-dialog",
                    "foreign-app",
                    "Top",
                    "Middle",
                    "Bottom",
                    "document"
                ]
            );
            assert!(!state.active());
        }
    }

    #[test]
    fn retry_uses_nearest_available_restored_sibling_or_document() {
        let mut state = UtilitySuspension::default();
        state.begin(
            ["Top", "Middle", "Bottom"].map(|label| (label.into(), true, false)),
            Some(vec!["Top".into(), "Middle".into(), "Bottom".into()]),
        );
        state.release(false).unwrap();
        state.restored("Top");
        state.restored("Bottom");
        state.finish_restore();
        assert_eq!(
            state.restore_placement("Middle", |_| true),
            RestorePlacement::Below("Top".into())
        );
        assert_eq!(
            state.restore_placement("Middle", |label| label != "Top"),
            RestorePlacement::Above("Bottom".into())
        );
        state.closed("Top");
        state.closed("Bottom");
        assert_eq!(
            state.restore_placement("Middle", |_| true),
            RestorePlacement::AboveDocument
        );
    }

    #[test]
    fn repeated_reveal_of_restored_window_keeps_its_original_position() {
        let mut state = UtilitySuspension::default();
        state.begin(
            [("Art".into(), true, false), ("Rings".into(), true, false)],
            Some(vec!["Rings".into(), "Art".into()]),
        );
        state.release(false).unwrap();
        state.restored("Art");
        state.finish_restore();
        state.defer_show("Art".into());
        assert_eq!(state.pending_restore().unwrap(), vec!["Art", "Rings"]);
    }

    #[test]
    fn closed_window_is_skipped_without_reordering_surviving_siblings() {
        let mut state = UtilitySuspension::default();
        state.begin(snapshot(), Some(vec!["toolbar".into(), "popover".into()]));
        state.closed("popover");
        assert_eq!(state.release(false).unwrap(), vec!["toolbar"]);
        state.restored("toolbar");
        state.finish_restore();
        assert!(!state.active());
    }

    #[test]
    fn nested_acquisition_keeps_first_order_and_deferred_reveals_come_last_once() {
        let mut state = UtilitySuspension::default();
        state.begin(snapshot(), Some(vec!["toolbar".into(), "popover".into()]));
        assert!(!state.begin(snapshot(), Some(vec!["popover".into(), "toolbar".into()]),));
        state.defer_show("late-panel".into());
        state.defer_show("late-panel".into());
        assert!(state.release(false).is_none());
        assert_eq!(
            state.release(false).unwrap(),
            vec!["popover", "toolbar", "late-panel"]
        );
    }

    #[test]
    fn unavailable_order_uses_supplied_fallback_and_a_new_snapshot_replaces_old_order() {
        let mut state = UtilitySuspension::default();
        state.begin(snapshot(), None);
        let labels = state.release(false).unwrap();
        assert_eq!(labels, vec!["toolbar", "popover"]);
        for label in labels {
            state.restored(&label);
        }
        state.finish_restore();
        state.begin(snapshot(), Some(vec!["toolbar".into(), "popover".into()]));
        assert_eq!(state.release(false).unwrap(), vec!["popover", "toolbar"]);
    }

    #[test]
    fn restores_only_the_original_visible_non_minimized_set() {
        let mut state = UtilitySuspension::default();
        assert!(state.begin(snapshot(), None));
        assert!(state.visible("toolbar", false));
        assert!(state.visible("minimized", false));
        assert!(!state.visible("hidden", false));
        let labels: HashSet<_> = state.release(false).unwrap().into_iter().collect();
        assert_eq!(labels, HashSet::from(["toolbar".into(), "popover".into()]));
        for label in labels {
            state.restored(&label);
        }
        state.finish_restore();
        assert!(!state.visible("toolbar", false));
    }

    #[test]
    fn overlapping_dialogs_share_the_first_snapshot_and_restore_only_after_the_last() {
        let mut state = UtilitySuspension::default();
        state.begin(snapshot(), None);
        assert!(!state.begin([("late tooltip".into(), true, false)], None));
        assert!(state.release(false).is_none());
        assert!(state.active());
        let labels = state.release(false).unwrap();
        assert_eq!(labels.len(), 2);
        for label in labels {
            state.restored(&label);
        }
        state.finish_restore();
        assert!(state.release(false).is_none());
    }

    #[test]
    fn quitting_refuses_restoration_and_discards_the_snapshot() {
        let mut state = UtilitySuspension::default();
        state.begin(snapshot(), None);
        assert!(state.release(true).is_none());
        assert!(!state.active());
        assert!(state.release(false).is_none());
    }

    #[test]
    fn state_save_and_pending_shows_remain_suppressed_through_monitor_recovery() {
        let mut state = UtilitySuspension::default();
        assert!(!state.active());
        state.begin(snapshot(), None);
        assert!(state.active());
        let labels = state.release(false).unwrap();
        assert!(state.active());
        for label in labels {
            state.restored(&label);
        }
        state.finish_restore();
        assert!(!state.active());
    }

    #[test]
    fn panel_requested_during_a_prompt_is_restored_even_without_an_original_window() {
        let mut state = UtilitySuspension::default();
        state.begin(snapshot(), None);
        state.defer_show("plugin-panel-new".into());
        assert!(state.visible("plugin-panel-new", false));
        let labels = state.release(false).unwrap();
        assert!(labels.contains(&"plugin-panel-new".into()));
        state.start_restore();
        // A show can cause a synchronous Resized callback. It must not reenter restoration.
        assert!(state.pending_restore().is_none());
        for label in labels {
            state.restored(&label);
        }
        state.finish_restore();
        assert!(!state.active());
    }

    #[test]
    fn minimized_owner_keeps_obligations_until_unminimize_and_a_new_prompt_keeps_the_snapshot() {
        let mut state = UtilitySuspension::default();
        state.begin(snapshot(), None);
        let labels = state.release(false).unwrap();
        // No shows while the owner is minimized. Even finish_restore cannot discard that work.
        state.finish_restore();
        assert!(state.active());
        assert!(state.visible("toolbar", false));
        assert_eq!(state.pending_restore().unwrap().len(), labels.len());
        state.defer_show("plugin-panel-late".into());
        assert!(!state.begin([("toolbar".into(), false, false)], None));
        assert!(state.pending_restore().is_none());
        let labels = state.release(false).unwrap();
        assert_eq!(labels.len(), 3);
        // On unminimize the same obligations are available, without another prompt release.
        assert_eq!(state.pending_restore().unwrap().len(), 3);
        for label in labels {
            state.restored(&label);
        }
        state.finish_restore();
        assert!(!state.active());
    }

    #[test]
    fn buffered_windows_recovery_moves_after_finish_do_not_write_toolbar_state() {
        let mut state = UtilitySuspension::default();
        state.begin([("toolbar".into(), true, false)], None);
        state.release(false).unwrap();
        state.start_restore();
        state.recovery_move("toolbar", (1800, 200));
        state.recovery_move("toolbar", (48, 96));
        state.restored("toolbar");
        state.finish_restore();
        assert!(!state.active());

        // Exercise the same event-buffering gate used before persist_toolset_position. Windows
        // can deliver duplicate WM_MOVE notifications after the restoration transaction returns.
        let dir = std::env::temp_dir().join(format!("chemdraft-recovery-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("toolbar-state.json");
        let saved = r#"{"toolsets":{"toolbar":{"x":1800,"y":200,"visible":true}}}"#;
        std::fs::write(&path, saved).unwrap();
        for position in [(1800, 200), (48, 96), (48, 96)] {
            if state.persist_move("toolbar", position) {
                std::fs::write(&path, "recovery must never be saved").unwrap();
            }
        }
        assert_eq!(std::fs::read_to_string(&path).unwrap(), saved);
        assert!(
            state.persist_move("toolbar", (150, 200)),
            "a user drag is still saved"
        );
        assert!(
            state.persist_move("toolbar", (48, 96)),
            "a later user drag back is saved"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn quitting_discards_deferred_panels_and_waiting_restoration() {
        let mut state = UtilitySuspension::default();
        state.begin(snapshot(), None);
        state.release(false).unwrap();
        state.defer_show("plugin-panel-late".into());
        state.release(true);
        assert!(!state.active());
        assert!(state.pending_restore().is_none());
    }
}
