use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};

use super::pins;
pub use super::platform::RunningChild;
use super::platform::{EnginePlatform, InstallChild};
use super::progress::{self, GrowthEstimator};
use super::EngineSpec;
use super::{InstallError, InstallPhase, InstallProgress};

pub const RECEIPT_FILE: &str = "install.json";
pub const REQUIREMENTS_FILE: &str = "requirements.txt";

/// Retain enough of a failed uv invocation to make its otherwise terse exit status actionable,
/// without allowing a broken child to retain an unbounded amount of installer memory.
const STDERR_TAIL_BYTES: usize = 4 * 1024;
const STDERR_ERROR_LINES: usize = 3;
const PIPE_READER_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Debug, Clone)]
pub struct InstallPaths {
    pub app_data: PathBuf,
    pub requirements: PathBuf,
}

impl InstallPaths {
    pub fn final_dir_for<S: EngineSpec>(&self) -> PathBuf {
        self.app_data.join(S::DIR_NAME)
    }

    pub fn partial_dir_for<S: EngineSpec>(&self) -> PathBuf {
        self.app_data.join(format!("{}.partial", S::DIR_NAME))
    }

    pub fn previous_dir_for<S: EngineSpec>(&self) -> PathBuf {
        self.app_data.join(format!("{}.previous", S::DIR_NAME))
    }
}

pub trait ProgressReporter: Send + Sync {
    fn report(&self, progress: InstallProgress);
}

impl<F> ProgressReporter for F
where
    F: Fn(InstallProgress) + Send + Sync,
{
    fn report(&self, progress: InstallProgress) {
        self(progress);
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RunStep {
    InstallPython,
    CreateVenv,
    #[cfg(windows)]
    RewriteVenvLaunchers,
    InstallPackages,
    Extra,
    VerifyEnvironment,
}

/// Progress for a uv step that reports none of its own: the estimator is sampled every
/// [`progress::SAMPLE_INTERVAL`] while the child runs, and reports 100% when it exits successfully.
pub struct RunWatch<'a> {
    pub estimator: GrowthEstimator,
    pub progress: &'a dyn ProgressReporter,
}

pub struct Download<'a> {
    pub url: &'a str,
    pub sha256: &'a str,
    pub size: Option<u64>,
    pub phase: InstallPhase,
}

/// Inputs to an engine-specific, pinned install hook.
pub struct InstallContext<'a> {
    pub root: &'a Path,
    pub platform: &'a dyn EnginePlatform,
    pub io: &'a dyn InstallIo,
    pub cancel: &'a AtomicBool,
    pub progress: &'a dyn ProgressReporter,
    pub environment: &'a [(OsString, OsString)],
}

pub trait InstallIo: Send + Sync {
    fn download(
        &self,
        spec: Download<'_>,
        destination: &Path,
        cancel: &AtomicBool,
        progress: &dyn ProgressReporter,
    ) -> Result<(), InstallError>;

    fn extract_uv(
        &self,
        platform: &dyn EnginePlatform,
        archive: &Path,
        destination: &Path,
    ) -> Result<(), InstallError>;

    // One seam for every child process the installer starts; bundling these into a struct would
    // only move the same eight names into a type used at four call sites.
    #[allow(clippy::too_many_arguments)]
    fn run(
        &self,
        platform: &dyn EnginePlatform,
        step: RunStep,
        program: &Path,
        args: &[OsString],
        env: &[(OsString, OsString)],
        cancel: &AtomicBool,
        watch: Option<RunWatch<'_>>,
    ) -> Result<(), InstallError>;
}

pub struct SystemInstallIo<S: EngineSpec> {
    spec: std::marker::PhantomData<S>,
    client: Option<reqwest::blocking::Client>,
    pub(crate) running: Arc<RunningChild>,
}

impl<S: EngineSpec> SystemInstallIo<S> {
    /// Recovery runs local processes and must never require an HTTP client.
    pub fn offline(running: Arc<RunningChild>) -> Self {
        Self {
            spec: std::marker::PhantomData,
            client: None,
            running,
        }
    }

    pub fn new(running: Arc<RunningChild>) -> Result<Self, InstallError> {
        let mut io = Self::from_builder(reqwest::blocking::Client::builder())?;
        io.running = running;
        Ok(io)
    }

    pub(crate) fn from_builder(
        builder: reqwest::blocking::ClientBuilder,
    ) -> Result<Self, InstallError> {
        // The blocking client applies `timeout` to each wait (the request, then every body read),
        // not to the whole transfer, so this is a stall timeout: a 1.1 GB model on a slow link
        // still completes, while a dead connection fails — and a cancel is noticed — within a
        // minute.
        let client = builder
            .connect_timeout(Duration::from_secs(30))
            .timeout(Duration::from_secs(60))
            .user_agent(S::USER_AGENT)
            .build()
            .map_err(|error| {
                InstallError::network(format!("Could not prepare downloads: {error}"))
            })?;
        Ok(Self {
            spec: std::marker::PhantomData,
            client: Some(client),
            running: Arc::default(),
        })
    }
}

/// Inherited variables that could redirect the pinned uv/pip/Python away from the reviewed
/// sources or into another environment. Every variable with one of these prefixes is removed.
pub(crate) const SCRUBBED_ENV_PREFIXES: [&str; 5] =
    ["UV_", "PIP_", "PYTHON", "VIRTUAL_ENV", "CONDA"];

fn scrub_environment(command: &mut Command) {
    for (key, _) in std::env::vars_os() {
        let name = key.to_string_lossy();
        if SCRUBBED_ENV_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
        {
            command.env_remove(&key);
        }
    }
}

/// Drain stderr while the child is running. Keeping only the tail is important both for noisy
/// package builds and because the installer must continue to supervise (and cancel) the child.
fn drain_stderr(
    mut stderr: std::process::ChildStderr,
) -> std::thread::JoinHandle<io::Result<Vec<u8>>> {
    std::thread::spawn(move || {
        let mut tail = Vec::with_capacity(STDERR_TAIL_BYTES);
        let mut buffer = [0_u8; 8 * 1024];
        loop {
            let read = stderr.read(&mut buffer)?;
            if read == 0 {
                return Ok(tail);
            }
            tail.extend_from_slice(&buffer[..read]);
            if tail.len() > STDERR_TAIL_BYTES {
                let excess = tail.len() - STDERR_TAIL_BYTES;
                tail.drain(..excess);
            }
        }
    })
}

/// Descendants can inherit a pipe even after its owner exits. Never let such a reader block
/// installation indefinitely; dropping an unfinished handle detaches the reader thread.
pub(crate) fn finish_reader<T>(reader: std::thread::JoinHandle<T>, timeout: Duration) -> Option<T> {
    let deadline = Instant::now() + timeout;
    while !reader.is_finished() {
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    reader.join().ok()
}

/// uv ordinarily writes UTF-8 diagnostics. If the bounded byte tail began in the middle of a
/// character, discard those leading continuation bytes rather than showing a replacement glyph.
fn stderr_tail_text(bytes: &[u8]) -> String {
    let mut start = 0;
    while start < bytes.len() && std::str::from_utf8(&bytes[start..]).is_err() {
        start += 1;
    }
    let text = String::from_utf8_lossy(&bytes[start..]);
    strip_ansi_colour_codes(&text)
}

/// Removes ANSI CSI colour sequences from a diagnostic before it reaches the dialog or log.
fn strip_ansi_colour_codes(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut clean = String::with_capacity(text.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\x1b' && bytes.get(index + 1) == Some(&b'[') {
            index += 2;
            while index < bytes.len() {
                let byte = bytes[index];
                index += 1;
                if (b'@'..=b'~').contains(&byte) {
                    break;
                }
            }
        } else {
            let character = text[index..]
                .chars()
                .next()
                .expect("character at byte index");
            clean.push(character);
            index += character.len_utf8();
        }
    }
    clean
}

fn stderr_error_summary(tail: &str) -> Option<String> {
    let lines: Vec<_> = tail
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .rev()
        .take(STDERR_ERROR_LINES)
        .collect();
    (!lines.is_empty()).then(|| lines.into_iter().rev().collect::<Vec<_>>().join(" "))
}

/// Bytes between progress events, so a 1.1 GB download sends ~1,000 events rather than ~9,000.
const PROGRESS_STRIDE_BYTES: u64 = 1024 * 1024;

impl<S: EngineSpec> InstallIo for SystemInstallIo<S> {
    fn download(
        &self,
        spec: Download<'_>,
        destination: &Path,
        cancel: &AtomicBool,
        progress: &dyn ProgressReporter,
    ) -> Result<(), InstallError> {
        check_cancel::<S>(cancel)?;
        let mut response = self
            .client
            .as_ref()
            .ok_or_else(|| InstallError::network("Downloads are disabled during engine recovery"))?
            .get(spec.url)
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .map_err(|error| {
                InstallError::network(format!("Could not download {}: {error}", spec.url))
            })?;
        if let (Some(expected), Some(reported)) = (spec.size, response.content_length()) {
            if expected != reported {
                return Err(InstallError::checksum(format!(
                    "{} reported {reported} bytes; expected {expected}.",
                    spec.url
                )));
            }
        }
        let total = spec.size.or_else(|| response.content_length());
        let mut file = File::create(destination).map_err(S::failed_io)?;
        let mut digest = Sha256::new();
        let mut done = 0_u64;
        let mut reported = 0_u64;
        let mut buffer = vec![0_u8; 128 * 1024];
        loop {
            check_cancel::<S>(cancel)?;
            let read = response.read(&mut buffer).map_err(|error| {
                InstallError::network(format!("Download interrupted for {}: {error}", spec.url))
            })?;
            if read == 0 {
                break;
            }
            file.write_all(&buffer[..read]).map_err(S::failed_io)?;
            digest.update(&buffer[..read]);
            done += read as u64;
            if spec.size.is_some_and(|expected| done > expected) {
                return Err(InstallError::checksum(format!(
                    "{} sent more than the pinned {} bytes.",
                    spec.url,
                    spec.size.unwrap_or_default()
                )));
            }
            if done - reported >= PROGRESS_STRIDE_BYTES {
                reported = done;
                progress.report(download_progress(spec.phase, done, total));
            }
        }
        progress.report(download_progress(spec.phase, done, total));
        file.sync_all().map_err(S::failed_io)?;
        let actual = format!("{:x}", digest.finalize());
        pins::verify_digest(done, &actual, spec.size, spec.sha256).map_err(|detail| {
            InstallError::checksum(format!("Verification failed for {}: {detail}.", spec.url))
        })?;
        Ok(())
    }

    fn extract_uv(
        &self,
        platform: &dyn EnginePlatform,
        archive: &Path,
        destination: &Path,
    ) -> Result<(), InstallError> {
        if platform.uv_asset().ends_with(".zip") {
            extract_uv_zip::<S>(archive, destination)
        } else {
            extract_uv_tar_gz::<S>(archive, destination)
        }
    }

    fn run(
        &self,
        platform: &dyn EnginePlatform,
        _step: RunStep,
        program: &Path,
        args: &[OsString],
        env: &[(OsString, OsString)],
        cancel: &AtomicBool,
        watch: Option<RunWatch<'_>>,
    ) -> Result<(), InstallError> {
        check_cancel::<S>(cancel)?;
        let mut command = Command::new(program);
        scrub_environment(&mut command);
        command
            .args(args)
            .envs(env.iter().cloned())
            .env("NO_COLOR", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::piped());
        platform.configure_child(&mut command);
        let mut child = command.spawn().map_err(|error| {
            InstallError::failed(format!("Could not run {}: {error}", program.display()))
        })?;
        let stderr = child.stderr.take().map(drain_stderr);
        let outcome = self.supervise(&mut child, program, cancel, watch, None);
        let stderr_tail = stderr
            .and_then(|reader| finish_reader(reader, PIPE_READER_TIMEOUT))
            .and_then(Result::ok)
            .map(|tail| stderr_tail_text(&tail))
            .unwrap_or_default();
        match outcome {
            Err(mut error) => {
                if error.code == super::InstallErrorCode::Failed {
                    if let Some(summary) = stderr_error_summary(&stderr_tail) {
                        eprintln!(
                            "{} {} stderr:\n{}",
                            S::LOG_PREFIX,
                            program.display(),
                            stderr_tail.trim_end()
                        );
                        if error.message.ends_with('.') {
                            error.message.pop();
                        }
                        error.message.push_str(": ");
                        error.message.push_str(&summary);
                    }
                }
                Err(error)
            }
            Ok(()) => Ok(()),
        }
    }
}

/// Drain the pipe while retaining only the final 8 KiB, so a chatty uv cannot block or
/// grow memory without bound and recovery failures include the useful diagnostic tail.
#[cfg(test)]
pub(super) fn stderr_tail(mut reader: impl Read) -> String {
    let mut tail = Vec::new();
    let mut buffer = [0_u8; 4096];
    while let Ok(read) = reader.read(&mut buffer) {
        if read == 0 {
            break;
        }
        tail.extend_from_slice(&buffer[..read]);
        if tail.len() > 8192 {
            tail.drain(..tail.len() - 8192);
        }
    }
    String::from_utf8_lossy(&tail).trim().to_owned()
}

/// Runs a program and returns what it wrote to stdout: the seam the in-place receipt upgrade uses
/// to ask the installed uv and Python what they are.
pub trait ProbeIo: InstallIo {
    fn output(
        &self,
        platform: &dyn EnginePlatform,
        program: &Path,
        args: &[OsString],
        cancel: &AtomicBool,
    ) -> Result<String, InstallError>;
}

/// A probe that has not answered in this long is killed; importing torch takes seconds.
const PROBE_TIMEOUT: Duration = Duration::from_secs(300);

impl<S: EngineSpec> ProbeIo for SystemInstallIo<S> {
    fn output(
        &self,
        platform: &dyn EnginePlatform,
        program: &Path,
        args: &[OsString],
        cancel: &AtomicBool,
    ) -> Result<String, InstallError> {
        check_cancel::<S>(cancel)?;
        let mut command = Command::new(program);
        scrub_environment(&mut command);
        command
            .args(args)
            .env("UV_NO_CONFIG", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        platform.configure_child(&mut command);
        let mut child = command.spawn().map_err(|error| {
            InstallError::failed(format!("Could not run {}: {error}", program.display()))
        })?;
        // Drained on its own thread so a chatty child never blocks on a full pipe.
        let reader = child.stdout.take().map(|mut stdout| {
            std::thread::spawn(move || {
                let mut text = Vec::new();
                stdout.read_to_end(&mut text).map(|_| text)
            })
        });
        let outcome = self.supervise(
            &mut child,
            program,
            cancel,
            None,
            Some(Instant::now() + PROBE_TIMEOUT),
        );
        let text = reader
            .map(|reader| {
                finish_reader(reader, PIPE_READER_TIMEOUT).unwrap_or_else(|| Ok(Vec::new()))
            })
            .transpose()
            .map_err(S::failed_io)?
            .unwrap_or_default();
        outcome?;
        Ok(String::from_utf8_lossy(&text).into_owned())
    }
}

impl<S: EngineSpec> SystemInstallIo<S> {
    /// Waits for `child`, killing its whole tree on cancel (or past `deadline`), and sampling a
    /// step's progress estimate while it runs.
    pub(crate) fn supervise(
        &self,
        child: &mut impl InstallChild,
        program: &Path,
        cancel: &AtomicBool,
        mut watch: Option<RunWatch<'_>>,
        deadline: Option<Instant>,
    ) -> Result<(), InstallError> {
        self.running.track(child);
        let mut last_sample = Instant::now();
        loop {
            let timed_out = deadline.is_some_and(|deadline| Instant::now() >= deadline);
            if cancel.load(Ordering::SeqCst) || timed_out {
                self.running.kill_and_wait(child);
                if timed_out && !cancel.load(Ordering::SeqCst) {
                    return Err(InstallError::failed(format!(
                        "{} did not finish within {} seconds.",
                        program.display(),
                        PROBE_TIMEOUT.as_secs()
                    )));
                }
                return Err(S::cancelled());
            }
            match self.running.try_wait(child) {
                Ok(Some(status)) => {
                    // Killed by app exit, which raises the cancel flag first.
                    if cancel.load(Ordering::SeqCst) {
                        return Err(S::cancelled());
                    }
                    if status.success() {
                        if let Some(watch) = watch.as_mut() {
                            watch.progress.report(watch.estimator.finished());
                        }
                        return Ok(());
                    }
                    return Err(InstallError::failed(format!(
                        "{} exited with {status}.",
                        program.display()
                    )));
                }
                Ok(None) => {
                    if let Some(watch) = watch.as_mut() {
                        if last_sample.elapsed() >= progress::SAMPLE_INTERVAL {
                            last_sample = Instant::now();
                            watch.progress.report(watch.estimator.sample());
                        }
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(error) => {
                    // Reap before either caller waits for a pipe reader. In particular, an
                    // inspection error does not imply that the process or its pipes exited.
                    self.running.kill_and_wait(child);
                    return Err(InstallError::failed(format!(
                        "Could not inspect {}: {error}",
                        program.display()
                    )));
                }
            }
        }
    }
}

pub(crate) fn pip_install_args<S: EngineSpec>(
    python: OsString,
    requirements: PathBuf,
) -> Vec<OsString> {
    let mut args = os_args(["pip", "install", "--python"]);
    args.push(python);
    args.push("--require-hashes".into());
    args.extend(S::pip_install_args());
    args.push("--requirement".into());
    args.push(requirements.into_os_string());
    args
}

pub fn install<S: EngineSpec>(
    paths: &InstallPaths,
    platform: &dyn EnginePlatform,
    io: &dyn InstallIo,
    cancel: &AtomicBool,
    progress: &dyn ProgressReporter,
    free_bytes: u64,
) -> Result<S::Receipt, InstallError> {
    progress.report(message(
        InstallPhase::CheckingDisk,
        "Checking available disk space.",
    ));
    S::platform_supported(platform).map_err(InstallError::unsupported)?;
    if free_bytes < S::required_disk_bytes() {
        return Err(S::insufficient_disk(free_bytes));
    }
    check_cancel::<S>(cancel)?;
    fs::create_dir_all(&paths.app_data).map_err(S::failed_io)?;
    let partial = paths.partial_dir_for::<S>();
    if partial.exists() {
        fs::remove_dir_all(&partial).map_err(S::failed_io)?;
    }
    fs::create_dir(&partial).map_err(S::failed_io)?;
    let mut guard = PartialGuard::new(partial.clone());

    progress.report(message(
        InstallPhase::DownloadingUv,
        "Downloading the pinned uv installer.",
    ));
    let uv_archive = partial.join(platform.uv_asset());
    io.download(
        Download {
            url: &pins::uv_url(platform.uv_asset()),
            sha256: platform.uv_sha256(),
            size: None,
            phase: InstallPhase::DownloadingUv,
        },
        &uv_archive,
        cancel,
        progress,
    )?;
    let uv = platform.uv_executable(&partial);
    io.extract_uv(platform, &uv_archive, &uv)?;
    check_cancel::<S>(cancel)?;

    let python_install_dir = partial.join("python");
    let cache_dir = partial.join("download-cache");
    let temp_dir = partial.join("temp");
    fs::create_dir_all(&temp_dir).map_err(S::failed_io)?;
    let environment = uv_environment(&partial);
    progress.report(message(
        InstallPhase::InstallingPython,
        "Installing the pinned managed Python runtime.",
    ));
    io.run(
        platform,
        RunStep::InstallPython,
        &uv,
        &os_args(["python", "install", S::python_version()]),
        &environment,
        cancel,
        Some(RunWatch {
            estimator: GrowthEstimator::new(
                InstallPhase::InstallingPython,
                "Installing Python",
                vec![python_install_dir.clone(), cache_dir.clone()],
                S::python_growth_bytes(),
            ),
            progress,
        }),
    )?;
    io.run(
        platform,
        RunStep::CreateVenv,
        &uv,
        &[
            OsString::from("venv"),
            partial.join("venv").into_os_string(),
            OsString::from("--python"),
            OsString::from(S::python_version()),
            OsString::from("--python-preference"),
            OsString::from("only-managed"),
            // Relative activation scripts and entry-point shebangs; the interpreter links and
            // pyvenv.cfg are still absolute and are rebased by `relocate_staged_tree`.
            OsString::from("--relocatable"),
        ],
        &environment,
        cancel,
        None,
    )?;

    let context = InstallContext {
        root: &partial,
        platform,
        io,
        cancel,
        progress,
        environment: &environment,
    };
    S::before_packages(&context)?;

    progress.report(message(
        InstallPhase::InstallingPackages,
        S::packages_message(),
    ));
    let requirements = fs::read(&paths.requirements).map_err(S::failed_io)?;
    let requirements_sha256 = pins::text_sha256(&requirements);
    if requirements_sha256 != S::requirements().1 {
        return Err(InstallError::checksum(format!(
            "The bundled requirements lock does not match this build: expected SHA-256 {}, found {requirements_sha256}.",
            S::requirements().1
        )));
    }
    let installed_requirements = partial.join(REQUIREMENTS_FILE);
    fs::write(&installed_requirements, &requirements).map_err(S::failed_io)?;
    let venv_python = platform.venv_python(&partial).into_os_string();
    // Every package, transitive ones included, is pinned with hashes; `--require-hashes` makes uv
    // refuse anything unpinned, unhashed, or whose archive does not match.
    io.run(
        platform,
        RunStep::InstallPackages,
        &uv,
        &pip_install_args::<S>(venv_python.clone(), installed_requirements),
        &environment,
        cancel,
        Some(RunWatch {
            estimator: GrowthEstimator::new(
                InstallPhase::InstallingPackages,
                S::packages_label(),
                vec![cache_dir.clone(), partial.join("venv")],
                S::packages_growth_bytes(),
            ),
            progress,
        }),
    )?;

    S::extra_steps(&context)?;

    progress.report(message(
        InstallPhase::Verifying,
        "Verifying the installed engine.",
    ));
    check_cancel::<S>(cancel)?;
    fs::remove_file(&uv_archive).map_err(S::failed_io)?;
    if cache_dir.exists() {
        fs::remove_dir_all(&cache_dir).map_err(S::failed_io)?;
    }
    if temp_dir.exists() {
        fs::remove_dir_all(&temp_dir).map_err(S::failed_io)?;
    }
    S::verify_layout(&partial, platform)?;
    // The receipt is NOT written here: it is the last thing written, into the final location, once
    // the engine has proved it works there (see `commit_staged_tree`).
    let disk_bytes = directory_size(&partial).map_err(S::failed_io)?;
    let receipt = S::receipt(platform, disk_bytes);
    check_cancel::<S>(cancel)?;

    commit_staged_tree::<S>(paths, platform, io, cancel, &mut guard, &receipt)?;
    progress.report(message(InstallPhase::Done, S::installed_message()));
    Ok(receipt)
}

/// uv must never inherit a caller's interpreter, cache or configuration. Use the same
/// engine-local directories before staging is swapped and when refreshing the final tree.
fn uv_environment(root: &Path) -> Vec<(OsString, OsString)> {
    let mut env: Vec<_> = [
        ("UV_PYTHON_INSTALL_DIR", "python"),
        ("UV_CACHE_DIR", "download-cache"),
        ("UV_PYTHON_BIN_DIR", "python-bin"),
        ("UV_STATE_DIR", "uv-state"),
        ("TMPDIR", "temp"),
        ("TMP", "temp"),
        ("TEMP", "temp"),
    ]
    .into_iter()
    .map(|(key, directory)| (OsString::from(key), root.join(directory).into_os_string()))
    .collect();
    env.push((OsString::from("UV_NO_CONFIG"), OsString::from("1")));
    env
}

/// Windows uv launchers embed the absolute managed interpreter path, even with
/// --relocatable, and ignore pyvenv.cfg. Regenerate both launchers after a move, preserving
/// site-packages. The minor-version junction was already rebased by relocation.
#[cfg(windows)]
pub(crate) fn rewrite_venv_launchers<S: EngineSpec>(
    root: &Path,
    platform: &dyn EnginePlatform,
    io: &dyn InstallIo,
    cancel: &AtomicBool,
) -> Result<(), InstallError> {
    check_cancel::<S>(cancel)?;
    // Only x64 Windows is supported. For ARM64, change the managed Python triple here
    // alongside the Windows uv pins in local_engine/pins.rs.
    let python = root
        .join("python")
        .join(format!(
            "cpython-{}-windows-x86_64-none",
            S::python_version()
        ))
        .join("python.exe");
    // The install removed its staging temp directory before the swap. uv may need it while
    // replacing launchers; restore it briefly and leave an existing recovery temp tree alone.
    let temp = root.join("temp");
    let had_temp = temp.exists();
    fs::create_dir_all(&temp).map_err(|error| {
        InstallError::failed(format!(
            "Could not prepare the venv launcher rewrite: {error}"
        ))
    })?;
    let result = io.run(
        platform,
        RunStep::RewriteVenvLaunchers,
        &platform.uv_executable(root),
        &[
            OsString::from("venv"),
            root.join("venv").into_os_string(),
            OsString::from("--allow-existing"),
            OsString::from("--offline"),
            OsString::from("--python"),
            python.into_os_string(),
            OsString::from("--python-preference"),
            OsString::from("only-managed"),
            OsString::from("--relocatable"),
        ],
        &uv_environment(root),
        cancel,
        None,
    );
    if !had_temp {
        let _ = fs::remove_dir_all(&temp);
    }
    let _ = fs::remove_dir_all(root.join("download-cache"));
    result.map_err(|error| InstallError {
        code: error.code,
        message: format!(
            "Could not rewrite the relocated venv launchers: {}",
            error.message
        ),
    })?;
    check_cancel::<S>(cancel)
}

// Unix venv interpreters are symlinks, which relocate_staged_tree already repairs.
#[cfg(not(windows))]
pub(crate) fn rewrite_venv_launchers<S: EngineSpec>(
    _root: &Path,
    _platform: &dyn EnginePlatform,
    _io: &dyn InstallIo,
    _cancel: &AtomicBool,
) -> Result<(), InstallError> {
    Ok(())
}

/// Swaps the verified staging tree into place and proves it works there.
///
/// uv records the interpreter by absolute path — the venv's `python` link and `pyvenv.cfg`'s
/// `home`, and the managed Python's minor-version link — so a renamed tree points back into the
/// directory that no longer exists. After the rename those paths are rebased onto the final
/// location, and the import check runs from the final location, which is the only proof that the
/// relocation worked. Any existing install is set aside first and restored if anything fails, so
/// a failed reinstall never costs the user a working engine.
///
/// # Crash safety
///
/// Two rules make every moment of this function survivable by a quit, a crash, or power loss:
///
/// 1. **`engine/` only ever changes by whole-directory renames.** Nothing is ever deleted
///    inside it. A tree leaving that name is renamed to a fresh `engine.discard-*` sibling
///    first ([`retire_tree`]) and deleted there, so an interrupted delete can only ever leave a
///    half-deleted *discard* directory, which the next launch sweeps.
/// 2. **The receipt is the last file written into an engine and leaves with the tree.** It is
///    written into `engine/` only after the relocation, the layout check and the import
///    check have all passed there. So an `engine/` holding a current receipt is a complete,
///    verified engine; one without a receipt is an interrupted commit. [`is_healthy`] and the
///    status command both require the receipt, so a partial engine is never reported installed.
///
/// If the process dies at any point, [`remove_stale_staging`] at the next launch finds one of: a
/// healthy `engine/` (the set-aside tree is discarded); a missing or receipt-less
/// `engine/` beside a healthy `engine.previous/` (the previous engine is restored); or
/// a receipt-less `engine/` alone (discarded, so status reads "not installed").
fn commit_staged_tree<S: EngineSpec>(
    paths: &InstallPaths,
    platform: &dyn EnginePlatform,
    io: &dyn InstallIo,
    cancel: &AtomicBool,
    guard: &mut PartialGuard,
    receipt: &S::Receipt,
) -> Result<(), InstallError> {
    let partial = paths.partial_dir_for::<S>();
    let final_dir = paths.final_dir_for::<S>();
    let previous = paths.previous_dir_for::<S>();
    // uv may have resolved symlinked ancestors (e.g. /var → /private/var) when it wrote paths, so
    // both spellings of the staging prefix are rebased.
    let mut rebases = vec![(partial.clone(), final_dir.clone())];
    if let Ok(canonical_app_data) = fs::canonicalize(&paths.app_data) {
        let canonical = (
            canonical_app_data.join(format!("{}.partial", S::DIR_NAME)),
            canonical_app_data.join(S::DIR_NAME),
        );
        if canonical != rebases[0] {
            rebases.push(canonical);
        }
    }

    // A set-aside tree from an interrupted swap may be the only working engine: put it back in
    // place first if `engine/` is not, so it becomes the one this install falls back to.
    if let Err(error) = reconcile_previous::<S>(paths, platform, io, cancel) {
        if error.code == super::InstallErrorCode::Cancelled {
            return Err(error);
        }
        // Recovery logged the process error, including its stderr tail. Replace these
        // unusable trees rather than allowing them to block reinstall or become rollback.
        eprintln!(
            "{} discarding unusable recovery trees before reinstall: {}",
            S::LOG_PREFIX,
            error.message
        );
        remove_tree::<S>(&paths.app_data, &previous).map_err(S::failed_io)?;
        remove_tree::<S>(&paths.app_data, &final_dir).map_err(S::failed_io)?;
    }
    remove_tree::<S>(&paths.app_data, &previous).map_err(S::failed_io)?;
    let had_previous = final_dir.exists();
    if had_previous {
        fs::rename(&final_dir, &previous).map_err(S::failed_io)?;
    }
    if let Err(error) = fs::rename(&partial, &final_dir) {
        restore_previous::<S>(&final_dir, &previous, had_previous, platform, io, cancel);
        return Err(S::failed_io(error));
    }
    // From here the staging tree is gone; a failure retires the new tree instead.
    guard.commit();

    let outcome = relocate_staged_tree(&final_dir, &rebases)
        .map_err(S::relocation_error)
        .and_then(|()| rewrite_venv_launchers::<S>(&final_dir, platform, io, cancel))
        .and_then(|()| S::verify_layout(&final_dir, platform))
        .and_then(|()| {
            io.run(
                platform,
                RunStep::VerifyEnvironment,
                &platform.venv_python(&final_dir),
                &S::probe_args(),
                &[],
                cancel,
                None,
            )
        })
        .and_then(|()| check_cancel::<S>(cancel))
        // Last: from this write on, `engine/` is a verified install.
        .and_then(|()| S::write_receipt(&final_dir.join(RECEIPT_FILE), receipt));
    match outcome {
        Ok(()) => {
            if let Err(error) = remove_tree::<S>(&paths.app_data, &previous) {
                eprintln!(
                    "{} could not set aside the replaced engine at {}: {error}",
                    S::LOG_PREFIX,
                    previous.display()
                );
            }
            Ok(())
        }
        Err(error) => {
            // Rename the failed tree away before restoring, never delete it in place: a quit
            // mid-delete would leave a half-deleted tree where the engine belongs.
            match retire_tree::<S>(&paths.app_data, &final_dir) {
                Ok(discarded) => {
                    restore_previous::<S>(
                        &final_dir,
                        &previous,
                        had_previous,
                        platform,
                        io,
                        cancel,
                    );
                    if let Some(discarded) = discarded {
                        delete_discarded::<S>(&discarded);
                    }
                }
                // The failed tree has no receipt, so it reads as not installed, and the next
                // launch restores the previous engine over it.
                Err(retire_error) => eprintln!(
                    "{} could not set aside the failed engine at {}: {retire_error}",
                    S::LOG_PREFIX,
                    final_dir.display()
                ),
            }
            Err(error)
        }
    }
}

fn restore_previous<S: EngineSpec>(
    final_dir: &Path,
    previous: &Path,
    had_previous: bool,
    platform: &dyn EnginePlatform,
    io: &dyn InstallIo,
    cancel: &AtomicBool,
) {
    if had_previous && !final_dir.exists() {
        if let Err(error) = fs::rename(previous, final_dir) {
            eprintln!(
                "{} could not restore the previous engine from {}: {error}",
                S::LOG_PREFIX,
                previous.display()
            );
        } else if let Err(error) = rewrite_venv_launchers::<S>(final_dir, platform, io, cancel) {
            // The old launchers already name final_dir, so cancellation can skip the refresh
            // safely. Never start a new child after cancellation (including app exit).
            if error.code != super::InstallErrorCode::Cancelled {
                eprintln!(
                    "{} could not refresh the restored engine: {}",
                    S::LOG_PREFIX,
                    error.message
                );
            }
        }
    }
}

/// A fresh, unused discard path beside the engine. It lives in `app_data` itself so renaming a
/// tree to it never crosses a filesystem, which is what makes the rename atomic.
fn discard_path<S: EngineSpec>(app_data: &Path) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    loop {
        let candidate = app_data.join(format!(
            "{}.discard-{}-{}",
            S::DIR_NAME,
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        if fs::symlink_metadata(&candidate).is_err() {
            return candidate;
        }
    }
}

/// Atomically renames `tree` to a fresh discard directory and returns where it went, or `None`
/// if there was nothing to move. On error `tree` is untouched and still whole.
pub fn retire_tree<S: EngineSpec>(app_data: &Path, tree: &Path) -> io::Result<Option<PathBuf>> {
    if fs::symlink_metadata(tree).is_err() {
        return Ok(None);
    }
    let discarded = discard_path::<S>(app_data);
    fs::rename(tree, &discarded)?;
    Ok(Some(discarded))
}

/// Deletes a retired tree, receipt first. A failure is logged and left for the next launch's
/// sweep; the tree is already out of every place ChemDraft reads an engine from.
fn delete_discarded<S: EngineSpec>(discarded: &Path) -> bool {
    let _ = fs::remove_file(discarded.join(RECEIPT_FILE));
    match fs::remove_dir_all(discarded) {
        Ok(()) => true,
        Err(error) => {
            eprintln!(
                "{} could not delete {} (the next launch retries): {error}",
                S::LOG_PREFIX,
                discarded.display()
            );
            false
        }
    }
}

/// Removes `tree` rename-first: it is renamed to a discard directory, then deleted there. An
/// error means the rename failed and `tree` is still whole in place.
pub fn remove_tree<S: EngineSpec>(app_data: &Path, tree: &Path) -> io::Result<()> {
    if let Some(discarded) = retire_tree::<S>(app_data, tree)? {
        delete_discarded::<S>(&discarded);
    }
    Ok(())
}

/// Every leftover discard directory in `app_data`.
pub(crate) fn discard_dirs<S: EngineSpec>(app_data: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(app_data) else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(&format!("{}.discard-", S::DIR_NAME))
        })
        .map(|entry| entry.path())
        .collect();
    found.sort();
    found
}

/// Uninstall: removes every engine tree, each rename-first. The live engine goes LAST, so a
/// failure part-way never leaves a set-aside engine that the next launch would restore over an
/// uninstall the user asked for. On error, returns the tree that could not be moved aside; it is
/// still whole in place.
pub fn remove_engine_trees<S: EngineSpec>(
    paths: &InstallPaths,
) -> Result<(), (PathBuf, io::Error)> {
    for tree in [
        paths.partial_dir_for::<S>(),
        paths.previous_dir_for::<S>(),
        paths.final_dir_for::<S>(),
    ] {
        remove_tree::<S>(&paths.app_data, &tree).map_err(|error| (tree, error))?;
    }
    for discarded in discard_dirs::<S>(&paths.app_data) {
        delete_discarded::<S>(&discarded);
    }
    Ok(())
}

/// Settles `engine.previous/` after an interrupted swap. Beside a healthy `engine/` it
/// is discarded. Otherwise, if it is healthy itself, it is restored: the unhealthy or missing
/// `engine/` is retired and the previous engine renamed back. If neither is healthy both are
/// left alone. Returns whether `engine.previous/` was removed from disk.
fn reconcile_previous<S: EngineSpec>(
    paths: &InstallPaths,
    platform: &dyn EnginePlatform,
    io: &dyn InstallIo,
    cancel: &AtomicBool,
) -> Result<bool, InstallError> {
    let final_dir = paths.final_dir_for::<S>();
    let previous = paths.previous_dir_for::<S>();
    if !previous.exists() {
        return Ok(false);
    }
    if is_healthy::<S>(&final_dir, platform) {
        return Ok(match retire_tree::<S>(&paths.app_data, &previous) {
            Ok(discarded) => {
                if let Some(discarded) = discarded {
                    delete_discarded::<S>(&discarded);
                }
                true
            }
            Err(error) => {
                eprintln!(
                    "{} could not set aside the stale {}: {error}",
                    S::LOG_PREFIX,
                    previous.display()
                );
                false
            }
        });
    }
    if !S::is_restorable(&previous, platform) {
        return Ok(false);
    }
    check_cancel::<S>(cancel)?;
    let discarded = match retire_tree::<S>(&paths.app_data, &final_dir) {
        Ok(discarded) => discarded,
        Err(error) => {
            eprintln!(
                "{} could not set aside the unhealthy {}: {error}",
                S::LOG_PREFIX,
                final_dir.display()
            );
            return Ok(false);
        }
    };
    let outcome = fs::rename(&previous, &final_dir)
        .map_err(S::failed_io)
        .and_then(|()| {
            relocate_staged_tree(&final_dir, &[(previous.clone(), final_dir.clone())])
                .map_err(S::relocation_error)
        })
        .and_then(|()| rewrite_venv_launchers::<S>(&final_dir, platform, io, cancel))
        .and_then(|()| check_cancel::<S>(cancel));
    if let Err(error) = outcome {
        eprintln!(
            "{} could not restore the previous engine: {}",
            S::LOG_PREFIX,
            error.message
        );
        // Keep the only verified tree for another recovery attempt if refreshing it failed.
        if final_dir.exists() && !previous.exists() {
            if let Err(error) = fs::rename(&final_dir, &previous) {
                eprintln!(
                    "{} could not set the previous engine back: {error}",
                    S::LOG_PREFIX
                );
            }
        }
        if let Some(discarded) = discarded {
            if let Err(error) = fs::rename(discarded, &final_dir) {
                eprintln!(
                    "{} could not restore the interrupted tree: {error}",
                    S::LOG_PREFIX
                );
            }
        }
        return Err(error);
    }
    eprintln!(
        "{} restored the previous engine from {}",
        S::LOG_PREFIX,
        previous.display()
    );
    if let Some(discarded) = discarded {
        delete_discarded::<S>(&discarded);
    }
    // Restored, not removed: the engine is still on disk, now as `engine/`.
    Ok(false)
}

/// Use the same spelling for canonicalized Windows paths and junction targets returned by read_link.
/// Keep non-UTF-8 path data intact and leave other namespaces and relative paths alone.
#[cfg(windows)]
pub(super) fn normalize_verbatim_path(path: &Path) -> PathBuf {
    use std::path::{Component, Prefix};

    let mut components = path.components();
    let mut plain = match components.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::VerbatimDisk(drive) => PathBuf::from(format!("{}:\\", char::from(drive))),
            Prefix::VerbatimUNC(server, share) => {
                let mut root = OsString::from(r"\\");
                root.push(server);
                root.push(r"\");
                root.push(share);
                PathBuf::from(root)
            }
            _ => return path.to_path_buf(),
        },
        _ => return path.to_path_buf(),
    };
    // The replacement prefix already supplies the root; pushing RootDir would replace it.
    plain.extend(components.filter(|component| !matches!(component, Component::RootDir)));
    plain
}

#[cfg(not(windows))]
pub(super) fn normalize_verbatim_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

/// Rewrites every symlink or junction under `root` whose target lies under an old prefix, and the `home`
/// entry of `venv/pyvenv.cfg`, so both point at the same place under the new prefix.
pub fn relocate_staged_tree(root: &Path, rebases: &[(PathBuf, PathBuf)]) -> io::Result<()> {
    let rebase = |target: &Path| {
        let target = normalize_verbatim_path(target);
        rebases.iter().find_map(|(old, new)| {
            target
                .strip_prefix(normalize_verbatim_path(old))
                .ok()
                .map(|rest| normalize_verbatim_path(new).join(rest))
        })
    };
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            let path = entry.path();
            let file_type = entry.file_type()?;
            let is_link = file_type.is_symlink();
            let junction = if is_link { is_junction(&path)? } else { false };
            if junction || is_link {
                let target = fs::read_link(&path)?;
                if let Some(rebased) = rebase(&target) {
                    fs::remove_file(&path).or_else(|_| fs::remove_dir(&path))?;
                    create_link(&rebased, &path, junction)?;
                }
            } else if file_type.is_dir() {
                pending.push(path);
            }
        }
    }

    let config = root.join("venv").join("pyvenv.cfg");
    if config.is_file() {
        let mut text = fs::read_to_string(&config)?;
        for (old, new) in rebases {
            text = text.replace(
                old.to_string_lossy().as_ref(),
                new.to_string_lossy().as_ref(),
            );
        }
        fs::write(&config, text)?;
    }
    Ok(())
}

#[cfg(unix)]
pub(super) fn create_link(target: &Path, link: &Path, _junction: bool) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

// A real Windows install confirmed uv's minor-version directory is a junction. Replacing it
// with symlink_dir failed with error 1314 for an ordinary user. Preserve the reparse-point kind:
// junction creation needs no symlink privilege (see docs/architecture/ocsr-engine.md).
#[cfg(windows)]
pub(super) fn create_link(target: &Path, link: &Path, junction: bool) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, MAXIMUM_REPARSE_DATA_BUFFER_SIZE,
    };
    use windows_sys::Win32::System::Ioctl::FSCTL_SET_REPARSE_POINT;
    use windows_sys::Win32::System::SystemServices::IO_REPARSE_TAG_MOUNT_POINT;
    use windows_sys::Win32::System::IO::DeviceIoControl;

    if junction {
        let absolute: Vec<u16> = normalize_verbatim_path(&std::path::absolute(target)?)
            .as_os_str()
            .encode_wide()
            .collect();
        // Drive and UNC print names are plain absolute; the substitute uses the NT namespace.
        let mut substitute: Vec<u16> = r"\??\".encode_utf16().collect();
        if absolute.starts_with(&[92, 92, 63, 92]) {
            substitute.extend_from_slice(&absolute[4..]);
        } else if absolute.starts_with(&[92, 92]) {
            substitute.extend("UNC\\".encode_utf16());
            substitute.extend_from_slice(&absolute[2..]);
        } else {
            substitute.extend_from_slice(&absolute);
        }
        let size = 16 + (substitute.len() + absolute.len() + 2) * 2;
        if size > MAXIMUM_REPARSE_DATA_BUFFER_SIZE as usize {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "junction target is too long",
            ));
        }
        // REPARSE_DATA_BUFFER: 8-byte header, 8-byte mount-point header, then two NUL-terminated
        // UTF-16 names. Offsets and lengths count bytes from the start of PathBuffer.
        let mut data = Vec::with_capacity(size);
        data.extend(IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
        for value in [
            (size - 8) as u16,
            0,
            0,
            (substitute.len() * 2) as u16,
            ((substitute.len() + 1) * 2) as u16,
            (absolute.len() * 2) as u16,
        ] {
            data.extend(value.to_le_bytes());
        }
        for unit in substitute
            .iter()
            .chain([0].iter())
            .chain(absolute.iter())
            .chain([0].iter())
        {
            data.extend(unit.to_le_bytes());
        }
        fs::create_dir(link)?;
        let result = (|| {
            let directory = fs::OpenOptions::new()
                .write(true)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
                .open(link)?;
            let mut returned = 0;
            // SAFETY: the owned handle stays open; data holds a complete mount-point buffer;
            // this synchronous call uses no output buffer or OVERLAPPED structure.
            let ok = unsafe {
                DeviceIoControl(
                    directory.as_raw_handle(),
                    FSCTL_SET_REPARSE_POINT,
                    data.as_ptr().cast(),
                    data.len() as u32,
                    std::ptr::null_mut(),
                    0,
                    &mut returned,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        })();
        if result.is_err() {
            let _ = fs::remove_dir(link);
        }
        return result;
    }
    if target.is_dir() {
        std::os::windows::fs::symlink_dir(target, link)
    } else {
        std::os::windows::fs::symlink_file(target, link)
    }
}

#[cfg(not(any(unix, windows)))]
pub(super) fn create_link(_target: &Path, _link: &Path, _junction: bool) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "symlinks are unsupported on this platform",
    ))
}

#[cfg(windows)]
pub(super) fn is_junction(path: &Path) -> io::Result<bool> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileAttributeTagInfo, GetFileInformationByHandleEx, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_ATTRIBUTE_TAG_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    };
    use windows_sys::Win32::System::SystemServices::IO_REPARSE_TAG_MOUNT_POINT;

    if fs::symlink_metadata(path)?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
        return Ok(false);
    }
    let link = fs::OpenOptions::new()
        .access_mode(0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)?;
    let mut info = FILE_ATTRIBUTE_TAG_INFO {
        FileAttributes: 0,
        ReparseTag: 0,
    };
    // SAFETY: link owns the handle and info is writable with exactly the requested size.
    let ok = unsafe {
        GetFileInformationByHandleEx(
            link.as_raw_handle(),
            FileAttributeTagInfo,
            (&mut info as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
            std::mem::size_of_val(&info) as u32,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(info.ReparseTag == IO_REPARSE_TAG_MOUNT_POINT)
}

#[cfg(not(windows))]
pub(super) fn is_junction(_path: &Path) -> io::Result<bool> {
    Ok(false)
}

/// Whether `root` holds an install that matches this build's pins and layout, as
/// the status command would report `installed`. The receipt is required, and it is written last
/// on install and leaves first (with the whole tree, by rename) on teardown, so a tree that is
/// incomplete for either reason never counts (see `commit_staged_tree`).
pub fn is_healthy<S: EngineSpec>(root: &Path, platform: &dyn EnginePlatform) -> bool {
    S::read_current_receipt(&root.join(RECEIPT_FILE))
        .is_some_and(|receipt| S::matches_pins(&receipt, platform))
        && S::verify_layout(root, platform).is_ok()
}

/// Settles what an interrupted install, reinstall or uninstall left behind. The caller guarantees
/// no install is running. In order:
///
/// - `engine.partial/` is removed (rename-first, like every teardown here);
/// - `engine.previous/` is discarded beside a healthy `engine/`, and restored in its
///   place when `engine/` is missing or unhealthy and the previous engine is healthy; when
///   neither is healthy it is left for the user's next install or uninstall;
/// - an `engine/` with no receipt at all is an interrupted commit (the receipt is written
///   last) and is discarded;
/// - every leftover `engine.discard-*` directory is deleted.
///
/// Returns what was removed from disk.
pub fn remove_stale_staging<S: EngineSpec>(
    paths: &InstallPaths,
    platform: &dyn EnginePlatform,
    io: &dyn InstallIo,
    cancel: &AtomicBool,
) -> Vec<PathBuf> {
    let mut removed = Vec::new();
    let partial = paths.partial_dir_for::<S>();
    if partial.exists() {
        match remove_tree::<S>(&paths.app_data, &partial) {
            Ok(()) => removed.push(partial),
            Err(error) => eprintln!(
                "{} could not remove the stale {}: {error}",
                S::LOG_PREFIX,
                partial.display()
            ),
        }
    }
    match reconcile_previous::<S>(paths, platform, io, cancel) {
        Ok(true) => removed.push(paths.previous_dir_for::<S>()),
        Ok(false) => {}
        Err(error) => eprintln!(
            "{} could not reconcile the previous engine: {}",
            S::LOG_PREFIX,
            error.message
        ),
    }
    let final_dir = paths.final_dir_for::<S>();
    if final_dir.is_dir() && fs::symlink_metadata(final_dir.join(RECEIPT_FILE)).is_err() {
        match remove_tree::<S>(&paths.app_data, &final_dir) {
            Ok(()) => removed.push(final_dir),
            Err(error) => eprintln!(
                "{} could not set aside the incomplete {}: {error}",
                S::LOG_PREFIX,
                final_dir.display()
            ),
        }
    }
    for discarded in discard_dirs::<S>(&paths.app_data) {
        if delete_discarded::<S>(&discarded) {
            removed.push(discarded);
        }
    }
    removed
}

pub(crate) fn check_cancel<S: EngineSpec>(cancel: &AtomicBool) -> Result<(), InstallError> {
    if cancel.load(Ordering::SeqCst) {
        Err(S::cancelled())
    } else {
        Ok(())
    }
}

pub(crate) fn os_args<const N: usize>(args: [&str; N]) -> Vec<OsString> {
    args.into_iter().map(OsString::from).collect()
}

pub(crate) fn download_progress(
    phase: InstallPhase,
    done: u64,
    total: Option<u64>,
) -> InstallProgress {
    let megabytes = |bytes: u64| bytes as f64 / 1_000_000.0;
    InstallProgress {
        phase,
        message: match total {
            Some(total) => format!(
                "Downloaded {:.1} of {:.1} MB.",
                megabytes(done),
                megabytes(total)
            ),
            None => format!("Downloaded {:.1} MB.", megabytes(done)),
        },
        bytes_done: Some(done),
        bytes_total: total,
        estimated: false,
    }
}

pub(crate) fn message(phase: InstallPhase, message: &str) -> InstallProgress {
    InstallProgress {
        phase,
        message: message.to_string(),
        bytes_done: None,
        bytes_total: None,
        estimated: false,
    }
}

pub(crate) fn extract_uv_tar_gz<S: EngineSpec>(
    archive: &Path,
    destination: &Path,
) -> Result<(), InstallError> {
    let file = File::open(archive).map_err(S::failed_io)?;
    let mut archive = GzDecoder::new(file);
    loop {
        let mut header = [0_u8; 512];
        match archive.read_exact(&mut header) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(error) => return Err(S::failed_io(error)),
        }
        if header.iter().all(|byte| *byte == 0) {
            break;
        }
        let size = parse_tar_octal(&header[124..136])?;
        let name_end = header[..100]
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(100);
        let name = String::from_utf8_lossy(&header[..name_end]);
        let is_regular = matches!(header[156], 0 | b'0');
        if Path::new(name.as_ref()).file_name() == Some(OsStr::new("uv")) && is_regular {
            let mut output = File::create(destination).map_err(S::failed_io)?;
            let copied = io::copy(&mut Read::by_ref(&mut archive).take(size), &mut output)
                .map_err(S::failed_io)?;
            if copied != size {
                return Err(InstallError::failed(
                    "The uv tar archive ended inside the executable.".to_string(),
                ));
            }
            output.sync_all().map_err(S::failed_io)?;
            make_executable::<S>(destination)?;
            return Ok(());
        }
        let padded = size.saturating_add(511) / 512 * 512;
        let skipped = io::copy(
            &mut Read::by_ref(&mut archive).take(padded),
            &mut io::sink(),
        )
        .map_err(S::failed_io)?;
        if skipped != padded {
            return Err(InstallError::failed(
                "The uv tar archive ended inside an entry.".to_string(),
            ));
        }
    }
    Err(InstallError::failed(
        "The verified uv archive did not contain the uv executable.".to_string(),
    ))
}

pub(crate) fn extract_uv_zip<S: EngineSpec>(
    archive: &Path,
    destination: &Path,
) -> Result<(), InstallError> {
    let bytes = fs::read(archive).map_err(S::failed_io)?;
    let eocd = bytes
        .windows(4)
        .rposition(|window| window == b"PK\x05\x06")
        .ok_or_else(|| InstallError::failed("The uv zip has no central directory."))?;
    let entries = zip_u16::<S>(&bytes, eocd + 10)? as usize;
    let mut cursor = zip_u32::<S>(&bytes, eocd + 16)? as usize;
    for _ in 0..entries {
        if bytes.get(cursor..cursor + 4) != Some(b"PK\x01\x02") {
            return Err(InstallError::failed(
                "The uv zip central directory is malformed.".to_string(),
            ));
        }
        let method = zip_u16::<S>(&bytes, cursor + 10)?;
        let compressed_size = zip_u32::<S>(&bytes, cursor + 20)? as usize;
        let uncompressed_size = zip_u32::<S>(&bytes, cursor + 24)? as usize;
        let name_len = zip_u16::<S>(&bytes, cursor + 28)? as usize;
        let extra_len = zip_u16::<S>(&bytes, cursor + 30)? as usize;
        let comment_len = zip_u16::<S>(&bytes, cursor + 32)? as usize;
        let local_offset = zip_u32::<S>(&bytes, cursor + 42)? as usize;
        let name_start = cursor + 46;
        let name_end = name_start
            .checked_add(name_len)
            .ok_or_else(|| InstallError::failed("The uv zip contains an oversized filename."))?;
        let name = bytes
            .get(name_start..name_end)
            .ok_or_else(|| InstallError::failed("The uv zip filename is truncated."))?;
        if Path::new(String::from_utf8_lossy(name).as_ref()).file_name()
            == Some(OsStr::new("uv.exe"))
        {
            if bytes.get(local_offset..local_offset + 4) != Some(b"PK\x03\x04") {
                return Err(InstallError::failed(
                    "The uv zip local entry is malformed.".to_string(),
                ));
            }
            let local_name = zip_u16::<S>(&bytes, local_offset + 26)? as usize;
            let local_extra = zip_u16::<S>(&bytes, local_offset + 28)? as usize;
            let data_start = local_offset
                .checked_add(30 + local_name + local_extra)
                .ok_or_else(|| InstallError::failed("The uv zip entry offset overflowed."))?;
            let data_end = data_start
                .checked_add(compressed_size)
                .ok_or_else(|| InstallError::failed("The uv zip entry size overflowed."))?;
            let compressed = bytes
                .get(data_start..data_end)
                .ok_or_else(|| InstallError::failed("The uv zip entry is truncated."))?;
            let mut output = File::create(destination).map_err(S::failed_io)?;
            let written = match method {
                0 => io::copy(&mut io::Cursor::new(compressed), &mut output),
                8 => io::copy(
                    &mut flate2::read::DeflateDecoder::new(io::Cursor::new(compressed)),
                    &mut output,
                ),
                other => {
                    return Err(InstallError::failed(format!(
                        "The uv zip uses unsupported compression method {other}."
                    )))
                }
            }
            .map_err(S::failed_io)?;
            if written != uncompressed_size as u64 {
                return Err(InstallError::failed(format!(
                    "The uv zip produced {written} bytes; expected {uncompressed_size}."
                )));
            }
            output.sync_all().map_err(S::failed_io)?;
            return Ok(());
        }
        cursor = name_end
            .checked_add(extra_len + comment_len)
            .ok_or_else(|| InstallError::failed("The uv zip directory offset overflowed."))?;
    }
    Err(InstallError::failed(
        "The verified uv archive did not contain uv.exe.".to_string(),
    ))
}

fn parse_tar_octal(bytes: &[u8]) -> Result<u64, InstallError> {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim_matches(['\0', ' ']);
    u64::from_str_radix(text, 8)
        .map_err(|error| InstallError::failed(format!("Invalid uv tar entry size: {error}")))
}

fn zip_u16<S: EngineSpec>(bytes: &[u8], offset: usize) -> Result<u16, InstallError> {
    let raw: [u8; 2] = bytes
        .get(offset..offset + 2)
        .and_then(|slice| slice.try_into().ok())
        .ok_or_else(|| InstallError::failed("The uv zip is truncated."))?;
    Ok(u16::from_le_bytes(raw))
}

fn zip_u32<S: EngineSpec>(bytes: &[u8], offset: usize) -> Result<u32, InstallError> {
    let raw: [u8; 4] = bytes
        .get(offset..offset + 4)
        .and_then(|slice| slice.try_into().ok())
        .ok_or_else(|| InstallError::failed("The uv zip is truncated."))?;
    Ok(u32::from_le_bytes(raw))
}

#[cfg(unix)]
fn make_executable<S: EngineSpec>(path: &Path) -> Result<(), InstallError> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path).map_err(S::failed_io)?.permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).map_err(S::failed_io)
}

#[cfg(not(unix))]
fn make_executable<S: EngineSpec>(_path: &Path) -> Result<(), InstallError> {
    Ok(())
}

fn directory_size(root: &Path) -> std::io::Result<u64> {
    let mut total = 0_u64;
    let mut pending = vec![root.to_path_buf()];
    while let Some(path) = pending.pop() {
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let metadata = entry.metadata()?;
            if metadata.is_dir() {
                pending.push(entry.path());
            } else if metadata.is_file() {
                total = total.saturating_add(metadata.len());
            }
        }
    }
    Ok(total)
}

struct PartialGuard {
    path: PathBuf,
    committed: bool,
}

impl PartialGuard {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            committed: false,
        }
    }

    fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for PartialGuard {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
