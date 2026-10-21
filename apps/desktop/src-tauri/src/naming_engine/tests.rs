use super::*;
use crate::local_engine::{
    platform::{MacArchitecture, MacPlatform, WindowsPlatform},
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
fn intel_mac_is_unsupported_before_install() {
    assert!(install::platform_supported(&MacPlatform::new(MacArchitecture::Aarch64)).is_ok());
    assert!(install::platform_supported(&WindowsPlatform).is_ok());
    let intel = MacPlatform::new(MacArchitecture::X86_64);
    assert!(install::platform_supported(&intel)
        .expect_err("unsupported")
        .contains("Intel"));
    let root = TestRoot::new("intel");
    let paths = InstallPaths {
        app_data: root.0.clone(),
        requirements: root.0.join("absent-lock"),
    };
    struct NoIo;
    impl local_engine::install::InstallIo for NoIo {
        fn download(
            &self,
            _: local_engine::install::Download<'_>,
            _: &Path,
            _: &AtomicBool,
            _: &dyn local_engine::install::ProgressReporter,
        ) -> Result<(), InstallError> {
            panic!("download must not start");
        }
        fn extract_uv(
            &self,
            _: &dyn local_engine::platform::EnginePlatform,
            _: &Path,
            _: &Path,
        ) -> Result<(), InstallError> {
            panic!("extract must not start");
        }
        fn run(
            &self,
            _: &dyn local_engine::platform::EnginePlatform,
            _: local_engine::install::RunStep,
            _: &Path,
            _: &[OsString],
            _: &[(OsString, OsString)],
            _: &AtomicBool,
            _: Option<local_engine::install::RunWatch<'_>>,
        ) -> Result<(), InstallError> {
            panic!("run must not start");
        }
    }
    let error = local_engine::install::install::<NamingSpec>(
        &paths,
        &intel,
        &NoIo,
        &AtomicBool::new(false),
        &|_| {},
        pins::REQUIRED_DISK_BYTES,
    )
    .expect_err("Intel refused");
    assert_eq!(error.code, local_engine::InstallErrorCode::Unsupported);
    assert!(!paths.partial_dir_for::<NamingSpec>().exists());
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
    let result = read_back(raw.clone(), &launch(&root.0), platform.as_ref(), &|| false);
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
    assert!(
        read_back(raw, &launch(&root.0), platform.as_ref(), &|| false)
            .opsin_read_back
            .is_none()
    );
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
            Ok(read_back(raw(), &worker_launch, platform.as_ref(), stopped))
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
        Ok(read_back(raw(), &launch, platform.as_ref(), stopped))
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
                Ok(read_back(raw(), &launch, platform.as_ref(), stopped))
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
    assert!(include_str!("../../tauri.conf.json").contains("resources/naming/**"));
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
        read_back(raw, &launch, platform.as_ref(), &|| false)
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
