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

const ABC_SHA: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const EMPTY_SHA: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
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

#[derive(Default)]
struct FixtureIo {
    bad_sha: bool,
    fail_probe: bool,
    cancel_probe: bool,
    probes: AtomicUsize,
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
        _env: &[(OsString, OsString)],
        cancel: &AtomicBool,
        watch: Option<RunWatch<'_>>,
    ) -> Result<(), InstallError> {
        let partial = program.parent().expect("program parent");
        if let RunStep::CreateVenv = step {
            let python = platform.venv_python(partial);
            fs::create_dir_all(python.parent().expect("python parent")).map_err(Stub::failed_io)?;
            fs::write(python, b"python").map_err(Stub::failed_io)?;
        }
        if let RunStep::VerifyEnvironment = step {
            self.probes.fetch_add(1, Ordering::Relaxed);
            let final_dir = program.parent().expect("venv").parent().expect("engine");
            assert!(final_dir.ends_with(Stub::DIR_NAME), "probe runs after swap");
            assert!(
                !final_dir.join(RECEIPT_FILE).exists(),
                "receipt written last"
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
    install::remove_stale_staging::<Stub>(&paths, &StubPlatform);
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
