#[cfg(test)]
use super::pins;
pub use crate::local_engine::platform::*;

pub fn current() -> Result<Box<dyn EnginePlatform>, String> {
    for_target(EngineTarget::current())
}

/// The shared platform identifies the build target; MolScribe's requirements profile supplies
/// that target's package set, including the separate lock for Intel Macs.
fn for_target(target: EngineTarget) -> Result<Box<dyn EnginePlatform>, String> {
    crate::local_engine::platform::for_target(target).map_err(|_| {
        format!(
            "MolScribe is not available for {}-{}.",
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })
}

#[cfg(test)]
pub fn has_required_disk(free_bytes: u64) -> bool {
    free_bytes >= pins::REQUIRED_DISK_BYTES
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_engine::EngineSpec;
    use crate::ocsr_engine::install::MolScribeSpec;
    use std::path::Path;

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
    fn intel_mac_gets_a_real_platform_with_its_own_requirements_profile() {
        let platform = for_target(EngineTarget::MacosX86_64).expect("Intel Mac supported");
        assert_eq!(platform.target(), EngineTarget::MacosX86_64);
        assert_eq!(platform.uv_asset(), pins::UV_X86_64_APPLE_ASSET);
        assert_eq!(
            MolScribeSpec::requirements_for(platform.as_ref()),
            (
                "resources/ocsr/requirements-macos-x86_64.txt",
                pins::REQUIREMENTS_LOCK_SHA256_MACOS_X86_64
            )
        );
    }

    #[test]
    fn apple_silicon_mac_gets_a_real_platform() {
        assert!(for_target(EngineTarget::MacosAarch64).is_ok());
    }

    #[test]
    fn windows_gets_a_real_platform_and_other_targets_stay_unsupported() {
        assert!(for_target(EngineTarget::WindowsX86_64).is_ok());
        assert!(for_target(EngineTarget::Unsupported).is_err());
    }

    #[test]
    fn disk_space_threshold_is_exact() {
        assert!(!has_required_disk(pins::REQUIRED_DISK_BYTES - 1));
        assert!(has_required_disk(pins::REQUIRED_DISK_BYTES));
    }
}
