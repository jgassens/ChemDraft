#[derive(Clone, Copy)]
enum StopReason {
    Crashed,
    MemoryLimit,
    TerminatedByApi,
    Unknown,
}

#[derive(Default)]
struct RecoveryPolicy {
    reload_attempted: bool,
}

struct Recovery {
    reload: bool,
    message: String,
}

impl RecoveryPolicy {
    fn on_termination(&mut self, reason: StopReason) -> Recovery {
        let reload = !std::mem::replace(&mut self.reload_attempted, true);
        let stopped = match reason {
            StopReason::Crashed => "The drawing view stopped because its web process crashed.",
            StopReason::MemoryLimit => {
                "The drawing view stopped because it exceeded its memory limit."
            }
            StopReason::TerminatedByApi => {
                "The drawing view stopped because its web process was told to shut down."
            }
            StopReason::Unknown => {
                "The drawing view stopped because its web process ended unexpectedly."
            }
        };
        let next = if reload {
            "ChemDraft will reload it when you close this message."
        } else {
            "Quit and restart ChemDraft to reopen it."
        };
        let appimage = concat!(
            "./ChemDraft_",
            env!("CARGO_PKG_VERSION"),
            "-beta_amd64.AppImage"
        );
        Recovery {
            reload,
            message: format!(
                "{stopped} {next} Changes since the last autosave may be lost.\n\n\
                 If this keeps happening, quit ChemDraft and try one of these terminal commands \
                 for the installed app.\n\n\
                 Mesa software rendering\n\
                 LIBGL_ALWAYS_SOFTWARE=1 chemdraft\n\n\
                 Disable WebKitGTK accelerated compositing\n\
                 WEBKIT_DISABLE_COMPOSITING_MODE=1 chemdraft\n\n\
                 For an AppImage, run one of these from the folder containing the file. \
                 Use your AppImage's filename if it differs.\n\
                 LIBGL_ALWAYS_SOFTWARE=1 {appimage}\n\
                 WEBKIT_DISABLE_COMPOSITING_MODE=1 {appimage}"
            ),
        }
    }
}

#[cfg(target_os = "linux")]
pub(super) fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("webview-recovery")
        .on_webview_ready(|webview| {
            if crate::is_document_window(webview.label()) {
                install(webview);
            }
        })
        .build()
}

#[cfg(target_os = "linux")]
fn install<R: tauri::Runtime>(webview: tauri::Webview<R>) {
    use std::cell::RefCell;
    use tauri::Manager;
    use tauri_plugin_dialog::MessageDialogKind;
    use webkit2gtk::{BackForwardListExt, WebProcessTerminationReason, WebViewExt};

    let document = webview.clone();
    if let Err(error) = webview.with_webview(move |platform| {
        let view = platform.inner();
        let startup_uri = view.uri();
        let policy = RefCell::new(RecoveryPolicy::default());
        view.connect_web_process_terminated(move |_, reason| {
            eprintln!("ChemDraft: document web process terminated ({reason:?})");
            let reason = match reason {
                WebProcessTerminationReason::Crashed => StopReason::Crashed,
                WebProcessTerminationReason::ExceededMemoryLimit => StopReason::MemoryLimit,
                WebProcessTerminationReason::TerminatedByApi => StopReason::TerminatedByApi,
                _ => StopReason::Unknown,
            };
            let Recovery { reload, message } = policy.borrow_mut().on_termination(reason);

            // Autosave and the quit flush both need a live renderer to serialize pending edits.
            // Leave the on-disk snapshot in place for normal session restore after a reload.
            let document = document.clone();
            let startup_uri = startup_uri.as_ref().map(ToString::to_string);
            // Through the GTK-safe prompt, which also keeps the box above the document window.
            let prompt = crate::appimage_dialogs::prompt(
                document.app_handle(),
                Some(&document.window()),
                Some("ChemDraft Drawing View Stopped"),
                &message,
            );
            prompt.kind(MessageDialogKind::Error).show(move |_| {
                if !reload {
                    return;
                }
                if let Err(error) = document.with_webview(move |platform| {
                    let view = platform.inner();
                    // A crash during startup can leave WebKit with no page to reload.
                    if let Some(uri) = startup_uri.filter(|_| {
                        view.back_forward_list()
                            .and_then(|history| history.current_item())
                            .is_none()
                    }) {
                        view.load_uri(&uri);
                    } else {
                        view.reload();
                    }
                }) {
                    eprintln!("ChemDraft: could not reload the drawing view: {error}");
                }
            });
        });
    }) {
        eprintln!("ChemDraft: could not observe the document web process: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::{RecoveryPolicy, StopReason};

    #[test]
    fn allows_one_reload_per_window_even_if_the_reason_changes() {
        let mut first_window = RecoveryPolicy::default();
        let mut second_window = RecoveryPolicy::default();
        assert!(first_window.on_termination(StopReason::Crashed).reload);

        for reason in [
            StopReason::MemoryLimit,
            StopReason::TerminatedByApi,
            StopReason::Crashed,
        ] {
            let recovery = first_window.on_termination(reason);
            assert!(!recovery.reload);
            assert!(recovery.message.contains("Quit and restart ChemDraft"));
            assert!(!recovery.message.contains("will reload"));
        }

        assert!(second_window.on_termination(StopReason::Crashed).reload);
    }

    #[test]
    fn explains_each_reason_and_warns_about_unsaved_work() {
        for (reason, detail) in [
            (StopReason::Crashed, "web process crashed"),
            (StopReason::MemoryLimit, "exceeded its memory limit"),
            (StopReason::TerminatedByApi, "was told to shut down"),
            (StopReason::Unknown, "ended unexpectedly"),
        ] {
            let recovery = RecoveryPolicy::default().on_termination(reason);
            assert!(recovery.message.starts_with("The drawing view stopped"));
            assert!(recovery.message.contains(detail));
            assert!(recovery.message.contains("ChemDraft will reload it"));
            assert!(recovery
                .message
                .contains("Changes since the last autosave may be lost"));
        }
    }

    #[test]
    fn gives_terminal_commands_for_installed_and_appimage_launches() {
        let mut policy = RecoveryPolicy::default();
        for _ in 0..2 {
            let recovery = policy.on_termination(StopReason::Crashed);
            for setting in [
                "LIBGL_ALWAYS_SOFTWARE=1",
                "WEBKIT_DISABLE_COMPOSITING_MODE=1",
            ] {
                let installed = format!("{setting} chemdraft");
                let appimage = format!(
                    "{setting} ./ChemDraft_{}-beta_amd64.AppImage",
                    env!("CARGO_PKG_VERSION")
                );
                assert!(recovery.message.lines().any(|line| line == installed));
                assert!(recovery.message.lines().any(|line| line == appimage));
            }
            assert!(!recovery.message.contains("WEBKIT_DISABLE_DMABUF_RENDERER"));
            assert!(!recovery.message.contains("GDK_BACKEND"));
        }
    }
}
