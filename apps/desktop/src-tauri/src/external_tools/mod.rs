//! Host-owned external CLI runner and main-window-only Tauri boundary.
#![allow(dead_code)] // Some catalog/platform helpers are exercised on the other platform or by tests.
pub mod catalog;
pub mod consent;
pub mod env;
pub mod install;
#[cfg(test)]
mod install_tests;
pub mod pins;
pub mod probe;
pub mod run;
pub mod terminal;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod wire_tests;

use crate::{
    assistant_mcp::session::{self, BindError, RunBinding},
    local_engine::InstallError,
};
use catalog::{identifier, Effort, RenderedRun, ToolId};
use run::{KillReason, ToolRun};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{ipc::Channel, Manager, Runtime};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolState {
    Installed,
    Missing,
    Broken,
    Installing,
    Unsupported,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolSource {
    User,
    Managed,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedTool {
    pub version: String,
    pub path: PathBuf,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolInstallPhase {
    CheckingDisk,
    Downloading,
    Verifying,
    Installing,
    Done,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInstallProgress {
    pub phase: ToolInstallPhase,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_done: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_total: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalToolStatus {
    pub tool: ToolId,
    pub publisher: String,
    pub state: ToolState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<ToolSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub pinned_version: String,
    pub pinned_download_bytes: u64,
    pub free_disk_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub managed: Option<ManagedTool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signed_in: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<ToolInstallProgress>,
    pub can_install: bool,
    pub consented: bool,
    pub probed_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalToolRunRequest {
    pub tool: ToolId,
    pub plugin_id: String,
    pub conversation_id: String,
    pub prompt: String,
    pub system_prompt: String,
    pub resume_id: Option<String>,
    pub model: Option<String>,
    pub effort: Option<Effort>,
    #[serde(default)]
    pub mcp_session_id: String,
    pub timeout_ms: Option<u64>,
}
impl ExternalToolRunRequest {
    pub fn validate(&self) -> Result<(), ExternalToolRunError> {
        if !valid_plugin_id(&self.plugin_id)
            || !identifier(&self.conversation_id, 8, 64)
            || self.prompt.len() > 32 * 1024
            || self.system_prompt.len() > 64 * 1024
            || self
                .resume_id
                .as_ref()
                .is_some_and(|s| !identifier(s, 1, 128))
            || self.model.as_ref().is_some_and(|s| {
                s.is_empty()
                    || s.len() > 64
                    || !s
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b".-".contains(&b))
            })
            || (!self.mcp_session_id.is_empty() && !identifier(&self.mcp_session_id, 1, 128))
            || self
                .timeout_ms
                .is_some_and(|n| !(1000..=1_800_000).contains(&n))
        {
            return Err(ExternalToolRunError::new(
                RunErrorCode::InvalidArgs,
                "Invalid external tool run request.",
            ));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalToolRunStarted {
    pub run_id: String,
    pub pid: u32,
    pub cwd: PathBuf,
    pub started_at: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunErrorCode {
    NotInstalled,
    NotConsented,
    Busy,
    InvalidArgs,
    UnknownRun,
    NotOwner,
    SpawnFailed,
    Limit,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalToolRunError {
    pub code: RunErrorCode,
    pub message: String,
}
impl ExternalToolRunError {
    pub fn new(code: RunErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub struct OwnedRun {
    pub tool: ToolId,
    pub plugin_id: String,
    pub conversation_id: String,
    pub mcp_session_id: String,
    pub run: Arc<ToolRun>,
}
#[derive(Default)]
pub struct ExternalToolsInner {
    pub runs: HashMap<String, OwnedRun>,
    pub active_by_tool: HashMap<ToolId, String>,
    pub conversations: HashMap<(String, String), PathBuf>,
    shutting_down: bool,
}
#[derive(Default)]
pub struct ExternalToolsState {
    pub inner: Mutex<ExternalToolsInner>,
    pub probes: probe::ProbeCache,
    installing: AtomicBool,
    cancel_install: AtomicBool,
    install_snapshot: Mutex<Option<(ToolId, Option<ToolInstallProgress>)>>,
    /// Serializes filesystem mutations, consent replacement and run starts/clears.
    mutation: Mutex<()>,
    consent_lock: Mutex<()>,
}
impl ExternalToolsState {
    /// The command layer must check permissions/consent and render a host-owned template first.
    pub fn start(
        &self,
        base: &Path,
        request: &ExternalToolRunRequest,
        rendered: RenderedRun,
        parent: &env::ParentEnv,
        managed: bool,
    ) -> Result<ExternalToolRunStarted, ExternalToolRunError> {
        self.start_bound(base, request, rendered, parent, managed, None)
    }
    fn start_bound(
        &self,
        base: &Path,
        request: &ExternalToolRunRequest,
        rendered: RenderedRun,
        parent: &env::ParentEnv,
        managed: bool,
        binding: Option<RunBinding>,
    ) -> Result<ExternalToolRunStarted, ExternalToolRunError> {
        request.validate()?;
        let run_id = binding
            .as_ref()
            .map(|b| b.run_id.clone())
            .unwrap_or_else(nonce);
        let mut state = self.inner.lock().unwrap();
        if state.shutting_down {
            return Err(ExternalToolRunError::new(
                RunErrorCode::Limit,
                "External tools are shutting down.",
            ));
        }
        state.runs.retain(|_, entry| !entry.run.removable());
        let live: std::collections::HashSet<_> = state
            .runs
            .iter()
            .filter(|(_, entry)| entry.run.status().is_running())
            .map(|(id, _)| id.clone())
            .collect();
        state.active_by_tool.retain(|_, id| live.contains(id));
        if state.active_by_tool.contains_key(&request.tool) {
            return Err(ExternalToolRunError::new(
                RunErrorCode::Busy,
                "This tool already has an active run.",
            ));
        }
        let key = (request.plugin_id.clone(), request.conversation_id.clone());
        if !state.conversations.contains_key(&key)
            && state
                .conversations
                .keys()
                .filter(|(plugin, _)| plugin == &request.plugin_id)
                .count()
                >= 8
        {
            return Err(ExternalToolRunError::new(
                RunErrorCode::Limit,
                "At most eight conversations are kept per plugin.",
            ));
        }
        let cwd = conversation_dir(base, &request.plugin_id, &request.conversation_id)
            .map_err(|e| ExternalToolRunError::new(RunErrorCode::SpawnFailed, e.to_string()))?;
        let environment = env::child_env(
            probe::ProbePlatform::current(),
            parent,
            &rendered.program,
            &cwd,
            managed,
        );
        let run = ToolRun::spawn_bound(
            rendered,
            &cwd,
            &environment,
            Duration::from_millis(request.timeout_ms.unwrap_or(600_000)),
            binding,
        )
        .map_err(|e| ExternalToolRunError::new(RunErrorCode::SpawnFailed, e))?;
        let started = ExternalToolRunStarted {
            run_id: run_id.clone(),
            pid: run.pid,
            cwd: cwd.clone(),
            started_at: run.started_at.clone(),
        };
        state.conversations.insert(key, cwd);
        state.active_by_tool.insert(request.tool, run_id.clone());
        state.runs.insert(
            run_id,
            OwnedRun {
                tool: request.tool,
                plugin_id: request.plugin_id.clone(),
                conversation_id: request.conversation_id.clone(),
                mcp_session_id: request.mcp_session_id.clone(),
                run,
            },
        );
        Ok(started)
    }
    pub fn owned_run(
        &self,
        id: &str,
        plugin_id: &str,
    ) -> Result<Arc<ToolRun>, ExternalToolRunError> {
        let state = self.inner.lock().unwrap();
        let entry = state.runs.get(id).ok_or_else(|| {
            ExternalToolRunError::new(RunErrorCode::UnknownRun, "Unknown external tool run.")
        })?;
        if entry.plugin_id != plugin_id {
            return Err(ExternalToolRunError::new(
                RunErrorCode::NotOwner,
                "Run belongs to a different plugin.",
            ));
        }
        Ok(entry.run.clone())
    }
    pub fn shutdown(&self) {
        self.cancel_install.store(true, Ordering::SeqCst);
        let (runs, dirs) = {
            let mut state = self.inner.lock().unwrap();
            state.shutting_down = true;
            (
                state
                    .runs
                    .values()
                    .map(|e| e.run.clone())
                    .collect::<Vec<_>>(),
                state.conversations.values().cloned().collect::<Vec<_>>(),
            )
        };
        for run in &runs {
            run.cancel(KillReason::AppExit);
        }
        for run in &runs {
            run.wait_finished(Duration::from_secs(5));
        }
        for dir in dirs {
            let _ = fs::remove_dir_all(dir);
        }
    }
}
pub(crate) fn valid_plugin_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        && id != "."
        && id != ".."
}
pub fn conversation_dir(base: &Path, plugin: &str, conversation: &str) -> std::io::Result<PathBuf> {
    if !valid_plugin_id(plugin) || !identifier(conversation, 8, 64) {
        return Err(std::io::ErrorKind::InvalidInput.into());
    }
    private_dir(base)?;
    let mut dir = base.to_owned();
    for part in ["runs", plugin, conversation] {
        dir.push(part);
        if fs::symlink_metadata(&dir).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(std::io::ErrorKind::InvalidInput.into());
        }
        private_dir(&dir)?;
    }
    Ok(dir)
}
pub(crate) fn private_dir(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    fs::create_dir_all(path)?;
    Ok(())
}
pub(crate) fn nonce() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    format!(
        "{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}
pub fn remove_stale_runs(base: &Path) -> std::io::Result<()> {
    let runs = base.join("runs");
    match fs::symlink_metadata(&runs) {
        Ok(m) if m.file_type().is_symlink() => fs::remove_file(runs),
        Ok(_) => fs::remove_dir_all(runs),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

fn base_dir<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|p| p.join("external-tools"))
        .map_err(|e| e.to_string())
}

fn current_platform() -> Option<pins::ToolPlatform> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some(pins::ToolPlatform::DarwinArm64),
        ("macos", "x86_64") => Some(pins::ToolPlatform::DarwinX64),
        ("windows", "x86_64") => Some(pins::ToolPlatform::WindowsX64),
        _ => None,
    }
}

fn status_impl(
    base: &Path,
    state: &ExternalToolsState,
    tool: ToolId,
    refresh: bool,
    plugin_id: Option<&str>,
    parent: &env::ParentEnv,
) -> Result<ExternalToolStatus, String> {
    let platform = current_platform();
    let pin = pins::pin_for(tool, platform.unwrap_or(pins::ToolPlatform::DarwinArm64));
    let mut status = install::managed_status(base, pin);
    {
        let _consent = state.consent_lock.lock().unwrap();
        status.consented = match plugin_id {
            Some(id) if valid_plugin_id(id) => consent::ConsentStore::new(base)
                .get(tool, id)
                .map_err(|e| e.to_string())?,
            Some(_) => return Err("Invalid plugin id.".into()),
            None => false,
        };
    }
    if platform.is_none() {
        status.state = ToolState::Unsupported;
        status.pinned_download_bytes = 0;
        status.can_install = false;
        status.detail = Some("External tools are unsupported on this platform.".into());
        return Ok(status);
    }
    if let Some((installing_tool, progress)) = state.install_snapshot.lock().unwrap().as_ref() {
        if *installing_tool == tool {
            status.state = ToolState::Installing;
            status.progress = progress.clone();
            return Ok(status);
        }
    }
    let result = state.probes.get_or_probe(tool, refresh, || {
        let run_dir = base.join("probes");
        private_dir(&run_dir).map_err(|e| e.to_string())?;
        let probe_platform = probe::ProbePlatform::current();
        let home = env::get(parent, if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or("");
        let mut paths = probe::candidate_paths(tool, probe_platform, Path::new(home), parent, None);
        let mut candidate = probe::resolve_candidates(&paths, |p| p.is_file());
        if probe_platform == probe::ProbePlatform::MacOS && !matches!(candidate, probe::Candidate::Runnable(_)) {
            if let Some(shell) = env::get(parent, "SHELL") {
                if let Ok(path) = state.probes.login_path.capture(Path::new(shell), parent, &run_dir) {
                    paths = probe::candidate_paths(tool, probe_platform, Path::new(home), parent, Some(&path));
                    candidate = probe::resolve_candidates(&paths, |p| p.is_file());
                }
            }
        }
        let user = match candidate {
            probe::Candidate::Runnable(path) => Some(probe::probe_tool(&tool.spec(), &path, parent, &run_dir, false)),
            probe::Candidate::ShimNeedsResolution(_) => Some(Err("A .cmd/.bat shim needs resolution to a native executable; install the vendor's native CLI.".into())),
            probe::Candidate::Missing => None,
        };
        if let Some(Ok(result)) = user.as_ref() { return Ok(result.clone()); }
        if let Some(managed) = status.managed.as_ref() {
            return probe::probe_tool(&tool.spec(), &managed.path, parent, &run_dir, true);
        }
        user.unwrap_or_else(|| Err(status.detail.clone().unwrap_or_else(|| "Tool is not installed.".into())))
    });
    match result {
        Ok(result) => {
            status.state = ToolState::Installed;
            status.source = Some(
                if status
                    .managed
                    .as_ref()
                    .is_some_and(|m| m.path == result.path)
                {
                    ToolSource::Managed
                } else {
                    ToolSource::User
                },
            );
            status.path = Some(result.path);
            status.version = Some(result.version);
            status.signed_in = Some(result.auth.signed_in);
            status.auth_method = result.auth.auth_method;
            status.probed_at = result.probed_at;
            status.detail = result.auth.detail;
        }
        Err(detail) => {
            status.state = if detail == "Tool is not installed." {
                ToolState::Missing
            } else {
                ToolState::Broken
            };
            status.detail = Some(detail);
        }
    }
    // An install may have begun while a slow probe was running.
    if let Some((active, progress)) = state.install_snapshot.lock().unwrap().as_ref() {
        if *active == tool {
            status.state = ToolState::Installing;
            status.progress = progress.clone();
        }
    }
    Ok(status)
}

#[tauri::command]
pub async fn external_tool_status<R: Runtime>(
    app: tauri::AppHandle<R>,
    tool: ToolId,
    refresh: Option<bool>,
    plugin_id: Option<String>,
) -> Result<ExternalToolStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        status_impl(
            &base_dir(&app)?,
            &app.state::<ExternalToolsState>(),
            tool,
            refresh.unwrap_or(false),
            plugin_id.as_deref(),
            &std::env::vars().collect(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

struct ResetInstall<'a>(&'a ExternalToolsState);
impl Drop for ResetInstall<'_> {
    fn drop(&mut self) {
        *self.0.install_snapshot.lock().unwrap() = None;
        self.0.installing.store(false, Ordering::SeqCst);
    }
}
impl ExternalToolsState {
    fn begin_install(&self, tool: ToolId) -> Result<ResetInstall<'_>, InstallError> {
        let inner = self.inner.lock().unwrap();
        if inner.shutting_down {
            return Err(InstallError::failed("External tools are shutting down."));
        }
        if self
            .installing
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(InstallError::failed(
                "An external tool installation is already running.",
            ));
        }
        self.cancel_install.store(false, Ordering::SeqCst);
        *self.install_snapshot.lock().unwrap() = Some((tool, None));
        Ok(ResetInstall(self))
    }
    fn stop_runs(&self, tool: ToolId, conversation: Option<(&str, &str)>) -> Result<(), String> {
        let runs: Vec<_> = self
            .inner
            .lock()
            .unwrap()
            .runs
            .values()
            .filter(|e| {
                e.tool == tool
                    && conversation.is_none_or(|(p, c)| e.plugin_id == p && e.conversation_id == c)
            })
            .map(|e| e.run.clone())
            .collect();
        for run in &runs {
            run.cancel(KillReason::Cancelled);
        }
        for run in runs {
            if !run.wait_finished(Duration::from_secs(5)) {
                return Err("External tool did not stop; its files were retained.".into());
            }
        }
        Ok(())
    }
    fn run_by_id(&self, id: &str) -> Result<Arc<ToolRun>, ExternalToolRunError> {
        let mut inner = self.inner.lock().unwrap();
        inner.runs.retain(|_, entry| !entry.run.removable());
        inner.runs.get(id).map(|e| e.run.clone()).ok_or_else(|| {
            ExternalToolRunError::new(RunErrorCode::UnknownRun, "Unknown external tool run.")
        })
    }
}

#[tauri::command]
pub async fn external_tool_install<R: Runtime>(
    app: tauri::AppHandle<R>,
    tool: ToolId,
    on_progress: Channel<ToolInstallProgress>,
) -> Result<ManagedTool, InstallError> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = base_dir(&app).map_err(InstallError::failed)?;
        let pin = pins::pin_for(
            tool,
            current_platform()
                .ok_or_else(|| InstallError::unsupported("Unsupported external tool platform."))?,
        );
        let state = app.state::<ExternalToolsState>();
        let _reset = state.begin_install(tool)?;
        let _mutation = state.mutation.lock().unwrap();
        state.stop_runs(tool, None).map_err(InstallError::failed)?;
        let result = install::install(
            &base,
            pin,
            &std::env::vars().collect(),
            &state.cancel_install,
            &install::SystemSignatureChecker,
            |progress| {
                *state.install_snapshot.lock().unwrap() = Some((tool, Some(progress.clone())));
                let _ = on_progress.send(progress);
            },
        );
        state.probes.invalidate(tool);
        result
    })
    .await
    .map_err(|e| InstallError::failed(e.to_string()))?
}

#[tauri::command]
pub fn external_tool_cancel_install(state: tauri::State<'_, ExternalToolsState>, tool: ToolId) {
    if state
        .install_snapshot
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|(active, _)| *active == tool)
    {
        state.cancel_install.store(true, Ordering::SeqCst);
    }
}

fn uninstall_impl(base: &Path, state: &ExternalToolsState, tool: ToolId) -> Result<(), String> {
    let _mutation = state.mutation.lock().unwrap();
    if state.installing.load(Ordering::SeqCst) {
        return Err("An external tool installation is running.".into());
    }
    state.stop_runs(tool, None)?;
    let root = base.join(tool.as_str());
    // Never follow a substituted managed root into a user's installation.
    match fs::symlink_metadata(&root) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err("Managed tool directory must not be a symbolic link.".into())
        }
        Ok(_) => fs::remove_dir_all(root).map_err(|e| e.to_string())?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(e.to_string()),
    }
    state.probes.invalidate(tool);
    Ok(())
}

#[tauri::command]
pub async fn external_tool_uninstall<R: Runtime>(
    app: tauri::AppHandle<R>,
    tool: ToolId,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        uninstall_impl(&base_dir(&app)?, &app.state::<ExternalToolsState>(), tool)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn external_tool_sign_in<R: Runtime>(
    app: tauri::AppHandle<R>,
    tool: ToolId,
) -> Result<terminal::SignInLaunch, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = base_dir(&app)?;
        let state = app.state::<ExternalToolsState>();
        let parent = std::env::vars().collect();
        let status = status_impl(&base, &state, tool, false, None, &parent)?;
        let _mutation = state.mutation.lock().unwrap();
        if !matches!(status.state, ToolState::Installed)
            || !status.path.as_ref().is_some_and(|p| p.is_file())
            || state.installing.load(Ordering::SeqCst)
        {
            return Err("External tool is not installed or is busy.".into());
        }
        let mut spec = tool.spec();
        spec.program = status.path.ok_or("External tool executable is missing.")?;
        let launch = terminal::launch_sign_in(
            probe::ProbePlatform::current(),
            &spec,
            &base.join("signin"),
            &parent,
            matches!(status.source, Some(ToolSource::Managed)),
            terminal::spawn_terminal,
        );
        state.probes.invalidate(tool);
        launch
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn external_tool_consent_set<R: Runtime>(
    app: tauri::AppHandle<R>,
    tool: ToolId,
    plugin_id: String,
    granted: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ExternalToolsState>();
        let _mutation = state.mutation.lock().unwrap();
        let _consent = state.consent_lock.lock().unwrap();
        consent::ConsentStore::new(&base_dir(&app)?)
            .set(tool, &plugin_id, granted)
            .map_err(|e| e.to_string())?;
        if !granted {
            let runs: Vec<_> = state
                .inner
                .lock()
                .unwrap()
                .runs
                .values()
                .filter(|e| e.tool == tool && e.plugin_id == plugin_id)
                .map(|e| e.run.clone())
                .collect();
            for run in runs {
                run.cancel(KillReason::Cancelled);
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn external_tool_consent_revoke<R: Runtime>(
    app: tauri::AppHandle<R>,
    tool: ToolId,
    plugin_id: String,
) -> Result<(), String> {
    external_tool_consent_set(app, tool, plugin_id, false).await
}

fn consent_clear_plugin_impl(
    base: &Path,
    state: &ExternalToolsState,
    plugin_id: &str,
) -> Result<(), String> {
    let _mutation = state.mutation.lock().unwrap();
    consent::ConsentStore::new(base)
        .clear_for_plugin(plugin_id)
        .map_err(|e| e.to_string())?;
    let runs: Vec<_> = state
        .inner
        .lock()
        .unwrap()
        .runs
        .values()
        .filter(|entry| entry.plugin_id == plugin_id)
        .map(|entry| entry.run.clone())
        .collect();
    for run in runs {
        run.cancel(KillReason::PluginUnregistered);
    }
    Ok(())
}

#[tauri::command]
pub async fn external_tool_consent_clear_plugin<R: Runtime>(
    app: tauri::AppHandle<R>,
    plugin_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        consent_clear_plugin_impl(
            &base_dir(&app)?,
            &app.state::<ExternalToolsState>(),
            &plugin_id,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn external_tool_consent_list<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Vec<consent::Consent>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ExternalToolsState>();
        let _consent = state.consent_lock.lock().unwrap();
        consent::ConsentStore::new(&base_dir(&app)?)
            .list()
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn bind_mcp_session(
    request: &ExternalToolRunRequest,
) -> Result<Option<RunBinding>, ExternalToolRunError> {
    if request.mcp_session_id.is_empty() {
        return Ok(None);
    }
    session::bind_session(&request.mcp_session_id, &request.plugin_id, &nonce())
        .map(Some)
        .map_err(|error| match error {
            BindError::UnknownSession => {
                ExternalToolRunError::new(RunErrorCode::InvalidArgs, "Unknown MCP session.")
            }
            BindError::NotOwner => ExternalToolRunError::new(
                RunErrorCode::NotOwner,
                "MCP session belongs to another plugin.",
            ),
            BindError::AlreadyBound => ExternalToolRunError::new(
                RunErrorCode::Busy,
                "MCP session is already bound to a run.",
            ),
        })
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(std::io::ErrorKind::InvalidInput.into());
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    // Windows uses the per-conversation directory and its inherited user ACL.
    file.write_all(bytes)
}

fn run_start_impl(
    base: &Path,
    state: &ExternalToolsState,
    request: ExternalToolRunRequest,
    parent: &env::ParentEnv,
) -> Result<ExternalToolRunStarted, ExternalToolRunError> {
    request.validate()?;
    let binding = bind_mcp_session(&request)?;
    {
        let _consent = state.consent_lock.lock().unwrap();
        if !consent::ConsentStore::new(base)
            .get(request.tool, &request.plugin_id)
            .map_err(|e| ExternalToolRunError::new(RunErrorCode::SpawnFailed, e.to_string()))?
        {
            return Err(ExternalToolRunError::new(
                RunErrorCode::NotConsented,
                "Plugin has no consent for this tool.",
            ));
        }
    }
    let status = status_impl(base, state, request.tool, false, None, parent)
        .map_err(|e| ExternalToolRunError::new(RunErrorCode::SpawnFailed, e))?;
    // Probing may execute vendor code for seconds. Serialize only the commit, and
    // re-check consent and executable availability after taking the mutation lock.
    let _mutation = state.mutation.lock().unwrap();
    if !consent::ConsentStore::new(base)
        .get(request.tool, &request.plugin_id)
        .map_err(|e| ExternalToolRunError::new(RunErrorCode::SpawnFailed, e.to_string()))?
    {
        return Err(ExternalToolRunError::new(
            RunErrorCode::NotConsented,
            "Plugin has no consent for this tool.",
        ));
    }
    if state
        .install_snapshot
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|(tool, _)| *tool == request.tool)
    {
        return Err(ExternalToolRunError::new(
            RunErrorCode::Busy,
            "This tool is being installed.",
        ));
    }
    if matches!(status.state, ToolState::Installing) {
        return Err(ExternalToolRunError::new(
            RunErrorCode::Busy,
            "This tool is being installed.",
        ));
    }
    if !matches!(status.state, ToolState::Installed)
        || !status.path.as_ref().is_some_and(|p| p.is_file())
    {
        return Err(ExternalToolRunError::new(
            RunErrorCode::NotInstalled,
            "External tool is not installed.",
        ));
    }
    // Check before staging files: another turn must never overwrite a live run's input.
    if state.inner.lock().unwrap().runs.values().any(|e| {
        (e.tool == request.tool
            || (e.plugin_id == request.plugin_id && e.conversation_id == request.conversation_id))
            && e.run.status().is_running()
    }) {
        return Err(ExternalToolRunError::new(
            RunErrorCode::Busy,
            "This tool already has an active run.",
        ));
    }
    let cwd = conversation_dir(base, &request.plugin_id, &request.conversation_id)
        .map_err(|e| ExternalToolRunError::new(RunErrorCode::SpawnFailed, e.to_string()))?;
    let system = cwd.join("system-prompt.md");
    let config = cwd.join("claude-mcp.json");
    let credentials = if binding.is_some() {
        Some(
            session::session_credentials(&request.mcp_session_id).ok_or_else(|| {
                ExternalToolRunError::new(
                    RunErrorCode::InvalidArgs,
                    "MCP session closed before run start.",
                )
            })?,
        )
    } else {
        None
    };
    let config_json = match &credentials {
        Some((url, token)) if request.tool == ToolId::Claude => {
            serde_json::json!({"mcpServers":{"chemdraft":{
                "type":"http", "url":url, "headers":{"Authorization":format!("Bearer {token}")}
            }}})
        }
        _ => serde_json::json!({"mcpServers":{}}),
    };
    // Arm cleanup before writing credentials: rendering and start_bound can still fail.
    // On success the spawned run owns cleanup for the rest of the file's lifetime.
    let mut config_cleanup = run::RunConfigCleanup(binding.as_ref().map(|_| config.clone()));
    write_private(&system, request.system_prompt.as_bytes())
        .and_then(|()| write_private(&config, config_json.to_string().as_bytes()))
        .map_err(|e| ExternalToolRunError::new(RunErrorCode::SpawnFailed, e.to_string()))?;
    let mut spec = request.tool.spec();
    spec.program = status.path.ok_or_else(|| {
        ExternalToolRunError::new(
            RunErrorCode::NotInstalled,
            "External tool executable is missing.",
        )
    })?;
    let managed = matches!(status.source, Some(ToolSource::Managed));
    let rendered = catalog::render_run(
        &spec,
        catalog::ToolRunInputs {
            run_dir: &cwd,
            prompt_file: &request.prompt,
            system_prompt_file: &system,
            mcp_config_file: &config,
            mcp_url: credentials
                .as_ref()
                .map(|(url, _)| url.as_str())
                .unwrap_or(""),
            resume_id: request.resume_id.as_deref(),
            model: request.model.as_deref(),
            effort: request.effort,
            managed_copy: managed,
        },
    )
    .map_err(|e| ExternalToolRunError::new(RunErrorCode::InvalidArgs, e))?;
    let mut rendered = rendered;
    // Supplied only by Rust after binding; never accept a parent's token.
    let token = credentials
        .as_ref()
        .filter(|_| request.tool == ToolId::Codex)
        .map(|(_, token)| token.as_str());
    rendered
        .env
        .extend(env::with_mcp_token(env::ParentEnv::new(), token));
    let started = state.start_bound(base, &request, rendered, parent, managed, binding)?;
    config_cleanup.0 = None;
    Ok(started)
}

#[tauri::command]
pub async fn external_tool_run_start<R: Runtime>(
    app: tauri::AppHandle<R>,
    request: ExternalToolRunRequest,
) -> Result<ExternalToolRunStarted, ExternalToolRunError> {
    tauri::async_runtime::spawn_blocking(move || {
        let base =
            base_dir(&app).map_err(|e| ExternalToolRunError::new(RunErrorCode::SpawnFailed, e))?;
        run_start_impl(
            &base,
            &app.state::<ExternalToolsState>(),
            request,
            &std::env::vars().collect(),
        )
    })
    .await
    .map_err(|e| ExternalToolRunError::new(RunErrorCode::SpawnFailed, e.to_string()))?
}

#[tauri::command]
pub async fn external_tool_run_poll<R: Runtime>(
    app: tauri::AppHandle<R>,
    run_id: String,
    cursor: u64,
    max_lines: Option<usize>,
    wait_ms: Option<u64>,
) -> Result<run::ExternalToolRunPoll, ExternalToolRunError> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(app.state::<ExternalToolsState>().run_by_id(&run_id)?.poll(
            cursor,
            max_lines.unwrap_or(5000).clamp(1, 5000),
            wait_ms.unwrap_or(0).min(1000),
        ))
    })
    .await
    .map_err(|e| ExternalToolRunError::new(RunErrorCode::SpawnFailed, e.to_string()))?
}

#[tauri::command]
pub fn external_tool_run_cancel(
    state: tauri::State<'_, ExternalToolsState>,
    run_id: String,
) -> Result<(), ExternalToolRunError> {
    state.run_by_id(&run_id)?.cancel(KillReason::Cancelled);
    Ok(())
}

fn conversation_clear_impl(
    base: &Path,
    state: &ExternalToolsState,
    tool: ToolId,
    plugin: &str,
    conversation: &str,
    parent: &env::ParentEnv,
) -> Result<(), String> {
    if !valid_plugin_id(plugin) || !identifier(conversation, 8, 64) {
        return Err("Invalid conversation identity.".into());
    }
    let status = if tool == ToolId::Claude {
        status_impl(base, state, tool, false, None, parent).ok()
    } else {
        None
    };
    let _mutation = state.mutation.lock().unwrap();
    // Both tools share the conversation directory; stop both before removing it.
    for active in [ToolId::Claude, ToolId::Codex] {
        state.stop_runs(active, Some((plugin, conversation)))?;
    }
    let dir = conversation_dir(base, plugin, conversation).map_err(|e| e.to_string())?;
    if !state.installing.load(Ordering::SeqCst) {
        if let Some(status) = status {
            if let Some(program) = status
                .path
                .filter(|_| matches!(status.state, ToolState::Installed))
            {
                let _ = probe::execute(
                    &program,
                    &["purge", &dir.to_string_lossy(), "--yes"],
                    parent,
                    base,
                    matches!(status.source, Some(ToolSource::Managed)),
                    Duration::from_secs(15),
                    64 * 1024,
                );
            }
        }
    }
    fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut inner = state.inner.lock().unwrap();
    inner
        .conversations
        .remove(&(plugin.to_owned(), conversation.to_owned()));
    Ok(())
}

#[tauri::command]
pub async fn external_tool_conversation_clear<R: Runtime>(
    app: tauri::AppHandle<R>,
    tool: ToolId,
    plugin_id: String,
    conversation_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        conversation_clear_impl(
            &base_dir(&app)?,
            &app.state::<ExternalToolsState>(),
            tool,
            &plugin_id,
            &conversation_id,
            &std::env::vars().collect(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn shutdown<R: Runtime>(app: &tauri::AppHandle<R>) {
    app.state::<ExternalToolsState>().shutdown();
}

pub fn setup<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Ok(base) = base_dir(app) {
        // Setup completes before the frontend can start a run; stale runs contain no user files.
        if let Err(error) = remove_stale_runs(&base) {
            eprintln!("Could not remove stale external tool runs: {error}");
        }
    }
}
