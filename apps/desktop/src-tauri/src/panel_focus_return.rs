//! Shared, pure foreground policy for a deliberate lease release or a finished drag.
//! Native app/window ownership must be sampled at execution, never at IPC dispatch.

pub(super) fn should_return(
    requested: bool,
    lease_held: bool,
    app_active: bool,
    source_or_document_focused: bool,
) -> bool {
    skip_reason(requested, lease_held, app_active, source_or_document_focused).is_none()
}

pub(super) fn skip_reason(
    requested: bool,
    lease_held: bool,
    app_active: bool,
    source_or_document_focused: bool,
) -> Option<&'static str> {
    if !requested {
        Some("not-requested")
    } else if lease_held {
        Some("lease-held")
    } else if !app_active {
        Some("app-inactive")
    } else if !source_or_document_focused {
        Some("another-window-focused")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deliberate_release_and_unleased_drag_return_to_the_document() {
        // Escape, Tab out, a completed control and WM_EXITSIZEMOVE share this policy.
        assert!(should_return(true, false, true, true));
    }

    #[test]
    fn focus_loss_cleanup_and_failed_acquisition_never_request_a_return() {
        assert!(!should_return(false, false, true, true));
    }

    #[test]
    fn stale_drag_completion_or_release_cannot_take_a_new_keyboard_lease() {
        assert!(!should_return(true, true, true, true));
    }

    #[test]
    fn background_app_another_palette_and_native_chooser_keep_focus() {
        assert!(!should_return(true, false, false, true));
        assert!(!should_return(true, false, false, false));
        // Another palette/dialog or native chooser is outside the source/document pair,
        // even if it runs in this process and the application is still active.
        assert!(!should_return(true, false, true, false));
    }
}
