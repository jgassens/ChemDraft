use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
#[cfg(test)]
use std::sync::atomic::Ordering;
#[cfg(test)]
use std::sync::mpsc;
use std::sync::Arc;
#[cfg(test)]
use std::thread;
use std::time::Duration;
#[cfg(test)]
use std::time::Instant;

use serde::Serialize;

use super::platform::EnginePlatform;
use super::protocol::{
    self, ProtocolResultError, RecognitionPayload, RequestLine, SidecarErrorCode, SidecarRequest,
};

/// Covers the first request's model load plus a full consensus vote: up to 15 recognitions (the
/// five first-pass sizes and the rest of the 760-1240 px grid). Measured 2026-09-24 on an M1 Pro
/// under heavy load: 2.1-2.3 s per recognition of a 70-atom drawing and 2.6 s for a warm model load,
/// so about 35 s for a full vote; 300 s leaves roughly an 8x margin for slower CPUs and a cold load.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Debug)]
pub struct LaunchPaths {
    pub python: PathBuf,
    /// Flags placed before the script: `-I` in production (isolated mode: ignore PYTHON*
    /// variables and the user site-packages). Tests pass none, because they run a shell stand-in.
    pub interpreter_args: Vec<OsString>,
    pub sidecar: PathBuf,
    pub model: PathBuf,
}

impl LaunchPaths {
    pub fn for_engine(python: PathBuf, sidecar: PathBuf, model: PathBuf) -> Self {
        Self {
            python,
            interpreter_args: vec![OsString::from("-I")],
            sidecar,
            model,
        }
    }
}

/// Where a recognition is, as the host shows it. `Starting` covers launching the sidecar and loading
/// the model (the sidecar says nothing until both are done); `Reading` is one reading of the vote.
/// Serialized for the webview as `{"stage":"starting"}` or
/// `{"stage":"reading","run":1,"runsPlanned":5}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(
    tag = "stage",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RecognitionProgress {
    Starting,
    Reading { run: u32, runs_planned: u32 },
}

#[derive(Debug, PartialEq)]
pub enum ProcessError {
    InvalidImage(String),
    RecognitionFailed(String),
    Crashed(String),
    Timeout,
    /// The sidecar was killed through its [`KillSwitch`] (app exit, install, uninstall, or the
    /// user's Cancel) while this request was running. Never retried.
    Cancelled,
}

pub use crate::local_engine::process::KillSwitch;
use crate::local_engine::process::{
    self as shared, FailureKind, ProcessFailure, ProcessMessages, ResponseLine, SidecarProtocol,
};
pub type ProcessManager = shared::ProcessManager<OcsrProtocol>;

pub trait EngineProcess: Send {
    /// `progress` receives each reading the sidecar announces, before the final answer.
    fn recognize(
        &mut self,
        request_id: &str,
        image_path: &Path,
        timeout: Duration,
        progress: &dyn Fn(RecognitionProgress),
    ) -> Result<RecognitionPayload, ProcessError>;
    fn shutdown(&mut self);
}

pub trait ProcessSpawner: Send + Sync {
    /// Starts a child and waits for it to be ready. The child must be armed on `kill_switch` as
    /// soon as it exists, so a kill during the model load does not wait for the load.
    fn spawn(
        &self,
        platform: &dyn EnginePlatform,
        paths: &LaunchPaths,
        timeout: Duration,
        kill_switch: &KillSwitch,
    ) -> Result<Box<dyn EngineProcess>, ProcessError>;
}

impl ProcessFailure for ProcessError {
    fn cancelled() -> Self {
        Self::Cancelled
    }
    fn timeout() -> Self {
        Self::Timeout
    }
    fn crashed(message: String) -> Self {
        Self::Crashed(message)
    }
    fn kind(&self) -> FailureKind {
        match self {
            Self::Cancelled => FailureKind::Cancelled,
            Self::Timeout => FailureKind::Timeout,
            Self::Crashed(_) => FailureKind::Crashed,
            _ => FailureKind::Answer,
        }
    }
}

pub struct OcsrProtocol;
impl SidecarProtocol for OcsrProtocol {
    type Input = Path;
    type Response = RecognitionPayload;
    type Progress = RecognitionProgress;
    type Error = ProcessError;
    type LaunchPaths = LaunchPaths;
    type Process = dyn EngineProcess;
    type Spawner = dyn ProcessSpawner;
    const IDLE_TIMEOUT: Duration = IDLE_TIMEOUT;
    const LOG_PREFIX: &'static str = "[chemdraft ocsr]";
    const REQUEST_PREFIX: &'static str = "ocsr-";
    fn system_spawner() -> Arc<Self::Spawner> {
        Arc::new(SystemSpawner)
    }
    fn spawn(
        spawner: &Self::Spawner,
        platform: &dyn EnginePlatform,
        paths: &LaunchPaths,
        timeout: Duration,
        kill: &KillSwitch,
    ) -> Result<Box<Self::Process>, ProcessError> {
        spawner.spawn(platform, paths, timeout, kill)
    }
    fn recognize(
        process: &mut Self::Process,
        id: &str,
        input: &Path,
        timeout: Duration,
        progress: &dyn Fn(RecognitionProgress),
    ) -> Result<RecognitionPayload, ProcessError> {
        process.recognize(id, input, timeout, progress)
    }
    fn shutdown(process: &mut Self::Process) {
        process.shutdown();
    }
    fn starting() -> RecognitionProgress {
        RecognitionProgress::Starting
    }
    fn configure_command(paths: &LaunchPaths) -> Command {
        let mut command = Command::new(&paths.python);
        command
            .args(&paths.interpreter_args)
            .arg(&paths.sidecar)
            .arg("--checkpoint")
            .arg(&paths.model)
            .env_remove("PYTHONHOME")
            .env_remove("PYTHONPATH")
            // Recognition is local. The model is loaded from the verified file on disk; these
            // keep the Hugging Face libraries MolScribe imports from reaching for the network.
            .env("HF_HUB_OFFLINE", "1")
            .env("TRANSFORMERS_OFFLINE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(engine_dir) = paths.model.parent().filter(|dir| dir.is_dir()) {
            command.current_dir(engine_dir);
        }
        command
    }
    fn ready(line: &str) -> Result<(), ProcessError> {
        let ready = protocol::parse_line(line).map_err(ProcessError::Crashed)?;
        protocol::validate_ready(ready).map_err(ProcessError::Crashed)
    }
    fn encode(request_id: &str, image_path: &Path) -> Result<String, ProcessError> {
        let image_path = image_path.to_str().ok_or_else(|| {
            ProcessError::InvalidImage("The temporary image path is not valid Unicode.".to_string())
        })?;
        protocol::encode_request(&SidecarRequest::Recognize {
            id: request_id,
            image_path,
        })
        .map_err(ProcessError::Crashed)
    }
    fn classify(line: &str, request_id: &str) -> ResponseLine<Self> {
        let message = match protocol::parse_line(line).map_err(ProcessError::Crashed) {
            Ok(message) => message,
            Err(error) => return ResponseLine::Final(Err(error)),
        };
        match protocol::classify_for_id(message, request_id) {
            RequestLine::Progress(reading) => {
                ResponseLine::Progress(RecognitionProgress::Reading {
                    run: reading.run,
                    runs_planned: reading.runs_planned,
                })
            }
            RequestLine::Final(answer) => ResponseLine::Final(match answer {
                Ok(payload) => Ok(payload),
                Err(ProtocolResultError::Recognition { code, message }) => match code {
                    SidecarErrorCode::InvalidImage => Err(ProcessError::InvalidImage(message)),
                    SidecarErrorCode::RecognitionFailed => {
                        Err(ProcessError::RecognitionFailed(message))
                    }
                },
                Err(ProtocolResultError::Crashed(message)) => Err(ProcessError::Crashed(message)),
            }),
        }
    }
    fn shutdown_line() -> Result<String, ProcessError> {
        protocol::encode_request(&SidecarRequest::Shutdown).map_err(ProcessError::Crashed)
    }
    fn messages() -> ProcessMessages {
        ProcessMessages {
            stopped: "The OCSR engine was stopped while recognizing the image.",
            stopped_twice: "The OCSR engine stopped twice while recognizing the image.",
            start: "Could not start the OCSR engine: ",
            input: "Could not open the OCSR engine input.",
            output: "Could not open the OCSR engine output.",
            log: "Could not open the OCSR engine log.",
            exited: "The OCSR engine exited with ",
            closed: "The OCSR engine closed its output unexpectedly.",
            inspect: "Could not inspect the OCSR engine: ",
            inspect_request: "Could not inspect OCSR: ",
            not_running: "The OCSR engine was no longer running.",
            send: "Could not send the image to OCSR: ",
        }
    }
}

struct SystemSpawner;
impl ProcessSpawner for SystemSpawner {
    fn spawn(
        &self,
        platform: &dyn EnginePlatform,
        paths: &LaunchPaths,
        timeout: Duration,
        kill_switch: &KillSwitch,
    ) -> Result<Box<dyn EngineProcess>, ProcessError> {
        shared::SystemProcess::<OcsrProtocol>::spawn(platform, paths, timeout, kill_switch)
            .map(|process| Box::new(OcsrProcess(process)) as Box<dyn EngineProcess>)
    }
}
struct OcsrProcess(shared::SystemProcess<OcsrProtocol>);
impl EngineProcess for OcsrProcess {
    fn recognize(
        &mut self,
        request_id: &str,
        image_path: &Path,
        timeout: Duration,
        progress: &dyn Fn(RecognitionProgress),
    ) -> Result<RecognitionPayload, ProcessError> {
        self.0.recognize(request_id, image_path, timeout, progress)
    }
    fn shutdown(&mut self) {
        self.0.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ocsr_engine::platform::{MacArchitecture, MacPlatform};
    use crate::ocsr_engine::protocol::RecognitionAgreement;
    use std::collections::VecDeque;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Mutex;

    struct FakeProcess {
        outcome: Option<Result<RecognitionPayload, ProcessError>>,
    }

    impl EngineProcess for FakeProcess {
        fn recognize(
            &mut self,
            _request_id: &str,
            _image_path: &Path,
            _timeout: Duration,
            _progress: &dyn Fn(RecognitionProgress),
        ) -> Result<RecognitionPayload, ProcessError> {
            self.outcome.take().expect("one request per fake process")
        }

        fn shutdown(&mut self) {}
    }

    struct FakeSpawner {
        outcomes: Mutex<VecDeque<Result<RecognitionPayload, ProcessError>>>,
        spawns: AtomicUsize,
    }

    impl ProcessSpawner for FakeSpawner {
        fn spawn(
            &self,
            _platform: &dyn EnginePlatform,
            _paths: &LaunchPaths,
            _timeout: Duration,
            _kill_switch: &KillSwitch,
        ) -> Result<Box<dyn EngineProcess>, ProcessError> {
            self.spawns.fetch_add(1, Ordering::Relaxed);
            Ok(Box::new(FakeProcess {
                outcome: Some(
                    self.outcomes
                        .lock()
                        .expect("fake outcomes")
                        .pop_front()
                        .expect("fake spawn outcome"),
                ),
            }))
        }
    }

    fn payload() -> RecognitionPayload {
        RecognitionPayload {
            smiles: "C".to_string(),
            molfile: "mol".to_string(),
            confidence: None,
            atoms: Vec::new(),
            bonds: Vec::new(),
            agreement: RecognitionAgreement {
                runs: 1,
                agreeing: 1,
                invalid_runs: 0,
                scales_px: vec![800],
            },
            elapsed_ms: 1,
        }
    }

    fn paths() -> LaunchPaths {
        LaunchPaths::for_engine("python".into(), "sidecar.py".into(), "model.pth".into())
    }

    #[test]
    fn crash_restarts_once_and_retries_the_request() {
        let spawner = Arc::new(FakeSpawner {
            outcomes: Mutex::new(VecDeque::from([
                Err(ProcessError::Crashed("gone".to_string())),
                Ok(payload()),
            ])),
            spawns: AtomicUsize::new(0),
        });
        let mut manager = ProcessManager::new(spawner.clone());
        let platform = MacPlatform::new(MacArchitecture::Aarch64);
        let result = manager
            .recognize(
                &platform,
                &paths(),
                Path::new("image.png"),
                Duration::from_secs(1),
            )
            .expect("second process succeeds");
        assert_eq!(result.smiles, "C");
        assert_eq!(spawner.spawns.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn timeout_is_not_retried_but_next_request_starts_fresh() {
        let spawner = Arc::new(FakeSpawner {
            outcomes: Mutex::new(VecDeque::from([Err(ProcessError::Timeout), Ok(payload())])),
            spawns: AtomicUsize::new(0),
        });
        let mut manager = ProcessManager::new(spawner.clone());
        let platform = MacPlatform::new(MacArchitecture::Aarch64);
        assert_eq!(
            manager.recognize(
                &platform,
                &paths(),
                Path::new("image.png"),
                Duration::from_secs(1)
            ),
            Err(ProcessError::Timeout)
        );
        manager
            .recognize(
                &platform,
                &paths(),
                Path::new("image.png"),
                Duration::from_secs(1),
            )
            .expect("next request restarts");
        assert_eq!(spawner.spawns.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn a_second_crash_is_reported_without_a_third_spawn() {
        let spawner = Arc::new(FakeSpawner {
            outcomes: Mutex::new(VecDeque::from([
                Err(ProcessError::Crashed("first".to_string())),
                Err(ProcessError::Crashed("second".to_string())),
            ])),
            spawns: AtomicUsize::new(0),
        });
        let mut manager = ProcessManager::new(spawner.clone());
        let platform = MacPlatform::new(MacArchitecture::Aarch64);
        assert_eq!(
            manager.recognize(
                &platform,
                &paths(),
                Path::new("image.png"),
                Duration::from_secs(1)
            ),
            Err(ProcessError::Crashed("second".to_string()))
        );
        assert_eq!(spawner.spawns.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn recognition_errors_are_answers_not_crashes() {
        let spawner = Arc::new(FakeSpawner {
            outcomes: Mutex::new(VecDeque::from([Err(ProcessError::InvalidImage(
                "bad".to_string(),
            ))])),
            spawns: AtomicUsize::new(0),
        });
        let mut manager = ProcessManager::new(spawner.clone());
        let platform = MacPlatform::new(MacArchitecture::Aarch64);
        assert_eq!(
            manager.recognize(
                &platform,
                &paths(),
                Path::new("image.png"),
                Duration::from_secs(1)
            ),
            Err(ProcessError::InvalidImage("bad".to_string()))
        );
        assert_eq!(spawner.spawns.load(Ordering::Relaxed), 1);
        assert!(
            manager.process.is_some(),
            "the process stays up after a bad image"
        );
    }

    /// A spawner whose child is asked to stop while it is still loading: the kill lands before the
    /// spawner arms the switch, so arming must kill at once.
    struct KilledWhileLoadingSpawner {
        spawns: AtomicUsize,
    }

    impl ProcessSpawner for KilledWhileLoadingSpawner {
        fn spawn(
            &self,
            _platform: &dyn EnginePlatform,
            _paths: &LaunchPaths,
            _timeout: Duration,
            kill_switch: &KillSwitch,
        ) -> Result<Box<dyn EngineProcess>, ProcessError> {
            self.spawns.fetch_add(1, Ordering::Relaxed);
            kill_switch.kill_now();
            let killed = Arc::new(AtomicUsize::new(0));
            let flag = killed.clone();
            kill_switch.arm(Box::new(move || {
                flag.fetch_add(1, Ordering::Relaxed);
            }));
            assert_eq!(
                killed.load(Ordering::Relaxed),
                1,
                "arming after a kill kills"
            );
            Err(ProcessError::Crashed("killed while loading".to_string()))
        }
    }

    #[test]
    fn a_kill_during_the_model_load_is_cancelled_and_not_retried() {
        let spawner = Arc::new(KilledWhileLoadingSpawner {
            spawns: AtomicUsize::new(0),
        });
        let mut manager = ProcessManager::new(spawner.clone());
        let platform = MacPlatform::new(MacArchitecture::Aarch64);
        assert_eq!(
            manager.recognize(
                &platform,
                &paths(),
                Path::new("image.png"),
                Duration::from_secs(1)
            ),
            Err(ProcessError::Cancelled)
        );
        assert_eq!(spawner.spawns.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn idle_processes_stop_after_ten_minutes() {
        let spawner = Arc::new(FakeSpawner {
            outcomes: Mutex::new(VecDeque::from([Ok(payload())])),
            spawns: AtomicUsize::new(0),
        });
        let mut manager = ProcessManager::new(spawner);
        let platform = MacPlatform::new(MacArchitecture::Aarch64);
        manager
            .recognize(
                &platform,
                &paths(),
                Path::new("image.png"),
                Duration::from_secs(1),
            )
            .expect("recognized");
        let used = manager.last_used.expect("last used");
        assert!(!manager.stop_if_idle(used + IDLE_TIMEOUT - Duration::from_secs(1)));
        assert!(manager.process.is_some());
        assert!(manager.stop_if_idle(used + IDLE_TIMEOUT));
        assert!(manager.process.is_none());
    }

    /// A shell stand-in for the Python sidecar, speaking the same JSON Lines protocol. The
    /// `--checkpoint` argument (`$2`) doubles as a scratch path and a mode switch. Test folder
    /// names must not contain the image keywords, which are matched against the whole request.
    #[cfg(unix)]
    const FAKE_SIDECAR: &str = r#"
if [ "$(basename "$2")" = "fatal" ]; then
  echo '{"type":"fatal","code":"model_load_failed","message":"no model"}'
  exit 1
fi
echo "starting" >&2
echo '{"type":"ready","protocol":2,"molscribeVersion":"test","torchVersion":"test"}'
while IFS= read -r line; do
  case "$line" in
    *'"shutdown"'*) exit 0 ;;
  esac
  id=$(printf '%s\n' "$line" | sed 's/.*"id":"\([^"]*\)".*/\1/')
  case "$line" in
    *crash-once*)
      if [ ! -e "$2.crashed" ]; then : > "$2.crashed"; exit 3; fi ;;
    *crash*) exit 3 ;;
    *garbage*) echo 'not json'; continue ;;
    *slow*) sleep 3 ;;
    *missing*)
      printf '{"id":"%s","type":"error","code":"invalid_image","message":"unreadable"}\n' "$id"
      continue ;;
    *stray-progress*)
      echo '{"id":"someone-else","type":"progress","stage":"reading","run":1,"runsPlanned":5}'
      continue ;;
    *widening*)
      for run in 1 2 3 4 5; do
        printf '{"id":"%s","type":"progress","stage":"reading","run":%s,"runsPlanned":5}\n' "$id" "$run"
      done
      for run in 6 7 8 9 10 11 12 13 14 15; do
        printf '{"id":"%s","type":"progress","stage":"reading","run":%s,"runsPlanned":15}\n' "$id" "$run"
      done ;;
    *one-reading-then-wait*)
      printf '{"id":"%s","type":"progress","stage":"reading","run":1,"runsPlanned":5}\n' "$id"
      sleep 3 ;;
  esac
  printf '{"id":"%s","type":"result","smiles":"C","molfile":"m","confidence":0.5,"atoms":[],"bonds":[],"agreement":{"runs":3,"agreeing":3,"invalidRuns":0,"scalesPx":[800,1000,1200]},"elapsedMs":1}\n' "$id"
done
"#;

    #[cfg(unix)]
    struct ShellSidecar {
        root: PathBuf,
        paths: LaunchPaths,
    }

    #[cfg(unix)]
    impl ShellSidecar {
        fn new(label: &str, model: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "chemdraft-ocsr-process-{label}-{}",
                std::process::id()
            ));
            std::fs::create_dir_all(&root).expect("test root");
            let script = root.join("sidecar.sh");
            std::fs::write(&script, FAKE_SIDECAR).expect("script");
            let paths = LaunchPaths {
                python: "/bin/sh".into(),
                interpreter_args: Vec::new(),
                sidecar: script,
                model: root.join(model),
            };
            Self { root, paths }
        }

        fn recognize(
            &self,
            manager: &mut ProcessManager,
            image: &str,
            timeout: Duration,
        ) -> Result<RecognitionPayload, ProcessError> {
            manager.recognize(
                &MacPlatform::new(MacArchitecture::Aarch64),
                &self.paths,
                &self.root.join(image),
                timeout,
            )
        }

        /// Recognizes `image`, returning the answer and every progress event, in order.
        fn recognize_observed(
            &self,
            manager: &mut ProcessManager,
            image: &str,
        ) -> (
            Result<RecognitionPayload, ProcessError>,
            Vec<RecognitionProgress>,
        ) {
            let events = Mutex::new(Vec::new());
            let result = manager.recognize_with(
                &MacPlatform::new(MacArchitecture::Aarch64),
                &self.paths,
                &self.root.join(image),
                Duration::from_secs(10),
                &|event| events.lock().expect("events").push(event),
                &|| false,
            );
            (result, events.into_inner().expect("events"))
        }
    }

    #[cfg(unix)]
    impl Drop for ShellSidecar {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[cfg(unix)]
    #[test]
    fn real_process_is_started_lazily_and_reused() {
        let sidecar = ShellSidecar::new("reuse", "model");
        let mut manager = ProcessManager::system();
        assert!(manager.process.is_none());
        for _ in 0..3 {
            let payload = sidecar
                .recognize(&mut manager, "image.png", Duration::from_secs(10))
                .expect("recognized");
            assert_eq!(payload.smiles, "C");
            assert_eq!(payload.confidence, Some(0.5));
        }
        assert!(manager.process.is_some());
        assert_eq!(
            sidecar.recognize(&mut manager, "missing.png", Duration::from_secs(10)),
            Err(ProcessError::InvalidImage("unreadable".to_string()))
        );
        manager.stop();
        assert!(manager.process.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn progress_lines_are_forwarded_in_order_before_the_answer() {
        let sidecar = ShellSidecar::new("progress", "model");
        let mut manager = ProcessManager::system();
        let (result, events) = sidecar.recognize_observed(&mut manager, "widening.png");
        assert_eq!(result.expect("recognized").smiles, "C");
        let mut expected = vec![RecognitionProgress::Starting];
        expected.extend((1..=5).map(|run| RecognitionProgress::Reading {
            run,
            runs_planned: 5,
        }));
        expected.extend((6..=15).map(|run| RecognitionProgress::Reading {
            run,
            runs_planned: 15,
        }));
        assert_eq!(events, expected);

        // A warm sidecar is not started again, so the next request reports only its readings.
        let (result, events) = sidecar.recognize_observed(&mut manager, "widening.png");
        assert!(result.is_ok());
        assert_eq!(
            events.first(),
            Some(&RecognitionProgress::Reading {
                run: 1,
                runs_planned: 5
            })
        );
        assert_eq!(events.len(), 15);

        // A sidecar that sends no progress at all (an older one) still answers as before.
        let (result, events) = sidecar.recognize_observed(&mut manager, "image.png");
        assert!(result.is_ok());
        assert!(events.is_empty());
    }

    #[test]
    fn progress_serializes_the_exact_webview_contract() {
        assert_eq!(
            serde_json::to_value(RecognitionProgress::Starting).expect("json"),
            serde_json::json!({"stage": "starting"})
        );
        assert_eq!(
            serde_json::to_value(RecognitionProgress::Reading {
                run: 2,
                runs_planned: 5
            })
            .expect("json"),
            serde_json::json!({"stage": "reading", "run": 2, "runsPlanned": 5})
        );
    }

    #[cfg(unix)]
    #[test]
    fn progress_for_another_request_is_a_crash() {
        let sidecar = ShellSidecar::new("stray", "model");
        let mut manager = ProcessManager::system();
        let (result, _) = sidecar.recognize_observed(&mut manager, "stray-progress.png");
        assert!(
            matches!(&result, Err(ProcessError::Crashed(message)) if message.contains("someone-else")),
            "{result:?}"
        );
    }

    /// The user's Cancel: the running request's sidecar dies at once, the request reports
    /// `Cancelled`, and the next request starts a fresh sidecar.
    #[cfg(unix)]
    #[test]
    fn cancel_request_stops_a_running_recognition_immediately() {
        let sidecar = Arc::new(ShellSidecar::new("user-cancel", "model"));
        let manager = Arc::new(Mutex::new(ProcessManager::system()));
        let kill_switch = manager.lock().expect("manager").kill_switch();
        let (reading_tx, reading_rx) = mpsc::channel();
        let worker = {
            let (manager, sidecar) = (manager.clone(), sidecar.clone());
            thread::spawn(move || {
                let reading_tx = Mutex::new(reading_tx);
                let mut manager = manager.lock().expect("manager");
                manager.recognize_with(
                    &MacPlatform::new(MacArchitecture::Aarch64),
                    &sidecar.paths,
                    &sidecar.root.join("one-reading-then-wait.png"),
                    Duration::from_secs(30),
                    &|event| {
                        let _ = reading_tx.lock().expect("sender").send(event);
                    },
                    &|| false,
                )
            })
        };
        // Wait until the sidecar has announced its first reading, then cancel mid-reading.
        loop {
            let event = reading_rx
                .recv_timeout(Duration::from_secs(10))
                .expect("progress before the answer");
            if matches!(event, RecognitionProgress::Reading { .. }) {
                break;
            }
        }
        let cancelled_at = Instant::now();
        assert!(kill_switch.cancel_request(), "a request was running");
        assert_eq!(
            worker.join().expect("request thread"),
            Err(ProcessError::Cancelled)
        );
        assert!(cancelled_at.elapsed() < Duration::from_millis(2_500));
        let mut manager = manager.lock().expect("manager");
        assert!(manager.process.is_none());
        sidecar
            .recognize(&mut manager, "image.png", Duration::from_secs(10))
            .expect("the next request starts a fresh process");
    }

    /// A Cancel between recognitions has nothing to stop, and must not kill the warm sidecar.
    #[cfg(unix)]
    #[test]
    fn cancel_request_between_recognitions_leaves_the_warm_sidecar_alone() {
        let sidecar = ShellSidecar::new("idle-cancel", "model");
        let mut manager = ProcessManager::system();
        let kill_switch = manager.kill_switch();
        sidecar
            .recognize(&mut manager, "image.png", Duration::from_secs(10))
            .expect("warm process");
        assert!(!kill_switch.cancel_request());
        let (result, events) = sidecar.recognize_observed(&mut manager, "image.png");
        assert!(result.is_ok());
        assert!(
            !events.contains(&RecognitionProgress::Starting),
            "the warm sidecar was reused"
        );
    }

    /// A Cancel that raced ahead of the request (so `cancel_request` found nothing running) is
    /// caught by the caller's flag before any process is started.
    #[test]
    fn a_cancel_flag_set_before_the_request_begins_stops_it_without_a_spawn() {
        let spawner = Arc::new(FakeSpawner {
            outcomes: Mutex::new(VecDeque::from([Ok(payload())])),
            spawns: AtomicUsize::new(0),
        });
        let mut manager = ProcessManager::new(spawner.clone());
        let started = Mutex::new(0);
        assert_eq!(
            manager.recognize_with(
                &MacPlatform::new(MacArchitecture::Aarch64),
                &paths(),
                Path::new("image.png"),
                Duration::from_secs(1),
                &|_| *started.lock().expect("count") += 1,
                &|| true,
            ),
            Err(ProcessError::Cancelled)
        );
        assert_eq!(spawner.spawns.load(Ordering::Relaxed), 0);
        assert_eq!(*started.lock().expect("count"), 0);
    }

    #[cfg(unix)]
    #[test]
    fn real_process_crash_restarts_once() {
        let sidecar = ShellSidecar::new("restart", "model");
        let mut manager = ProcessManager::system();
        sidecar
            .recognize(&mut manager, "crash-once.png", Duration::from_secs(10))
            .expect("the restarted process answers");
        assert!(matches!(
            sidecar.recognize(&mut manager, "crash.png", Duration::from_secs(10)),
            Err(ProcessError::Crashed(_))
        ));
        assert!(manager.process.is_none());
        sidecar
            .recognize(&mut manager, "image.png", Duration::from_secs(10))
            .expect("the next request starts a fresh process");
    }

    #[cfg(unix)]
    #[test]
    fn real_process_malformed_output_is_a_crash() {
        let sidecar = ShellSidecar::new("malformed", "model");
        let mut manager = ProcessManager::system();
        let error = sidecar
            .recognize(&mut manager, "garbage.png", Duration::from_secs(10))
            .expect_err("malformed line");
        assert!(matches!(error, ProcessError::Crashed(message) if message.contains("malformed")));
    }

    #[cfg(unix)]
    #[test]
    fn real_process_timeout_kills_it_and_the_next_request_starts_fresh() {
        let sidecar = ShellSidecar::new("deadline", "model");
        let mut manager = ProcessManager::system();
        let started = Instant::now();
        assert_eq!(
            sidecar.recognize(&mut manager, "slow.png", Duration::from_millis(300)),
            Err(ProcessError::Timeout)
        );
        assert!(manager.process.is_none());
        assert!(started.elapsed() < Duration::from_secs(10));
        sidecar
            .recognize(&mut manager, "image.png", Duration::from_secs(10))
            .expect("fresh process");
    }

    /// The request lock is held for the whole recognition; the kill switch must not need it.
    #[cfg(unix)]
    #[test]
    fn kill_switch_cancels_a_running_request_without_the_manager_lock() {
        let sidecar = Arc::new(ShellSidecar::new("kill", "model"));
        let manager = Arc::new(Mutex::new(ProcessManager::system()));
        let kill_switch = manager.lock().expect("manager").kill_switch();
        sidecar
            .recognize(
                &mut manager.lock().expect("manager"),
                "image.png",
                Duration::from_secs(10),
            )
            .expect("warm process");
        let started = Instant::now();
        let worker = {
            let manager = manager.clone();
            let sidecar = sidecar.clone();
            thread::spawn(move || {
                let mut manager = manager.lock().expect("manager");
                sidecar.recognize(&mut manager, "slow.png", Duration::from_secs(30))
            })
        };
        while manager.try_lock().is_ok() {
            thread::sleep(Duration::from_millis(10));
        }
        thread::sleep(Duration::from_millis(200));
        kill_switch.kill_now();
        assert_eq!(
            worker.join().expect("request thread"),
            Err(ProcessError::Cancelled)
        );
        // The sidecar's `sleep 3` runs in its process group, so the whole tree died, not only sh.
        assert!(started.elapsed() < Duration::from_millis(2_500));
        let mut manager = manager.lock().expect("manager");
        assert!(manager.process.is_none());
        sidecar
            .recognize(&mut manager, "image.png", Duration::from_secs(10))
            .expect("the next request starts a fresh process");
    }

    #[cfg(unix)]
    #[test]
    fn real_process_fatal_load_is_reported() {
        let sidecar = ShellSidecar::new("load", "fatal");
        let mut manager = ProcessManager::system();
        let error = sidecar
            .recognize(&mut manager, "image.png", Duration::from_secs(10))
            .expect_err("model load fails");
        assert!(
            matches!(&error, ProcessError::Crashed(message) if message.contains("model_load_failed")),
            "{error:?}"
        );
        assert!(manager.process.is_none());
    }
}
