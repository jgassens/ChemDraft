#[cfg(windows)]
pub(super) struct WindowsJob(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
pub(super) fn resume_windows_child(child: &std::process::Child) -> std::io::Result<()> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::{
        Foundation::INVALID_HANDLE_VALUE,
        System::{
            Diagnostics::ToolHelp::*,
            Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
        },
    };
    // SAFETY: the snapshot is an owned kernel handle; no pointers are passed to this call.
    let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if raw == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: ownership transfers exactly once to the RAII guard.
    let snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
    // SAFETY: THREADENTRY32 is a plain C structure; dwSize is set before the API reads it.
    let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of_val(&entry) as u32;
    // SAFETY: valid snapshot and initialized writable structure.
    let mut found = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
    while found != 0 {
        if entry.th32OwnerProcessID == child.id() {
            // The only thread belongs to our child, suspended since process creation.
            // SAFETY: requesting a noninheritable handle for an existing thread.
            let raw = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if raw.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            // SAFETY: transfer the newly owned handle exactly once.
            let thread = unsafe { OwnedHandle::from_raw_handle(raw) };
            // SAFETY: this thread belongs to our still-owned child and was created suspended.
            if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
                return Err(std::io::Error::last_os_error());
            }
            return Ok(());
        }
        // SAFETY: same live snapshot and writable structure as Thread32First.
        found = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "Suspended child thread was not found.",
    ))
}
#[cfg(windows)]
// SAFETY: the job handle is owned, used only by the supervisor, and closed exactly once.
unsafe impl Send for WindowsJob {}
#[cfg(windows)]
impl WindowsJob {
    pub(super) fn attach(child: &std::process::Child) -> std::io::Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::*;
        // SAFETY: null attributes/name request an unnamed, noninheritable job.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let job = Self(handle);
        // SAFETY: JOBOBJECT_EXTENDED_LIMIT_INFORMATION permits zero initialization.
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: correct structure size and valid job/process handles, owned for this call.
        if unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&info) as u32,
            )
        } == 0
            || unsafe { AssignProcessToJobObject(handle, child.as_raw_handle()) } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(job)
    }
    pub(super) fn terminate(&self) {
        // SAFETY: self owns a valid job handle.
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
        }
    }
}
#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        // SAFETY: this is the single owned reference to the handle.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
