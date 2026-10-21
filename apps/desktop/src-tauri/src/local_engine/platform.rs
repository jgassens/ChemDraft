use std::path::{Path, PathBuf};
use std::process::Command;

use super::pins;

/// Everything about a local engine that differs by operating system: which pinned uv archive to
/// fetch, where uv and the venv's interpreter live, and how child processes are spawned. Adding a
/// target means one more implementation plus its reviewed pins in `pins.rs`; nothing else in the
/// installer or process manager branches on the OS.
pub trait EnginePlatform: Send + Sync {
    fn uv_asset(&self) -> &'static str;
    fn uv_sha256(&self) -> &'static str;
    fn uv_executable(&self, root: &Path) -> PathBuf;
    fn venv_python(&self, root: &Path) -> PathBuf;
    /// Prepares a child the engine starts (uv, the sidecar) so that [`kill_process_tree`] can
    /// take down it and everything it started.
    fn configure_child(&self, command: &mut Command);
}

#[derive(Debug)]
#[cfg(any(target_os = "macos", test))]
pub struct MacPlatform {
    architecture: MacArchitecture,
}

#[derive(Debug, Clone, Copy)]
#[cfg(any(target_os = "macos", test))]
#[allow(dead_code)] // Each build selects the variant for its own architecture.
pub enum MacArchitecture {
    Aarch64,
    X86_64,
}

#[cfg(any(target_os = "macos", test))]
impl MacPlatform {
    pub fn new(architecture: MacArchitecture) -> Self {
        Self { architecture }
    }
}

#[cfg(any(target_os = "macos", test))]
impl EnginePlatform for MacPlatform {
    fn uv_asset(&self) -> &'static str {
        match self.architecture {
            MacArchitecture::Aarch64 => pins::UV_AARCH64_APPLE_ASSET,
            MacArchitecture::X86_64 => pins::UV_X86_64_APPLE_ASSET,
        }
    }

    fn uv_sha256(&self) -> &'static str {
        match self.architecture {
            MacArchitecture::Aarch64 => pins::UV_AARCH64_APPLE_SHA256,
            MacArchitecture::X86_64 => pins::UV_X86_64_APPLE_SHA256,
        }
    }

    fn uv_executable(&self, root: &Path) -> PathBuf {
        root.join("uv")
    }

    fn venv_python(&self, root: &Path) -> PathBuf {
        root.join("venv").join("bin").join("python")
    }

    /// Its own process group (pgid = its pid), which `kill_process_tree` signals as a whole.
    fn configure_child(&self, command: &mut Command) {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(not(unix))]
        let _ = command;
    }
}

#[derive(Debug)]
#[cfg(any(target_os = "windows", test))]
pub struct WindowsPlatform;

#[cfg(any(target_os = "windows", test))]
impl EnginePlatform for WindowsPlatform {
    fn uv_asset(&self) -> &'static str {
        pins::UV_X86_64_WINDOWS_ASSET
    }

    fn uv_sha256(&self) -> &'static str {
        pins::UV_X86_64_WINDOWS_SHA256
    }

    fn uv_executable(&self, root: &Path) -> PathBuf {
        root.join("uv.exe")
    }

    fn venv_python(&self, root: &Path) -> PathBuf {
        root.join("venv").join("Scripts").join("python.exe")
    }

    fn configure_child(&self, command: &mut Command) {
        configure_windows_child(command);
    }
}

/// No console window, and a new process group so the child does not share the app's console
/// control events. Unverified: no Windows build has run yet (see the engine architecture documentation).
#[cfg(target_os = "windows")]
fn configure_windows_child(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW};
    command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
}

#[cfg(all(not(target_os = "windows"), test))]
fn configure_windows_child(_command: &mut Command) {}

/// Kills a child started with [`EnginePlatform::configure_child`] and every process it started,
/// without waiting for them to exit. uv runs Python (package builds, interpreter
/// checks); killing uv alone would leave those writing into the staging tree after ChemDraft quits.
///
/// Callers pass only the id of a child they have not reaped yet (they hold the lock that reaps
/// it), so the id cannot have been reused by an unrelated process.
///
/// Unix: SIGKILL to the process group the child leads (`MacPlatform::configure_child` makes it a
/// group leader), and to the child itself in case it is not one. A child forked at the moment of
/// the kill can escape it; [`sweep_exited_process_group`] catches it before the leader is reaped.
#[cfg(unix)]
pub fn kill_process_tree(pid: u32) {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return;
    };
    if pid <= 1 {
        return;
    }
    // SAFETY: plain signal delivery to a child this process still owns; failures (ESRCH once the
    // group is gone) are harmless and ignored.
    unsafe {
        libc::killpg(pid, libc::SIGKILL);
        libc::kill(pid, libc::SIGKILL);
    }
}

/// Windows: `taskkill /T /F` ends the process and every descendant. A job object with
/// KILL_ON_JOB_CLOSE would also cover a crash of ChemDraft itself and is the stronger fix once a
/// Windows build can be tested. Unverified: no Windows build has run yet.
#[cfg(windows)]
pub fn kill_process_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

#[cfg(not(any(unix, windows)))]
pub fn kill_process_tree(_pid: u32) {}

/// Reports whether the unreaped child `pid` has exited, without reaping it, and if it has, kills
/// whatever is left of the process group it led. `block` waits for the exit instead of returning
/// `Ok(false)` while it is still running.
///
/// [`kill_process_tree`] alone is not enough on macOS: a group kill that lands while the leader is
/// forking misses the new child, which joins the group just after the signal went out and lives
/// on, holding the leader's stdout open (measured: a killed `sh` lost its `sleep` in 11 of 15 runs
/// when the kill landed ~100 µs into the fork). Once the leader has exited it cannot fork again,
/// and until it is reaped its pid, and so the group id, cannot be reused, so this second kill
/// reaches every survivor and nothing else. Callers reap (`Child::try_wait`/`wait`) only after it.
#[cfg(unix)]
pub fn sweep_exited_process_group(pid: u32, block: bool) -> std::io::Result<bool> {
    let id = libc::id_t::try_from(pid).map_err(|_| std::io::ErrorKind::InvalidInput)?;
    let mut flags = libc::WEXITED | libc::WNOWAIT;
    if !block {
        flags |= libc::WNOHANG;
    }
    loop {
        // SAFETY: an all-zero siginfo_t is valid, and zero is what `si_pid` must read when
        // WNOHANG finds the child still running.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        // SAFETY: `info` is a valid out-pointer; WNOWAIT leaves the child for `Child` to reap.
        if unsafe { libc::waitid(libc::P_PID, id, &mut info, flags) } == 0 {
            // SAFETY: waitid filled `info` for a child state change, or left it zeroed.
            if unsafe { info.si_pid() } == 0 {
                return Ok(false);
            }
            kill_process_tree(pid);
            return Ok(true);
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

/// No process groups to sweep; callers fall back to reaping the child directly.
#[cfg(not(unix))]
pub fn sweep_exited_process_group(_pid: u32, _block: bool) -> std::io::Result<bool> {
    Err(std::io::ErrorKind::Unsupported.into())
}

pub fn free_disk_bytes(path: &Path) -> Result<u64, String> {
    #[cfg(unix)]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let encoded = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| "The app data path contains a NUL byte.".to_string())?;
        let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        // SAFETY: `encoded` is NUL-terminated and `stats` points to writable storage for statvfs.
        let result = unsafe { libc::statvfs(encoded.as_ptr(), stats.as_mut_ptr()) };
        if result != 0 {
            return Err(format!(
                "Could not query free disk space: {}",
                std::io::Error::last_os_error()
            ));
        }
        // SAFETY: statvfs returned success and initialized the structure.
        let stats = unsafe { stats.assume_init() };
        Ok(u64::from(stats.f_bavail).saturating_mul(stats.f_frsize))
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut available = 0_u64;
        // SAFETY: `wide` is NUL-terminated and `available` is a valid out pointer.
        let result = unsafe {
            GetDiskFreeSpaceExW(
                wide.as_ptr(),
                &mut available,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if result == 0 {
            return Err(format!(
                "Could not query free disk space: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(available)
    }
    #[cfg(not(any(unix, target_os = "windows")))]
    {
        Err("Free-space checks are unsupported on this platform.".to_string())
    }
}

use std::io;
use std::process::{Child, ExitStatus};
use std::sync::{Mutex, MutexGuard};

/// The installer's child operations, with a seam for failures from `try_wait`.
pub(crate) trait InstallChild {
    fn id(&self) -> u32;
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>>;
    fn kill(&mut self) -> io::Result<()>;
    fn wait(&mut self) -> io::Result<ExitStatus>;
}

impl InstallChild for Child {
    fn id(&self) -> u32 {
        self.id()
    }
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.try_wait()
    }
    fn kill(&mut self) -> io::Result<()> {
        self.kill()
    }
    fn wait(&mut self) -> io::Result<ExitStatus> {
        self.wait()
    }
}

/// The uv child an install is running, if any, so app exit can kill it and everything it started
/// without waiting for the install thread to notice its cancel flag: a process that is exiting
/// never gets back to that thread, and an orphaned uv would keep writing gigabytes into the
/// staging tree after ChemDraft has quit.
#[derive(Default)]
pub struct RunningChild {
    pid: Mutex<Option<u32>>,
}

impl RunningChild {
    #[cfg(windows)]
    pub(crate) fn has_child(&self) -> bool {
        self.slot().is_some()
    }

    /// Kills the running child's whole process tree, if a child is running. Returns at once.
    pub fn kill_tree(&self) {
        if let Some(pid) = *self.slot() {
            kill_process_tree(pid);
        }
    }

    pub(crate) fn track(&self, child: &impl InstallChild) {
        *self.slot() = Some(child.id());
    }

    /// `try_wait` under the slot's lock, clearing the slot once the child is reaped: `kill_tree`
    /// then never signals an id the system may already have handed to another process.
    pub(crate) fn try_wait(&self, child: &mut impl InstallChild) -> io::Result<Option<ExitStatus>> {
        let mut slot = self.slot();
        let result = child.try_wait();
        if matches!(result, Ok(Some(_))) {
            *slot = None;
        }
        result
    }

    /// Keep the PID protected from concurrent exit/cancel until the child has been reaped.
    /// On a wait failure it stays tracked, so those paths can still retry the tree kill.
    pub(crate) fn kill_and_wait(&self, child: &mut impl InstallChild) {
        let mut slot = self.slot();
        if let Some(pid) = *slot {
            kill_process_tree(pid);
            let _ = child.kill();
            let _ = sweep_exited_process_group(pid, true);
            if child.wait().is_ok() {
                *slot = None;
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn tracked_pid(&self) -> Option<u32> {
        *self.slot()
    }

    fn slot(&self) -> MutexGuard<'_, Option<u32>> {
        self.pid
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
