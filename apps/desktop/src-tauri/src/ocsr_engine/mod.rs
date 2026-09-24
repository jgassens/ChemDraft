mod install;
mod pins;
mod platform;
mod process;
mod progress;
mod protocol;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, TryLockError};
use std::time::{Duration, Instant};

use std::borrow::Cow;

use base64::Engine;
use image::ImageFormat;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{Manager, Runtime};

use install::{InstallPaths, SystemInstallIo};
use process::{LaunchPaths, ProcessError, ProcessManager};
use protocol::{RecognizedAtom, RecognizedBond};

const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
static NEXT_TEMP_IMAGE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EngineState {
    NotInstalled,
    Installing,
    Installed,
    Broken,
    Unsupported,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledEngine {
    pub uv_version: String,
    pub python_version: String,
    pub molscribe_commit: String,
    pub model_sha256: String,
    pub installed_at: String,
    pub disk_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcsrEngineStatus {
    pub state: EngineState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed: Option<InstalledEngine>,
    pub required_disk_bytes: u64,
    pub free_disk_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// While `installing`: the latest progress event, so a window that did not start the install
    /// (or was closed and reopened) can show where it is instead of offering Install again.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<InstallProgress>,
    /// While `installing`: milliseconds since the install started.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_elapsed_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum InstallPhase {
    CheckingDisk,
    DownloadingUv,
    InstallingPython,
    InstallingPackages,
    DownloadingModel,
    Verifying,
    Done,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub phase: InstallPhase,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_done: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_total: Option<u64>,
    /// The byte counts are an estimate from directory growth, not a transfer count
    /// (see `progress.rs`). Omitted when false.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub estimated: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum InstallErrorCode {
    InsufficientDisk,
    Network,
    ChecksumMismatch,
    Cancelled,
    Unsupported,
    Failed,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstallError {
    pub code: InstallErrorCode,
    pub message: String,
}

impl InstallError {
    fn network(message: impl Into<String>) -> Self {
        Self {
            code: InstallErrorCode::Network,
            message: message.into(),
        }
    }

    fn checksum(message: impl Into<String>) -> Self {
        Self {
            code: InstallErrorCode::ChecksumMismatch,
            message: message.into(),
        }
    }

    fn cancelled() -> Self {
        Self {
            code: InstallErrorCode::Cancelled,
            message: "MolScribe installation was cancelled.".to_string(),
        }
    }

    fn failed(message: impl Into<String>) -> Self {
        Self {
            code: InstallErrorCode::Failed,
            message: message.into(),
        }
    }

    fn failed_io(error: std::io::Error) -> Self {
        Self::failed(format!("OCSR installation failed: {error}"))
    }

    fn unsupported(message: impl Into<String>) -> Self {
        Self {
            code: InstallErrorCode::Unsupported,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RecognitionErrorCode {
    InvalidImage,
    RecognitionFailed,
    EngineCrashed,
    Timeout,
    Busy,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecognitionEngine {
    pub name: &'static str,
    pub molscribe_commit: &'static str,
    pub model_sha256: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RecognitionResponse {
    Recognized {
        smiles: String,
        molfile: String,
        confidence: Option<f64>,
        atoms: Vec<RecognizedAtom>,
        bonds: Vec<RecognizedBond>,
        elapsed_ms: u64,
        engine: RecognitionEngine,
    },
    NotInstalled,
    Failed {
        code: RecognitionErrorCode,
        message: String,
    },
}

/// The running install's start time and latest progress, read by `ocsr_engine_status`.
struct InstallSnapshot {
    started: Instant,
    progress: Option<InstallProgress>,
}

pub struct OcsrEngineState {
    installing: Arc<AtomicBool>,
    cancel_install: Arc<AtomicBool>,
    install_snapshot: Arc<Mutex<Option<InstallSnapshot>>>,
    stop_reaper: Arc<AtomicBool>,
    request_gate: Arc<Mutex<()>>,
    process: Arc<Mutex<ProcessManager>>,
}

impl Default for OcsrEngineState {
    fn default() -> Self {
        Self {
            installing: Arc::new(AtomicBool::new(false)),
            cancel_install: Arc::new(AtomicBool::new(false)),
            install_snapshot: Arc::new(Mutex::new(None)),
            stop_reaper: Arc::new(AtomicBool::new(false)),
            request_gate: Arc::new(Mutex::new(())),
            process: Arc::new(Mutex::new(ProcessManager::system())),
        }
    }
}

impl OcsrEngineState {
    pub fn start_idle_reaper(&self) {
        let stop = self.stop_reaper.clone();
        let process = self.process.clone();
        std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_secs(30));
                if let Ok(mut manager) = process.try_lock() {
                    manager.stop_if_idle(Instant::now());
                }
            }
        });
    }

    pub fn shutdown(&self) {
        self.stop_reaper.store(true, Ordering::SeqCst);
        self.stop_sidecar();
    }

    pub fn stop_sidecar(&self) {
        let mut process = self
            .process
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        process.stop();
    }
}

impl Drop for OcsrEngineState {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[tauri::command]
pub fn ocsr_engine_status<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, OcsrEngineState>,
) -> OcsrEngineStatus {
    status_impl(&app, &state)
}

#[tauri::command]
pub async fn ocsr_engine_install<R: Runtime>(
    app: tauri::AppHandle<R>,
    on_progress: Channel<InstallProgress>,
) -> Result<OcsrEngineStatus, InstallError> {
    let paths = install_paths(&app)?;
    let platform = platform::current().map_err(InstallError::unsupported)?;
    let disk_path = existing_ancestor(&paths.app_data);
    let free = platform::free_disk_bytes(&disk_path).map_err(InstallError::failed)?;
    let state = app.state::<OcsrEngineState>();
    if state
        .installing
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(InstallError::failed(
            "A MolScribe installation is already running.",
        ));
    }
    state.cancel_install.store(false, Ordering::SeqCst);
    let snapshot = state.install_snapshot.clone();
    *lock_ignoring_poison(&snapshot) = Some(InstallSnapshot {
        started: Instant::now(),
        progress: None,
    });
    // A reinstall replaces the files a running sidecar was started from; recognition reports
    // `notInstalled` while `installing` is set, so nothing restarts it until the install ends.
    state.stop_sidecar();
    let installing = state.installing.clone();
    let cancel = state.cancel_install.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        struct ResetInstall(Arc<AtomicBool>, Arc<Mutex<Option<InstallSnapshot>>>);
        impl Drop for ResetInstall {
            fn drop(&mut self) {
                *lock_ignoring_poison(&self.1) = None;
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _reset = ResetInstall(installing, snapshot.clone());
        let io = SystemInstallIo::new()?;
        // Every event updates the snapshot; the channel gets at most about four a second.
        let throttle = Mutex::new(progress::ProgressThrottle::new(progress::EMIT_INTERVAL));
        let reporter = move |progress: InstallProgress| {
            if let Some(current) = lock_ignoring_poison(&snapshot).as_mut() {
                current.progress = Some(progress.clone());
            }
            if lock_ignoring_poison(&throttle).admit(&progress, Instant::now()) {
                let _ = on_progress.send(progress);
            }
        };
        install::install(&paths, platform.as_ref(), &io, &cancel, &reporter, free)
    })
    .await
    .map_err(|error| InstallError::failed(format!("Could not schedule installation: {error}")))?;
    result?;
    Ok(status_impl(&app, &app.state::<OcsrEngineState>()))
}

#[tauri::command]
pub fn ocsr_engine_cancel_install(state: tauri::State<'_, OcsrEngineState>) {
    state.cancel_install.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub async fn ocsr_engine_uninstall<R: Runtime>(app: tauri::AppHandle<R>) -> OcsrEngineStatus {
    let state = app.state::<OcsrEngineState>();
    state.cancel_install.store(true, Ordering::SeqCst);
    let installing = state.installing.clone();
    let process = state.process.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        while installing.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(50));
        }
    })
    .await;
    process
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .stop();
    let paths = match install_paths(&app) {
        Ok(paths) => paths,
        Err(error) => return broken_status(0, error.message),
    };
    for path in [paths.final_dir(), paths.partial_dir(), paths.previous_dir()] {
        if path.exists() {
            if let Err(error) = fs::remove_dir_all(&path) {
                return broken_status(
                    free_disk_for(&paths.app_data),
                    format!("Could not remove {}: {error}", path.display()),
                );
            }
        }
    }
    status_impl(&app, &app.state::<OcsrEngineState>())
}

#[tauri::command]
pub async fn ocsr_recognize_image<R: Runtime>(
    app: tauri::AppHandle<R>,
    media_type: String,
    bytes_base64: String,
) -> RecognitionResponse {
    let state = app.state::<OcsrEngineState>();
    let status = status_impl(&app, &state);
    match status.state {
        // An unsupported platform has no engine installed; the status command says why.
        EngineState::NotInstalled | EngineState::Installing | EngineState::Unsupported => {
            return RecognitionResponse::NotInstalled
        }
        EngineState::Broken => {
            return failed(
                RecognitionErrorCode::EngineCrashed,
                status
                    .detail
                    .unwrap_or_else(|| "The MolScribe installation is unavailable.".to_string()),
            )
        }
        EngineState::Installed => {}
    }
    if !is_supported_media_type(&media_type) {
        return failed(
            RecognitionErrorCode::InvalidImage,
            format!("Unsupported image media type: {media_type}"),
        );
    }
    // Base64 carries 3 bytes per 4 characters; the bound can exceed the true size by up to two
    // padding bytes, so only a payload that cannot fit is rejected before decoding.
    if decoded_size_upper_bound(bytes_base64.len()) > MAX_IMAGE_BYTES + 2 {
        return failed(
            RecognitionErrorCode::InvalidImage,
            "The image exceeds the 25 MB limit.",
        );
    }
    let bytes = match base64::engine::general_purpose::STANDARD.decode(bytes_base64.as_bytes()) {
        Ok(bytes) if bytes.len() <= MAX_IMAGE_BYTES => bytes,
        Ok(_) => {
            return failed(
                RecognitionErrorCode::InvalidImage,
                "The image exceeds the 25 MB limit.",
            )
        }
        Err(error) => {
            return failed(
                RecognitionErrorCode::InvalidImage,
                format!("The image payload is not valid base64: {error}"),
            )
        }
    };
    let install_paths = match install_paths(&app) {
        Ok(paths) => paths,
        Err(error) => return failed(RecognitionErrorCode::EngineCrashed, error.message),
    };
    let sidecar = match resource_path(&app, "resources/ocsr/molscribe_sidecar.py") {
        Some(path) => path,
        None => {
            return failed(
                RecognitionErrorCode::EngineCrashed,
                "The MolScribe sidecar is not present in this build.",
            )
        }
    };
    let temp_dir = app
        .path()
        .temp_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let request_gate = state.request_gate.clone();
    let manager = state.process.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _request = match request_gate.try_lock() {
            Ok(guard) => guard,
            Err(TryLockError::WouldBlock) => {
                return failed(
                    RecognitionErrorCode::Busy,
                    "MolScribe is already recognizing another image.",
                )
            }
            Err(TryLockError::Poisoned(_)) => {
                return failed(
                    RecognitionErrorCode::EngineCrashed,
                    "The MolScribe request queue is unavailable.",
                )
            }
        };
        let (extension, bytes) = match prepare_image(&bytes) {
            Ok(prepared) => prepared,
            Err(message) => return failed(RecognitionErrorCode::InvalidImage, message),
        };
        let temp = match TempImage::write(&temp_dir, extension, &bytes) {
            Ok(temp) => temp,
            Err(error) => {
                return failed(
                    RecognitionErrorCode::InvalidImage,
                    format!("Could not prepare the image: {error}"),
                )
            }
        };
        let platform = match platform::current() {
            Ok(platform) => platform,
            Err(message) => return failed(RecognitionErrorCode::EngineCrashed, message),
        };
        let root = install_paths.final_dir();
        let launch = LaunchPaths::for_engine(
            platform.venv_python(&root),
            sidecar,
            root.join(pins::MODEL_FILENAME),
        );
        let mut process = manager
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match process.recognize(
            platform.as_ref(),
            &launch,
            temp.path(),
            process::REQUEST_TIMEOUT,
        ) {
            Ok(payload) => RecognitionResponse::Recognized {
                smiles: payload.smiles,
                molfile: payload.molfile,
                confidence: payload.confidence,
                atoms: payload.atoms,
                bonds: payload.bonds,
                elapsed_ms: payload.elapsed_ms,
                engine: RecognitionEngine {
                    name: "MolScribe",
                    molscribe_commit: pins::MOLSCRIBE_COMMIT,
                    model_sha256: pins::MODEL_SHA256,
                },
            },
            Err(ProcessError::InvalidImage(message)) => {
                failed(RecognitionErrorCode::InvalidImage, message)
            }
            Err(ProcessError::RecognitionFailed(message)) => {
                failed(RecognitionErrorCode::RecognitionFailed, message)
            }
            Err(ProcessError::Crashed(message)) => {
                failed(RecognitionErrorCode::EngineCrashed, message)
            }
            Err(ProcessError::Timeout) => failed(
                RecognitionErrorCode::Timeout,
                "MolScribe did not finish within 120 seconds.",
            ),
        }
    })
    .await
    .unwrap_or_else(|error| {
        failed(
            RecognitionErrorCode::EngineCrashed,
            format!("Could not schedule recognition: {error}"),
        )
    })
}

fn status_impl<R: Runtime>(app: &tauri::AppHandle<R>, state: &OcsrEngineState) -> OcsrEngineStatus {
    let paths = match install_paths(app) {
        Ok(paths) => paths,
        Err(error) => return broken_status(0, error.message),
    };
    let free = free_disk_for(&paths.app_data);
    let platform = match platform::current() {
        Ok(platform) => platform,
        Err(detail) => {
            return OcsrEngineStatus {
                state: EngineState::Unsupported,
                installed: None,
                required_disk_bytes: pins::REQUIRED_DISK_BYTES,
                free_disk_bytes: free,
                detail: Some(detail),
                progress: None,
                install_elapsed_ms: None,
            }
        }
    };
    if state.installing.load(Ordering::SeqCst) {
        let (progress, install_elapsed_ms) =
            match lock_ignoring_poison(&state.install_snapshot).as_ref() {
                Some(snapshot) => (
                    snapshot.progress.clone(),
                    Some(u64::try_from(snapshot.started.elapsed().as_millis()).unwrap_or(u64::MAX)),
                ),
                None => (None, None),
            };
        return OcsrEngineStatus {
            state: EngineState::Installing,
            installed: None,
            required_disk_bytes: pins::REQUIRED_DISK_BYTES,
            free_disk_bytes: free,
            detail: None,
            progress,
            install_elapsed_ms,
        };
    }
    let root = paths.final_dir();
    if !root.exists() {
        return OcsrEngineStatus {
            state: EngineState::NotInstalled,
            installed: None,
            required_disk_bytes: pins::REQUIRED_DISK_BYTES,
            free_disk_bytes: free,
            detail: None,
            progress: None,
            install_elapsed_ms: None,
        };
    }
    let receipt = match install::read_receipt(&root.join(install::RECEIPT_FILE)) {
        Ok(receipt) => receipt,
        Err(error) => {
            return broken_status(
                free,
                format!("The OCSR install receipt is invalid: {error}"),
            )
        }
    };
    if !receipt.matches_pins(platform.as_ref()) {
        return broken_status(
            free,
            "The installed OCSR dependency pins do not match this ChemDraft build.",
        );
    }
    if let Err(error) = install::verify_layout(&root, platform.as_ref()) {
        return broken_status(free, error.message);
    }
    OcsrEngineStatus {
        state: EngineState::Installed,
        installed: Some(InstalledEngine {
            uv_version: receipt.uv_version,
            python_version: receipt.python_version,
            molscribe_commit: receipt.molscribe_commit,
            model_sha256: receipt.model_sha256,
            installed_at: receipt.installed_at,
            disk_bytes: receipt.disk_bytes,
        }),
        required_disk_bytes: pins::REQUIRED_DISK_BYTES,
        free_disk_bytes: free,
        detail: None,
        progress: None,
        install_elapsed_ms: None,
    }
}

fn install_paths<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<InstallPaths, InstallError> {
    let app_data = app.path().app_data_dir().map_err(|error| {
        InstallError::failed(format!("No app data directory is available: {error}"))
    })?;
    let requirements = resource_path(app, "resources/ocsr/requirements.txt").ok_or_else(|| {
        InstallError::failed("The OCSR requirements file is not present in this build.")
    })?;
    Ok(InstallPaths {
        app_data,
        requirements,
    })
}

fn resource_path<R: Runtime>(app: &tauri::AppHandle<R>, relative: &str) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join(relative));
    }
    if cfg!(debug_assertions) {
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative));
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn free_disk_for(path: &Path) -> u64 {
    platform::free_disk_bytes(&existing_ancestor(path)).unwrap_or(0)
}

fn existing_ancestor(path: &Path) -> PathBuf {
    let mut candidate = path;
    while !candidate.exists() {
        match candidate.parent() {
            Some(parent) => candidate = parent,
            None => return PathBuf::from("."),
        }
    }
    candidate.to_path_buf()
}

fn lock_ignoring_poison<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn broken_status(free_disk_bytes: u64, detail: impl Into<String>) -> OcsrEngineStatus {
    OcsrEngineStatus {
        state: EngineState::Broken,
        installed: None,
        required_disk_bytes: pins::REQUIRED_DISK_BYTES,
        free_disk_bytes,
        detail: Some(detail.into()),
        progress: None,
        install_elapsed_ms: None,
    }
}

fn failed(code: RecognitionErrorCode, message: impl Into<String>) -> RecognitionResponse {
    RecognitionResponse::Failed {
        code,
        message: message.into(),
    }
}

fn is_supported_media_type(media_type: &str) -> bool {
    let essence = media_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    matches!(
        essence.as_str(),
        "image/png" | "image/jpeg" | "image/jpg" | "image/gif" | "image/bmp" | "image/tiff"
    )
}

/// Decodes the image here, so a corrupt or mislabelled payload is reported as `invalidImage`
/// before the engine starts, and picks the file the sidecar will read. The format comes from the
/// bytes, not the declared media type. PNG, JPEG, BMP and TIFF pass through unchanged; anything
/// else (GIF) is re-encoded as PNG, because MolScribe reads with OpenCV, which cannot open GIF.
fn prepare_image(bytes: &[u8]) -> Result<(&'static str, Cow<'_, [u8]>), String> {
    let format = image::guess_format(bytes)
        .map_err(|_| "The image format is not recognized.".to_string())?;
    let decoded = image::load_from_memory_with_format(bytes, format)
        .map_err(|error| format!("The image could not be decoded: {error}"))?;
    match format {
        ImageFormat::Png => Ok(("png", Cow::Borrowed(bytes))),
        ImageFormat::Jpeg => Ok(("jpg", Cow::Borrowed(bytes))),
        ImageFormat::Bmp => Ok(("bmp", Cow::Borrowed(bytes))),
        ImageFormat::Tiff => Ok(("tiff", Cow::Borrowed(bytes))),
        _ => {
            let mut png = std::io::Cursor::new(Vec::new());
            decoded
                .write_to(&mut png, ImageFormat::Png)
                .map_err(|error| format!("The image could not be converted to PNG: {error}"))?;
            Ok(("png", Cow::Owned(png.into_inner())))
        }
    }
}

fn decoded_size_upper_bound(encoded_len: usize) -> usize {
    encoded_len.saturating_add(3) / 4 * 3
}

struct TempImage {
    path: PathBuf,
}

impl TempImage {
    fn write(directory: &Path, extension: &str, bytes: &[u8]) -> std::io::Result<Self> {
        fs::create_dir_all(directory)?;
        for _ in 0..32 {
            let id = NEXT_TEMP_IMAGE.fetch_add(1, Ordering::Relaxed);
            let path = directory.join(format!(
                "chemdraft-ocsr-{}-{id}.{extension}",
                std::process::id()
            ));
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(mut file) => {
                    use std::io::Write;
                    file.write_all(bytes)?;
                    file.sync_all()?;
                    return Ok(Self { path });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "could not allocate a unique temporary image",
        ))
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempImage {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_file(&self.path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!(
                    "[chemdraft ocsr] could not remove temporary image {}: {error}",
                    self.path.display()
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognition_contract_serializes_exact_camel_case_shape() {
        let response = RecognitionResponse::Recognized {
            smiles: "C".to_string(),
            molfile: "mol".to_string(),
            confidence: None,
            atoms: vec![],
            bonds: vec![],
            elapsed_ms: 12,
            engine: RecognitionEngine {
                name: "MolScribe",
                molscribe_commit: pins::MOLSCRIBE_COMMIT,
                model_sha256: pins::MODEL_SHA256,
            },
        };
        let value = serde_json::to_value(response).expect("serialize response");
        assert_eq!(value["status"], "recognized");
        assert_eq!(value["elapsedMs"], 12);
        assert_eq!(value["confidence"], serde_json::Value::Null);
        assert_eq!(value["engine"]["name"], "MolScribe");
    }

    #[test]
    fn status_progress_and_install_error_serialize_the_exact_contract() {
        let status = OcsrEngineStatus {
            state: EngineState::NotInstalled,
            installed: None,
            required_disk_bytes: pins::REQUIRED_DISK_BYTES,
            free_disk_bytes: 7,
            detail: None,
            progress: None,
            install_elapsed_ms: None,
        };
        assert_eq!(
            serde_json::to_value(&status).expect("status"),
            serde_json::json!({
                "state": "notInstalled",
                "requiredDiskBytes": 3_000_000_000_u64,
                "freeDiskBytes": 7,
            })
        );
        let installed = OcsrEngineStatus {
            state: EngineState::Installed,
            installed: Some(InstalledEngine {
                uv_version: pins::UV_VERSION.to_string(),
                python_version: pins::PYTHON_VERSION.to_string(),
                molscribe_commit: pins::MOLSCRIBE_COMMIT.to_string(),
                model_sha256: pins::MODEL_SHA256.to_string(),
                installed_at: "2026-09-24T00:00:00+00:00".to_string(),
                disk_bytes: 1,
            }),
            detail: Some("ok".to_string()),
            ..status
        };
        let value = serde_json::to_value(&installed).expect("installed status");
        assert_eq!(value["state"], "installed");
        assert_eq!(value["detail"], "ok");
        let keys: Vec<_> = value["installed"]
            .as_object()
            .expect("installed object")
            .keys()
            .cloned()
            .collect();
        assert_eq!(
            keys,
            [
                "diskBytes",
                "installedAt",
                "modelSha256",
                "molscribeCommit",
                "pythonVersion",
                "uvVersion"
            ]
        );
        for (state, name) in [
            (EngineState::Installing, "installing"),
            (EngineState::Broken, "broken"),
            (EngineState::Unsupported, "unsupported"),
        ] {
            assert_eq!(serde_json::to_value(state).expect("state"), name);
        }

        let progress = InstallProgress {
            phase: InstallPhase::DownloadingModel,
            message: "m".to_string(),
            bytes_done: Some(1),
            bytes_total: Some(2),
            estimated: false,
        };
        assert_eq!(
            serde_json::to_value(&progress).expect("progress"),
            serde_json::json!({"phase": "downloadingModel", "message": "m", "bytesDone": 1, "bytesTotal": 2})
        );
        let estimate = InstallProgress {
            phase: InstallPhase::InstallingPackages,
            estimated: true,
            ..progress
        };
        let installing = OcsrEngineStatus {
            state: EngineState::Installing,
            installed: None,
            required_disk_bytes: 3,
            free_disk_bytes: 7,
            detail: None,
            progress: Some(estimate),
            install_elapsed_ms: Some(1_500),
        };
        assert_eq!(
            serde_json::to_value(&installing).expect("installing status"),
            serde_json::json!({
                "state": "installing",
                "requiredDiskBytes": 3,
                "freeDiskBytes": 7,
                "progress": {
                    "phase": "installingPackages",
                    "message": "m",
                    "bytesDone": 1,
                    "bytesTotal": 2,
                    "estimated": true
                },
                "installElapsedMs": 1_500
            })
        );
        for (phase, name) in [
            (InstallPhase::CheckingDisk, "checkingDisk"),
            (InstallPhase::DownloadingUv, "downloadingUv"),
            (InstallPhase::InstallingPython, "installingPython"),
            (InstallPhase::InstallingPackages, "installingPackages"),
            (InstallPhase::Verifying, "verifying"),
            (InstallPhase::Done, "done"),
        ] {
            assert_eq!(serde_json::to_value(phase).expect("phase"), name);
        }

        for (error, code) in [
            (
                InstallError {
                    code: InstallErrorCode::InsufficientDisk,
                    message: String::new(),
                },
                "insufficientDisk",
            ),
            (InstallError::network(""), "network"),
            (InstallError::checksum(""), "checksumMismatch"),
            (InstallError::cancelled(), "cancelled"),
            (InstallError::unsupported(""), "unsupported"),
            (InstallError::failed(""), "failed"),
        ] {
            assert_eq!(serde_json::to_value(&error).expect("error")["code"], code);
        }
    }

    #[test]
    fn recognition_failures_and_not_installed_serialize_the_exact_contract() {
        assert_eq!(
            serde_json::to_value(RecognitionResponse::NotInstalled).expect("not installed"),
            serde_json::json!({"status": "notInstalled"})
        );
        for (code, name) in [
            (RecognitionErrorCode::InvalidImage, "invalidImage"),
            (RecognitionErrorCode::RecognitionFailed, "recognitionFailed"),
            (RecognitionErrorCode::EngineCrashed, "engineCrashed"),
            (RecognitionErrorCode::Timeout, "timeout"),
            (RecognitionErrorCode::Busy, "busy"),
        ] {
            assert_eq!(
                serde_json::to_value(failed(code, "why")).expect("failure"),
                serde_json::json!({"status": "failed", "code": name, "message": "why"})
            );
        }
        let atom = RecognizedAtom {
            index: 0,
            symbol: "C".to_string(),
            x: Some(0.5),
            y: None,
            confidence: None,
        };
        let bond = RecognizedBond {
            begin: 0,
            end: 1,
            bond_type: "single".to_string(),
            confidence: Some(0.9),
        };
        assert_eq!(
            serde_json::to_value(atom).expect("atom"),
            serde_json::json!({"index": 0, "symbol": "C", "x": 0.5, "y": null, "confidence": null})
        );
        assert_eq!(
            serde_json::to_value(bond).expect("bond"),
            serde_json::json!({"begin": 0, "end": 1, "bondType": "single", "confidence": 0.9})
        );
    }

    #[test]
    fn media_types_and_size_guard_are_strict() {
        assert!(is_supported_media_type("image/png"));
        assert!(is_supported_media_type("IMAGE/JPEG; charset=binary"));
        assert!(!is_supported_media_type("image/svg+xml"));
        assert!(!is_supported_media_type("application/octet-stream"));
        for len in 0..64 {
            let encoded = base64::engine::general_purpose::STANDARD.encode(vec![0_u8; len]);
            let bound = decoded_size_upper_bound(encoded.len());
            assert!(bound >= len && bound <= len + 2, "len {len}");
        }
    }

    fn encoded(format: ImageFormat) -> Vec<u8> {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(3, 2)
            .write_to(&mut bytes, format)
            .expect("encode fixture");
        bytes.into_inner()
    }

    #[test]
    fn images_are_decoded_and_gif_becomes_png() {
        let png = encoded(ImageFormat::Png);
        let (extension, bytes) = prepare_image(&png).expect("png");
        assert_eq!(extension, "png");
        assert!(matches!(bytes, Cow::Borrowed(_)));

        let jpeg = encoded(ImageFormat::Jpeg);
        let (extension, _) = prepare_image(&jpeg).expect("jpeg");
        assert_eq!(extension, "jpg");

        let gif = encoded(ImageFormat::Gif);
        let (extension, bytes) = prepare_image(&gif).expect("gif");
        assert_eq!(extension, "png");
        assert_eq!(
            image::guess_format(&bytes).expect("converted"),
            ImageFormat::Png
        );

        assert!(prepare_image(b"not an image").is_err());
        let mut truncated = png.clone();
        truncated.truncate(png.len() / 2);
        assert!(prepare_image(&truncated).is_err());
    }

    #[test]
    fn temporary_images_are_deleted_on_drop() {
        let root =
            std::env::temp_dir().join(format!("chemdraft-ocsr-temp-test-{}", std::process::id()));
        let temp = TempImage::write(&root, "png", b"fixture").expect("temp image");
        let path = temp.path().to_path_buf();
        assert!(path.exists());
        drop(temp);
        assert!(!path.exists());
        let _ = fs::remove_dir(root);
    }

    #[test]
    fn ocsr_capability_is_main_window_only_and_grants_every_command() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../../capabilities/ocsr-engine.json"))
                .expect("OCSR capability JSON");
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        let permissions = capability["permissions"]
            .as_array()
            .expect("permission array");
        for permission in [
            "allow-ocsr-engine-status",
            "allow-ocsr-engine-install",
            "allow-ocsr-engine-cancel-install",
            "allow-ocsr-engine-uninstall",
            "allow-ocsr-recognize-image",
        ] {
            assert!(
                permissions.iter().any(|item| item == permission),
                "missing {permission}"
            );
        }
    }

    #[test]
    fn bundled_requirements_match_reviewed_constraints() {
        let requirements = include_str!("../../resources/ocsr/requirements.txt");
        for pin in [
            format!("numpy{}", pins::NUMPY_CONSTRAINT),
            format!("torch{}", pins::TORCH_CONSTRAINT),
            format!("torchvision{}", pins::TORCHVISION_CONSTRAINT),
            pins::MOLSCRIBE_SOURCE_URL.to_string(),
        ] {
            assert!(
                requirements.lines().any(|line| line == pin),
                "missing {pin}"
            );
        }
    }
}
