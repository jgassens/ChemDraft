//! Host-owned external CLI runner. Tauri registration and install orchestration are separate tasks.
#![allow(dead_code)] // A1 supplies the core; A3 wires its public API into Tauri commands.
pub mod catalog;
pub mod consent;
pub mod env;
pub mod pins;
pub mod probe;
pub mod run;
pub mod terminal;
#[cfg(test)]
mod tests;

use catalog::{identifier, Effort, RenderedRun, ToolId};
use run::{KillReason, ToolRun};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

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
#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub state: ToolState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<ToolSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub pinned_version: String,
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
            || !identifier(&self.mcp_session_id, 1, 128)
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
        request.validate()?;
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
        let run = ToolRun::spawn(
            rendered,
            &cwd,
            &environment,
            Duration::from_millis(request.timeout_ms.unwrap_or(600_000)),
        )
        .map_err(|e| ExternalToolRunError::new(RunErrorCode::SpawnFailed, e))?;
        let run_id = nonce();
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
