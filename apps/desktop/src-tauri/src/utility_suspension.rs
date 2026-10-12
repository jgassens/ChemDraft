use std::collections::{HashMap, HashSet};

/// Shared by native prompts and, in future, in-app modal dialogs. A suspension is temporary;
/// logical toolbar visibility and persisted frames must remain unchanged throughout restoration.
#[derive(Default)]
pub(crate) struct UtilitySuspension {
    depth: usize,
    visibility: HashMap<String, bool>,
    restore: HashSet<String>,
}

impl UtilitySuspension {
    pub(crate) fn active(&self) -> bool {
        self.depth != 0
    }

    pub(crate) fn visible(&self, label: &str, actual: bool) -> bool {
        self.visibility.get(label).copied().unwrap_or(actual)
    }

    pub(crate) fn begin(
        &mut self,
        windows: impl IntoIterator<Item = (String, bool, bool)>,
    ) -> bool {
        self.depth += 1;
        if self.depth != 1 {
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

    /// Keep the final suspension active until the OS windows have been restored, so move events
    /// and state writes during monitor recovery are still suppressed. Quit discards the snapshot.
    pub(crate) fn release(&mut self, quitting: bool) -> Option<Vec<String>> {
        if self.depth == 0 {
            return None;
        }
        if self.depth > 1 {
            self.depth -= 1;
            return None;
        }
        if quitting {
            self.finish_restore();
            return None;
        }
        Some(self.restore.iter().cloned().collect())
    }

    pub(crate) fn finish_restore(&mut self) {
        self.depth = 0;
        self.visibility.clear();
        self.restore.clear();
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
        assert_eq!(state.release(false).unwrap().len(), 2);
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
        state.release(false).unwrap();
        assert!(state.active());
        state.finish_restore();
        assert!(!state.active());
    }
}
