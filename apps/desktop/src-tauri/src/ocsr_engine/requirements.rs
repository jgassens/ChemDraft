//! One target-specific source of truth for lock lookup, verification and receipt pins.

use super::pins;
use crate::local_engine::platform::EngineTarget;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequirementsProfile {
    pub path: &'static str,
    pub sha256: &'static str,
    pub torch: &'static str,
    pub torchvision: &'static str,
    pub numpy: &'static str,
    pub rdkit: &'static str,
    pub opencv_python: &'static str,
    pub opencv_python_headless: &'static str,
}

impl RequirementsProfile {
    pub fn for_target(target: EngineTarget) -> Self {
        if target == EngineTarget::MacosX86_64 {
            Self {
                path: "resources/ocsr/requirements-macos-x86_64.txt",
                sha256: pins::REQUIREMENTS_LOCK_SHA256_MACOS_X86_64,
                torch: "2.2.2",
                torchvision: "0.17.2",
                numpy: pins::NUMPY_VERSION,
                rdkit: "2023.9.6",
                opencv_python: "4.9.0.80",
                opencv_python_headless: "4.9.0.80",
            }
        } else {
            Self {
                path: "resources/ocsr/requirements.txt",
                sha256: pins::REQUIREMENTS_LOCK_SHA256,
                torch: pins::TORCH_VERSION,
                torchvision: pins::TORCHVISION_VERSION,
                numpy: pins::NUMPY_VERSION,
                rdkit: pins::RDKIT_VERSION,
                opencv_python: pins::OPENCV_VERSION,
                opencv_python_headless: pins::OPENCV_VERSION,
            }
        }
    }

    pub fn lock(self) -> (&'static str, &'static str) {
        (self.path, self.sha256)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intel_input_retains_all_other_existing_lock_pins() {
        let original = include_str!("../../resources/ocsr/requirements.txt");
        let intel = include_str!("../../resources/ocsr/requirements-macos-x86_64.in");
        let profile = RequirementsProfile::for_target(EngineTarget::MacosX86_64);
        for (package, version) in [
            ("torch", profile.torch),
            ("torchvision", profile.torchvision),
            ("numpy", profile.numpy),
            ("rdkit", profile.rdkit),
            ("opencv-python", profile.opencv_python),
            ("opencv-python-headless", profile.opencv_python_headless),
        ] {
            assert!(
                intel
                    .lines()
                    .any(|line| line == format!("{package}=={version}")),
                "{package}"
            );
        }
        for line in original.lines().filter(|line| {
            !line.starts_with(char::is_whitespace) && !line.starts_with('#') && line.contains("==")
        }) {
            let pin = line.trim_end_matches('\\').trim();
            let (name, _) = pin.split_once("==").expect("exact pin");
            if [
                "torch",
                "torchvision",
                "rdkit",
                "opencv-python",
                "opencv-python-headless",
            ]
            .contains(&name)
            {
                continue;
            }
            assert!(
                intel
                    .lines()
                    .any(|candidate| candidate.eq_ignore_ascii_case(pin)),
                "missing {pin}"
            );
        }
        assert!(intel.contains("uv pip compile requirements-macos-x86_64.in --python-version 3.10 --python-platform x86_64-apple-darwin --generate-hashes -o requirements-macos-x86_64.txt"));
    }

    #[test]
    fn requirements_profile_is_selected_from_the_explicit_build_target() {
        for target in [EngineTarget::MacosAarch64, EngineTarget::WindowsX86_64] {
            let profile = RequirementsProfile::for_target(target);
            assert_eq!(profile.path, "resources/ocsr/requirements.txt");
            assert_eq!(
                profile.sha256,
                "6c71c47f1bf1ee6c419948121ab3923b50dff75488445e4dbd3c0a84b08d7383"
            );
            assert_eq!(profile.torch, "2.14.0");
            assert_eq!(profile.torchvision, "0.29.0");
            assert_eq!(profile.numpy, "1.26.4");
            assert_eq!(profile.rdkit, "2026.3.6");
            assert_eq!(profile.opencv_python, "4.11.0.86");
            assert_eq!(profile.opencv_python_headless, "4.11.0.86");
        }

        let intel = RequirementsProfile::for_target(EngineTarget::MacosX86_64);
        assert_eq!(intel.path, "resources/ocsr/requirements-macos-x86_64.txt");
        assert_eq!(intel.sha256, pins::REQUIREMENTS_LOCK_SHA256_MACOS_X86_64);
        assert_ne!(intel.sha256, pins::REQUIREMENTS_LOCK_SHA256);
        assert_eq!(intel.torch, "2.2.2");
        assert_eq!(intel.torchvision, "0.17.2");
        assert_eq!(intel.numpy, "1.26.4");
        assert_eq!(intel.rdkit, "2023.9.6");
        assert_eq!(intel.opencv_python, "4.9.0.80");
        assert_eq!(intel.opencv_python_headless, "4.9.0.80");
    }
}
