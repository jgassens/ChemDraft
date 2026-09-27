use std::ffi::OsString;
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::platform::{self, EnginePlatform};
use super::protocol::{
    self, ProtocolResultError, RecognitionPayload, RequestLine, SidecarErrorCode, SidecarRequest,
};

/// Covers the first request's model load plus a full consensus vote: up to 15 recognitions (the
/// five first-pass sizes and the rest of the 760-1240 px grid). Measured 2026-09-24 on an M1 Pro
/// under heavy load: 2.1-2.3 s per recognition of a 70-atom drawing and 2.6 s for a warm model load,
/// so about 35 s for a full vote; 300 s leaves roughly an 8x margin for slower CPUs and a cold load.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
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

/// Kills the running sidecar from any thread, without the [`ProcessManager`] lock that a
/// recognition holds for its whole length (up to [`REQUEST_TIMEOUT`]). Exit, install and
/// uninstall use it so none of them waits for a recognition to finish: the child dies, and the
/// request in flight is woken at once and reports [`ProcessError::Cancelled`] (it does not wait for
/// the child's output to close, which a grandchild still holding it open would delay).
#[derive(Clone, Default)]
pub struct KillSwitch(Arc<Mutex<KillState>>);

#[derive(Default)]
struct KillState {
    /// Set by `kill_now` (or `cancel_request` while a request runs), cleared when the next request
    /// begins.
    requested: bool,
    /// True from the start of a request until it returns; `cancel_request` acts only then.
    active: bool,
    /// Kills the current child; present from spawn until the manager stops it.
    kill: Option<Box<dyn FnMut() + Send>>,
}

impl KillSwitch {
    /// Kills the current child, if any, and marks the request in flight as cancelled. Returns at
    /// once; nothing here waits for the child to exit.
    pub fn kill_now(&self) {
        let kill = {
            let mut state = self.state();
            state.requested = true;
            state.kill.take()
        };
        if let Some(mut kill) = kill {
            kill();
        }
    }

    /// The user's Cancel: kills the child only while a request is running, so a click that lands
    /// between recognitions leaves a warm idle sidecar alone. Returns whether a request was running.
    /// A cancel that lands just before a request begins is caught by the manager's `cancelled`
    /// check instead, which runs after `begin`.
    pub fn cancel_request(&self) -> bool {
        let kill = {
            let mut state = self.state();
            if !state.active {
                return false;
            }
            state.requested = true;
            state.kill.take()
        };
        if let Some(mut kill) = kill {
            kill();
        }
        true
    }

    /// Called by a spawner as soon as its child exists, before the (possibly long) model load.
    /// A kill requested while the spawn was starting takes effect immediately.
    pub fn arm(&self, mut kill: Box<dyn FnMut() + Send>) {
        let mut state = self.state();
        if state.requested {
            drop(state);
            kill();
        } else {
            state.kill = Some(kill);
        }
    }

    fn begin(&self) {
        let mut state = self.state();
        state.requested = false;
        state.active = true;
    }

    /// Ends a request; returns whether a kill was requested at any point during it.
    fn finish(&self) -> bool {
        let mut state = self.state();
        state.active = false;
        state.requested
    }

    fn requested(&self) -> bool {
        self.state().requested
    }

    fn disarm(&self) {
        self.state().kill = None;
    }

    fn state(&self) -> MutexGuard<'_, KillState> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

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

pub struct ProcessManager {
    spawner: Arc<dyn ProcessSpawner>,
    process: Option<Box<dyn EngineProcess>>,
    last_used: Option<Instant>,
    kill_switch: KillSwitch,
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
            kill_switch: KillSwitch::default(),
        }
    }

    /// A handle that kills this manager's child without taking the manager's lock.
    pub fn kill_switch(&self) -> KillSwitch {
        self.kill_switch.clone()
    }

    /// [`Self::recognize_with`] without progress or a cancel check.
    #[cfg(test)]
    pub fn recognize(
        &mut self,
        platform: &dyn EnginePlatform,
        paths: &LaunchPaths,
        image_path: &Path,
        timeout: Duration,
    ) -> Result<RecognitionPayload, ProcessError> {
        self.recognize_with(platform, paths, image_path, timeout, &|_| {}, &|| false)
    }

    /// A crashed child is discarded and the request is retried against one fresh process. A timeout
    /// is not retried because the first inference may still have consumed the entire user budget,
    /// and a kill through the [`KillSwitch`] is not retried because someone asked for it.
    ///
    /// `progress` hears `Starting` before each spawn and every reading the sidecar announces.
    /// `cancelled` is the caller's own cancel flag, read once the request has begun: a
    /// [`KillSwitch::cancel_request`] that raced ahead of `begin` found no request to kill, so the
    /// caller's flag is what stops this one before it starts work.
    pub fn recognize_with(
        &mut self,
        platform: &dyn EnginePlatform,
        paths: &LaunchPaths,
        image_path: &Path,
        timeout: Duration,
        progress: &dyn Fn(RecognitionProgress),
        cancelled: &dyn Fn() -> bool,
    ) -> Result<RecognitionPayload, ProcessError> {
        self.kill_switch.begin();
        let result = if cancelled() {
            Err(ProcessError::Cancelled)
        } else {
            self.attempts(platform, paths, image_path, timeout, progress)
        };
        if self.kill_switch.finish() {
            // A kill landed after the attempts last looked (or during them): the child may be dead
            // while still held here, so drop it and let the next request start a fresh one.
            self.stop();
            return result.map_err(|_| ProcessError::Cancelled);
        }
        result
    }

    fn attempts(
        &mut self,
        platform: &dyn EnginePlatform,
        paths: &LaunchPaths,
        image_path: &Path,
        timeout: Duration,
        progress: &dyn Fn(RecognitionProgress),
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
                progress(RecognitionProgress::Starting);
                match self
                    .spawner
                    .spawn(platform, paths, remaining, &self.kill_switch)
                {
                    Ok(process) => self.process = Some(process),
                    Err(error) => {
                        self.kill_switch.disarm();
                        return Err(if self.kill_switch.requested() {
                            ProcessError::Cancelled
                        } else {
                            error
                        });
                    }
                }
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            let result = self
                .process
                .as_mut()
                .expect("process was initialized")
                .recognize(&request_id, image_path, remaining, progress);
            self.last_used = Some(Instant::now());
            if self.kill_switch.requested() {
                // The child is dead or dying; an answer that arrived first still stands.
                self.stop();
                return result.map_err(|_| ProcessError::Cancelled);
            }
            match result {
                // Killed before this request began (it asked for nothing): a dead child, as below.
                Err(ProcessError::Cancelled) => {
                    self.stop();
                    if attempt == 1 {
                        return Err(ProcessError::Crashed(
                            "The OCSR engine was stopped while recognizing the image.".to_string(),
                        ));
                    }
                }
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
        self.kill_switch.disarm();
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
        kill_switch: &KillSwitch,
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
        let child = Arc::new(Mutex::new(Sidecar {
            child,
            reaped: false,
        }));
        let (lines_tx, lines_rx) = mpsc::channel();
        let killable = child.clone();
        let killed_tx = lines_tx.clone();
        kill_switch.arm(Box::new(move || {
            // Holding the child's lock rules out a concurrent reap, so the id cannot be reused.
            let mut sidecar = lock_child(&killable);
            if !sidecar.reaped {
                platform::kill_process_tree(sidecar.child.id());
            }
            let _ = sidecar.child.kill();
            drop(sidecar);
            // Wakes the request now, rather than when the output closes.
            let _ = killed_tx.send(SidecarOutput::Killed);
        }));
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        if lines_tx.send(SidecarOutput::Line(line)).is_err() {
                            return;
                        }
                    }
                    Err(error) => {
                        eprintln!("[chemdraft ocsr] could not read sidecar output: {error}");
                        break;
                    }
                }
            }
            // Said explicitly: the kill switch's sender keeps the channel connected.
            let _ = lines_tx.send(SidecarOutput::Closed);
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
    /// Shared with the [`KillSwitch`], which kills it from another thread.
    child: Arc<Mutex<Sidecar>>,
    stdin: ChildStdin,
    lines: mpsc::Receiver<SidecarOutput>,
}

enum SidecarOutput {
    Line(String),
    /// The sidecar's stdout reached its end.
    Closed,
    /// The [`KillSwitch`] killed the sidecar.
    Killed,
}

/// The sidecar's child. Every reap goes through here, so the process group is swept first (see
/// [`platform::sweep_exited_process_group`]), and `reaped` records when its pid stops being ours.
struct Sidecar {
    child: Child,
    reaped: bool,
}

impl Sidecar {
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        if !self.reaped
            && matches!(
                platform::sweep_exited_process_group(self.child.id(), false),
                Ok(false)
            )
        {
            return Ok(None);
        }
        let status = self.child.try_wait()?;
        self.reaped |= status.is_some();
        Ok(status)
    }

    fn kill_and_wait(&mut self) {
        if !self.reaped {
            platform::kill_process_tree(self.child.id());
            let _ = self.child.kill();
            let _ = platform::sweep_exited_process_group(self.child.id(), true);
        }
        let _ = self.child.wait();
        self.reaped = true;
    }
}

fn lock_child(child: &Mutex<Sidecar>) -> MutexGuard<'_, Sidecar> {
    child
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl SystemProcess {
    fn receive_line(&mut self, timeout: Duration) -> Result<String, ProcessError> {
        match self.lines.recv_timeout(timeout) {
            Ok(SidecarOutput::Line(line)) => Ok(line),
            Ok(SidecarOutput::Killed) => Err(ProcessError::Cancelled),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(ProcessError::Timeout),
            Ok(SidecarOutput::Closed) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                let detail = match lock_child(&self.child).try_wait() {
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
        progress: &dyn Fn(RecognitionProgress),
    ) -> Result<RecognitionPayload, ProcessError> {
        let deadline = Instant::now() + timeout;
        if lock_child(&self.child)
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
        // Progress lines come first, one per reading; the whole request shares one deadline.
        let answer = loop {
            let response = self.receive_line(deadline.saturating_duration_since(Instant::now()))?;
            let message =
                protocol::parse_line(response.trim_end()).map_err(ProcessError::Crashed)?;
            match protocol::classify_for_id(message, request_id) {
                RequestLine::Progress(reading) => progress(RecognitionProgress::Reading {
                    run: reading.run,
                    runs_planned: reading.runs_planned,
                }),
                RequestLine::Final(answer) => break answer,
            }
        };
        match answer {
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
            let exited = lock_child(&self.child).try_wait();
            match exited {
                Ok(Some(_)) => return,
                Ok(None) => thread::sleep(Duration::from_millis(20)),
                Err(_) => break,
            }
        }
        lock_child(&self.child).kill_and_wait();
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
