//! Shared policy for quit-time file opens and the final session write.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum QuitPlatform {
    Macos,
    Windows,
    Other,
}

impl QuitPlatform {
    pub(crate) fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Macos
        } else if cfg!(windows) {
            Self::Windows
        } else {
            Self::Other
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum QuitKind {
    User,
    System,
    Irreversible,
}

pub(crate) fn quit_kind(
    platform: QuitPlatform,
    apple_event_reason: u32,
    os_session_ending: bool,
    irreversible: bool,
) -> QuitKind {
    if irreversible {
        return QuitKind::Irreversible;
    }
    let system = match platform {
        QuitPlatform::Macos => {
            os_session_ending
                || (apple_event_reason != 0 && apple_event_reason != u32::from_be_bytes(*b"quit"))
        }
        QuitPlatform::Windows => os_session_ending,
        QuitPlatform::Other => false,
    };
    if system {
        QuitKind::System
    } else {
        QuitKind::User
    }
}

/// Invoke the platform's veto before enqueuing its alert. An OS or final exit
/// records paths for the next launch and proceeds even if storage fails.
pub(crate) fn finish_opens(
    kind: QuitKind,
    persist: impl FnOnce(bool) -> Result<(), String>,
    cancel: impl FnOnce(),
    schedule_alert: impl FnOnce(String),
) -> bool {
    match persist(kind != QuitKind::User) {
        Ok(()) => true,
        Err(error) => {
            let message = format!("Could not record document opens for relaunch: {error}");
            eprintln!("{message}");
            if kind == QuitKind::User {
                cancel();
                schedule_alert(message);
                false
            } else {
                true
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FlushWrite {
    AwaitingSnapshot,
    Writing,
    Publishing,
    Finished,
    Failed,
}

impl FlushWrite {
    pub(crate) fn grace_can_end_quit(self) -> bool {
        matches!(self, Self::Finished | Self::Failed)
    }

    #[cfg(any(target_os = "macos", test))]
    pub(crate) fn can_cancel_for_open(self) -> bool {
        matches!(self, Self::AwaitingSnapshot | Self::Writing | Self::Failed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn user_quit_persists_before_veto_and_schedules_alert_after_veto() {
        for platform in [QuitPlatform::Macos, QuitPlatform::Windows] {
            let calls = RefCell::new(Vec::new());
            assert!(!finish_opens(
                quit_kind(platform, 0, false, false),
                |notice| {
                    assert!(!notice);
                    calls.borrow_mut().push("persist");
                    Err("disk full".into())
                },
                || calls.borrow_mut().push("cancel"),
                |message| {
                    assert!(message.contains("disk full"));
                    calls.borrow_mut().push("schedule alert");
                },
            ));
            assert_eq!(*calls.borrow(), ["persist", "cancel", "schedule alert"]);
        }
    }

    #[test]
    fn system_and_irreversible_exits_record_before_proceeding_and_never_show_alerts() {
        for (platform, reason, ending, irreversible) in [
            (
                QuitPlatform::Macos,
                u32::from_be_bytes(*b"shut"),
                false,
                false,
            ),
            (QuitPlatform::Macos, 0, true, false),
            (QuitPlatform::Windows, 0, true, false),
            (QuitPlatform::Macos, 0, false, true),
            (QuitPlatform::Windows, 0, false, true),
        ] {
            let kind = quit_kind(platform, reason, ending, irreversible);
            assert_eq!(
                kind,
                if irreversible {
                    QuitKind::Irreversible
                } else {
                    QuitKind::System
                }
            );
            for result in [Ok(()), Err("disk full".into())] {
                assert!(finish_opens(
                    kind,
                    |notice| {
                        assert!(notice);
                        result
                    },
                    || panic!("must proceed"),
                    |_| panic!("alert belongs to the next launch"),
                ));
            }
        }
    }
}
