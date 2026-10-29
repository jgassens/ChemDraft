#[cfg(test)]
use super::pins;
pub use crate::local_engine::platform::*;
#[cfg(test)]
use std::path::Path;
#[cfg(any(target_os = "macos", test))]
impl MacArchitecture {
    /// Whether `current()` should hand out a working platform for this architecture. Intel Macs
    /// are seam-complete (asset pins, venv paths) but disabled because the hash-locked
    /// requirements pin torch 2.14.0, which has no macOS x86_64 wheel; see `current()`.
    fn is_installable(self) -> bool {
        match self {
            MacArchitecture::Aarch64 => true,
            MacArchitecture::X86_64 => false,
        }
    }
}

pub fn current() -> Result<Box<dyn EnginePlatform>, String> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return mac_platform_or_unsupported(MacArchitecture::Aarch64);
    // Intel Macs keep the `MacArchitecture::X86_64` seam (uv asset pins, venv paths) so a real
    // build stays a data change away, but `is_installable()` reports `unsupported` up front
    // rather than reaching it: the hash-locked requirements pin torch 2.14.0, which ships no
    // macOS x86_64 wheel, so an install would download uv and Python and only then fail at the
    // packages step. Re-enable by pinning a torch build for x86_64 macOS in pins.rs and flipping
    // `MacArchitecture::X86_64` to `true` in `is_installable()`.
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return mac_platform_or_unsupported(MacArchitecture::X86_64);
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return Ok(Box::new(WindowsPlatform));
    // The Linux lock deliberately selects the reviewed CPU-only x86_64 wheels. Other Linux
    // architectures remain unavailable until their complete wheel set and inference are checked.
    #[cfg(all(target_os = "linux", target_env = "gnu", target_arch = "x86_64"))]
    return Ok(Box::new(LinuxPlatform::new(LinuxArchitecture::X86_64)));
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "linux", target_env = "gnu", target_arch = "x86_64")
    )))]
    Err(format!(
        "MolScribe is not available for {}-{}.",
        std::env::consts::OS,
        std::env::consts::ARCH
    ))
}

#[cfg(any(target_os = "macos", test))]
fn mac_platform_or_unsupported(
    architecture: MacArchitecture,
) -> Result<Box<dyn EnginePlatform>, String> {
    if architecture.is_installable() {
        Ok(Box::new(MacPlatform::new(architecture)))
    } else {
        Err("The recognition engine needs a Mac with Apple silicon.".to_string())
    }
}

#[cfg(test)]
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

        // The X86_64 seam stays intact (asset pins, venv paths above) even though it is
        // disabled: see `is_installable()`.
        assert!(MacArchitecture::Aarch64.is_installable());
        assert!(!MacArchitecture::X86_64.is_installable());

        let windows = WindowsPlatform;
        assert_eq!(windows.uv_asset(), pins::UV_X86_64_WINDOWS_ASSET);
        assert_eq!(windows.uv_executable(root), root.join("uv.exe"));
        assert_eq!(
            windows.venv_python(root),
            root.join("venv/Scripts/python.exe")
        );

        let linux = LinuxPlatform::new(LinuxArchitecture::X86_64);
        assert_eq!(linux.uv_asset(), pins::UV_X86_64_LINUX_ASSET);
        assert_eq!(linux.uv_sha256(), pins::UV_X86_64_LINUX_SHA256);
        assert_eq!(linux.uv_executable(root), root.join("uv"));
        assert_eq!(linux.venv_python(root), root.join("venv/bin/python"));
        let arm = LinuxPlatform::new(LinuxArchitecture::Aarch64);
        assert_ne!(arm.uv_asset(), linux.uv_asset());
        assert_eq!(arm.uv_sha256(), pins::UV_AARCH64_LINUX_SHA256);
    }

    #[test]
    fn intel_mac_is_unsupported_before_any_download() {
        let error = mac_platform_or_unsupported(MacArchitecture::X86_64)
            .err()
            .expect("Intel Macs must be reported unsupported, never given a platform");
        assert_eq!(
            error,
            "The recognition engine needs a Mac with Apple silicon."
        );
    }

    #[test]
    fn apple_silicon_mac_gets_a_real_platform() {
        assert!(mac_platform_or_unsupported(MacArchitecture::Aarch64).is_ok());
    }

    #[test]
    fn disk_space_threshold_is_exact() {
        assert!(!has_required_disk(pins::REQUIRED_DISK_BYTES - 1));
        assert!(has_required_disk(pins::REQUIRED_DISK_BYTES));
    }

    #[cfg(all(target_os = "linux", target_env = "gnu", target_arch = "x86_64"))]
    #[test]
    fn linux_selects_the_verified_cpu_runtime_before_any_download() {
        let platform = current().expect("GNU Linux x64 is supported");
        assert_eq!(platform.uv_asset(), pins::UV_X86_64_LINUX_ASSET);
        assert_eq!(pins::TORCH_VERSION, "2.14.0+cpu");
        assert_eq!(pins::TORCHVISION_VERSION, "0.29.0+cpu");
        assert!(!has_required_disk(7_999_999_999));
        assert!(has_required_disk(8_000_000_000));
    }
}
