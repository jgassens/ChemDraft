use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

use super::platform::EnginePlatform;
use super::protocol::{
    self, ProtocolResultError, RecognitionPayload, SidecarErrorCode, SidecarRequest,
};

pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

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

#[derive(Debug, PartialEq)]
pub enum ProcessError {
    InvalidImage(String),
    RecognitionFailed(String),
    Crashed(String),
    Timeout,
}

pub trait EngineProcess: Send {
    fn recognize(
        &mut self,
        request_id: &str,
        image_path: &Path,
        timeout: Duration,
    ) -> Result<RecognitionPayload, ProcessError>;
    fn shutdown(&mut self);
}

pub trait ProcessSpawner: Send + Sync {
    fn spawn(
        &self,
        platform: &dyn EnginePlatform,
        paths: &LaunchPaths,
        timeout: Duration,
    ) -> Result<Box<dyn EngineProcess>, ProcessError>;
}

pub struct ProcessManager {
    spawner: Arc<dyn ProcessSpawner>,
    process: Option<Box<dyn EngineProcess>>,
    last_used: Option<Instant>,
}

impl ProcessManager {
    pub fn system() -> Self {
        Self::new(Arc::new(SystemSpawner))
    }

    pub fn new(spawner: Arc<dyn ProcessSpawner>) -> Self {
        Self {
            spawner,
            process: None,
            last_used: None,
        }
    }

    /// A crashed child is discarded and the request is retried against one fresh process. A timeout
    /// is not retried because the first inference may still have consumed the entire user budget.
    pub fn recognize(
        &mut self,
        platform: &dyn EnginePlatform,
        paths: &LaunchPaths,
        image_path: &Path,
        timeout: Duration,
    ) -> Result<RecognitionPayload, ProcessError> {
        let deadline = Instant::now() + timeout;
        let request_id = format!("ocsr-{}", NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed));
        for attempt in 0..=1 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                self.stop();
                return Err(ProcessError::Timeout);
            }
            if self.process.is_none() {
                self.process = Some(self.spawner.spawn(platform, paths, remaining)?);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            let result = self
                .process
                .as_mut()
                .expect("process was initialized")
                .recognize(&request_id, image_path, remaining);
            self.last_used = Some(Instant::now());
            match result {
                Err(ProcessError::Crashed(message)) => {
                    self.stop();
                    if attempt == 1 {
                        return Err(ProcessError::Crashed(message));
                    }
                }
                Err(ProcessError::Timeout) => {
                    self.stop();
                    return Err(ProcessError::Timeout);
                }
                other => return other,
            }
        }
        Err(ProcessError::Crashed(
            "The OCSR engine stopped twice while recognizing the image.".to_string(),
        ))
    }

    pub fn stop_if_idle(&mut self, now: Instant) -> bool {
        if self.process.is_some()
            && self
                .last_used
                .is_some_and(|last_used| now.saturating_duration_since(last_used) >= IDLE_TIMEOUT)
        {
            self.stop();
            true
        } else {
            false
        }
    }

    pub fn stop(&mut self) {
        if let Some(mut process) = self.process.take() {
            process.shutdown();
        }
        self.last_used = None;
    }
}

impl Drop for ProcessManager {
    fn drop(&mut self) {
        self.stop();
    }
}

struct SystemSpawner;

impl ProcessSpawner for SystemSpawner {
    fn spawn(
        &self,
        platform: &dyn EnginePlatform,
        paths: &LaunchPaths,
        timeout: Duration,
    ) -> Result<Box<dyn EngineProcess>, ProcessError> {
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
        platform.configure_child(&mut command);
        let mut child = command.spawn().map_err(|error| {
            ProcessError::Crashed(format!("Could not start the OCSR engine: {error}"))
        })?;
        let stdin = child.stdin.take().ok_or_else(|| {
            ProcessError::Crashed("Could not open the OCSR engine input.".to_string())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            ProcessError::Crashed("Could not open the OCSR engine output.".to_string())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            ProcessError::Crashed("Could not open the OCSR engine log.".to_string())
        })?;
        let (lines_tx, lines_rx) = mpsc::channel();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        if lines_tx.send(line).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        eprintln!("[chemdraft ocsr] could not read sidecar output: {error}");
                        break;
                    }
                }
            }
        });
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                match line {
                    Ok(line) => eprintln!("[chemdraft ocsr] {line}"),
                    Err(error) => {
                        eprintln!("[chemdraft ocsr] could not read sidecar log: {error}");
                        break;
                    }
                }
            }
        });

        let mut process = SystemProcess {
            child,
            stdin,
            lines: lines_rx,
        };
        let ready_result = process.receive_line(timeout).and_then(|ready_line| {
            let ready =
                protocol::parse_line(ready_line.trim_end()).map_err(ProcessError::Crashed)?;
            protocol::validate_ready(ready).map_err(ProcessError::Crashed)
        });
        if let Err(error) = ready_result {
            process.shutdown();
            return Err(error);
        }
        Ok(Box::new(process))
    }
}

struct SystemProcess {
    child: Child,
    stdin: ChildStdin,
    lines: mpsc::Receiver<String>,
}

impl SystemProcess {
    fn receive_line(&mut self, timeout: Duration) -> Result<String, ProcessError> {
        match self.lines.recv_timeout(timeout) {
            Ok(line) => Ok(line),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(ProcessError::Timeout),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let detail = match self.child.try_wait() {
                    Ok(Some(status)) => format!("The OCSR engine exited with {status}."),
                    Ok(None) => "The OCSR engine closed its output unexpectedly.".to_string(),
                    Err(error) => format!("Could not inspect the OCSR engine: {error}"),
                };
                Err(ProcessError::Crashed(detail))
            }
        }
    }
}

impl EngineProcess for SystemProcess {
    fn recognize(
        &mut self,
        request_id: &str,
        image_path: &Path,
        timeout: Duration,
    ) -> Result<RecognitionPayload, ProcessError> {
        if self
            .child
            .try_wait()
            .map_err(|error| ProcessError::Crashed(format!("Could not inspect OCSR: {error}")))?
            .is_some()
        {
            return Err(ProcessError::Crashed(
                "The OCSR engine was no longer running.".to_string(),
            ));
        }
        let image_path = image_path.to_str().ok_or_else(|| {
            ProcessError::InvalidImage("The temporary image path is not valid Unicode.".to_string())
        })?;
        let line = protocol::encode_request(&SidecarRequest::Recognize {
            id: request_id,
            image_path,
        })
        .map_err(ProcessError::Crashed)?;
        writeln!(self.stdin, "{line}")
            .and_then(|()| self.stdin.flush())
            .map_err(|error| {
                ProcessError::Crashed(format!("Could not send the image to OCSR: {error}"))
            })?;
        let response = self.receive_line(timeout)?;
        let message = protocol::parse_line(response.trim_end()).map_err(ProcessError::Crashed)?;
        match protocol::result_for_id(message, request_id) {
            Ok(payload) => Ok(payload),
            Err(ProtocolResultError::Recognition { code, message }) => match code {
                SidecarErrorCode::InvalidImage => Err(ProcessError::InvalidImage(message)),
                SidecarErrorCode::RecognitionFailed => {
                    Err(ProcessError::RecognitionFailed(message))
                }
            },
            Err(ProtocolResultError::Crashed(message)) => Err(ProcessError::Crashed(message)),
        }
    }

    fn shutdown(&mut self) {
        if let Ok(line) = protocol::encode_request(&SidecarRequest::Shutdown) {
            let _ = writeln!(self.stdin, "{line}");
            let _ = self.stdin.flush();
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => thread::sleep(Duration::from_millis(20)),
                Err(_) => break,
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ocsr_engine::platform::{MacArchitecture, MacPlatform};
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
echo '{"type":"ready","protocol":1,"molscribeVersion":"test","torchVersion":"test"}'
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
  esac
  printf '{"id":"%s","type":"result","smiles":"C","molfile":"m","confidence":0.5,"atoms":[],"bonds":[],"elapsedMs":1}\n' "$id"
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
