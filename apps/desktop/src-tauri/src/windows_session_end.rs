//! Tao delivers Exit directly from WM_ENDSESSION on its hidden event target.
//! Flush the committed session and record pending opens before forwarding it.

#[cfg(not(windows))]
pub(super) fn install(_app: &tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
pub(super) fn in_progress() -> bool {
    false
}

#[cfg(windows)]
pub(super) use windows::{in_progress, install, terminate_process};

#[cfg(windows)]
mod windows {
    use crate::{finish_exit_opens, flush_system_session, QuitKind};
    use std::{
        ptr::null_mut,
        sync::atomic::{AtomicBool, Ordering},
        thread,
        time::Duration,
    };
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        System::Threading::{GetCurrentProcess, GetCurrentThreadId, TerminateProcess},
        UI::{
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::{
                DispatchMessageW, EnumThreadWindows, GetClassNameW, PeekMessageW, PostQuitMessage,
                MSG, PM_QS_POSTMESSAGE, PM_QS_SENDMESSAGE, PM_REMOVE, WM_ENDSESSION, WM_NCDESTROY,
                WM_QUERYENDSESSION, WM_QUIT,
            },
        },
    };

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
            // A different app can still veto the query. Leave ChemDraft editable until TRUE.
            WM_QUERYENDSESSION => return 1,
            WM_ENDSESSION if wparam != 0 => {
                if ENDING.swap(true, Ordering::SeqCst) {
                    return 0; // The outer callback will forward the committed message to Tao.
                }
                // SAFETY: Clone the installed handle before pumping messages that can destroy it.
                let app = unsafe { (&*(data as *const tauri::AppHandle)).clone() };
                let recorder = app.clone();
                let _watchdog =
                    flush_system_session(&app, pump_webview, terminate_process, move || {
                        finish_exit_opens(&recorder, QuitKind::System, || {});
                    });
                // SAFETY: Forward through the live subclass chain with the watchdog still armed.
                // Tao dispatches Exit synchronously in this call.
                return unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
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

    fn pump_webview(remaining: Duration) -> bool {
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
            thread::sleep(remaining.min(Duration::from_millis(5)));
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

    pub(crate) fn terminate_process() {
        // Skip DLL detach handlers. WebView2 teardown can stall or raise a dialog.
        // SAFETY: GetCurrentProcess returns a pseudo-handle for this process.
        unsafe { TerminateProcess(GetCurrentProcess(), 0) };
        std::process::exit(0);
    }
}
