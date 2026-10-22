//! Download metadata is deliberately NOT release-ready until the pinning task replaces placeholders.
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
pub const CLAUDE_VERSION: &str = "2.1.308";
pub const CODEX_TAG: &str = "rust-v0.163.0";
pub const CODEX_VERSION: &str = "0.163.0";
pub const PIN_PENDING: &str = "PIN_PENDING";
pub const SIZE_PENDING: u64 = 0;
// URL templates are pinned to the specified releases; sizes/digests still need the pin script.
pub const PINS: [ToolPin; 6] = [
    ToolPin {
        tool: ToolId::Claude,
        platform: ToolPlatform::DarwinArm64,
        version: CLAUDE_VERSION,
        url: "https://downloads.claude.ai/claude-code-releases/2.1.308/darwin-arm64/claude",
        size: SIZE_PENDING,
        sha256: PIN_PENDING,
        archive: ArchiveKind::Raw,
        entry: "claude",
        binary: "claude",
    },
    ToolPin {
        tool: ToolId::Claude,
        platform: ToolPlatform::DarwinX64,
        version: CLAUDE_VERSION,
        url: "https://downloads.claude.ai/claude-code-releases/2.1.308/darwin-x64/claude",
        size: SIZE_PENDING,
        sha256: PIN_PENDING,
        archive: ArchiveKind::Raw,
        entry: "claude",
        binary: "claude",
    },
    ToolPin {
        tool: ToolId::Claude,
        platform: ToolPlatform::WindowsX64,
        version: CLAUDE_VERSION,
        url: "https://downloads.claude.ai/claude-code-releases/2.1.308/win32-x64/claude.exe",
        size: SIZE_PENDING,
        sha256: PIN_PENDING,
        archive: ArchiveKind::Raw,
        entry: "claude.exe",
        binary: "claude.exe",
    },
    ToolPin {
        tool: ToolId::Codex,
        platform: ToolPlatform::DarwinArm64,
        version: CODEX_VERSION,
        url: "https://github.com/openai/codex/releases/download/rust-v0.163.0/codex-aarch64-apple-darwin.tar.gz",
        size: SIZE_PENDING,
        sha256: PIN_PENDING,
        archive: ArchiveKind::TarGz,
        entry: "codex-aarch64-apple-darwin",
        binary: "codex",
    },
    ToolPin {
        tool: ToolId::Codex,
        platform: ToolPlatform::DarwinX64,
        version: CODEX_VERSION,
        url: "https://github.com/openai/codex/releases/download/rust-v0.163.0/codex-x86_64-apple-darwin.tar.gz",
        size: SIZE_PENDING,
        sha256: PIN_PENDING,
        archive: ArchiveKind::TarGz,
        entry: "codex-x86_64-apple-darwin",
        binary: "codex",
    },
    ToolPin {
        tool: ToolId::Codex,
        platform: ToolPlatform::WindowsX64,
        version: CODEX_VERSION,
        url: "https://github.com/openai/codex/releases/download/rust-v0.163.0/codex-x86_64-pc-windows-msvc.exe.zip",
        size: SIZE_PENDING,
        sha256: PIN_PENDING,
        archive: ArchiveKind::Zip,
        entry: "codex-x86_64-pc-windows-msvc.exe",
        binary: "codex.exe",
    },
];
pub fn pin_for(tool: ToolId, platform: ToolPlatform) -> &'static ToolPin {
    PINS.iter()
        .find(|p| p.tool == tool && p.platform == platform)
        .expect("all supported tool/platform pairs are pinned")
}
