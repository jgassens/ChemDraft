//! Shared, engine-independent installation and sidecar machinery.
//!
//! Specs use static methods: each adapter has one pinned configuration. Two install hooks keep
//! pre-dependency downloads ahead of the hash-locked package install and the remaining steps after
//! it, preserving each adapter's ordering and progress stream. Receipts and protocol diagnostics
//! remain adapter-owned. Overall install-bar weights are currently a frontend concern; this module
//! provides the original growth estimates and throttle without adding fields to emitted events.
pub mod install;
pub mod pins;
pub mod platform;
pub mod process;
pub mod progress;
pub mod receipt;

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum InstallPhase {
    CheckingDisk,
    DownloadingUv,
    InstallingPython,
    InstallingPackages,
    DownloadingModel,
    Verifying,
    Done,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub phase: InstallPhase,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_done: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_total: Option<u64>,
    /// The byte counts are an estimate from directory growth, not a transfer count
    /// (see `progress.rs`). Omitted when false.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub estimated: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum InstallErrorCode {
    InsufficientDisk,
    Network,
    ChecksumMismatch,
    Cancelled,
    Unsupported,
    Failed,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstallError {
    pub code: InstallErrorCode,
    pub message: String,
}

impl InstallError {
    pub fn network(message: impl Into<String>) -> Self {
        Self {
            code: InstallErrorCode::Network,
            message: message.into(),
        }
    }
    pub fn checksum(message: impl Into<String>) -> Self {
        Self {
            code: InstallErrorCode::ChecksumMismatch,
            message: message.into(),
        }
    }
    pub fn failed(message: impl Into<String>) -> Self {
        Self {
            code: InstallErrorCode::Failed,
            message: message.into(),
        }
    }
    pub fn unsupported(message: impl Into<String>) -> Self {
        Self {
            code: InstallErrorCode::Unsupported,
            message: message.into(),
        }
    }
}

/// Shared staging lock, owned by the host's engine state. Multiple adapters can share a registry.
#[derive(Clone, Default)]
pub struct EngineRegistry {
    pub staging: std::sync::Arc<std::sync::Mutex<()>>,
}

/// Policy at the install boundary. Hooks retain downloads, labels, layout and receipt schemas;
/// the transaction, verified IO and relocation remain shared.
pub trait EngineSpec: Send + Sync + 'static {
    type Receipt;
    const DIR_NAME: &'static str;
    const LOG_PREFIX: &'static str;
    const USER_AGENT: &'static str;
    fn python_version() -> &'static str;
    fn required_disk_bytes() -> u64;
    fn requirements() -> (&'static str, &'static str);
    fn python_growth_bytes() -> u64;
    fn packages_growth_bytes() -> u64;
    fn packages_label() -> &'static str;
    fn packages_message() -> &'static str;
    fn installed_message() -> &'static str;
    fn insufficient_disk(free_bytes: u64) -> InstallError;
    fn cancelled() -> InstallError;
    fn failed_io(error: std::io::Error) -> InstallError;
    fn relocation_error(error: std::io::Error) -> InstallError;
    fn platform_supported(platform: &dyn platform::EnginePlatform) -> Result<(), String>;
    fn before_packages(context: &install::InstallContext<'_>) -> Result<(), InstallError>;
    fn extra_steps(context: &install::InstallContext<'_>) -> Result<(), InstallError>;
    fn probe_args() -> Vec<std::ffi::OsString>;
    fn verify_layout(
        root: &std::path::Path,
        platform: &dyn platform::EnginePlatform,
    ) -> Result<(), InstallError>;
    fn receipt(platform: &dyn platform::EnginePlatform, disk_bytes: u64) -> Self::Receipt;
    fn read_current_receipt(path: &std::path::Path) -> Option<Self::Receipt>;
    fn matches_pins(receipt: &Self::Receipt, platform: &dyn platform::EnginePlatform) -> bool;
    fn write_receipt(path: &std::path::Path, receipt: &Self::Receipt) -> Result<(), InstallError>;
    fn is_restorable(root: &std::path::Path, platform: &dyn platform::EnginePlatform) -> bool;
}

#[cfg(test)]
mod tests;
