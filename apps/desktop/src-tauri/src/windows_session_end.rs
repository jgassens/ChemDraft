//! Tao 0.35.3 delivers Exit directly from WM_ENDSESSION on its hidden event target.
//! Run the document's committed flush before passing that message down the subclass chain.
//!
//! Embedded Office editors (docs/architecture/office-editing.md): WM_QUERYENDSESSION asks every
//! open editor for its drawing, and the Office STA saves each one into Office as it arrives.
//! While any drawing is neither confirmed saved in Office nor beyond saving, ChemDraft refuses the
//! session end with a reason (ShutdownBlockReasonCreate) and keeps collecting and retrying; once
//! everything is saved it destroys the reason and lets the next request through. A drawing still
//! at risk when Windows ends the session anyway has a recovery copy under the app data folder,
//! named in `office-session-end.log`. The main thread only pumps and polls shared state here: it
//! never waits on the STA, and the STA never waits on it.

#[cfg(any(windows, test))]
use crate::{QuitHost, QuitReason};
#[cfg(any(windows, test))]
use std::{sync::mpsc, time::Duration};

#[cfg(any(windows, test))]
const HARD_LIMIT: Duration = Duration::from_secs(3);

#[cfg(any(windows, test))]
pub(super) fn watch_flush(watchdog: mpsc::Receiver<()>, remaining: Duration, host: &impl QuitHost) {
    if watchdog.recv_timeout(remaining) == Err(mpsc::RecvTimeoutError::Timeout) {
        host.force_exit(HARD_LIMIT, QuitReason::GraceExpired);
    }
}

#[cfg(not(windows))]
pub(super) fn in_progress() -> bool {
    false
}

#[cfg(windows)]
pub(crate) use windows::office_session_changed;
#[cfg(windows)]
pub(super) use windows::{in_progress, install};

#[cfg(windows)]
pub(crate) fn log_office_loss(app: &tauri::AppHandle, message: std::fmt::Arguments<'_>) {
    use std::{fs, io::Write};
    use tauri::Manager;

    eprintln!("ChemDraft: {message}");
    // Release builds are GUI executables and may have no stderr to capture.
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let directory = app.path().app_log_dir()?;
        fs::create_dir_all(&directory)?;
        let mut log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(directory.join("office-session-end.log"))?;
        let entry = format!("{} {message}\n", chrono::Utc::now().to_rfc3339());
        log.write_all(entry.as_bytes())?;
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("ChemDraft: could not write the Office session-end log: {error}");
    }
}

#[cfg(windows)]
mod windows {
    use super::{watch_flush, HARD_LIMIT};
    use crate::{
        office_ole::{
            bridge::owner_id, recovery, server::Server, session_publish::Answer,
            toolset_events::deliver,
        },
        request_document_quit_flush, APP_QUITTING, QUIT,
    };
    use std::{
        cell::{Cell, RefCell},
        path::PathBuf,
        ptr::null_mut,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            mpsc,
        },
        thread,
        time::{Duration, Instant},
    };
    use tauri::Manager;
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        System::Threading::GetCurrentThreadId,
        UI::{
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::{
                DispatchMessageW, EnumThreadWindows, GetClassNameW, GetSystemMetrics, KillTimer,
                PeekMessageW, PostQuitMessage, SetTimer, MSG, PM_QS_POSTMESSAGE, PM_QS_SENDMESSAGE,
                PM_REMOVE, SM_SHUTTINGDOWN, WM_ENDSESSION, WM_NCDESTROY, WM_QUERYENDSESSION,
                WM_QUIT, WM_TIMER,
            },
        },
    };

    // user32 exports these; the crate's windows-sys features do not include Win32_System_Shutdown.
    #[link(name = "user32")]
    extern "system" {
        fn ShutdownBlockReasonCreate(hwnd: HWND, reason: *const u16) -> i32;
        fn ShutdownBlockReasonDestroy(hwnd: HWND) -> i32;
    }

    const FLUSH_BUDGET: Duration = Duration::from_secs(2);
    // Collect and save Office drawings for at most 3 seconds during the query, below the 5 seconds
    // Windows waits before it lists an app as not responding. Anything slower is refused with a
    // reason and finishes in the background.
    const OFFICE_QUERY_BUDGET: Duration = Duration::from_secs(3);
    // While a refused session end is pending, update recovery copies and re-check Windows.
    const SESSION_TIMER: usize = 0x0FF1_CE5E;
    const SESSION_TIMER_MS: u32 = 1000;
    // Windows normally sends WM_ENDSESSION(FALSE) when the user cancels a shutdown. If it reports
    // no shutdown for this many checks without one, resume the editors anyway.
    const QUIET_CHECKS: u8 = 2;
    static ENDING: AtomicBool = AtomicBool::new(false);
    static TARGET: AtomicUsize = AtomicUsize::new(0);

    thread_local! {
        // Main thread only. The reason Windows currently shows for ChemDraft, if any.
        static BLOCK: RefCell<Option<String>> = const { RefCell::new(None) };
        static TIMER: Cell<bool> = const { Cell::new(false) };
        static QUIET: Cell<u8> = const { Cell::new(0) };
    }

    pub(crate) fn in_progress() -> bool {
        ENDING.load(Ordering::SeqCst)
    }

    unsafe extern "system" fn find_tao_event_target(hwnd: HWND, data: LPARAM) -> i32 {
        let mut class_name = [0u16; 64];
        // SAFETY: The buffer holds the number of UTF-16 code units passed to GetClassNameW.
        let len = unsafe { GetClassNameW(hwnd, class_name.as_mut_ptr(), class_name.len() as i32) };
        if class_name[..len as usize]
            .iter()
            .copied()
            .eq("Tao Thread Event Target".encode_utf16())
        {
            // SAFETY: EnumThreadWindows calls back synchronously with install's HWND slot.
            unsafe { *(data as *mut HWND) = hwnd };
            return 0;
        }
        1
    }

    pub(crate) fn install(app: &tauri::AppHandle) -> Result<(), String> {
        let mut hwnd: HWND = null_mut();
        // SAFETY: Primary setup runs on Tao's UI thread, and the slot outlives enumeration.
        unsafe {
            EnumThreadWindows(
                GetCurrentThreadId(),
                Some(find_tao_event_target),
                &mut hwnd as *mut HWND as LPARAM,
            );
        }
        if hwnd.is_null() {
            return Err("Tao's session-end window was not found".into());
        }
        let data = Box::into_raw(Box::new(app.clone()));
        // SAFETY: The target belongs to this thread. The subclass owns data until WM_NCDESTROY.
        if unsafe { SetWindowSubclass(hwnd, Some(observe), 1, data as usize) } == 0 {
            unsafe { drop(Box::from_raw(data)) };
            return Err(std::io::Error::last_os_error().to_string());
        }
        TARGET.store(hwnd as usize, Ordering::Release);
        Ok(())
    }

    unsafe extern "system" fn observe(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        id: usize,
        data: usize,
    ) -> LRESULT {
        match message {
            WM_QUERYENDSESSION => {
                // Clone before pumping messages that can destroy the subclass.
                let app = unsafe { (&*(data as *const tauri::AppHandle)).clone() };
                return LRESULT::from(query(&app, hwnd));
            }
            WM_ENDSESSION if wparam != 0 => {
                if ENDING.swap(true, Ordering::SeqCst) {
                    return 0; // The outer callback will forward the committed message to Tao.
                }
                APP_QUITTING.store(true, Ordering::SeqCst);
                // SAFETY: Clone the installed handle before pumping messages that can destroy it.
                let app = unsafe { (&*(data as *const tauri::AppHandle)).clone() };
                flush(&app, hwnd);
            }
            WM_ENDSESSION if !in_progress() => {
                let app = unsafe { &*(data as *const tauri::AppHandle) };
                cancel(app, hwnd, true);
            }
            WM_TIMER if wparam == SESSION_TIMER => {
                let app = unsafe { (&*(data as *const tauri::AppHandle)).clone() };
                tick(&app, hwnd);
                return 0;
            }
            WM_NCDESTROY => {
                stop_timer(hwnd);
                TARGET.store(0, Ordering::Release);
                // SAFETY: Remove this callback before releasing the handle allocated in install.
                unsafe {
                    RemoveWindowSubclass(hwnd, Some(observe), id);
                    drop(Box::from_raw(data as *mut tauri::AppHandle));
                }
            }
            _ => {}
        }
        // SAFETY: Forward on the same thread and through the live subclass chain.
        unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
    }

    /// WM_QUERYENDSESSION: true lets the session end.
    fn query(app: &tauri::AppHandle, hwnd: HWND) -> bool {
        let deadline = Instant::now() + OFFICE_QUERY_BUDGET;
        let server = app.state::<Server>();
        // A repeated query keeps collecting into the pending session end.
        if let Some((request, editors)) =
            server.begin_session_end(recovery::stamp(chrono::Utc::now()))
        {
            ask_editors(app, &server, request, &editors);
        }
        while Instant::now() < deadline && server.session_end_answer().blocks() {
            if !pump_webviews() {
                break;
            }
        }
        let allowed = settle(app, hwnd);
        if !allowed {
            start_timer(hwnd);
        }
        allowed
    }

    fn ask_editors(app: &tauri::AppHandle, server: &Server, request: u32, editors: &[String]) {
        let windows = app.webview_windows();
        let message = request.to_string();
        for id in editors {
            match windows.get(&format!("office-object-{id}")) {
                Some(window) => deliver(window, "office-session-publish", &message),
                // Its renderer has gone: only the drawing its object holds can still be saved.
                None => {
                    server.session_editor_window_closed(request, id);
                }
            }
        }
    }

    /// Called from the STA and IPC threads after the session-end state changes.
    pub(crate) fn office_session_changed(app: &tauri::AppHandle) {
        let handle = app.clone();
        let posted = app.run_on_main_thread(move || {
            let hwnd = TARGET.load(Ordering::Acquire) as HWND;
            if !hwnd.is_null() && !in_progress() && BLOCK.with_borrow(Option::is_some) {
                settle(&handle, hwnd);
            }
        });
        if let Err(error) = posted {
            eprintln!("ChemDraft: could not report an Office session-end change: {error}");
        }
    }

    fn recovery_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
        match app.path().app_data_dir() {
            Ok(dir) => Some(dir.join(recovery::FOLDER)),
            Err(error) => {
                super::log_office_loss(
                    app,
                    format_args!("No app data folder for Office recovery copies: {error}"),
                );
                None
            }
        }
    }

    /// Bring recovery copies in line with what is still at risk, and log what changed.
    fn update_recovery(app: &tauri::AppHandle, server: &Server) -> Answer {
        let dir = recovery_dir(app);
        let (answer, report) = server.settle_session_end(dir.as_deref());
        for (id, path) in &report.written {
            super::log_office_loss(app, format_args!("Office object {id}: its drawing is not saved in Office yet; wrote its last known drawing to {}. Nothing restores this copy automatically.", path.display()));
        }
        for path in &report.removed {
            super::log_office_loss(
                app,
                format_args!(
                    "Removed the recovery copy {}: Office has the drawing.",
                    path.display()
                ),
            );
        }
        for error in &report.errors {
            super::log_office_loss(app, format_args!("{error}"));
        }
        answer
    }

    /// Update recovery copies and the shutdown block reason. True lets the session end.
    fn settle(app: &tauri::AppHandle, hwnd: HWND) -> bool {
        let server = app.state::<Server>();
        match update_recovery(app, &server) {
            Answer::Allow => {
                if release_block(hwnd) {
                    super::log_office_loss(app, format_args!("Every Office drawing is saved; ChemDraft no longer refuses the Windows session end."));
                }
                true
            }
            Answer::Block(reason) => {
                show_block(app, &server, hwnd, reason);
                false
            }
        }
    }

    fn show_block(app: &tauri::AppHandle, server: &Server, hwnd: HWND, reason: String) {
        if BLOCK.with_borrow(|shown| shown.as_deref() == Some(reason.as_str())) {
            return;
        }
        let wide: Vec<u16> = reason.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: hwnd is Tao's event target, created by this thread, and wide ends in NUL.
        unsafe {
            if BLOCK.with_borrow(Option::is_some) {
                ShutdownBlockReasonDestroy(hwnd);
            }
            if ShutdownBlockReasonCreate(hwnd, wide.as_ptr()) == 0 {
                let error = std::io::Error::last_os_error();
                eprintln!("ChemDraft: could not set the shutdown block reason: {error}");
            }
        }
        super::log_office_loss(
            app,
            format_args!("Refused the Windows session end: {reason}."),
        );
        for risk in server.session_end_risks() {
            let error = risk.error.map(|e| format!(" ({e})")).unwrap_or_default();
            super::log_office_loss(
                app,
                format_args!(
                    "Office object {} in {}: {}{error}.",
                    risk.editor, risk.document, risk.state
                ),
            );
        }
        BLOCK.set(Some(reason));
    }

    /// Returns whether a block reason was shown.
    fn release_block(hwnd: HWND) -> bool {
        let shown = BLOCK.take().is_some();
        if shown {
            // SAFETY: hwnd is Tao's event target, created by this thread.
            unsafe { ShutdownBlockReasonDestroy(hwnd) };
        }
        shown
    }

    fn start_timer(hwnd: HWND) {
        QUIET.set(0);
        if TIMER.replace(true) {
            return;
        }
        // SAFETY: The timer belongs to Tao's event target on this thread; observe handles it.
        if unsafe { SetTimer(hwnd, SESSION_TIMER, SESSION_TIMER_MS, None) } == 0 {
            TIMER.set(false);
            eprintln!(
                "ChemDraft: could not start the session-end timer: {}",
                std::io::Error::last_os_error()
            );
        }
    }

    fn stop_timer(hwnd: HWND) {
        if TIMER.replace(false) {
            // SAFETY: Kills the timer start_timer set on this window.
            unsafe { KillTimer(hwnd, SESSION_TIMER) };
        }
    }

    fn tick(app: &tauri::AppHandle, hwnd: HWND) {
        let server = app.state::<Server>();
        if in_progress() || !server.session_end_pending() {
            stop_timer(hwnd);
            return;
        }
        if BLOCK.with_borrow(Option::is_some) {
            settle(app, hwnd);
        }
        // SAFETY: GetSystemMetrics has no preconditions.
        if unsafe { GetSystemMetrics(SM_SHUTTINGDOWN) } != 0 {
            QUIET.set(0);
            return;
        }
        let quiet = QUIET.get().saturating_add(1);
        QUIET.set(quiet);
        if quiet >= QUIET_CHECKS {
            super::log_office_loss(app, format_args!("Windows no longer reports a session end and sent no cancellation; resuming the Office editors and keeping any recovery copies."));
            cancel(app, hwnd, false);
        }
    }

    /// Windows cancelled the session end. With `confirmed`, recovery copies of drawings still open
    /// in their editors are removed; a drawing Office closed keeps its copy either way.
    fn cancel(app: &tauri::AppHandle, hwnd: HWND, confirmed: bool) {
        stop_timer(hwnd);
        release_block(hwnd);
        let server = app.state::<Server>();
        let dir = if server.session_end_pending() {
            recovery_dir(app)
        } else {
            None
        };
        let Some(cancelled) = server.cancel_session_end(dir.as_deref(), confirmed) else {
            return;
        };
        for error in &cancelled.report.errors {
            super::log_office_loss(app, format_args!("{error}"));
        }
        for path in &cancelled.kept {
            super::log_office_loss(
                app,
                format_args!(
                    "The Windows session end was cancelled; kept the recovery copy {}.",
                    path.display()
                ),
            );
        }
        let request = cancelled.request.to_string();
        for window in app.webview_windows().into_values() {
            if owner_id(window.label()).is_ok() {
                deliver(&window, "office-session-cancel", &request);
            }
        }
    }

    fn flush(app: &tauri::AppHandle, hwnd: HWND) {
        let start = Instant::now();
        stop_timer(hwnd);
        // The nested WebView2 pump can enter a native callback. Keep a hard ceiling even if
        // that callback stalls. Windows has already committed to ending this session.
        let (disarm, watchdog) = mpsc::channel::<()>();
        let watchdog_app = app.clone();
        thread::spawn(move || {
            watch_flush(
                watchdog,
                HARD_LIMIT.saturating_sub(start.elapsed()),
                &watchdog_app,
            );
        });

        // Without an earlier query (or after Windows stopped reporting it), ask the editors now.
        let server = app.state::<Server>();
        if let Some((request, editors)) =
            server.begin_session_end(recovery::stamp(chrono::Utc::now()))
        {
            ask_editors(app, &server, request, &editors);
        }
        // Windows may end the process as soon as this message returns, and the watchdog may end
        // it sooner: write recovery copies before waiting for anything.
        update_recovery(app, &server);

        // Join an existing app quit or ask the document once. Pump WebView2 and its IPC so the
        // worker can persist the renderer's snapshot and acknowledge this specific request; the
        // STA keeps saving Office drawings meanwhile.
        let request_id = match request_document_quit_flush(app) {
            Ok(id) => id,
            Err(error) => {
                eprintln!("ChemDraft: could not request session-end flush: {error}");
                None
            }
        };
        let document_saved = || request_id.is_none_or(|id| QUIT.flush_confirmed(id));
        while start.elapsed() < FLUSH_BUDGET
            && (!document_saved() || server.session_end_answer().blocks())
        {
            if !pump_webviews() {
                break;
            }
        }
        if !document_saved() {
            eprintln!("ChemDraft: session-end flush was not confirmed before shutdown");
        }
        update_recovery(app, &server);
        for risk in server.session_end_risks() {
            let error = risk.error.map(|e| format!(" ({e})")).unwrap_or_default();
            let copy = risk.snapshot.map_or_else(
                || "no recovery copy could be written".to_owned(),
                |path| format!("its last known drawing is in {}", path.display()),
            );
            super::log_office_loss(app, format_args!("Office object {} in {}: {}{error} when Windows ended the session; {copy}. Unsaved edits may be lost; nothing restores this copy automatically.", risk.editor, risk.document, risk.state));
        }
        release_block(hwnd);
        drop(disarm);
    }

    fn pump_webviews() -> bool {
        let mut message = MSG::default();
        // SAFETY: Pump this thread's posted/sent work. Hardware input is unnecessary.
        let available = unsafe {
            PeekMessageW(
                &mut message,
                null_mut(),
                0,
                0,
                PM_REMOVE | PM_QS_POSTMESSAGE | PM_QS_SENDMESSAGE,
            )
        };
        if available == 0 {
            thread::sleep(Duration::from_millis(5));
        } else if message.message == WM_QUIT {
            // SAFETY: Preserve a quit already pending for the outer event loop.
            unsafe { PostQuitMessage(message.wParam as i32) };
            return false;
        } else {
            // SAFETY: PeekMessageW initialized this message for the current thread.
            unsafe { DispatchMessageW(&message) };
        }
        true
    }
}
