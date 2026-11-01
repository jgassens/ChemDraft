//! Native lease bookkeeping. IPC registers a generation before queuing UI-thread acquisition;
//! native activation transitions invalidate it before emitting events or replying to IPC.
//! Browser focus and elapsed time are deliberately not inputs.

#[derive(Default, Debug)]
pub(super) struct Lease {
    pub generation: u64,
    pub epoch: u64,
    held: bool,
    // Only set for an explicitly leased macOS select. App/outside loss is still terminal.
    pub select_interaction: bool,
    select_suspended: bool,
}

impl Lease {
    pub fn is_held(&self) -> bool {
        self.held
    }

    /// A new webview starts its JS counter over. Invalidate queued native work as well:
    /// its generation may equal a request from the new page.
    pub fn reset(&mut self) {
        self.generation = 0;
        self.held = false;
        self.select_interaction = false;
        self.select_suspended = false;
        self.epoch += 1;
    }

    pub fn is_current(&self, generation: u64, epoch: u64) -> bool {
        self.generation == generation && self.epoch == epoch
    }

    pub fn request(&mut self, generation: u64, epoch: u64, editing: bool) -> bool {
        if epoch != self.epoch || generation <= self.generation {
            return false;
        }
        self.generation = generation;
        self.held = editing;
        self.select_suspended = false;
        true
    }

    pub fn acquired(&mut self, generation: u64, epoch: u64, focused: bool) -> bool {
        if !self.is_current(generation, epoch) || !self.held {
            return false;
        }
        self.held = focused || self.select_suspended;
        self.held
    }

    pub fn suspend_select(&mut self) -> bool {
        self.select_suspended = self.held && self.select_interaction;
        self.select_suspended
    }

    pub fn deactivate(&mut self) -> Option<u64> {
        self.select_interaction = false;
        self.select_suspended = false;
        let held = std::mem::replace(&mut self.held, false);
        held.then_some(self.generation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn select_popup_key_loss_preserves_acquisition_but_app_or_outside_loss_is_terminal() {
        let mut lease = Lease::default();
        lease.request(1, 0, true);
        lease.select_interaction = true;
        assert!(lease.suspend_select());
        // AppKit can resign key status before the acquisition reply is sampled.
        assert!(lease.acquired(1, 0, false));
        assert!(lease.is_held());
        assert_eq!(lease.deactivate(), Some(1)); // Explicit app loss/click elsewhere.
        assert!(!lease.acquired(1, 0, true));
        assert!(!lease.suspend_select());
    }

    #[test]
    fn genuine_loss_during_acquisition_cannot_be_undone_by_its_completion() {
        let mut lease = Lease::default();
        assert!(lease.request(1, lease.epoch, true));
        assert_eq!(lease.deactivate(), Some(1));
        assert!(!lease.acquired(1, 0, true));
        assert_eq!(lease.deactivate(), None);
    }

    #[test]
    fn dropped_acquisition_never_holds_a_lease() {
        let mut lease = Lease::default();
        lease.request(1, lease.epoch, true);
        assert!(!lease.acquired(1, 0, false));
        assert_eq!(lease.deactivate(), None);
        assert!(lease.request(2, lease.epoch, true));
        assert!(lease.acquired(2, 0, true));
        assert_eq!(lease.deactivate(), Some(2));
    }

    #[test]
    fn stale_requests_and_completions_cannot_change_a_new_lease() {
        let mut lease = Lease::default();
        lease.request(1, lease.epoch, true);
        lease.request(2, lease.epoch, false);
        lease.request(3, lease.epoch, true);
        assert!(!lease.request(2, lease.epoch, false));
        assert!(!lease.acquired(1, 0, false));
        assert!(lease.acquired(3, 0, true));
        assert_eq!(lease.deactivate(), Some(3));
    }

    #[test]
    fn old_page_request_executing_after_reset_cannot_acquire_or_block_new_page() {
        let mut lease = Lease::default();
        let old_page = lease.epoch;
        assert!(lease.request(40, old_page, true));
        // Generation 41 was dispatched by the old page, but its async command has
        // not executed yet when navigation resets native bookkeeping.
        lease.reset();
        let new_page = lease.epoch;
        assert!(!lease.request(41, old_page, true));
        assert!(!lease.is_current(41, new_page));
        assert!(!lease.acquired(41, old_page, true));
        assert_eq!(lease.deactivate(), None);
        assert!(lease.request(1, new_page, true));
        assert!(lease.acquired(1, new_page, true));
        // An old page's release cannot end the new page's lease either.
        assert!(!lease.request(42, old_page, false));
        assert_eq!(lease.deactivate(), Some(1));
    }

    #[test]
    fn reloaded_webview_can_restart_generations_without_reviving_old_work() {
        let mut lease = Lease::default();
        assert!(lease.request(1, lease.epoch, true));
        let old_epoch = lease.epoch;
        lease.reset();
        assert_eq!(lease.deactivate(), None);
        assert!(!lease.is_current(1, old_epoch));
        assert!(lease.request(1, lease.epoch, true));
        assert!(!lease.is_current(1, old_epoch));
        assert!(!lease.acquired(1, old_epoch, false));
        assert!(lease.acquired(1, lease.epoch, true));
        assert_eq!(lease.deactivate(), Some(1));
    }
}

// Plugin panels use native activation, never the palette input lease.
#[derive(Default, Debug)]
pub(super) struct PanelActivation {
    pub generation: u64,
    pub epoch: u64,
    held: bool,
    active: bool,
}

impl PanelActivation {
    pub fn is_held(&self) -> bool {
        self.held
    }

    /// A new webview starts its JS counter over. Invalidate queued native work as well:
    /// its generation may equal a request from the new page.
    pub fn reset(&mut self) {
        self.generation = 0;
        self.held = false;
        self.active = false;
        self.epoch += 1;
    }

    pub fn is_current(&self, generation: u64, epoch: u64) -> bool {
        self.generation == generation && self.epoch == epoch
    }

    pub fn request(&mut self, generation: u64, epoch: u64, editing: bool) -> bool {
        if epoch != self.epoch || generation <= self.generation || (editing && !self.active) {
            return false;
        }
        self.generation = generation;
        self.held = editing;
        true
    }

    pub fn acquired(&mut self, generation: u64, epoch: u64, focused: bool) -> bool {
        if !self.is_current(generation, epoch) || !self.held || !self.active {
            return false;
        }
        self.held = focused;
        focused
    }

    pub fn deactivate(&mut self) -> Option<u64> {
        self.active = false;
        let held = std::mem::replace(&mut self.held, false);
        held.then_some(self.generation)
    }

    /// Only a native activation can authorize webview focus; queued IPC cannot activate a window.
    pub fn activate(&mut self) {
        self.active = true;
    }
}

#[cfg(test)]
mod panel_activation_tests {
    use super::*;

    #[test]
    fn native_click_activation_keeps_focus_until_genuine_deactivation() {
        let mut lease = PanelActivation::default();
        lease.activate();
        assert!(lease.request(1, lease.epoch, true));
        assert!(lease.acquired(1, lease.epoch, true));
        // Completing a button/menu interaction releases bookkeeping, never activation.
        assert!(lease.request(2, lease.epoch, false));
        assert!(lease.active);
        assert!(lease.request(3, lease.epoch, true));
        assert!(lease.acquired(3, lease.epoch, true));
        assert_eq!(lease.deactivate(), Some(3));
        assert!(!lease.request(4, lease.epoch, true));
    }

    #[test]
    fn show_restore_and_content_updates_cannot_acquire_focus() {
        let mut lease = PanelActivation::default();
        for generation in 1..=3 {
            assert!(!lease.request(generation, lease.epoch, true));
            assert!(!lease.acquired(generation, lease.epoch, true));
        }
        lease.activate();
        assert!(lease.request(4, lease.epoch, true));
        lease.deactivate();
        assert!(!lease.request(5, lease.epoch, true));
        assert!(!lease.acquired(4, lease.epoch, true));
    }

    #[test]
    fn genuine_loss_during_acquisition_cannot_be_undone_by_its_completion() {
        let mut lease = PanelActivation::default();
        lease.activate();
        assert!(lease.request(1, lease.epoch, true));
        assert_eq!(lease.deactivate(), Some(1));
        assert!(!lease.acquired(1, 0, true));
        assert_eq!(lease.deactivate(), None);
    }

    #[test]
    fn dropped_acquisition_never_holds_a_lease() {
        let mut lease = PanelActivation::default();
        lease.activate();
        lease.request(1, lease.epoch, true);
        assert!(!lease.acquired(1, 0, false));
        assert_eq!(lease.deactivate(), None);
        lease.activate();
        assert!(lease.request(2, lease.epoch, true));
        assert!(lease.acquired(2, 0, true));
        assert_eq!(lease.deactivate(), Some(2));
    }

    #[test]
    fn stale_requests_and_completions_cannot_change_a_new_lease() {
        let mut lease = PanelActivation::default();
        lease.activate();
        lease.request(1, lease.epoch, true);
        lease.request(2, lease.epoch, false);
        lease.request(3, lease.epoch, true);
        assert!(!lease.request(2, lease.epoch, false));
        assert!(!lease.acquired(1, 0, false));
        assert!(lease.acquired(3, 0, true));
        assert_eq!(lease.deactivate(), Some(3));
    }

    #[test]
    fn old_page_request_executing_after_reset_cannot_acquire_or_block_new_page() {
        let mut lease = PanelActivation::default();
        lease.activate();
        let old_page = lease.epoch;
        assert!(lease.request(40, old_page, true));
        // Generation 41 was dispatched by the old page, but its async command has
        // not executed yet when navigation resets native bookkeeping.
        lease.reset();
        let new_page = lease.epoch;
        assert!(!lease.request(41, old_page, true));
        assert!(!lease.is_current(41, new_page));
        assert!(!lease.acquired(41, old_page, true));
        assert_eq!(lease.deactivate(), None);
        lease.activate();
        assert!(lease.request(1, new_page, true));
        assert!(lease.acquired(1, new_page, true));
        // An old page's release cannot end the new page's lease either.
        assert!(!lease.request(42, old_page, false));
        assert_eq!(lease.deactivate(), Some(1));
    }

    #[test]
    fn reloaded_webview_can_restart_generations_without_reviving_old_work() {
        let mut lease = PanelActivation::default();
        lease.activate();
        assert!(lease.request(1, lease.epoch, true));
        let old_epoch = lease.epoch;
        lease.reset();
        assert_eq!(lease.deactivate(), None);
        assert!(!lease.is_current(1, old_epoch));
        lease.activate();
        assert!(lease.request(1, lease.epoch, true));
        assert!(!lease.is_current(1, old_epoch));
        assert!(!lease.acquired(1, old_epoch, false));
        assert!(lease.acquired(1, lease.epoch, true));
        assert_eq!(lease.deactivate(), Some(1));
    }
}
