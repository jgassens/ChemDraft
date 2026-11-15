//! Pure Windows activation policy. Only native choosers may activate a command
//! palette on press; text controls acquire their existing explicit input lease.

use std::time::{Duration, Instant};

const COMMAND_PRESS_TIMEOUT: Duration = Duration::from_millis(500);

pub(super) fn is_command_surface(label: &str) -> bool {
    [
        "toolset-core-",
        "toolset-plugin-",
        "toolset-user-",
        "toolset-popover-",
    ]
    .iter()
    .any(|prefix| {
        label
            .strip_prefix(prefix)
            .is_some_and(|suffix| !suffix.is_empty())
    })
}

#[derive(Clone, Copy, Debug)]
pub(super) enum Press {
    Mouse,
    Pointer,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct Policy {
    command_surface: bool,
    command_popover: bool,
    command_press: Option<Instant>,
}

impl Policy {
    pub fn new(label: &str) -> Self {
        Self {
            command_surface: is_command_surface(label),
            command_popover: false,
            command_press: None,
        }
    }

    pub fn set_content(&mut self, kind: &str) {
        self.command_popover = self.command_surface && kind == "flyout";
        self.clear_command_press();
    }

    pub fn clear_command_press(&mut self) {
        self.command_press = None;
    }

    pub fn ends_input_focus(&self, command_hit: bool) -> bool {
        // NOACTIVATE describes activation, not editing intent. In particular a
        // second/third field press may send an activation message while its
        // lease is already held. Only actual commands may revoke that lease.
        self.command_surface && (self.command_popover || command_hit)
    }

    pub fn activate(
        &mut self,
        press: Press,
        command_hit: bool,
        chooser_hit: bool,
        now: Instant,
    ) -> Option<isize> {
        // Both mouse and pointer activations replace the previous press, including
        // a pen/touch tap in a field immediately after a mouse command click.
        self.clear_command_press();
        if !self.command_surface || chooser_hit {
            return None;
        }
        self.command_press = command_hit.then_some(now);
        // MA_NOACTIVATE / PA_NOACTIVATE. Never ANDEAT: deliver the original
        // press/release exactly once and preserve the title/grip drag handlers.
        Some(match press {
            Press::Mouse => 3,
            Press::Pointer => 3,
        })
    }

    pub fn permits_input_focus(&mut self, now: Instant) -> bool {
        if self
            .command_press
            .is_some_and(|start| now.saturating_duration_since(start) >= COMMAND_PRESS_TIMEOUT)
        {
            self.clear_command_press();
        }
        !self.command_popover && self.command_press.is_none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::panel_window::PaletteCommandHitBox;

    #[test]
    fn mouse_and_pointer_are_nonactivating_except_inside_native_choosers() {
        let command = PaletteCommandHitBox {
            x: 10,
            y: 10,
            width: 20,
            height: 20,
            native_chooser: false,
        };
        let chooser = PaletteCommandHitBox {
            x: 40,
            y: 10,
            width: 20,
            height: 20,
            native_chooser: true,
        };
        for label in [
            "toolset-core-main",
            "toolset-plugin-demo",
            "toolset-user-custom",
            "toolset-popover-core-art",
        ] {
            for press in [Press::Mouse, Press::Pointer] {
                for (x, y, expected) in [
                    (10, 10, Some(3)),
                    (0, 0, Some(3)),
                    (-1, -1, Some(3)),
                    (40, 10, None),
                    (59, 29, None),
                    (60, 30, Some(3)),
                ] {
                    let mut policy = Policy::new(label);
                    assert_eq!(
                        policy.activate(
                            press,
                            command.contains(x, y),
                            chooser.contains(x, y),
                            Instant::now()
                        ),
                        expected,
                        "{label} {press:?} ({x}, {y})"
                    );
                }
            }
        }
    }

    #[test]
    fn document_reports_tooltips_and_unknown_windows_keep_default_processing() {
        for label in [
            "main",
            "plugin-panel-demo",
            "analysis-properties",
            "toolset-tooltip-core-main",
            "toolset-",
            "toolset-core-",
        ] {
            let mut policy = Policy::new(label);
            for press in [Press::Mouse, Press::Pointer] {
                for hit in [false, true] {
                    assert_eq!(policy.activate(press, hit, false, Instant::now()), None);
                    assert!(policy.permits_input_focus(Instant::now()));
                }
            }
        }
    }

    #[test]
    fn command_press_expires_at_500_ms_without_another_mouse_message() {
        let mut policy = Policy::new("toolset-core-main");
        let now = Instant::now();
        policy.activate(Press::Mouse, true, false, now);
        assert!(!policy.permits_input_focus(now + Duration::from_millis(499)));
        assert!(policy.permits_input_focus(now + Duration::from_millis(500)));
        assert!(policy.command_press.is_none());
    }

    #[test]
    fn repeated_field_activation_does_not_end_a_held_or_pending_lease() {
        for press in [Press::Mouse, Press::Pointer] {
            let mut policy = Policy::new("toolset-popover-core-text");
            policy.set_content("textColor");
            let start = Instant::now();
            policy.activate(press, true, false, start);
            assert!(policy.ends_input_focus(true));
            for delay in [50, 100, 150, 499, 501] {
                let now = start + Duration::from_millis(delay);
                assert_eq!(policy.activate(press, false, false, now), Some(3));
                assert!(!policy.ends_input_focus(false));
                assert!(policy.permits_input_focus(now));
            }
            policy.set_content("flyout");
            assert!(policy.ends_input_focus(false));
            assert!(!policy.permits_input_focus(start + Duration::from_secs(1)));
        }
    }

    #[test]
    fn pointer_and_keyboard_entry_clear_a_previous_command_press() {
        let mut policy = Policy::new("toolset-core-main");
        let now = Instant::now();
        policy.activate(Press::Mouse, true, false, now);
        assert_eq!(policy.activate(Press::Pointer, false, false, now), Some(3));
        assert!(policy.permits_input_focus(now));
        policy.activate(Press::Mouse, true, false, now);
        policy.clear_command_press(); // Native key path, including Tab.
        assert!(policy.permits_input_focus(now));
    }

    #[test]
    fn reused_colour_popover_cannot_restore_an_edit_lease_into_a_command_flyout() {
        let mut policy = Policy::new("toolset-popover-core-art");
        for kind in ["textColor", "artColor"] {
            policy.set_content(kind);
            assert!(policy.permits_input_focus(Instant::now()));
            policy.set_content("flyout");
            policy.clear_command_press();
            assert!(!policy.permits_input_focus(Instant::now() + Duration::from_secs(1)));
            policy.set_content(kind);
            assert!(policy.permits_input_focus(Instant::now()));
        }
    }
}
