use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use chrono::Utc;
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::pins;
use super::platform::{self, EnginePlatform};
use super::progress::{self, GrowthEstimator};
use super::{InstallError, InstallErrorCode, InstallPhase, InstallProgress};

pub const ENGINE_DIR: &str = "ocsr-engine";
pub const PARTIAL_DIR: &str = "ocsr-engine.partial";
/// A working install set aside while its replacement is swapped in; restored if the swap fails.
pub const PREVIOUS_DIR: &str = "ocsr-engine.previous";
pub const RECEIPT_FILE: &str = "install.json";
pub const REQUIREMENTS_FILE: &str = "requirements.txt";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstallReceipt {
    pub uv_version: String,
    pub uv_asset: String,
    pub uv_sha256: String,
    pub python_version: String,
    pub requirements_sha256: String,
    pub torch_version: String,
    pub torchvision_version: String,
    pub numpy_version: String,
    pub molscribe_commit: String,
    pub molscribe_source_url: String,
    pub molscribe_source_sha256: String,
    pub model_revision: String,
    pub model_url: String,
    pub model_sha256: String,
    pub model_bytes: u64,
    pub installed_at: String,
    pub disk_bytes: u64,
}

impl InstallReceipt {
    fn pinned(platform: &dyn EnginePlatform, disk_bytes: u64) -> Self {
        Self {
            uv_version: pins::UV_VERSION.to_string(),
            uv_asset: platform.uv_asset().to_string(),
            uv_sha256: platform.uv_sha256().to_string(),
            python_version: pins::PYTHON_VERSION.to_string(),
            requirements_sha256: pins::REQUIREMENTS_LOCK_SHA256.to_string(),
            torch_version: pins::TORCH_VERSION.to_string(),
            torchvision_version: pins::TORCHVISION_VERSION.to_string(),
            numpy_version: pins::NUMPY_VERSION.to_string(),
            molscribe_commit: pins::MOLSCRIBE_COMMIT.to_string(),
            molscribe_source_url: pins::MOLSCRIBE_SOURCE_URL.to_string(),
            molscribe_source_sha256: pins::MOLSCRIBE_SOURCE_SHA256.to_string(),
            model_revision: pins::MODEL_REVISION.to_string(),
            model_url: pins::MODEL_URL.to_string(),
            model_sha256: pins::MODEL_SHA256.to_string(),
            model_bytes: pins::MODEL_BYTES,
            installed_at: Utc::now().to_rfc3339(),
            disk_bytes,
        }
    }

    pub fn matches_pins(&self, platform: &dyn EnginePlatform) -> bool {
        self.uv_version == pins::UV_VERSION
            && self.uv_asset == platform.uv_asset()
            && self.uv_sha256 == platform.uv_sha256()
            && self.python_version == pins::PYTHON_VERSION
            && self.requirements_sha256 == pins::REQUIREMENTS_LOCK_SHA256
            && self.torch_version == pins::TORCH_VERSION
            && self.torchvision_version == pins::TORCHVISION_VERSION
            && self.numpy_version == pins::NUMPY_VERSION
            && self.molscribe_commit == pins::MOLSCRIBE_COMMIT
            && self.molscribe_source_url == pins::MOLSCRIBE_SOURCE_URL
            && self.molscribe_source_sha256 == pins::MOLSCRIBE_SOURCE_SHA256
            && self.model_revision == pins::MODEL_REVISION
            && self.model_url == pins::MODEL_URL
            && self.model_sha256 == pins::MODEL_SHA256
            && self.model_bytes == pins::MODEL_BYTES
    }
}

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

pub struct SystemInstallIo {
    client: reqwest::blocking::Client,
}

impl SystemInstallIo {
    pub fn new() -> Result<Self, InstallError> {
        Self::from_builder(reqwest::blocking::Client::builder())
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
        Ok(Self { client })
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
        mut watch: Option<RunWatch<'_>>,
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
        let mut last_sample = Instant::now();
        loop {
            if cancel.load(Ordering::SeqCst) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(InstallError::cancelled());
            }
            match child.try_wait() {
                Ok(Some(status)) => {
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
    let molscribe_source = partial.join(pins::MOLSCRIBE_SOURCE_FILENAME);
    io.download(
        Download {
            url: pins::MOLSCRIBE_SOURCE_URL,
            sha256: pins::MOLSCRIBE_SOURCE_SHA256,
            size: Some(pins::MOLSCRIBE_SOURCE_BYTES),
            phase: InstallPhase::InstallingPackages,
        },
        &molscribe_source,
        cancel,
        progress,
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
    let receipt_path = partial.join(RECEIPT_FILE);
    let mut receipt = InstallReceipt::pinned(platform, 0);
    write_receipt(&receipt_path, &receipt)?;
    receipt.disk_bytes = directory_size(&partial).map_err(InstallError::failed_io)?;
    write_receipt(&receipt_path, &receipt)?;
    check_cancel(cancel)?;

    commit_staged_tree(paths, platform, io, cancel, &mut guard)?;
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
fn commit_staged_tree(
    paths: &InstallPaths,
    platform: &dyn EnginePlatform,
    io: &dyn InstallIo,
    cancel: &AtomicBool,
    guard: &mut PartialGuard,
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

    if previous.exists() {
        fs::remove_dir_all(&previous).map_err(InstallError::failed_io)?;
    }
    let had_previous = final_dir.exists();
    if had_previous {
        fs::rename(&final_dir, &previous).map_err(InstallError::failed_io)?;
    }
    if let Err(error) = fs::rename(&partial, &final_dir) {
        restore_previous(&final_dir, &previous, had_previous);
        return Err(InstallError::failed_io(error));
    }
    // From here the staging tree is gone; a failure removes the new tree instead.
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
        });
    match outcome {
        Ok(()) => {
            if had_previous {
                if let Err(error) = fs::remove_dir_all(&previous) {
                    eprintln!(
                        "[chemdraft ocsr] could not remove the replaced engine at {}: {error}",
                        previous.display()
                    );
                }
            }
            Ok(())
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&final_dir);
            restore_previous(&final_dir, &previous, had_previous);
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

pub fn read_receipt(path: &Path) -> Result<InstallReceipt, String> {
    let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&text).map_err(|error| error.to_string())
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

fn write_receipt(path: &Path, receipt: &InstallReceipt) -> Result<(), InstallError> {
    let bytes = serde_json::to_vec_pretty(receipt).map_err(|error| {
        InstallError::failed(format!("Could not encode install receipt: {error}"))
    })?;
    let mut file = File::create(path).map_err(InstallError::failed_io)?;
    file.write_all(&bytes).map_err(InstallError::failed_io)?;
    file.sync_all().map_err(InstallError::failed_io)
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
            _progress: &dyn ProgressReporter,
        ) -> Result<(), InstallError> {
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
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
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
        let round_trip = read_receipt(&paths.final_dir().join(RECEIPT_FILE)).expect("receipt");
        assert_eq!(receipt, round_trip);
        assert!(receipt.disk_bytes >= pins::MODEL_BYTES);
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

    #[test]
    fn receipt_round_trips_all_pins_and_detects_stale_ones() {
        let root = temp_root("receipt");
        let platform = MacPlatform::new(MacArchitecture::X86_64);
        let receipt = InstallReceipt::pinned(&platform, 42);
        let path = root.join(RECEIPT_FILE);
        write_receipt(&path, &receipt).expect("write receipt");
        let read = read_receipt(&path).expect("read receipt");
        assert_eq!(read, receipt);
        assert!(read.matches_pins(&platform));
        assert!(!read.matches_pins(&MacPlatform::new(MacArchitecture::Aarch64)));
        let stale = InstallReceipt {
            model_sha256: "0".repeat(64),
            ..receipt
        };
        assert!(!stale.matches_pins(&platform));
        fs::write(&path, b"{not json").expect("corrupt receipt");
        assert!(read_receipt(&path).is_err());
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
