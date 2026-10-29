use super::pins;
use super::platform::EnginePlatform;
use super::progress;
use super::receipt::{read_current_receipt, write_receipt, InstallReceipt};
use super::{InstallError, InstallErrorCode, InstallPhase, InstallProgress};
use crate::local_engine::{self, EngineSpec};
use local_engine::file_ops::{self, FileOps};
use local_engine::install::ProgressReporter;
#[cfg(test)]
use local_engine::install::RunWatch;
#[cfg(test)]
use local_engine::install::SCRUBBED_ENV_PREFIXES;
#[cfg(test)]
use local_engine::install::{download_progress, REQUIREMENTS_FILE};
use local_engine::install::{message, os_args, Download, InstallContext, RunStep};
pub use local_engine::install::{InstallIo, ProbeIo, RunningChild, RECEIPT_FILE};
#[cfg(test)]
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
#[cfg(test)]
use std::{
    fs::File,
    io::{Read, Write},
    sync::atomic::Ordering,
};
#[cfg(all(test, unix))]
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

pub type SystemInstallIo = local_engine::install::SystemInstallIo<MolScribeSpec>;
pub const ENGINE_DIR: &str = "ocsr-engine";
#[cfg(test)]
pub const PARTIAL_DIR: &str = "ocsr-engine.partial";
/// A working install set aside while its replacement is swapped in; restored if the swap fails.
#[cfg(test)]
pub const PREVIOUS_DIR: &str = "ocsr-engine.previous";
/// Name prefix of a tree renamed out of the way and waiting to be deleted (see [`retire_tree`]).
#[cfg(test)]
pub const DISCARD_PREFIX: &str = "ocsr-engine.discard-";
#[derive(Debug, Clone)]
pub struct InstallPaths {
    pub app_data: PathBuf,
    pub requirements: PathBuf,
}

impl InstallPaths {
    fn shared(&self) -> local_engine::install::InstallPaths {
        local_engine::install::InstallPaths {
            app_data: self.app_data.clone(),
            requirements: self.requirements.clone(),
        }
    }

    pub fn final_dir(&self) -> PathBuf {
        self.app_data.join(ENGINE_DIR)
    }

    #[cfg(test)]
    pub fn partial_dir(&self) -> PathBuf {
        self.app_data.join(PARTIAL_DIR)
    }

    #[cfg(test)]
    pub fn previous_dir(&self) -> PathBuf {
        self.app_data.join(PREVIOUS_DIR)
    }
}

#[allow(non_upper_case_globals)]
impl RunStep {
    pub const InstallMolScribe: Self = Self::Extra;
}

pub struct MolScribeSpec;
impl EngineSpec for MolScribeSpec {
    type Receipt = InstallReceipt;
    const DIR_NAME: &'static str = ENGINE_DIR;
    const LOG_PREFIX: &'static str = "[chemdraft ocsr]";
    const USER_AGENT: &'static str = "ChemDraft-OCSR-Installer/1";
    fn python_version() -> &'static str {
        pins::PYTHON_VERSION
    }
    fn required_disk_bytes() -> u64 {
        pins::REQUIRED_DISK_BYTES
    }
    fn requirements() -> (&'static str, &'static str) {
        (pins::REQUIREMENTS_RESOURCE, pins::REQUIREMENTS_LOCK_SHA256)
    }
    fn pip_install_args() -> Vec<OsString> {
        // uv applies this index only to PyTorch ecosystem packages. The reviewed Linux lock
        // contains exact +cpu versions and SHA-256 hashes; no CUDA runtime is installed.
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        return os_args(["--torch-backend", "cpu"]);
        #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
        Vec::new()
    }
    fn python_growth_bytes() -> u64 {
        progress::PYTHON_EXPECTED_GROWTH_BYTES
    }
    fn packages_growth_bytes() -> u64 {
        progress::PACKAGES_EXPECTED_GROWTH_BYTES
    }
    fn packages_label() -> &'static str {
        "Installing PyTorch and MolScribe"
    }
    fn packages_message() -> &'static str {
        "Installing pinned MolScribe dependencies."
    }
    fn installed_message() -> &'static str {
        "MolScribe is installed."
    }
    fn insufficient_disk(free_bytes: u64) -> InstallError {
        InstallError {
            code: InstallErrorCode::InsufficientDisk,
            message: format!(
                "MolScribe needs at least {} bytes free; only {free_bytes} bytes are available.",
                pins::REQUIRED_DISK_BYTES
            ),
        }
    }
    fn cancelled() -> InstallError {
        InstallError::cancelled()
    }
    fn failed_io(error: std::io::Error) -> InstallError {
        InstallError::failed_io(error)
    }
    fn relocation_error(error: std::io::Error) -> InstallError {
        InstallError::failed(format!(
            "Could not relocate the MolScribe environment: {error}"
        ))
    }
    fn platform_supported(_platform: &dyn EnginePlatform) -> Result<(), String> {
        Ok(())
    }
    fn before_packages(context: &InstallContext<'_>) -> Result<(), InstallError> {
        let InstallContext {
            root: partial,
            io,
            cancel,
            progress,
            ..
        } = *context;
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

        Ok(())
    }
    fn extra_steps(context: &InstallContext<'_>) -> Result<(), InstallError> {
        let InstallContext {
            root: partial,
            platform,
            io,
            cancel,
            progress,
            environment,
        } = *context;
        let uv = platform.uv_executable(partial);
        let venv_python = platform.venv_python(partial).into_os_string();
        let molscribe_source = partial.join(pins::MOLSCRIBE_SOURCE_FILENAME);
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
            environment,
            cancel,
            None,
        )?;
        FileOps::new::<Self>(Some(cancel))
            .with_running(io.running_child())
            .remove_file(&molscribe_source)
            .map_err(file_ops::failed::<Self>)?;

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

        Ok(())
    }
    fn probe_args() -> Vec<OsString> {
        os_args([
            "-c",
            "import cv2, molscribe, numpy, torch, torchvision; print(torch.__version__)",
        ])
    }
    fn verify_layout(root: &Path, platform: &dyn EnginePlatform) -> Result<(), InstallError> {
        verify_layout(root, platform)
    }
    fn receipt(platform: &dyn EnginePlatform, disk_bytes: u64) -> InstallReceipt {
        InstallReceipt::pinned(platform, disk_bytes)
    }
    fn read_current_receipt(path: &Path) -> Option<InstallReceipt> {
        read_current_receipt(path)
    }
    fn matches_pins(receipt: &InstallReceipt, platform: &dyn EnginePlatform) -> bool {
        receipt.matches_pins(platform)
    }
    fn write_receipt(path: &Path, receipt: &InstallReceipt) -> Result<(), InstallError> {
        write_receipt(path, receipt)
    }
    fn write_receipt_with_cancel(
        path: &Path,
        receipt: &InstallReceipt,
        cancel: &AtomicBool,
    ) -> Result<(), InstallError> {
        local_engine::receipt::write_receipt_with_cancel::<Self>(path, receipt, Some(cancel))
    }
    fn is_restorable(root: &Path, platform: &dyn EnginePlatform) -> bool {
        is_restorable(root, platform)
    }
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
    let size = FileOps::new::<MolScribeSpec>(None)
        .run(format!("inspect file {}", model.display()), || {
            fs::metadata(&model)
        })
        .map_err(file_ops::failed::<MolScribeSpec>)?
        .len();
    if size != pins::MODEL_BYTES {
        return Err(InstallError::checksum(format!(
            "The installed model is {size} bytes; expected {}.",
            pins::MODEL_BYTES
        )));
    }
    Ok(())
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

pub fn install(
    paths: &InstallPaths,
    platform: &dyn EnginePlatform,
    io: &dyn InstallIo,
    cancel: &AtomicBool,
    progress: &dyn ProgressReporter,
    free_bytes: u64,
) -> Result<InstallReceipt, InstallError> {
    local_engine::install::install::<MolScribeSpec>(
        &paths.shared(),
        platform,
        io,
        cancel,
        progress,
        free_bytes,
    )
}

pub fn remove_stale_staging(
    paths: &InstallPaths,
    platform: &dyn EnginePlatform,
    io: &dyn InstallIo,
    cancel: &AtomicBool,
) -> Vec<PathBuf> {
    local_engine::install::remove_stale_staging::<MolScribeSpec>(
        &paths.shared(),
        platform,
        io,
        cancel,
    )
}

pub fn remove_engine_trees(paths: &InstallPaths) -> Result<(), (PathBuf, std::io::Error)> {
    local_engine::install::remove_engine_trees::<MolScribeSpec>(&paths.shared())
}

#[cfg(test)]
pub fn is_healthy(root: &Path, platform: &dyn EnginePlatform) -> bool {
    local_engine::install::is_healthy::<MolScribeSpec>(root, platform)
}

#[cfg(test)]
pub fn retire_tree(app_data: &Path, tree: &Path) -> std::io::Result<Option<PathBuf>> {
    local_engine::install::retire_tree::<MolScribeSpec>(app_data, tree)
}

#[cfg(test)]
fn discard_dirs(app_data: &Path) -> Vec<PathBuf> {
    local_engine::install::discard_dirs::<MolScribeSpec>(app_data)
}

#[cfg(test)]
fn extract_uv_tar_gz(archive: &Path, destination: &Path) -> Result<(), InstallError> {
    local_engine::install::extract_uv_tar_gz::<MolScribeSpec>(archive, destination)
}

#[cfg(test)]
fn extract_uv_zip(archive: &Path, destination: &Path) -> Result<(), InstallError> {
    local_engine::install::extract_uv_zip::<MolScribeSpec>(archive, destination)
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
            crate::ocsr_engine::set_sparse_len(&file, spec.size.unwrap_or(8))
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
                #[cfg(windows)]
                RunStep::RewriteVenvLaunchers => "rewrite-venv",
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
                #[cfg(windows)]
                "rewrite-venv",
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
            remove_stale_staging(
                &paths,
                &platform,
                &FakeIo::new(None),
                &AtomicBool::new(false)
            ),
            vec![paths.partial_dir()]
        );
        assert!(!paths.partial_dir().exists());
        assert!(paths.previous_dir().exists());

        // Beside a healthy install, both go and the install is untouched.
        run_install(&paths, &FakeIo::new(None)).expect("fake install");
        stage(&paths.partial_dir());
        stage(&paths.previous_dir());
        assert_eq!(
            remove_stale_staging(
                &paths,
                &platform,
                &FakeIo::new(None),
                &AtomicBool::new(false)
            ),
            vec![paths.partial_dir(), paths.previous_dir()]
        );
        assert_no_staging(&paths);
        assert!(is_healthy(&paths.final_dir(), &platform));
        assert!(remove_stale_staging(
            &paths,
            &platform,
            &FakeIo::new(None),
            &AtomicBool::new(false)
        )
        .is_empty());
        let _ = fs::remove_dir_all(root);
    }

    /// App exit kills the uv child from another thread through `RunningChild`, and must take down
    /// what uv started too; a grandchild left running would keep writing into the staging tree.
    #[cfg(unix)]
    #[test]
    fn killing_the_running_child_takes_down_its_whole_process_tree() {
        assert_running_child_tree_is_killed(Box::new(MacPlatform::new(MacArchitecture::Aarch64)));
    }

    #[cfg(unix)]
    #[test]
    fn linux_running_child_kill_takes_down_its_whole_process_tree() {
        use crate::local_engine::platform::{LinuxArchitecture, LinuxPlatform};
        assert_running_child_tree_is_killed(Box::new(LinuxPlatform::new(
            LinuxArchitecture::X86_64,
        )));
    }

    #[cfg(unix)]
    fn assert_running_child_tree_is_killed(platform: Box<dyn EnginePlatform>) {
        let root = temp_root("kill-tree");
        let grandchild_file = root.join("grandchild.pid");
        let running = Arc::new(RunningChild::default());
        let mut io = loopback_io();
        io.running = running.clone();
        let script = format!("sleep 30 & echo $! > '{}'; wait", grandchild_file.display());
        let started = Instant::now();
        let worker = std::thread::spawn(move || {
            io.run(
                platform.as_ref(),
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

    const BUNDLED_REQUIREMENTS: &str = pins::BUNDLED_REQUIREMENTS;

    /// Explicitly opt-in: exercises the production downloader, hash-locked package install,
    /// staging relocation, probe and final receipt. The large model stays out of ordinary CI.
    #[cfg(all(target_os = "linux", target_env = "gnu", target_arch = "x86_64"))]
    #[test]
    #[ignore = "downloads and installs the real Linux CPU engine; set CHEMDRAFT_REAL_ENGINE_TEST_ROOT"]
    fn linux_real_install_downloads_verifies_relocates_and_probes() {
        let parent = PathBuf::from(
            std::env::var_os("CHEMDRAFT_REAL_ENGINE_TEST_ROOT")
                .expect("choose a disposable test directory explicitly"),
        );
        assert!(parent.is_absolute());
        fs::create_dir_all(&parent).expect("test parent");
        let root = parent.join(format!(
            "ocsr-real-install-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        assert!(!root.exists());
        fs::create_dir(&root).expect("fresh test root");
        struct RemoveTestRoot(PathBuf);
        impl Drop for RemoveTestRoot {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = RemoveTestRoot(root.clone());
        let platform = super::super::platform::current().expect("Linux CPU platform");
        let paths = InstallPaths {
            app_data: root,
            requirements: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join(pins::REQUIREMENTS_RESOURCE),
        };
        let io = SystemInstallIo::new(Arc::default()).expect("production download client");
        let receipt = install(
            &paths,
            platform.as_ref(),
            &io,
            &AtomicBool::new(false),
            &|event: InstallProgress| eprintln!("Linux OCSR: {:?}: {}", event.phase, event.message),
            super::super::platform::free_disk_bytes(&paths.app_data).expect("free disk"),
        )
        .expect("real production installation");
        assert!(is_healthy(&paths.final_dir(), platform.as_ref()));
        assert!(receipt.matches_pins(platform.as_ref()));
        assert!(!paths.partial_dir().exists());
        assert!(!paths.previous_dir().exists());
        fs::write(
            parent.join("ocsr-linux-install-receipt.json"),
            serde_json::to_vec_pretty(&receipt).expect("receipt JSON"),
        )
        .expect("save evidence");
    }

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
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        assert!(packages
            .windows(2)
            .any(|args| args == ["--torch-backend", "cpu"]));
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
            remove_stale_staging(
                &paths,
                &platform,
                &FakeIo::new(None),
                &AtomicBool::new(false)
            ),
            vec![discarded.clone()]
        );
        assert!(!discarded.exists());
        assert!(is_healthy(&paths.final_dir(), &platform));
        assert!(remove_stale_staging(
            &paths,
            &platform,
            &FakeIo::new(None),
            &AtomicBool::new(false)
        )
        .is_empty());
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

        assert!(remove_stale_staging(
            &paths,
            &platform,
            &FakeIo::new(None),
            &AtomicBool::new(false)
        )
        .is_empty());
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
            .and_then(|model| crate::ocsr_engine::set_sparse_len(&model, pins::MODEL_BYTES))
            .expect("model");
        assert!(verify_layout(&paths.final_dir(), &platform).is_ok());
        assert!(!is_healthy(&paths.final_dir(), &platform));

        assert!(remove_stale_staging(
            &paths,
            &platform,
            &FakeIo::new(None),
            &AtomicBool::new(false)
        )
        .is_empty());
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
            remove_stale_staging(
                &paths,
                &platform,
                &FakeIo::new(None),
                &AtomicBool::new(false)
            ),
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
    fn system_download_reports_plain_refused_and_interrupted_messages() {
        let root = temp_root("network-errors");
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("address");
        drop(listener);
        let url = format!("http://{address}/artifact?sig=secret-signature&jwt=secret-token");
        let io = loopback_io();
        let download = |url: &str| {
            io.download(
                Download {
                    url,
                    sha256: pins::MODEL_SHA256,
                    size: None,
                    phase: InstallPhase::DownloadingModel,
                },
                &root.join("artifact"),
                &AtomicBool::new(false),
                &|_| {},
            )
            .expect_err("network failure")
        };
        let refused = download(&url);
        assert_eq!(refused.code, InstallErrorCode::Network);
        assert_eq!(
            refused.message,
            "Couldn't reach 127.0.0.1: the network refused the connection."
        );

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("address");
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().expect("connection");
            crate::network_test_http::reply(
                stream,
                b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nshort",
            );
        });
        let interrupted = download(&format!(
            "http://{address}/artifact?sig=secret-signature&jwt=secret-token"
        ));
        assert_eq!(interrupted.code, InstallErrorCode::Network);
        assert!(
            interrupted
                .message
                .contains("127.0.0.1: the connection was closed or interrupted"),
            "{}",
            interrupted.message
        );
        for error in [refused, interrupted] {
            for secret in ["?", "sig=", "jwt=", "secret-signature", "secret-token"] {
                assert!(!error.message.contains(secret));
            }
        }
        server.join().expect("server");
        let _ = fs::remove_dir_all(root);
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
