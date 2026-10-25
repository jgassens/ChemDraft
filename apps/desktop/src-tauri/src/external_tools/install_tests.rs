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
        super::test_support::register(&path);
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

fn codex_probe_stub() -> &'static [u8] {
    static STUB: OnceLock<Vec<u8>> = OnceLock::new();
    STUB.get_or_init(|| {
        let temp = Temp::new();
        let source = temp.0.join("codex_probe.rs");
        let binary = temp.0.join(if cfg!(windows) { "stub.exe" } else { "stub" });
        fs::write(
            &source,
            r#"fn main() {
            match std::env::args().nth(1).as_deref() {
                Some("--version") => println!("codex-cli 0.163.0"),
                Some("login") => eprintln!("Logged in using ChatGPT"),
                _ => panic!("unexpected fixture arguments"),
            }
        }"#,
        )
        .unwrap();
        let output = Command::new("rustc")
            .args(["--crate-name", "codex_probe_stub", "--edition=2021"])
            .arg(source)
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
        .contains("older ChemDraft version"));
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
        .contains("older ChemDraft version"));
    fs::write(root.join("install.json"), b"invalid JSON").unwrap();
    assert!(managed_status(&temp.0, &pin)
        .detail
        .unwrap()
        .contains("older ChemDraft version"));
}

fn status_fixture(base: &Path, pin: &ToolPin) -> PathBuf {
    let root = base.join(pin.tool.as_str()).join(pin.version);
    fs::create_dir_all(&root).unwrap();
    let receipt = serde_json::json!({"receiptVersion":1,"tool":pin.tool,"version":pin.version,"platform":pin.platform,
        "url":pin.url,"size":pin.size,"sha256":pin.sha256,"installedAt":chrono::Utc::now().to_rfc3339()});
    fs::write(
        root.join("install.json"),
        serde_json::to_vec(&receipt).unwrap(),
    )
    .unwrap();
    let binary = root.join(pin.binary);
    let mut paths = vec![binary.clone()];
    if pin.tool == ToolId::Codex {
        paths.push(root.join(if pin.platform == ToolPlatform::WindowsX64 {
            "codex-code-mode-host.exe"
        } else {
            "codex-code-mode-host"
        }));
    }
    for path in paths {
        fs::write(&path, b"status fixture; never executed").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        #[cfg(not(unix))]
        let _ = path;
    }
    binary
}

#[test]
fn managed_status_accepts_each_pin_platform_on_any_host() {
    for pin in &PINS {
        let base = Temp::new();
        status_fixture(&base.0, pin);
        let status = managed_status(&base.0, pin);
        assert!(
            matches!(status.state, ToolState::Installed),
            "{:?} {:?}: {:?}",
            pin.tool,
            pin.platform,
            status.detail
        );
    }
}

#[test]
fn managed_status_windows_pins_require_case_insensitive_exe_extension() {
    for pin in PINS
        .iter()
        .filter(|p| p.platform == ToolPlatform::WindowsX64)
    {
        for (name, installed) in [
            ("tool.exe", true),
            ("tool.EXE", true),
            ("tool", false),
            ("tool.cmd", false),
        ] {
            let base = Temp::new();
            let mut pin = pin.clone();
            pin.binary = name;
            status_fixture(&base.0, &pin);
            let status = managed_status(&base.0, &pin);
            if installed {
                assert!(
                    matches!(status.state, ToolState::Installed),
                    "{name}: {:?}",
                    status.detail
                );
            } else {
                assert!(matches!(status.state, ToolState::Broken));
                assert_eq!(
                    status.detail.as_deref(),
                    Some("The managed tool binary is not an executable (.exe).")
                );
            }
        }
    }
}

#[test]
fn managed_status_darwin_pins_preserve_unix_execute_permission_check() {
    for pin in PINS
        .iter()
        .filter(|p| p.platform != ToolPlatform::WindowsX64)
    {
        let base = Temp::new();
        let binary = status_fixture(&base.0, pin);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for (mode, installed) in [(0o644, false), (0o100, true), (0o010, true), (0o001, true)] {
                fs::set_permissions(&binary, fs::Permissions::from_mode(mode)).unwrap();
                let status = managed_status(&base.0, pin);
                if installed {
                    assert!(
                        matches!(status.state, ToolState::Installed),
                        "{mode:o}: {:?}",
                        status.detail
                    );
                } else {
                    assert!(matches!(status.state, ToolState::Broken));
                    assert_eq!(
                        status.detail.as_deref(),
                        Some("The managed tool binary is not executable.")
                    );
                }
            }
        }
        #[cfg(not(unix))]
        {
            let _ = binary;
            assert!(matches!(
                managed_status(&base.0, pin).state,
                ToolState::Installed
            ));
        }
    }
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
        let parent = super::test_support::fake_parent(&base.0);
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
    let parent = super::test_support::fake_parent(&base.0);
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
    use crate::local_engine::{file_ops::FileOps, install::extract_tar_entries_with_ops};
    let Some(directory) = std::env::var_os("CHEMDRAFT_REAL_ARCHIVE_DIR") else {
        return;
    };
    let temp = Temp::new();
    let mut tested = 0;
    for pin in PINS.iter().filter(|p| p.tool == ToolId::Codex) {
        let name = pin.url.rsplit('/').next().unwrap();
        let archive = Path::new(&directory).join(name);
        if !archive.is_file() {
            continue;
        }
        let bytes = fs::read(&archive).unwrap();
        assert_eq!(bytes.len() as u64, pin.size);
        assert_eq!(format!("{:x}", Sha256::digest(&bytes)), pin.sha256);
        let output = temp.0.join(format!("archive-{tested}"));
        fs::create_dir(&output).unwrap();
        let helper = if pin.platform == ToolPlatform::WindowsX64 {
            "codex-code-mode-host.exe"
        } else {
            "codex-code-mode-host"
        };
        extract_tar_entries_with_ops(
            &archive,
            &[
                (pin.entry, &output.join(pin.binary)),
                (&format!("bin/{helper}"), &output.join(helper)),
            ],
            FileOps::with_prefix("[real package test]", None),
        )
        .unwrap();
        assert_eq!(fs::read_dir(&output).unwrap().count(), 2);
        for path in [output.join(pin.binary), output.join(helper)] {
            assert!(fs::metadata(path).unwrap().len() > 0);
        }
        tested += 1;
    }
    assert!(tested > 0, "No pinned Codex packages found");
}

fn package_tar(entries: &[(&str, &[u8], u8)]) -> Vec<u8> {
    let mut tar = Vec::new();
    for (name, body, kind) in entries {
        let mut header = [0u8; 512];
        header[..name.len()].copy_from_slice(name.as_bytes());
        header[100..107].copy_from_slice(b"0000755");
        header[124..135].copy_from_slice(format!("{:011o}", body.len()).as_bytes());
        header[156] = *kind;
        header[148..156].fill(b' ');
        let sum: u32 = header.iter().map(|b| u32::from(*b)).sum();
        header[148..155].copy_from_slice(format!("{sum:06o}\0").as_bytes());
        tar.extend(header);
        tar.extend(*body);
        tar.resize(tar.len().div_ceil(512) * 512, 0);
    }
    tar.resize(tar.len() + 1024, 0);
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(&tar).unwrap();
    encoder.finish().unwrap()
}

#[test]
fn codex_package_installs_only_two_binaries_and_requires_both_signatures() {
    for platform in [
        ToolPlatform::DarwinArm64,
        ToolPlatform::DarwinX64,
        ToolPlatform::WindowsX64,
    ] {
        for fail_helper in [false, true] {
            let base = Temp::new();
            let main = if platform == ToolPlatform::WindowsX64 {
                "codex.exe"
            } else {
                "codex"
            };
            let helper = if platform == ToolPlatform::WindowsX64 {
                "codex-code-mode-host.exe"
            } else {
                "codex-code-mode-host"
            };
            let body = package_tar(&[
                ("././@PaxHeader", b"22 mtime=1792097863.0\n", b'x'),
                (&format!("bin/{main}"), stub(), b'0'),
                (&format!("bin/{helper}"), stub(), b'0'),
                ("codex-package.json", b"{}", b'0'),
                ("codex-path/rg", b"not installed", b'0'),
                ("codex-resources/voice/unused", b"not installed", b'0'),
            ]);
            let mut pinned = pin(
                &body,
                ArchiveKind::TarGz,
                "https://github.com/openai/codex/fixture",
            );
            pinned.tool = ToolId::Codex;
            pinned.platform = platform;
            pinned.entry = leak(format!("bin/{main}"));
            pinned.binary = main;
            struct Signatures {
                paths: std::sync::Mutex<Vec<PathBuf>>,
                fail_helper: bool,
            }
            impl SignatureChecker for Signatures {
                fn verify(&self, binary: &Path) -> Result<(), String> {
                    self.paths.lock().unwrap().push(binary.to_owned());
                    if self.fail_helper
                        && binary
                            .file_name()
                            .unwrap()
                            .to_string_lossy()
                            .contains("code-mode-host")
                    {
                        Err("invalid helper signature".into())
                    } else {
                        Ok(())
                    }
                }
            }
            let signatures = Signatures {
                paths: Default::default(),
                fail_helper,
            };
            let result = install_with_download(
                &base.0,
                &pinned,
                &super::test_support::fake_parent(&base.0),
                &AtomicBool::new(false),
                &signatures,
                |_| {},
                |path, _| {
                    fs::write(path, &body).unwrap();
                    Ok(())
                },
            );
            if fail_helper {
                assert!(result.unwrap_err().message.contains("helper signature"));
                assert_eq!(fs::read_dir(base.0.join("codex")).unwrap().count(), 0);
                continue;
            }
            let installed = result.unwrap();
            let root = installed.path.parent().unwrap();
            assert_eq!(fs::read_dir(root).unwrap().count(), 3); // two executables + receipt
            assert!(root.join(helper).is_file());
            assert_eq!(signatures.paths.lock().unwrap().len(), 2);
            assert!(matches!(
                managed_status(&base.0, &pinned).state,
                ToolState::Installed
            ));
            fs::remove_file(root.join(helper)).unwrap();
            assert!(matches!(
                managed_status(&base.0, &pinned).state,
                ToolState::Broken
            ));
        }
    }
}

#[test]
fn codex_package_refuses_missing_duplicate_link_and_unsafe_entries() {
    use crate::local_engine::{file_ops::FileOps, install::extract_tar_entries_with_ops};
    for bad in [
        "missing",
        "duplicate",
        "link",
        "../escape",
        "/absolute",
        "C:/drive",
        "bin/../codex",
        "checksum",
        "oversize",
        "truncated",
        "pax-path",
    ] {
        let temp = Temp::new();
        let mut entries: Vec<(&str, &[u8], u8)> = vec![("bin/codex", b"main", b'0')];
        if bad != "missing" {
            entries.push(("bin/codex-code-mode-host", b"helper", b'0'));
        }
        match bad {
            "duplicate" => entries.push(("bin/codex", b"again", b'0')),
            "link" => entries.push(("other", b"", b'2')),
            "pax-path" => entries.push(("././@PaxHeader", b"18 path=../escape\n", b'x')),
            "missing" | "checksum" | "oversize" | "truncated" => (),
            name => entries.push((name, b"unsafe", b'0')),
        }
        let mut body = package_tar(&entries);
        if bad == "truncated" {
            body.truncate(body.len() - 6);
        }
        if bad == "checksum" || bad == "oversize" {
            let mut tar = Vec::new();
            std::io::Read::read_to_end(
                &mut flate2::read::GzDecoder::new(body.as_slice()),
                &mut tar,
            )
            .unwrap();
            if bad == "checksum" {
                tar[0] ^= 1;
            } else {
                tar[124..135].copy_from_slice(format!("{:011o}", 513u64 * 1024 * 1024).as_bytes());
                tar[148..156].fill(b' ');
                let sum: u32 = tar[..512].iter().map(|b| u32::from(*b)).sum();
                tar[148..155].copy_from_slice(format!("{sum:06o}\0").as_bytes());
            }
            let mut encoder =
                flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            encoder.write_all(&tar).unwrap();
            body = encoder.finish().unwrap();
        }
        let archive = temp.0.join("package.tar.gz");
        fs::write(&archive, &body).unwrap();
        let result = extract_tar_entries_with_ops(
            &archive,
            &[
                ("bin/codex", &temp.0.join("codex")),
                ("bin/codex-code-mode-host", &temp.0.join("host")),
            ],
            FileOps::with_prefix("[test]", None),
        );
        assert!(result.is_err(), "accepted {bad}");
    }
}

#[test]
fn managed_update_detail_matches_ts_snapshot_fixtures() {
    let rows: Vec<serde_json::Value> = serde_json::from_str(include_str!(
        "../../../src/dialogs/managedUpdateSnapshots.json"
    ))
    .unwrap();
    for row in rows {
        let tool: ToolId = serde_json::from_value(row["status"]["tool"].clone()).unwrap();
        assert_eq!(row["status"]["detail"], managed_update_detail(tool));
    }
}

#[test]
fn stale_managed_copies_offer_update_and_replace_without_touching_user_files() {
    check_stale_managed_replacement(true);
}

#[test]
fn stale_managed_replacement_filesystem_transaction_preserves_user_files() {
    check_stale_managed_replacement(false);
}

fn check_stale_managed_replacement(loopback: bool) {
    for platform in [
        ToolPlatform::DarwinArm64,
        ToolPlatform::DarwinX64,
        ToolPlatform::WindowsX64,
    ] {
        for scenario in ["old-version", "old-archive", "corrupt", "missing-helper"] {
            let temp = Temp::new();
            let base = temp.0.join("external-tools");
            let parent = super::test_support::fake_parent(&temp.0);
            let auth = Path::new(parent.get("CODEX_HOME").unwrap()).join("auth.json");
            let original_auth = fs::read(&auth).unwrap();
            let home = super::env::prepare_codex_home(
                super::probe::ProbePlatform::current(),
                &base,
                &parent,
            );
            assert!(home.fallback_reason.is_none());
            let linked_auth = home.path.unwrap().join("auth.json");
            let link_metadata = fs::symlink_metadata(&linked_auth).unwrap();
            let binary = if platform == ToolPlatform::WindowsX64 {
                "codex.exe"
            } else {
                "codex"
            };
            let helper = if platform == ToolPlatform::WindowsX64 {
                "codex-code-mode-host.exe"
            } else {
                "codex-code-mode-host"
            };
            let user_dir = temp.0.join("user-bin");
            fs::create_dir_all(&user_dir).unwrap();
            let user_binary = user_dir.join(binary);
            for path in [&user_binary, &user_dir.join(helper)] {
                fs::write(path, codex_probe_stub()).unwrap();
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
                }
            }
            let body = package_tar(&[
                (&format!("bin/{binary}"), codex_probe_stub(), b'0'),
                (&format!("bin/{helper}"), stub(), b'0'),
            ]);
            let (url, server) = if loopback {
                let (url, server) = serve(&body, true);
                (url, Some(server))
            } else {
                ("https://github.com/openai/codex/fixture".into(), None)
            };
            let mut pin = pin(&body, ArchiveKind::TarGz, &url);
            pin.tool = ToolId::Codex;
            pin.version = "0.163.0";
            pin.platform = platform;
            pin.binary = binary;
            pin.entry = leak(format!("bin/{binary}"));
            let old_binary = status_fixture(&base, &pin);
            let mut old_dir = old_binary.parent().unwrap().to_owned();
            let receipt_path = old_dir.join("install.json");
            match scenario {
                "old-version" => {
                    let mut receipt: serde_json::Value =
                        serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
                    receipt["version"] = serde_json::json!("0.162.1");
                    fs::write(&receipt_path, serde_json::to_vec(&receipt).unwrap()).unwrap();
                    let older = base.join("codex").join("0.162.1");
                    fs::rename(&old_dir, &older).unwrap();
                    old_dir = older;
                }
                "old-archive" => {
                    let mut receipt: serde_json::Value =
                        serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
                    receipt["url"] = serde_json::json!(
                        "https://github.com/openai/codex/releases/old-codex-only.tar.gz"
                    );
                    fs::write(&receipt_path, serde_json::to_vec(&receipt).unwrap()).unwrap();
                }
                "corrupt" => fs::write(&receipt_path, b"{corrupt receipt").unwrap(),
                "missing-helper" => (),
                _ => unreachable!(),
            }
            fs::remove_file(old_dir.join(helper)).unwrap();
            let old_receipt = fs::read(old_dir.join("install.json")).unwrap();
            let expected_detail = "ChemDraft's copy of Codex is from an older ChemDraft version. Update it to add the helper ChemDraft now needs.";
            let status = managed_status(&base, &pin);
            assert!(matches!(status.state, ToolState::Broken));
            assert!(matches!(status.source, Some(super::ToolSource::Managed)));
            assert!(status.can_install);
            assert_eq!(status.detail.as_deref(), Some(expected_detail));
            // Exercise the public status policy too, with discovery confined to fake paths.
            if super::current_platform().is_some() {
                let state = super::ExternalToolsState::default();
                let status =
                    super::status_impl(&base, &state, ToolId::Codex, true, None, &parent).unwrap();
                assert!(matches!(status.state, ToolState::Broken));
                assert!(matches!(status.source, Some(super::ToolSource::Managed)));
                assert!(status.can_install);
                assert_eq!(status.detail.as_deref(), Some(expected_detail));
                if (platform == ToolPlatform::WindowsX64) == cfg!(windows) {
                    // Inject the PATH candidate rather than searching this machine's PATH.
                    *state.test_candidates.lock().unwrap() = vec![user_binary.clone()];
                    let status =
                        super::status_impl(&base, &state, ToolId::Codex, true, None, &parent)
                            .unwrap();
                    assert!(matches!(status.state, ToolState::Installed));
                    assert!(matches!(status.source, Some(super::ToolSource::User)));
                    assert_eq!(status.path, Some(fs::canonicalize(&user_binary).unwrap()));
                }
            }
            let progress = |progress: super::ToolInstallProgress| {
                if progress.phase == ToolInstallPhase::Installing {
                    // Old files remain intact until the new download passes verification.
                    assert_eq!(fs::read(old_dir.join("install.json")).unwrap(), old_receipt);
                    assert!(!old_dir.join(helper).exists());
                }
            };
            let installed = if loopback {
                install_with_client(
                    &base,
                    &pin,
                    &parent,
                    &AtomicBool::new(false),
                    &Signature(true),
                    progress,
                    &client(),
                )
            } else {
                install_with_download(
                    &base,
                    &pin,
                    &parent,
                    &AtomicBool::new(false),
                    &Signature(true),
                    progress,
                    |path, _| {
                        fs::write(path, &body).unwrap();
                        Ok(())
                    },
                )
            }
            .unwrap();
            if let Some(server) = server {
                server.join().unwrap();
            }
            let status = managed_status(&base, &pin);
            assert!(matches!(status.state, ToolState::Installed));
            assert!(matches!(status.source, Some(super::ToolSource::Managed)));
            assert_eq!(status.path, Some(installed.path.clone()));
            assert!(status.detail.is_none());
            assert_eq!(fs::read_dir(base.join("codex")).unwrap().count(), 1);
            assert_eq!(fs::read(&installed.path).unwrap(), codex_probe_stub());
            if (platform == ToolPlatform::WindowsX64) == cfg!(windows) {
                let probe = super::probe::probe_tool(
                    &ToolId::Codex.spec(),
                    &installed.path,
                    &parent,
                    &base,
                    true,
                    None,
                )
                .unwrap();
                assert_eq!(probe.version, pin.version);
                assert!(probe.auth.signed_in);
            }
            assert_eq!(
                fs::read(base.join("codex").join(pin.version).join(helper)).unwrap(),
                stub()
            );
            assert_eq!(fs::read(user_binary).unwrap(), codex_probe_stub());
            assert_eq!(fs::read(user_dir.join(helper)).unwrap(), codex_probe_stub());
            assert_eq!(fs::read(&auth).unwrap(), original_auth);
            assert_eq!(fs::read(&linked_auth).unwrap(), original_auth);
            assert_eq!(
                fs::symlink_metadata(&linked_auth).unwrap().file_type(),
                link_metadata.file_type()
            );
            assert!(!auth.with_extension("json.bak").exists());
        }
    }
}
