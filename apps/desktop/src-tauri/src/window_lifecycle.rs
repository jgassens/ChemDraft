//! Bookkeeping for the existing quit/update drain and per-document close choices.
//! Only registered document labels enter these operations; native utilities are never participants.
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Condvar, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FlushPurpose {
    Quit,
    PromptedQuit,
    Update,
}

struct Flush {
    id: u64,
    purpose: FlushPurpose,
    pending: HashSet<String>,
    error: Option<String>,
}

#[derive(Default)]
struct State {
    next_flush: u64,
    flush: Option<Flush>,
    prompts: VecDeque<String>,
    next_close: u64,
    closes: HashMap<String, (u64, bool)>,
    last_window_close: bool,
}

#[derive(Default)]
pub(crate) struct DocumentLifecycle {
    state: Mutex<State>,
    changed: Condvar,
}

impl DocumentLifecycle {
    pub(crate) fn set_last_window_close(&self, closing: bool) {
        self.state.lock().unwrap().last_window_close = closing;
    }

    pub(crate) fn last_window_close(&self) -> bool {
        self.state.lock().unwrap().last_window_close
    }

    pub(crate) fn begin_flush(&self, purpose: FlushPurpose, labels: Vec<String>) -> u64 {
        let mut state = self.state.lock().unwrap();
        state.next_flush += 1;
        let id = state.next_flush;
        state.flush = Some(Flush {
            id,
            purpose,
            pending: labels.into_iter().collect(),
            error: None,
        });
        self.changed.notify_all();
        id
    }

    pub(crate) fn acknowledge_flush(
        &self,
        id: u64,
        label: &str,
        error: Option<String>,
    ) -> Option<FlushPurpose> {
        let mut state = self.state.lock().unwrap();
        let flush = state.flush.as_mut().filter(|flush| flush.id == id)?;
        if !flush.pending.remove(label) {
            return None;
        }
        if error.is_some() {
            flush.error = error;
        }
        self.changed.notify_all();
        flush.pending.is_empty().then_some(flush.purpose)
    }

    pub(crate) fn wait_for_update(&self, id: u64, timeout: Duration) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        let mut state = self.state.lock().unwrap();
        loop {
            let flush = state
                .flush
                .as_ref()
                .filter(|flush| flush.id == id)
                .ok_or("The session flush was superseded by another application operation")?;
            if let Some(error) = &flush.error {
                return Err(error.clone());
            }
            if flush.pending.is_empty() {
                return Ok(());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("Saving every document window before updating timed out".into());
            }
            state = self.changed.wait_timeout(state, remaining).unwrap().0;
        }
    }

    pub(crate) fn flush_succeeded(&self, id: u64) -> bool {
        self.state
            .lock()
            .unwrap()
            .flush
            .as_ref()
            .is_some_and(|flush| {
                flush.id == id && flush.pending.is_empty() && flush.error.is_none()
            })
    }

    pub(crate) fn prompted_flush_finished(&self) -> bool {
        let state = self.state.lock().unwrap();
        state.prompts.is_empty()
            && state.flush.as_ref().is_some_and(|flush| {
                flush.purpose == FlushPurpose::PromptedQuit
                    && flush.pending.is_empty()
                    && flush.error.is_none()
            })
    }

    pub(crate) fn begin_prompts(&self, labels: Vec<String>) -> Option<String> {
        let mut state = self.state.lock().unwrap();
        // A quit supersedes any renderer close choice/final save still in flight.
        state.closes.clear();
        state.prompts = labels.into();
        state.prompts.front().cloned()
    }

    /// Unexpected destruction must not leave a Showing prompt with an owner that cannot answer.
    pub(crate) fn forget_window(&self, label: &str) -> bool {
        let mut state = self.state.lock().unwrap();
        state.closes.remove(label);
        let owned_prompt = state.prompts.front().is_some_and(|owner| owner == label);
        if owned_prompt {
            state.prompts.clear();
        } else {
            state.prompts.retain(|owner| owner != label);
        }
        if let Some(flush) = &mut state.flush {
            if flush.pending.remove(label) {
                flush.error = Some(
                    "A document window was destroyed before its session flush completed".into(),
                );
                self.changed.notify_all();
            }
        }
        owned_prompt
    }

    pub(crate) fn is_prompt_owner(&self, label: &str) -> bool {
        self.state
            .lock()
            .unwrap()
            .prompts
            .front()
            .is_some_and(|owner| owner == label)
    }

    pub(crate) fn cancel_prompts(&self) {
        self.state.lock().unwrap().prompts.clear();
    }

    pub(crate) fn complete_prompt(&self, label: &str) -> Option<String> {
        let mut state = self.state.lock().unwrap();
        if state.prompts.front().is_some_and(|owner| owner == label) {
            state.prompts.pop_front();
        }
        state.prompts.front().cloned()
    }

    /// Repeated native close clicks reuse the pending choice. No timeout may discard a window.
    pub(crate) fn begin_close(&self, label: &str) -> Option<u64> {
        let mut state = self.state.lock().unwrap();
        if state.closes.contains_key(label) || !state.prompts.is_empty() {
            return None;
        }
        state.next_close += 1;
        // Disjoint from the existing quit prompt sequence; still an exact JS safe integer.
        let id = (1_u64 << 32) + state.next_close;
        state.closes.insert(label.into(), (id, false));
        Some(id)
    }

    pub(crate) fn is_close(&self, label: &str, id: u64) -> bool {
        self.state
            .lock()
            .unwrap()
            .closes
            .get(label)
            .is_some_and(|request| request.0 == id)
    }

    pub(crate) fn resume_close(&self, label: &str, id: u64) -> bool {
        let mut state = self.state.lock().unwrap();
        let Some(request) = state
            .closes
            .get_mut(label)
            .filter(|request| request.0 == id)
        else {
            return false;
        };
        request.1 = true;
        true
    }

    pub(crate) fn close_confirmed(&self, label: &str, id: u64) -> bool {
        self.state.lock().unwrap().closes.get(label) == Some(&(id, true))
    }

    pub(crate) fn cancel_close(&self, label: &str, id: u64) -> bool {
        let mut state = self.state.lock().unwrap();
        if !state
            .closes
            .get(label)
            .is_some_and(|request| request.0 == id)
        {
            return false;
        }
        state.closes.remove(label);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quit_and_update_wait_for_every_window_and_refuse_foreign_duplicate_and_stale_answers() {
        for purpose in [
            FlushPurpose::Quit,
            FlushPurpose::PromptedQuit,
            FlushPurpose::Update,
        ] {
            let lifecycle = DocumentLifecycle::default();
            let id = lifecycle.begin_flush(purpose, vec!["main".into(), "doc-b".into()]);
            assert_eq!(lifecycle.acknowledge_flush(id, "runtime", None), None);
            assert_eq!(lifecycle.acknowledge_flush(id, "main", None), None);
            assert!(lifecycle.wait_for_update(id, Duration::ZERO).is_err());
            assert_eq!(lifecycle.acknowledge_flush(id, "main", None), None);
            assert_eq!(lifecycle.acknowledge_flush(id - 1, "doc-b", None), None);
            assert_eq!(
                lifecycle.acknowledge_flush(id, "doc-b", None),
                Some(purpose)
            );
            assert!(lifecycle.wait_for_update(id, Duration::ZERO).is_ok());
        }
    }

    #[test]
    fn update_with_zero_documents_completes_and_a_failed_window_stops_installation() {
        let lifecycle = DocumentLifecycle::default();
        let id = lifecycle.begin_flush(FlushPurpose::Update, vec![]);
        assert!(lifecycle.wait_for_update(id, Duration::ZERO).is_ok());
        let id = lifecycle.begin_flush(FlushPurpose::Update, vec!["main".into()]);
        lifecycle.acknowledge_flush(id, "main", Some("disk full".into()));
        assert_eq!(
            lifecycle.wait_for_update(id, Duration::ZERO),
            Err("disk full".into())
        );
    }

    #[test]
    fn save_choices_visit_each_window_in_order() {
        let lifecycle = DocumentLifecycle::default();
        assert_eq!(
            lifecycle.begin_prompts(vec!["a".into(), "b".into()]),
            Some("a".into())
        );
        assert!(!lifecycle.is_prompt_owner("b"));
        assert_eq!(lifecycle.complete_prompt("a"), Some("b".into()));
        assert!(lifecycle.is_prompt_owner("b"));
        assert_eq!(lifecycle.complete_prompt("b"), None);
    }

    #[test]
    fn prompted_quit_requires_both_every_save_choice_and_every_final_snapshot() {
        for snapshot_first in [true, false] {
            let lifecycle = DocumentLifecycle::default();
            lifecycle.begin_prompts(vec!["a".into(), "b".into()]);
            let id =
                lifecycle.begin_flush(FlushPurpose::PromptedQuit, vec!["a".into(), "b".into()]);
            lifecycle.acknowledge_flush(id, "a", None);
            lifecycle.complete_prompt("a");
            assert!(!lifecycle.prompted_flush_finished());
            if snapshot_first {
                lifecycle.acknowledge_flush(id, "b", None);
            }
            assert!(!lifecycle.prompted_flush_finished());
            lifecycle.complete_prompt("b");
            if !snapshot_first {
                assert!(!lifecycle.prompted_flush_finished());
                lifecycle.acknowledge_flush(id, "b", None);
            }
            assert!(lifecycle.prompted_flush_finished());
        }
    }

    #[test]
    fn window_close_requires_its_own_choice_and_can_be_cancelled_after_a_failed_flush() {
        let lifecycle = DocumentLifecycle::default();
        let id = lifecycle.begin_close("main").unwrap();
        assert!(lifecycle.begin_close("main").is_none());
        assert!(!lifecycle.close_confirmed("main", id));
        assert!(!lifecycle.resume_close("runtime", id));
        assert!(lifecycle.resume_close("main", id));
        assert!(lifecycle.close_confirmed("main", id));
        assert!(lifecycle.cancel_close("main", id));
        assert!(!lifecycle.close_confirmed("main", id));
        assert!(lifecycle.begin_close("main").unwrap() > id);
    }

    #[test]
    fn quit_supersedes_an_approved_close_waiting_for_its_final_renderer_snapshot() {
        let lifecycle = DocumentLifecycle::default();
        let close = lifecycle.begin_close("main").unwrap();
        assert!(lifecycle.resume_close("main", close));
        assert_eq!(
            lifecycle.begin_prompts(vec!["main".into()]),
            Some("main".into())
        );
        assert!(!lifecycle.close_confirmed("main", close));
        assert!(!lifecycle.resume_close("main", close));
        assert!(lifecycle.begin_close("main").is_none());
        assert!(lifecycle.is_prompt_owner("main"));
        lifecycle.cancel_prompts();
        assert!(!lifecycle.is_prompt_owner("main"));
        assert!(lifecycle.begin_close("main").is_some());
    }
}
