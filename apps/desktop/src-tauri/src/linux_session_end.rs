#[cfg(any(target_os = "linux", test))]
use std::time::Duration;

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminationSignal {
    Terminate,
    Interrupt,
    Hangup,
}

#[cfg(any(target_os = "linux", test))]
const fn termination_signals() -> [TerminationSignal; 3] {
    [
        TerminationSignal::Terminate,
        TerminationSignal::Interrupt,
        TerminationSignal::Hangup,
    ]
}

#[cfg(any(target_os = "linux", test))]
const fn flush_budget() -> Duration {
    Duration::from_secs(2)
}

#[cfg(any(target_os = "linux", test))]
const fn exit_budget() -> Duration {
    Duration::from_secs(3)
}

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, PartialEq, Eq)]
enum LogoutAction {
    AllowQuery,
    FlushAndExit,
    Ignore,
}

#[cfg(any(target_os = "linux", test))]
fn logout_action(signal: Option<&str>) -> LogoutAction {
    match signal {
        Some("QueryEndSession") => LogoutAction::AllowQuery,
        Some("EndSession") => LogoutAction::FlushAndExit,
        _ => LogoutAction::Ignore,
    }
}

/// GNOME's `EndSessionResponse` arguments. A flush that failed or timed out is not confirmed, so
/// ChemDraft must not answer OK: GNOME then names ChemDraft and its reason to the user.
#[cfg(any(target_os = "linux", test))]
const fn end_session_response(flush_confirmed: bool) -> (bool, &'static str) {
    if flush_confirmed {
        (true, "")
    } else {
        (false, "ChemDraft could not save your open documents")
    }
}

#[cfg(not(target_os = "linux"))]
pub(super) fn in_progress() -> bool {
    false
}

#[cfg(not(target_os = "linux"))]
pub(super) fn blocks_exit() -> bool {
    false
}

#[cfg(target_os = "linux")]
pub(super) use linux::{acknowledge_flush, blocks_exit, in_progress, install};

#[cfg(target_os = "linux")]
mod linux {
    use super::{
        end_session_response, exit_budget, flush_budget, logout_action, termination_signals,
        LogoutAction, TerminationSignal,
    };
    use crate::{request_document_quit_flush, APP_QUITTING, QUIT};
    use futures_lite::StreamExt;
    use std::{
        sync::atomic::{AtomicBool, Ordering},
        thread,
        time::{Duration, Instant},
    };
    use tauri::AppHandle;
    use tokio::{
        signal::unix::{signal, SignalKind},
        sync::{oneshot, Notify, OnceCell},
    };
    use zbus::{
        zvariant::{OwnedFd, OwnedObjectPath},
        Connection, Proxy,
    };

    static ENDING: AtomicBool = AtomicBool::new(false);
    static EXIT_ALLOWED: AtomicBool = AtomicBool::new(false);
    static FLUSH: OnceCell<bool> = OnceCell::const_new();
    static ACKNOWLEDGEMENT: Notify = Notify::const_new();
    const BUS_TIMEOUT: Duration = Duration::from_secs(1);

    pub(crate) fn in_progress() -> bool {
        ENDING.load(Ordering::SeqCst)
    }

    pub(crate) fn blocks_exit() -> bool {
        in_progress() && !EXIT_ALLOWED.load(Ordering::SeqCst)
    }

    pub(crate) fn acknowledge_flush() {
        if in_progress() {
            ACKNOWLEDGEMENT.notify_one();
        }
    }

    pub(crate) fn install(app: &AppHandle) -> std::io::Result<()> {
        // Register before returning from setup. Tokio's OS handlers only wake the runtime.
        let [term, interrupt, hangup] = tauri::async_runtime::block_on(async {
            termination_signals().map(|kind| {
                signal(match kind {
                    TerminationSignal::Terminate => SignalKind::terminate(),
                    TerminationSignal::Interrupt => SignalKind::interrupt(),
                    TerminationSignal::Hangup => SignalKind::hangup(),
                })
            })
        });
        let (mut term, mut interrupt, mut hangup) = (term?, interrupt?, hangup?);
        let signal_app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::select! {
                _ = term.recv() => {},
                _ = interrupt.recv() => {},
                _ = hangup.recv() => {},
            }
            exit(&signal_app, flush(&signal_app).await);
        });

        let shutdown_app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = watch_logind(&shutdown_app).await {
                log::debug!("Linux logind shutdown integration unavailable: {error}");
            }
        });
        let logout_app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = watch_logout(&logout_app).await {
                log::debug!("Linux desktop logout integration unavailable: {error}");
            }
        });
        Ok(())
    }

    async fn flush(app: &AppHandle) -> bool {
        *FLUSH
            .get_or_init(|| async {
                let started = Instant::now();
                ENDING.store(true, Ordering::SeqCst);
                APP_QUITTING.store(true, Ordering::SeqCst);
                // Cover a hung GTK main loop and a stalled normal teardown independently.
                thread::spawn(move || {
                    thread::sleep(exit_budget().saturating_sub(started.elapsed()));
                    // SAFETY: The grace has expired. Skip potentially blocked exit handlers.
                    unsafe { libc::_exit(i32::from(FLUSH.get() != Some(&true))) };
                });

                let (send, receive) = oneshot::channel();
                let request_app = app.clone();
                if let Err(error) = app.run_on_main_thread(move || {
                    let _ = send.send(request_document_quit_flush(&request_app));
                }) {
                    eprintln!("ChemDraft: could not dispatch Linux session-end flush: {error}");
                    return false;
                }

                let deadline = tokio::time::Instant::from_std(started + flush_budget());
                match tokio::time::timeout_at(deadline, async {
                    let Some(id) = receive
                        .await
                        .map_err(|error| error.to_string())?
                        .map_err(|error| error.to_string())?
                    else {
                        return Ok::<_, String>(());
                    };
                    while !QUIT.flush_confirmed(id) {
                        ACKNOWLEDGEMENT.notified().await;
                    }
                    Ok(())
                })
                .await
                {
                    Ok(Ok(())) => true,
                    Ok(Err(error)) => {
                        eprintln!("ChemDraft: could not request Linux session-end flush: {error}");
                        false
                    }
                    Err(_) => {
                        eprintln!(
                            "ChemDraft: Linux session-end flush was not confirmed before shutdown"
                        );
                        false
                    }
                }
            })
            .await
    }

    fn exit(app: &AppHandle, flushed_or_no_document: bool) {
        if !EXIT_ALLOWED.swap(true, Ordering::SeqCst) {
            app.exit(i32::from(!flushed_or_no_document));
        }
    }

    async fn watch_logind(app: &AppHandle) -> zbus::Result<()> {
        let register = async {
            let connection = Connection::system().await?;
            let manager = Proxy::new(
                &connection,
                "org.freedesktop.login1",
                "/org/freedesktop/login1",
                "org.freedesktop.login1.Manager",
            )
            .await?;
            let signals = manager.receive_signal("PrepareForShutdown").await?;
            let inhibitor = manager
                .call::<_, _, OwnedFd>(
                    "Inhibit",
                    &("shutdown", "ChemDraft", "Save the drawing session", "delay"),
                )
                .await;
            if let Err(error) = &inhibitor {
                log::debug!("Linux logind delay inhibitor unavailable: {error}");
            }
            let preparing = manager
                .get_property::<bool>("PreparingForShutdown")
                .await
                .unwrap_or(false);
            Ok::<_, zbus::Error>((connection, signals, inhibitor.ok(), preparing))
        };
        let Ok(registration) = tokio::time::timeout(BUS_TIMEOUT, register).await else {
            return Ok(());
        };
        let (_connection, mut signals, inhibitor, mut preparing) = registration?;
        while !preparing {
            let Some(message) = signals.next().await else {
                return Ok(());
            };
            preparing = message.body().deserialize::<bool>()?;
        }
        let flushed = flush(app).await;
        drop(inhibitor);
        exit(app, flushed);
        Ok(())
    }

    async fn watch_logout(app: &AppHandle) -> zbus::Result<()> {
        const MANAGER: &str = "org.gnome.SessionManager";
        let register = async {
            let connection = Connection::session().await?;
            let manager =
                Proxy::new(&connection, MANAGER, "/org/gnome/SessionManager", MANAGER).await?;
            let startup_id = std::env::var("DESKTOP_AUTOSTART_ID").unwrap_or_default();
            let client_path: OwnedObjectPath = manager
                .call(
                    "RegisterClient",
                    &(app.config().identifier.as_str(), startup_id),
                )
                .await?;
            let client = Proxy::new_owned(
                connection,
                MANAGER,
                client_path,
                "org.gnome.SessionManager.ClientPrivate",
            )
            .await?;
            let signals = client.receive_all_signals().await?;
            Ok::<_, zbus::Error>((client, signals))
        };
        let Ok(registration) = tokio::time::timeout(BUS_TIMEOUT, register).await else {
            return Ok(());
        };
        let (client, mut signals) = registration?;
        while let Some(message) = signals.next().await {
            let action = logout_action(message.header().member().map(|name| name.as_str()));
            match action {
                LogoutAction::AllowQuery => {
                    // The user can still cancel. Only EndSession commits the document to quit.
                    let _ = tokio::time::timeout(
                        BUS_TIMEOUT,
                        client.call::<_, _, ()>("EndSessionResponse", &(true, "")),
                    )
                    .await;
                }
                LogoutAction::FlushAndExit => {
                    // flush() is bounded by flush_budget(); a timeout returns false.
                    let flushed = flush(app).await;
                    // Never answer OK for an unconfirmed write. The hard exit deadline set by
                    // flush() still ends this process, so the refusal cannot hold logout open.
                    let response = end_session_response(flushed);
                    let _ = tokio::time::timeout(
                        exit_budget().saturating_sub(flush_budget()),
                        client.call::<_, _, ()>("EndSessionResponse", &response),
                    )
                    .await;
                    exit(app, flushed);
                    return Ok(());
                }
                LogoutAction::Ignore => {}
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_shutdown_covers_terminate_interrupt_and_hangup() {
        assert_eq!(
            termination_signals(),
            [
                TerminationSignal::Terminate,
                TerminationSignal::Interrupt,
                TerminationSignal::Hangup,
            ]
        );
    }

    #[test]
    fn system_shutdown_has_a_short_flush_budget_and_a_hard_ceiling() {
        assert_eq!(flush_budget(), Duration::from_secs(2));
        assert_eq!(exit_budget(), Duration::from_secs(3));
        assert!(flush_budget() < exit_budget());
    }

    #[test]
    fn logout_flush_starts_only_after_the_session_is_committed() {
        assert_eq!(
            logout_action(Some("QueryEndSession")),
            LogoutAction::AllowQuery
        );
        assert_eq!(
            logout_action(Some("EndSession")),
            LogoutAction::FlushAndExit
        );
        assert_eq!(
            logout_action(Some("CancelEndSession")),
            LogoutAction::Ignore
        );
        assert_eq!(logout_action(None), LogoutAction::Ignore);
    }

    #[test]
    fn logout_reports_ok_only_for_a_confirmed_flush() {
        assert_eq!(end_session_response(true), (true, ""));
        let (is_ok, reason) = end_session_response(false);
        assert!(!is_ok);
        assert_eq!(reason, "ChemDraft could not save your open documents");
    }
}
