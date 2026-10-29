//! Verified download metadata for supported external tools.
use super::catalog::ToolId;
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ToolPlatform {
    DarwinArm64,
    DarwinX64,
    WindowsX64,
    LinuxX64,
    LinuxArm64,
}
impl ToolPlatform {
    pub fn for_target(os: &str, arch: &str) -> Option<Self> {
        match (os, arch) {
            ("macos", "aarch64") => Some(Self::DarwinArm64),
            ("macos", "x86_64") => Some(Self::DarwinX64),
            ("windows", "x86_64") => Some(Self::WindowsX64),
            ("linux", "x86_64") => Some(Self::LinuxX64),
            ("linux", "aarch64") => Some(Self::LinuxArm64),
            _ => None,
        }
    }
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
pub const PINS: [ToolPin; 10] = [
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
        tool: ToolId::Claude,
        platform: ToolPlatform::LinuxX64,
        version: CLAUDE_VERSION,
        url: "https://downloads.claude.ai/claude-code-releases/2.1.308/linux-x64/claude",
        size: 292232560,
        sha256: "356733f185fa988e6bf3aa9a555269fdd167982a2e2a80d3c8a78037bb92ad58",
        archive: ArchiveKind::Raw,
        entry: "claude",
        binary: "claude",
    },
    ToolPin {
        tool: ToolId::Claude,
        platform: ToolPlatform::LinuxArm64,
        version: CLAUDE_VERSION,
        url: "https://downloads.claude.ai/claude-code-releases/2.1.308/linux-arm64/claude",
        size: 292085944,
        sha256: "fdd22e6cbb734d580f5664c48df4294eeec850218ff07f186f9af30426396ee1",
        archive: ArchiveKind::Raw,
        entry: "claude",
        binary: "claude",
    },
    ToolPin {
        tool: ToolId::Codex,
        platform: ToolPlatform::DarwinArm64,
        version: CODEX_VERSION,
        url: "https://github.com/openai/codex/releases/download/rust-v0.163.0/codex-package-aarch64-apple-darwin.tar.gz",
        size: 133412281,
        sha256: "b0344fc2e41f15e0071147e5869008047b8ff4bf2c4a8897975d3bae3f103b34",
        archive: ArchiveKind::TarGz,
        entry: "bin/codex",
        binary: "codex",
    },
    ToolPin {
        tool: ToolId::Codex,
        platform: ToolPlatform::DarwinX64,
        version: CODEX_VERSION,
        url: "https://github.com/openai/codex/releases/download/rust-v0.163.0/codex-package-x86_64-apple-darwin.tar.gz",
        size: 144982749,
        sha256: "0c182d6194da7003943678dc87866b54b3dee719edaf8d092f304affbc6b57d1",
        archive: ArchiveKind::TarGz,
        entry: "bin/codex",
        binary: "codex",
    },
    ToolPin {
        tool: ToolId::Codex,
        platform: ToolPlatform::WindowsX64,
        version: CODEX_VERSION,
        url: "https://github.com/openai/codex/releases/download/rust-v0.163.0/codex-package-x86_64-pc-windows-msvc.tar.gz",
        size: 162230206,
        sha256: "901028b285614a9974f431f9d9f6534b3e5ed8d62eba4ba64f4762c00f040522",
        archive: ArchiveKind::TarGz,
        entry: "bin/codex.exe",
        binary: "codex.exe",
    },
    ToolPin {
        tool: ToolId::Codex,
        platform: ToolPlatform::LinuxX64,
        version: CODEX_VERSION,
        url: "https://github.com/openai/codex/releases/download/rust-v0.163.0/codex-package-x86_64-unknown-linux-musl.tar.gz",
        size: 159424486,
        sha256: "582646c6bf0561eb0de540f7fc85b9121b0091a826bc6e96830b7f1722122182",
        archive: ArchiveKind::TarGz,
        entry: "bin/codex",
        binary: "codex",
    },
    ToolPin {
        tool: ToolId::Codex,
        platform: ToolPlatform::LinuxArm64,
        version: CODEX_VERSION,
        url: "https://github.com/openai/codex/releases/download/rust-v0.163.0/codex-package-aarch64-unknown-linux-musl.tar.gz",
        size: 149800043,
        sha256: "9d8ecf2d19d3e184877983902d6c85de48b3888dcb72c382a8a0c975845927fb",
        archive: ArchiveKind::TarGz,
        entry: "bin/codex",
        binary: "codex",
    },
];
pub fn pin_for(tool: ToolId, platform: ToolPlatform) -> &'static ToolPin {
    PINS.iter()
        .find(|p| p.tool == tool && p.platform == platform)
        .expect("all supported tool/platform pairs are pinned")
}
