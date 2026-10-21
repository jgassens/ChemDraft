use std::io::{self, BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, ExitStatus};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, TryLockError};
use std::thread;
use std::time::{Duration, Instant};

use super::platform::{self, EnginePlatform};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    Cancelled,
    Timeout,
    Crashed,
    Answer,
}
pub trait ProcessFailure: Sized {
    fn cancelled() -> Self;
    fn timeout() -> Self;
    fn crashed(message: String) -> Self;
    fn kind(&self) -> FailureKind;
}

pub enum ResponseLine<P: SidecarProtocol> {
    Progress(P::Progress),
    Final(Result<P::Response, P::Error>),
}

/// Engine-owned typed protocol and launch policy; the shared manager owns process lifetime and IO.
pub trait SidecarProtocol: Send + Sync + 'static {
    type Input: ?Sized;
    type Response;
    type Progress;
    type Error: ProcessFailure;
    type LaunchPaths;
    type Process: ?Sized + Send;
    type Spawner: ?Sized + Send + Sync;
    const IDLE_TIMEOUT: Duration;
    const LOG_PREFIX: &'static str;
    const REQUEST_PREFIX: &'static str;
    fn system_spawner() -> Arc<Self::Spawner>;
    fn spawn(
        spawner: &Self::Spawner,
        platform: &dyn EnginePlatform,
        paths: &Self::LaunchPaths,
        timeout: Duration,
        kill: &KillSwitch,
    ) -> Result<Box<Self::Process>, Self::Error>;
    fn recognize(
        process: &mut Self::Process,
        id: &str,
        input: &Self::Input,
        timeout: Duration,
        progress: &dyn Fn(Self::Progress),
    ) -> Result<Self::Response, Self::Error>;
    fn shutdown(process: &mut Self::Process);
    fn starting() -> Self::Progress;
    fn configure_command(paths: &Self::LaunchPaths) -> Command;
    fn ready(line: &str) -> Result<(), Self::Error>;
    fn encode(id: &str, input: &Self::Input) -> Result<String, Self::Error>;
    fn classify(line: &str, id: &str) -> ResponseLine<Self>
    where
        Self: Sized;
    fn shutdown_line() -> Result<String, Self::Error>;
    fn messages() -> ProcessMessages;
}

/// Exact adapter-owned diagnostic text, including punctuation and the space before a detail.
pub struct ProcessMessages {
    pub stopped: &'static str,
    pub stopped_twice: &'static str,
    pub start: &'static str,
    pub input: &'static str,
    pub output: &'static str,
    pub log: &'static str,
    pub exited: &'static str,
    pub closed: &'static str,
    pub inspect: &'static str,
    pub inspect_request: &'static str,
    pub not_running: &'static str,
    pub send: &'static str,
}
static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);
/// Kills the running sidecar from any thread, without the [`ProcessManager`] lock that a
/// recognition holds for its whole length (up to the request timeout). Exit, install and
/// uninstall use it so none of them waits for a recognition to finish: the child dies, and the
/// request in flight is woken at once and reports [`P::Error::cancelled()`] (it does not wait for
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

pub struct ProcessManager<P: SidecarProtocol> {
    spawner: Arc<P::Spawner>,
    pub(crate) process: Option<Box<P::Process>>,
    pub(crate) last_used: Option<Instant>,
    kill_switch: KillSwitch,
}

impl<P: SidecarProtocol> ProcessManager<P> {
    pub fn system() -> Self {
        Self::new(P::system_spawner())
    }

    pub fn new(spawner: Arc<P::Spawner>) -> Self {
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
        paths: &P::LaunchPaths,
        image_path: &P::Input,
        timeout: Duration,
    ) -> Result<P::Response, P::Error> {
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
        paths: &P::LaunchPaths,
        image_path: &P::Input,
        timeout: Duration,
        progress: &dyn Fn(P::Progress),
        cancelled: &dyn Fn() -> bool,
    ) -> Result<P::Response, P::Error> {
        self.kill_switch.begin();
        let result = if cancelled() {
            Err(P::Error::cancelled())
        } else {
            self.attempts(platform, paths, image_path, timeout, progress)
        };
        if self.kill_switch.finish() {
            // A kill landed after the attempts last looked (or during them): the child may be dead
            // while still held here, so drop it and let the next request start a fresh one.
            self.stop();
            return result.map_err(|_| P::Error::cancelled());
        }
        result
    }

    fn attempts(
        &mut self,
        platform: &dyn EnginePlatform,
        paths: &P::LaunchPaths,
        image_path: &P::Input,
        timeout: Duration,
        progress: &dyn Fn(P::Progress),
    ) -> Result<P::Response, P::Error> {
        let deadline = Instant::now() + timeout;
        let request_id = format!(
            "{}{}",
            P::REQUEST_PREFIX,
            NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
        );
        for attempt in 0..=1 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                self.stop();
                return Err(P::Error::timeout());
            }
            if self.process.is_none() {
                progress(P::starting());
                match P::spawn(
                    self.spawner.as_ref(),
                    platform,
                    paths,
                    remaining,
                    &self.kill_switch,
                ) {
                    Ok(process) => self.process = Some(process),
                    Err(error) => {
                        self.kill_switch.disarm();
                        return Err(if self.kill_switch.requested() {
                            P::Error::cancelled()
                        } else {
                            error
                        });
                    }
                }
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            let result = P::recognize(
                self.process
                    .as_mut()
                    .expect("process was initialized")
                    .as_mut(),
                &request_id,
                image_path,
                remaining,
                progress,
            );
            self.last_used = Some(Instant::now());
            if self.kill_switch.requested() {
                // The child is dead or dying; an answer that arrived first still stands.
                self.stop();
                return result.map_err(|_| P::Error::cancelled());
            }
            match result {
                Err(error) if error.kind() == FailureKind::Cancelled => {
                    self.stop();
                    if attempt == 1 {
                        return Err(P::Error::crashed(P::messages().stopped.to_string()));
                    }
                }
                Err(error) if error.kind() == FailureKind::Crashed => {
                    self.stop();
                    if attempt == 1 {
                        return Err(error);
                    }
                }
                Err(error) if error.kind() == FailureKind::Timeout => {
                    self.stop();
                    return Err(error);
                }
                other => return other,
            }
        }
        Err(P::Error::crashed(P::messages().stopped_twice.to_string()))
    }

    pub fn stop_if_idle(&mut self, now: Instant) -> bool {
        if self.process.is_some()
            && self.last_used.is_some_and(|last_used| {
                now.saturating_duration_since(last_used) >= P::IDLE_TIMEOUT
            })
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
            P::shutdown(process.as_mut());
        }
        self.last_used = None;
    }
}

impl<P: SidecarProtocol> Drop for ProcessManager<P> {
    fn drop(&mut self) {
        self.stop();
    }
}

impl<P: SidecarProtocol> SystemProcess<P> {
    pub fn spawn(
        platform: &dyn EnginePlatform,
        paths: &P::LaunchPaths,
        timeout: Duration,
        kill_switch: &KillSwitch,
    ) -> Result<Self, P::Error> {
        let mut command = P::configure_command(paths);
        platform.configure_child(&mut command);
        let mut child = command
            .spawn()
            .map_err(|error| P::Error::crashed(format!("{}{error}", P::messages().start)))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| P::Error::crashed(P::messages().input.to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| P::Error::crashed(P::messages().output.to_string()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| P::Error::crashed(P::messages().log.to_string()))?;
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
                        eprintln!("{} could not read sidecar output: {error}", P::LOG_PREFIX);
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
                    Ok(line) => eprintln!("{} {line}", P::LOG_PREFIX),
                    Err(error) => {
                        eprintln!("{} could not read sidecar log: {error}", P::LOG_PREFIX);
                        break;
                    }
                }
            }
        });

        let mut process = SystemProcess {
            protocol: std::marker::PhantomData,
            child,
            stdin,
            lines: lines_rx,
        };
        let ready_result = process
            .receive_line(timeout)
            .and_then(|ready_line| P::ready(ready_line.trim_end()));
        if let Err(error) = ready_result {
            process.shutdown();
            return Err(error);
        }
        Ok(process)
    }
}

pub struct SystemProcess<P: SidecarProtocol> {
    protocol: std::marker::PhantomData<P>,
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

impl<P: SidecarProtocol> SystemProcess<P> {
    fn receive_line(&mut self, timeout: Duration) -> Result<String, P::Error> {
        match self.lines.recv_timeout(timeout) {
            Ok(SidecarOutput::Line(line)) => Ok(line),
            Ok(SidecarOutput::Killed) => Err(P::Error::cancelled()),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(P::Error::timeout()),
            Ok(SidecarOutput::Closed) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                let detail = match lock_child(&self.child).try_wait() {
                    Ok(Some(status)) => format!("{}{status}.", P::messages().exited),
                    Ok(None) => P::messages().closed.to_string(),
                    Err(error) => format!("{}{error}", P::messages().inspect),
                };
                Err(P::Error::crashed(detail))
            }
        }
    }
}

impl<P: SidecarProtocol> SystemProcess<P> {
    pub fn recognize(
        &mut self,
        request_id: &str,
        image_path: &P::Input,
        timeout: Duration,
        progress: &dyn Fn(P::Progress),
    ) -> Result<P::Response, P::Error> {
        let deadline = Instant::now() + timeout;
        if lock_child(&self.child)
            .try_wait()
            .map_err(|error| {
                P::Error::crashed(format!("{}{error}", P::messages().inspect_request))
            })?
            .is_some()
        {
            return Err(P::Error::crashed(P::messages().not_running.to_string()));
        }
        let line = P::encode(request_id, image_path)?;
        writeln!(self.stdin, "{line}")
            .and_then(|()| self.stdin.flush())
            .map_err(|error| P::Error::crashed(format!("{}{error}", P::messages().send)))?;
        // Progress lines come first, one per reading; the whole request shares one deadline.
        let answer = loop {
            let response = self.receive_line(deadline.saturating_duration_since(Instant::now()))?;
            match P::classify(response.trim_end(), request_id) {
                ResponseLine::Progress(reading) => progress(reading),
                ResponseLine::Final(answer) => break answer,
            }
        };
        answer
    }

    pub fn shutdown(&mut self) {
        if let Ok(line) = P::shutdown_line() {
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

pub fn enter_request(gate: &Mutex<()>) -> Option<std::sync::MutexGuard<'_, ()>> {
    match gate.try_lock() {
        Ok(guard) => Some(guard),
        Err(TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner()),
        Err(TryLockError::WouldBlock) => None,
    }
}

pub fn lock_ignoring_poison<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn cancel_request(cancels: &AtomicU64, kill: &KillSwitch) {
    cancels.fetch_add(1, Ordering::SeqCst);
    kill.cancel_request();
}

pub fn start_idle_reaper<P: SidecarProtocol>(
    stop: Arc<AtomicBool>,
    process: Arc<Mutex<ProcessManager<P>>>,
) {
    std::thread::spawn(move || {
        while !stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_secs(30));
            let manager = match process.try_lock() {
                Ok(manager) => Some(manager),
                Err(TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner()),
                Err(TryLockError::WouldBlock) => None,
            };
            if let Some(mut manager) = manager {
                manager.stop_if_idle(Instant::now());
            }
        }
    });
}

pub fn stop_sidecar_blocking<P: SidecarProtocol>(
    process: &Mutex<ProcessManager<P>>,
    kill: &KillSwitch,
) {
    loop {
        match process.try_lock() {
            Ok(mut manager) => return manager.stop(),
            Err(TryLockError::Poisoned(poisoned)) => return poisoned.into_inner().stop(),
            Err(TryLockError::WouldBlock) => {
                kill.kill_now();
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
}
