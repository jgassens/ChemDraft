use std::collections::{HashMap, HashSet};

/// Shared by native prompts and, in future, in-app modal dialogs. A suspension is temporary;
/// logical toolbar visibility and persisted frames must remain unchanged throughout restoration.
#[derive(Default)]
pub(crate) struct UtilitySuspension {
    depth: usize,
    restoring: bool,
    restoring_windows: bool,
    visibility: HashMap<String, bool>,
    restore: HashSet<String>,
    recovery_positions: HashMap<String, HashSet<(i32, i32)>>,
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
    ) -> bool {
        let already_active = self.active();
        self.depth += 1;
        if already_active {
            return false;
        }
        for (label, visible, minimized) in windows {
            self.visibility.insert(label.clone(), visible);
            if visible && !minimized {
                self.restore.insert(label);
            }
        }
        true
    }

    /// A requested panel is built hidden while suspended, then shown with the original windows.
    pub(crate) fn defer_show(&mut self, label: String) {
        self.visibility.insert(label.clone(), true);
        self.restore.insert(label);
    }

    /// Keep restoration active after the last prompt ends, including while the owner is minimized.
    pub(crate) fn release(&mut self, quitting: bool) -> Option<Vec<String>> {
        if quitting {
            self.depth = 0;
            self.restoring = false;
            self.restoring_windows = false;
            self.visibility.clear();
            self.restore.clear();
            self.recovery_positions.clear();
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
        (self.depth == 0 && self.restoring && !self.restoring_windows)
            .then(|| self.restore.iter().cloned().collect())
    }

    pub(crate) fn start_restore(&mut self) {
        self.restoring_windows = true;
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
    fn restores_only_the_original_visible_non_minimized_set() {
        let mut state = UtilitySuspension::default();
        assert!(state.begin(snapshot()));
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
        state.begin(snapshot());
        assert!(!state.begin([("late tooltip".into(), true, false)]));
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
        state.begin(snapshot());
        assert!(state.release(true).is_none());
        assert!(!state.active());
        assert!(state.release(false).is_none());
    }

    #[test]
    fn state_save_and_pending_shows_remain_suppressed_through_monitor_recovery() {
        let mut state = UtilitySuspension::default();
        assert!(!state.active());
        state.begin(snapshot());
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
        state.begin(snapshot());
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
        state.begin(snapshot());
        let labels = state.release(false).unwrap();
        // No shows while the owner is minimized. Even finish_restore cannot discard that work.
        state.finish_restore();
        assert!(state.active());
        assert!(state.visible("toolbar", false));
        assert_eq!(state.pending_restore().unwrap().len(), labels.len());
        state.defer_show("plugin-panel-late".into());
        assert!(!state.begin([("toolbar".into(), false, false)]));
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
        state.begin([("toolbar".into(), true, false)]);
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
        state.begin(snapshot());
        state.release(false).unwrap();
        state.defer_show("plugin-panel-late".into());
        state.release(true);
        assert!(!state.active());
        assert!(state.pending_restore().is_none());
    }
}
