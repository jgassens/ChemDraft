//! Verified download metadata for supported external tools.
use super::catalog::ToolId;
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ToolPlatform {
    DarwinArm64,
    DarwinX64,
    WindowsX64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ArchiveKind {
    Raw,
    TarGz,
    Zip,
    /// Extract every entry, preserving paths, with the traversal guards; `binary` is relative to the tree.
    ZipTree,
}
#[derive(Debug, Clone)]
pub struct ToolPin {
    pub tool: ToolId,
    pub platform: ToolPlatform,
    pub version: &'static str,
    pub url: &'static str,
    pub size: u64,
    pub sha256: &'static str,
    pub archive: ArchiveKind,
    pub entry: &'static str,
    pub binary: &'static str,
}
pub const PIN_PENDING: &str = "PIN_PENDING";
pub const CLAUDE_VERSION: &str = "2.1.308";
pub const CODEX_TAG: &str = "rust-v0.163.0";
pub const CODEX_VERSION: &str = "0.163.0";
pub const PINS: [ToolPin; 6] = [
    ToolPin {
        tool: ToolId::Claude,
        platform: ToolPlatform::DarwinArm64,
        version: CLAUDE_VERSION,
        url: "https://downloads.claude.ai/claude-code-releases/2.1.308/darwin-arm64/claude",
        size: 274675680,
        sha256: "ca923c86ac84b30574a82331a05b6e066c27477a926ceaffe46a845a33e4dd37",
        archive: ArchiveKind::Raw,
        entry: "claude",
        binary: "claude",
    },
    ToolPin {
        tool: ToolId::Claude,
        platform: ToolPlatform::DarwinX64,
        version: CLAUDE_VERSION,
        url: "https://downloads.claude.ai/claude-code-releases/2.1.308/darwin-x64/claude",
        size: 285902384,
        sha256: "9a0bc140f5fb06e6366624d770371ef290e6731d1e84c4def5daf4df946d1b59",
        archive: ArchiveKind::Raw,
        entry: "claude",
        binary: "claude",
    },
    ToolPin {
        tool: ToolId::Claude,
        platform: ToolPlatform::WindowsX64,
        version: CLAUDE_VERSION,
        url: "https://downloads.claude.ai/claude-code-releases/2.1.308/win32-x64/claude.exe",
        size: 297376928,
        sha256: "c9796ba22a9221586b36371b36f5b66198d66eb4badf6a4cf4a5f7b07becea53",
        archive: ArchiveKind::Raw,
        entry: "claude.exe",
        binary: "claude.exe",
    },
    ToolPin {
        tool: ToolId::Codex,
        platform: ToolPlatform::DarwinArm64,
        version: CODEX_VERSION,
        url: "https://github.com/openai/codex/releases/download/rust-v0.163.0/codex-aarch64-apple-darwin.tar.gz",
        size: 99551880,
        sha256: "61c4d9a92521bdb42b0c1d9f87c673f6da628a06de5945cbdd9a0010632f6d10",
        archive: ArchiveKind::TarGz,
        entry: "codex-aarch64-apple-darwin",
        binary: "codex",
    },
    ToolPin {
        tool: ToolId::Codex,
        platform: ToolPlatform::DarwinX64,
        version: CODEX_VERSION,
        url: "https://github.com/openai/codex/releases/download/rust-v0.163.0/codex-x86_64-apple-darwin.tar.gz",
        size: 108640069,
        sha256: "562a1aea0e5686283a467687d268ae33705f02fd4d40f1bc4110a415c5c1c7b1",
        archive: ArchiveKind::TarGz,
        entry: "codex-x86_64-apple-darwin",
        binary: "codex",
    },
    ToolPin {
        tool: ToolId::Codex,
        platform: ToolPlatform::WindowsX64,
        version: CODEX_VERSION,
        url: "https://github.com/openai/codex/releases/download/rust-v0.163.0/codex-x86_64-pc-windows-msvc.exe.zip",
        size: 167080091,
        sha256: "dabdb4d16aaf10fea40b74811c96efddcd9138f122163b69ed604fcb3eb704c3",
        archive: ArchiveKind::ZipTree,
        entry: "codex-x86_64-pc-windows-msvc.exe",
        binary: "codex-x86_64-pc-windows-msvc.exe",
    },
];
pub fn pin_for(tool: ToolId, platform: ToolPlatform) -> &'static ToolPin {
    PINS.iter()
        .find(|p| p.tool == tool && p.platform == platform)
        .expect("all supported tool/platform pairs are pinned")
}
