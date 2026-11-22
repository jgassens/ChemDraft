//! Tauri startup and single-instance integration. A normal launch may reach the single-instance
//! callback before the primary's setup hook, including when Office started that primary.
use tauri::{AppHandle, Context, Wry};

pub(crate) struct Launch {
    #[cfg(windows)]
    skipped_config_windows: bool,
    #[cfg(windows)]
    headless: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// A second launch has queued this Office-only process's promotion to a document window.
    #[cfg(windows)]
    promoting: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl Launch {
    pub(crate) fn configure(context: &mut Context<Wry>) -> Self {
        #[cfg(windows)]
        {
            super::registry::handle_cli(&context.config().identifier);
            let headless = std::env::args_os()
                .skip(1)
                .any(|arg| arg.to_str().is_some_and(super::server::embedding_arg));
            if headless {
                for window in &mut context.config_mut().app.windows {
                    window.create = false;
                }
            }
            Self {
                skipped_config_windows: headless,
                headless: std::sync::Arc::new(headless.into()),
                promoting: Default::default(),
            }
        }
        #[cfg(not(windows))]
        {
            let _ = context;
            Self {}
        }
    }

    /// True when the primary should pump COM messages without initializing a document window.
    pub(crate) fn setup(&self, app: &AppHandle) -> Result<bool, Box<dyn std::error::Error>> {
        #[cfg(windows)]
        {
            super::server::start(app, self.headless.clone())?;
            let headless = self.headless.load(std::sync::atomic::Ordering::Acquire);
            if self.skipped_config_windows && !headless {
                crate::create_main_window(app)?;
            }
            Ok(headless)
        }
        #[cfg(not(windows))]
        {
            let _ = app;
            Ok(false)
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
    pub(crate) fn consume_second_launch(&self, app: &AppHandle, args: &[String]) -> bool {
        #[cfg(windows)]
        {
            use std::sync::atomic::Ordering;
            use tauri::Manager;
            if args
                .iter()
                .skip(1)
                .any(|arg| super::server::embedding_arg(arg))
            {
                return true;
            }
            if !crate::quit_in_progress()
                && app.try_state::<super::server::Server>().is_some()
                && self.headless.swap(false, Ordering::AcqRel)
            {
                // The single-instance plugin calls this inline from WM_COPYDATA, and building the
                // first WebView2 window from a Windows message handler can deadlock. Promote from
                // the event loop instead: `run_on_main_thread` runs inline when called on the main
                // thread, so post it from another one. Until setup completes, this launch's
                // documents wait in `PendingOpenDocument`, and the new window drains them.
                self.promoting.store(true, Ordering::Release);
                let app = app.clone();
                let headless = self.headless.clone();
                let promoting = self.promoting.clone();
                tauri::async_runtime::spawn(async move {
                    let target = app.clone();
                    let (task_headless, task_promoting) = (headless.clone(), promoting.clone());
                    let posted = app.run_on_main_thread(move || {
                        promote_office_only_process(&target, &task_headless);
                        task_promoting.store(false, Ordering::Release);
                    });
                    if let Err(error) = posted {
                        headless.store(true, Ordering::Release);
                        promoting.store(false, Ordering::Release);
                        eprintln!("Could not open the ChemDraft document window: {error}");
                    }
                });
            }
            false
        }
        #[cfg(not(windows))]
        {
            let _ = (app, args);
            false
        }
    }

    pub(crate) fn keep_running(&self, code: Option<i32>) -> bool {
        #[cfg(windows)]
        {
            use std::sync::atomic::Ordering;
            // A queued promotion has no window yet; closing the last Office editor must not exit.
            code.is_none()
                && (self.headless.load(Ordering::Acquire) || self.promoting.load(Ordering::Acquire))
        }
        #[cfg(not(windows))]
        {
            let _ = code;
            false
        }
    }
}

/// Give the Office-only process its document window, on the event loop. A failure leaves it
/// Office-only, as before the second launch.
#[cfg(windows)]
fn promote_office_only_process(app: &AppHandle, headless: &std::sync::atomic::AtomicBool) {
    use std::sync::atomic::Ordering;
    use tauri::Manager;
    let Some(server) = app.try_state::<super::server::Server>() else {
        return;
    };
    if crate::quit_in_progress() {
        return;
    }
    if let Err(error) = crate::create_main_window(app)
        .and_then(|_| crate::setup_primary_app(app).map_err(|e| e.to_string()))
    {
        headless.store(true, Ordering::Release);
        eprintln!("Could not open the ChemDraft document window: {error}");
        return;
    }
    server.resume();
}

pub(crate) fn shutdown(app: &AppHandle) {
    #[cfg(windows)]
    {
        use tauri::Manager;
        if let Some(server) = app.try_state::<super::server::Server>() {
            server.shutdown();
        }
    }
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    /// The single-instance plugin calls `consume_second_launch` inline from WM_COPYDATA, where
    /// building the first WebView2 window can deadlock. The promotion is posted to the event loop
    /// from another thread, because `run_on_main_thread` runs inline on the main thread.
    #[test]
    fn office_only_promotion_never_builds_a_window_inside_the_single_instance_callback() {
        let source = include_str!("launch.rs");
        let body = source.split("fn consume_second_launch(").nth(1).unwrap();
        let body = &body[..body.find("\n    }\n").unwrap()];
        assert!(!body.contains("create_main_window"));
        assert!(!body.contains("setup_primary_app"));
        assert!(body.contains("tauri::async_runtime::spawn"));
        assert!(body.contains("run_on_main_thread"));
    }
}
