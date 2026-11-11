//! One target-specific source of truth for lock lookup, verification and receipt pins.

use super::pins;
use crate::local_engine::platform::EngineTarget;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequirementsProfile {
    pub path: &'static str,
    pub sha256: &'static str,
    /// Only Intel records a profile identifier, preserving the original receipt bytes.
    pub receipt_profile: Option<&'static str>,
}

impl RequirementsProfile {
    pub fn for_target(target: EngineTarget) -> Self {
        if target == EngineTarget::MacosX86_64 {
            Self {
                path: "resources/naming/requirements-macos-x86_64.txt",
                sha256: pins::REQUIREMENTS_LOCK_SHA256_MACOS_X86_64,
                receipt_profile: Some("macos-x86_64"),
            }
        } else {
            Self {
                path: "resources/naming/requirements.txt",
                sha256: pins::REQUIREMENTS_LOCK_SHA256,
                receipt_profile: None,
            }
        }
    }

    pub fn lock(self) -> (&'static str, &'static str) {
        (self.path, self.sha256)
    }
}
