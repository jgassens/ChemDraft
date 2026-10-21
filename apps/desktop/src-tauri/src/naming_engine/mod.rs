//! Host-owned optional Orthonym adapter. Installation and process lifetime live in local_engine;
//! exact-structure acceptance and canonicalization live in document-workflow-core (TypeScript).
mod install;
mod pins;
mod process;
mod protocol;
mod receipt;

use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, TryLockError,
    },
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, Manager, Runtime};

use crate::local_engine::{
    self,
    install::{InstallPaths, RunningChild, RECEIPT_FILE},
    process::{
        cancel_request, enter_request, lock_ignoring_poison as lock, stop_sidecar_blocking,
        KillSwitch,
    },
    EngineSpec, InstallError, InstallProgress,
};
use install::{NamingSpec, SystemInstallIo};
use process::{LaunchPaths, ProcessError, ProcessManager};
use receipt::InstallReceipt;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EngineStatus {
    NotInstalled,
    Installing,
    Installed,
    Broken,
    Unsupported,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamingEngineStatus {
    pub state: EngineStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed: Option<InstallReceipt>,
    pub required_disk_bytes: u64,
    pub free_disk_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<InstallProgress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_elapsed_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamingError {
    pub code: &'static str,
    pub message: String,
}
fn failure(code: &'static str, message: impl Into<String>) -> NamingError {
    NamingError {
        code,
        message: message.into(),
    }
}
impl From<ProcessError> for NamingError {
    fn from(error: ProcessError) -> Self {
        match error {
            ProcessError::InvalidSmiles(message) => failure("invalidSmiles", message),
            ProcessError::NamingFailed(message) => failure("namingFailed", message),
            ProcessError::Crashed(message) => failure("engineCrashed", message),
            ProcessError::Timeout => failure(
                "timeout",
                "The naming engine exceeded its 60 second startup or 30 second request limit.",
            ),
            ProcessError::Cancelled => failure("cancelled", "Naming cancelled."),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NameStructureRaw {
    #[serde(flatten)]
    pub result: protocol::RawResult,
    /// None when there was no non-empty name to read. A read failure preserves the raw result.
    pub opsin_read_back: Option<crate::opsin::OpsinConversion>,
}

struct Snapshot {
    started: Instant,
    progress: Option<InstallProgress>,
}
struct SharedState {
    installing: AtomicBool,
    cancel_install: AtomicBool,
    snapshot: Mutex<Option<Snapshot>>,
    install_child: Arc<RunningChild>,
    registry: local_engine::EngineRegistry,
    stop_reaper: Arc<AtomicBool>,
    shut_down: AtomicBool,
    request_gate: Mutex<()>,
    process: Arc<Mutex<ProcessManager>>,
    kill: KillSwitch,
    cancels: AtomicU64,
}

pub struct NamingEngineState {
    inner: Arc<SharedState>,
}
impl Default for NamingEngineState {
    fn default() -> Self {
        let process = ProcessManager::system();
        Self {
            inner: Arc::new(SharedState {
                installing: AtomicBool::new(false),
                cancel_install: AtomicBool::new(false),
                snapshot: Mutex::new(None),
                install_child: Arc::default(),
                registry: local_engine::EngineRegistry::default(),
                stop_reaper: Arc::new(AtomicBool::new(false)),
                shut_down: AtomicBool::new(false),
                request_gate: Mutex::new(()),
                kill: process.kill_switch(),
                process: Arc::new(Mutex::new(process)),
                cancels: AtomicU64::new(0),
            }),
        }
    }
}
impl NamingEngineState {
    pub fn start_idle_reaper(&self) {
        local_engine::process::start_idle_reaper(
            self.inner.stop_reaper.clone(),
            self.inner.process.clone(),
        );
    }
    pub fn remove_stale_staging<R: Runtime>(&self, app: &tauri::AppHandle<R>) {
        let (Ok(paths), Ok(platform)) = (install_paths(app), install::current_platform()) else {
            return;
        };
        let state = self.inner.clone();
        std::thread::spawn(move || {
            let _staging = lock(&state.registry.staging);
            if !state.installing.load(Ordering::SeqCst) {
                local_engine::install::remove_stale_staging::<NamingSpec>(
                    &paths,
                    platform.as_ref(),
                );
            }
        });
    }
    pub fn shutdown(&self) {
        let state = &self.inner;
        if state.shut_down.swap(true, Ordering::SeqCst) {
            return;
        }
        state.stop_reaper.store(true, Ordering::SeqCst);
        state.cancel_install.store(true, Ordering::SeqCst);
        state.install_child.kill_tree();
        match state.process.try_lock() {
            Ok(mut process) => process.stop(),
            Err(TryLockError::Poisoned(error)) => error.into_inner().stop(),
            Err(TryLockError::WouldBlock) => state.kill.kill_now(),
        }
    }
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn kill_for_forced_exit(&self) {
        self.inner.cancel_install.store(true, Ordering::SeqCst);
        self.inner.install_child.kill_tree();
        self.inner.kill.kill_now();
        self.shutdown();
    }
}
impl Drop for NamingEngineState {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn status(state: EngineStatus, free: u64, detail: Option<String>) -> NamingEngineStatus {
    NamingEngineStatus {
        state,
        installed: None,
        required_disk_bytes: pins::REQUIRED_DISK_BYTES,
        free_disk_bytes: free,
        detail,
        progress: None,
        install_elapsed_ms: None,
    }
}

fn installed_status(
    root: &Path,
    platform: &dyn local_engine::platform::EnginePlatform,
    free: u64,
) -> NamingEngineStatus {
    if !root.exists() {
        return status(EngineStatus::NotInstalled, free, None);
    }
    let checked = receipt::read_receipt(&root.join(RECEIPT_FILE)).and_then(|receipt| {
        if !receipt.matches_pins(platform) {
            return Err(
                "The naming engine pins differ from this build. Install the engine again.".into(),
            );
        }
        NamingSpec::verify_layout(root, platform).map_err(|error| error.message)?;
        Ok(receipt)
    });
    match checked {
        Ok(receipt) => NamingEngineStatus {
            installed: Some(receipt),
            ..status(EngineStatus::Installed, free, None)
        },
        Err(detail) => status(EngineStatus::Broken, free, Some(detail)),
    }
}

fn status_impl<R: Runtime>(app: &tauri::AppHandle<R>, state: &SharedState) -> NamingEngineStatus {
    let paths = match install_paths(app) {
        Ok(paths) => paths,
        Err(error) => return status(EngineStatus::Broken, 0, Some(error.message)),
    };
    let free = free_disk(&paths.app_data);
    let platform = match install::current_platform() {
        Ok(platform) => platform,
        Err(detail) => return status(EngineStatus::Unsupported, free, Some(detail)),
    };
    if state.installing.load(Ordering::SeqCst) {
        let mut result = status(EngineStatus::Installing, free, None);
        if let Some(snapshot) = lock(&state.snapshot).as_ref() {
            result.progress = snapshot.progress.clone();
            result.install_elapsed_ms =
                Some(u64::try_from(snapshot.started.elapsed().as_millis()).unwrap_or(u64::MAX));
        }
        return result;
    }
    installed_status(
        &paths.final_dir_for::<NamingSpec>(),
        platform.as_ref(),
        free,
    )
}

#[tauri::command]
pub fn naming_engine_status<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, NamingEngineState>,
) -> NamingEngineStatus {
    status_impl(&app, &state.inner)
}

struct ResetOperation(Arc<SharedState>);
impl Drop for ResetOperation {
    fn drop(&mut self) {
        *lock(&self.0.snapshot) = None;
        self.0.installing.store(false, Ordering::SeqCst);
    }
}

#[tauri::command]
pub async fn naming_engine_install<R: Runtime>(
    app: tauri::AppHandle<R>,
    on_progress: Channel<InstallProgress>,
) -> Result<NamingEngineStatus, InstallError> {
    let paths = install_paths(&app)?;
    let platform = install::current_platform().map_err(InstallError::unsupported)?;
    let state = app.state::<NamingEngineState>().inner.clone();
    if state.shut_down.load(Ordering::SeqCst) {
        return Err(InstallError::failed("ChemDraft is quitting."));
    }
    if state
        .installing
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(InstallError::failed(
            "A naming engine installation or removal is already running.",
        ));
    }
    let reset = ResetOperation(state.clone());
    state.cancel_install.store(false, Ordering::SeqCst);
    *lock(&state.snapshot) = Some(Snapshot {
        started: Instant::now(),
        progress: None,
    });
    tauri::async_runtime::spawn_blocking(move || {
        let _reset = reset;
        stop_sidecar_blocking(&state.process, &state.kill);
        let _staging = lock(&state.registry.staging);
        let free = free_disk(&paths.app_data);
        let io = SystemInstallIo::new(state.install_child.clone())?;
        let throttle = Mutex::new(local_engine::progress::ProgressThrottle::new(
            local_engine::progress::EMIT_INTERVAL,
        ));
        let reporter = |progress: InstallProgress| {
            if let Some(snapshot) = lock(&state.snapshot).as_mut() {
                snapshot.progress = Some(progress.clone());
            }
            if lock(&throttle).admit(&progress, Instant::now()) {
                let _ = on_progress.send(progress);
            }
        };
        local_engine::install::install::<NamingSpec>(
            &paths,
            platform.as_ref(),
            &io,
            &state.cancel_install,
            &reporter,
            free,
        )
    })
    .await
    .map_err(|error| {
        InstallError::failed(format!("Could not schedule naming installation: {error}"))
    })??;
    Ok(status_impl(&app, &app.state::<NamingEngineState>().inner))
}

#[tauri::command]
pub fn naming_engine_cancel_install(state: tauri::State<'_, NamingEngineState>) {
    state.inner.cancel_install.store(true, Ordering::SeqCst);
    state.inner.install_child.kill_tree();
}

#[tauri::command]
pub async fn naming_engine_uninstall<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<NamingEngineStatus, InstallError> {
    let paths = install_paths(&app)?;
    let state = app.state::<NamingEngineState>().inner.clone();
    state.cancel_install.store(true, Ordering::SeqCst);
    state.install_child.kill_tree();
    tauri::async_runtime::spawn_blocking(move || {
        // Own the operation flag too, so no request restarts the sidecar after it has stopped.
        while state
            .installing
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            std::thread::sleep(Duration::from_millis(50));
        }
        let _reset = ResetOperation(state.clone());
        stop_sidecar_blocking(&state.process, &state.kill);
        let _staging = lock(&state.registry.staging);
        local_engine::install::remove_engine_trees::<NamingSpec>(&paths).map_err(|(path, error)| {
            InstallError::failed(format!("Could not remove {}: {error}", path.display()))
        })
    })
    .await
    .map_err(|error| {
        InstallError::failed(format!("Could not schedule naming engine removal: {error}"))
    })??;
    Ok(status_impl(&app, &app.state::<NamingEngineState>().inner))
}

#[tauri::command]
pub fn naming_cancel(state: tauri::State<'_, NamingEngineState>) {
    cancel_request(&state.inner.cancels, &state.inner.kill);
}

fn read_back(result: protocol::RawResult, launch: &LaunchPaths) -> NameStructureRaw {
    let opsin_read_back = result
        .name
        .as_ref()
        .filter(|name| !name.trim().is_empty())
        .map(|name| {
            crate::opsin::convert_with_options(
                &process::java_executable(&launch.jre),
                &launch.opsin,
                name,
                crate::opsin::OpsinOptions { radicals: true },
            )
            .unwrap_or_else(|error| crate::opsin::OpsinConversion {
                smiles: None,
                failure_reason: Some(error.message),
            })
        });
    NameStructureRaw {
        result,
        opsin_read_back,
    }
}

#[tauri::command]
pub async fn name_structure_raw<R: Runtime>(
    app: tauri::AppHandle<R>,
    smiles: String,
) -> Result<NameStructureRaw, NamingError> {
    // Refuse oversized or malformed input before status IO, and certainly before spawning.
    protocol::validate_smiles(&smiles)?;
    let state = app.state::<NamingEngineState>().inner.clone();
    let cancels_at_start = state.cancels.load(Ordering::SeqCst);
    let paths = install_paths(&app).map_err(|error| failure("engineCrashed", error.message))?;
    let platform = install::current_platform().map_err(|detail| failure("notInstalled", detail))?;
    let root = paths.final_dir_for::<NamingSpec>();
    let launch = LaunchPaths {
        python: platform.venv_python(&root),
        engine: root,
        sidecar: required_resource(&app, "resources/naming/orthonym_sidecar.py")?,
        jre: required_resource(&app, "resources/opsin/jre")?,
        opsin: required_resource(&app, "resources/opsin/opsin-cli-2.9.0.jar")?,
    };
    tauri::async_runtime::spawn_blocking(move || {
        let Some(_request) = enter_request(&state.request_gate) else {
            return Err(failure(
                "busy",
                "The naming engine is already naming another structure.",
            ));
        };
        let cancelled = || state.cancels.load(Ordering::SeqCst) != cancels_at_start;
        let raw = {
            let mut manager = lock(&state.process);
            if cancelled() {
                return Err(failure("cancelled", "Naming cancelled."));
            }
            if state.shut_down.load(Ordering::SeqCst) {
                return Err(failure("engineCrashed", "ChemDraft is quitting."));
            }
            if state.installing.load(Ordering::SeqCst) {
                return Err(failure(
                    "notInstalled",
                    "The naming engine is being installed or removed.",
                ));
            }
            let status = installed_status(&launch.engine, platform.as_ref(), 0);
            match status.state {
                EngineStatus::Installed => {}
                EngineStatus::Broken => {
                    return Err(failure("engineCrashed", status.detail.unwrap_or_default()))
                }
                _ => return Err(failure("notInstalled", "Install the naming engine first.")),
            }
            match manager.recognize_with(
                platform.as_ref(),
                &launch,
                &smiles,
                process::REQUEST_TIMEOUT,
                &|()| {},
                &cancelled,
            ) {
                Err(ProcessError::Cancelled) if !cancelled() => {
                    return Err(failure(
                        "engineCrashed",
                        "The naming engine was stopped for app exit, installation or removal.",
                    ))
                }
                other => other?,
            }
        };
        let response = read_back(raw, &launch);
        if cancelled() {
            return Err(failure("cancelled", "Naming cancelled."));
        }
        Ok(response)
    })
    .await
    .map_err(|error| {
        failure(
            "engineCrashed",
            format!("Could not schedule naming: {error}"),
        )
    })?
}

fn install_paths<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<InstallPaths, InstallError> {
    Ok(InstallPaths {
        app_data: app
            .path()
            .app_data_dir()
            .map_err(|error| InstallError::failed(format!("No app data directory: {error}")))?,
        requirements: resource_path(app, NamingSpec::requirements().0).ok_or_else(|| {
            InstallError::failed("The naming requirements lock is missing from this build.")
        })?,
    })
}

fn required_resource<R: Runtime>(
    app: &tauri::AppHandle<R>,
    relative: &str,
) -> Result<PathBuf, NamingError> {
    resource_path(app, relative).ok_or_else(|| {
        failure(
            "engineCrashed",
            format!("Bundled naming resource missing: {relative}"),
        )
    })
}

fn resource_path<R: Runtime>(app: &tauri::AppHandle<R>, relative: &str) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(root) = app.path().resource_dir() {
        candidates.push(root.join(relative));
    }
    if cfg!(debug_assertions) {
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative));
    }
    candidates
        .into_iter()
        .find(|path| path.exists())
        .map(without_verbatim_drive_prefix)
}

// JNI and java must receive ordinary drive paths, just as the vendored OPSIN launcher does.
fn without_verbatim_drive_prefix(path: PathBuf) -> PathBuf {
    if let Some(rest) = path.to_str().and_then(|text| text.strip_prefix(r"\\?\")) {
        if rest.as_bytes().get(1) == Some(&b':') {
            return PathBuf::from(rest);
        }
    }
    path
}

fn free_disk(path: &Path) -> u64 {
    let mut ancestor = path;
    while !ancestor.exists() {
        match ancestor.parent() {
            Some(parent) => ancestor = parent,
            None => return 0,
        }
    }
    local_engine::platform::free_disk_bytes(ancestor).unwrap_or(0)
}

#[cfg(test)]
mod tests;
