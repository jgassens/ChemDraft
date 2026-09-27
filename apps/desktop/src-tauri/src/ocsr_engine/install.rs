use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};

use super::pins;
use super::platform::{self, EnginePlatform};
use super::progress::{self, GrowthEstimator};
use super::receipt::{read_current_receipt, write_receipt, InstallReceipt};
use super::{InstallError, InstallErrorCode, InstallPhase, InstallProgress};

pub const ENGINE_DIR: &str = "ocsr-engine";
pub const PARTIAL_DIR: &str = "ocsr-engine.partial";
/// A working install set aside while its replacement is swapped in; restored if the swap fails.
pub const PREVIOUS_DIR: &str = "ocsr-engine.previous";
/// Name prefix of a tree renamed out of the way and waiting to be deleted (see [`retire_tree`]).
pub const DISCARD_PREFIX: &str = "ocsr-engine.discard-";
pub const RECEIPT_FILE: &str = "install.json";
pub const REQUIREMENTS_FILE: &str = "requirements.txt";

#[derive(Debug, Clone)]
pub struct InstallPaths {
    pub app_data: PathBuf,
    pub requirements: PathBuf,
}

impl InstallPaths {
    pub fn final_dir(&self) -> PathBuf {
        self.app_data.join(ENGINE_DIR)
    }

    pub fn partial_dir(&self) -> PathBuf {
        self.app_data.join(PARTIAL_DIR)
    }

    pub fn previous_dir(&self) -> PathBuf {
        self.app_data.join(PREVIOUS_DIR)
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

#[derive(Clone, Copy)]
pub enum RunStep {
    InstallPython,
    CreateVenv,
    InstallPackages,
    InstallMolScribe,
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

/// The uv child an install is running, if any, so app exit can kill it and everything it started
/// without waiting for the install thread to notice its cancel flag: a process that is exiting
/// never gets back to that thread, and an orphaned uv would keep writing gigabytes into the
/// staging tree after ChemDraft has quit.
#[derive(Default)]
pub struct RunningChild {
    pid: Mutex<Option<u32>>,
}

impl RunningChild {
    /// Kills the running child's whole process tree, if a child is running. Returns at once.
    pub fn kill_tree(&self) {
        if let Some(pid) = self.slot().take() {
            platform::kill_process_tree(pid);
        }
    }

    fn track(&self, child: &Child) {
        *self.slot() = Some(child.id());
    }

    /// `try_wait` under the slot's lock, clearing the slot once the child is reaped: `kill_tree`
    /// then never signals an id the system may already have handed to another process.
    fn try_wait(&self, child: &mut Child) -> io::Result<Option<ExitStatus>> {
        let mut slot = self.slot();
        let result = child.try_wait();
        if !matches!(result, Ok(None)) {
            *slot = None;
        }
        result
    }

    fn slot(&self) -> MutexGuard<'_, Option<u32>> {
        self.pid
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub struct SystemInstallIo {
    client: reqwest::blocking::Client,
    running: Arc<RunningChild>,
}

impl SystemInstallIo {
    pub fn new(running: Arc<RunningChild>) -> Result<Self, InstallError> {
        let mut io = Self::from_builder(reqwest::blocking::Client::builder())?;
        io.running = running;
        Ok(io)
    }

    fn from_builder(builder: reqwest::blocking::ClientBuilder) -> Result<Self, InstallError> {
        // The blocking client applies `timeout` to each wait (the request, then every body read),
        // not to the whole transfer, so this is a stall timeout: a 1.1 GB model on a slow link
        // still completes, while a dead connection fails — and a cancel is noticed — within a
        // minute.
        let client = builder
            .connect_timeout(Duration::from_secs(30))
            .timeout(Duration::from_secs(60))
            .user_agent("ChemDraft-OCSR-Installer/1")
            .build()
            .map_err(|error| {
                InstallError::network(format!("Could not prepare downloads: {error}"))
            })?;
        Ok(Self {
            client,
            running: Arc::default(),
        })
    }
}

/// Inherited variables that could redirect the pinned uv/pip/Python away from the reviewed
/// sources or into another environment. Every variable with one of these prefixes is removed.
const SCRUBBED_ENV_PREFIXES: [&str; 5] = ["UV_", "PIP_", "PYTHON", "VIRTUAL_ENV", "CONDA"];

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

/// Bytes between progress events, so a 1.1 GB download sends ~1,000 events rather than ~9,000.
const PROGRESS_STRIDE_BYTES: u64 = 1024 * 1024;

impl InstallIo for SystemInstallIo {
    fn download(
        &self,
        spec: Download<'_>,
        destination: &Path,
        cancel: &AtomicBool,
        progress: &dyn ProgressReporter,
    ) -> Result<(), InstallError> {
        check_cancel(cancel)?;
        let mut response = self
            .client
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
        let mut file = File::create(destination).map_err(InstallError::failed_io)?;
        let mut digest = Sha256::new();
        let mut done = 0_u64;
        let mut reported = 0_u64;
        let mut buffer = vec![0_u8; 128 * 1024];
        loop {
            check_cancel(cancel)?;
            let read = response.read(&mut buffer).map_err(|error| {
                InstallError::network(format!("Download interrupted for {}: {error}", spec.url))
            })?;
            if read == 0 {
                break;
            }
            file.write_all(&buffer[..read])
                .map_err(InstallError::failed_io)?;
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
        file.sync_all().map_err(InstallError::failed_io)?;
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
            extract_uv_zip(archive, destination)
        } else {
            extract_uv_tar_gz(archive, destination)
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
        check_cancel(cancel)?;
        let mut command = Command::new(program);
        scrub_environment(&mut command);
        command
            .args(args)
            .envs(env.iter().cloned())
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        platform.configure_child(&mut command);
        let mut child = command.spawn().map_err(|error| {
            InstallError::failed(format!("Could not run {}: {error}", program.display()))
        })?;
        self.supervise(&mut child, program, cancel, watch, None)
    }
}

/// Runs a program and returns what it wrote to stdout: the seam the in-place receipt upgrade uses
/// to ask the installed uv and Python what they are.
pub trait ProbeIo: Send + Sync {
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

impl ProbeIo for SystemInstallIo {
    fn output(
        &self,
        platform: &dyn EnginePlatform,
        program: &Path,
        args: &[OsString],
        cancel: &AtomicBool,
    ) -> Result<String, InstallError> {
        check_cancel(cancel)?;
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
            .map(|reader| reader.join().unwrap_or_else(|_| Ok(Vec::new())))
            .transpose()
            .map_err(InstallError::failed_io)?
            .unwrap_or_default();
        outcome?;
        Ok(String::from_utf8_lossy(&text).into_owned())
    }
}

impl SystemInstallIo {
    /// Waits for `child`, killing its whole tree on cancel (or past `deadline`), and sampling a
    /// step's progress estimate while it runs.
    fn supervise(
        &self,
        child: &mut Child,
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
                self.running.kill_tree();
                let _ = child.kill();
                let _ = child.wait();
                if timed_out && !cancel.load(Ordering::SeqCst) {
                    return Err(InstallError::failed(format!(
                        "{} did not finish within {} seconds.",
                        program.display(),
                        PROBE_TIMEOUT.as_secs()
                    )));
                }
                return Err(InstallError::cancelled());
            }
            match self.running.try_wait(child) {
                Ok(Some(status)) => {
                    // Killed by app exit, which raises the cancel flag first.
                    if cancel.load(Ordering::SeqCst) {
                        return Err(InstallError::cancelled());
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
                    return Err(InstallError::failed(format!(
                        "Could not inspect {}: {error}",
                        program.display()
                    )))
                }
            }
        }
    }
}

pub fn install(
    paths: &InstallPaths,
    platform: &dyn EnginePlatform,
    io: &dyn InstallIo,
    cancel: &AtomicBool,
    progress: &dyn ProgressReporter,
    free_bytes: u64,
) -> Result<InstallReceipt, InstallError> {
    progress.report(message(
        InstallPhase::CheckingDisk,
        "Checking available disk space.",
    ));
    if !platform::has_required_disk(free_bytes) {
        return Err(InstallError {
            code: InstallErrorCode::InsufficientDisk,
            message: format!(
                "MolScribe needs at least {} bytes free; only {free_bytes} bytes are available.",
                pins::REQUIRED_DISK_BYTES
            ),
        });
    }
    check_cancel(cancel)?;
    fs::create_dir_all(&paths.app_data).map_err(InstallError::failed_io)?;
    let partial = paths.partial_dir();
    if partial.exists() {
        fs::remove_dir_all(&partial).map_err(InstallError::failed_io)?;
    }
    fs::create_dir(&partial).map_err(InstallError::failed_io)?;
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
    check_cancel(cancel)?;

    let python_install_dir = partial.join("python");
    let cache_dir = partial.join("download-cache");
    let python_bin_dir = partial.join("python-bin");
    let state_dir = partial.join("uv-state");
    let temp_dir = partial.join("temp");
    fs::create_dir_all(&temp_dir).map_err(InstallError::failed_io)?;
    let environment = vec![
        (
            OsString::from("UV_PYTHON_INSTALL_DIR"),
            python_install_dir.as_os_str().to_owned(),
        ),
        (
            OsString::from("UV_CACHE_DIR"),
            cache_dir.as_os_str().to_owned(),
        ),
        (
            OsString::from("UV_PYTHON_BIN_DIR"),
            python_bin_dir.as_os_str().to_owned(),
        ),
        (
            OsString::from("UV_STATE_DIR"),
            state_dir.as_os_str().to_owned(),
        ),
        (OsString::from("UV_NO_CONFIG"), OsString::from("1")),
        (OsString::from("TMPDIR"), temp_dir.as_os_str().to_owned()),
        (OsString::from("TMP"), temp_dir.as_os_str().to_owned()),
        (OsString::from("TEMP"), temp_dir.as_os_str().to_owned()),
    ];
    progress.report(message(
        InstallPhase::InstallingPython,
        "Installing the pinned managed Python runtime.",
    ));
    io.run(
        platform,
        RunStep::InstallPython,
        &uv,
        &os_args(["python", "install", pins::PYTHON_VERSION]),
        &environment,
        cancel,
        Some(RunWatch {
            estimator: GrowthEstimator::new(
                InstallPhase::InstallingPython,
                "Installing Python",
                vec![python_install_dir.clone(), cache_dir.clone()],
                progress::PYTHON_EXPECTED_GROWTH_BYTES,
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
            OsString::from(pins::PYTHON_VERSION),
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

    progress.report(message(
        InstallPhase::InstallingPackages,
        "Downloading the pinned MolScribe source.",
    ));
    // Verified before anything is installed: a tampered archive fails in seconds, not after the
    // PyTorch download. A requirements file cannot hash-lock a URL, so the check is done here.
    //
    // Its byte counts are withheld: the UI reads bytes in `installingPackages` as the fraction of
    // that whole ~1.2 GB phase, so a finished 5.7 MB download would put the overall bar near the
    // end of the phase, and the package estimate that follows would pull it back to the start.
    let molscribe_source = partial.join(pins::MOLSCRIBE_SOURCE_FILENAME);
    let without_byte_counts = |mut event: InstallProgress| {
        event.bytes_done = None;
        event.bytes_total = None;
        progress.report(event);
    };
    io.download(
        Download {
            url: pins::MOLSCRIBE_SOURCE_URL,
            sha256: pins::MOLSCRIBE_SOURCE_SHA256,
            size: Some(pins::MOLSCRIBE_SOURCE_BYTES),
            phase: InstallPhase::InstallingPackages,
        },
        &molscribe_source,
        cancel,
        &without_byte_counts,
    )?;

    progress.report(message(
        InstallPhase::InstallingPackages,
        "Installing pinned MolScribe dependencies.",
    ));
    let requirements = fs::read(&paths.requirements).map_err(InstallError::failed_io)?;
    let requirements_sha256 = pins::text_sha256(&requirements);
    if requirements_sha256 != pins::REQUIREMENTS_LOCK_SHA256 {
        return Err(InstallError::checksum(format!(
            "The bundled requirements lock does not match this build: expected SHA-256 {}, found {requirements_sha256}.",
            pins::REQUIREMENTS_LOCK_SHA256
        )));
    }
    let installed_requirements = partial.join(REQUIREMENTS_FILE);
    fs::write(&installed_requirements, &requirements).map_err(InstallError::failed_io)?;
    let venv_python = platform.venv_python(&partial).into_os_string();
    // Every package, transitive ones included, is pinned with hashes; `--require-hashes` makes uv
    // refuse anything unpinned, unhashed, or whose archive does not match.
    io.run(
        platform,
        RunStep::InstallPackages,
        &uv,
        &[
            OsString::from("pip"),
            OsString::from("install"),
            OsString::from("--python"),
            venv_python.clone(),
            OsString::from("--require-hashes"),
            OsString::from("--requirement"),
            installed_requirements.into_os_string(),
        ],
        &environment,
        cancel,
        Some(RunWatch {
            estimator: GrowthEstimator::new(
                InstallPhase::InstallingPackages,
                "Installing PyTorch and MolScribe",
                vec![cache_dir.clone(), partial.join("venv")],
                progress::PACKAGES_EXPECTED_GROWTH_BYTES,
            ),
            progress,
        }),
    )?;

    // The verified local archive, with nothing else: `--no-deps` because its dependencies are the
    // locked set above, `--no-index` so nothing is fetched, and `--no-build-isolation` so the sdist
    // builds with the venv's hash-locked setuptools instead of an unverified download.
    io.run(
        platform,
        RunStep::InstallMolScribe,
        &uv,
        &[
            OsString::from("pip"),
            OsString::from("install"),
            OsString::from("--python"),
            venv_python,
            OsString::from("--no-deps"),
            OsString::from("--no-index"),
            OsString::from("--no-build-isolation"),
            molscribe_source.clone().into_os_string(),
        ],
        &environment,
        cancel,
        None,
    )?;
    fs::remove_file(&molscribe_source).map_err(InstallError::failed_io)?;

    progress.report(message(
        InstallPhase::DownloadingModel,
        "Downloading the pinned MolScribe model.",
    ));
    let model = partial.join(pins::MODEL_FILENAME);
    io.download(
        Download {
            url: pins::MODEL_URL,
            sha256: pins::MODEL_SHA256,
            size: Some(pins::MODEL_BYTES),
            phase: InstallPhase::DownloadingModel,
        },
        &model,
        cancel,
        progress,
    )?;

    progress.report(message(
        InstallPhase::Verifying,
        "Verifying the installed engine.",
    ));
    check_cancel(cancel)?;
    fs::remove_file(&uv_archive).map_err(InstallError::failed_io)?;
    if cache_dir.exists() {
        fs::remove_dir_all(&cache_dir).map_err(InstallError::failed_io)?;
    }
    if temp_dir.exists() {
        fs::remove_dir_all(&temp_dir).map_err(InstallError::failed_io)?;
    }
    verify_layout(&partial, platform)?;
    // The receipt is NOT written here: it is the last thing written, into the final location, once
    // the engine has proved it works there (see `commit_staged_tree`).
    let disk_bytes = directory_size(&partial).map_err(InstallError::failed_io)?;
    let receipt = InstallReceipt::pinned(platform, disk_bytes);
    check_cancel(cancel)?;

    commit_staged_tree(paths, platform, io, cancel, &mut guard, &receipt)?;
    progress.report(message(InstallPhase::Done, "MolScribe is installed."));
    Ok(receipt)
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
/// 1. **`ocsr-engine/` only ever changes by whole-directory renames.** Nothing is ever deleted
///    inside it. A tree leaving that name is renamed to a fresh `ocsr-engine.discard-*` sibling
///    first ([`retire_tree`]) and deleted there, so an interrupted delete can only ever leave a
///    half-deleted *discard* directory, which the next launch sweeps.
/// 2. **The receipt is the last file written into an engine and leaves with the tree.** It is
///    written into `ocsr-engine/` only after the relocation, the layout check and the import
///    check have all passed there. So an `ocsr-engine/` holding a current receipt is a complete,
///    verified engine; one without a receipt is an interrupted commit. [`is_healthy`] and the
///    status command both require the receipt, so a partial engine is never reported installed.
///
/// If the process dies at any point, [`remove_stale_staging`] at the next launch finds one of: a
/// healthy `ocsr-engine/` (the set-aside tree is discarded); a missing or receipt-less
/// `ocsr-engine/` beside a healthy `ocsr-engine.previous/` (the previous engine is restored); or
/// a receipt-less `ocsr-engine/` alone (discarded, so status reads "not installed").
fn commit_staged_tree(
    paths: &InstallPaths,
    platform: &dyn EnginePlatform,
    io: &dyn InstallIo,
    cancel: &AtomicBool,
    guard: &mut PartialGuard,
    receipt: &InstallReceipt,
) -> Result<(), InstallError> {
    let partial = paths.partial_dir();
    let final_dir = paths.final_dir();
    let previous = paths.previous_dir();
    // uv may have resolved symlinked ancestors (e.g. /var → /private/var) when it wrote paths, so
    // both spellings of the staging prefix are rebased.
    let mut rebases = vec![(partial.clone(), final_dir.clone())];
    if let Ok(canonical_app_data) = fs::canonicalize(&paths.app_data) {
        let canonical = (
            canonical_app_data.join(PARTIAL_DIR),
            canonical_app_data.join(ENGINE_DIR),
        );
        if canonical != rebases[0] {
            rebases.push(canonical);
        }
    }

    // A set-aside tree from an interrupted swap may be the only working engine: put it back in
    // place first if `ocsr-engine/` is not, so it becomes the one this install falls back to.
    reconcile_previous(paths, platform);
    remove_tree(&paths.app_data, &previous).map_err(InstallError::failed_io)?;
    let had_previous = final_dir.exists();
    if had_previous {
        fs::rename(&final_dir, &previous).map_err(InstallError::failed_io)?;
    }
    if let Err(error) = fs::rename(&partial, &final_dir) {
        restore_previous(&final_dir, &previous, had_previous);
        return Err(InstallError::failed_io(error));
    }
    // From here the staging tree is gone; a failure retires the new tree instead.
    guard.commit();

    let outcome = relocate_staged_tree(&final_dir, &rebases)
        .map_err(|error| {
            InstallError::failed(format!(
                "Could not relocate the MolScribe environment: {error}"
            ))
        })
        .and_then(|()| verify_layout(&final_dir, platform))
        .and_then(|()| {
            io.run(
                platform,
                RunStep::VerifyEnvironment,
                &platform.venv_python(&final_dir),
                &os_args([
                    "-c",
                    "import cv2, molscribe, numpy, torch, torchvision; print(torch.__version__)",
                ]),
                &[],
                cancel,
                None,
            )
        })
        .and_then(|()| check_cancel(cancel))
        // Last: from this write on, `ocsr-engine/` is a verified install.
        .and_then(|()| write_receipt(&final_dir.join(RECEIPT_FILE), receipt));
    match outcome {
        Ok(()) => {
            if let Err(error) = remove_tree(&paths.app_data, &previous) {
                eprintln!(
                    "[chemdraft ocsr] could not set aside the replaced engine at {}: {error}",
                    previous.display()
                );
            }
            Ok(())
        }
        Err(error) => {
            // Rename the failed tree away before restoring, never delete it in place: a quit
            // mid-delete would leave a half-deleted tree where the engine belongs.
            match retire_tree(&paths.app_data, &final_dir) {
                Ok(discarded) => {
                    restore_previous(&final_dir, &previous, had_previous);
                    if let Some(discarded) = discarded {
                        delete_discarded(&discarded);
                    }
                }
                // The failed tree has no receipt, so it reads as not installed, and the next
                // launch restores the previous engine over it.
                Err(retire_error) => eprintln!(
                    "[chemdraft ocsr] could not set aside the failed engine at {}: {retire_error}",
                    final_dir.display()
                ),
            }
            Err(error)
        }
    }
}

fn restore_previous(final_dir: &Path, previous: &Path, had_previous: bool) {
    if had_previous && !final_dir.exists() {
        if let Err(error) = fs::rename(previous, final_dir) {
            eprintln!(
                "[chemdraft ocsr] could not restore the previous engine from {}: {error}",
                previous.display()
            );
        }
    }
}

/// A fresh, unused discard path beside the engine. It lives in `app_data` itself so renaming a
/// tree to it never crosses a filesystem, which is what makes the rename atomic.
fn discard_path(app_data: &Path) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    loop {
        let candidate = app_data.join(format!(
            "{DISCARD_PREFIX}{}-{}",
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
pub fn retire_tree(app_data: &Path, tree: &Path) -> io::Result<Option<PathBuf>> {
    if fs::symlink_metadata(tree).is_err() {
        return Ok(None);
    }
    let discarded = discard_path(app_data);
    fs::rename(tree, &discarded)?;
    Ok(Some(discarded))
}

/// Deletes a retired tree, receipt first. A failure is logged and left for the next launch's
/// sweep; the tree is already out of every place ChemDraft reads an engine from.
fn delete_discarded(discarded: &Path) -> bool {
    let _ = fs::remove_file(discarded.join(RECEIPT_FILE));
    match fs::remove_dir_all(discarded) {
        Ok(()) => true,
        Err(error) => {
            eprintln!(
                "[chemdraft ocsr] could not delete {} (the next launch retries): {error}",
                discarded.display()
            );
            false
        }
    }
}

/// Removes `tree` rename-first: it is renamed to a discard directory, then deleted there. An
/// error means the rename failed and `tree` is still whole in place.
pub fn remove_tree(app_data: &Path, tree: &Path) -> io::Result<()> {
    if let Some(discarded) = retire_tree(app_data, tree)? {
        delete_discarded(&discarded);
    }
    Ok(())
}

/// Every leftover discard directory in `app_data`.
fn discard_dirs(app_data: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(app_data) else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(DISCARD_PREFIX)
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
pub fn remove_engine_trees(paths: &InstallPaths) -> Result<(), (PathBuf, io::Error)> {
    for tree in [paths.partial_dir(), paths.previous_dir(), paths.final_dir()] {
        remove_tree(&paths.app_data, &tree).map_err(|error| (tree, error))?;
    }
    for discarded in discard_dirs(&paths.app_data) {
        delete_discarded(&discarded);
    }
    Ok(())
}

/// Settles `ocsr-engine.previous/` after an interrupted swap. Beside a healthy `ocsr-engine/` it
/// is discarded. Otherwise, if it is healthy itself, it is restored: the unhealthy or missing
/// `ocsr-engine/` is retired and the previous engine renamed back. If neither is healthy both are
/// left alone. Returns whether `ocsr-engine.previous/` was removed from disk.
fn reconcile_previous(paths: &InstallPaths, platform: &dyn EnginePlatform) -> bool {
    let final_dir = paths.final_dir();
    let previous = paths.previous_dir();
    if !previous.exists() {
        return false;
    }
    if is_healthy(&final_dir, platform) {
        return match retire_tree(&paths.app_data, &previous) {
            Ok(discarded) => {
                if let Some(discarded) = discarded {
                    delete_discarded(&discarded);
                }
                true
            }
            Err(error) => {
                eprintln!(
                    "[chemdraft ocsr] could not set aside the stale {}: {error}",
                    previous.display()
                );
                false
            }
        };
    }
    if !is_restorable(&previous, platform) {
        return false;
    }
    let discarded = match retire_tree(&paths.app_data, &final_dir) {
        Ok(discarded) => discarded,
        Err(error) => {
            eprintln!(
                "[chemdraft ocsr] could not set aside the unhealthy {}: {error}",
                final_dir.display()
            );
            return false;
        }
    };
    match fs::rename(&previous, &final_dir) {
        Ok(()) => eprintln!(
            "[chemdraft ocsr] restored the previous engine from {}",
            previous.display()
        ),
        Err(error) => eprintln!(
            "[chemdraft ocsr] could not restore the previous engine from {}: {error}",
            previous.display()
        ),
    }
    if let Some(discarded) = discarded {
        delete_discarded(&discarded);
    }
    // Restored, not removed: the engine is still on disk, now as `ocsr-engine/`.
    false
}

/// Rewrites every symlink under `root` whose target lies under an old prefix, and the `home`
/// entry of `venv/pyvenv.cfg`, so both point at the same place under the new prefix.
pub fn relocate_staged_tree(root: &Path, rebases: &[(PathBuf, PathBuf)]) -> io::Result<()> {
    let rebase = |target: &Path| {
        rebases
            .iter()
            .find_map(|(old, new)| target.strip_prefix(old).ok().map(|rest| new.join(rest)))
    };
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            let path = entry.path();
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                let target = fs::read_link(&path)?;
                if let Some(rebased) = rebase(&target) {
                    fs::remove_file(&path).or_else(|_| fs::remove_dir(&path))?;
                    create_symlink(&rebased, &path)?;
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
fn create_symlink(target: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

// Windows: uv links the managed Python's minor-version directory with a junction. std cannot
// create junctions, and symlink creation needs Developer Mode or elevation; this path is
// unverified until a real Windows install runs (see docs/architecture/ocsr-engine.md).
#[cfg(windows)]
fn create_symlink(target: &Path, link: &Path) -> io::Result<()> {
    if target.is_dir() {
        std::os::windows::fs::symlink_dir(target, link)
    } else {
        std::os::windows::fs::symlink_file(target, link)
    }
}

#[cfg(not(any(unix, windows)))]
fn create_symlink(_target: &Path, _link: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "symlinks are unsupported on this platform",
    ))
}

/// Whether `root` holds an install that matches this build's pins and layout, as
/// `ocsr_engine_status` would report `installed`. The receipt is required, and it is written last
/// on install and leaves first (with the whole tree, by rename) on teardown, so a tree that is
/// incomplete for either reason never counts (see `commit_staged_tree`).
pub fn is_healthy(root: &Path, platform: &dyn EnginePlatform) -> bool {
    read_current_receipt(&root.join(RECEIPT_FILE))
        .is_some_and(|receipt| receipt.matches_pins(platform))
        && verify_layout(root, platform).is_ok()
}

/// Whether a set-aside `ocsr-engine.previous/` is a verified engine worth renaming back.
///
/// [`is_healthy`] cannot answer this: the tree was relocated for `ocsr-engine/`, so its venv
/// interpreter is an absolute link into `ocsr-engine/` and resolves only once the tree is back
/// there (or, worse, resolves into whatever tree is there now). So the links are checked as
/// entries, not followed. The receipt carries the weight: it was written last, after the engine
/// verified in place, and nothing deletes inside a set-aside tree (every teardown renames it away
/// whole first), so a set-aside tree with a current receipt is a whole, verified engine.
fn is_restorable(root: &Path, platform: &dyn EnginePlatform) -> bool {
    let receipt_ok = read_current_receipt(&root.join(RECEIPT_FILE))
        .is_some_and(|receipt| receipt.matches_pins(platform));
    let model = root.join(pins::MODEL_FILENAME);
    receipt_ok
        && platform.uv_executable(root).is_file()
        && fs::symlink_metadata(platform.venv_python(root)).is_ok()
        && fs::metadata(&model).is_ok_and(|meta| meta.is_file() && meta.len() == pins::MODEL_BYTES)
}

/// Settles what an interrupted install, reinstall or uninstall left behind. The caller guarantees
/// no install is running. In order:
///
/// - `ocsr-engine.partial/` is removed (rename-first, like every teardown here);
/// - `ocsr-engine.previous/` is discarded beside a healthy `ocsr-engine/`, and restored in its
///   place when `ocsr-engine/` is missing or unhealthy and the previous engine is healthy; when
///   neither is healthy it is left for the user's next install or uninstall;
/// - an `ocsr-engine/` with no receipt at all is an interrupted commit (the receipt is written
///   last) and is discarded;
/// - every leftover `ocsr-engine.discard-*` directory is deleted.
///
/// Returns what was removed from disk.
pub fn remove_stale_staging(paths: &InstallPaths, platform: &dyn EnginePlatform) -> Vec<PathBuf> {
    let mut removed = Vec::new();
    let partial = paths.partial_dir();
    if partial.exists() {
        match remove_tree(&paths.app_data, &partial) {
            Ok(()) => removed.push(partial),
            Err(error) => eprintln!(
                "[chemdraft ocsr] could not remove the stale {}: {error}",
                partial.display()
            ),
        }
    }
    if reconcile_previous(paths, platform) {
        removed.push(paths.previous_dir());
    }
    let final_dir = paths.final_dir();
    if final_dir.is_dir() && fs::symlink_metadata(final_dir.join(RECEIPT_FILE)).is_err() {
        match remove_tree(&paths.app_data, &final_dir) {
            Ok(()) => removed.push(final_dir),
            Err(error) => eprintln!(
                "[chemdraft ocsr] could not set aside the incomplete {}: {error}",
                final_dir.display()
            ),
        }
    }
    for discarded in discard_dirs(&paths.app_data) {
        if delete_discarded(&discarded) {
            removed.push(discarded);
        }
    }
    removed
}

pub fn verify_layout(root: &Path, platform: &dyn EnginePlatform) -> Result<(), InstallError> {
    let uv = platform.uv_executable(root);
    let python = platform.venv_python(root);
    let model = root.join(pins::MODEL_FILENAME);
    for (label, path) in [("uv", uv), ("Python", python), ("model", model.clone())] {
        if !path.is_file() {
            return Err(InstallError::failed(format!(
                "The installed {label} file is missing at {}.",
                path.display()
            )));
        }
    }
    let size = fs::metadata(model).map_err(InstallError::failed_io)?.len();
    if size != pins::MODEL_BYTES {
        return Err(InstallError::checksum(format!(
            "The installed model is {size} bytes; expected {}.",
            pins::MODEL_BYTES
        )));
    }
    Ok(())
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), InstallError> {
    if cancel.load(Ordering::SeqCst) {
        Err(InstallError::cancelled())
    } else {
        Ok(())
    }
}

fn os_args<const N: usize>(args: [&str; N]) -> Vec<OsString> {
    args.into_iter().map(OsString::from).collect()
}

fn download_progress(phase: InstallPhase, done: u64, total: Option<u64>) -> InstallProgress {
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

fn message(phase: InstallPhase, message: &str) -> InstallProgress {
    InstallProgress {
        phase,
        message: message.to_string(),
        bytes_done: None,
        bytes_total: None,
        estimated: false,
    }
}

fn extract_uv_tar_gz(archive: &Path, destination: &Path) -> Result<(), InstallError> {
    let file = File::open(archive).map_err(InstallError::failed_io)?;
    let mut archive = GzDecoder::new(file);
    loop {
        let mut header = [0_u8; 512];
        match archive.read_exact(&mut header) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(error) => return Err(InstallError::failed_io(error)),
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
            let mut output = File::create(destination).map_err(InstallError::failed_io)?;
            let copied = io::copy(&mut Read::by_ref(&mut archive).take(size), &mut output)
                .map_err(InstallError::failed_io)?;
            if copied != size {
                return Err(InstallError::failed(
                    "The uv tar archive ended inside the executable.".to_string(),
                ));
            }
            output.sync_all().map_err(InstallError::failed_io)?;
            make_executable(destination)?;
            return Ok(());
        }
        let padded = size.saturating_add(511) / 512 * 512;
        let skipped = io::copy(
            &mut Read::by_ref(&mut archive).take(padded),
            &mut io::sink(),
        )
        .map_err(InstallError::failed_io)?;
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

fn extract_uv_zip(archive: &Path, destination: &Path) -> Result<(), InstallError> {
    let bytes = fs::read(archive).map_err(InstallError::failed_io)?;
    let eocd = bytes
        .windows(4)
        .rposition(|window| window == b"PK\x05\x06")
        .ok_or_else(|| InstallError::failed("The uv zip has no central directory."))?;
    let entries = zip_u16(&bytes, eocd + 10)? as usize;
    let mut cursor = zip_u32(&bytes, eocd + 16)? as usize;
    for _ in 0..entries {
        if bytes.get(cursor..cursor + 4) != Some(b"PK\x01\x02") {
            return Err(InstallError::failed(
                "The uv zip central directory is malformed.".to_string(),
            ));
        }
        let method = zip_u16(&bytes, cursor + 10)?;
        let compressed_size = zip_u32(&bytes, cursor + 20)? as usize;
        let uncompressed_size = zip_u32(&bytes, cursor + 24)? as usize;
        let name_len = zip_u16(&bytes, cursor + 28)? as usize;
        let extra_len = zip_u16(&bytes, cursor + 30)? as usize;
        let comment_len = zip_u16(&bytes, cursor + 32)? as usize;
        let local_offset = zip_u32(&bytes, cursor + 42)? as usize;
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
            let local_name = zip_u16(&bytes, local_offset + 26)? as usize;
            let local_extra = zip_u16(&bytes, local_offset + 28)? as usize;
            let data_start = local_offset
                .checked_add(30 + local_name + local_extra)
                .ok_or_else(|| InstallError::failed("The uv zip entry offset overflowed."))?;
            let data_end = data_start
                .checked_add(compressed_size)
                .ok_or_else(|| InstallError::failed("The uv zip entry size overflowed."))?;
            let compressed = bytes
                .get(data_start..data_end)
                .ok_or_else(|| InstallError::failed("The uv zip entry is truncated."))?;
            let mut output = File::create(destination).map_err(InstallError::failed_io)?;
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
            .map_err(InstallError::failed_io)?;
            if written != uncompressed_size as u64 {
                return Err(InstallError::failed(format!(
                    "The uv zip produced {written} bytes; expected {uncompressed_size}."
                )));
            }
            output.sync_all().map_err(InstallError::failed_io)?;
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

fn zip_u16(bytes: &[u8], offset: usize) -> Result<u16, InstallError> {
    let raw: [u8; 2] = bytes
        .get(offset..offset + 2)
        .and_then(|slice| slice.try_into().ok())
        .ok_or_else(|| InstallError::failed("The uv zip is truncated."))?;
    Ok(u16::from_le_bytes(raw))
}

fn zip_u32(bytes: &[u8], offset: usize) -> Result<u32, InstallError> {
    let raw: [u8; 4] = bytes
        .get(offset..offset + 4)
        .and_then(|slice| slice.try_into().ok())
        .ok_or_else(|| InstallError::failed("The uv zip is truncated."))?;
    Ok(u32::from_le_bytes(raw))
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), InstallError> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path)
        .map_err(InstallError::failed_io)?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).map_err(InstallError::failed_io)
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<(), InstallError> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ocsr_engine::platform::{MacArchitecture, MacPlatform};
    use std::net::TcpListener;
    use std::sync::Mutex;

    /// Stands in for the network and for uv. Each step is named; `fail_at` makes one step fail
    /// with a chosen code (a `Cancelled` failure also raises the cancel flag, as a user would).
    struct FakeIo {
        steps: Mutex<Vec<&'static str>>,
        /// Each child process's step name and arguments, in order.
        runs: Mutex<Vec<(&'static str, Vec<OsString>)>>,
        /// Each download's step name and pinned SHA-256/size, in order.
        downloads: Mutex<Vec<(&'static str, String, Option<u64>)>>,
        fail_at: Option<(&'static str, InstallErrorCode)>,
    }

    impl FakeIo {
        fn new(fail_at: Option<(&'static str, InstallErrorCode)>) -> Self {
            Self {
                steps: Mutex::new(Vec::new()),
                runs: Mutex::new(Vec::new()),
                downloads: Mutex::new(Vec::new()),
                fail_at,
            }
        }

        fn args_of(&self, step: &str) -> Vec<String> {
            self.runs
                .lock()
                .expect("runs")
                .iter()
                .find(|(name, _)| *name == step)
                .map(|(_, args)| {
                    args.iter()
                        .map(|arg| arg.to_string_lossy().into_owned())
                        .collect()
                })
                .unwrap_or_else(|| panic!("no {step} run"))
        }

        fn step(&self, name: &'static str, cancel: &AtomicBool) -> Result<(), InstallError> {
            self.steps.lock().expect("steps").push(name);
            match self.fail_at {
                Some((wanted, code)) if wanted == name => {
                    if code == InstallErrorCode::Cancelled {
                        cancel.store(true, Ordering::SeqCst);
                    }
                    Err(InstallError {
                        code,
                        message: format!("fake failure at {name}"),
                    })
                }
                _ => Ok(()),
            }
        }
    }

    impl InstallIo for FakeIo {
        fn download(
            &self,
            spec: Download<'_>,
            destination: &Path,
            cancel: &AtomicBool,
            progress: &dyn ProgressReporter,
        ) -> Result<(), InstallError> {
            // Mimic `SystemInstallIo`: byte progress part-way and at the end.
            let size = spec.size.unwrap_or(8);
            progress.report(download_progress(spec.phase, size / 2, Some(size)));
            progress.report(download_progress(spec.phase, size, Some(size)));
            let name = match spec.phase {
                InstallPhase::DownloadingUv => "uv",
                _ if spec.url == pins::MOLSCRIBE_SOURCE_URL => "molscribe-source",
                _ => "model",
            };
            self.downloads.lock().expect("downloads").push((
                name,
                spec.sha256.to_string(),
                spec.size,
            ));
            let file = File::create(destination).expect("fake download");
            file.set_len(spec.size.unwrap_or(8))
                .expect("fake download size");
            self.step(name, cancel)
        }

        fn extract_uv(
            &self,
            _platform: &dyn EnginePlatform,
            _archive: &Path,
            destination: &Path,
        ) -> Result<(), InstallError> {
            File::create(destination).expect("fake uv");
            Ok(())
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
            let name = match step {
                RunStep::InstallPython => "python",
                RunStep::CreateVenv => "venv",
                RunStep::InstallPackages => "packages",
                RunStep::InstallMolScribe => "molscribe",
                RunStep::VerifyEnvironment => "verify",
            };
            self.runs.lock().expect("runs").push((name, args.to_vec()));
            if matches!(step, RunStep::CreateVenv) {
                // Mimic uv: the venv's interpreter is an ABSOLUTE link into the managed Python,
                // and pyvenv.cfg names the managed Python's bin directory absolutely.
                let venv = Path::new(&args[1]);
                let root = venv.parent().expect("venv parent");
                let base_bin = root.join("python").join("cpython-3.10").join("bin");
                fs::create_dir_all(&base_bin).expect("base python dir");
                fs::write(base_bin.join("python3.10"), b"interpreter").expect("base python");
                let python = platform.venv_python(root);
                fs::create_dir_all(python.parent().expect("venv bin")).expect("venv bin dir");
                #[cfg(unix)]
                std::os::unix::fs::symlink(base_bin.join("python3.10"), &python)
                    .expect("venv link");
                #[cfg(not(unix))]
                fs::write(&python, b"launcher").expect("venv launcher");
                fs::write(
                    venv.join("pyvenv.cfg"),
                    format!("home = {}\nrelocatable = true\n", base_bin.display()),
                )
                .expect("pyvenv.cfg");
            }
            if matches!(step, RunStep::VerifyEnvironment) && !program.is_file() {
                return Err(InstallError::failed(format!(
                    "{} does not resolve to an interpreter",
                    program.display()
                )));
            }
            // Mimic `SystemInstallIo`: one running estimate, then 100% on a successful exit.
            let mut watch = watch;
            if let Some(watch) = watch.as_mut() {
                watch.progress.report(watch.estimator.sample());
            }
            self.step(name, cancel)?;
            if let Some(watch) = watch.as_mut() {
                watch.progress.report(watch.estimator.finished());
            }
            Ok(())
        }
    }

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "chemdraft-ocsr-{label}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(&root).expect("test root");
        root
    }

    fn test_paths(root: &Path) -> InstallPaths {
        let requirements = root.join("source-requirements.txt");
        fs::write(&requirements, BUNDLED_REQUIREMENTS).expect("requirements");
        InstallPaths {
            app_data: root.to_path_buf(),
            requirements,
        }
    }

    fn run_install(paths: &InstallPaths, io: &FakeIo) -> Result<InstallReceipt, InstallError> {
        install(
            paths,
            &MacPlatform::new(MacArchitecture::Aarch64),
            io,
            &AtomicBool::new(false),
            &|_| {},
            pins::REQUIRED_DISK_BYTES,
        )
    }

    fn assert_no_staging(paths: &InstallPaths) {
        assert!(!paths.partial_dir().exists(), "partial dir left behind");
        assert!(!paths.previous_dir().exists(), "previous dir left behind");
    }

    #[test]
    fn install_state_machine_completes_in_order_and_writes_receipt() {
        let root = temp_root("complete");
        let paths = test_paths(&root);
        let platform = MacPlatform::new(MacArchitecture::Aarch64);
        let io = FakeIo::new(None);
        let reported = Mutex::new(Vec::<InstallProgress>::new());
        let reporter =
            |progress: InstallProgress| reported.lock().expect("reported").push(progress);
        let receipt = install(
            &paths,
            &platform,
            &io,
            &AtomicBool::new(false),
            &reporter,
            pins::REQUIRED_DISK_BYTES,
        )
        .expect("fake install");
        assert_eq!(
            *io.steps.lock().expect("steps"),
            [
                "uv",
                "python",
                "venv",
                "molscribe-source",
                "packages",
                "molscribe",
                "model",
                "verify"
            ]
        );
        let events = reported.lock().expect("reported");
        let mut phases: Vec<InstallPhase> = events.iter().map(|event| event.phase).collect();
        phases.dedup();
        // The two uv steps report estimated byte progress, ending at 100% when uv exits.
        for phase in [
            InstallPhase::InstallingPython,
            InstallPhase::InstallingPackages,
        ] {
            let estimates: Vec<_> = events
                .iter()
                .filter(|event| event.phase == phase && event.estimated)
                .collect();
            assert!(estimates.len() >= 2, "{phase:?} sent no estimate");
            let last = estimates.last().expect("estimate");
            assert!(last.bytes_total.is_some_and(|total| total > 0));
            assert_eq!(last.bytes_done, last.bytes_total);
        }
        assert_eq!(
            phases,
            [
                InstallPhase::CheckingDisk,
                InstallPhase::DownloadingUv,
                InstallPhase::InstallingPython,
                InstallPhase::InstallingPackages,
                InstallPhase::DownloadingModel,
                InstallPhase::Verifying,
                InstallPhase::Done,
            ]
        );
        assert!(paths.final_dir().is_dir());
        assert_no_staging(&paths);
        assert!(receipt.matches_pins(&platform));
        let round_trip =
            read_current_receipt(&paths.final_dir().join(RECEIPT_FILE)).expect("receipt");
        assert_eq!(receipt, round_trip);
        assert!(receipt.disk_bytes >= pins::MODEL_BYTES);
        let _ = fs::remove_dir_all(root);
    }

    /// The overall bar in structureRecognitionInstallProgress.ts: each phase weighted by roughly
    /// what it moves, and a phase's byte counts read as the fraction of that phase. A step without
    /// byte counts is taken at its start, since a scripted install spends no time in it.
    fn overall_fraction(event: &InstallProgress) -> f64 {
        const WEIGHTS: [(InstallPhase, f64); 6] = [
            (InstallPhase::CheckingDisk, 0.0),
            (InstallPhase::DownloadingUv, 20e6),
            (InstallPhase::InstallingPython, 40e6),
            (InstallPhase::InstallingPackages, 1.2e9),
            (InstallPhase::DownloadingModel, 1.13e9),
            (InstallPhase::Verifying, 10e6),
        ];
        if event.phase == InstallPhase::Done {
            return 1.0;
        }
        let index = WEIGHTS
            .iter()
            .position(|(phase, _)| *phase == event.phase)
            .expect("weighted phase");
        let total: f64 = WEIGHTS.iter().map(|(_, weight)| weight).sum();
        let before: f64 = WEIGHTS[..index].iter().map(|(_, weight)| weight).sum();
        let fraction = match (event.bytes_done, event.bytes_total) {
            (Some(done), Some(total)) if total > 0 => (done as f64 / total as f64).clamp(0.0, 1.0),
            _ => 0.0,
        };
        (before + WEIGHTS[index].1 * fraction) / total
    }

    #[test]
    fn overall_install_progress_never_moves_backwards() {
        let root = temp_root("monotonic");
        let paths = test_paths(&root);
        let reported = Mutex::new(Vec::<InstallProgress>::new());
        let reporter =
            |progress: InstallProgress| reported.lock().expect("reported").push(progress);
        install(
            &paths,
            &MacPlatform::new(MacArchitecture::Aarch64),
            &FakeIo::new(None),
            &AtomicBool::new(false),
            &reporter,
            pins::REQUIRED_DISK_BYTES,
        )
        .expect("fake install");
        let events = reported.lock().expect("reported");
        let overall: Vec<f64> = events.iter().map(overall_fraction).collect();
        for (index, pair) in overall.windows(2).enumerate() {
            assert!(
                pair[1] >= pair[0],
                "overall progress fell from {:.3} to {:.3} at {:?} then {:?}",
                pair[0],
                pair[1],
                events[index],
                events[index + 1]
            );
        }
        assert_eq!(overall.last().copied(), Some(1.0));
        // The source download still reports, as text, without the byte counts that moved the bar.
        assert!(events
            .iter()
            .any(|event| event.phase == InstallPhase::InstallingPackages
                && event.bytes_total.is_none()
                && event.message.starts_with("Downloaded")));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stale_staging_is_removed_and_a_set_aside_engine_only_beside_a_healthy_one() {
        let root = temp_root("stale");
        let paths = test_paths(&root);
        let platform = MacPlatform::new(MacArchitecture::Aarch64);
        let stage = |dir: &Path| {
            fs::create_dir_all(dir.join("venv")).expect("stale dir");
            fs::write(dir.join("venv").join("leftover"), b"x").expect("stale file");
        };

        // No working install: the staging tree goes, the set-aside tree may be the only engine.
        stage(&paths.partial_dir());
        stage(&paths.previous_dir());
        assert_eq!(
            remove_stale_staging(&paths, &platform),
            vec![paths.partial_dir()]
        );
        assert!(!paths.partial_dir().exists());
        assert!(paths.previous_dir().exists());

        // Beside a healthy install, both go and the install is untouched.
        run_install(&paths, &FakeIo::new(None)).expect("fake install");
        stage(&paths.partial_dir());
        stage(&paths.previous_dir());
        assert_eq!(
            remove_stale_staging(&paths, &platform),
            vec![paths.partial_dir(), paths.previous_dir()]
        );
        assert_no_staging(&paths);
        assert!(is_healthy(&paths.final_dir(), &platform));
        assert!(remove_stale_staging(&paths, &platform).is_empty());
        let _ = fs::remove_dir_all(root);
    }

    /// App exit kills the uv child from another thread through `RunningChild`, and must take down
    /// what uv started too; a grandchild left running would keep writing into the staging tree.
    #[cfg(unix)]
    #[test]
    fn killing_the_running_child_takes_down_its_whole_process_tree() {
        let root = temp_root("kill-tree");
        let grandchild_file = root.join("grandchild.pid");
        let running = Arc::new(RunningChild::default());
        let mut io = loopback_io();
        io.running = running.clone();
        let script = format!("sleep 30 & echo $! > '{}'; wait", grandchild_file.display());
        let started = Instant::now();
        let worker = std::thread::spawn(move || {
            io.run(
                &MacPlatform::new(MacArchitecture::Aarch64),
                RunStep::InstallPackages,
                Path::new("/bin/sh"),
                &[OsString::from("-c"), OsString::from(script)],
                &[],
                &AtomicBool::new(false),
                None,
            )
        });
        let grandchild = loop {
            if let Some(pid) = fs::read_to_string(&grandchild_file)
                .ok()
                .and_then(|text| text.trim().parse::<libc::pid_t>().ok())
            {
                break pid;
            }
            assert!(started.elapsed() < Duration::from_secs(10), "no grandchild");
            std::thread::sleep(Duration::from_millis(20));
        };
        running.kill_tree();
        let error = worker.join().expect("run thread").expect_err("killed");
        assert_eq!(error.code, InstallErrorCode::Failed);
        assert!(started.elapsed() < Duration::from_secs(10));
        // SAFETY: signal 0 only checks whether the process still exists.
        let alive = || unsafe { libc::kill(grandchild, 0) } == 0;
        let deadline = Instant::now() + Duration::from_secs(5);
        while alive() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!alive(), "uv's own child survived the kill");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn renamed_install_is_relocated_so_the_venv_resolves() {
        let root = temp_root("relocate");
        let paths = test_paths(&root);
        run_install(&paths, &FakeIo::new(None)).expect("fake install");
        let final_dir = paths.final_dir();
        let python = final_dir.join("venv/bin/python");
        assert!(
            python.is_file(),
            "venv python must resolve after the rename"
        );
        #[cfg(unix)]
        assert!(fs::read_link(&python)
            .expect("venv link")
            .starts_with(&final_dir));
        let config = fs::read_to_string(final_dir.join("venv/pyvenv.cfg")).expect("pyvenv.cfg");
        assert!(config.contains(final_dir.join("python").to_string_lossy().as_ref()));
        assert!(!config.contains(PARTIAL_DIR));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cancellation_at_any_step_removes_the_partial_directory() {
        for step in [
            "uv",
            "python",
            "venv",
            "molscribe-source",
            "packages",
            "molscribe",
            "model",
        ] {
            let root = temp_root("cancel");
            let paths = test_paths(&root);
            let error = run_install(
                &paths,
                &FakeIo::new(Some((step, InstallErrorCode::Cancelled))),
            )
            .expect_err("cancelled install");
            assert_eq!(error.code, InstallErrorCode::Cancelled, "step {step}");
            assert_no_staging(&paths);
            assert!(!paths.final_dir().exists(), "step {step}");
            let _ = fs::remove_dir_all(root);
        }
    }

    #[test]
    fn a_checksum_mismatch_fails_the_install_and_cleans_up() {
        let root = temp_root("checksum");
        let paths = test_paths(&root);
        let error = run_install(
            &paths,
            &FakeIo::new(Some(("model", InstallErrorCode::ChecksumMismatch))),
        )
        .expect_err("tampered model");
        assert_eq!(error.code, InstallErrorCode::ChecksumMismatch);
        assert_no_staging(&paths);
        assert!(!paths.final_dir().exists());
        let _ = fs::remove_dir_all(root);
    }

    const BUNDLED_REQUIREMENTS: &str = include_str!("../../resources/ocsr/requirements.txt");

    #[test]
    fn packages_install_hash_locked_and_molscribe_from_the_verified_archive_alone() {
        let root = temp_root("locked");
        let paths = test_paths(&root);
        let io = FakeIo::new(None);
        run_install(&paths, &io).expect("fake install");

        let downloads = io.downloads.lock().expect("downloads").clone();
        assert!(downloads.contains(&(
            "molscribe-source",
            pins::MOLSCRIBE_SOURCE_SHA256.to_string(),
            Some(pins::MOLSCRIBE_SOURCE_BYTES)
        )));

        let packages = io.args_of("packages");
        assert!(packages.iter().any(|arg| arg == "--require-hashes"));
        let requirement = packages
            .iter()
            .position(|arg| arg == "--requirement")
            .map(|index| &packages[index + 1])
            .expect("requirements argument");
        assert!(requirement.ends_with(REQUIREMENTS_FILE));

        let molscribe = io.args_of("molscribe");
        for flag in ["--no-deps", "--no-index", "--no-build-isolation"] {
            assert!(molscribe.iter().any(|arg| arg == flag), "missing {flag}");
        }
        // The only thing installed is the local archive Rust verified; never the URL.
        assert!(molscribe
            .last()
            .expect("archive argument")
            .ends_with(pins::MOLSCRIBE_SOURCE_FILENAME));
        assert!(!molscribe.iter().any(|arg| arg.contains("://")));
        assert!(!paths
            .final_dir()
            .join(pins::MOLSCRIBE_SOURCE_FILENAME)
            .exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_tampered_molscribe_archive_stops_the_install_before_any_package_is_installed() {
        let root = temp_root("tarball");
        let paths = test_paths(&root);
        let io = FakeIo::new(Some((
            "molscribe-source",
            InstallErrorCode::ChecksumMismatch,
        )));
        let error = run_install(&paths, &io).expect_err("tampered archive");
        assert_eq!(error.code, InstallErrorCode::ChecksumMismatch);
        assert!(!io.steps.lock().expect("steps").contains(&"packages"));
        assert_no_staging(&paths);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_requirements_file_that_is_not_the_reviewed_lock_is_refused() {
        let root = temp_root("lock");
        let paths = test_paths(&root);
        fs::write(
            &paths.requirements,
            BUNDLED_REQUIREMENTS.replace("torch==2.14.0", "torch==2.14.1"),
        )
        .expect("edited lock");
        let io = FakeIo::new(None);
        let error = run_install(&paths, &io).expect_err("edited lock");
        assert_eq!(error.code, InstallErrorCode::ChecksumMismatch);
        assert!(!io.steps.lock().expect("steps").contains(&"packages"));
        assert_no_staging(&paths);

        // Line-ending style alone is not a change: a CRLF checkout of the same lock installs.
        let crlf_root = temp_root("lock-crlf");
        let crlf = test_paths(&crlf_root);
        fs::write(
            &crlf.requirements,
            BUNDLED_REQUIREMENTS.replace('\n', "\r\n"),
        )
        .expect("crlf lock");
        run_install(&crlf, &FakeIo::new(None)).expect("crlf lock installs");
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(crlf_root);
    }

    #[test]
    fn a_failed_reinstall_restores_the_previous_engine() {
        let root = temp_root("restore");
        let paths = test_paths(&root);
        fs::create_dir_all(paths.final_dir()).expect("existing engine");
        fs::write(paths.final_dir().join("marker"), b"old").expect("marker");
        let error = run_install(
            &paths,
            &FakeIo::new(Some(("verify", InstallErrorCode::Failed))),
        )
        .expect_err("verification fails after the swap");
        assert_eq!(error.code, InstallErrorCode::Failed);
        assert_eq!(
            fs::read(paths.final_dir().join("marker")).expect("previous engine restored"),
            b"old"
        );
        assert_no_staging(&paths);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_successful_reinstall_replaces_the_previous_engine() {
        let root = temp_root("replace");
        let paths = test_paths(&root);
        fs::create_dir_all(paths.final_dir()).expect("existing engine");
        fs::write(paths.final_dir().join("marker"), b"old").expect("marker");
        run_install(&paths, &FakeIo::new(None)).expect("reinstall");
        assert!(!paths.final_dir().join("marker").exists());
        assert!(paths.final_dir().join(RECEIPT_FILE).is_file());
        assert_no_staging(&paths);
        let _ = fs::remove_dir_all(root);
    }

    fn assert_no_discards(paths: &InstallPaths) {
        assert_eq!(
            discard_dirs(&paths.app_data),
            Vec::<PathBuf>::new(),
            "discard dir left behind"
        );
    }

    #[test]
    fn a_cancel_during_verification_after_the_swap_restores_the_healthy_previous_engine() {
        let root = temp_root("cancel-verify");
        let paths = test_paths(&root);
        let platform = MacPlatform::new(MacArchitecture::Aarch64);
        run_install(&paths, &FakeIo::new(None)).expect("first install");
        fs::write(paths.final_dir().join("marker"), b"old").expect("marker");

        let error = run_install(
            &paths,
            &FakeIo::new(Some(("verify", InstallErrorCode::Cancelled))),
        )
        .expect_err("quit during step 9");
        assert_eq!(error.code, InstallErrorCode::Cancelled);
        assert_eq!(
            fs::read(paths.final_dir().join("marker")).expect("previous engine restored"),
            b"old"
        );
        assert!(is_healthy(&paths.final_dir(), &platform));
        assert_no_staging(&paths);
        assert_no_discards(&paths);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn the_receipt_is_written_only_after_the_engine_verifies_in_place() {
        let root = temp_root("receipt-last");
        let paths = test_paths(&root);
        let error = run_install(
            &paths,
            &FakeIo::new(Some(("verify", InstallErrorCode::Failed))),
        )
        .expect_err("verification fails after the swap");
        assert_eq!(error.code, InstallErrorCode::Failed);
        // No previous engine to restore: the failed tree is retired whole, receipt and all.
        assert!(!paths.final_dir().exists());
        assert_no_staging(&paths);
        assert_no_discards(&paths);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_leftover_discard_dir_is_swept_at_startup() {
        let root = temp_root("discard-sweep");
        let paths = test_paths(&root);
        let platform = MacPlatform::new(MacArchitecture::Aarch64);
        run_install(&paths, &FakeIo::new(None)).expect("install");
        // A delete interrupted by a quit: the tree was renamed away first, so only the discard
        // directory is half-deleted, and the live engine is untouched.
        let discarded = root.join(format!("{DISCARD_PREFIX}1-0"));
        fs::create_dir_all(discarded.join("venv").join("lib")).expect("discard dir");
        fs::write(discarded.join("venv").join("lib").join("left"), b"x").expect("discard file");

        assert_eq!(
            remove_stale_staging(&paths, &platform),
            vec![discarded.clone()]
        );
        assert!(!discarded.exists());
        assert!(is_healthy(&paths.final_dir(), &platform));
        assert!(remove_stale_staging(&paths, &platform).is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_missing_final_engine_beside_a_healthy_previous_is_restored_at_startup() {
        let root = temp_root("restore-missing");
        let paths = test_paths(&root);
        let platform = MacPlatform::new(MacArchitecture::Aarch64);
        run_install(&paths, &FakeIo::new(None)).expect("install");
        // A quit between setting the old engine aside and renaming the new one into place.
        fs::rename(paths.final_dir(), paths.previous_dir()).expect("set aside");

        assert!(remove_stale_staging(&paths, &platform).is_empty());
        assert!(is_healthy(&paths.final_dir(), &platform));
        assert_no_staging(&paths);
        assert_no_discards(&paths);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn an_unhealthy_final_engine_beside_a_healthy_previous_is_replaced_by_it_at_startup() {
        let root = temp_root("restore-unhealthy");
        let paths = test_paths(&root);
        let platform = MacPlatform::new(MacArchitecture::Aarch64);
        run_install(&paths, &FakeIo::new(None)).expect("install");
        fs::write(paths.final_dir().join("marker"), b"old").expect("marker");
        fs::rename(paths.final_dir(), paths.previous_dir()).expect("set aside");
        // A quit after the new tree was renamed in but before it verified: no receipt yet, and
        // everything else in place, as the layout check sees it.
        let fresh = paths.final_dir();
        for file in [platform.uv_executable(&fresh), platform.venv_python(&fresh)] {
            fs::create_dir_all(file.parent().expect("parent")).expect("dir");
            fs::write(file, b"x").expect("file");
        }
        File::create(fresh.join(pins::MODEL_FILENAME))
            .and_then(|model| model.set_len(pins::MODEL_BYTES))
            .expect("model");
        assert!(verify_layout(&paths.final_dir(), &platform).is_ok());
        assert!(!is_healthy(&paths.final_dir(), &platform));

        assert!(remove_stale_staging(&paths, &platform).is_empty());
        assert_eq!(
            fs::read(paths.final_dir().join("marker")).expect("previous engine restored"),
            b"old"
        );
        assert!(is_healthy(&paths.final_dir(), &platform));
        assert_no_staging(&paths);
        assert_no_discards(&paths);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_final_engine_without_a_receipt_is_an_interrupted_commit_and_is_discarded() {
        let root = temp_root("unreceipted");
        let paths = test_paths(&root);
        let platform = MacPlatform::new(MacArchitecture::Aarch64);
        run_install(&paths, &FakeIo::new(None)).expect("install");
        fs::remove_file(paths.final_dir().join(RECEIPT_FILE)).expect("unreceipted");

        assert_eq!(
            remove_stale_staging(&paths, &platform),
            vec![paths.final_dir()]
        );
        assert!(!paths.final_dir().exists());
        assert_no_discards(&paths);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn uninstall_removes_every_tree_rename_first_and_leaves_no_engine_behind() {
        let root = temp_root("uninstall");
        let paths = test_paths(&root);
        let platform = MacPlatform::new(MacArchitecture::Aarch64);
        run_install(&paths, &FakeIo::new(None)).expect("install");
        fs::create_dir_all(paths.previous_dir().join("venv")).expect("previous");
        fs::create_dir_all(paths.partial_dir().join("venv")).expect("partial");
        let stale = root.join(format!("{DISCARD_PREFIX}1-0"));
        fs::create_dir_all(&stale).expect("stale discard");

        remove_engine_trees(&paths).expect("uninstall");
        assert!(!paths.final_dir().exists());
        assert!(!is_healthy(&paths.final_dir(), &platform));
        assert_no_staging(&paths);
        assert_no_discards(&paths);
        // Nothing but the test's own requirements file is left in the app data directory.
        let left: Vec<_> = fs::read_dir(&root)
            .expect("root")
            .map(|entry| entry.expect("entry").file_name())
            .collect();
        assert_eq!(left, vec![OsString::from("source-requirements.txt")]);
        // Idempotent: a second uninstall finds nothing to do.
        remove_engine_trees(&paths).expect("second uninstall");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn retiring_a_tree_moves_it_whole_to_a_unique_sibling() {
        let root = temp_root("retire");
        let tree = root.join(ENGINE_DIR);
        fs::create_dir_all(tree.join("venv")).expect("tree");
        fs::write(tree.join(RECEIPT_FILE), b"{}").expect("receipt");
        let first = retire_tree(&root, &tree).expect("retire").expect("moved");
        assert!(!tree.exists());
        assert_eq!(first.parent(), Some(root.as_path()));
        assert!(first.join(RECEIPT_FILE).is_file() && first.join("venv").is_dir());
        fs::create_dir_all(&tree).expect("second tree");
        let second = retire_tree(&root, &tree).expect("retire").expect("moved");
        assert_ne!(first, second);
        assert_eq!(retire_tree(&root, &tree).expect("absent"), None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn insufficient_disk_never_creates_staging() {
        let root = temp_root("disk");
        let paths = test_paths(&root);
        let io = FakeIo::new(None);
        let error = install(
            &paths,
            &MacPlatform::new(MacArchitecture::Aarch64),
            &io,
            &AtomicBool::new(false),
            &|_| {},
            pins::REQUIRED_DISK_BYTES - 1,
        )
        .expect_err("insufficient disk");
        assert_eq!(error.code, InstallErrorCode::InsufficientDisk);
        assert!(io.steps.lock().expect("steps").is_empty());
        assert!(!paths.partial_dir().exists());
        let _ = fs::remove_dir_all(root);
    }

    fn tar_entry(name: &str, body: &[u8]) -> Vec<u8> {
        let mut header = [0_u8; 512];
        header[..name.len()].copy_from_slice(name.as_bytes());
        header[100..107].copy_from_slice(b"0000755");
        header[124..135].copy_from_slice(format!("{:011o}", body.len()).as_bytes());
        header[156] = b'0';
        let mut entry = header.to_vec();
        entry.extend_from_slice(body);
        entry.resize(entry.len().div_ceil(512) * 512, 0);
        entry
    }

    #[test]
    fn extracts_only_the_uv_executable_from_a_tar_gz() {
        let root = temp_root("tar");
        let mut tar = tar_entry("uv-aarch64-apple-darwin/uvx", b"not this one");
        tar.extend(tar_entry("uv-aarch64-apple-darwin/uv", b"uv binary"));
        tar.extend([0_u8; 1024]);
        let archive = root.join("uv.tar.gz");
        let mut encoder = flate2::write::GzEncoder::new(
            File::create(&archive).expect("archive"),
            flate2::Compression::fast(),
        );
        encoder.write_all(&tar).expect("gzip");
        encoder.finish().expect("gzip finish");
        let destination = root.join("uv");
        extract_uv_tar_gz(&archive, &destination).expect("extract");
        assert_eq!(fs::read(&destination).expect("uv"), b"uv binary");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&destination)
                .expect("mode")
                .permissions()
                .mode();
            assert_eq!(mode & 0o111, 0o111);
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_tar_without_uv_is_rejected() {
        let root = temp_root("tar-missing");
        let mut tar = tar_entry("readme", b"hello");
        tar.extend([0_u8; 1024]);
        let archive = root.join("uv.tar.gz");
        let mut encoder = flate2::write::GzEncoder::new(
            File::create(&archive).expect("archive"),
            flate2::Compression::fast(),
        );
        encoder.write_all(&tar).expect("gzip");
        encoder.finish().expect("gzip finish");
        assert!(extract_uv_tar_gz(&archive, &root.join("uv")).is_err());
        let _ = fs::remove_dir_all(root);
    }

    /// A minimal single-entry ZIP (stored or deflated), built by hand like uv's Windows asset.
    fn zip_with(name: &str, body: &[u8], deflate: bool) -> Vec<u8> {
        let data = if deflate {
            let mut encoder =
                flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
            encoder.write_all(body).expect("deflate");
            encoder.finish().expect("deflate finish")
        } else {
            body.to_vec()
        };
        let method: u16 = if deflate { 8 } else { 0 };
        let mut zip = Vec::new();
        zip.extend(b"PK\x03\x04");
        zip.extend([20, 0, 0, 0]);
        zip.extend(method.to_le_bytes());
        zip.extend([0_u8; 8]); // time, date, crc (unchecked by the extractor)
        zip.extend((data.len() as u32).to_le_bytes());
        zip.extend((body.len() as u32).to_le_bytes());
        zip.extend((name.len() as u16).to_le_bytes());
        zip.extend(0_u16.to_le_bytes());
        zip.extend(name.as_bytes());
        zip.extend(&data);
        let central = zip.len();
        zip.extend(b"PK\x01\x02");
        zip.extend([20, 0, 20, 0, 0, 0]);
        zip.extend(method.to_le_bytes());
        zip.extend([0_u8; 8]);
        zip.extend((data.len() as u32).to_le_bytes());
        zip.extend((body.len() as u32).to_le_bytes());
        zip.extend((name.len() as u16).to_le_bytes());
        zip.extend([0_u8; 12]); // extra len, comment len, disk, internal attrs, external attrs
        zip.extend(0_u32.to_le_bytes()); // local header offset
        zip.extend(name.as_bytes());
        let central_len = zip.len() - central;
        zip.extend(b"PK\x05\x06");
        zip.extend([0_u8; 4]);
        zip.extend(1_u16.to_le_bytes());
        zip.extend(1_u16.to_le_bytes());
        zip.extend((central_len as u32).to_le_bytes());
        zip.extend((central as u32).to_le_bytes());
        zip.extend(0_u16.to_le_bytes());
        zip
    }

    #[test]
    fn extracts_uv_exe_from_stored_and_deflated_zips() {
        let root = temp_root("zip");
        for deflate in [false, true] {
            let archive = root.join("uv.zip");
            fs::write(&archive, zip_with("uv.exe", b"windows uv", deflate)).expect("zip");
            let destination = root.join("uv.exe");
            extract_uv_zip(&archive, &destination).expect("extract");
            assert_eq!(fs::read(&destination).expect("uv.exe"), b"windows uv");
        }
        fs::write(root.join("other.zip"), zip_with("uvx.exe", b"x", false)).expect("zip");
        assert!(extract_uv_zip(&root.join("other.zip"), &root.join("uv.exe")).is_err());
        let _ = fs::remove_dir_all(root);
    }

    /// Serves `body` once per connection on loopback; no external network is touched.
    fn serve_once(body: Vec<u8>, connections: usize) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let address = listener.local_addr().expect("address");
        std::thread::spawn(move || {
            for stream in listener.incoming().take(connections) {
                let mut stream = stream.expect("connection");
                let mut request = Vec::new();
                let mut byte = [0_u8; 1];
                while !request.ends_with(b"\r\n\r\n") {
                    if stream.read(&mut byte).unwrap_or(0) == 0 {
                        break;
                    }
                    request.push(byte[0]);
                }
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(&body);
            }
        });
        format!("http://{address}/artifact")
    }

    fn loopback_io() -> SystemInstallIo {
        SystemInstallIo::from_builder(reqwest::blocking::Client::builder().no_proxy())
            .expect("client")
    }

    #[test]
    fn system_download_verifies_pinned_bytes_and_rejects_tampering() {
        let root = temp_root("download");
        let body = b"pinned artifact".to_vec();
        let checksum = format!("{:x}", Sha256::digest(&body));
        let io = loopback_io();
        let url = serve_once(body.clone(), 3);
        let destination = root.join("artifact");
        let spec = |sha256, size| Download {
            url: &url,
            sha256,
            size,
            phase: InstallPhase::DownloadingModel,
        };
        let reported = Mutex::new(Vec::new());
        let reporter = |progress: InstallProgress| {
            reported.lock().expect("reported").push(progress.bytes_done)
        };
        io.download(
            spec(&checksum, Some(body.len() as u64)),
            &destination,
            &AtomicBool::new(false),
            &reporter,
        )
        .expect("verified download");
        assert_eq!(fs::read(&destination).expect("artifact"), body);
        assert_eq!(
            reported.lock().expect("reported").last(),
            Some(&Some(body.len() as u64))
        );

        let zeros = "0".repeat(64);
        let tampered = io
            .download(
                spec(&zeros, None),
                &destination,
                &AtomicBool::new(false),
                &|_| {},
            )
            .expect_err("wrong checksum");
        assert_eq!(tampered.code, InstallErrorCode::ChecksumMismatch);

        let wrong_size = io
            .download(
                spec(&checksum, Some(body.len() as u64 + 1)),
                &destination,
                &AtomicBool::new(false),
                &|_| {},
            )
            .expect_err("wrong size");
        assert_eq!(wrong_size.code, InstallErrorCode::ChecksumMismatch);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn system_download_honours_cancel_before_connecting() {
        let root = temp_root("download-cancel");
        let error = loopback_io()
            .download(
                Download {
                    url: "http://127.0.0.1:9/never",
                    sha256: pins::MODEL_SHA256,
                    size: None,
                    phase: InstallPhase::DownloadingModel,
                },
                &root.join("artifact"),
                &AtomicBool::new(true),
                &|_| {},
            )
            .expect_err("cancelled");
        assert_eq!(error.code, InstallErrorCode::Cancelled);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn child_environment_scrubs_uv_pip_and_python_overrides() {
        for name in [
            "UV_INDEX_URL",
            "UV_PYTHON_INSTALL_MIRROR",
            "PIP_INDEX_URL",
            "PYTHONPATH",
            "VIRTUAL_ENV",
        ] {
            assert!(
                SCRUBBED_ENV_PREFIXES
                    .iter()
                    .any(|prefix| name.starts_with(prefix)),
                "{name} would leak into uv"
            );
        }
        assert!(!SCRUBBED_ENV_PREFIXES
            .iter()
            .any(|prefix| "HOME".starts_with(prefix) || "PATH".starts_with(prefix)));
    }
}
