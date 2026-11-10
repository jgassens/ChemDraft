use super::*;
use crate::local_engine::{
    platform::{EngineTarget, MacArchitecture, MacPlatform, WindowsPlatform},
    process::SidecarProtocol,
};
use std::{ffi::OsString, fs, process::Command};

struct TestRoot(PathBuf);
impl TestRoot {
    fn new(label: &str) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "chemdraft-naming-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).expect("test root");
        Self(root)
    }
}
impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn raw() -> protocol::RawResult {
    protocol::RawResult {
        name: Some("ethanol".into()),
        tier: "pin_verified".into(),
        is_pin: true,
        opsin: "verified".into(),
        gate_outcome: "self_consistency_verified".into(),
        limit_code: None,
        stereo_unexpressed: false,
        source: "pin_path".into(),
        elapsed_ms: 25,
    }
}

#[test]
fn install_io_diagnostics_keep_naming_prefixes_and_paths() {
    use crate::local_engine::file_ops::{self, FileOps};
    let root = TestRoot::new("io-diagnostics");
    let from = root.0.join("naming-engine.partial");
    let to = root.0.join("naming-engine");
    let ops = FileOps::new::<install::NamingSpec>(None);
    let error = ops
        .rename(&from, &to)
        .map_err(file_ops::failed::<install::NamingSpec>)
        .unwrap_err();
    assert!(error
        .message
        .starts_with("Naming engine file operation failed: could not rename "));
    assert!(error.message.contains(from.to_string_lossy().as_ref()));
    assert!(error.message.contains(to.to_string_lossy().as_ref()));

    let config = to.join("venv").join("pyvenv.cfg");
    let error = ops
        .write(&config, b"home = missing")
        .map_err(file_ops::relocation_failed::<install::NamingSpec>)
        .unwrap_err();
    assert!(error
        .message
        .starts_with("Could not relocate the naming environment: could not create file "));
    assert!(error.message.contains(config.to_string_lossy().as_ref()));
}
fn result_line() -> String {
    let mut value = serde_json::to_value(raw()).expect("raw");
    value["type"] = "result".into();
    value["id"] = "n-1".into();
    value.to_string()
}
fn ready_line() -> serde_json::Value {
    serde_json::json!({"type":"ready", "protocol":1, "orthonymVersion":"1.0.8", "rdkitVersion":"2026.03.5", "jvm":"jpype"})
}

#[test]
fn bundled_lock_matches_pin_and_wheel_provenance() {
    let lock = include_bytes!("../../resources/naming/requirements.txt");
    assert_eq!(
        local_engine::pins::text_sha256(lock),
        pins::REQUIREMENTS_LOCK_SHA256
    );
    let text = String::from_utf8_lossy(lock);
    assert!(text.contains("orthonym==1.0.8"));
    assert!(text.contains(pins::ORTHONYM_WHEEL_SHA256));
    assert_eq!(
        pins::ORTHONYM_COMMIT,
        "461987b947f76e41ff0baa6c2aa19ecd79cacd0b"
    );
    assert_eq!(pins::REQUIRED_DISK_BYTES, 1_000_000_000);
}

#[test]
fn intel_input_keeps_the_original_pins_except_for_the_rdkit_source() {
    let original = include_str!("../../resources/naming/requirements.in");
    let intel = include_str!("../../resources/naming/requirements-macos-x86_64.in");
    let pins = |text: &str| -> Vec<String> {
        text.lines()
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .map(String::from)
            .collect()
    };
    let mut expected = pins(original);
    let wheel = "https://github.com/jgassens/ChemDraft-Engines/releases/download/rdkit-2026.3.5-macos-x86_64-1/rdkit-2026.3.5-cp312-cp312-macosx_11_0_x86_64.whl";
    *expected
        .iter_mut()
        .find(|pin| pin.starts_with("rdkit=="))
        .expect("RDKit pin") = format!("rdkit @ {wheel}");
    assert_eq!(pins(intel), expected);
    assert!(intel.contains("uv pip compile requirements-macos-x86_64.in --python-version 3.12 --python-platform x86_64-apple-darwin --generate-hashes -o requirements-macos-x86_64.txt"));
}

#[test]
fn intel_bundled_lock_matches_pin_and_wheel_provenance() {
    let profile = requirements::RequirementsProfile::for_target(EngineTarget::MacosX86_64);
    // Deliberately a runtime read: the absent release/lock must fail this gate without
    // preventing the other naming tests from compiling and running on the original targets.
    let lock = fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(profile.path))
        .expect("publish the Intel RDKit wheel, generate requirements-macos-x86_64.txt, then set REQUIREMENTS_LOCK_SHA256_MACOS_X86_64");
    assert_ne!(
        profile.sha256,
        "0".repeat(64),
        "set the real Intel lock hash"
    );
    assert_eq!(local_engine::pins::text_sha256(&lock), profile.sha256);
    let text = String::from_utf8(lock).expect("UTF-8 lock");
    assert!(text.contains("orthonym==1.0.8"));
    assert!(text.contains(pins::ORTHONYM_WHEEL_SHA256));
    let rdkit = text
        .split("rdkit @ ")
        .nth(1)
        .expect("direct RDKit reference");
    assert!(rdkit.starts_with("https://github.com/jgassens/ChemDraft-Engines/releases/download/rdkit-2026.3.5-macos-x86_64-1/rdkit-2026.3.5-cp312-cp312-macosx_11_0_x86_64.whl"));
    assert!(
        rdkit.contains("--hash=sha256:"),
        "direct wheel must be hash-locked"
    );
}

#[test]
fn requirements_profiles_select_the_lock_from_the_explicit_build_target() {
    for target in [EngineTarget::MacosAarch64, EngineTarget::WindowsX86_64] {
        let profile = requirements::RequirementsProfile::for_target(target);
        assert_eq!(profile.path, "resources/naming/requirements.txt");
        assert_eq!(
            profile.sha256,
            "ec5021b4365d77936c99ae71f3057a41c946149e67d8342de24c867edd6d9a2a"
        );
        assert_eq!(profile.receipt_profile, None);
        let platform = install::platform_for_target(target).expect("original platform");
        assert_eq!(
            NamingSpec::requirements_for(platform.as_ref()),
            profile.lock()
        );
    }
    let profile = requirements::RequirementsProfile::for_target(EngineTarget::MacosX86_64);
    assert_eq!(
        profile.path,
        "resources/naming/requirements-macos-x86_64.txt"
    );
    assert_eq!(profile.sha256, pins::REQUIREMENTS_LOCK_SHA256_MACOS_X86_64);
    assert_ne!(profile.sha256, pins::REQUIREMENTS_LOCK_SHA256);
    assert_eq!(profile.receipt_profile, Some("macos-x86_64"));
    assert_eq!(
        NamingSpec::requirements(),
        requirements::RequirementsProfile::for_target(EngineTarget::current()).lock()
    );
}

// Literal bytes from the original v1 schema and pins, independent of current serialization.
fn original_receipt_fixture(target: EngineTarget) -> &'static str {
    match target {
        EngineTarget::MacosAarch64 => {
            r#"{
  "receiptVersion": 1,
  "engineDir": "naming-engine",
  "uvVersion": "0.12.18",
  "uvAsset": "uv-aarch64-apple-darwin.tar.gz",
  "uvSha256": "cf40e0c6a202190ccd9e0406dcfdd5b2d6668a9a5c779b17948963df32aafe5b",
  "pythonVersion": "3.12",
  "orthonymVersion": "1.0.8",
  "orthonymCommit": "461987b947f76e41ff0baa6c2aa19ecd79cacd0b",
  "orthonymWheelSha256": "ffd4f69d95349887c3fd762197464dadff81a1cf494fe42f6a2bcd7d6674393d",
  "requirementsSha256": "ec5021b4365d77936c99ae71f3057a41c946149e67d8342de24c867edd6d9a2a",
  "centresUrl": "https://github.com/SiMolecule/centres/releases/download/1.2.1/centres.jar",
  "centresBytes": 2291742,
  "centresSha256": "6c5d5cafa9393ed7b667a2340222348cd15a9bbdd0d1b92518229f26cc5e87fb",
  "installedAt": "2026-10-21T00:00:00+00:00",
  "diskBytes": 123
}"#
        }
        EngineTarget::WindowsX86_64 => {
            r#"{
  "receiptVersion": 1,
  "engineDir": "naming-engine",
  "uvVersion": "0.12.18",
  "uvAsset": "uv-x86_64-pc-windows-msvc.zip",
  "uvSha256": "cae6a3bc25239f83dffb467a4b180508d9da23986c04639ebfa44e43e6a84bff",
  "pythonVersion": "3.12",
  "orthonymVersion": "1.0.8",
  "orthonymCommit": "461987b947f76e41ff0baa6c2aa19ecd79cacd0b",
  "orthonymWheelSha256": "ffd4f69d95349887c3fd762197464dadff81a1cf494fe42f6a2bcd7d6674393d",
  "requirementsSha256": "ec5021b4365d77936c99ae71f3057a41c946149e67d8342de24c867edd6d9a2a",
  "centresUrl": "https://github.com/SiMolecule/centres/releases/download/1.2.1/centres.jar",
  "centresBytes": 2291742,
  "centresSha256": "6c5d5cafa9393ed7b667a2340222348cd15a9bbdd0d1b92518229f26cc5e87fb",
  "installedAt": "2026-10-21T00:00:00+00:00",
  "diskBytes": 123
}"#
        }
        other => panic!("no original receipt for {other:?}"),
    }
}

#[test]
fn original_receipts_keep_the_previous_bytes_and_remain_accepted() {
    for target in [EngineTarget::MacosAarch64, EngineTarget::WindowsX86_64] {
        let platform = install::platform_for_target(target).expect("platform");
        let fixture = original_receipt_fixture(target);
        let old = receipt::parse_receipt(fixture).expect("original v1 receipt");
        assert!(old.matches_pins(platform.as_ref()));
        assert_eq!(old.requirements_profile, None);
        let mut fresh = InstallReceipt::pinned(platform.as_ref(), 123);
        fresh.installed_at = "2026-10-21T00:00:00+00:00".into();
        let root = TestRoot::new("receipt-bytes");
        let path = root.0.join(RECEIPT_FILE);
        for receipt in [old, fresh] {
            NamingSpec::write_receipt(&path, &receipt).expect("write v1 receipt");
            assert_eq!(fs::read(&path).expect("receipt bytes"), fixture.as_bytes());
        }
    }
}

#[test]
fn cross_profile_receipts_are_rejected_even_with_matching_uv_pins() {
    let intel = install::platform_for_target(EngineTarget::MacosX86_64).expect("Intel");
    for target in [EngineTarget::MacosAarch64, EngineTarget::WindowsX86_64] {
        let original = install::platform_for_target(target).expect("original platform");
        for (source, destination) in [
            (intel.as_ref(), original.as_ref()),
            (original.as_ref(), intel.as_ref()),
        ] {
            let mut receipt = InstallReceipt::pinned(source, 123);
            assert!(receipt.matches_pins(source));
            receipt.uv_asset = destination.uv_asset().into();
            receipt.uv_sha256 = destination.uv_sha256().into();
            assert!(!receipt.matches_pins(destination));
            // The optional profile marker independently guards even coincident lock hashes.
            receipt.requirements_sha256 =
                requirements::RequirementsProfile::for_target(destination.target())
                    .sha256
                    .into();
            assert!(!receipt.matches_pins(destination));
            let root = TestRoot::new("cross-profile");
            NamingSpec::write_receipt(&root.0.join(RECEIPT_FILE), &receipt).expect("write");
            let status = installed_status(&root.0, destination, 0);
            assert_eq!(status.state, EngineStatus::Broken);
            assert!(status.detail.expect("pins detail").contains("pins differ"));
            assert!(!local_engine::install::is_healthy::<NamingSpec>(
                &root.0,
                destination
            ));
            assert!(!NamingSpec::is_restorable(&root.0, destination));
        }
    }
}

#[test]
fn intel_receipts_require_the_profile_marker_and_its_lock_hash() {
    let platform = install::platform_for_target(EngineTarget::MacosX86_64).expect("Intel");
    let receipt = InstallReceipt::pinned(platform.as_ref(), 123);
    let value = serde_json::to_value(&receipt).expect("JSON");
    assert_eq!(value["requirementsProfile"], "macos-x86_64");
    assert!(receipt.matches_pins(platform.as_ref()));
    for replacement in [
        None,
        Some(serde_json::Value::Null),
        Some(serde_json::json!("other")),
    ] {
        let mut incomplete = value.clone();
        match replacement {
            Some(value) => incomplete["requirementsProfile"] = value,
            None => {
                incomplete
                    .as_object_mut()
                    .expect("object")
                    .remove("requirementsProfile");
            }
        }
        let incomplete = receipt::parse_receipt(&incomplete.to_string()).expect("v1");
        assert!(!incomplete.matches_pins(platform.as_ref()));
    }
    let mut stale = receipt;
    stale.requirements_sha256 = pins::REQUIREMENTS_LOCK_SHA256.into();
    assert!(!stale.matches_pins(platform.as_ref()));
}

#[test]
fn receipt_round_trip_and_unreadable_or_newer_records_are_broken() {
    let platform = MacPlatform::new(MacArchitecture::Aarch64);
    let receipt = InstallReceipt::pinned(&platform, 123);
    let text = serde_json::to_string(&receipt).expect("receipt");
    assert_eq!(receipt::parse_receipt(&text), Ok(receipt.clone()));
    assert!(receipt.matches_pins(&platform));
    assert!(!receipt.matches_pins(&WindowsPlatform));
    let root = TestRoot::new("receipt");
    let path = root.0.join(RECEIPT_FILE);
    let broken = installed_status(&root.0, &platform, 5);
    assert_eq!(broken.state, EngineStatus::Broken);
    assert!(broken.detail.expect("detail").contains("Could not read"));
    fs::write(&path, "damaged").expect("bad receipt");
    assert_eq!(
        installed_status(&root.0, &platform, 5).state,
        EngineStatus::Broken
    );
    fs::write(&path, r#"{"receiptVersion":2,"futureField":true}"#).expect("future receipt");
    let broken = installed_status(&root.0, &platform, 5);
    assert_eq!(broken.state, EngineStatus::Broken);
    assert!(broken.detail.expect("newer detail").contains("newer"));
    assert!(receipt::parse_receipt(r#"{"receiptVersion":0}"#).is_err());
}

#[test]
fn protocol_rejects_wrong_ids_unknown_fields_versions_and_fatal_lines() {
    assert_eq!(protocol::NAMING_PROTOCOL_VERSION, 1);
    assert!(protocol::ready(&ready_line().to_string()).is_ok());
    for (field, value) in [
        ("protocol", serde_json::json!(2)),
        ("orthonymVersion", serde_json::json!("selftest-stub")),
        ("orthonymVersion", serde_json::json!("1.0.9")),
        ("jvm", serde_json::json!("subprocess")),
        ("extra", serde_json::json!(true)),
    ] {
        let mut ready = ready_line();
        ready[field] = value;
        assert!(
            protocol::ready(&ready.to_string()).is_err(),
            "accepted {ready}"
        );
    }
    assert_eq!(protocol::result(&result_line(), "n-1"), Ok(raw()));
    assert!(protocol::result(&result_line(), "n-2").is_err());
    let mut result: serde_json::Value = serde_json::from_str(&result_line()).expect("line");
    result["extra"] = true.into();
    assert!(protocol::result(&result.to_string(), "n-1").is_err());
    for line in [
        r#"{"type":"fatal","code":"reduced_mode","message":"refused"}"#,
        r#"{"type":"fatal","code":"future_fatal","message":"refused"}"#,
    ] {
        assert!(protocol::ready(line).is_err());
        assert!(protocol::result(line, "n-1").is_err());
    }
    for line in [
        "noise",
        "{}",
        r#"{"type":"error","id":"other","code":"invalid_smiles","message":"bad"}"#,
        r#"{"type":"error","id":null,"code":"bad_request","message":"bad"}"#,
        r#"{"type":"error","id":"n-1","code":"invalid_smiles","message":"bad","unknown":true}"#,
    ] {
        assert!(protocol::result(line, "n-1").is_err());
    }
    assert!(matches!(
        protocol::result(
            r#"{"type":"error","id":"n-1","code":"invalid_smiles","message":"bad"}"#,
            "n-1"
        ),
        Err(ProcessError::InvalidSmiles(_))
    ));
    assert!(matches!(
        protocol::result(
            r#"{"type":"error","id":"n-1","code":"namer_raised","message":"bad"}"#,
            "n-1"
        ),
        Err(ProcessError::NamingFailed(_))
    ));
    assert!(
        protocol::parse_line(r#"{"type":"fatal","code":"x","code":"y","message":"bad"}"#).is_err()
    );
}

#[test]
fn oversized_smiles_are_refused_before_encoding_or_spawning() {
    assert!(protocol::validate_smiles(&"C".repeat(5000)).is_ok());
    for smiles in [
        "C".repeat(5001),
        String::new(),
        " CCO".into(),
        "C\nC".into(),
        "C\0C".into(),
    ] {
        assert!(matches!(
            protocol::encode("n-1", &smiles),
            Err(ProcessError::InvalidSmiles(_))
        ));
    }
}

#[test]
fn intel_mac_is_supported_with_its_own_requirements_profile() {
    assert!(install::platform_supported(&MacPlatform::new(MacArchitecture::Aarch64)).is_ok());
    assert!(install::platform_supported(&WindowsPlatform).is_ok());
    let intel = MacPlatform::new(MacArchitecture::X86_64);
    assert!(install::platform_supported(&intel).is_ok());
    let platform = install::platform_for_target(EngineTarget::MacosX86_64).expect("Intel");
    assert_eq!(platform.target(), EngineTarget::MacosX86_64);
    assert_eq!(platform.uv_asset(), "uv-x86_64-apple-darwin.tar.gz");
    assert_eq!(
        NamingSpec::requirements_for(platform.as_ref()),
        (
            "resources/naming/requirements-macos-x86_64.txt",
            pins::REQUIREMENTS_LOCK_SHA256_MACOS_X86_64,
        )
    );
    assert!(install::platform_for_target(EngineTarget::Unsupported).is_err());
}

#[test]
fn original_install_arguments_remain_byte_identical() {
    for target in [EngineTarget::MacosAarch64, EngineTarget::WindowsX86_64] {
        let platform = install::platform_for_target(target).expect("platform");
        let root = Path::new("engine");
        let args = local_engine::install::pip_install_args::<NamingSpec>(
            platform.venv_python(root).into_os_string(),
            root.join("requirements.txt"),
        );
        let python = match target {
            EngineTarget::MacosAarch64 => root.join("venv").join("bin").join("python"),
            EngineTarget::WindowsX86_64 => root.join("venv").join("Scripts").join("python.exe"),
            _ => unreachable!(),
        };
        let expected: Vec<OsString> = vec![
            "pip".into(),
            "install".into(),
            "--python".into(),
            python.into_os_string(),
            "--require-hashes".into(),
            "--compile-bytecode".into(),
            "--requirement".into(),
            root.join("requirements.txt").into_os_string(),
        ];
        assert_eq!(args, expected, "{target:?}");
        assert_eq!(NamingSpec::python_version(), "3.12");
    }
}

#[test]
fn installer_checks_the_selected_profile_hash_before_installing_packages() {
    use local_engine::{
        install::{Download, InstallIo, ProgressReporter, RunStep, RunWatch},
        platform::EnginePlatform,
    };

    // No downloads or subprocesses: stop as soon as package installation would start.
    #[derive(Default)]
    struct LockCheckIo(AtomicBool);
    impl InstallIo for LockCheckIo {
        fn download(
            &self,
            _: Download<'_>,
            _: &Path,
            _: &AtomicBool,
            _: &dyn ProgressReporter,
        ) -> Result<(), InstallError> {
            Ok(())
        }
        fn extract_uv(
            &self,
            _: &dyn EnginePlatform,
            _: &Path,
            _: &Path,
        ) -> Result<(), InstallError> {
            Ok(())
        }
        fn run(
            &self,
            _: &dyn EnginePlatform,
            step: RunStep,
            _: &Path,
            _: &[OsString],
            _: &[(OsString, OsString)],
            _: &AtomicBool,
            _: Option<RunWatch<'_>>,
        ) -> Result<(), InstallError> {
            if step == RunStep::InstallPackages {
                self.0.store(true, Ordering::SeqCst);
                return Err(InstallError::failed("test stopped before package install"));
            }
            Ok(())
        }
    }

    for target in [
        EngineTarget::MacosAarch64,
        EngineTarget::MacosX86_64,
        EngineTarget::WindowsX86_64,
    ] {
        let platform = install::platform_for_target(target).expect("platform");
        for tampered in [false, true] {
            let root = TestRoot::new("lock-check");
            let paths = InstallPaths {
                app_data: root.0.clone(),
                requirements: root.0.join("lock.txt"),
            };
            let original = include_bytes!("../../resources/naming/requirements.txt");
            fs::write(
                &paths.requirements,
                if tampered {
                    b"tampered".as_slice()
                } else {
                    original
                },
            )
            .expect("lock fixture");
            let io = LockCheckIo::default();
            let error = local_engine::install::install::<NamingSpec>(
                &paths,
                platform.as_ref(),
                &io,
                &AtomicBool::new(false),
                &|_| {},
                pins::REQUIRED_DISK_BYTES,
            )
            .expect_err("test install stops");
            if target == EngineTarget::MacosX86_64 || tampered {
                assert_eq!(error.code, local_engine::InstallErrorCode::ChecksumMismatch);
                let profile = requirements::RequirementsProfile::for_target(target);
                assert!(error.message.contains(profile.sha256));
                assert!(
                    !io.0.load(Ordering::SeqCst),
                    "unverified packages must not install"
                );
            } else {
                assert!(
                    io.0.load(Ordering::SeqCst),
                    "original lock remains accepted"
                );
                assert_eq!(error.message, "test stopped before package install");
            }
            assert!(!paths.partial_dir_for::<NamingSpec>().exists());
        }
    }
}

const POISON_KEYS: &[&str] = &[
    "ORTHONYM_ALLOW_REDUCED",
    "ORTHONYM_DISABLE_JPYPE",
    "JAVA_TOOL_OPTIONS",
    "_JAVA_OPTIONS",
    "JDK_JAVA_OPTIONS",
    "UV_INDEX",
    "PIP_INDEX_URL",
    "PYTHONPATH",
    "PYTHONHOME",
    "VIRTUAL_ENV",
    "CONDA_PREFIX",
];

// The Rust test executable is a portable child stand-in, requiring neither shell nor Python.
#[test]
fn environment_child_probe() {
    if std::env::var_os("CHEMDRAFT_NAMING_ENV_PROBE").is_none() {
        return;
    }
    for key in POISON_KEYS {
        assert!(std::env::var_os(key).is_none(), "inherited {key}");
    }
}

#[test]
fn poisoned_parent_environment_does_not_reach_a_child() {
    let mut child = Command::new(std::env::current_exe().expect("test executable"));
    child
        .args([
            "--exact",
            "naming_engine::tests::environment_child_probe",
            "--nocapture",
        ])
        .env("CHEMDRAFT_NAMING_ENV_PROBE", "1");
    for key in POISON_KEYS {
        child.env(key, "poison");
    }
    process::scrub_environment(&mut child, POISON_KEYS.iter().map(OsString::from));
    assert!(child.status().expect("child probe").success());
}

fn launch(root: &Path) -> LaunchPaths {
    LaunchPaths {
        python: root.join("python"),
        sidecar: root.join("sidecar.py"),
        engine: root.to_path_buf(),
        jre: root.join("bundled-jre"),
        opsin: root.join("opsin.jar"),
    }
}

#[test]
fn command_uses_bundled_jre_and_system_path_and_explicit_environment() {
    let root = TestRoot::new("env");
    let launch = launch(&root.0);
    let command = process::command(&launch);
    assert_eq!(command.get_current_dir(), Some(root.0.as_path()));
    let args: Vec<_> = command.get_args().collect();
    assert_eq!(&args[..2], ["-I", "-B"]);
    let vars: std::collections::BTreeMap<_, _> = command.get_envs().collect();
    #[cfg(windows)]
    let env_value = |key: &str| {
        vars.iter().find_map(|(candidate, value)| {
            candidate
                .to_string_lossy()
                .eq_ignore_ascii_case(key)
                .then_some(value)
        })
    };
    #[cfg(not(windows))]
    let env_value = |key: &str| vars.get(std::ffi::OsStr::new(key));
    for key in &POISON_KEYS[..5] {
        assert_eq!(env_value(key), Some(&None));
    }
    assert_eq!(
        env_value("JAVA_HOME").copied().flatten(),
        Some(launch.jre.as_os_str())
    );
    assert_eq!(
        env_value("ORTHONYM_NO_DOWNLOAD").copied().flatten(),
        Some(std::ffi::OsStr::new("1"))
    );
    assert_eq!(
        env_value("ORTHONYM_OPSIN_JAR").copied().flatten(),
        Some(launch.opsin.as_os_str())
    );
    let path = env_value("PATH").copied().flatten().expect("path");
    let entries: Vec<_> = std::env::split_paths(path).collect();
    assert_eq!(entries[0], launch.jre.join("bin"));
    #[cfg(unix)]
    assert_eq!(
        &entries[1..],
        ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(PathBuf::from)
    );
    #[cfg(windows)]
    assert!(entries[1].ends_with("System32"));
}

#[test]
fn tampered_centres_refuses_spawn_and_checks_digest_even_at_the_pinned_size() {
    let root = TestRoot::new("jar");
    fs::create_dir(root.0.join("jars")).expect("jars");
    let path = install::centres_path(&root.0);
    fs::write(&path, b"tampered").expect("jar");
    assert!(install::verify_centres(&root.0).is_err());
    let file = fs::File::create(&path).expect("jar");
    file.set_len(pins::CENTRES_BYTES).expect("size");
    assert!(install::verify_centres(&root.0)
        .expect_err("digest mismatch")
        .message
        .contains("SHA-256"));
    let error = process::NamingProtocol::spawn(
        &(),
        &MacPlatform::new(MacArchitecture::Aarch64),
        &launch(&root.0),
        Duration::from_secs(1),
        &KillSwitch::default(),
    );
    assert!(
        matches!(error, Err(ProcessError::Crashed(message)) if message.contains("centres jar"))
    );
    assert_eq!(
        process::NamingProtocol::START_TIMEOUT,
        Some(Duration::from_secs(60))
    );
    assert_eq!(process::REQUEST_TIMEOUT, Duration::from_secs(30));
    assert_eq!(
        process::NamingProtocol::IDLE_TIMEOUT,
        Duration::from_secs(600)
    );
}

#[test]
fn raw_contract_preserves_all_metadata_and_read_back_failure_without_policy() {
    let root = TestRoot::new("read-back");
    let mut raw = raw();
    raw.tier = "unverified".into();
    raw.gate_outcome = "carveout:example".into();
    raw.stereo_unexpressed = true;
    let platform = install::current_platform().expect("platform");
    let result = read_back(
        raw.clone(),
        &launch(&root.0),
        platform.as_ref(),
        &|| false,
        &crate::opsin::ReadBackChild::default(),
    );
    assert_eq!(result.result, raw);
    assert!(result
        .opsin_read_back
        .as_ref()
        .expect("read-back attempted")
        .failure_reason
        .is_some());
    let value = serde_json::to_value(result).expect("raw contract");
    for field in [
        "name",
        "tier",
        "isPin",
        "opsin",
        "gateOutcome",
        "limitCode",
        "stereoUnexpressed",
        "source",
        "elapsedMs",
        "opsinReadBack",
    ] {
        assert!(value.get(field).is_some(), "missing {field}");
    }
    assert!(value["opsinReadBack"]["smiles"].is_null());
    assert!(value["opsinReadBack"]["failureReason"].is_string());
    raw.name = None;
    assert!(read_back(
        raw,
        &launch(&root.0),
        platform.as_ref(),
        &|| false,
        &crate::opsin::ReadBackChild::default()
    )
    .opsin_read_back
    .is_none());
}

fn sleeping_read_back(root: &TestRoot) -> LaunchPaths {
    let launch = launch(&root.0);
    fs::create_dir_all(&launch.engine).expect("engine directory");
    crate::opsin::build_sleeping_opsin_stub(&process::java_executable(&launch.jre));
    launch
}

fn wait_for_read_back(root: &TestRoot) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !root.0.join("opsin.started").exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        root.0.join("opsin.started").exists(),
        "OPSIN read-back never started"
    );
}

#[cfg(unix)]
fn process_has_exited(pid: u32) -> bool {
    let pid = libc::pid_t::try_from(pid).expect("valid child PID");
    // SAFETY: signal 0 only checks existence. Shutdown must have killed AND reaped this child.
    let result = unsafe { libc::kill(pid, 0) };
    result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

#[cfg(windows)]
fn process_has_exited(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, STILL_ACTIVE},
        System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };
    // SAFETY: query-only handle to the stub; closed before returning on every path.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            assert_eq!(GetLastError(), ERROR_INVALID_PARAMETER);
            return true;
        }
        let mut code = 0;
        let result = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        assert_ne!(result, 0, "query stub exit code");
        code != STILL_ACTIVE as u32
    }
}

#[test]
fn shutdown_reaps_opsin_read_back_before_returning_without_worker_cooperation() {
    for forced in [false, true] {
        let root = TestRoot::new(if forced {
            "forced-read-back"
        } else {
            "exit-read-back"
        });
        let launch = sleeping_read_back(&root);
        let state = NamingEngineState::default();
        let worker_state = state.inner.clone();
        let pause = Arc::new(AtomicBool::new(false));
        let worker_pause = pause.clone();
        let (paused_send, paused_receive) = std::sync::mpsc::channel();
        let (resume_send, resume_receive) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let platform = install::current_platform().expect("platform");
            let stopped = || {
                if worker_pause.swap(false, Ordering::SeqCst) {
                    paused_send.send(()).expect("paused notification");
                    // Park outside the child lock: model a worker that never gets its next
                    // timeslice once the Windows quit watchdog starts forcing app exit.
                    resume_receive
                        .recv_timeout(Duration::from_secs(10))
                        .expect("resume worker");
                }
                worker_state.shut_down.load(Ordering::SeqCst)
            };
            read_back(
                raw(),
                &launch,
                platform.as_ref(),
                &stopped,
                &worker_state.read_back_child,
            )
        });
        wait_for_read_back(&root);
        let pid = state
            .inner
            .read_back_child
            .tracked_pid()
            .expect("registered JVM");
        pause.store(true, Ordering::SeqCst);
        paused_receive
            .recv_timeout(Duration::from_secs(2))
            .expect("park read-back worker");
        let started = Instant::now();
        if forced {
            // A concurrent earlier shutdown may have set this flag without finishing cleanup.
            state.inner.shut_down.store(true, Ordering::SeqCst);
            state.kill_for_forced_exit();
        } else {
            state.shutdown();
        }
        let elapsed = started.elapsed();
        // Capture these BEFORE releasing the worker: polling cannot make this test pass.
        let cleared = state.inner.read_back_child.tracked_pid().is_none();
        let exited = process_has_exited(pid);
        state.shutdown(); // repeated cleanup must leave the reaped child unregistered
        resume_send.send(()).expect("resume");
        let result = worker.join().expect("read-back worker");
        assert!(
            elapsed < Duration::from_secs(2),
            "shutdown waited for the parser timeout"
        );
        assert!(cleared, "shutdown did not reap and clear the JVM");
        assert!(exited, "JVM still running after shutdown returned");
        assert!(result.opsin_read_back.expect("read-back").smiles.is_none());
        // A killed descendant can remain a zombie until the OS reaps it. Verify it never
        // reaches its delayed write, rather than treating a zombie PID as a live process.
        std::thread::sleep(Duration::from_millis(3200));
        assert!(
            !root.0.join("opsin.survived").exists(),
            "JVM descendant survived shutdown"
        );
    }
}

#[test]
fn shutdown_between_initial_stop_check_and_child_registration_refuses_spawn() {
    let root = TestRoot::new("exit-before-read-back-spawn");
    let launch = launch(&root.0); // deliberately absent: reaching spawn would give a launch error
    let state = NamingEngineState::default();
    let worker_state = state.inner.clone();
    let (checked_send, checked_receive) = std::sync::mpsc::channel();
    let (resume_send, resume_receive) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let platform = install::current_platform().expect("platform");
        let first_check = AtomicBool::new(true);
        read_back(
            raw(),
            &launch,
            platform.as_ref(),
            &|| {
                if first_check.swap(false, Ordering::SeqCst) {
                    checked_send.send(()).expect("initial stop check");
                    resume_receive
                        .recv_timeout(Duration::from_secs(10))
                        .expect("resume worker");
                    false // stale result from just before shutdown
                } else {
                    worker_state.shut_down.load(Ordering::SeqCst)
                }
            },
            &worker_state.read_back_child,
        )
    });
    checked_receive
        .recv_timeout(Duration::from_secs(2))
        .expect("initial check");
    state.shutdown();
    resume_send.send(()).expect("resume");
    let result = worker.join().expect("read-back worker");
    assert_eq!(
        result
            .opsin_read_back
            .expect("read-back")
            .failure_reason
            .as_deref(),
        Some("Naming read-back stopped.")
    );
    assert_eq!(state.inner.read_back_child.tracked_pid(), None);
}

#[test]
fn normal_opsin_read_back_completion_clears_registration_before_shutdown() {
    let root = TestRoot::new("read-back-completed");
    let mut launch = sleeping_read_back(&root);
    launch.opsin = root.0.join("fast.jar");
    let state = NamingEngineState::default();
    let platform = install::current_platform().expect("platform");
    let result = read_back(
        raw(),
        &launch,
        platform.as_ref(),
        &|| false,
        &state.inner.read_back_child,
    );
    assert_eq!(
        result.opsin_read_back.expect("read-back").smiles.as_deref(),
        Some("CCO")
    );
    let pid = fs::read_to_string(root.0.join("fast.started"))
        .expect("stub PID")
        .parse()
        .expect("PID");
    assert!(process_has_exited(pid));
    assert_eq!(state.inner.read_back_child.tracked_pid(), None);
    state.shutdown();
    assert_eq!(state.inner.read_back_child.tracked_pid(), None);
}

#[test]
fn cancel_during_opsin_read_back_releases_the_request_gate_and_allows_retry() {
    let root = TestRoot::new("cancel-read-back");
    let mut launch = sleeping_read_back(&root);
    let state = NamingEngineState::default();
    let worker_state = state.inner.clone();
    let worker_launch = launch.clone();
    let (send, receive) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let platform = install::current_platform().expect("platform");
        let response = with_request(&worker_state, 0, 0, |stopped| {
            Ok(read_back(
                raw(),
                &worker_launch,
                platform.as_ref(),
                stopped,
                &worker_state.read_back_child,
            ))
        });
        send.send(response).expect("result");
    });
    wait_for_read_back(&root);
    assert_eq!(
        with_request(&state.inner, 0, 0, |_| Ok(()))
            .expect_err("busy")
            .code,
        "busy"
    );
    let at_cancel = Instant::now();
    cancel_request(&state.inner.cancels, &state.inner.kill);
    assert_eq!(
        receive
            .recv_timeout(Duration::from_secs(2))
            .expect("bounded cancel")
            .expect_err("cancelled")
            .code,
        "cancelled"
    );
    // Same acknowledgement barrier as naming_cancel; the read-back has stopped before it opens.
    drop(lock(&state.inner.request_gate));
    worker.join().expect("request worker");
    assert!(at_cancel.elapsed() < Duration::from_secs(2));
    launch.opsin = root.0.join("fast.jar");
    let platform = install::current_platform().expect("platform");
    let retry = with_request(&state.inner, 1, 0, |stopped| {
        Ok(read_back(
            raw(),
            &launch,
            platform.as_ref(),
            stopped,
            &state.inner.read_back_child,
        ))
    })
    .expect("retry is not busy");
    assert_eq!(
        retry
            .opsin_read_back
            .expect("verified read-back")
            .smiles
            .as_deref(),
        Some("CCO")
    );
}

#[test]
fn engine_operations_during_opsin_read_back_wait_and_refuse_a_raw_result() {
    // Install and uninstall share the same stop/gate barrier. Exercise both; the removal path
    // also deletes the actual engine trees after the child has stopped.
    for uninstall in [false, true] {
        let root = TestRoot::new(if uninstall {
            "uninstall-read-back"
        } else {
            "install-read-back"
        });
        let launch = sleeping_read_back(&root);
        let paths = InstallPaths {
            app_data: root.0.clone(),
            requirements: root.0.join("unused"),
        };
        fs::create_dir_all(paths.final_dir_for::<NamingSpec>()).expect("installed engine");
        let state = NamingEngineState::default();
        let worker_state = state.inner.clone();
        let (send, receive) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let platform = install::current_platform().expect("platform");
            let response = with_request(&worker_state, 0, 0, |stopped| {
                Ok(read_back(
                    raw(),
                    &launch,
                    platform.as_ref(),
                    stopped,
                    &worker_state.read_back_child,
                ))
            });
            send.send(response).expect("result");
        });
        wait_for_read_back(&root);
        state.inner.installing.store(true, Ordering::SeqCst);
        let at_stop = Instant::now();
        stop_naming_blocking(&state.inner);
        assert!(
            at_stop.elapsed() < Duration::from_secs(2),
            "engine operation waited for OPSIN timeout"
        );
        if uninstall {
            local_engine::install::remove_engine_trees::<NamingSpec>(&paths).expect("uninstall");
            assert!(!paths.final_dir_for::<NamingSpec>().exists());
        }
        assert_eq!(
            receive
                .recv_timeout(Duration::from_secs(2))
                .expect("stopped request")
                .expect_err("no raw result after engine stop")
                .code,
            "engineCrashed"
        );
        worker.join().expect("request worker");
    }
}

#[test]
fn stop_racing_a_completed_read_back_or_a_queued_request_never_returns_a_result() {
    let state = NamingEngineState::default();
    let response = with_request(&state.inner, 0, 0, |_| {
        // Model an uninstall arriving after the last OPSIN read, before return.
        state.inner.stops.fetch_add(1, Ordering::SeqCst);
        Ok(raw())
    });
    assert_eq!(
        response.expect_err("stop wins over result").code,
        "engineCrashed"
    );
    assert_eq!(
        with_request(&state.inner, 0, 0, |_| -> Result<(), NamingError> {
            panic!("request queued before an engine stop must never run");
        })
        .expect_err("stale request")
        .code,
        "engineCrashed"
    );
}

#[test]
fn request_error_during_install_reports_busy() {
    let state = NamingEngineState::default();
    state.inner.installing.store(true, Ordering::SeqCst);
    let error = request_error(&state.inner, 0, 0).expect("install is busy");
    assert_eq!(error.code, "busy");
    assert_eq!(error.message, "The naming engine is being installed.");
}

#[test]
fn capability_is_only_main_and_grants_exactly_six_commands() {
    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../../capabilities/naming-engine.json"))
            .expect("capability");
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    assert!(capability.get("webviews").is_none());
    assert!(capability.get("remote").is_none());
    let expected = serde_json::json!([
        "allow-naming-engine-status",
        "allow-naming-engine-install",
        "allow-naming-engine-cancel-install",
        "allow-naming-engine-uninstall",
        "allow-name-structure-raw",
        "allow-naming-cancel"
    ]);
    assert_eq!(capability["permissions"], expected);
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../../tauri.conf.json")).expect("Tauri config");
    assert_eq!(
        config["bundle"]["resources"]["resources/naming"],
        "resources/naming"
    );
}

#[test]
#[ignore = "Requires an installed naming engine; set CHEMDRAFT_NAMING_ENGINE_DIR to its directory"]
fn real_engine_ethanol_glycine_raw_and_iron_abstention() {
    let root = PathBuf::from(
        std::env::var_os("CHEMDRAFT_NAMING_ENGINE_DIR").expect("installed engine directory"),
    );
    let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
    let platform = install::current_platform().expect("supported platform");
    let launch = LaunchPaths {
        python: platform.venv_python(&root),
        sidecar: resources.join("naming").join("orthonym_sidecar.py"),
        engine: root,
        jre: resources.join("opsin").join("jre"),
        opsin: resources.join("opsin").join("opsin-cli-2.9.0.jar"),
    };
    let mut manager = ProcessManager::system();
    let mut request = |smiles: &str| {
        let raw = manager
            .recognize_with(
                platform.as_ref(),
                &launch,
                smiles,
                process::REQUEST_TIMEOUT,
                &|()| {},
                &|| false,
            )
            .expect("real naming");
        read_back(
            raw,
            &launch,
            platform.as_ref(),
            &|| false,
            &crate::opsin::ReadBackChild::default(),
        )
    };
    let ethanol = request("CCO");
    assert_eq!(ethanol.result.name.as_deref(), Some("ethanol"));
    assert!(ethanol
        .opsin_read_back
        .expect("ethanol read-back")
        .smiles
        .is_some());
    let glycine = request("[NH3+]CC(=O)[O-]");
    assert_eq!(glycine.result.name.as_deref(), Some("glycine"));
    assert!(glycine
        .opsin_read_back
        .expect("glycine read-back")
        .smiles
        .is_some());
    let iron = request("[Fe]");
    assert_eq!(iron.result.tier, "abstain");
    assert_eq!(
        iron.result.limit_code.as_deref(),
        Some("UNSUPPORTED_ELEMENT")
    );
    assert!(iron.result.name.is_none());
    assert!(iron.opsin_read_back.is_none());
}
