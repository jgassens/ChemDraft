//! Pinned, transactional installs. Callers serialize installs and supply the app-local base.
use super::{
    catalog::{RenderedRun, ToolId},
    env::{self, ParentEnv},
    nonce,
    pins::{ArchiveKind, ToolPin, ToolPlatform, PIN_PENDING},
    probe::ProbePlatform,
    run::{CaptureError, RunStatus, ToolRun},
    ExternalToolStatus, ManagedTool, ToolInstallPhase, ToolInstallProgress, ToolSource, ToolState,
};
use crate::local_engine::{
    download::{check_cancel, download_verified, DownloadClient},
    file_ops::FileOps,
    install::{
        extract_single_entry_with_ops, extract_tar_entries_with_ops, make_executable_with_ops,
        ArchiveKind as ExtractKind,
    },
    platform::free_disk_bytes,
    progress::{ProgressThrottle, EMIT_INTERVAL},
    InstallError, InstallErrorCode,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

const RECEIPT: &str = "install.json";

fn binary_name(pin: &ToolPin) -> &str {
    pin.binary
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallReceipt {
    pub receipt_version: u32,
    pub tool: ToolId,
    pub version: String,
    pub platform: ToolPlatform,
    pub url: String,
    pub size: u64,
    pub sha256: String,
    pub installed_at: String,
}

impl InstallReceipt {
    fn matches(&self, pin: &ToolPin) -> bool {
        self.receipt_version == 1
            && self.tool == pin.tool
            && self.version == pin.version
            && self.platform == pin.platform
            && self.url == pin.url
            && self.size == pin.size
            && self.sha256 == pin.sha256
            && chrono::DateTime::parse_from_rfc3339(&self.installed_at).is_ok()
    }
}

/// Tests inject this boundary; production always uses the operating system verifier.
pub trait SignatureChecker {
    fn verify(&self, binary: &Path) -> Result<(), String>;
}

pub struct SystemSignatureChecker;
impl SignatureChecker for SystemSignatureChecker {
    fn verify(&self, binary: &Path) -> Result<(), String> {
        verify_signature(binary)
    }
}

#[cfg(target_os = "macos")]
fn verify_signature(binary: &Path) -> Result<(), String> {
    let output = std::process::Command::new("/usr/bin/codesign")
        .args(["--verify", "--strict"])
        .arg(binary)
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "codesign rejected the binary: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

#[cfg(windows)]
fn verify_signature(binary: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Security::WinTrust::*;
    let wide: Vec<u16> = binary.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut file = WINTRUST_FILE_INFO {
        cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: wide.as_ptr(),
        ..Default::default()
    };
    let mut data = WINTRUST_DATA {
        cbStruct: std::mem::size_of::<WINTRUST_DATA>() as u32,
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        Anonymous: WINTRUST_DATA_0 { pFile: &mut file },
        dwStateAction: WTD_STATEACTION_VERIFY,
        dwProvFlags: WTD_CACHE_ONLY_URL_RETRIEVAL,
        ..Default::default()
    };
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    // SAFETY: the UTF-16 path, file info and data remain live throughout both calls;
    // all structure sizes and union tags match the documented file verification contract.
    let result = unsafe {
        WinVerifyTrust(
            std::ptr::null_mut(),
            &mut action,
            (&mut data as *mut WINTRUST_DATA).cast(),
        )
    };
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    // SAFETY: release state allocated by the verify call, even when verification failed.
    unsafe {
        WinVerifyTrust(
            std::ptr::null_mut(),
            &mut action,
            (&mut data as *mut WINTRUST_DATA).cast(),
        );
    }
    if result == 0 {
        Ok(())
    } else {
        Err(format!(
            "Authenticode verification failed (0x{:08x})",
            result as u32
        ))
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn verify_signature(_binary: &Path) -> Result<(), String> {
    Err("External tool signature verification is unsupported on this platform.".into())
}

fn validate_pin(pin: &ToolPin) -> Result<(), InstallError> {
    if pin.sha256 == PIN_PENDING
        || pin.size == 0
        || pin.sha256.len() != 64
        || !pin.sha256.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(InstallError::unsupported(format!(
            "{} {} has no verified download pin yet (PIN_PENDING); installation is unavailable.",
            pin.tool.spec().display_name,
            pin.version
        )));
    }
    for part in [pin.version, pin.binary] {
        if part.is_empty()
            || matches!(part, "." | "..")
            || !part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        {
            return Err(InstallError::unsupported("Invalid external tool pin path."));
        }
    }
    if pin.tool == ToolId::Codex {
        let expected = if pin.platform == ToolPlatform::WindowsX64 {
            "codex.exe"
        } else {
            "codex"
        };
        if pin.archive != ArchiveKind::TarGz
            || pin.binary != expected
            || pin.entry != format!("bin/{expected}")
        {
            return Err(InstallError::unsupported("Invalid Codex package entry."));
        }
    } else if pin.entry.is_empty()
        || !pin
            .entry
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        || matches!(pin.entry, "." | "..")
    {
        return Err(InstallError::unsupported(
            "Invalid external tool pin entry.",
        ));
    }
    Ok(())
}

fn redirect_hosts(pin: &ToolPin) -> Result<&'static [&'static str], InstallError> {
    let url = reqwest::Url::parse(pin.url)
        .map_err(|_| InstallError::unsupported("Invalid tool download URL."))?;
    let expected = match pin.tool {
        ToolId::Claude => "downloads.claude.ai",
        ToolId::Codex => "github.com",
    };
    if url.scheme() != "https"
        || url.host_str() != Some(expected)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err(InstallError::unsupported(
            "The tool download URL is not an approved vendor URL.",
        ));
    }
    Ok(match pin.tool {
        ToolId::Claude => &[],
        ToolId::Codex => &["release-assets.githubusercontent.com"],
    })
}

pub fn install(
    base: &Path,
    pin: &ToolPin,
    parent: &ParentEnv,
    cancel: &AtomicBool,
    signature: &dyn SignatureChecker,
    progress: impl FnMut(ToolInstallProgress),
) -> Result<ManagedTool, InstallError> {
    // Refuse incomplete pins before constructing a client or touching the disk.
    validate_pin(pin)?;
    let client = DownloadClient::new("ChemDraft external-tools", Some(redirect_hosts(pin)?))?;
    install_with_client(base, pin, parent, cancel, signature, progress, &client)
}

pub(crate) fn install_with_client(
    base: &Path,
    pin: &ToolPin,
    parent: &ParentEnv,
    cancel: &AtomicBool,
    signature: &dyn SignatureChecker,
    progress: impl FnMut(ToolInstallProgress),
    client: &DownloadClient,
) -> Result<ManagedTool, InstallError> {
    install_with_download(
        base,
        pin,
        parent,
        cancel,
        signature,
        progress,
        |archive, progress| {
            download_verified(
                client,
                pin.url,
                Some(pin.size),
                pin.sha256,
                archive,
                cancel,
                progress,
            )
        },
    )
}

/// The transaction's download seam also lets filesystem/process tests run without networking.
pub(super) fn install_with_download(
    base: &Path,
    pin: &ToolPin,
    parent: &ParentEnv,
    cancel: &AtomicBool,
    signature: &dyn SignatureChecker,
    mut progress: impl FnMut(ToolInstallProgress),
    download: impl FnOnce(&Path, &mut dyn FnMut(u64, Option<u64>)) -> Result<(), InstallError>,
) -> Result<ManagedTool, InstallError> {
    validate_pin(pin)?;
    check_cancel(cancel)?;
    let mut throttle = ProgressThrottle::new(EMIT_INTERVAL);
    let mut report = |phase, message: &str, done: Option<u64>, total: Option<u64>| {
        if throttle.admit_phase(phase, total.is_some() && done == total, Instant::now()) {
            progress(ToolInstallProgress {
                phase,
                message: message.into(),
                bytes_done: done,
                bytes_total: total,
            });
        }
    };
    report(
        ToolInstallPhase::CheckingDisk,
        "Checking disk space.",
        None,
        None,
    );
    let ops = FileOps::with_prefix("[chemdraft external-tools]", Some(cancel));
    ops.create_dir_all(base).map_err(|e| ops.failed(e))?;
    let free = free_disk_bytes(base).map_err(InstallError::failed)?;
    let needed = pin.size.saturating_mul(4).saturating_add(64 * 1024 * 1024);
    if free < needed {
        return Err(InstallError {
            code: InstallErrorCode::InsufficientDisk,
            message: format!(
                "{} needs {needed} bytes of free disk space; {free} are available.",
                pin.tool.spec().display_name
            ),
        });
    }
    let root = base.join(pin.tool.as_str());
    reject_symlink(&root)?;
    ops.create_dir_all(&root).map_err(|e| ops.failed(e))?;
    sweep(&root, ops)?;
    let partial = root.join(format!("{}.partial", pin.version));
    let final_dir = root.join(pin.version);
    reject_symlink(&final_dir)?;
    ops.create_dir(&partial).map_err(|e| ops.failed(e))?;
    let mut staged = Staged {
        path: partial.clone(),
        committed: false,
    };
    let archive = partial.join("download");
    report(
        ToolInstallPhase::Downloading,
        "Downloading verified tool release.",
        Some(0),
        Some(pin.size),
    );
    download(&archive, &mut |done, total| {
        report(
            ToolInstallPhase::Downloading,
            "Downloading verified tool release.",
            Some(done),
            total,
        );
    })?;
    check_cancel(cancel)?;
    report(
        ToolInstallPhase::Verifying,
        "Verifying tool signature and version.",
        None,
        None,
    );
    let binary = partial.join(binary_name(pin));
    match pin.archive {
        ArchiveKind::Raw => ops.rename(&archive, &binary).map_err(|e| ops.failed(e))?,
        ArchiveKind::TarGz if pin.tool == ToolId::Codex => {
            let helper_name =
                super::probe::codex_helper_name(if pin.platform == ToolPlatform::WindowsX64 {
                    ProbePlatform::Windows
                } else {
                    ProbePlatform::MacOS
                });
            let helper = partial.join(helper_name);
            let helper_entry = format!("bin/{helper_name}");
            extract_tar_entries_with_ops(
                &archive,
                &[(pin.entry, &binary), (&helper_entry, &helper)],
                ops,
            )?;
            make_executable_with_ops(&helper, ops)?;
            super::probe::require_codex_helper(
                &binary,
                if pin.platform == ToolPlatform::WindowsX64 {
                    ProbePlatform::Windows
                } else {
                    ProbePlatform::MacOS
                },
            )
            .map_err(InstallError::failed)?;
            check_cancel(cancel)?;
            signature.verify(&helper).map_err(|detail| {
                InstallError::failed(format!(
                    "Codex code-mode helper signature verification failed: {detail}"
                ))
            })?;
            ops.remove_file(&archive).map_err(|e| ops.failed(e))?;
        }
        ArchiveKind::TarGz | ArchiveKind::Zip | ArchiveKind::ZipTree => {
            let kind = match pin.archive {
                ArchiveKind::TarGz => ExtractKind::TarGz,
                ArchiveKind::Zip => ExtractKind::Zip,
                ArchiveKind::ZipTree => ExtractKind::ZipTree,
                ArchiveKind::Raw => unreachable!(),
            };
            let destination = if pin.archive == ArchiveKind::ZipTree {
                &partial
            } else {
                &binary
            };
            extract_single_entry_with_ops(&archive, kind, pin.entry, destination, ops)?;
            ops.remove_file(&archive).map_err(|e| ops.failed(e))?;
        }
    }
    make_executable_with_ops(&binary, ops)?;
    check_cancel(cancel)?;
    signature.verify(&binary).map_err(|detail| {
        InstallError::failed(format!(
            "{} signature verification failed: {detail}",
            pin.tool.spec().publisher
        ))
    })?;
    check_cancel(cancel)?;
    verify_version(&binary, &partial, pin, parent, cancel)?;
    check_cancel(cancel)?;
    report(
        ToolInstallPhase::Installing,
        "Installing verified tool release.",
        None,
        None,
    );
    let previous = if final_dir.exists() {
        let backup = root.join(format!("{}.discard-{}", pin.version, nonce()));
        ops.rename(&final_dir, &backup).map_err(|e| ops.failed(e))?;
        Some(backup)
    } else {
        None
    };
    let commit = (|| {
        ops.rename(&partial, &final_dir)
            .map_err(|e| ops.failed(e))?;
        staged.path = final_dir.clone();
        check_cancel(cancel)?;
        let receipt = InstallReceipt {
            receipt_version: 1,
            tool: pin.tool,
            version: pin.version.into(),
            platform: pin.platform,
            url: pin.url.into(),
            size: pin.size,
            sha256: pin.sha256.into(),
            installed_at: chrono::Utc::now().to_rfc3339(),
        };
        let bytes =
            serde_json::to_vec_pretty(&receipt).map_err(|e| InstallError::failed(e.to_string()))?;
        let path = final_dir.join(RECEIPT);
        let mut file = ops.create(&path).map_err(|e| ops.failed(e))?;
        ops.write_all(&mut file, &path, &bytes)
            .map_err(|e| ops.failed(e))?;
        ops.sync(&file, &path).map_err(|e| ops.failed(e))?;
        Ok(())
    })();
    if let Err(error) = commit {
        // Cleanup and rollback must still retry on Windows after cancellation.
        let cleanup = FileOps::with_prefix("[chemdraft external-tools rollback]", None);
        if staged.path == final_dir {
            let _ = discard(&final_dir, cleanup);
        }
        if let Some(previous) = previous {
            let _ = cleanup.rename(&previous, &final_dir);
        }
        // Never let the staging guard discard a restored previous installation.
        if staged.path == final_dir {
            staged.committed = true;
        }
        return Err(error);
    }
    staged.committed = true;
    // A valid receipt is already committed. A scanner locking an old binary must not turn a
    // successful install into a failure; rename-first leftovers are swept on the next install.
    let cleanup = FileOps::with_prefix("[chemdraft external-tools retirement]", None);
    if let Some(previous) = previous {
        let _ = discard(&previous, cleanup);
    }
    for entry in fs::read_dir(&root).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.path() != final_dir
            && !name.ends_with(".partial")
            && entry.file_type().is_ok_and(|t| t.is_dir())
        {
            let _ = discard(&entry.path(), cleanup);
        }
    }
    report(ToolInstallPhase::Done, "Tool installed.", None, None);
    Ok(ManagedTool {
        version: pin.version.into(),
        path: final_dir.join(binary_name(pin)),
    })
}

fn verify_version(
    binary: &Path,
    cwd: &Path,
    pin: &ToolPin,
    parent: &ParentEnv,
    cancel: &AtomicBool,
) -> Result<(), InstallError> {
    let run = ToolRun::spawn_with_output_limit(
        RenderedRun {
            program: binary.to_owned(),
            args: vec!["--version".into()],
            env: Vec::new(),
            stdin: None,
        },
        cwd,
        &env::child_env(ProbePlatform::current(), parent, binary, cwd, true),
        Duration::from_secs(20),
        Some(64 * 1024),
    )
    .map_err(InstallError::failed)?;
    let output = match run.capture_output(64 * 1024, || cancel.load(Ordering::SeqCst)) {
        Ok(output) => output,
        Err(CaptureError::Cancelled) => return Err(crate::local_engine::download::cancelled()),
        Err(CaptureError::OutputLimit) => {
            return Err(InstallError::failed(
                "Tool --version exceeded its output limit.",
            ))
        }
    };
    match output.status {
        RunStatus::Exited { code: Some(0), .. }
            if output.stdout.contains(pin.version) || output.stderr.contains(pin.version) =>
        {
            Ok(())
        }
        RunStatus::Exited { .. } => Err(InstallError::failed(format!(
            "{} --version did not report pinned version {}.",
            pin.tool.spec().display_name,
            pin.version
        ))),
        RunStatus::Killed { .. } => Err(InstallError::failed(
            "Tool --version did not finish within 20 seconds.",
        )),
        RunStatus::Failed { message } => Err(InstallError::failed(message)),
        RunStatus::Running => unreachable!("capture_output drains a finished run"),
    }
}

fn reject_symlink(path: &Path) -> Result<(), InstallError> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        Err(InstallError::failed(
            "The managed tool directory must not be a symbolic link.",
        ))
    } else {
        Ok(())
    }
}

fn discard(path: &Path, ops: FileOps<'_>) -> Result<(), InstallError> {
    let target = path.with_file_name(format!(
        "{}.discard-{}",
        path.file_name().unwrap_or_default().to_string_lossy(),
        nonce()
    ));
    ops.rename(path, &target).map_err(|e| ops.failed(e))?;
    remove_entry(&target, ops)
}

fn remove_entry(path: &Path, ops: FileOps<'_>) -> Result<(), InstallError> {
    let metadata = fs::symlink_metadata(path).map_err(|e| ops.failed(e))?;
    #[cfg(windows)]
    let directory_link = {
        use std::os::windows::fs::FileTypeExt;
        metadata.file_type().is_symlink_dir()
    };
    #[cfg(not(windows))]
    let directory_link = false;
    if directory_link {
        return ops
            .run(format!("remove directory link {}", path.display()), || {
                fs::remove_dir(path)
            })
            .map_err(|e| ops.failed(e));
    }
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        ops.remove_dir_all(path).map_err(|e| ops.failed(e))
    } else {
        ops.remove_file(path).map_err(|e| ops.failed(e))
    }
}

fn sweep(root: &Path, ops: FileOps<'_>) -> Result<(), InstallError> {
    for entry in ops
        .run(format!("read directory {}", root.display()), || {
            fs::read_dir(root)
        })
        .map_err(|e| ops.failed(e))?
    {
        let entry = entry.map_err(|e| ops.failed(e))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".partial") || name.contains(".discard-") {
            remove_entry(&entry.path(), ops)?;
        }
    }
    Ok(())
}

struct Staged {
    path: PathBuf,
    committed: bool,
}
impl Drop for Staged {
    fn drop(&mut self) {
        if !self.committed {
            let _ = discard(
                &self.path,
                FileOps::with_prefix("[chemdraft external-tools cleanup]", None),
            );
        }
    }
}

/// Status checks the receipt and executable metadata; it deliberately does not rehash binaries.
pub fn managed_status(base: &Path, pin: &ToolPin) -> ExternalToolStatus {
    let root = base.join(pin.tool.as_str()).join(pin.version);
    let path = root.join(binary_name(pin));
    let mut status = ExternalToolStatus {
        tool: pin.tool,
        publisher: pin.tool.spec().publisher.into(),
        state: ToolState::Missing,
        source: None,
        path: None,
        version: None,
        pinned_version: pin.version.into(),
        pinned_download_bytes: pin.size,
        free_disk_bytes: base
            .ancestors()
            .find(|p| p.is_dir())
            .and_then(|p| free_disk_bytes(p).ok()),
        managed: None,
        signed_in: None,
        auth_method: None,
        detail: None,
        progress: None,
        can_install: validate_pin(pin).is_ok(),
        consented: false,
        probed_at: chrono::Utc::now().to_rfc3339(),
    };
    if !root.exists() {
        return status;
    }
    let check = (|| -> Result<(), String> {
        reject_symlink(&root).map_err(|e| e.message)?;
        let bytes = fs::read(root.join(RECEIPT))
            .map_err(|_| "The managed tool install receipt is missing or unreadable.".to_owned())?;
        let receipt: InstallReceipt = serde_json::from_slice(&bytes)
            .map_err(|_| "The managed tool install receipt is invalid.".to_owned())?;
        if !receipt.matches(pin) {
            return Err("The managed tool receipt does not match the pinned release.".into());
        }
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| "The managed tool executable is missing.".to_owned())?;
        if !metadata.is_file() {
            return Err("The managed tool executable is not a regular file.".into());
        }
        if pin.tool == ToolId::Codex {
            super::probe::require_codex_helper(
                &path,
                if pin.platform == ToolPlatform::WindowsX64 {
                    ProbePlatform::Windows
                } else {
                    ProbePlatform::MacOS
                },
            )?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o111 == 0 {
                return Err("The managed tool binary is not executable.".into());
            }
        }
        #[cfg(not(unix))]
        let _ = metadata;
        if pin.platform == ToolPlatform::WindowsX64
            && !path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("exe"))
        {
            return Err("The managed tool binary is not an executable (.exe).".into());
        }
        Ok(())
    })();
    status.source = Some(ToolSource::Managed);
    status.path = Some(path.clone());
    match check {
        Ok(()) => {
            status.state = ToolState::Installed;
            status.version = Some(pin.version.into());
            status.managed = Some(ManagedTool {
                version: pin.version.into(),
                path,
            });
        }
        Err(detail) => {
            status.state = ToolState::Broken;
            status.detail = Some(detail);
        }
    }
    status
}

#[cfg(test)]
mod url_tests {
    use super::*;

    #[test]
    fn redirect_hosts_rejects_unapproved_vendor_urls() {
        for tool in [ToolId::Claude, ToolId::Codex] {
            let mut pin = super::super::pins::pin_for(tool, ToolPlatform::DarwinArm64).clone();
            let expected: &[&str] = if tool == ToolId::Claude {
                &[]
            } else {
                &["release-assets.githubusercontent.com"]
            };
            assert_eq!(redirect_hosts(&pin).unwrap(), expected);
            for url in [
                "http://downloads.claude.ai/tool",
                "http://github.com/tool",
                "https://user@downloads.claude.ai/tool",
                "https://user:pass@github.com/tool",
                "https://downloads.claude.ai.evil.example/tool",
                "https://github.com.evil.example/tool",
                "https://downloads.claude.ai:8443/tool",
                "https://github.com:8443/tool",
                "https://evil.example/tool",
                "file:///tool",
                "not a URL",
            ] {
                pin.url = url;
                assert!(redirect_hosts(&pin).is_err(), "accepted {url} for {tool:?}");
            }
        }
    }
}
