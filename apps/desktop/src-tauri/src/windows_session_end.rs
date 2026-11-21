//! Tao 0.35.3 delivers Exit directly from WM_ENDSESSION on its hidden event target.
//! Run the document's committed flush before passing that message down the subclass chain.

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
        office_ole::{bridge::owner_id, server::Server, toolset_events::deliver},
        request_document_quit_flush, APP_QUITTING, QUIT,
    };
    use std::{
        ptr::null_mut,
        sync::{
            atomic::{AtomicBool, Ordering},
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
                DispatchMessageW, EnumThreadWindows, GetClassNameW, PeekMessageW, PostQuitMessage,
                MSG, PM_QS_POSTMESSAGE, PM_QS_SENDMESSAGE, PM_REMOVE, WM_ENDSESSION, WM_NCDESTROY,
                WM_QUERYENDSESSION, WM_QUIT,
            },
        },
    };

    const FLUSH_BUDGET: Duration = Duration::from_secs(2);
    // Spend at most 1.5 seconds collecting renderer drawings during the query. The committed
    // message shares its existing two-second flush budget between Office and the main document.
    const OFFICE_PUBLISH_BUDGET: Duration = Duration::from_millis(1500);
    static ENDING: AtomicBool = AtomicBool::new(false);

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
                publish_office_drawings(&app);
                return 1;
            }
            WM_ENDSESSION if wparam != 0 => {
                if ENDING.swap(true, Ordering::SeqCst) {
                    return 0; // The outer callback will forward the committed message to Tao.
                }
                APP_QUITTING.store(true, Ordering::SeqCst);
                // SAFETY: Clone the installed handle before pumping messages that can destroy it.
                let app = unsafe { (&*(data as *const tauri::AppHandle)).clone() };
                flush(&app);
            }
            WM_ENDSESSION if !in_progress() => {
                let app = unsafe { &*(data as *const tauri::AppHandle) };
                if let Some(id) = app.state::<Server>().cancel_session_publish() {
                    for window in app.webview_windows().into_values() {
                        if owner_id(window.label()).is_ok() {
                            deliver(&window, "office-session-cancel", &id.to_string());
                        }
                    }
                }
            }
            WM_NCDESTROY => {
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

    fn publish_office_drawings(app: &tauri::AppHandle) {
        let deadline = Instant::now() + OFFICE_PUBLISH_BUDGET;
        let server = app.state::<Server>();
        let editors: Vec<_> = app
            .webview_windows()
            .into_values()
            .filter_map(|window| Some((owner_id(window.label()).ok()?.to_owned(), window)))
            .collect();
        let Some(request) = server
            .start_session_publish(deadline, editors.iter().map(|(id, _)| id.clone()).collect())
        else {
            return;
        };
        for (_, window) in editors {
            deliver(&window, "office-session-publish", &request.to_string());
        }
        while Instant::now() < deadline && !server.missing_session_drawing_ids().is_empty() {
            if !pump_webviews() {
                break;
            }
        }
        for id in server.missing_session_drawing_ids() {
            super::log_office_loss(app, format_args!("Office object {id}: its latest drawing was not published within the 1.5-second session-end query budget. Unpublished edits may be lost if the session ends."));
        }
    }

    fn flush(app: &tauri::AppHandle) {
        let start = Instant::now();
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

        // Join an existing app quit or ask the document once. Pump WebView2 and its IPC so the
        // worker can persist the renderer's snapshot and acknowledge this specific request.
        let saving_office = app.state::<Server>().commit_session_publish(app);
        let request_id = match request_document_quit_flush(app) {
            Ok(id) => id,
            Err(error) => {
                eprintln!("ChemDraft: could not request session-end flush: {error}");
                None
            }
        };
        let document_saved = || request_id.is_none_or(|id| QUIT.flush_confirmed(id));
        while start.elapsed() < FLUSH_BUDGET
            && (!document_saved() || !saving_office.lock().unwrap().is_empty())
        {
            if !pump_webviews() {
                break;
            }
        }
        if !document_saved() {
            eprintln!("ChemDraft: session-end flush was not confirmed before shutdown");
        }
        let unsaved = saving_office.lock().unwrap().clone();
        for id in unsaved {
            super::log_office_loss(app, format_args!("Office object {id}: its new drawing was published, but Office did not confirm saving it before shutdown."));
        }
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
