//! Loopback transaction tests; signature verification is injected, never bypassed in production.
use super::{
    catalog::ToolId, env::ParentEnv, install::*, nonce, pins::*, ToolInstallPhase, ToolState,
};
use crate::local_engine::{
    download::{download_verified, DownloadClient},
    InstallErrorCode,
};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    net::TcpListener,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("chemdraft-tool-install-{}", nonce()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn stub() -> &'static [u8] {
    static STUB: OnceLock<Vec<u8>> = OnceLock::new();
    STUB.get_or_init(|| {
        let temp = Temp::new();
        let source = temp.0.join("stub.rs");
        let binary = temp.0.join(if cfg!(windows) { "stub.exe" } else { "stub" });
        fs::write(
            &source,
            r#"fn main() {
            assert_eq!(std::env::args().nth(1).as_deref(), Some("--version"));
            assert_eq!(std::env::var("DISABLE_UPDATES").as_deref(), Ok("1"));
            assert_eq!(std::env::var("TERM").as_deref(), Ok("dumb"));
            assert!(std::env::var("CHEMDRAFT_INSTALL_UNTRUSTED").is_err());
            println!("2.1.308 (tool install fixture)");
        }"#,
        )
        .unwrap();
        let output = Command::new("rustc")
            .args(["--crate-name", "tool_install_stub", "--edition=2021"])
            .arg(&source)
            .arg("-o")
            .arg(&binary)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        fs::read(binary).unwrap()
    })
}

struct Signature(bool);
impl SignatureChecker for Signature {
    fn verify(&self, binary: &Path) -> Result<(), String> {
        assert!(binary.is_file());
        assert!(binary
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .ends_with(".partial"));
        assert!(!binary.parent().unwrap().join("install.json").exists());
        if self.0 {
            Ok(())
        } else {
            Err("fixture signature rejected".into())
        }
    }
}
fn leak(value: String) -> &'static str {
    Box::leak(value.into_boxed_str())
}
fn pin(body: &[u8], archive: ArchiveKind, url: &str) -> ToolPin {
    ToolPin {
        tool: ToolId::Claude,
        platform: if cfg!(windows) {
            ToolPlatform::WindowsX64
        } else {
            ToolPlatform::DarwinArm64
        },
        version: "2.1.308",
        url: leak(url.into()),
        size: body.len() as u64,
        sha256: leak(format!("{:x}", Sha256::digest(body))),
        archive,
        entry: "vendor-tool",
        binary: if cfg!(windows) {
            "claude.exe"
        } else {
            "claude"
        },
    }
}
fn client() -> DownloadClient {
    DownloadClient::from_builder(
        reqwest::blocking::Client::builder().no_proxy(),
        "ChemDraft test",
        Some(&[]),
    )
    .unwrap()
}
fn serve_response(response: Vec<u8>) -> (String, thread::JoinHandle<()>) {
    serve_response_after(response, Duration::ZERO)
}
fn serve_response_after(response: Vec<u8>, delay: Duration) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/asset", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let server = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match listener.accept() {
                Ok((stream, _)) => {
                    thread::sleep(delay);
                    crate::network_test_http::reply(stream, &response);
                    return;
                }
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        && Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(5))
                }
                Err(error) => panic!("loopback accept failed: {error}"),
            }
        }
    });
    (url, server)
}
fn serve(body: &[u8], length: bool) -> (String, thread::JoinHandle<()>) {
    let mut response = b"HTTP/1.1 200 OK\r\nConnection: close\r\n".to_vec();
    if length {
        response.extend(format!("Content-Length: {}\r\n", body.len()).as_bytes());
    }
    response.extend(b"\r\n");
    response.extend(body);
    serve_response(response)
}

fn tar_gz(body: &[u8]) -> Vec<u8> {
    let name = "release/vendor-tool";
    let mut header = [0u8; 512];
    header[..name.len()].copy_from_slice(name.as_bytes());
    header[100..107].copy_from_slice(b"0000755");
    header[124..135].copy_from_slice(format!("{:011o}", body.len()).as_bytes());
    header[156] = b'0';
    header[148..156].fill(b' ');
    let checksum: u32 = header.iter().map(|b| u32::from(*b)).sum();
    header[148..155].copy_from_slice(format!("{checksum:06o}\0").as_bytes());
    let mut tar = header.to_vec();
    tar.extend(body);
    tar.resize(tar.len().div_ceil(512) * 512 + 1024, 0);
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(&tar).unwrap();
    encoder.finish().unwrap()
}

fn zip(body: &[u8], deflate: bool) -> Vec<u8> {
    let name = b"release/vendor-tool";
    let data = if deflate {
        let mut encoder =
            flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(body).unwrap();
        encoder.finish().unwrap()
    } else {
        body.to_vec()
    };
    let method: u16 = if deflate { 8 } else { 0 };
    let mut zip = b"PK\x03\x04".to_vec();
    zip.extend([20, 0, 0, 0]);
    zip.extend(method.to_le_bytes());
    zip.extend([0u8; 8]);
    zip.extend((data.len() as u32).to_le_bytes());
    zip.extend((body.len() as u32).to_le_bytes());
    zip.extend((name.len() as u16).to_le_bytes());
    zip.extend(0u16.to_le_bytes());
    zip.extend(name);
    zip.extend(&data);
    let central = zip.len();
    zip.extend(b"PK\x01\x02");
    zip.extend([20, 0, 20, 0, 0, 0]);
    zip.extend(method.to_le_bytes());
    zip.extend([0u8; 8]);
    zip.extend((data.len() as u32).to_le_bytes());
    zip.extend((body.len() as u32).to_le_bytes());
    zip.extend((name.len() as u16).to_le_bytes());
    zip.extend([0u8; 12]);
    zip.extend(0u32.to_le_bytes());
    zip.extend(name);
    let central_size = zip.len() - central;
    zip.extend(b"PK\x05\x06");
    zip.extend([0u8; 4]);
    zip.extend(1u16.to_le_bytes());
    zip.extend(1u16.to_le_bytes());
    zip.extend((central_size as u32).to_le_bytes());
    zip.extend((central as u32).to_le_bytes());
    zip.extend(0u16.to_le_bytes());
    zip
}

fn assert_clean(base: &Path) {
    assert_eq!(
        fs::read_dir(base.join("claude")).unwrap().count(),
        0,
        "failed installation left staging/final files"
    );
}

#[test]
fn raw_tar_and_zip_install_commit_receipt_and_retire_old_versions() {
    for (kind, body) in [
        (ArchiveKind::Raw, stub().to_vec()),
        (ArchiveKind::TarGz, tar_gz(stub())),
        (ArchiveKind::Zip, zip(stub(), false)),
        (ArchiveKind::Zip, zip(stub(), true)),
    ] {
        let base = Temp::new();
        let root = base.0.join("claude");
        for name in ["1.0.0", "2.0.0.partial", "2.0.1.discard-stale"] {
            fs::create_dir_all(root.join(name)).unwrap();
            fs::write(root.join(name).join("old"), b"old").unwrap();
        }
        let (url, server) = serve(&body, true);
        let pin = pin(&body, kind, &url);
        let cancel = AtomicBool::new(false);
        let mut phases = Vec::new();
        let parent = ParentEnv::from([(
            "CHEMDRAFT_INSTALL_UNTRUSTED".into(),
            "must be scrubbed".into(),
        )]);
        let result = install_with_client(
            &base.0,
            &pin,
            &parent,
            &cancel,
            &Signature(true),
            |p| {
                phases.push(p.phase);
                if p.phase == ToolInstallPhase::Installing {
                    assert!(!root.join(pin.version).join("install.json").exists());
                }
            },
            &client(),
        )
        .unwrap();
        server.join().unwrap();
        assert_eq!(fs::read(&result.path).unwrap(), stub());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        let receipt: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join(pin.version).join("install.json")).unwrap())
                .unwrap();
        assert_eq!(receipt["receiptVersion"], 1);
        assert_eq!(receipt["sha256"], pin.sha256);
        assert_eq!(receipt["tool"], "claude");
        assert_eq!(receipt["size"], pin.size);
        assert_eq!(phases.first(), Some(&ToolInstallPhase::CheckingDisk));
        assert_eq!(phases.last(), Some(&ToolInstallPhase::Done));
        for phase in [
            ToolInstallPhase::Downloading,
            ToolInstallPhase::Verifying,
            ToolInstallPhase::Installing,
        ] {
            assert!(phases.contains(&phase));
        }
        assert!(matches!(
            managed_status(&base.0, &pin).state,
            ToolState::Installed
        ));
        // Status uses executable metadata rather than rehashing on every poll.
        fs::write(&result.path, b"changed since installation").unwrap();
        assert!(matches!(
            managed_status(&base.0, &pin).state,
            ToolState::Installed
        ));
        fs::remove_file(&result.path).unwrap();
        assert!(managed_status(&base.0, &pin)
            .detail
            .unwrap()
            .contains("missing"));
    }
}

#[test]
fn tampering_signature_failure_and_version_mismatch_discard_staging() {
    for failure in ["checksum", "signature", "version"] {
        let base = Temp::new();
        let mut body = stub().to_vec();
        let mut pinned = pin(&body, ArchiveKind::Raw, "unused");
        if failure == "checksum" {
            body[0] ^= 1;
        }
        if failure == "version" {
            pinned.version = "9.9.999";
        }
        let (url, server) = serve(&body, true);
        pinned.url = leak(url);
        let error = install_with_client(
            &base.0,
            &pinned,
            &ParentEnv::new(),
            &AtomicBool::new(false),
            &Signature(failure != "signature"),
            |_| {},
            &client(),
        )
        .unwrap_err();
        server.join().unwrap();
        assert_eq!(
            error.code,
            if failure == "checksum" {
                InstallErrorCode::ChecksumMismatch
            } else {
                InstallErrorCode::Failed
            }
        );
        if failure == "signature" {
            assert!(error.message.contains("Anthropic"));
        }
        if failure == "version" {
            assert!(error.message.contains("9.9.999"));
        }
        assert_clean(&base.0);
    }
}

#[test]
fn oversize_stream_is_cut_off_without_writing_excess() {
    let temp = Temp::new();
    let (url, server) = serve(&[b'x'; 8192], false);
    let dest = temp.0.join("download");
    let error = download_verified(
        &client(),
        &url,
        Some(100),
        &"0".repeat(64),
        &dest,
        &AtomicBool::new(false),
        |_, _| {},
    )
    .unwrap_err();
    server.join().unwrap();
    assert_eq!(error.code, InstallErrorCode::ChecksumMismatch);
    assert!(fs::metadata(dest).unwrap().len() <= 100);

    let (url, server) = serve(&[b'x'; 8192], false);
    let mut pin = pin(&[b'x'; 100], ArchiveKind::Raw, &url);
    pin.size = 100;
    let error = install_with_client(
        &temp.0,
        &pin,
        &ParentEnv::new(),
        &AtomicBool::new(false),
        &Signature(true),
        |_| {},
        &client(),
    )
    .unwrap_err();
    server.join().unwrap();
    assert_eq!(error.code, InstallErrorCode::ChecksumMismatch);
    assert_clean(&temp.0);
}

#[test]
fn cancellation_during_download_sweeps_partial() {
    let temp = Temp::new();
    // One MiB produces an intermediate progress event before the body is exhausted.
    let body = vec![b'x'; 1024 * 1024 + 128 * 1024];
    let mut response = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    response.extend(&body);
    // Let the 250 ms progress throttle become due before the first MiB arrives.
    let (url, server) = serve_response_after(response, Duration::from_millis(350));
    let pin = pin(&body, ArchiveKind::Raw, &url);
    let cancel = AtomicBool::new(false);
    let error = install_with_client(
        &temp.0,
        &pin,
        &ParentEnv::new(),
        &cancel,
        &Signature(true),
        |p| {
            if p.phase == ToolInstallPhase::Downloading && p.bytes_done.is_some_and(|n| n > 0) {
                assert!(
                    p.bytes_done < p.bytes_total,
                    "must cancel before the full transfer completes"
                );
                cancel.store(true, Ordering::SeqCst);
            }
        },
        &client(),
    )
    .unwrap_err();
    server.join().unwrap();
    assert_eq!(error.code, InstallErrorCode::Cancelled);
    assert_clean(&temp.0);
}

#[test]
fn pending_pins_refuse_without_touching_disk_or_http() {
    let base = Temp::new();
    let mut pin = pin(
        b"unused",
        ArchiveKind::Raw,
        "http://127.0.0.1:1/must-not-connect",
    );
    pin.sha256 = PIN_PENDING;
    let error = install(
        &base.0,
        &pin,
        &ParentEnv::new(),
        &AtomicBool::new(false),
        &Signature(true),
        |_| panic!("pending pin progressed"),
    )
    .unwrap_err();
    assert_eq!(error.code, InstallErrorCode::Unsupported);
    assert!(error.message.contains("PIN_PENDING"));
    assert_eq!(fs::read_dir(&base.0).unwrap().count(), 0);
}

#[test]
fn redirect_to_unapproved_host_is_refused() {
    let temp = Temp::new();
    let (url, server) = serve_response(b"HTTP/1.1 302 Found\r\nLocation: https://example.invalid/tool\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec());
    let pin = pin(b"test", ArchiveKind::Raw, &url);
    let error = install_with_client(
        &temp.0,
        &pin,
        &ParentEnv::new(),
        &AtomicBool::new(false),
        &Signature(true),
        |_| {},
        &client(),
    )
    .unwrap_err();
    server.join().unwrap();
    assert_eq!(error.code, InstallErrorCode::Network);
    assert_clean(&temp.0);
}

#[test]
fn invalid_receipts_and_non_executable_binaries_are_broken() {
    let temp = Temp::new();
    let pin = pin(
        b"fixture",
        ArchiveKind::Raw,
        "https://downloads.claude.ai/fixture",
    );
    assert!(matches!(
        managed_status(&temp.0, &pin).state,
        ToolState::Missing
    ));
    let root = temp.0.join("claude").join(pin.version);
    fs::create_dir_all(&root).unwrap();
    assert!(managed_status(&temp.0, &pin)
        .detail
        .unwrap()
        .contains("receipt"));
    let receipt = serde_json::json!({"receiptVersion":1,"tool":"claude","version":pin.version,"platform":pin.platform,
        "url":pin.url,"size":pin.size,"sha256":pin.sha256,"installedAt":chrono::Utc::now().to_rfc3339()});
    fs::write(
        root.join("install.json"),
        serde_json::to_vec(&receipt).unwrap(),
    )
    .unwrap();
    fs::write(root.join(pin.binary), b"fixture").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root.join(pin.binary), fs::Permissions::from_mode(0o644)).unwrap();
        assert!(managed_status(&temp.0, &pin)
            .detail
            .unwrap()
            .contains("not executable"));
    }
    let mut wrong = receipt.clone();
    wrong["sha256"] = serde_json::json!("wrong");
    fs::write(
        root.join("install.json"),
        serde_json::to_vec(&wrong).unwrap(),
    )
    .unwrap();
    assert!(managed_status(&temp.0, &pin)
        .detail
        .unwrap()
        .contains("does not match"));
    fs::write(root.join("install.json"), b"invalid JSON").unwrap();
    assert!(managed_status(&temp.0, &pin)
        .detail
        .unwrap()
        .contains("invalid"));
}

/// Runs the same transaction as the HTTP cases with only the transfer replaced. This also
/// exercises the executable fixture and commit/rollback on hosts that prohibit loopback binds.
#[test]
fn filesystem_transaction_formats_reinstall_and_failures() {
    for (kind, body) in [
        (ArchiveKind::Raw, stub().to_vec()),
        (ArchiveKind::TarGz, tar_gz(stub())),
        (ArchiveKind::Zip, zip(stub(), false)),
        (ArchiveKind::Zip, zip(stub(), true)),
    ] {
        let base = Temp::new();
        let pin = pin(&body, kind, "https://downloads.claude.ai/fixture");
        let root = base.0.join("claude");
        for name in ["1.0.0", "1.1.0.partial", "1.2.0.discard-stale"] {
            fs::create_dir_all(root.join(name)).unwrap();
        }
        let parent: ParentEnv = std::env::vars().collect();
        let mut phases = Vec::new();
        let result = install_with_download(
            &base.0,
            &pin,
            &parent,
            &AtomicBool::new(false),
            &Signature(true),
            |p| phases.push(p.phase),
            |path, progress| {
                fs::write(path, &body).unwrap();
                progress(body.len() as u64, Some(body.len() as u64));
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(fs::read(&result.path).unwrap(), stub());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        assert_eq!(phases.first(), Some(&ToolInstallPhase::CheckingDisk));
        assert_eq!(phases.last(), Some(&ToolInstallPhase::Done));
        assert!(matches!(
            managed_status(&base.0, &pin).state,
            ToolState::Installed
        ));

        // Version and signature failure preserve the already committed version.
        let mut wrong_version = pin.clone();
        wrong_version.version = "9.9.999";
        for (candidate, signature) in [(&wrong_version, Signature(true)), (&pin, Signature(false))]
        {
            let error = install_with_download(
                &base.0,
                candidate,
                &parent,
                &AtomicBool::new(false),
                &signature,
                |_| {},
                |path, _| {
                    fs::write(path, &body).unwrap();
                    Ok(())
                },
            )
            .unwrap_err();
            assert_eq!(error.code, InstallErrorCode::Failed);
            assert_eq!(fs::read(&result.path).unwrap(), stub());
            assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        }

        // A same-version reinstall atomically replaces the old copy and retires its backup.
        install_with_download(
            &base.0,
            &pin,
            &parent,
            &AtomicBool::new(false),
            &Signature(true),
            |_| {},
            |path, _| {
                fs::write(path, &body).unwrap();
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        assert!(matches!(
            managed_status(&base.0, &pin).state,
            ToolState::Installed
        ));
    }
}

#[test]
fn filesystem_transaction_cancel_and_failed_receipt_restore_old_copy() {
    let base = Temp::new();
    let pin = pin(
        stub(),
        ArchiveKind::Raw,
        "https://downloads.claude.ai/fixture",
    );
    let root = base.0.join("claude");
    let parent: ParentEnv = std::env::vars().collect();
    for phase in [
        ToolInstallPhase::Downloading,
        ToolInstallPhase::Verifying,
        ToolInstallPhase::Installing,
    ] {
        let cancel = AtomicBool::new(false);
        let error = install_with_download(
            &base.0,
            &pin,
            &parent,
            &cancel,
            &Signature(true),
            |p| {
                if p.phase == phase {
                    cancel.store(true, Ordering::SeqCst);
                }
            },
            |path, _| {
                fs::write(path, stub()).unwrap();
                Ok(())
            },
        )
        .unwrap_err();
        assert_eq!(error.code, InstallErrorCode::Cancelled);
        assert_clean(&base.0);
    }
    install_with_download(
        &base.0,
        &pin,
        &parent,
        &AtomicBool::new(false),
        &Signature(true),
        |_| {},
        |path, _| {
            fs::write(path, stub()).unwrap();
            Ok(())
        },
    )
    .unwrap();
    let original_receipt = fs::read(root.join(pin.version).join("install.json")).unwrap();
    // Sabotage only the receipt path in staging: commit must roll back to the previous copy.
    let error = install_with_download(
        &base.0,
        &pin,
        &parent,
        &AtomicBool::new(false),
        &Signature(true),
        |p| {
            if p.phase == ToolInstallPhase::Installing {
                fs::create_dir(
                    root.join(format!("{}.partial", pin.version))
                        .join("install.json"),
                )
                .unwrap();
            }
        },
        |path, _| {
            fs::write(path, stub()).unwrap();
            Ok(())
        },
    )
    .unwrap_err();
    assert_eq!(error.code, InstallErrorCode::Failed);
    assert_eq!(
        fs::read(root.join(pin.version).join("install.json")).unwrap(),
        original_receipt
    );
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    assert!(matches!(
        managed_status(&base.0, &pin).state,
        ToolState::Installed
    ));
}

#[test]
fn insufficient_disk_refuses_before_sweep_or_download() {
    let base = Temp::new();
    let stale = base.0.join("claude").join("1.0.0.partial");
    fs::create_dir_all(&stale).unwrap();
    let mut pin = pin(
        b"fixture",
        ArchiveKind::Raw,
        "https://downloads.claude.ai/fixture",
    );
    pin.size = u64::MAX;
    let error = install_with_download(
        &base.0,
        &pin,
        &ParentEnv::new(),
        &AtomicBool::new(false),
        &Signature(true),
        |_| {},
        |_, _| panic!("disk check must precede transfer"),
    )
    .unwrap_err();
    assert_eq!(error.code, InstallErrorCode::InsufficientDisk);
    assert!(stale.exists(), "disk check must precede stale sweep");
}

/// Set CHEMDRAFT_REAL_ARCHIVE_DIR to downloaded, checksum-verified vendor assets.
#[test]
#[ignore]
fn real_vendor_archives_extract() {
    use crate::local_engine::{
        file_ops::FileOps,
        install::{extract_single_entry_with_ops, ArchiveKind as ExtractKind},
    };
    let Some(directory) = std::env::var_os("CHEMDRAFT_REAL_ARCHIVE_DIR") else {
        return;
    };
    let temp = Temp::new();
    let mut tested = 0;
    for entry in fs::read_dir(directory).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name().to_string_lossy().into_owned();
        let (binary, kind) = if let Some(binary) = name.strip_suffix(".tar.gz") {
            (binary, ExtractKind::TarGz)
        } else if let Some(binary) = name.strip_suffix(".zip") {
            (binary, ExtractKind::ZipTree)
        } else {
            continue;
        };
        let output = temp.0.join(format!("archive-{tested}"));
        fs::create_dir(&output).unwrap();
        let destination = match kind {
            ExtractKind::TarGz => output.join(binary),
            _ => output.clone(),
        };
        extract_single_entry_with_ops(
            &entry.path(),
            kind,
            binary,
            &destination,
            FileOps::with_prefix("[real vendor archive test]", None),
        )
        .unwrap_or_else(|error| panic!("{name}: {}", error.message));
        let main = output.join(binary);
        let metadata = fs::symlink_metadata(&main).unwrap();
        assert!(
            metadata.file_type().is_file() && metadata.len() > 0,
            "{name}"
        );
        if name.ends_with(".tar.gz") {
            assert_eq!(fs::read_dir(&output).unwrap().count(), 1, "{name}");
        } else {
            assert!(
                output
                    .join("codex-resources/codex-command-runner.exe")
                    .is_file(),
                "{name}"
            );
        }
        tested += 1;
    }
    assert!(
        tested > 0,
        "CHEMDRAFT_REAL_ARCHIVE_DIR contained no vendor archives"
    );
}

#[test]
fn windows_codex_tree_install_preserves_packaged_binary_resources_and_status() {
    let base = Temp::new();
    let main = "codex-x86_64-pc-windows-msvc.exe";
    let body = crate::local_engine::archive_tests::descriptor_zip(&[
        (main, stub(), 0o100755),
        (
            "codex-package.json",
            b"{\"binary\":\"codex-x86_64-pc-windows-msvc.exe\"}",
            0o100644,
        ),
        (
            "codex-resources/codex-command-runner.exe",
            b"helper",
            0o100755,
        ),
    ]);
    let mut pinned = pin(
        &body,
        ArchiveKind::ZipTree,
        "https://github.com/openai/codex/fixture",
    );
    pinned.tool = ToolId::Codex;
    pinned.platform = ToolPlatform::WindowsX64;
    pinned.entry = main;
    pinned.binary = main;
    let result = install_with_download(
        &base.0,
        &pinned,
        &std::env::vars().collect(),
        &AtomicBool::new(false),
        &Signature(true),
        |_| {},
        |path, _| {
            fs::write(path, &body).unwrap();
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(result.path.file_name().unwrap(), main);
    let root = result.path.parent().unwrap();
    assert!(!root.join("codex.exe").exists());
    assert_eq!(
        fs::read(root.join("codex-resources/codex-command-runner.exe")).unwrap(),
        b"helper"
    );
    assert!(root.join("codex-package.json").is_file());
    let status = managed_status(&base.0, &pinned);
    assert!(matches!(status.state, ToolState::Installed));
    assert_eq!(status.path, Some(result.path));
}
