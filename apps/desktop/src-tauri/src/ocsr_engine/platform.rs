use std::path::{Path, PathBuf};
use std::process::Command;

use super::pins;

/// Everything about the OCSR engine that differs by operating system: which pinned uv archive to
/// fetch, where uv and the venv's interpreter live, and how child processes are spawned. Adding a
/// target means one more implementation plus its reviewed pins in `pins.rs`; nothing else in the
/// installer or process manager branches on the OS. See docs/architecture/ocsr-engine.md.
pub trait EnginePlatform: Send + Sync {
    fn uv_asset(&self) -> &'static str;
    fn uv_sha256(&self) -> &'static str;
    fn uv_executable(&self, root: &Path) -> PathBuf;
    fn venv_python(&self, root: &Path) -> PathBuf;
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

    fn configure_child(&self, _command: &mut Command) {}
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

#[cfg(target_os = "windows")]
fn configure_windows_child(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(all(not(target_os = "windows"), test))]
fn configure_windows_child(_command: &mut Command) {}

pub fn current() -> Result<Box<dyn EnginePlatform>, String> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return Ok(Box::new(MacPlatform::new(MacArchitecture::Aarch64)));
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return Ok(Box::new(MacPlatform::new(MacArchitecture::X86_64)));
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return Ok(Box::new(WindowsPlatform));
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64")
    )))]
    Err(format!(
        "MolScribe is not available for {}-{}.",
        std::env::consts::OS,
        std::env::consts::ARCH
    ))
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

pub fn has_required_disk(free_bytes: u64) -> bool {
    free_bytes >= pins::REQUIRED_DISK_BYTES
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_platform_specific_assets_and_paths() {
        let root = Path::new("engine");
        let arm = MacPlatform::new(MacArchitecture::Aarch64);
        assert_eq!(arm.uv_asset(), pins::UV_AARCH64_APPLE_ASSET);
        assert_eq!(arm.uv_executable(root), root.join("uv"));
        assert_eq!(arm.venv_python(root), root.join("venv/bin/python"));

        let intel = MacPlatform::new(MacArchitecture::X86_64);
        assert_eq!(intel.uv_asset(), pins::UV_X86_64_APPLE_ASSET);

        let windows = WindowsPlatform;
        assert_eq!(windows.uv_asset(), pins::UV_X86_64_WINDOWS_ASSET);
        assert_eq!(windows.uv_executable(root), root.join("uv.exe"));
        assert_eq!(
            windows.venv_python(root),
            root.join("venv/Scripts/python.exe")
        );
    }

    #[test]
    fn disk_space_threshold_is_exact() {
        assert!(!has_required_disk(pins::REQUIRED_DISK_BYTES - 1));
        assert!(has_required_disk(pins::REQUIRED_DISK_BYTES));
    }
}
