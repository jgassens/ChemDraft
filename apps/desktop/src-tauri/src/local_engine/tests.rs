use super::install::{
    self, Download, InstallContext, InstallIo, InstallPaths, ProgressReporter, RunStep, RunWatch,
    RECEIPT_FILE,
};
use super::platform::EnginePlatform;
use super::process::{
    FailureKind, KillSwitch, ProcessFailure, ProcessManager, ProcessMessages, ResponseLine,
    SidecarProtocol,
};
use super::progress::{GrowthEstimator, ProgressThrottle, EMIT_INTERVAL};
use super::*;
use std::collections::VecDeque;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[path = "install_cleanup_tests.rs"]
mod install_cleanup_tests;

const ABC_SHA: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const EMPTY_SHA: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

fn shell_command(script: &str) -> (PathBuf, Vec<OsString>) {
    if cfg!(windows) {
        (
            PathBuf::from("cmd.exe"),
            vec!["/C".into(), OsString::from(script)],
        )
    } else {
        (
            PathBuf::from("sh"),
            vec!["-c".into(), OsString::from(script)],
        )
    }
}

fn failing_script(message: &str) -> String {
    if cfg!(windows) {
        format!("echo {message} 1>&2 & exit /b 2")
    } else {
        format!("printf '%s\\n' '{message}' >&2; exit 2")
    }
}

#[test]
fn uv_failure_includes_its_stderr_tail() {
    let io = install::SystemInstallIo::<Stub>::from_builder(reqwest::blocking::Client::builder())
        .expect("system io");
    let (program, args) = shell_command(&failing_script("Missing expected target directory"));
    let error = io
        .run(
            &StubPlatform,
            RunStep::InstallPython,
            &program,
            &args,
            &[],
            &AtomicBool::new(false),
            None,
        )
        .expect_err("child fails");

    assert_eq!(error.code, InstallErrorCode::Failed);
    assert!(
        error.message.contains("Missing expected target directory"),
        "stderr tail missing from {}",
        error.message
    );
}

#[test]
fn uv_large_stderr_is_drained_and_truncated() {
    let io = install::SystemInstallIo::<Stub>::from_builder(reqwest::blocking::Client::builder())
        .expect("system io");
    let script = if cfg!(windows) {
        "for /L %i in (1,1,20000) do @echo 012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789 1>&2 & exit /b 2"
    } else {
        "head -c 1100000 /dev/zero | tr '\\0' x >&2; printf '\\nfinal stderr line\\n' >&2; exit 2"
    };
    let (program, args) = shell_command(script);
    let started = Instant::now();
    let error = io
        .run(
            &StubPlatform,
            RunStep::InstallPackages,
            &program,
            &args,
            &[],
            &AtomicBool::new(false),
            None,
        )
        .expect_err("child fails");

    assert!(
        started.elapsed() < Duration::from_secs(10),
        "large stderr child was not drained"
    );
    assert!(error.message.contains("final stderr line"));
    assert!(error.message.len() <= 5 * 1024, "tail was not bounded");
}

// A second spec overrides only the additive install option; all other fixture policy delegates.
struct CompiledStub;
macro_rules! delegate_stub {
    ($($name:ident ($($arg:ident : $ty:ty),*) -> $out:ty;)*) => {
        $(fn $name($($arg: $ty),*) -> $out { Stub::$name($($arg),*) })*
    };
}
impl EngineSpec for CompiledStub {
    type Receipt = serde_json::Value;
    const DIR_NAME: &'static str = "compiled-stub";
    const LOG_PREFIX: &'static str = "[compiled-stub]";
    const USER_AGENT: &'static str = "compiled-stub/1";
    fn pip_install_args() -> Vec<OsString> {
        vec!["--compile-bytecode".into()]
    }
    delegate_stub! {
        python_version() -> &'static str;
        required_disk_bytes() -> u64;
        requirements() -> (&'static str, &'static str);
        python_growth_bytes() -> u64;
        packages_growth_bytes() -> u64;
        packages_label() -> &'static str;
        packages_message() -> &'static str;
        installed_message() -> &'static str;
        insufficient_disk(free: u64) -> InstallError;
        cancelled() -> InstallError;
        failed_io(error: std::io::Error) -> InstallError;
        relocation_error(error: std::io::Error) -> InstallError;
        platform_supported(platform: &dyn EnginePlatform) -> Result<(), String>;
        before_packages(context: &InstallContext<'_>) -> Result<(), InstallError>;
        extra_steps(context: &InstallContext<'_>) -> Result<(), InstallError>;
        probe_args() -> Vec<OsString>;
        verify_layout(root: &Path, platform: &dyn EnginePlatform) -> Result<(), InstallError>;
        receipt(platform: &dyn EnginePlatform, disk: u64) -> Self::Receipt;
        read_current_receipt(path: &Path) -> Option<Self::Receipt>;
        matches_pins(receipt: &Self::Receipt, platform: &dyn EnginePlatform) -> bool;
        write_receipt(path: &Path, receipt: &Self::Receipt) -> Result<(), InstallError>;
        is_restorable(root: &Path, platform: &dyn EnginePlatform) -> bool;
    }
}

#[test]
fn extra_pip_arguments_are_additive_and_default_argv_is_unchanged() {
    let args = |compiled| {
        if compiled {
            install::pip_install_args::<CompiledStub>("python".into(), "requirements.txt".into())
        } else {
            install::pip_install_args::<Stub>("python".into(), "requirements.txt".into())
        }
    };
    let legacy = install::os_args([
        "pip",
        "install",
        "--python",
        "python",
        "--require-hashes",
        "--requirement",
        "requirements.txt",
    ]);
    assert_eq!(args(false), legacy);
    let mut compiled = legacy;
    compiled.insert(5, "--compile-bytecode".into());
    assert_eq!(args(true), compiled);
}

struct Stub;
struct StubPlatform;
impl EnginePlatform for StubPlatform {
    fn uv_asset(&self) -> &'static str {
        "stub.tar.gz"
    }
    fn uv_sha256(&self) -> &'static str {
        ABC_SHA
    }
    fn uv_executable(&self, root: &Path) -> PathBuf {
        root.join("uv-stub")
    }
    fn venv_python(&self, root: &Path) -> PathBuf {
        root.join("venv").join("python-stub")
    }
    fn configure_child(&self, _command: &mut Command) {}
}
impl EngineSpec for Stub {
    type Receipt = serde_json::Value;
    const DIR_NAME: &'static str = "stub-engine";
    const LOG_PREFIX: &'static str = "[stub]";
    const USER_AGENT: &'static str = "stub/1";
    fn python_version() -> &'static str {
        "3.12"
    }
    fn required_disk_bytes() -> u64 {
        100
    }
    fn requirements() -> (&'static str, &'static str) {
        ("stub/requirements.txt", EMPTY_SHA)
    }
    fn python_growth_bytes() -> u64 {
        100
    }
    fn packages_growth_bytes() -> u64 {
        200
    }
    fn packages_label() -> &'static str {
        "Stub packages"
    }
    fn packages_message() -> &'static str {
        "Installing stub packages."
    }
    fn installed_message() -> &'static str {
        "Stub installed."
    }
    fn insufficient_disk(_free: u64) -> InstallError {
        InstallError {
            code: InstallErrorCode::InsufficientDisk,
            message: "stub disk".into(),
        }
    }
    fn cancelled() -> InstallError {
        InstallError {
            code: InstallErrorCode::Cancelled,
            message: "stub cancelled".into(),
        }
    }
    fn failed_io(error: std::io::Error) -> InstallError {
        InstallError::failed(error.to_string())
    }
    fn relocation_error(error: std::io::Error) -> InstallError {
        Self::failed_io(error)
    }
    fn platform_supported(_platform: &dyn EnginePlatform) -> Result<(), String> {
        Ok(())
    }
    fn before_packages(_context: &InstallContext<'_>) -> Result<(), InstallError> {
        Ok(())
    }
    fn extra_steps(context: &InstallContext<'_>) -> Result<(), InstallError> {
        context.io.download(
            Download {
                url: "https://fixture.invalid/extra",
                sha256: ABC_SHA,
                size: Some(3),
                phase: InstallPhase::DownloadingModel,
            },
            &context.root.join("extra"),
            context.cancel,
            context.progress,
        )
    }
    fn probe_args() -> Vec<OsString> {
        vec!["-I".into(), "-B".into(), "probe".into()]
    }
    fn verify_layout(root: &Path, platform: &dyn EnginePlatform) -> Result<(), InstallError> {
        if platform.uv_executable(root).is_file()
            && platform.venv_python(root).is_file()
            && root.join("extra").is_file()
        {
            Ok(())
        } else {
            Err(InstallError::failed("stub layout"))
        }
    }
    fn receipt(_platform: &dyn EnginePlatform, _disk_bytes: u64) -> Self::Receipt {
        serde_json::json!({"receiptVersion": 7, "stub": true})
    }
    fn read_current_receipt(path: &Path) -> Option<Self::Receipt> {
        serde_json::from_slice(&fs::read(path).ok()?).ok()
    }
    fn matches_pins(receipt: &Self::Receipt, _platform: &dyn EnginePlatform) -> bool {
        receipt == &serde_json::json!({"receiptVersion": 7, "stub": true})
    }
    fn write_receipt(path: &Path, receipt: &Self::Receipt) -> Result<(), InstallError> {
        super::receipt::write_receipt::<Self>(path, receipt)
    }
    fn is_restorable(root: &Path, platform: &dyn EnginePlatform) -> bool {
        install::is_healthy::<Self>(root, platform)
    }
}

struct FixtureRoot(PathBuf);
impl FixtureRoot {
    fn new(label: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "chemdraft-local-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).expect("fixture directory");
        Self(root)
    }
    fn paths(&self) -> InstallPaths {
        let requirements = self.0.join("source-requirements.txt");
        fs::write(&requirements, b"").expect("requirements");
        InstallPaths {
            app_data: self.0.clone(),
            requirements,
        }
    }
}
impl Drop for FixtureRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[cfg(unix)]
#[test]
fn relocation_preserves_directory_symlink() {
    assert_directory_link_relocation(false, false);
}

#[cfg(windows)]
#[test]
fn relocation_preserves_directory_junction_without_symlink_privilege() {
    assert_directory_link_relocation(true, false);
}

#[cfg(windows)]
#[test]
fn relocation_rebases_directory_junction_with_only_verbatim_prefixes() {
    assert_directory_link_relocation(true, true);
}

fn assert_directory_link_relocation(junction: bool, verbatim_rebases: bool) {
    let fixture = FixtureRoot::new("relocate-link");
    let canonical_root = fs::canonicalize(&fixture.0).expect("absolute fixture root");
    let root = install::normalize_verbatim_path(&canonical_root);
    let partial = root.join("engine.partial");
    let installed = root.join("engine");
    let python = Path::new("python").join("cpython-3.10.20");
    let alias = Path::new("python").join("cpython-3.10");
    fs::create_dir_all(partial.join(&python)).expect("managed Python directory");
    fs::write(partial.join(&python).join("python.exe"), b"python").expect("interpreter fixture");
    install::create_link(
        &canonical_root.join("engine.partial").join(&python),
        &partial.join(&alias),
        junction,
    )
    .expect("directory link without elevation");
    assert_eq!(
        fs::read_link(partial.join(&alias)).expect("plain absolute target"),
        partial.join(&python)
    );
    assert_eq!(
        install::is_junction(&partial.join(&alias)).unwrap(),
        junction
    );
    fs::rename(&partial, &installed).expect("commit staged tree");
    assert!(
        !installed.join(&alias).exists(),
        "old target is now missing"
    );

    let rebases = if verbatim_rebases {
        assert_ne!(
            canonical_root, root,
            "regression requires verbatim prefixes"
        );
        vec![(
            canonical_root.join("engine.partial"),
            canonical_root.join("engine"),
        )]
    } else {
        vec![(partial.clone(), installed.clone())]
    };
    install::relocate_staged_tree(&installed, &rebases).expect("relocate directory link");

    let link = installed.join(&alias);
    assert_eq!(install::is_junction(&link).unwrap(), junction);
    let target = fs::read_link(&link).expect("relocated target");
    assert!(target.is_absolute());
    assert_eq!(target, installed.join(&python));
    assert_eq!(fs::read(link.join("python.exe")).unwrap(), b"python");
    assert!(!partial.exists(), "relocation must not recreate staging");
}

#[cfg(windows)]
#[test]
fn normalize_verbatim_drive_path() {
    assert_eq!(
        install::normalize_verbatim_path(Path::new(r"\\?\C:\engine.partial\python")),
        Path::new(r"C:\engine.partial\python")
    );
}

#[cfg(windows)]
#[test]
fn normalize_verbatim_unc_path() {
    assert_eq!(
        install::normalize_verbatim_path(Path::new(r"\\?\UNC\server\share\engine.partial\python")),
        Path::new(r"\\server\share\engine.partial\python")
    );
}

#[cfg(windows)]
#[test]
fn normalize_verbatim_leaves_plain_paths_unchanged() {
    for path in [r"C:\engine\python", r"\\server\share\engine\python"] {
        assert_eq!(
            install::normalize_verbatim_path(Path::new(path)),
            Path::new(path)
        );
    }
}

#[cfg(windows)]
#[test]
fn normalize_verbatim_leaves_relative_paths_unchanged() {
    let path = Path::new(r"engine.partial\python");
    assert_eq!(install::normalize_verbatim_path(path), path);
}

#[cfg(not(windows))]
#[test]
fn normalize_verbatim_leaves_unix_paths_unchanged() {
    for path in [
        "/engine.partial/python",
        "engine.partial/python",
        r"\\?\C:\python",
        r"\\?\UNC\server\share",
    ] {
        assert_eq!(
            install::normalize_verbatim_path(Path::new(path)),
            Path::new(path)
        );
    }
}

#[derive(Default)]
struct FixtureIo {
    bad_sha: bool,
    fail_probe: bool,
    cancel_probe: bool,
    probes: AtomicUsize,
    commands: Mutex<Vec<&'static str>>,
    #[cfg(windows)]
    fail_rewrite: bool,
    #[cfg(windows)]
    cancel_rewrite: bool,
    #[cfg(windows)]
    rewrites: AtomicUsize,
}
impl InstallIo for FixtureIo {
    fn download(
        &self,
        spec: Download<'_>,
        destination: &Path,
        _cancel: &AtomicBool,
        _progress: &dyn ProgressReporter,
    ) -> Result<(), InstallError> {
        let bytes = if self.bad_sha && destination.ends_with("extra") {
            &b"bad"[..]
        } else {
            &b"abc"[..]
        };
        // The same digest gate as streamed production IO, fed deterministic fixture bytes.
        let (size, digest) = super::pins::sha256_reader(bytes).expect("digest");
        super::pins::verify_digest(size, &digest, spec.size, spec.sha256)
            .map_err(InstallError::checksum)?;
        fs::write(destination, bytes).map_err(Stub::failed_io)
    }
    fn extract_uv(
        &self,
        _platform: &dyn EnginePlatform,
        _archive: &Path,
        destination: &Path,
    ) -> Result<(), InstallError> {
        fs::write(destination, b"uv").map_err(Stub::failed_io)
    }
    fn run(
        &self,
        platform: &dyn EnginePlatform,
        step: RunStep,
        program: &Path,
        args: &[OsString],
        env: &[(OsString, OsString)],
        cancel: &AtomicBool,
        watch: Option<RunWatch<'_>>,
    ) -> Result<(), InstallError> {
        let name = match step {
            RunStep::InstallPython => "python",
            RunStep::CreateVenv => "venv",
            RunStep::InstallPackages => "packages",
            RunStep::Extra => "extra",
            RunStep::VerifyEnvironment => "probe",
            #[cfg(windows)]
            RunStep::RewriteVenvLaunchers => "rewrite",
        };
        self.commands.lock().expect("commands").push(name);
        #[cfg(not(windows))]
        let _ = env;
        let partial = program.parent().expect("program parent");
        if let RunStep::CreateVenv = step {
            let python = platform.venv_python(partial);
            fs::create_dir_all(python.parent().expect("python parent")).map_err(Stub::failed_io)?;
            fs::write(python, b"python").map_err(Stub::failed_io)?;
            fs::write(
                partial.join("venv").join("pyvenv.cfg"),
                format!("home = {}\n", partial.join("python").display()),
            )
            .map_err(Stub::failed_io)?;
            #[cfg(windows)]
            {
                let managed = partial
                    .join("python")
                    .join("cpython-3.12.99-windows-x86_64-none");
                fs::create_dir_all(&managed).map_err(Stub::failed_io)?;
                fs::write(managed.join("python.exe"), b"managed python")
                    .map_err(Stub::failed_io)?;
                install::create_link(
                    &managed,
                    &partial
                        .join("python")
                        .join("cpython-3.12-windows-x86_64-none"),
                    true,
                )
                .map_err(Stub::failed_io)?;
            }
        }
        #[cfg(windows)]
        if let RunStep::RewriteVenvLaunchers = step {
            let root = program.parent().expect("uv parent");
            assert!(root.ends_with(Stub::DIR_NAME), "rewrite runs after swap");
            assert_eq!(program, StubPlatform.uv_executable(root));
            let managed = root
                .join("python")
                .join("cpython-3.12-windows-x86_64-none")
                .join("python.exe");
            assert!(
                managed.is_file(),
                "junction relocation precedes launcher rewrite"
            );
            let config = fs::read_to_string(root.join("venv").join("pyvenv.cfg")).expect("config");
            assert!(
                !config.contains(".partial"),
                "config relocation precedes launcher rewrite"
            );
            assert_eq!(
                args,
                [
                    OsString::from("venv"),
                    root.join("venv").into_os_string(),
                    OsString::from("--allow-existing"),
                    OsString::from("--offline"),
                    OsString::from("--python"),
                    managed.into_os_string(),
                    OsString::from("--python-preference"),
                    OsString::from("only-managed"),
                    OsString::from("--relocatable"),
                ]
            );
            for (key, dir) in [
                ("UV_PYTHON_INSTALL_DIR", "python"),
                ("UV_PYTHON_BIN_DIR", "python-bin"),
                ("UV_STATE_DIR", "uv-state"),
                ("UV_CACHE_DIR", "download-cache"),
                ("TMPDIR", "temp"),
                ("TMP", "temp"),
                ("TEMP", "temp"),
            ] {
                assert!(env.contains(&(OsString::from(key), root.join(dir).into_os_string())));
            }
            assert!(env.contains(&(OsString::from("UV_NO_CONFIG"), OsString::from("1"))));
            assert!(watch.is_none());
            fs::create_dir_all(root.join("download-cache")).expect("uv cache");
            fs::write(root.join("download-cache").join("cache"), b"scratch").expect("cache");
            let first = self.rewrites.fetch_add(1, Ordering::SeqCst) == 0;
            if first && self.cancel_rewrite {
                cancel.store(true, Ordering::SeqCst);
                return Err(Stub::cancelled());
            }
            if first && self.fail_rewrite {
                return Err(InstallError::failed("launcher refused"));
            }
        }
        if let RunStep::VerifyEnvironment = step {
            self.probes.fetch_add(1, Ordering::Relaxed);
            let final_dir = program.parent().expect("venv").parent().expect("engine");
            assert!(final_dir.ends_with(Stub::DIR_NAME), "probe runs after swap");
            assert!(
                !final_dir.join(RECEIPT_FILE).exists(),
                "receipt written last"
            );
            #[cfg(windows)]
            assert_eq!(
                self.commands.lock().expect("commands").iter().rev().nth(1),
                Some(&"rewrite"),
                "launcher rewrite precedes probe",
            );
            assert_eq!(args, Stub::probe_args());
            if self.cancel_probe {
                cancel.store(true, Ordering::SeqCst);
                return Err(Stub::cancelled());
            }
            if self.fail_probe {
                return Err(InstallError::failed("probe refused"));
            }
        }
        if let Some(mut watch) = watch {
            watch.progress.report(watch.estimator.finished());
        }
        Ok(())
    }
}
fn run_install(paths: &InstallPaths, io: &FixtureIo) -> Result<serde_json::Value, InstallError> {
    install::install::<Stub>(
        paths,
        &StubPlatform,
        io,
        &AtomicBool::new(false),
        &|_| {},
        100,
    )
}
fn assert_clean(paths: &InstallPaths) {
    assert!(!paths.partial_dir_for::<Stub>().exists());
    assert!(!paths
        .final_dir_for::<Stub>()
        .join("download-cache")
        .exists());
    assert!(!paths.final_dir_for::<Stub>().join("temp").exists());
    assert!(!paths.previous_dir_for::<Stub>().exists());
    assert!(!fs::read_dir(&paths.app_data)
        .expect("entries")
        .flatten()
        .any(|entry| entry
            .file_name()
            .to_string_lossy()
            .starts_with("stub-engine.discard-")));
}
#[test]
fn stub_transaction_stages_then_probes_in_final_location_and_writes_receipt_last() {
    let fixture = FixtureRoot::new("transaction");
    let paths = fixture.paths();
    let io = FixtureIo::default();
    run_install(&paths, &io).expect("install");
    assert_eq!(io.probes.load(Ordering::Relaxed), 1);
    assert!(install::is_healthy::<Stub>(
        &paths.final_dir_for::<Stub>(),
        &StubPlatform
    ));
    assert!(!paths
        .final_dir_for::<Stub>()
        .join("install.json.tmp")
        .exists());
    assert_clean(&paths);
    install::remove_engine_trees::<Stub>(&paths).expect("uninstall");
    assert!(!paths.final_dir_for::<Stub>().exists());
}
#[cfg(not(windows))]
#[test]
fn unix_launcher_refresh_is_a_noop_and_install_issues_no_extra_command() {
    let fixture = FixtureRoot::new("unix-launcher");
    let paths = fixture.paths();
    let io = FixtureIo::default();
    install::rewrite_venv_launchers::<Stub>(
        Path::new("missing"),
        &StubPlatform,
        &io,
        &AtomicBool::new(false),
    )
    .expect("Unix no-op");
    assert!(io.commands.lock().expect("commands").is_empty());
    run_install(&paths, &io).expect("install");
    assert_eq!(
        *io.commands.lock().expect("commands"),
        ["python", "venv", "packages", "probe"]
    );
}

#[cfg(windows)]
#[test]
fn windows_launcher_rewrite_uses_final_paths_after_relocation_before_probe() {
    let fixture = FixtureRoot::new("windows-launcher");
    let paths = fixture.paths();
    let io = FixtureIo::default();
    run_install(&paths, &io).expect("install");
    assert_eq!(
        *io.commands.lock().expect("commands"),
        ["python", "venv", "packages", "rewrite", "probe"]
    );
    assert_clean(&paths);
}

#[cfg(windows)]
#[test]
fn windows_launcher_failure_and_cancel_roll_back_with_and_without_a_previous_install() {
    for previous in [false, true] {
        for cancelled in [false, true] {
            let fixture = FixtureRoot::new("windows-launcher-rollback");
            let paths = fixture.paths();
            if previous {
                run_install(&paths, &FixtureIo::default()).expect("original");
                fs::write(paths.final_dir_for::<Stub>().join("marker"), b"old").expect("marker");
            }
            let io = FixtureIo {
                fail_rewrite: !cancelled,
                cancel_rewrite: cancelled,
                ..Default::default()
            };
            let error = run_install(&paths, &io).expect_err("rewrite refused");
            assert_eq!(
                error.code,
                if cancelled {
                    InstallErrorCode::Cancelled
                } else {
                    InstallErrorCode::Failed
                }
            );
            assert!(error.message.contains("venv launchers"), "step is named");
            assert_eq!(
                io.probes.load(Ordering::SeqCst),
                0,
                "never probe stale launchers"
            );
            if previous {
                assert_eq!(
                    fs::read(paths.final_dir_for::<Stub>().join("marker")).expect("restored"),
                    b"old"
                );
                assert_eq!(
                    io.rewrites.load(Ordering::SeqCst),
                    if cancelled { 1 } else { 2 },
                    "rollback refreshes launchers unless already cancelled"
                );
            } else {
                assert!(!paths.final_dir_for::<Stub>().exists());
            }
            assert_clean(&paths);
        }
    }
}

#[cfg(windows)]
#[test]
fn windows_reconcile_refreshes_launchers_and_preserves_previous_on_failure_or_cancel() {
    for cancelled in [false, true] {
        let fixture = FixtureRoot::new("windows-reconcile");
        let paths = fixture.paths();
        run_install(&paths, &FixtureIo::default()).expect("original");
        fs::rename(
            paths.final_dir_for::<Stub>(),
            paths.previous_dir_for::<Stub>(),
        )
        .expect("interrupted swap");
        let io = FixtureIo {
            fail_rewrite: !cancelled,
            cancel_rewrite: cancelled,
            ..Default::default()
        };
        install::remove_stale_staging::<Stub>(&paths, &StubPlatform, &io, &AtomicBool::new(false));
        assert!(
            paths
                .previous_dir_for::<Stub>()
                .join(RECEIPT_FILE)
                .is_file(),
            "previous preserved"
        );
        assert!(!paths.final_dir_for::<Stub>().exists());
        let retry = FixtureIo::default();
        install::remove_stale_staging::<Stub>(
            &paths,
            &StubPlatform,
            &retry,
            &AtomicBool::new(false),
        );
        assert_eq!(*retry.commands.lock().expect("commands"), ["rewrite"]);
        assert!(install::is_healthy::<Stub>(
            &paths.final_dir_for::<Stub>(),
            &StubPlatform
        ));
        assert_clean(&paths);
    }
}

#[cfg(windows)]
#[test]
fn windows_reinstall_discards_broken_recovery_but_cancel_still_aborts() {
    for cancelled in [false, true] {
        for fail_probe in [false, true] {
            let fixture = FixtureRoot::new("windows-reinstall-recovery");
            let paths = fixture.paths();
            run_install(&paths, &FixtureIo::default()).expect("original");
            fs::write(paths.final_dir_for::<Stub>().join("marker"), b"old").expect("marker");
            fs::rename(
                paths.final_dir_for::<Stub>(),
                paths.previous_dir_for::<Stub>(),
            )
            .expect("interrupted swap");
            let io = FixtureIo {
                fail_rewrite: !cancelled,
                cancel_rewrite: cancelled,
                fail_probe,
                ..Default::default()
            };
            let result = run_install(&paths, &io);
            if cancelled {
                assert_eq!(
                    result.expect_err("cancelled").code,
                    InstallErrorCode::Cancelled
                );
                assert!(paths.previous_dir_for::<Stub>().join("marker").is_file());
                assert!(!paths.final_dir_for::<Stub>().exists());
                assert!(!paths.partial_dir_for::<Stub>().exists());
                assert_eq!(io.probes.load(Ordering::SeqCst), 0);
            } else {
                if fail_probe {
                    assert!(result
                        .expect_err("new probe failed")
                        .message
                        .contains("probe refused"));
                    assert!(
                        !paths.final_dir_for::<Stub>().exists(),
                        "broken engine never restored"
                    );
                } else {
                    result.expect("fresh install replaces broken recovery");
                    assert!(install::is_healthy::<Stub>(
                        &paths.final_dir_for::<Stub>(),
                        &StubPlatform
                    ));
                    assert!(!paths.final_dir_for::<Stub>().join("marker").exists());
                }
                assert_eq!(io.probes.load(Ordering::SeqCst), 1);
                assert_clean(&paths);
            }
        }
    }
}

#[test]
fn bad_sha_and_post_swap_probe_failure_preserve_the_previous_install() {
    let fixture = FixtureRoot::new("rollback");
    let paths = fixture.paths();
    run_install(&paths, &FixtureIo::default()).expect("original");
    let marker = paths.final_dir_for::<Stub>().join("marker");
    fs::write(&marker, b"old").expect("marker");
    for (io, code) in [
        (
            FixtureIo {
                bad_sha: true,
                ..Default::default()
            },
            InstallErrorCode::ChecksumMismatch,
        ),
        (
            FixtureIo {
                fail_probe: true,
                ..Default::default()
            },
            InstallErrorCode::Failed,
        ),
        (
            FixtureIo {
                cancel_probe: true,
                ..Default::default()
            },
            InstallErrorCode::Cancelled,
        ),
    ] {
        assert_eq!(run_install(&paths, &io).expect_err("refusal").code, code);
        assert_eq!(fs::read(&marker).expect("restored"), b"old");
        assert!(install::is_healthy::<Stub>(
            &paths.final_dir_for::<Stub>(),
            &StubPlatform
        ));
        assert_clean(&paths);
    }
}
#[test]
fn stub_disk_and_cancel_refuse_before_staging_and_startup_restores_a_previous_tree() {
    let fixture = FixtureRoot::new("sweep");
    let paths = fixture.paths();
    let io = FixtureIo::default();
    for (free, cancel, code) in [
        (99, false, InstallErrorCode::InsufficientDisk),
        (100, true, InstallErrorCode::Cancelled),
    ] {
        let error = install::install::<Stub>(
            &paths,
            &StubPlatform,
            &io,
            &AtomicBool::new(cancel),
            &|_| {},
            free,
        )
        .expect_err("refused");
        assert_eq!(error.code, code);
        assert!(!paths.partial_dir_for::<Stub>().exists());
    }
    run_install(&paths, &io).expect("install");
    fs::rename(
        paths.final_dir_for::<Stub>(),
        paths.previous_dir_for::<Stub>(),
    )
    .expect("interrupted swap");
    fs::create_dir_all(paths.partial_dir_for::<Stub>()).expect("stale stage");
    install::remove_stale_staging::<Stub>(&paths, &StubPlatform, &io, &AtomicBool::new(false));
    assert!(install::is_healthy::<Stub>(
        &paths.final_dir_for::<Stub>(),
        &StubPlatform
    ));
    assert_clean(&paths);
}
#[test]
fn stub_progress_growth_is_monotonic_capped_and_throttled_until_completion() {
    let fixture = FixtureRoot::new("progress");
    let watched = fixture.0.join("cache");
    fs::create_dir(&watched).expect("cache");
    let mut estimator = GrowthEstimator::new(
        InstallPhase::InstallingPackages,
        Stub::packages_label(),
        vec![watched.clone()],
        Stub::packages_growth_bytes(),
    );
    let mut throttle = ProgressThrottle::new(EMIT_INTERVAL);
    let now = Instant::now();
    let first = estimator.sample();
    assert!(throttle.admit(&first, now));
    assert_eq!(first.bytes_done, Some(0));
    fs::write(watched.join("a"), vec![0; 300]).expect("growth");
    let grown = estimator.sample();
    assert_eq!(grown.bytes_done, Some(198));
    assert!(grown.estimated);
    assert!(!throttle.admit(&grown, now));
    fs::remove_file(watched.join("a")).expect("cache removed");
    assert_eq!(estimator.sample().bytes_done, Some(198));
    let finished = estimator.finished();
    assert_eq!(finished.bytes_done, Some(200));
    assert!(throttle.admit(&finished, now));
}

#[derive(Debug, PartialEq)]
enum StubError {
    Crash(String),
    Timeout,
    Cancelled,
    Declined,
}
impl ProcessFailure for StubError {
    fn cancelled() -> Self {
        Self::Cancelled
    }
    fn timeout() -> Self {
        Self::Timeout
    }
    fn crashed(message: String) -> Self {
        Self::Crash(message)
    }
    fn kind(&self) -> FailureKind {
        match self {
            Self::Crash(_) => FailureKind::Crashed,
            Self::Timeout => FailureKind::Timeout,
            Self::Cancelled => FailureKind::Cancelled,
            Self::Declined => FailureKind::Answer,
        }
    }
}
struct StubWorker {
    outcomes: Arc<Mutex<VecDeque<Result<String, StubError>>>>,
    stops: Arc<AtomicUsize>,
}
struct StubSpawner {
    outcomes: Arc<Mutex<VecDeque<Result<String, StubError>>>>,
    stops: Arc<AtomicUsize>,
    spawns: AtomicUsize,
    kill_during_spawn: bool,
}
impl StubSpawner {
    fn new(outcomes: Vec<Result<String, StubError>>) -> Arc<Self> {
        Arc::new(Self {
            outcomes: Arc::new(Mutex::new(outcomes.into())),
            stops: Arc::default(),
            spawns: AtomicUsize::new(0),
            kill_during_spawn: false,
        })
    }
}
impl SidecarProtocol for Stub {
    type Input = str;
    type Response = String;
    type Progress = &'static str;
    type Error = StubError;
    type LaunchPaths = ();
    type Process = StubWorker;
    type Spawner = StubSpawner;
    const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
    const LOG_PREFIX: &'static str = "[stub]";
    const REQUEST_PREFIX: &'static str = "stub-";
    fn system_spawner() -> Arc<Self::Spawner> {
        StubSpawner::new(vec![])
    }
    fn spawn(
        spawner: &Self::Spawner,
        _platform: &dyn EnginePlatform,
        _paths: &(),
        _timeout: Duration,
        kill: &KillSwitch,
    ) -> Result<Box<Self::Process>, StubError> {
        spawner.spawns.fetch_add(1, Ordering::Relaxed);
        if spawner.kill_during_spawn {
            kill.kill_now();
            kill.arm(Box::new(|| {}));
            return Err(StubError::Crash("loading".into()));
        }
        Ok(Box::new(StubWorker {
            outcomes: spawner.outcomes.clone(),
            stops: spawner.stops.clone(),
        }))
    }
    fn recognize(
        process: &mut Self::Process,
        id: &str,
        _input: &str,
        _timeout: Duration,
        progress: &dyn Fn(Self::Progress),
    ) -> Result<String, StubError> {
        assert!(id.starts_with("stub-"));
        progress("working");
        process
            .outcomes
            .lock()
            .expect("outcomes")
            .pop_front()
            .expect("fixture outcome")
    }
    fn shutdown(process: &mut Self::Process) {
        process.stops.fetch_add(1, Ordering::Relaxed);
    }
    fn starting() -> Self::Progress {
        "starting"
    }
    fn configure_command(_paths: &()) -> Command {
        panic!("manager fixture does not spawn native processes")
    }
    fn ready(_line: &str) -> Result<(), StubError> {
        Ok(())
    }
    fn encode(_id: &str, input: &str) -> Result<String, StubError> {
        Ok(input.into())
    }
    fn classify(line: &str, _id: &str) -> ResponseLine<Self> {
        ResponseLine::Final(Ok(line.into()))
    }
    fn shutdown_line() -> Result<String, StubError> {
        Ok("shutdown".into())
    }
    fn messages() -> ProcessMessages {
        ProcessMessages {
            stopped: "stub stopped",
            stopped_twice: "stub stopped twice",
            start: "start: ",
            input: "input",
            output: "output",
            log: "log",
            exited: "exit ",
            closed: "closed",
            inspect: "inspect: ",
            inspect_request: "inspect: ",
            not_running: "not running",
            send: "send: ",
        }
    }
}
#[test]
fn stub_manager_reuses_a_worker_retries_one_crash_and_reaps_on_idle() {
    let spawner = StubSpawner::new(vec![
        Err(StubError::Crash("gone".into())),
        Ok("first".into()),
        Ok("second".into()),
    ]);
    let mut manager = ProcessManager::<Stub>::new(spawner.clone());
    let events = Mutex::new(Vec::new());
    assert_eq!(
        manager.recognize_with(
            &StubPlatform,
            &(),
            "input",
            Duration::from_secs(1),
            &|event| events.lock().expect("events").push(event),
            &|| false
        ),
        Ok("first".into())
    );
    assert_eq!(
        events.into_inner().expect("events"),
        vec!["starting", "working", "starting", "working"]
    );
    assert_eq!(
        manager.recognize(&StubPlatform, &(), "input", Duration::from_secs(1)),
        Ok("second".into())
    );
    assert_eq!(spawner.spawns.load(Ordering::Relaxed), 2);
    assert!(!manager.stop_if_idle(Instant::now()));
    assert!(manager.stop_if_idle(Instant::now() + <Stub as SidecarProtocol>::IDLE_TIMEOUT));
    assert_eq!(spawner.stops.load(Ordering::Relaxed), 2);
}
#[test]
fn stub_manager_timeout_and_decline_are_not_retried_and_early_cancel_never_spawns() {
    let spawner = StubSpawner::new(vec![Err(StubError::Timeout), Err(StubError::Declined)]);
    let mut manager = ProcessManager::<Stub>::new(spawner.clone());
    assert_eq!(
        manager.recognize_with(
            &StubPlatform,
            &(),
            "input",
            Duration::from_secs(1),
            &|_| {},
            &|| true
        ),
        Err(StubError::Cancelled)
    );
    assert_eq!(spawner.spawns.load(Ordering::Relaxed), 0);
    assert_eq!(
        manager.recognize(&StubPlatform, &(), "input", Duration::from_secs(1)),
        Err(StubError::Timeout)
    );
    assert_eq!(spawner.spawns.load(Ordering::Relaxed), 1);
    assert_eq!(
        manager.recognize(&StubPlatform, &(), "input", Duration::from_secs(1)),
        Err(StubError::Declined)
    );
    assert_eq!(spawner.spawns.load(Ordering::Relaxed), 2);
    assert!(manager.process.is_some());
    assert!(
        !manager.kill_switch().cancel_request(),
        "idle worker is not killed"
    );
}
#[test]
fn stub_manager_kill_while_loading_never_retries_and_a_second_crash_stops() {
    let spawner = Arc::new(StubSpawner {
        kill_during_spawn: true,
        ..Arc::try_unwrap(StubSpawner::new(vec![]))
            .ok()
            .expect("sole owner")
    });
    let mut manager = ProcessManager::<Stub>::new(spawner.clone());
    assert_eq!(
        manager.recognize(&StubPlatform, &(), "input", Duration::from_secs(1)),
        Err(StubError::Cancelled)
    );
    assert_eq!(spawner.spawns.load(Ordering::Relaxed), 1);
    let spawner = StubSpawner::new(vec![
        Err(StubError::Crash("first".into())),
        Err(StubError::Crash("second".into())),
    ]);
    let mut manager = ProcessManager::<Stub>::new(spawner.clone());
    assert_eq!(
        manager.recognize(&StubPlatform, &(), "input", Duration::from_secs(1)),
        Err(StubError::Crash("second".into()))
    );
    assert_eq!(spawner.spawns.load(Ordering::Relaxed), 2);
    assert!(manager.process.is_none());
}
#[test]
fn version_dispatch_is_schema_neutral_and_rejects_invalid_values() {
    use super::receipt::receipt_version;
    assert_eq!(receipt_version(&serde_json::json!({}), 1, 7, "stub"), Ok(1));
    assert_eq!(
        receipt_version(&serde_json::json!({"stub": true}), 1, 7, "stub"),
        Ok(7)
    );
    assert_eq!(
        receipt_version(&serde_json::json!({"receiptVersion": 9}), 1, 7, "stub"),
        Ok(9)
    );
    assert_eq!(
        receipt_version(&serde_json::json!({"receiptVersion": -1}), 1, 7, "stub"),
        Err("receiptVersion -1".into())
    );
    assert_eq!(
        receipt_version(&serde_json::json!([]), 1, 7, "stub"),
        Err("not a JSON object".into())
    );
}

#[test]
fn startup_sweep_without_http_client_removes_stale_trees() {
    let fixture = FixtureRoot::new("offline-sweep");
    let paths = fixture.paths();
    fs::create_dir_all(paths.partial_dir_for::<Stub>()).expect("partial");
    fs::create_dir_all(paths.final_dir_for::<Stub>()).expect("incomplete engine");
    let io = install::SystemInstallIo::<Stub>::offline(std::sync::Arc::default());
    let removed =
        install::remove_stale_staging::<Stub>(&paths, &StubPlatform, &io, &AtomicBool::new(false));
    assert!(removed.contains(&paths.partial_dir_for::<Stub>()));
    assert!(removed.contains(&paths.final_dir_for::<Stub>()));
    assert!(!paths.final_dir_for::<Stub>().exists());
    assert_clean(&paths);
}

#[test]
fn launcher_stderr_tail_is_bounded_and_keeps_the_failure_detail() {
    let mut output = vec![b'x'; 20_000];
    output.extend_from_slice(b"\nlauncher refused\n");
    let tail = install::stderr_tail(output.as_slice());
    assert!(tail.len() <= 8192);
    assert!(tail.ends_with("launcher refused"));
}
