use super::*;
use std::collections::BTreeMap;

#[test]
fn linux_tool_pins_have_real_assets_and_distinct_native_architectures() {
    use pins::ToolPlatform::*;
    for (os, arch, expected) in [
        ("macos", "aarch64", Some(DarwinArm64)),
        ("macos", "x86_64", Some(DarwinX64)),
        ("windows", "x86_64", Some(WindowsX64)),
        ("linux", "x86_64", Some(LinuxX64)),
        ("linux", "aarch64", Some(LinuxArm64)),
        ("linux", "riscv64", None),
        ("windows", "aarch64", None),
    ] {
        assert_eq!(pins::ToolPlatform::for_target(os, arch), expected);
    }
    for platform in [LinuxX64, LinuxArm64] {
        let claude = pins::pin_for(ToolId::Claude, platform);
        let codex = pins::pin_for(ToolId::Codex, platform);
        assert!(claude.url.contains("/linux-"));
        assert!(codex.url.contains("unknown-linux-musl.tar.gz"));
        assert_eq!((claude.binary, codex.binary), ("claude", "codex"));
        assert!(claude.size > 250_000_000 && codex.size > 100_000_000);
        assert_ne!(claude.sha256, codex.sha256);
    }
}

#[test]
fn linux_discovery_uses_unix_paths_without_homebrew_or_windows_shims() {
    let parent = BTreeMap::from([("PATH".into(), ":/custom/bin:/usr/bin::".into())]);
    let paths = probe::candidate_paths(
        ToolId::Claude,
        probe::ProbePlatform::Linux,
        Path::new("/home/chemist"),
        &parent,
        None,
    );
    assert_eq!(
        paths,
        [
            "/home/chemist/.local/bin/claude",
            "/usr/local/bin/claude",
            "/usr/bin/claude",
            "/home/chemist/.codex/bin/claude",
            "/home/chemist/.npm-global/bin/claude",
            "/custom/bin/claude",
        ]
        .map(PathBuf::from)
    );
    assert_eq!(
        probe::codex_helper_name(probe::ProbePlatform::Linux),
        "codex-code-mode-host"
    );
}

#[test]
fn linux_child_environment_keeps_graphical_session_without_secrets_or_injection() {
    let parent = BTreeMap::from([
        ("HOME".into(), "/home/chemist".into()),
        ("DISPLAY".into(), ":99".into()),
        ("WAYLAND_DISPLAY".into(), "wayland-test".into()),
        ("XAUTHORITY".into(), "/tmp/authority".into()),
        (
            "DBUS_SESSION_BUS_ADDRESS".into(),
            "unix:path=/tmp/bus".into(),
        ),
        ("ANTHROPIC_API_KEY".into(), "must-not-inherit".into()),
        ("OPENAI_API_KEY".into(), "must-not-inherit".into()),
        ("LD_PRELOAD".into(), "/untrusted.so".into()),
    ]);
    let child = env::child_env(
        probe::ProbePlatform::Linux,
        &parent,
        Path::new("/managed/bin/codex"),
        Path::new("/private/run"),
        true,
    );
    for key in [
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XAUTHORITY",
        "DBUS_SESSION_BUS_ADDRESS",
    ] {
        assert_eq!(child.get(key), parent.get(key));
    }
    for key in ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "LD_PRELOAD"] {
        assert!(!child.contains_key(key));
    }
    assert_eq!(child["PATH"], "/managed/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    assert_eq!(
        env::real_codex_home(probe::ProbePlatform::Linux, &parent),
        Some(PathBuf::from("/home/chemist/.codex"))
    );
}

#[test]
fn verified_linux_executable_headers_reject_wrong_arch_scripts_and_truncation() {
    for (arch, machine) in [("x86_64", 62_u16), ("aarch64", 183_u16)] {
        let mut header = [0_u8; 64];
        header[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
        header[16..18].copy_from_slice(&3_u16.to_le_bytes());
        header[18..20].copy_from_slice(&machine.to_le_bytes());
        assert!(install::validate_linux_elf_header(&header, arch).is_ok());
        assert!(install::validate_linux_elf_header(&header[..20], arch).is_err());
        let other = if arch == "x86_64" {
            "aarch64"
        } else {
            "x86_64"
        };
        assert!(install::validate_linux_elf_header(&header, other).is_err());
        header[16..18].copy_from_slice(&1_u16.to_le_bytes());
        assert!(install::validate_linux_elf_header(&header, arch).is_err());
        header[16..18].copy_from_slice(&2_u16.to_le_bytes());
        header[4] = 1;
        assert!(install::validate_linux_elf_header(&header, arch).is_err());
    }
    assert!(install::validate_linux_elf_header(b"#!/bin/sh\n", "x86_64").is_err());
}

#[test]
fn linux_sign_in_uses_bundled_terminal_and_never_a_flatpak_host_escape() {
    let spec = ToolId::Claude.spec();
    let script = Path::new("/private/sign in.sh");
    let bundled = Path::new("/app/bin/chemdraft-terminal");
    let parent = BTreeMap::from([("FLATPAK_ID".into(), "org.chemdraft.desktop.dev".into())]);
    let command = terminal::linux_terminal_command(
        &spec,
        script,
        bundled,
        &parent,
        BTreeMap::new(),
        |path| path == bundled,
    )
    .unwrap();
    assert_eq!(command.program, bundled);
    assert_eq!(
        command.args,
        [
            "-t",
            "ChemDraft sign-in — Claude Code",
            "-e",
            "/bin/sh",
            "/private/sign in.sh"
        ]
    );
    assert!(!command.new_console);
    assert!(terminal::linux_terminal_command(
        &spec,
        script,
        bundled,
        &parent,
        BTreeMap::new(),
        |_| false,
    )
    .unwrap_err()
    .contains("missing its sign-in terminal"));
    let parent = BTreeMap::from([("PATH".into(), ":/desktop/bin::".into())]);
    let command = terminal::linux_terminal_command(
        &spec,
        script,
        bundled,
        &parent,
        BTreeMap::new(),
        |path| path == Path::new("/desktop/bin/konsole"),
    )
    .unwrap();
    assert_eq!(command.program, Path::new("/desktop/bin/konsole"));
    assert_eq!(
        command.args,
        ["--separate", "-e", "/bin/sh", "/private/sign in.sh"]
    );
}

#[cfg(unix)]
#[test]
fn linux_login_script_quotes_paths_preserves_real_home_and_keeps_failures_visible() {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    use std::process::{Command, Stdio};
    let temp = tests::TempDir::new();
    let program = temp.0.join("vendor ' $(touch unsafe)");
    let marker = temp.0.join("arguments.txt");
    fs::write(&program, format!(
        "#!/bin/sh\nprintf '%s|%s|%s|%s' \"$*\" \"$HOME\" \"$ANTHROPIC_API_KEY\" \"$OPENAI_API_KEY\" > {}\nexit 7\n",
        terminal::shell_quote(&marker.to_string_lossy())
    )).unwrap();
    fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
    let mut spec = ToolId::Claude.spec();
    spec.program = program;
    let parent = BTreeMap::from([
        ("HOME".into(), temp.0.to_string_lossy().into_owned()),
        ("ANTHROPIC_API_KEY".into(), "not-inherited".into()),
        ("OPENAI_API_KEY".into(), "not-inherited".into()),
    ]);
    let environment = env::child_env(
        probe::ProbePlatform::Linux,
        &parent,
        &spec.program,
        &temp.0,
        false,
    );
    let script = temp.0.join("sign-in.sh");
    fs::write(&script, terminal::linux_command_script(&spec, &environment)).unwrap();
    let mut child = Command::new("/bin/sh")
        .arg(&script)
        .current_dir(&temp.0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b"\n").unwrap();
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(7));
    assert!(String::from_utf8_lossy(&output.stdout).contains("Press Enter to close"));
    assert_eq!(
        fs::read_to_string(marker).unwrap(),
        format!("auth login|{}||", temp.0.display())
    );
    assert!(!temp.0.join("unsafe").exists());
    assert!(!script.exists());
}

/// Opt-in release evidence: these are actual vendor archives, never mocks or the user's installed
/// tools. They run only --version in a registered temporary home, with no account/model requests.
#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires explicitly supplied verified Linux vendor archives"]
fn linux_vendor_archives_install_validate_and_commit_without_user_accounts() {
    use crate::local_engine::InstallError;
    use sha2::{Digest, Sha256};
    use std::io::Read;
    use std::sync::atomic::AtomicBool;

    let platform = current_platform().expect("supported native Linux architecture");
    for (tool, variable) in [
        (ToolId::Claude, "CHEMDRAFT_LINUX_CLAUDE_ARCHIVE"),
        (ToolId::Codex, "CHEMDRAFT_LINUX_CODEX_ARCHIVE"),
    ] {
        let archive =
            std::env::var_os(variable).unwrap_or_else(|| panic!("{variable} is required"));
        let archive = PathBuf::from(archive);
        let pin = pins::pin_for(tool, platform);
        let temp = tests::TempDir::new();
        let base = temp.0.join("managed-tools");
        let parent = test_support::fake_parent(&temp.0);
        let mut phases = Vec::new();
        let installed = install::install_with_download(
            &base,
            pin,
            &parent,
            &AtomicBool::new(false),
            &install::SystemSignatureChecker,
            |progress| phases.push(progress.phase),
            |destination, progress| {
                // Reuse a previously downloaded vendor archive while retaining the transport's
                // exact size/SHA-256 contract. Extraction, ELF validation, real process/version
                // verification and transactional commit all use the production implementation.
                fs::copy(&archive, destination)
                    .map_err(|error| InstallError::failed(error.to_string()))?;
                let mut file = fs::File::open(destination)
                    .map_err(|error| InstallError::failed(error.to_string()))?;
                let mut hash = Sha256::new();
                let mut total = 0_u64;
                let mut buffer = [0_u8; 64 * 1024];
                loop {
                    let count = file
                        .read(&mut buffer)
                        .map_err(|error| InstallError::failed(error.to_string()))?;
                    if count == 0 {
                        break;
                    }
                    total += count as u64;
                    hash.update(&buffer[..count]);
                }
                if total != pin.size || format!("{:x}", hash.finalize()) != pin.sha256 {
                    return Err(InstallError::failed(
                        "Supplied vendor archive failed its pin.",
                    ));
                }
                progress(total, Some(pin.size));
                Ok(())
            },
        )
        .unwrap_or_else(|error| panic!("{tool:?} real Linux install failed: {}", error.message));
        assert_eq!(installed.version, pin.version);
        assert!(installed.path.is_file());
        assert!(phases.contains(&ToolInstallPhase::Done));
        let status = install::managed_status(&base, pin);
        assert!(
            matches!(status.state, ToolState::Installed),
            "{:?}",
            status.detail
        );
        let receipt: install::InstallReceipt = serde_json::from_slice(
            &fs::read(installed.path.with_file_name("install.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(receipt.platform, platform);
        assert_eq!(receipt.sha256, pin.sha256);
        assert_eq!(receipt.url, pin.url);
        if tool == ToolId::Codex {
            assert!(installed
                .path
                .with_file_name("codex-code-mode-host")
                .is_file());
            assert!(!installed
                .path
                .parent()
                .unwrap()
                .join("codex-resources")
                .exists());
        }
        eprintln!("{tool:?}: actual Linux download pin, native ELF, --version, receipt and managed status passed");
    }
}
