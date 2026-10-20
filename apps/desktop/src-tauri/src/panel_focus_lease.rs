//! Native lease bookkeeping. IPC registers a generation before queuing UI-thread acquisition;
//! native activation transitions invalidate it before emitting events or replying to IPC.
//! Browser focus and elapsed time are deliberately not inputs.

#[derive(Default, Debug)]
pub(super) struct Lease {
    pub generation: u64,
    pub epoch: u64,
    held: bool,
}

impl Lease {
    /// A new webview starts its JS counter over. Invalidate queued native work as well:
    /// its generation may equal a request from the new page.
    pub fn reset(&mut self) {
        self.generation = 0;
        self.held = false;
        self.epoch += 1;
    }

    pub fn is_current(&self, generation: u64, epoch: u64) -> bool {
        self.generation == generation && self.epoch == epoch
    }

    pub fn request(&mut self, generation: u64, editing: bool) -> bool {
        if generation <= self.generation {
            return false;
        }
        self.generation = generation;
        self.held = editing;
        true
    }

    pub fn acquired(&mut self, generation: u64, epoch: u64, focused: bool) -> bool {
        if !self.is_current(generation, epoch) || !self.held {
            return false;
        }
        self.held = focused;
        focused
    }

    pub fn deactivate(&mut self) -> Option<u64> {
        let held = std::mem::replace(&mut self.held, false);
        held.then_some(self.generation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn genuine_loss_during_acquisition_cannot_be_undone_by_its_completion() {
        let mut lease = Lease::default();
        assert!(lease.request(1, true));
        assert_eq!(lease.deactivate(), Some(1));
        assert!(!lease.acquired(1, 0, true));
        assert_eq!(lease.deactivate(), None);
    }

    #[test]
    fn dropped_acquisition_never_holds_a_lease() {
        let mut lease = Lease::default();
        lease.request(1, true);
        assert!(!lease.acquired(1, 0, false));
        assert_eq!(lease.deactivate(), None);
        assert!(lease.request(2, true));
        assert!(lease.acquired(2, 0, true));
        assert_eq!(lease.deactivate(), Some(2));
    }

    #[test]
    fn stale_requests_and_completions_cannot_change_a_new_lease() {
        let mut lease = Lease::default();
        lease.request(1, true);
        lease.request(2, false);
        lease.request(3, true);
        assert!(!lease.request(2, false));
        assert!(!lease.acquired(1, 0, false));
        assert!(lease.acquired(3, 0, true));
        assert_eq!(lease.deactivate(), Some(3));
    }

    #[test]
    fn reloaded_webview_can_restart_generations_without_reviving_old_work() {
        let mut lease = Lease::default();
        assert!(lease.request(1, true));
        let old_epoch = lease.epoch;
        lease.reset();
        assert_eq!(lease.deactivate(), None);
        assert!(!lease.is_current(1, old_epoch));
        assert!(lease.request(1, true));
        assert!(!lease.is_current(1, old_epoch));
        assert!(!lease.acquired(1, old_epoch, false));
        assert!(lease.acquired(1, lease.epoch, true));
        assert_eq!(lease.deactivate(), Some(1));
    }
}
