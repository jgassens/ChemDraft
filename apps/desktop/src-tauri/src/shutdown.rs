//! Shared policy for quit-time file opens and the final session write.
#[cfg(any(windows, target_os = "macos", test))]
use std::{sync::mpsc, time::Duration};

#[cfg(any(windows, target_os = "macos", test))]
pub(super) const FLUSH_BUDGET: Duration = Duration::from_secs(2);
#[cfg(any(windows, target_os = "macos", test))]
pub(super) const HARD_LIMIT: Duration = Duration::from_secs(3);

#[cfg(any(windows, target_os = "macos", test))]
pub(super) fn watch_flush(
    watchdog: mpsc::Receiver<()>,
    remaining: Duration,
    on_stall: impl FnOnce(),
) {
    if watchdog.recv_timeout(remaining) == Err(mpsc::RecvTimeoutError::Timeout) {
        on_stall();
    }
}

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

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum OpenFailureAction {
    Alert,
    CancelQuit,
    OnExitReply,
    RecordOnExit,
}

pub(crate) fn open_failure_action(
    kind: QuitKind,
    quit_requested: bool,
    exit_reply_pending: bool,
) -> OpenFailureAction {
    if kind != QuitKind::User {
        OpenFailureAction::RecordOnExit
    } else if exit_reply_pending {
        OpenFailureAction::OnExitReply
    } else if quit_requested {
        OpenFailureAction::CancelQuit
    } else {
        OpenFailureAction::Alert
    }
}

/// Invoke the platform's veto before enqueuing its alert. An OS or final exit
/// records paths for the next launch and proceeds even if storage fails.
pub(crate) fn finish_opens(
    kind: QuitKind,
    open_failure: Option<String>,
    persist: impl FnOnce(bool) -> Result<(), String>,
    cancel: impl FnOnce(),
    schedule_alert: impl FnOnce(String),
) -> bool {
    let result = match (kind, open_failure) {
        // Leave the paths in their queues so still-in-flight opens can confirm after the veto.
        (QuitKind::User, Some(message)) => Err(message),
        _ => persist(kind != QuitKind::User)
            .map_err(|error| format!("Could not record document opens for relaunch: {error}")),
    };
    match result {
        Ok(()) => true,
        Err(message) => {
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
    fn open_failure_waits_for_a_pending_user_veto_and_system_exit_records() {
        for platform in [QuitPlatform::Macos, QuitPlatform::Windows] {
            let user = quit_kind(platform, 0, false, false);
            assert_eq!(
                open_failure_action(user, false, false),
                OpenFailureAction::Alert
            );
            assert_eq!(
                open_failure_action(user, true, false),
                OpenFailureAction::CancelQuit
            );
            assert_eq!(
                open_failure_action(user, false, true),
                OpenFailureAction::OnExitReply
            );
            let calls = RefCell::new(Vec::new());
            assert!(!finish_opens(
                user,
                Some("renderer failed".into()),
                |_| panic!("leave the unopened paths queued after a veto"),
                || calls.borrow_mut().push("veto"),
                |message| {
                    assert_eq!(message, "renderer failed");
                    calls.borrow_mut().push("schedule alert");
                },
            ));
            assert_eq!(*calls.borrow(), ["veto", "schedule alert"]);

            for kind in [
                quit_kind(platform, 0, true, false),
                quit_kind(platform, 0, false, true),
            ] {
                assert_eq!(
                    open_failure_action(kind, true, true),
                    OpenFailureAction::RecordOnExit
                );
                assert!(finish_opens(
                    kind,
                    Some("renderer failed".into()),
                    |notice| {
                        assert!(notice);
                        calls.borrow_mut().push("record");
                        Ok(())
                    },
                    || panic!("the exit is committed"),
                    |_| panic!("the alert belongs to the next launch"),
                ));
            }
            assert_eq!(
                *calls.borrow(),
                ["veto", "schedule alert", "record", "record"]
            );
        }
    }

    #[test]
    fn system_flush_watchdog_only_fires_if_the_callback_stalls() {
        let (disarm, watchdog) = mpsc::channel();
        let fired = std::cell::Cell::new(false);
        watch_flush(watchdog, Duration::ZERO, || fired.set(true));
        assert!(fired.get());
        drop(disarm);

        let (disarm, watchdog) = mpsc::channel();
        drop(disarm);
        watch_flush(watchdog, Duration::ZERO, || {
            panic!("the callback completed")
        });
    }

    #[test]
    fn user_quit_persists_before_veto_and_schedules_alert_after_veto() {
        for platform in [QuitPlatform::Macos, QuitPlatform::Windows] {
            let calls = RefCell::new(Vec::new());
            assert!(!finish_opens(
                quit_kind(platform, 0, false, false),
                None,
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
                    None,
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
