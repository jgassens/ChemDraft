//! A fail-closed macOS guard, installed before webviews and application setup.
//!
//! tauri-plugin-single-instance 2.4.5's macOS implementation starts its listener asynchronously,
//! unlinks the socket before binding, and continues startup on errors. Concurrent launches can
//! therefore both enter setup. An advisory lock is the authority here; IPC is only the handoff.
use crate::OpenReceipt;
use block2::RcBlock;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSAlert, NSAlertStyle, NSApplication};
use objc2_foundation::{NSString, NSTimer};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, Write},
    net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    os::{fd::AsRawFd, unix::fs::OpenOptionsExt},
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{plugin::TauriPlugin, AppHandle, Context, Manager, RunEvent, Url, Wry};

const LOCK_FILE: &str = "single-instance.lock";
const MAX_MESSAGE_BYTES: usize = 256 * 1024;
const HANDOFF_TIMEOUT: Duration = Duration::from_secs(2);
const TAKEOVER_TIMEOUT: Duration = Duration::from_secs(10);
const LOCK_RETRY: Duration = Duration::from_millis(20);
const OPEN_QUIET_PERIOD: Duration = Duration::from_millis(300);
const OPEN_COLLECTION_CAP: Duration = Duration::from_secs(5);

#[derive(Deserialize, Serialize)]
struct Endpoint {
    port: u16,
    token: [u8; 32],
}

#[derive(Debug, Deserialize, Serialize)]
struct Launch {
    token: [u8; 32],
    #[serde(flatten)]
    request: LaunchRequest,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct LaunchRequest {
    pub argv: Vec<String>,
    pub cwd: String,
    #[serde(default)]
    pub urls: Vec<Url>,
}

// Never unlink this file: replacing its inode would let a second process lock a different file.
// Closing the descriptor (including a crash/SIGKILL) releases flock without stale-lock recovery.
pub struct InstanceLock {
    file: File,
}

impl Drop for InstanceLock {
    fn drop(&mut self) {
        // A concurrently spawned child can briefly share the open file description before
        // exec closes its CLOEXEC descriptor. Relinquish ownership when *this* owner drops
        // the guard. The kernel still releases the lock on a crash.
        // SAFETY: the descriptor remains live through this call and closes immediately after.
        unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) };
    }
}

impl InstanceLock {
    fn acquire(directory: &Path) -> io::Result<Option<Self>> {
        fs::create_dir_all(directory)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(directory.join(LOCK_FILE))?;
        // SAFETY: file owns a valid descriptor; LOCK_NB never waits for another process.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(Some(Self { file }));
        }
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::WouldBlock {
            Ok(None)
        } else {
            Err(error)
        }
    }

    fn publish(&mut self) -> io::Result<(TcpListener, Endpoint)> {
        // A loopback port avoids macOS's short Unix-socket path limit for long home directories.
        // Only a process able to read the app-data lock file can authenticate a handoff.
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let mut token = [0; 32];
        getrandom::fill(&mut token).map_err(|error| io::Error::other(error.to_string()))?;
        let endpoint = Endpoint {
            port: listener.local_addr()?.port(),
            token,
        };
        self.write_endpoint(&endpoint)?;
        Ok((listener, endpoint))
    }

    fn write_endpoint(&mut self, endpoint: &Endpoint) -> io::Result<()> {
        self.file.rewind()?;
        self.file.set_len(0)?;
        serde_json::to_writer(&mut self.file, endpoint)?;
        self.file.flush()
    }
}

pub fn init(context: &mut Context<Wry>) -> (Option<InstanceLock>, Option<Arc<SecondaryLaunch>>) {
    // Match PathResolver::app_data_dir. The identifier separates stable and dev builds.
    let directory = dirs::data_dir()
        .ok_or_else(|| io::Error::other("ChemDraft's application data directory is unavailable"))
        .map(|data| data.join(&context.config().identifier));
    let guard = directory
        .as_ref()
        .ok()
        .and_then(|path| InstanceLock::acquire(path).ok().flatten());
    if let Some(guard) = guard {
        return (Some(guard), None);
    }
    // Keep the config for a possible takeover while starting the secondary without windows.
    for window in &mut context.config_mut().app.windows {
        window.create = false;
    }
    (None, Some(Arc::new(SecondaryLaunch::new(directory))))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Acknowledgement {
    Accepted = 1,
    Refused = 2,
    Failed = 3,
}

// The legacy primary writes just 1 when scheduling its callback. A confirmed primary writes
// both bytes in one reply, keeping older secondaries compatible after the actual open.
const CONFIRMED_OPEN_VERSION: u8 = 2;

#[derive(Clone, Copy, Deserialize, Serialize)]
pub struct RendererReceipt {
    batch: u32,
    file: usize,
}

pub enum Reply {
    Secondary(mpsc::Sender<Acknowledgement>),
    Takeover(LaunchRequest),
}

impl Reply {
    pub fn finish(self, result: Acknowledgement, on_takeover_failure: impl FnOnce(LaunchRequest)) {
        match self {
            Self::Secondary(sender) => {
                let _ = sender.send(result);
            }
            Self::Takeover(launch) if result != Acknowledgement::Accepted => {
                on_takeover_failure(launch);
            }
            Self::Takeover(_) => {}
        }
    }
}

struct PendingBatch {
    outstanding: HashSet<usize>,
    paths: Vec<String>,
    reply: Option<Reply>,
}

#[derive(Default)]
pub struct RendererOpens {
    next: u32,
    batches: HashMap<u32, PendingBatch>,
}

impl RendererOpens {
    fn track(&mut self, payloads: &mut [crate::NativeOpenDocumentPayload], reply: Reply) -> u32 {
        let id = self.next;
        self.next = self.next.checked_add(1).expect("exhausted handoff IDs");
        for (file, payload) in payloads.iter_mut().enumerate() {
            payload.receipt = Some(OpenReceipt::Handoff(RendererReceipt { batch: id, file }));
        }
        self.batches.insert(
            id,
            PendingBatch {
                outstanding: (0..payloads.len()).collect(),
                paths: payloads
                    .iter()
                    .map(|payload| payload.path.clone())
                    .collect(),
                reply: Some(reply),
            },
        );
        id
    }

    fn consume(
        &mut self,
        receipt: RendererReceipt,
        opened: bool,
    ) -> Option<(Reply, Acknowledgement)> {
        let batch = self.batches.get_mut(&receipt.batch)?;
        if !batch.outstanding.contains(&receipt.file) {
            return None;
        }
        if !opened {
            return Some((self.fail(receipt.batch)?, Acknowledgement::Failed));
        }
        batch.outstanding.remove(&receipt.file);
        if batch.outstanding.is_empty() {
            Some((
                self.batches.remove(&receipt.batch)?.reply?,
                Acknowledgement::Accepted,
            ))
        } else {
            None
        }
    }

    fn fail(&mut self, id: u32) -> Option<Reply> {
        let reply = self.batches.get_mut(&id)?.reply.take()?;
        if matches!(reply, Reply::Secondary(_)) {
            // The other process owns these paths until it receives an acknowledgement.
            self.batches.remove(&id);
        }
        Some(reply)
    }

    fn persist_with(
        &mut self,
        mut paths: Vec<String>,
        record: impl FnOnce(&[String]) -> Result<(), String>,
    ) -> Result<(), String> {
        for batch in self.batches.values() {
            if !matches!(batch.reply, Some(Reply::Secondary(_))) {
                paths.extend(
                    batch
                        .paths
                        .iter()
                        .enumerate()
                        .filter(|(index, _)| batch.outstanding.contains(index))
                        .map(|(_, path)| path.clone()),
                );
            }
        }
        record(&paths)?;
        self.batches.clear();
        Ok(())
    }
}

pub fn track_renderer_open(
    app: &AppHandle,
    payloads: &mut [crate::NativeOpenDocumentPayload],
    reply: Reply,
) -> u32 {
    let id = app
        .state::<Mutex<RendererOpens>>()
        .lock()
        .unwrap()
        .track(payloads, reply);
    let app = app.clone();
    let tick = RcBlock::new(move |_| {
        fail_renderer_open(
            &app,
            id,
            "The document window did not confirm every file open in time.",
        );
    });
    // Main run loop, including during cold-start takeover. Bound both the receipt lifetime and
    // the time before a promoted secondary with an unresponsive renderer shows its own alert.
    unsafe {
        NSTimer::scheduledTimerWithTimeInterval_repeats_block(
            TAKEOVER_TIMEOUT.as_secs_f64(),
            false,
            &tick,
        )
    };
    id
}

pub fn fail_renderer_open(app: &AppHandle, id: u32, error: &str) {
    let reply = app.state::<Mutex<RendererOpens>>().lock().unwrap().fail(id);
    if let Some(reply) = reply {
        reply.finish(Acknowledgement::Failed, |launch| {
            crate::report_open_failure(app, launch_error_message(&launch, error));
        });
    }
}

pub fn renderer_consumed(app: &AppHandle, receipt: RendererReceipt, opened: bool) {
    let reply = app
        .state::<Mutex<RendererOpens>>()
        .lock()
        .unwrap()
        .consume(receipt, opened);
    if let Some((reply, result)) = reply {
        reply.finish(result, |launch| {
            crate::report_open_failure(
                app,
                launch_error_message(
                    &launch,
                    "The document window could not open every requested file.",
                ),
            );
        });
    }
}

pub fn renderer_exiting<R: tauri::Runtime>(
    app: &AppHandle<R>,
    paths: Vec<String>,
    notice: bool,
) -> Result<(), String> {
    app.state::<Mutex<RendererOpens>>()
        .try_lock()
        .map_err(|error| error.to_string())?
        .persist_with(paths, |paths| {
            crate::record_pending_opens(app, paths, notice)
        })
}

pub fn plugin(
    mut guard: InstanceLock,
    callback: impl Fn(&AppHandle<Wry>, LaunchRequest, Reply) + Send + Sync + 'static,
) -> TauriPlugin<Wry> {
    tauri::plugin::Builder::new("single-instance")
        .setup(move |app, _| {
            let (listener, endpoint) = guard.publish()?;
            let app_handle = app.clone();
            thread::Builder::new()
                .name("single-instance".into())
                .spawn(move || {
                    let callback = Arc::new(callback);
                    for connection in listener.incoming() {
                        let result = connection.and_then(|mut stream| {
                            stream.set_read_timeout(Some(HANDOFF_TIMEOUT))?;
                            stream.set_write_timeout(Some(HANDOFF_TIMEOUT))?;
                            receive_launch(&mut stream, &endpoint.token, |launch| {
                                if crate::QUIT.refuses_macos_launch() {
                                    return Ok(Acknowledgement::Refused);
                                }
                                let app = app_handle.clone();
                                let callback = callback.clone();
                                let (send_reply, reply) = mpsc::channel();
                                let deadline = Instant::now() + TAKEOVER_TIMEOUT;
                                app_handle
                                    .run_on_main_thread(move || {
                                        // Skip work still queued after the IPC worker timed out.
                                        if Instant::now() < deadline {
                                            callback(&app, launch, Reply::Secondary(send_reply));
                                        }
                                    })
                                    .map_err(io::Error::other)?;
                                reply
                                    .recv_timeout(
                                        deadline.saturating_duration_since(Instant::now()),
                                    )
                                    .map_err(io::Error::other)
                            })
                        });
                        if let Err(error) = result {
                            eprintln!("ChemDraft single-instance handoff failed: {error}");
                        }
                    }
                })?;
            // The descriptor stays alive through session flush and application teardown. The IPC
            // thread never owns it, so a listener failure cannot release the startup guard.
            app.manage(guard);
            Ok(())
        })
        .build()
}

#[derive(Default)]
struct OpenCollection {
    launch: LaunchRequest,
    started: Option<Instant>,
    last_open: Option<Instant>,
}

impl OpenCollection {
    fn append(&mut self, urls: &[Url], now: Instant) {
        if !urls.is_empty() {
            self.started.get_or_insert(now);
            self.launch.urls.extend_from_slice(urls);
            self.last_open = Some(now);
        }
    }

    fn deadline(&self) -> Option<Instant> {
        let started = self.started?;
        let last_open = self.last_open.unwrap_or(started).max(started);
        Some((last_open + OPEN_QUIET_PERIOD).min(started + OPEN_COLLECTION_CAP))
    }
}

type StartPrimary = fn(&AppHandle<Wry>, InstanceLock) -> Result<(), Box<dyn std::error::Error>>;

struct Handoff {
    launch: LaunchRequest,
    result: mpsc::Receiver<io::Result<Resolution>>,
    resolved: Option<io::Result<Resolution>>,
}

impl Handoff {
    fn poll(&mut self) -> Option<&io::Result<Resolution>> {
        if self.resolved.is_none() {
            self.resolved = match self.result.try_recv() {
                Ok(result) => Some(result),
                Err(mpsc::TryRecvError::Disconnected) => Some(Err(io::Error::other(
                    "the single-instance handoff worker stopped",
                ))),
                Err(mpsc::TryRecvError::Empty) => None,
            };
        }
        self.resolved.as_ref()
    }
}

struct SecondaryState {
    collection: OpenCollection,
    handoff: Option<Handoff>,
    promoting: Option<LaunchRequest>,
    promoted: bool,
    terminating: bool,
    exiting: bool,
    exit_code: i32,
}

impl SecondaryState {
    fn interrupted_launch(&mut self) -> LaunchRequest {
        let late = &self.collection.launch;
        let unconfirmed = self.promoting.as_ref().or_else(|| {
            let handoff = self.handoff.as_mut()?;
            // Cache the reply so a veto can resume the same handoff, including a won lock.
            (!matches!(handoff.poll(), Some(Ok(Resolution::Forwarded)))).then_some(&handoff.launch)
        });
        if let Some(launch) = unconfirmed {
            let mut launch = launch.clone();
            launch.urls.extend_from_slice(&late.urls);
            launch
        } else {
            late.clone()
        }
    }
}

pub struct SecondaryLaunch {
    directory: io::Result<PathBuf>,
    state: Mutex<SecondaryState>,
}

impl SecondaryLaunch {
    fn new(directory: io::Result<PathBuf>) -> Self {
        Self {
            directory,
            state: Mutex::new(SecondaryState {
                collection: OpenCollection {
                    launch: LaunchRequest {
                        argv: std::env::args_os()
                            .map(|arg| arg.to_string_lossy().into_owned())
                            .collect(),
                        cwd: std::env::current_dir()
                            .map(|cwd| cwd.to_string_lossy().into_owned())
                            .unwrap_or_default(),
                        urls: Vec::new(),
                    },
                    ..Default::default()
                },
                handoff: None,
                promoting: None,
                promoted: false,
                terminating: false,
                exiting: false,
                exit_code: 0,
            }),
        }
    }

    // AppKit termination can bypass ExitRequested. Preserve unconfirmed and late opens.
    pub fn record_interrupted_launch(
        &self,
        app: &AppHandle,
        notice: bool,
    ) -> Option<Result<(), String>> {
        self.record_interrupted_launch_with(|paths| crate::record_pending_opens(app, paths, notice))
    }

    fn record_interrupted_launch_with(
        &self,
        record: impl FnOnce(&[String]) -> Result<(), String>,
    ) -> Option<Result<(), String>> {
        let mut state = self.state.lock().unwrap();
        if state.promoted {
            return None;
        }
        let launch = state.interrupted_launch();
        let mut paths: Vec<_> = launch
            .urls
            .iter()
            .filter_map(|url| url.to_file_path().ok())
            .collect();
        let cwd = Path::new(&launch.cwd);
        for arg in launch
            .argv
            .iter()
            .skip(1)
            .filter(|arg| !arg.starts_with('-'))
        {
            let path = cwd.join(arg);
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
        let result = record(
            &paths
                .into_iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
        );
        if result.is_ok() {
            state.terminating = true;
            state.collection = OpenCollection::default();
            state.handoff = None;
            state.promoting = None;
        }
        Some(result)
    }

    // Keep one Tauri event loop. When we take over, run normal startup in this windowless app.
    pub fn handle_event(
        self: &Arc<Self>,
        app: &AppHandle<Wry>,
        event: &RunEvent,
        start_primary: StartPrimary,
    ) -> bool {
        if matches!(event, RunEvent::Exit) {
            return self
                .record_interrupted_launch(app, true)
                .is_some_and(|result| {
                    if let Err(error) = result {
                        eprintln!("Could not record document opens for relaunch: {error}");
                    }
                    true
                });
        }
        let mut state = self.state.lock().unwrap();
        if state.promoted {
            return false;
        }
        let deadline = match event {
            RunEvent::Opened { urls } => {
                state.collection.append(urls, Instant::now());
                None
            }
            RunEvent::Ready => {
                state.collection.started = Some(Instant::now());
                state.collection.deadline()
            }
            RunEvent::ExitRequested { code, api, .. } => {
                // AppHandle::exit posts an event. Keep collecting if an Opened event arrived
                // between posting it and receiving it.
                if state.exiting && *code == Some(state.exit_code) {
                    let deadline = state.collection.deadline();
                    if deadline.is_some() {
                        api.prevent_exit();
                        state.exiting = false;
                    }
                    deadline
                } else {
                    api.prevent_exit();
                    None
                }
            }
            _ => None,
        };
        drop(state);
        if let Some(deadline) = deadline {
            self.schedule(app, start_primary, deadline);
        }
        true
    }

    fn schedule(
        self: &Arc<Self>,
        app: &AppHandle<Wry>,
        start_primary: StartPrimary,
        deadline: Instant,
    ) {
        let delay = deadline.saturating_duration_since(Instant::now());
        let secondary = self.clone();
        let app = app.clone();
        let tick = RcBlock::new(move |_| secondary.tick(&app, start_primary));
        // SAFETY: The block captures sendable values and is scheduled on AppKit's main run loop.
        unsafe {
            NSTimer::scheduledTimerWithTimeInterval_repeats_block(delay.as_secs_f64(), false, &tick)
        };
    }

    fn tick(self: &Arc<Self>, app: &AppHandle<Wry>, start_primary: StartPrimary) {
        let mut state = self.state.lock().unwrap();
        if state.terminating || state.promoting.is_some() || state.promoted {
            return;
        }
        let now = Instant::now();
        if let Some(handoff) = state.handoff.as_mut() {
            if handoff.poll().is_none() {
                drop(state);
                self.schedule(app, start_primary, now + LOCK_RETRY);
                return;
            }
            let handoff = state.handoff.take().unwrap();
            drop(state);
            self.complete(
                app,
                start_primary,
                handoff.launch,
                handoff.resolved.unwrap(),
            );
            return;
        }

        let Some(deadline) = state.collection.deadline() else {
            return;
        };
        if now < deadline {
            drop(state);
            self.schedule(app, start_primary, deadline);
            return;
        }
        let launch = std::mem::take(&mut state.collection).launch;
        drop(state);

        // The lock wait and socket I/O must leave AppKit free to receive subsequent file opens.
        let secondary = self.clone();
        let request = launch.clone();
        let (send, result) = mpsc::channel();
        match thread::Builder::new()
            .name("forward-launch".into())
            .spawn(move || {
                let result = match &secondary.directory {
                    Ok(directory) => {
                        resolve_launch_with(directory, &request, TAKEOVER_TIMEOUT, connect)
                    }
                    Err(error) => Err(io::Error::other(error.to_string())),
                };
                let _ = send.send(result);
            }) {
            Ok(_) => {
                self.state.lock().unwrap().handoff = Some(Handoff {
                    launch,
                    result,
                    resolved: None,
                });
                self.schedule(app, start_primary, now + LOCK_RETRY);
            }
            Err(error) => self.complete(app, start_primary, launch, Err(error)),
        };
    }

    fn complete(
        self: &Arc<Self>,
        app: &AppHandle<Wry>,
        start_primary: StartPrimary,
        mut launch: LaunchRequest,
        result: io::Result<Resolution>,
    ) {
        let error = match result {
            Ok(Resolution::Primary(guard)) => {
                // Retain ownership through window creation and setup. AppKit can deliver more
                // Opened events, or terminate us, while either operation runs a nested loop.
                self.state.lock().unwrap().promoting = Some(launch.clone());
                let startup = start_primary(app, guard);
                let mut state = self.state.lock().unwrap();
                if state.terminating {
                    return; // The termination recorder already accounted for this batch.
                }
                state.promoting = None;
                launch
                    .urls
                    .extend(std::mem::take(&mut state.collection).launch.urls);
                match startup {
                    Ok(()) => {
                        state.promoted = true;
                        drop(state);
                        crate::open_macos_launch(app, &launch, Reply::Takeover(launch.clone()));
                        return;
                    }
                    Err(error) => Some(error.to_string()),
                }
            }
            Ok(Resolution::Forwarded) => None,
            Err(error) => Some(error.to_string()),
        };

        if let Some(error) = error {
            self.state.lock().unwrap().exit_code = 1;
            show_launch_error(&launch, &error);
        }

        let mut state = self.state.lock().unwrap();
        if let Some(deadline) = state.collection.deadline() {
            drop(state);
            self.schedule(app, start_primary, deadline);
        } else {
            state.exiting = true;
            let code = state.exit_code;
            drop(state);
            app.exit(code);
        }
    }
}

pub(super) fn launch_error_message(launch: &LaunchRequest, error: &str) -> String {
    let mut files = Vec::new();
    for url in launch.urls.iter().filter(|url| url.scheme() == "file") {
        let path = url
            .to_file_path()
            .map_or_else(|_| url.to_string(), |path| path.display().to_string());
        if !files.contains(&path) {
            files.push(path);
        }
    }
    for arg in launch
        .argv
        .iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
    {
        let path = Path::new(&launch.cwd).join(arg).display().to_string();
        if !files.contains(&path) {
            files.push(path);
        }
    }
    if files.is_empty() {
        error.to_owned()
    } else {
        format!("{error}\n\nRequested files:\n{}", files.join("\n"))
    }
}

pub fn show_launch_error(launch: &LaunchRequest, error: &str) {
    let message = launch_error_message(launch, error);
    eprintln!("ChemDraft could not complete the document open: {message}");
    let mtm = MainThreadMarker::new().expect("launch error is shown on the main thread");
    let app = NSApplication::sharedApplication(mtm);
    #[allow(deprecated)]
    app.activateIgnoringOtherApps(true);
    let alert = NSAlert::new(mtm);
    alert.setAlertStyle(NSAlertStyle::Critical);
    alert.setMessageText(&NSString::from_str(
        "ChemDraft could not complete the document open",
    ));
    alert.setInformativeText(&NSString::from_str(&message));
    alert.runModal();
}

fn read_endpoint(directory: &Path) -> io::Result<Endpoint> {
    let file = File::open(directory.join(LOCK_FILE))?;
    Ok(serde_json::from_reader(file.take(1024))?)
}

enum Resolution {
    Primary(InstanceLock),
    Forwarded,
}

fn connect(endpoint: &Endpoint, timeout: Duration) -> io::Result<TcpStream> {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, endpoint.port));
    let stream = TcpStream::connect_timeout(&address, timeout.min(HANDOFF_TIMEOUT))?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    Ok(stream)
}

fn resolve_launch_with<S: Read + Write>(
    directory: &Path,
    launch: &LaunchRequest,
    wait: Duration,
    mut connect: impl FnMut(&Endpoint, Duration) -> io::Result<S>,
) -> io::Result<Resolution> {
    let deadline = Instant::now() + wait;
    let mut last_error = io::Error::other("the running copy did not accept the launch");
    let mut attempted_owner = None;
    loop {
        // Recheck ownership after collecting, and after each refusal or transport error.
        if let Some(guard) = InstanceLock::acquire(directory)? {
            return Ok(Resolution::Primary(guard));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(last_error);
        }
        match read_endpoint(directory) {
            Ok(endpoint) if attempted_owner != Some(endpoint.token) => {
                match connect(&endpoint, remaining) {
                    Ok(mut stream) => {
                        // A lost reply can leave delivery ambiguous. Try a new owner if one takes
                        // over, but don't send the same request twice to this owner.
                        attempted_owner = Some(endpoint.token);
                        match send_launch(&mut stream, &endpoint, launch) {
                            Ok(Acknowledgement::Accepted) => return Ok(Resolution::Forwarded),
                            Ok(Acknowledgement::Refused) => {
                                // Refusal guarantees no work was queued. The same owner can
                                // finish setup or cancel a quit prompt before the deadline.
                                attempted_owner = None;
                                last_error = io::Error::other(
                                    "the running copy refused the request and still holds the launch lock",
                                );
                            }
                            Ok(Acknowledgement::Failed) => {
                                return Err(io::Error::other(
                                    "the running copy could not open every requested document",
                                ));
                            }
                            Err(error) => last_error = error,
                        }
                    }
                    Err(error) => last_error = error,
                }
            }
            Ok(_) => {}
            Err(error) => last_error = error,
        }
        thread::sleep(LOCK_RETRY.min(deadline.saturating_duration_since(Instant::now())));
    }
}

fn send_launch(
    stream: &mut (impl Read + Write),
    endpoint: &Endpoint,
    launch: &LaunchRequest,
) -> io::Result<Acknowledgement> {
    let mut frame = vec![0; 4];
    serde_json::to_writer(
        &mut frame,
        &Launch {
            token: endpoint.token,
            request: launch.clone(),
        },
    )?;
    let size = frame.len() - 4;
    if size > MAX_MESSAGE_BYTES {
        return Err(io::Error::other(
            "second-launch request exceeds the handoff limit",
        ));
    }
    frame[..4].copy_from_slice(&(size as u32).to_le_bytes());
    stream.write_all(&frame)?;
    let mut acknowledgement = [0];
    stream.read_exact(&mut acknowledgement)?;
    match acknowledgement[0] {
        1 => {
            let mut version = [0];
            if stream.read_exact(&mut version).is_ok() && version == [CONFIRMED_OPEN_VERSION] {
                Ok(Acknowledgement::Accepted)
            } else {
                Err(io::Error::other(
                    "the running copy did not confirm that its document window opened the files",
                ))
            }
        }
        2 => Ok(Acknowledgement::Refused),
        3 => Ok(Acknowledgement::Failed),
        _ => Err(io::Error::other("invalid second-launch acknowledgement")),
    }
}

fn receive_launch(
    stream: &mut (impl Read + Write),
    token: &[u8; 32],
    deliver: impl FnOnce(LaunchRequest) -> io::Result<Acknowledgement>,
) -> io::Result<()> {
    let mut size = [0; 4];
    stream.read_exact(&mut size)?;
    let size = u32::from_le_bytes(size) as usize;
    if size > MAX_MESSAGE_BYTES {
        return Err(io::Error::other(
            "second-launch message exceeds the handoff limit",
        ));
    }
    let mut bytes = vec![0; size];
    stream.read_exact(&mut bytes)?;
    let launch: Launch = serde_json::from_slice(&bytes)?;
    if &launch.token != token {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "invalid handoff token",
        ));
    }
    let acknowledgement = deliver(launch.request)?;
    if acknowledgement == Acknowledgement::Accepted {
        stream.write_all(&[acknowledgement as u8, CONFIRMED_OPEN_VERSION])
    } else {
        stream.write_all(&[acknowledgement as u8])
    }
}

#[cfg(test)]
mod single_instance_tests {
    use super::*;
    use std::{
        os::unix::net::UnixStream,
        path::PathBuf,
        process::Command,
        sync::atomic::{AtomicU64, Ordering},
    };

    // Anonymous sockets exercise the framed protocol in restricted test hosts without requiring
    // permission to listen on a TCP port. Production binds only IPv4 loopback.
    fn streams() -> (UnixStream, UnixStream) {
        let (client, server) = UnixStream::pair().unwrap();
        for stream in [&client, &server] {
            stream.set_read_timeout(Some(HANDOFF_TIMEOUT)).unwrap();
            stream.set_write_timeout(Some(HANDOFF_TIMEOUT)).unwrap();
        }
        (client, server)
    }

    struct Directory(PathBuf);

    impl Directory {
        fn new() -> Self {
            static SERIAL: AtomicU64 = AtomicU64::new(0);
            let directory = std::env::temp_dir().join(format!(
                "chemdraft-single-instance-{}-{}",
                std::process::id(),
                SERIAL.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&directory).unwrap();
            Self(directory)
        }
    }

    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn single_instance_process_probe() {
        let Some(directory) = std::env::var_os("CHEMDRAFT_SINGLE_INSTANCE_TEST_DIR") else {
            return;
        };
        let directory = PathBuf::from(directory);
        match std::env::var("CHEMDRAFT_SINGLE_INSTANCE_TEST_MODE")
            .unwrap()
            .as_str()
        {
            "contend" => assert!(InstanceLock::acquire(&directory).unwrap().is_none()),
            "hold" => {
                let _guard = InstanceLock::acquire(&directory).unwrap().unwrap();
                fs::write(directory.join("ready"), "ready").unwrap();
                loop {
                    thread::park();
                }
            }
            mode => panic!("unknown single-instance test mode: {mode}"),
        }
    }

    fn probe(directory: &Path, mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["single_instance_process_probe", "--nocapture"])
            .env("CHEMDRAFT_SINGLE_INSTANCE_TEST_DIR", directory)
            .env("CHEMDRAFT_SINGLE_INSTANCE_TEST_MODE", mode);
        command
    }

    #[test]
    fn single_instance_rejects_second_process_without_changing_shared_files() {
        let directory = Directory::new();
        let _guard = InstanceLock::acquire(&directory.0).unwrap().unwrap();
        for file in ["document-session.json", "toolbar-state.json"] {
            fs::write(directory.0.join(file), "original").unwrap();
        }
        assert!(probe(&directory.0, "contend").status().unwrap().success());
        assert!(InstanceLock::acquire(&directory.0).unwrap().is_none());
        for file in ["document-session.json", "toolbar-state.json"] {
            assert_eq!(
                fs::read_to_string(directory.0.join(file)).unwrap(),
                "original"
            );
        }
    }

    #[test]
    fn single_instance_releases_after_abrupt_process_exit() {
        let directory = Directory::new();
        let mut child = probe(&directory.0, "hold").spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !directory.0.join("ready").exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        let ready = directory.0.join("ready").exists();
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(ready, "lock holder did not start");
        assert!(InstanceLock::acquire(&directory.0).unwrap().is_some());
    }

    #[test]
    fn single_instance_stable_and_dev_lock_independently_and_reuse_stale_file() {
        let directory = Directory::new();
        let stable = directory.0.join("org.chemdraft.desktop");
        let dev = directory.0.join("org.chemdraft.desktop.dev");
        let stable_guard = InstanceLock::acquire(&stable).unwrap().unwrap();
        let _dev_guard = InstanceLock::acquire(&dev).unwrap().unwrap();
        fs::write(stable.join(LOCK_FILE), "stale endpoint").unwrap();
        assert!(InstanceLock::acquire(&stable).unwrap().is_none());
        assert!(InstanceLock::acquire(&dev).unwrap().is_none());
        drop(stable_guard);
        assert!(InstanceLock::acquire(&stable).unwrap().is_some());
    }

    #[test]
    fn single_instance_simultaneous_launches_choose_one_owner() {
        use std::sync::{Arc, Barrier};

        let directory = Directory::new();
        let barrier = Arc::new(Barrier::new(8));
        let launches: Vec<_> = (0..8)
            .map(|_| {
                let path = directory.0.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    let guard = InstanceLock::acquire(&path).unwrap();
                    // Nobody releases the lock until every launch has tried to acquire it.
                    barrier.wait();
                    guard.is_some()
                })
            })
            .collect();
        let owners = launches
            .into_iter()
            .map(|launch| usize::from(launch.join().unwrap()))
            .sum::<usize>();
        assert_eq!(owners, 1);
    }

    #[test]
    fn single_instance_waits_for_owner_to_publish_its_endpoint() {
        let directory = Directory::new();
        let mut guard = InstanceLock::acquire(&directory.0).unwrap().unwrap();
        let path = directory.0.clone();
        let (client, mut server) = streams();
        let client = thread::spawn(move || {
            let mut client = Some(client);
            resolve_launch_with(
                &path,
                &LaunchRequest::default(),
                TAKEOVER_TIMEOUT,
                |_, _| Ok(client.take().unwrap()),
            )
        });
        // The first launch can be descheduled between locking and publishing its endpoint.
        thread::sleep(Duration::from_millis(60));
        let endpoint = Endpoint {
            port: 1,
            token: [3; 32],
        };
        guard.write_endpoint(&endpoint).unwrap();
        receive_launch(&mut server, &endpoint.token, |_| {
            Ok(Acknowledgement::Accepted)
        })
        .unwrap();
        assert!(matches!(
            client.join().unwrap().unwrap(),
            Resolution::Forwarded
        ));
    }

    #[test]
    fn single_instance_reclaims_lock_if_primary_exits_during_collection() {
        let directory = Directory::new();
        let mut primary = InstanceLock::acquire(&directory.0).unwrap().unwrap();
        primary
            .write_endpoint(&Endpoint {
                port: 1,
                token: [5; 32],
            })
            .unwrap();
        assert!(InstanceLock::acquire(&directory.0).unwrap().is_none());
        drop(primary);

        let path = directory.0.join("takeover.chemdraft");
        fs::write(&path, "<CDXML/>").unwrap();
        let launch = LaunchRequest {
            urls: vec![Url::from_file_path(&path).unwrap()],
            ..Default::default()
        };
        let resolution =
            resolve_launch_with::<UnixStream>(&directory.0, &launch, TAKEOVER_TIMEOUT, |_, _| {
                panic!("must acquire the free lock before connecting to the stale endpoint")
            })
            .unwrap();
        assert!(matches!(resolution, Resolution::Primary(_)));
        assert!(InstanceLock::acquire(&directory.0).unwrap().is_none());

        let pending = crate::PendingOpenDocument::default();
        crate::deliver_opened_documents(crate::forwarded_document_payloads(&launch), |batch| {
            assert_eq!(
                pending.record(batch, false)?,
                crate::OpenDocumentDelivery::PendingOnly
            );
            Ok(())
        })
        .unwrap();
        let opened = pending.drain().unwrap();
        assert_eq!(opened.len(), 1);
        assert_eq!(opened[0].path, path.to_str().unwrap());
    }

    #[test]
    fn single_instance_waits_for_quitting_primary_after_refusal() {
        let directory = Directory::new();
        let mut primary = InstanceLock::acquire(&directory.0).unwrap().unwrap();
        let endpoint = Endpoint {
            port: 1,
            token: [6; 32],
        };
        primary.write_endpoint(&endpoint).unwrap();
        let (client, mut server) = streams();
        let path = directory.0.clone();
        let url = Url::from_file_path(path.join("requested.chemdraft")).unwrap();
        let launch = LaunchRequest {
            urls: vec![url.clone()],
            ..Default::default()
        };
        let secondary = thread::spawn(move || {
            let mut client = Some(client);
            resolve_launch_with(&path, &launch, TAKEOVER_TIMEOUT, |_, _| {
                client.take().ok_or(io::ErrorKind::ConnectionRefused.into())
            })
        });
        receive_launch(&mut server, &endpoint.token, |request| {
            assert_eq!(request.urls, [url]);
            Ok(Acknowledgement::Refused)
        })
        .unwrap();
        assert!(InstanceLock::acquire(&directory.0).unwrap().is_none());
        drop(primary);
        assert!(matches!(
            secondary.join().unwrap().unwrap(),
            Resolution::Primary(_)
        ));
    }

    #[test]
    fn single_instance_reclaims_lock_if_primary_disconnects_before_acknowledging() {
        let directory = Directory::new();
        let mut primary = InstanceLock::acquire(&directory.0).unwrap().unwrap();
        let endpoint = Endpoint {
            port: 1,
            token: [6; 32],
        };
        primary.write_endpoint(&endpoint).unwrap();
        let (client, mut server) = streams();
        let owner = thread::spawn(move || {
            let error = receive_launch(&mut server, &endpoint.token, |_| {
                drop(primary);
                Err(io::ErrorKind::ConnectionAborted.into())
            })
            .unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::ConnectionAborted);
        });

        let mut client = Some(client);
        let resolution = resolve_launch_with(
            &directory.0,
            &LaunchRequest::default(),
            TAKEOVER_TIMEOUT,
            |_, _| Ok(client.take().unwrap()),
        )
        .unwrap();
        assert!(matches!(resolution, Resolution::Primary(_)));
        owner.join().unwrap();
    }

    #[test]
    fn single_instance_sends_refused_acknowledgement() {
        let endpoint = Endpoint {
            port: 1,
            token: [7; 32],
        };
        let (mut client, mut server) = streams();
        let server = thread::spawn(move || {
            receive_launch(&mut server, &endpoint.token, |_| {
                Ok(Acknowledgement::Refused)
            })
            .unwrap();
        });
        assert_eq!(
            send_launch(&mut client, &endpoint, &LaunchRequest::default()).unwrap(),
            Acknowledgement::Refused
        );
        server.join().unwrap();
    }

    #[test]
    fn single_instance_retries_explicit_refusal_against_the_same_owner() {
        let directory = Directory::new();
        let mut guard = InstanceLock::acquire(&directory.0).unwrap().unwrap();
        let endpoint = Endpoint {
            port: 1,
            token: [9; 32],
        };
        guard.write_endpoint(&endpoint).unwrap();
        let url = Url::from_file_path(directory.0.join("opening.chemdraft")).unwrap();
        let launch = LaunchRequest {
            urls: vec![url.clone()],
            ..Default::default()
        };
        let (first, mut starting) = streams();
        let (second, mut ready) = streams();
        let server = thread::spawn(move || {
            for (stream, reply) in [
                (&mut starting, Acknowledgement::Refused),
                (&mut ready, Acknowledgement::Accepted),
            ] {
                receive_launch(stream, &endpoint.token, |request| {
                    assert_eq!(request.urls, std::slice::from_ref(&url));
                    Ok(reply)
                })
                .unwrap();
            }
        });
        let mut connections = [first, second].into_iter();
        let result = resolve_launch_with(&directory.0, &launch, HANDOFF_TIMEOUT, |_, _| {
            Ok(connections.next().unwrap())
        })
        .unwrap();
        assert!(matches!(result, Resolution::Forwarded));
        assert!(connections.next().is_none());
        server.join().unwrap();
    }

    #[test]
    fn single_instance_legacy_ack_cannot_confirm_or_replay_a_file_open() {
        let directory = Directory::new();
        let mut owner = InstanceLock::acquire(&directory.0).unwrap().unwrap();
        owner
            .write_endpoint(&Endpoint {
                port: 1,
                token: [9; 32],
            })
            .unwrap();
        let launch = LaunchRequest {
            urls: vec![Url::from_file_path(directory.0.join("legacy.cdx")).unwrap()],
            ..Default::default()
        };
        let (client, mut legacy) = streams();
        let server = thread::spawn(move || {
            let mut length = [0; 4];
            legacy.read_exact(&mut length).unwrap();
            legacy
                .read_exact(&mut vec![0; u32::from_le_bytes(length) as usize])
                .unwrap();
            legacy.write_all(&[1]).unwrap();
        });
        let mut client = Some(client);
        let Err(error) =
            resolve_launch_with(&directory.0, &launch, Duration::from_millis(150), |_, _| {
                Ok(client
                    .take()
                    .expect("a legacy reply is ambiguous; never replay to that owner"))
            })
        else {
            panic!("legacy scheduling ack must not be treated as an open");
        };
        assert!(error.to_string().contains("did not confirm"));
        assert!(launch_error_message(&launch, &error.to_string()).contains("legacy.cdx"));
        server.join().unwrap();
    }

    #[test]
    fn single_instance_waits_for_each_renderer_confirmation_after_the_destructive_drain() {
        let directory = Directory::new();
        let path = directory.0.join("draw.chemdraft");
        fs::write(&path, "<CDXML/>").unwrap();
        let payload = crate::open_document_payload_from_path(&path).unwrap();
        for last_opened in [true, false] {
            let mut opens = RendererOpens::default();
            let mut files = vec![payload.clone(); 2];
            let (sender, ack) = mpsc::channel();
            opens.track(&mut files, Reply::Secondary(sender));
            let queue = crate::PendingOpenDocument::default();
            queue.record(files, true).unwrap();
            let drained = queue.drain().unwrap();
            let [OpenReceipt::Handoff(first), OpenReceipt::Handoff(second)] =
                [drained[0].receipt.unwrap(), drained[1].receipt.unwrap()]
            else {
                panic!("expected handoff receipts");
            };
            assert!(opens.consume(first, true).is_none());
            assert!(
                opens.consume(first, true).is_none(),
                "duplicate confirmation"
            );
            assert_eq!(ack.try_recv(), Err(mpsc::TryRecvError::Empty));
            let (reply, result) = opens.consume(second, last_opened).unwrap();
            let expected = if last_opened {
                Acknowledgement::Accepted
            } else {
                Acknowledgement::Failed
            };
            reply.finish(result, |_| panic!("a forwarded launch has a sender"));
            assert_eq!(ack.try_recv(), Ok(expected));
            assert!(opens.consume(second, true).is_none(), "late confirmation");
        }
    }

    #[test]
    fn single_instance_takeover_failure_keeps_unopened_paths_until_persisted() {
        for timeout in [false, true] {
            let mut opens = RendererOpens::default();
            let mut payloads = ["opened.cdx", "failed.cdx", "unfinished.cdx"].map(|path| {
                crate::NativeOpenDocumentPayload {
                    path: path.into(),
                    display_name: path.into(),
                    contents: String::new(),
                    bytes: None,
                    receipt: None,
                    error: None,
                }
            });
            let batch = opens.track(&mut payloads, Reply::Takeover(LaunchRequest::default()));
            let receipt = |file| RendererReceipt { batch, file };
            assert!(opens.consume(receipt(0), true).is_none());
            let reply = if timeout {
                opens.fail(batch)
            } else {
                opens.consume(receipt(1), false).map(|(reply, result)| {
                    assert_eq!(result, Acknowledgement::Failed);
                    reply
                })
            };
            assert!(matches!(reply, Some(Reply::Takeover(_))));
            assert!(opens.fail(batch).is_none()); // Only one failure reaches shutdown.
            assert_eq!(
                opens.persist_with(vec![], |paths| {
                    assert_eq!(paths, ["failed.cdx", "unfinished.cdx"]);
                    Err("disk full".into())
                }),
                Err("disk full".into())
            );
            assert!(opens.consume(receipt(2), true).is_none());
            opens
                .persist_with(vec![], |paths| {
                    assert_eq!(paths, ["failed.cdx"]);
                    Ok(())
                })
                .unwrap();
            assert!(opens.batches.is_empty());
        }
    }

    #[test]
    fn single_instance_exit_accounts_for_collected_in_flight_and_late_files() {
        let early = Url::parse("file:///early.cdx").unwrap();
        let late = Url::parse("file:///late.cdxml").unwrap();
        let launch = LaunchRequest {
            urls: vec![early.clone()],
            ..Default::default()
        };
        for source in ["collection", "handoff", "forwarded", "promotion"] {
            let secondary = SecondaryLaunch::new(Ok(PathBuf::new()));
            let mut state = secondary.state.lock().unwrap();
            let (sender, result) = mpsc::channel();
            state.collection.launch = LaunchRequest::default();
            match source {
                "collection" => state.collection.launch = launch.clone(),
                "promotion" => state.promoting = Some(launch.clone()),
                _ => {
                    state.handoff = Some(Handoff {
                        launch: launch.clone(),
                        result,
                        resolved: None,
                    });
                    if source == "forwarded" {
                        sender.send(Ok(Resolution::Forwarded)).unwrap();
                    }
                }
            }
            state
                .collection
                .append(std::slice::from_ref(&late), Instant::now());
            drop(state);
            let expected = if source == "forwarded" {
                vec!["/late.cdxml"]
            } else {
                vec!["/early.cdx", "/late.cdxml"]
            };
            secondary
                .record_interrupted_launch_with(|paths| {
                    assert_eq!(paths, expected);
                    Ok(())
                })
                .unwrap()
                .unwrap();
            let state = secondary.state.lock().unwrap();
            assert!(state.terminating);
            assert!(state.collection.deadline().is_none());
            assert!(state.collection.launch.urls.is_empty());
            assert!(state.handoff.is_none());
            assert!(state.promoting.is_none());
        }
    }

    #[test]
    fn failed_interrupted_launch_record_preserves_collection_and_handoff_or_promotion() {
        let directory = Directory::new();
        let first = Url::parse("file:///first.cdx").unwrap();
        let late = Url::parse("file:///late.cdx").unwrap();
        let now = Instant::now();
        for stage in ["collection", "handoff", "promotion"] {
            let secondary = SecondaryLaunch::new(Ok(directory.0.clone()));
            let request = LaunchRequest {
                urls: vec![first.clone()],
                ..Default::default()
            };
            let mut state = secondary.state.lock().unwrap();
            let (sender, result) = mpsc::channel();
            state.collection = OpenCollection {
                started: Some(now),
                ..Default::default()
            };
            match stage {
                "collection" => state.collection.launch = request,
                "handoff" => {
                    state.handoff = Some(Handoff {
                        launch: request,
                        result,
                        resolved: None,
                    });
                    let guard = InstanceLock::acquire(&directory.0).unwrap().unwrap();
                    sender.send(Ok(Resolution::Primary(guard))).unwrap();
                }
                _ => state.promoting = Some(request),
            }
            let last_open = now + Duration::from_millis(100);
            state
                .collection
                .append(std::slice::from_ref(&late), last_open);
            let deadline = state.collection.deadline();
            drop(state);
            assert_eq!(
                secondary.record_interrupted_launch_with(|paths| {
                    assert_eq!(paths, ["/first.cdx", "/late.cdx"]);
                    Err("disk full".into())
                }),
                Some(Err("disk full".into()))
            );
            let state = secondary.state.lock().unwrap();
            assert!(!state.terminating);
            assert_eq!(state.collection.started, Some(now));
            assert_eq!(state.collection.last_open, Some(last_open));
            assert_eq!(state.collection.deadline(), deadline);
            match stage {
                "collection" => {
                    assert_eq!(state.collection.launch.urls, [first.clone(), late.clone()])
                }
                "handoff" => {
                    let handoff = state.handoff.as_ref().unwrap();
                    assert_eq!(handoff.launch.urls, std::slice::from_ref(&first));
                    assert!(matches!(handoff.resolved, Some(Ok(Resolution::Primary(_)))));
                    assert!(InstanceLock::acquire(&directory.0).unwrap().is_none());
                }
                _ => assert_eq!(
                    state.promoting.as_ref().unwrap().urls,
                    std::slice::from_ref(&first)
                ),
            }
        }
    }

    #[test]
    fn single_instance_exit_records_unconfirmed_files_without_a_modal() {
        let secondary = SecondaryLaunch::new(Ok(PathBuf::new()));
        secondary.state.lock().unwrap().collection.launch = LaunchRequest {
            urls: vec![Url::parse("file:///unconfirmed.cdx").unwrap()],
            ..Default::default()
        };
        let mut recorded = Vec::new();
        assert!(secondary
            .record_interrupted_launch_with(|paths| {
                recorded.extend_from_slice(paths);
                Ok(())
            })
            .unwrap()
            .is_ok());
        assert_eq!(recorded, ["/unconfirmed.cdx"]);
        assert!(secondary.state.lock().unwrap().terminating);
    }

    #[test]
    fn single_instance_collects_two_open_batches_until_quiet() {
        let directory = Directory::new();
        let ready = Instant::now();
        let first_batch = ready + Duration::from_millis(200);
        let second_batch = ready + Duration::from_millis(450);
        let first = Url::from_file_path(directory.0.join("first.chemdraft")).unwrap();
        let second = Url::from_file_path(directory.0.join("second.cdxml")).unwrap();
        let third = Url::from_file_path(directory.0.join("third.cdx")).unwrap();
        let mut collection = OpenCollection {
            started: Some(ready),
            ..Default::default()
        };
        collection.append(std::slice::from_ref(&first), first_batch);
        assert_eq!(collection.deadline(), Some(first_batch + OPEN_QUIET_PERIOD));
        assert!(second_batch < collection.deadline().unwrap());
        collection.append(&[second.clone(), third.clone()], second_batch);
        assert_eq!(
            collection.deadline(),
            Some(second_batch + OPEN_QUIET_PERIOD)
        );
        let launch = round_trip(&directory.0, collection.launch);
        assert_eq!(launch.urls, [first, second, third]);
    }

    #[test]
    fn single_instance_caps_continuous_open_collection() {
        let ready = Instant::now();
        let mut collection = OpenCollection {
            started: Some(ready),
            ..Default::default()
        };
        let url = Url::parse("file:///drawing.chemdraft").unwrap();
        for tick in 1..20 {
            let now = ready + Duration::from_millis(250 * tick);
            assert!(now < collection.deadline().unwrap());
            collection.append(std::slice::from_ref(&url), now);
        }
        assert_eq!(collection.deadline(), Some(ready + OPEN_COLLECTION_CAP));
        assert_eq!(collection.launch.urls.len(), 19);
    }

    #[test]
    fn single_instance_reports_files_when_neither_forwarding_nor_takeover_works() {
        let directory = Directory::new();
        let mut primary = InstanceLock::acquire(&directory.0).unwrap().unwrap();
        primary
            .write_endpoint(&Endpoint {
                port: 1,
                token: [8; 32],
            })
            .unwrap();
        let launch = LaunchRequest {
            argv: vec!["ChemDraft".into(), "other drawing.cdxml".into()],
            cwd: directory.0.display().to_string(),
            urls: vec![
                Url::from_file_path(directory.0.join("requested drawing.chemdraft")).unwrap(),
            ],
        };
        let result = resolve_launch_with::<UnixStream>(
            &directory.0,
            &launch,
            Duration::from_millis(100),
            |_, _| {
                Err(io::Error::new(
                    io::ErrorKind::ConnectionRefused,
                    "connection refused",
                ))
            },
        );
        let Err(error) = result else {
            panic!("must report the failure if the unreachable owner keeps the lock");
        };
        assert_eq!(error.kind(), io::ErrorKind::ConnectionRefused);
        let message = launch_error_message(&launch, &error.to_string());
        for expected in [
            "connection refused",
            "requested drawing.chemdraft",
            "other drawing.cdxml",
        ] {
            assert!(message.contains(expected), "{message}");
        }
        assert!(InstanceLock::acquire(&directory.0).unwrap().is_none());
    }

    #[test]
    fn single_instance_treats_a_missing_document_argument_as_a_failed_open() {
        let directory = Directory::new();
        let request = LaunchRequest {
            argv: vec!["ChemDraft".into(), "missing.chemdraft".into()],
            cwd: directory.0.display().to_string(),
            ..Default::default()
        };
        let mut files = crate::forwarded_document_payloads(&request);
        assert!(matches!(
            files.next(),
            Some(Err(error)) if error.contains("missing.chemdraft")
        ));
        assert!(files.next().is_none());
    }

    #[test]
    fn single_instance_forwards_open_events_and_reports_missing_files() {
        let directory = Directory::new();
        let names = ["first file.chemdraft", "missing file.chemdraft", "β.cdx"];
        fs::write(directory.0.join(names[0]), "<CDXML/>").unwrap();
        fs::write(directory.0.join(names[2]), "VjCD0100").unwrap();
        let urls: Vec<_> = names
            .iter()
            .map(|name| Url::from_file_path(directory.0.join(name)).unwrap())
            .collect();
        // LaunchServices normally supplies only the executable in argv.
        let launch = round_trip(
            &directory.0,
            LaunchRequest {
                argv: vec!["ChemDraft".into()],
                urls: urls.clone(),
                ..Default::default()
            },
        );
        assert_eq!(launch.urls, urls);
        let mut opened = Vec::new();
        let error = crate::deliver_opened_documents(
            crate::forwarded_document_payloads(&launch),
            |payloads| {
                assert_eq!(payloads.len(), 2);
                opened = payloads;
                Ok(())
            },
        )
        .unwrap_err();
        assert_eq!(
            error,
            crate::open_document_payload_from_path(&directory.0.join(names[1]))
                .err()
                .expect("missing file must fail")
        );
        assert_eq!(opened[0].path, directory.0.join(names[0]).to_str().unwrap());
        assert_eq!(opened[0].contents, "<CDXML/>");
        assert_eq!(opened[1].path, directory.0.join(names[2]).to_str().unwrap());
        assert_eq!(opened[1].bytes.as_deref(), Some(b"VjCD0100".as_slice()));
    }

    #[test]
    fn single_instance_keeps_distinct_argv_files_and_accepts_activation_only() {
        let directory = Directory::new();
        let first = "first file.chemdraft";
        let second = "β.cdxml";
        for name in [first, second] {
            fs::write(directory.0.join(name), "<CDXML/>").unwrap();
        }
        let argv = vec!["ChemDraft".into(), first.into(), second.into()];
        let cwd = directory.0.to_str().unwrap().to_string();
        let launch = round_trip(
            &directory.0,
            LaunchRequest {
                argv: argv.clone(),
                cwd: cwd.clone(),
                urls: vec![Url::from_file_path(directory.0.join(first)).unwrap()],
            },
        );
        assert_eq!(launch.argv, argv);
        assert_eq!(launch.cwd, cwd);
        let opened: Vec<_> = crate::forwarded_document_payloads(&launch)
            .map(|payload| payload.unwrap().display_name)
            .collect();
        assert_eq!(opened, [first, second]);

        let activation = round_trip(
            &directory.0,
            LaunchRequest {
                argv: vec!["ChemDraft".into()],
                ..Default::default()
            },
        );
        assert!(crate::forwarded_document_payloads(&activation)
            .next()
            .is_none());
    }

    fn round_trip(directory: &Path, launch: LaunchRequest) -> LaunchRequest {
        let mut guard = InstanceLock::acquire(directory).unwrap().unwrap();
        let endpoint = Endpoint {
            port: 1,
            token: [4; 32],
        };
        guard.write_endpoint(&endpoint).unwrap();
        let (client, mut stream) = streams();
        let server = thread::spawn(move || {
            let mut delivered = None;
            receive_launch(&mut stream, &endpoint.token, |launch| {
                delivered = Some(launch);
                Ok(Acknowledgement::Accepted)
            })
            .unwrap();
            delivered.unwrap()
        });
        let mut client = Some(client);
        assert!(matches!(
            resolve_launch_with(directory, &launch, TAKEOVER_TIMEOUT, |_, _| Ok(client
                .take()
                .unwrap()))
            .unwrap(),
            Resolution::Forwarded
        ));
        assert!(InstanceLock::acquire(directory).unwrap().is_none());
        server.join().unwrap()
    }

    #[test]
    fn single_instance_rejects_unauthenticated_and_oversized_messages() {
        for oversized in [false, true] {
            let (mut stream, mut server_stream) = streams();
            let server = thread::spawn(move || {
                receive_launch(&mut server_stream, &[1; 32], |_| {
                    panic!("must not deliver invalid input")
                })
                .unwrap_err()
            });
            if oversized {
                stream
                    .write_all(&((MAX_MESSAGE_BYTES + 1) as u32).to_le_bytes())
                    .unwrap();
            } else {
                let request = serde_json::to_vec(&Launch {
                    token: [2; 32],
                    request: LaunchRequest::default(),
                })
                .unwrap();
                stream
                    .write_all(&(request.len() as u32).to_le_bytes())
                    .unwrap();
                stream.write_all(&request).unwrap();
            }
            let error = server.join().unwrap();
            if !oversized {
                assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
            }
        }
    }

    #[test]
    fn single_instance_lock_errors_fail_closed() {
        let directory = Directory::new();
        fs::create_dir(directory.0.join(LOCK_FILE)).unwrap();
        assert!(InstanceLock::acquire(&directory.0).is_err());
    }
}
