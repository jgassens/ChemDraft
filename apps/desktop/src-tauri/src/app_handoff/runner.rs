use super::{
    arming::ApprovedBuild,
    command_line::Pipeline,
    temp_files::{self, TempFiles},
    wire::{Diagnostic, RunCode, StepResult, INPUT_BYTES, STDERR_BYTES, STDERR_TAIL_BYTES},
};
#[cfg(unix)]
use crate::local_engine::platform;
use serde_json::Value;
use std::{
    ffi::OsString,
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

#[derive(Debug)]
pub(super) struct Failure {
    pub code: RunCode,
    pub message: String,
    pub diagnostic: Option<Box<Diagnostic>>,
}

impl Failure {
    pub(super) fn new(code: RunCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            diagnostic: None,
        }
    }

    fn step(mut self, id: &str, exit: Option<i32>, json: Option<Value>, stderr: &[u8]) -> Self {
        let start = stderr.len().saturating_sub(STDERR_TAIL_BYTES);
        let tail = String::from_utf8_lossy(&stderr[start..]);
        let tail = tail.trim();
        let stderr_tail = if tail.is_empty() {
            None
        } else if path_like(tail) {
            Some("[Companion diagnostic contains a local path.]".into())
        } else {
            let mut end = tail.len().min(STDERR_TAIL_BYTES);
            while !tail.is_char_boundary(end) {
                end -= 1;
            }
            Some(tail[..end].into())
        };
        self.diagnostic = Some(Box::new(Diagnostic {
            step: id.into(),
            exit_code: exit,
            json,
            stderr_tail,
        }));
        self
    }
}

pub(super) struct Completed {
    pub steps: Vec<StepResult>,
    pub output: Option<PathBuf>,
}

pub(super) fn run(
    pipeline: &Pipeline,
    build: &ApprovedBuild,
    files: &TempFiles,
    mut start_step: impl FnMut(&[OsString], &Path, bool, Instant) -> Result<ChildProcess, Failure>,
    stopped: &AtomicBool,
) -> Result<Completed, Failure> {
    let mut previous = None;
    let mut final_output = None;
    let mut results = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(600);
    for (index, step) in pipeline.steps.iter().enumerate() {
        let rendered = pipeline
            .render(
                step,
                &build.combination,
                &files.root,
                &files.stem,
                previous.as_deref(),
            )
            .map_err(|error| Failure::new(RunCode::BadParam, error))?;
        if rendered.reads_previous
            && previous
                .as_deref()
                .is_none_or(|path| !verified_output(&files.root, path))
        {
            return Err(Failure::new(RunCode::BadOutput, "The preceding companion step did not create a regular output file in the handoff folder."));
        }
        if rendered.output.as_ref().is_some_and(|path| {
            !path
                .symlink_metadata()
                .is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
        }) {
            return Err(Failure::new(
                RunCode::BadOutput,
                "The declared companion output file already exists.",
            ));
        }
        check_launch_time(deadline, stopped)?;
        let mut child = start_step(&rendered.args, &files.root, index == 0, deadline)?;
        let remaining = Duration::from_secs(step.timeout_seconds)
            .min(deadline.saturating_duration_since(Instant::now()));
        let captured = child.capture(remaining, stopped).map_err(|error| {
            let (code, message) = match error {
                CaptureError::Timeout => {
                    (RunCode::Timeout, "exceeded its time limit or was stopped")
                }
                CaptureError::Limit => (
                    RunCode::BadOutput,
                    "exceeded the 1 MiB stdout or 256 KiB stderr limit",
                ),
                CaptureError::Io => (
                    RunCode::BadOutput,
                    "could not be supervised or its output could not be read",
                ),
            };
            Failure::new(code, format!("Companion step \"{}\" {message}.", step.id)).step(
                &step.id,
                None,
                None,
                &[],
            )
        })?;
        let json = parse_output(&captured.stdout);
        if !captured.status.success() {
            return Err(Failure::new(
                RunCode::ExitNonzero,
                format!("Companion step \"{}\" exited unsuccessfully.", step.id),
            )
            .step(&step.id, captured.status.code(), json, &captured.stderr));
        }
        let json = json.ok_or_else(|| {
            Failure::new(
                RunCode::BadOutput,
                format!(
                    "Companion step \"{}\" did not return one bounded JSON value.",
                    step.id
                ),
            )
            .step(&step.id, captured.status.code(), None, &captured.stderr)
        })?;
        if index == 0
            && !json
                .get("version")
                .and_then(Value::as_str)
                .is_some_and(|version| {
                    pipeline
                        .tested_versions
                        .iter()
                        .any(|tested| tested == version)
                })
        {
            return Err(Failure::new(
                RunCode::VersionUntested,
                format!(
                    "The installed companion did not report a tested version. Tested versions: {}.",
                    pipeline.tested_versions.join(", ")
                ),
            )
            .step(
                &step.id,
                captured.status.code(),
                Some(json),
                &captured.stderr,
            ));
        }
        previous = rendered.output;
        if let Some(path) = &previous {
            if !verified_output(&files.root, path) {
                return Err(Failure::new(
                    RunCode::BadOutput,
                    format!(
                        "Companion step \"{}\" did not create its declared regular output file.",
                        step.id
                    ),
                ));
            }
            final_output = Some(path.clone());
        }
        results.push(StepResult {
            id: step.id.clone(),
            json,
        });
    }
    Ok(Completed {
        steps: results,
        output: final_output,
    })
}

fn check_launch_time(deadline: Instant, stopped: &AtomicBool) -> Result<(), Failure> {
    if Instant::now() >= deadline || stopped.load(Ordering::Acquire) {
        return Err(Failure::new(
            RunCode::Timeout,
            "The companion pipeline ended before its next step.",
        ));
    }
    Ok(())
}

pub(super) fn verified_output(directory: &Path, path: &Path) -> bool {
    directory
        .canonicalize()
        .is_ok_and(|canonical| canonical == directory)
        && path
            .strip_prefix(directory)
            .ok()
            .is_some_and(|relative| temp_files::plain_path(directory, relative, false).is_ok())
}

fn isolated_command(program: &Path, args: &[OsString], cwd: &Path) -> Command {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::{
            CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, CREATE_SUSPENDED,
        };
        let keys = ["SystemRoot", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA"];
        // The system drive need not be C:. Build a fixed system-only PATH from SystemRoot.
        if let Some(root) = std::env::var_os("SystemRoot") {
            let root = PathBuf::from(root);
            if let Ok(path) = std::env::join_paths([root.join("System32"), root]) {
                command.env("PATH", path);
            }
        }
        command.envs(
            keys.iter()
                .filter_map(|key| std::env::var_os(key).map(|value| (*key, value))),
        );
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW | CREATE_SUSPENDED);
    }
    #[cfg(not(windows))]
    {
        let keys = ["HOME", "TMPDIR", "LANG"];
        command.env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
        command.envs(
            keys.iter()
                .filter_map(|key| std::env::var_os(key).map(|value| (*key, value))),
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command
}

pub(super) struct ChildProcess {
    child: Child,
    #[cfg(windows)]
    job: super::windows_process::WindowsJob,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum CaptureError {
    Timeout,
    Limit,
    Io,
}

#[derive(Debug)]
pub(super) struct Captured {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

struct CaptureLimits<'a> {
    deadline: Instant,
    stopped: &'a AtomicBool,
    exceeded: AtomicBool,
}

impl CaptureLimits<'_> {
    fn check(&self) -> Result<(), CaptureError> {
        if self.exceeded.load(Ordering::Acquire) {
            Err(CaptureError::Limit)
        } else if self.stopped.load(Ordering::Acquire) || Instant::now() >= self.deadline {
            Err(CaptureError::Timeout)
        } else {
            Ok(())
        }
    }

    fn pause(&self) {
        thread::sleep(
            self.deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_millis(10)),
        );
    }
}

impl ChildProcess {
    pub(super) fn spawn_before(
        program: &Path,
        args: &[OsString],
        cwd: &Path,
        deadline: Instant,
        stopped: &AtomicBool,
    ) -> Result<Self, Failure> {
        let command = isolated_command(program, args, cwd);
        check_launch_time(deadline, stopped)?;
        Self::spawn_command(command).map_err(|_| {
            Failure::new(
                RunCode::ToolMissing,
                "ChemDraft could not start the declared companion executable.",
            )
        })
    }

    #[cfg(test)]
    pub(super) fn spawn(program: &Path, args: &[OsString], cwd: &Path) -> io::Result<Self> {
        Self::spawn_command(isolated_command(program, args, cwd))
    }

    fn spawn_command(mut command: Command) -> io::Result<Self> {
        #[allow(unused_mut)]
        let mut child = command.spawn()?;
        #[cfg(windows)]
        let job = match super::windows_process::WindowsJob::attach(&child).and_then(|job| {
            super::windows_process::resume_windows_child(&child)?;
            Ok(job)
        }) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        Ok(Self {
            child,
            #[cfg(windows)]
            job,
        })
    }

    pub(super) fn capture(
        &mut self,
        timeout: Duration,
        stopped: &AtomicBool,
    ) -> Result<Captured, CaptureError> {
        let stdout = self.child.stdout.take().expect("piped companion stdout");
        let stderr = self.child.stderr.take().expect("piped companion stderr");
        let limits = CaptureLimits {
            deadline: Instant::now() + timeout,
            stopped,
            exceeded: AtomicBool::new(false),
        };
        #[cfg(unix)]
        if nonblocking_pipe(&stdout)
            .and_then(|()| nonblocking_pipe(&stderr))
            .is_err()
        {
            self.terminate();
            return Err(CaptureError::Io);
        }
        thread::scope(|scope| {
            let stdout = scope.spawn(|| drain(stdout, INPUT_BYTES, &limits));
            let stderr = scope.spawn(|| drain(stderr, STDERR_BYTES, &limits));
            let status = self.wait(&limits);
            let stdout = stdout.join();
            let stderr = stderr.join();
            let status = status?;
            let stdout = stdout.map_err(|_| CaptureError::Io)??;
            let stderr = stderr.map_err(|_| CaptureError::Io)??;
            if limits.exceeded.load(Ordering::Acquire) {
                return Err(CaptureError::Limit);
            }
            Ok(Captured {
                status,
                stdout,
                stderr,
            })
        })
    }

    fn wait(&mut self, limits: &CaptureLimits<'_>) -> Result<ExitStatus, CaptureError> {
        loop {
            if let Err(error) = limits.check() {
                self.terminate();
                return Err(error);
            }
            #[cfg(unix)]
            match platform::sweep_exited_process_group(self.child.id(), false) {
                Ok(false) => {
                    limits.pause();
                    continue;
                }
                Ok(true) => {}
                Err(_) => {
                    self.terminate();
                    return Err(CaptureError::Io);
                }
            }
            match self.child.try_wait() {
                Ok(Some(status)) => {
                    #[cfg(windows)]
                    self.job.terminate();
                    return Ok(status);
                }
                Ok(None) => limits.pause(),
                Err(_) => {
                    self.terminate();
                    return Err(CaptureError::Io);
                }
            }
        }
    }

    fn terminate(&mut self) {
        #[cfg(unix)]
        platform::kill_process_tree(self.child.id());
        #[cfg(windows)]
        self.job.terminate();
        let _ = self.child.kill();
        #[cfg(unix)]
        let _ = platform::sweep_exited_process_group(self.child.id(), true);
        let _ = self.child.wait();
    }
}

#[cfg(unix)]
fn nonblocking_pipe(pipe: &impl std::os::fd::AsRawFd) -> io::Result<()> {
    let fd = pipe.as_raw_fd();
    // Change only the parent's read end. A descendant can outlive the process group and
    // keep the write end open, so the reader needs to be able to stop without waiting for EOF.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags == -1 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn drain(
    mut reader: impl Read,
    cap: usize,
    limits: &CaptureLimits<'_>,
) -> Result<Vec<u8>, CaptureError> {
    let mut output = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        #[cfg(unix)]
        limits.check()?;
        let read = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => n,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            #[cfg(unix)]
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                limits.pause();
                continue;
            }
            Err(_) => return Err(CaptureError::Io),
        };
        let available = cap - output.len();
        output.extend_from_slice(&buffer[..read.min(available)]);
        if read > available {
            limits.exceeded.store(true, Ordering::Release);
        }
    }
    Ok(output)
}

fn parse_output(bytes: &[u8]) -> Option<Value> {
    let mut value = serde_json::from_slice(bytes).ok()?;
    let mut nodes = 0;
    (redact(&mut value, 0, &mut nodes) && serde_json::to_vec(&value).ok()?.len() <= INPUT_BYTES)
        .then_some(value)
}

fn redact(value: &mut Value, depth: usize, nodes: &mut usize) -> bool {
    *nodes += 1;
    if depth > 32 || *nodes > 250_000 {
        return false;
    }
    match value {
        Value::String(text) if path_like(text) => {
            *text = "[local path removed]".into();
            true
        }
        Value::Object(entries) => {
            entries.len() <= 1024
                && entries.iter_mut().all(|(key, value)| {
                    !matches!(key.as_str(), "__proto__" | "constructor" | "prototype")
                        && !path_like(key)
                        && redact(value, depth + 1, nodes)
                })
        }
        Value::Array(entries) => entries
            .iter_mut()
            .all(|value| redact(value, depth + 1, nodes)),
        _ => true,
    }
}

fn path_like(text: &str) -> bool {
    // Do not return toolkit filenames or paths from tool-produced output or traceback text.
    // Keep crystallography strings such as P2(1)/c and ordinary numeric fractions.
    text.contains('\\')
        || text.contains("file:")
        || text
            .split(|ch: char| ch.is_whitespace() || matches!(ch, '"' | '\'' | '=' | '(' | '['))
            .any(|word| word.starts_with('/') || word.as_bytes().get(1..3) == Some(b":/"))
}
