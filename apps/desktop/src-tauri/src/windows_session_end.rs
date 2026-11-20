//! Tao delivers Exit directly from WM_ENDSESSION on its hidden event target.
//! Observe committed system shutdown before forwarding it.

#[cfg(not(windows))]
pub(super) fn install(_app: &tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
pub(super) fn in_progress() -> bool {
    false
}

#[cfg(windows)]
pub(super) use windows::{in_progress, install};

#[cfg(windows)]
mod windows {
    use crate::{finish_exit_opens, shutdown_kind, APP_QUITTING};
    use std::{
        ptr::null_mut,
        sync::atomic::{AtomicBool, Ordering},
    };
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        System::Threading::GetCurrentThreadId,
        UI::{
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::{
                EnumThreadWindows, GetClassNameW, WM_ENDSESSION, WM_NCDESTROY, WM_QUERYENDSESSION,
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
                APP_QUITTING.store(true, Ordering::SeqCst);
                // SAFETY: The subclass owns the handle until WM_NCDESTROY.
                let app = unsafe { &*(data as *const tauri::AppHandle) };
                finish_exit_opens(app, shutdown_kind(false), || {});
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
}
