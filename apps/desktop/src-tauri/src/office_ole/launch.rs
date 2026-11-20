//! Tauri startup and single-instance integration. A normal launch may reach the single-instance
//! callback before the primary's setup hook, including when Office started that primary.
use tauri::{AppHandle, Context, Wry};

pub(crate) struct Launch {
    #[cfg(windows)]
    skipped_config_windows: bool,
    #[cfg(windows)]
    headless: std::sync::Arc<std::sync::atomic::AtomicBool>,
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
            if !crate::quit_in_progress() && self.headless.swap(false, Ordering::AcqRel) {
                if let Some(server) = app.try_state::<super::server::Server>() {
                    if let Err(error) = crate::create_main_window(app)
                        .and_then(|_| crate::setup_primary_app(app).map_err(|e| e.to_string()))
                    {
                        self.headless.store(true, Ordering::Release);
                        eprintln!("Could not open the ChemDraft document window: {error}");
                        return true;
                    }
                    server.resume();
                }
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
            code.is_none() && self.headless.load(std::sync::atomic::Ordering::Acquire)
        }
        #[cfg(not(windows))]
        {
            let _ = code;
            false
        }
    }
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
