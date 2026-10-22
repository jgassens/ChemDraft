//! Owned child lifetime, bounded output and cursor-based polling. Only the supervisor reaps PIDs.
use super::{catalog::RenderedRun, env::ParentEnv};
use crate::{local_engine::platform, WithoutConsoleWindow};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Condvar, Mutex},
    thread,
    time::{Duration, Instant},
};

pub const MAX_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_LINES: usize = 20_000;
pub const MAX_LINE_BYTES: usize = 256 * 1024;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KillReason {
    Cancelled,
    Timeout,
    AppExit,
    PluginUnregistered,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RunStatus {
    Running,
    Exited {
        code: Option<i32>,
        signal: Option<i32>,
        duration_ms: u64,
    },
    Killed {
        reason: KillReason,
    },
    Failed {
        message: String,
    },
}
impl RunStatus {
    pub fn is_running(&self) -> bool {
        matches!(self, Self::Running)
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputStream {
    Stdout,
    Stderr,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputLine {
    pub stream: OutputStream,
    pub seq: u64,
    pub text: String,
    pub truncated: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalToolRunPoll {
    pub lines: Vec<OutputLine>,
    pub next_cursor: u64,
    pub dropped_lines: u64,
    pub status: RunStatus,
}

struct Buffer {
    lines: VecDeque<OutputLine>,
    bytes: usize,
    next: u64,
    dropped: u64,
    status: RunStatus,
    cancel: Option<KillReason>,
    polled_finished_at: Option<Instant>,
    captured_bytes: usize,
    output_limit_exceeded: bool,
}
struct Shared {
    buffer: Mutex<Buffer>,
    changed: Condvar,
    output_limit: Option<usize>,
}
impl Shared {
    fn push(&self, stream: OutputStream, bytes: &[u8], truncated: bool) {
        let mut text = String::from_utf8_lossy(bytes).into_owned();
        // Lossy decoding may expand invalid bytes. Keep the byte bound on the stored string too.
        let mut limit = text.len().min(MAX_LINE_BYTES);
        while !text.is_char_boundary(limit) {
            limit -= 1;
        }
        let truncated = truncated || limit < text.len();
        text.truncate(limit);
        let mut b = self.buffer.lock().unwrap();
        let seq = b.next;
        b.next += 1;
        b.bytes += text.len();
        b.lines.push_back(OutputLine {
            stream,
            seq,
            text,
            truncated,
        });
        while b.lines.len() > MAX_LINES || b.bytes > MAX_BYTES {
            if let Some(line) = b.lines.pop_front() {
                b.bytes -= line.text.len();
                b.dropped += 1;
            }
        }
        self.changed.notify_all();
    }
}

pub struct ToolRun {
    pub pid: u32,
    pub cwd: PathBuf,
    pub started_at: String,
    shared: Arc<Shared>,
}
impl ToolRun {
    pub fn spawn(
        rendered: RenderedRun,
        cwd: &Path,
        environment: &ParentEnv,
        timeout: Duration,
    ) -> Result<Arc<Self>, String> {
        Self::spawn_with_output_limit(rendered, cwd, environment, timeout, None)
    }
    pub(super) fn spawn_with_output_limit(
        rendered: RenderedRun,
        cwd: &Path,
        environment: &ParentEnv,
        timeout: Duration,
        output_limit: Option<usize>,
    ) -> Result<Arc<Self>, String> {
        if rendered
            .program
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.eq_ignore_ascii_case("cmd") || s.eq_ignore_ascii_case("bat"))
        {
            return Err("Batch shims cannot be run; resolve a native executable first.".into());
        }
        let mut command = Command::new(&rendered.program);
        command
            .args(&rendered.args)
            .current_dir(cwd)
            .env_clear()
            .envs(environment)
            .envs(rendered.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .without_console_window();
        // Apply AFTER WithoutConsoleWindow: Windows creation_flags replaces, rather than ORs.
        platform::current()?.configure_child(&mut command);
        // Contain the process before it can execute vendor code or create descendants.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            use windows_sys::Win32::System::Threading::{
                CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, CREATE_SUSPENDED,
            };
            command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW | CREATE_SUSPENDED);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("Could not start external tool: {e}"))?;
        #[cfg(windows)]
        let job = match WindowsJob::attach(&child) {
            Ok(job) => job,
            Err(error) => {
                platform::kill_process_tree(child.id());
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "Could not contain external tool in a Job Object: {error}"
                ));
            }
        };
        #[cfg(windows)]
        if let Err(error) = resume_windows_child(&child) {
            job.terminate();
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Could not resume contained external tool: {error}"));
        }
        let shared = Arc::new(Shared {
            buffer: Mutex::new(Buffer {
                lines: VecDeque::new(),
                bytes: 0,
                next: 0,
                dropped: 0,
                status: RunStatus::Running,
                cancel: None,
                polled_finished_at: None,
                captured_bytes: 0,
                output_limit_exceeded: false,
            }),
            changed: Condvar::new(),
            output_limit,
        });
        let started = Instant::now();
        let run = Arc::new(Self {
            pid: child.id(),
            cwd: cwd.to_owned(),
            started_at: chrono::Utc::now().to_rfc3339(),
            shared: shared.clone(),
        });
        let stdout = reader(
            child.stdout.take().expect("piped stdout"),
            OutputStream::Stdout,
            shared.clone(),
        );
        let stderr = reader(
            child.stderr.take().expect("piped stderr"),
            OutputStream::Stderr,
            shared.clone(),
        );
        let mut stdin = child.stdin.take().expect("piped stdin");
        // A separate writer lets the watchdog stop a child that never consumes stdin.
        let writer = thread::spawn(move || {
            if let Some(text) = rendered.stdin {
                let _ = stdin.write_all(text.as_bytes());
            }
            drop(stdin);
        });
        thread::spawn(move || {
            let pid = child.id();
            let mut interrupt_at = None;
            let status = loop {
                let reason = {
                    let mut b = shared.buffer.lock().unwrap();
                    if b.cancel.is_none() && started.elapsed() >= timeout {
                        b.cancel = Some(KillReason::Timeout);
                    }
                    b.cancel
                };
                if reason.is_some() && interrupt_at.is_none() {
                    #[cfg(unix)]
                    // SAFETY: the child has not been reaped and owns this process group.
                    unsafe {
                        libc::killpg(pid as libc::pid_t, libc::SIGINT);
                    }
                    interrupt_at = Some(Instant::now());
                }
                if interrupt_at.is_some_and(|at| at.elapsed() >= Duration::from_secs(2)) {
                    platform::kill_process_tree(pid);
                    #[cfg(windows)]
                    job.terminate();
                    let _ = child.kill();
                }
                // Never reap a Unix leader before sweeping its process group: PID reuse would
                // make a later kill unsafe, and descendants can retain the stdout pipe forever.
                let ready = match platform::sweep_exited_process_group(pid, false) {
                    Ok(ready) => ready,
                    Err(error) if error.kind() == std::io::ErrorKind::Unsupported => true,
                    Err(error) => {
                        platform::kill_process_tree(pid);
                        let _ = child.kill();
                        let _ = child.wait();
                        break RunStatus::Failed {
                            message: format!("Could not supervise external tool: {error}"),
                        };
                    }
                };
                if ready {
                    match child.try_wait() {
                        Ok(Some(exit)) => {
                            #[cfg(windows)]
                            job.terminate();
                            if let Some(reason) = reason {
                                break RunStatus::Killed { reason };
                            }
                            #[cfg(unix)]
                            let signal = {
                                use std::os::unix::process::ExitStatusExt;
                                exit.signal()
                            };
                            #[cfg(not(unix))]
                            let signal = None;
                            break RunStatus::Exited {
                                code: exit.code(),
                                signal,
                                duration_ms: started.elapsed().as_millis() as u64,
                            };
                        }
                        Ok(None) => (),
                        Err(error) => {
                            platform::kill_process_tree(pid);
                            let _ = child.kill();
                            let _ = platform::sweep_exited_process_group(pid, true);
                            let _ = child.wait();
                            break RunStatus::Failed {
                                message: format!("Could not wait for external tool: {error}"),
                            };
                        }
                    }
                }
                let lock = shared.buffer.lock().unwrap();
                let _ = shared
                    .changed
                    .wait_timeout(lock, Duration::from_millis(20))
                    .unwrap();
            };
            #[cfg(windows)]
            drop(job);
            let _ = writer.join();
            let _ = stdout.join();
            let _ = stderr.join();
            let mut b = shared.buffer.lock().unwrap();
            // A cancel arriving just as the child exits still owns the terminal result.
            b.status = b
                .cancel
                .map(|reason| RunStatus::Killed { reason })
                .unwrap_or(status);
            shared.changed.notify_all();
        });
        Ok(run)
    }
    pub fn poll(&self, cursor: u64, max_lines: usize, wait_ms: u64) -> ExternalToolRunPoll {
        let max_lines = max_lines.clamp(1, 5000);
        let mut b = self.shared.buffer.lock().unwrap();
        if cursor >= b.next && b.status.is_running() {
            b = self
                .shared
                .changed
                .wait_timeout_while(b, Duration::from_millis(wait_ms.min(1000)), |b| {
                    cursor >= b.next && b.status.is_running()
                })
                .unwrap()
                .0;
        }
        let lines: Vec<_> = b
            .lines
            .iter()
            .filter(|l| l.seq >= cursor)
            .take(max_lines)
            .cloned()
            .collect();
        let next_cursor = lines
            .last()
            .map(|l| l.seq + 1)
            .unwrap_or(cursor.min(b.next));
        if !b.status.is_running() {
            b.polled_finished_at.get_or_insert_with(Instant::now);
        }
        ExternalToolRunPoll {
            lines,
            next_cursor,
            dropped_lines: b.dropped,
            status: b.status.clone(),
        }
    }
    pub fn status(&self) -> RunStatus {
        self.shared.buffer.lock().unwrap().status.clone()
    }
    pub(super) fn output_limit_exceeded(&self) -> bool {
        self.shared.buffer.lock().unwrap().output_limit_exceeded
    }
    pub fn cancel(&self, reason: KillReason) {
        let mut b = self.shared.buffer.lock().unwrap();
        if b.status.is_running() && b.cancel.is_none() {
            b.cancel = Some(reason);
            self.shared.changed.notify_all();
        }
    }
    pub fn wait_finished(&self, timeout: Duration) -> bool {
        let b = self.shared.buffer.lock().unwrap();
        !self
            .shared
            .changed
            .wait_timeout_while(b, timeout, |b| b.status.is_running())
            .unwrap()
            .0
            .status
            .is_running()
    }
    pub fn removable(&self) -> bool {
        let b = self.shared.buffer.lock().unwrap();
        b.polled_finished_at
            .is_some_and(|at| at.elapsed() >= Duration::from_secs(60))
    }
}

fn reader(
    input: impl Read + Send + 'static,
    stream: OutputStream,
    shared: Arc<Shared>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = BufReader::new(input);
        let mut line = Vec::new();
        let mut truncated = false;
        loop {
            let available = match reader.fill_buf() {
                Ok(buf) => buf,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            };
            if available.is_empty() {
                if !line.is_empty() || truncated {
                    shared.push(stream, &line, truncated);
                }
                break;
            }
            let end = available.iter().position(|b| *b == b'\n');
            let n = end.map(|n| n + 1).unwrap_or(available.len());
            if let Some(cap) = shared.output_limit {
                let mut b = shared.buffer.lock().unwrap();
                b.captured_bytes = b.captured_bytes.saturating_add(n);
                if b.captured_bytes > cap {
                    b.output_limit_exceeded = true;
                    b.cancel.get_or_insert(KillReason::Cancelled);
                    shared.changed.notify_all();
                    break;
                }
            }
            let content = if end.is_some() {
                &available[..n - 1]
            } else {
                &available[..n]
            };
            let keep = content.len().min(MAX_LINE_BYTES - line.len());
            line.extend_from_slice(&content[..keep]);
            truncated |= keep < content.len();
            reader.consume(n);
            if end.is_some() {
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                shared.push(stream, &line, truncated);
                line.clear();
                truncated = false;
            }
        }
    })
}

#[cfg(windows)]
struct WindowsJob(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
fn resume_windows_child(child: &std::process::Child) -> std::io::Result<()> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::{
        Foundation::INVALID_HANDLE_VALUE,
        System::{
            Diagnostics::ToolHelp::*,
            Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
        },
    };
    // SAFETY: the snapshot is an owned kernel handle; no pointers are passed to this call.
    let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if raw == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: ownership transfers exactly once to the RAII guard.
    let snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
    // SAFETY: THREADENTRY32 is a plain C structure; dwSize is set before the API reads it.
    let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of_val(&entry) as u32;
    // SAFETY: valid snapshot and initialized writable structure.
    let mut found = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
    while found != 0 {
        if entry.th32OwnerProcessID == child.id() {
            // The only thread belongs to our child, suspended since process creation.
            // SAFETY: requesting a noninheritable handle for an existing thread.
            let raw = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if raw.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            // SAFETY: transfer the newly owned handle exactly once.
            let thread = unsafe { OwnedHandle::from_raw_handle(raw) };
            // SAFETY: this thread belongs to our still-owned child and was created suspended.
            if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
                return Err(std::io::Error::last_os_error());
            }
            return Ok(());
        }
        // SAFETY: same live snapshot and writable structure as Thread32First.
        found = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "Suspended child thread was not found.",
    ))
}
#[cfg(windows)]
// SAFETY: the job handle is owned, used only by the supervisor, and closed exactly once.
unsafe impl Send for WindowsJob {}
#[cfg(windows)]
impl WindowsJob {
    fn attach(child: &std::process::Child) -> std::io::Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::*;
        // SAFETY: null attributes/name request an unnamed, noninheritable job.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let job = Self(handle);
        // SAFETY: JOBOBJECT_EXTENDED_LIMIT_INFORMATION permits zero initialization.
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: correct structure size and valid job/process handles, owned for this call.
        if unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&info) as u32,
            )
        } == 0
            || unsafe { AssignProcessToJobObject(handle, child.as_raw_handle()) } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(job)
    }
    fn terminate(&self) {
        // SAFETY: self owns a valid job handle.
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
        }
    }
}
#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        // SAFETY: this is the single owned reference to the handle.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
