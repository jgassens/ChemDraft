//! Native authority for document ownership. Labels and payloads supplied by renderers never
//! authorize a caller: commands authenticate the invoking webview against this registry.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap},
    sync::{LazyLock, Mutex},
};
use tauri::{Emitter, Manager, Runtime};

#[derive(Default, Clone)]
pub(crate) struct Directory {
    pub transferred_tabs: HashMap<String, String>,
    pub labels: Vec<String>,
    pub active: Option<String>,
    utilities: HashMap<String, String>,
    files: HashMap<String, (String, String)>,
    transfers: HashMap<String, Transfer>,
    transfer_payloads: HashMap<String, Vec<String>>,
    next: u64,
    pub sessions: BTreeMap<String, Value>,
    pub loaded: bool,
    pub quit: Option<WindowQuit>,
}
impl Directory {
    fn reserve_utility_owner(&mut self, label: &str, owner: &str) -> Result<(), String> {
        if !self.labels.iter().any(|label| label == owner) {
            return Err("The document owner has closed".into());
        }
        if self
            .utilities
            .get(label)
            .is_some_and(|existing| existing != owner)
        {
            return Err("This utility label already belongs to another document window".into());
        }
        self.utilities.insert(label.into(), owner.into());
        Ok(())
    }

    /// The destination stages a tab in memory before accepting. Until the atomic ownership
    /// commit, recovery must reopen only the source's durable copy, including after cancellation.
    pub(crate) fn persisted_sessions(&self) -> BTreeMap<String, Value> {
        let mut sessions = self.sessions.clone();
        for transfer in self
            .transfers
            .values()
            .filter(|transfer| transfer.status != "accepted")
        {
            // An old cancelled attempt must not hide a later successful move to the same window.
            if self.transferred_tabs.get(&transfer.tab_id) == Some(&transfer.target) {
                continue;
            }
            if let Some(session) = sessions.get_mut(&transfer.target) {
                remove_session_tab(session, &transfer.tab_id);
            }
        }
        sessions
    }
}
#[derive(Clone)]
pub(crate) struct WindowQuit {
    pub participants: Vec<String>,
    pub remaining: Vec<String>,
    pub prompting: Option<String>,
    pub close_only: bool,
    pub flush_id: u64,
}
impl WindowQuit {
    /// Only the current generation's requested owners can cross the flush barrier.
    pub(crate) fn acknowledge_flush(&mut self, label: &str, request_id: u64) -> bool {
        if self.prompting.is_some()
            || self.flush_id != request_id
            || !self.remaining.iter().any(|owner| owner == label)
        {
            return false;
        }
        self.remaining.retain(|owner| owner != label);
        self.remaining.is_empty()
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Transfer {
    pub transfer_id: String,
    pub tab_id: String,
    pub snapshot: Value,
    #[serde(skip)]
    pub source: String,
    #[serde(skip)]
    pub target: String,
    #[serde(skip)]
    pub status: String,
}
pub(crate) static NEXT_FLUSH_ID: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(1);
pub(crate) static DIRECTORY: LazyLock<Mutex<Directory>> =
    LazyLock::new(|| Mutex::new(Directory::default()));

#[derive(Default)]
struct WorkspaceFlush {
    id: u64,
    remaining: Vec<String>,
    error: Option<String>,
    active: bool,
}
static WORKSPACE_FLUSH: LazyLock<Mutex<WorkspaceFlush>> =
    LazyLock::new(|| Mutex::new(WorkspaceFlush::default()));
#[tauri::command]
pub(crate) async fn flush_document_workspace(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    authorize(&app, window.label())?;
    let (id, labels) = {
        let mut f = WORKSPACE_FLUSH.lock().unwrap();
        if f.active {
            return Err("Another workspace flush is in progress".into());
        }
        f.id += 1;
        f.active = true;
        f.error = None;
        f.remaining = DIRECTORY.lock().unwrap().labels.clone();
        (f.id, f.remaining.clone())
    };
    for label in labels {
        if let Err(error) = emit_document_event(
            &app,
            &label,
            "chemdraft://flush-document-workspace",
            serde_json::json!({"requestId":id}),
        ) {
            let mut f = WORKSPACE_FLUSH.lock().unwrap();
            f.active = false;
            return Err(error);
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            {
                let mut f = WORKSPACE_FLUSH.lock().unwrap();
                if let Some(error) = f.error.take() {
                    f.active = false;
                    return Err(error);
                }
                if f.remaining.is_empty() {
                    f.active = false;
                    return Ok(());
                }
                if std::time::Instant::now() >= deadline {
                    f.active = false;
                    return Err("Timed out flushing every document window; update cancelled".into());
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) fn document_workspace_flushed(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request_id: u64,
    error: Option<String>,
) -> Result<(), String> {
    authorize(&app, window.label())?;
    let mut f = WORKSPACE_FLUSH.lock().unwrap();
    if !f.active || f.id != request_id || !f.remaining.iter().any(|v| v == window.label()) {
        return Err("Stale workspace flush acknowledgement".into());
    }
    if let Some(error) = error {
        f.error = Some(error);
    }
    f.remaining.retain(|v| v != window.label());
    Ok(())
}

pub(crate) fn register_document<R: Runtime>(_app: &tauri::AppHandle<R>, label: &str) {
    let mut d = DIRECTORY.lock().unwrap();
    if !d.labels.iter().any(|v| v == label) {
        d.labels.push(label.into());
    }
    d.active = Some(label.into());
}
pub(crate) fn registered_document_label<R: Runtime>(
    _app: &tauri::AppHandle<R>,
    label: &str,
) -> bool {
    DIRECTORY.lock().unwrap().labels.iter().any(|v| v == label)
}
pub(crate) fn authorize<R: Runtime>(app: &tauri::AppHandle<R>, label: &str) -> Result<(), String> {
    if registered_document_label(app, label) {
        Ok(())
    } else {
        Err("Only a registered document window may perform this operation".into())
    }
}
pub(crate) fn set_active<R: Runtime>(app: &tauri::AppHandle<R>, label: &str) {
    if registered_document_label(app, label) {
        DIRECTORY.lock().unwrap().active = Some(label.into());
    }
}
pub(crate) fn document_windows<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Vec<tauri::WebviewWindow<R>> {
    let labels = DIRECTORY.lock().unwrap().labels.clone();
    labels
        .iter()
        .filter_map(|l| app.get_webview_window(l))
        .collect()
}
pub(crate) fn active_document_window<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Option<tauri::WebviewWindow<R>> {
    let d = DIRECTORY.lock().unwrap();
    d.active
        .as_ref()
        .and_then(|l| app.get_webview_window(l))
        .or_else(|| d.labels.iter().find_map(|l| app.get_webview_window(l)))
}
pub(crate) fn utility_owner<R: Runtime>(_app: &tauri::AppHandle<R>, label: &str) -> Option<String> {
    DIRECTORY.lock().unwrap().utilities.get(label).cloned()
}
pub(crate) fn utility_labels_for_owner<R: Runtime>(
    _app: &tauri::AppHandle<R>,
    owner: &str,
) -> Vec<String> {
    DIRECTORY
        .lock()
        .unwrap()
        .utilities
        .iter()
        .filter(|(_, actual)| actual.as_str() == owner)
        .map(|(label, _)| label.clone())
        .collect()
}

pub(crate) fn register_utility_owner<R: Runtime>(
    _app: &tauri::AppHandle<R>,
    label: &str,
    owner: &str,
) -> Result<(), String> {
    DIRECTORY
        .lock()
        .unwrap()
        .reserve_utility_owner(label, owner)
}

pub(crate) fn unregister_document<R: Runtime>(_app: &tauri::AppHandle<R>, label: &str) {
    let mut d = DIRECTORY.lock().unwrap();
    d.labels.retain(|l| l != label);
    d.files.retain(|_, (owner, _)| owner != label);
    d.utilities.retain(|_, owner| owner != label);
    for t in d.transfers.values_mut() {
        if (t.source == label || t.target == label) && t.status == "pending" {
            t.status = "cancelled".into();
            t.snapshot = Value::Null;
        }
    }
    let pending: Vec<_> = d
        .transfers
        .values()
        .filter(|t| t.status == "pending")
        .map(|t| t.transfer_id.clone())
        .collect();
    d.transfer_payloads.retain(|id, _| pending.contains(id));
    if d.active.as_deref() == Some(label) {
        d.active = d.labels.last().cloned();
    }
}

#[derive(Serialize)]
pub(crate) struct WindowInfo {
    label: String,
    title: String,
}
#[tauri::command]
pub(crate) fn list_document_windows(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Vec<WindowInfo>, String> {
    authorize(&app, window.label())?;
    Ok(document_windows(&app)
        .into_iter()
        .map(|w| WindowInfo {
            label: w.label().into(),
            title: w.title().unwrap_or_else(|_| "ChemDraft".into()),
        })
        .collect())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransferReceipt {
    transfer_id: String,
    target_label: String,
}
#[tauri::command]
pub(crate) fn stage_document_tab_transfer(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    target_label: String,
    tab_id: String,
    snapshot: Value,
) -> Result<TransferReceipt, String> {
    authorize(&app, window.label())?;
    authorize(&app, &target_label)?;
    if window.label() == target_label
        || tab_id.is_empty()
        || tab_id.len() > 128
        || snapshot.to_string().len() > 64 * 1024 * 1024
    {
        return Err("Invalid tab transfer".into());
    }
    if super::quit_in_progress() {
        return Err("Cannot move a tab while quitting".into());
    }
    let mut d = DIRECTORY.lock().unwrap();
    if d.transfers
        .values()
        .any(|t| t.source == window.label() && t.tab_id == tab_id && t.status == "pending")
    {
        return Err("This tab is already moving".into());
    }
    if d.quit.is_some() {
        return Err("Cannot move a tab while quitting".into());
    }
    let chunks = transfer_payload_chunks(&snapshot)?;
    d.next += 1;
    let id = format!("transfer-{}", d.next);
    d.transfer_payloads.insert(id.clone(), chunks);
    d.transfers.insert(
        id.clone(),
        Transfer {
            transfer_id: id.clone(),
            tab_id,
            snapshot,
            source: window.label().into(),
            target: target_label.clone(),
            status: "pending".into(),
        },
    );
    Ok(TransferReceipt {
        transfer_id: id,
        target_label,
    })
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransferMetadata {
    transfer_id: String,
    tab_id: String,
    chunk_count: usize,
}
fn transfer_payload_chunks(snapshot: &Value) -> Result<Vec<String>, String> {
    let json = serde_json::to_string(snapshot).map_err(|e| e.to_string())?;
    if json.len() > 64 * 1024 * 1024 {
        return Err("The moved tab exceeds the transfer limit".into());
    }
    let mut chunks = Vec::new();
    let mut chunk = String::new();
    let mut chars = 0;
    for character in json.chars() {
        chunk.push(character);
        chars += 1;
        if chars == 1024 {
            chunks.push(std::mem::take(&mut chunk));
            chars = 0;
        }
    }
    if !chunk.is_empty() {
        chunks.push(chunk);
    }
    if chunks
        .iter()
        .any(|c| serde_json::to_vec(c).map_or(true, |bytes| bytes.len() >= 8192))
    {
        return Err("Tab transfer chunk exceeds private delivery limit".into());
    }
    Ok(chunks)
}
#[tauri::command]
pub(crate) fn take_document_tab_transfer(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<TransferMetadata>, String> {
    authorize(&app, window.label())?;
    let d = DIRECTORY.lock().unwrap();
    let Some(t) = d
        .transfers
        .values()
        .find(|t| t.target == window.label() && t.status == "pending")
    else {
        return Ok(None);
    };
    let chunks = d
        .transfer_payloads
        .get(&t.transfer_id)
        .ok_or("Transfer payload is unavailable")?;
    Ok(Some(TransferMetadata {
        transfer_id: t.transfer_id.clone(),
        tab_id: t.tab_id.clone(),
        chunk_count: chunks.len(),
    }))
}
#[tauri::command]
pub(crate) fn document_tab_transfer_chunk(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    transfer_id: String,
    index: usize,
) -> Result<String, String> {
    authorize(&app, window.label())?;
    let d = DIRECTORY.lock().unwrap();
    let t = d
        .transfers
        .get(&transfer_id)
        .ok_or("Unknown tab transfer")?;
    if t.target != window.label() || t.status != "pending" {
        return Err("Tab transfer is not available to this window".into());
    }
    d.transfer_payloads
        .get(&transfer_id)
        .and_then(|chunks| chunks.get(index))
        .cloned()
        .ok_or_else(|| "Invalid tab transfer chunk".into())
}
#[tauri::command]
pub(crate) fn accept_document_tab_transfer(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    transfer_id: String,
) -> Result<(), String> {
    authorize(&app, window.label())?;
    let mut d = DIRECTORY.lock().unwrap();
    let source = d
        .transfers
        .get(&transfer_id)
        .ok_or("Unknown tab transfer")?
        .source
        .clone();
    let candidate = transfer_accept_candidate(&d, window.label(), &transfer_id)?;
    super::persist_workspace(&app, &candidate)?;
    *d = candidate;
    drop(d);
    app.emit_to(
        &source,
        "chemdraft://tab-transfer-accepted",
        serde_json::json!({"transferId":transfer_id}),
    )
    .map_err(|e| e.to_string())
}
/// Build the commit without touching live ownership; persistence must succeed before publication.
fn transfer_accept_candidate(d: &Directory, caller: &str, id: &str) -> Result<Directory, String> {
    let transfer = d.transfers.get(id).ok_or("Unknown tab transfer")?;
    if transfer.target != caller || transfer.status == "cancelled" {
        return Err("Tab transfer is not available to this window".into());
    }
    let destination = d
        .sessions
        .get(caller)
        .ok_or("The destination has not persisted the moved tab")?;
    let owns_tab = destination
        .get("tabs")
        .and_then(Value::as_array)
        .is_some_and(|tabs| {
            tabs.iter().any(|tab| {
                tab.get("tabId").and_then(Value::as_str) == Some(transfer.tab_id.as_str())
            })
        });
    if !owns_tab {
        return Err("The destination has not persisted the moved tab".into());
    }
    let mut candidate = d.clone();
    candidate
        .transferred_tabs
        .insert(transfer.tab_id.clone(), transfer.target.clone());
    if let Some(session) = candidate.sessions.get_mut(&transfer.source) {
        remove_session_tab(session, &transfer.tab_id);
    }
    for (owner, tab) in candidate.files.values_mut() {
        if *owner == transfer.source && *tab == transfer.tab_id {
            *owner = transfer.target.clone();
        }
    }
    let receipt = candidate.transfers.get_mut(id).unwrap();
    receipt.status = "accepted".into();
    receipt.snapshot = Value::Null;
    candidate.transfer_payloads.remove(id);
    Ok(candidate)
}
#[tauri::command]
pub(crate) fn document_tab_transfer_status(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    transfer_id: String,
) -> Result<String, String> {
    authorize(&app, window.label())?;
    let d = DIRECTORY.lock().unwrap();
    let t = d
        .transfers
        .get(&transfer_id)
        .ok_or("Unknown tab transfer")?;
    if t.source != window.label() && t.target != window.label() {
        return Err("Transfer belongs to another window".into());
    }
    Ok(t.status.clone())
}
#[tauri::command]
pub(crate) fn cancel_document_tab_transfer(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    transfer_id: String,
) -> Result<(), String> {
    authorize(&app, window.label())?;
    let mut d = DIRECTORY.lock().unwrap();
    let t = d
        .transfers
        .get_mut(&transfer_id)
        .ok_or("Unknown tab transfer")?;
    if t.source != window.label() {
        return Err("Only the source may cancel a transfer".into());
    }
    if t.status == "accepted" {
        return Err("Tab transfer already accepted".into());
    }
    t.status = "cancelled".into();
    t.snapshot = Value::Null;
    d.transfer_payloads.remove(&transfer_id);
    Ok(())
}
fn path_key(path: &str) -> Result<String, String> {
    let p = std::path::Path::new(path);
    if !p.is_absolute() {
        return Err("Document path must be absolute".into());
    }
    // Reserve Save As before creation using the same canonical parent spelling as an existing
    // file. In particular, Windows canonicalization adds the extended path prefix.
    let canonical = match p.canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let name = p.file_name().ok_or("Document path must name a file")?;
            let parent = p.parent().ok_or("Document path has no parent")?;
            parent
                .canonicalize()
                .map_err(|error| format!("Document folder is unavailable: {error}"))?
                .join(name)
        }
        Err(error) => return Err(format!("Document path is unavailable: {error}")),
    };
    let path = canonical.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        Ok(path.to_lowercase())
    }
    #[cfg(not(windows))]
    {
        Ok(path)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileClaim {
    owned: bool,
    window_label: String,
    tab_id: String,
}
#[tauri::command]
pub(crate) fn claim_document_file(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    path: String,
    tab_id: String,
) -> Result<FileClaim, String> {
    authorize(&app, window.label())?;
    let key = path_key(&path)?;
    let mut d = DIRECTORY.lock().unwrap();
    let (owner, tab) = d
        .files
        .entry(key)
        .or_insert_with(|| (window.label().into(), tab_id.clone()))
        .clone();
    drop(d);
    let owned = owner == window.label() && tab == tab_id;
    if !owned {
        if let Some(w) = app.get_webview_window(&owner) {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
        app.emit_to(
            &owner,
            "chemdraft://activate-document-tab",
            serde_json::json!({"tabId":tab}),
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(FileClaim {
        owned,
        window_label: owner,
        tab_id: tab,
    })
}
#[tauri::command]
pub(crate) fn release_document_file(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    path: String,
    tab_id: String,
) -> Result<(), String> {
    authorize(&app, window.label())?;
    let key = path_key(&path)?;
    let mut d = DIRECTORY.lock().unwrap();
    if d.files
        .get(&key)
        .is_some_and(|(owner, tab)| owner == window.label() && tab == &tab_id)
    {
        d.files.remove(&key);
    }
    Ok(())
}

/// Remove the transferred tab from the source recovery record in the same disk transaction
/// that records its accepted destination. Late source autosaves are filtered by the same rule.
pub(crate) fn remove_session_tab(session: &mut Value, id: &str) {
    if let Some(tabs) = session.get_mut("tabs").and_then(Value::as_array_mut) {
        tabs.retain(|tab| tab.get("tabId").and_then(Value::as_str) != Some(id));
        let active = session
            .get("activeTabIndex")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        let tabs = session["tabs"].as_array().unwrap();
        if tabs.is_empty() {
            let recovery = session
                .get("unrestoredTabs")
                .cloned()
                .unwrap_or_else(|| serde_json::json!([]));
            *session = serde_json::json!({"version":1,"tabs":[],"activeTabIndex":0,"unrestoredTabs":recovery});
        } else {
            let index = active.min(tabs.len() - 1);
            let tabs = tabs.clone();
            let unrestored = session.get("unrestoredTabs").cloned();
            *session = tabs[index].clone();
            session["tabs"] = Value::Array(tabs);
            session["activeTabIndex"] = serde_json::json!(index);
            if let Some(v) = unrestored {
                session["unrestoredTabs"] = v;
            }
        }
    }
}
/// Shared by real open-document and quit-flush delivery paths; never uses Tauri broadcast.
pub(crate) fn emit_document_event<R: Runtime, S: Serialize + Clone>(
    app: &tauri::AppHandle<R>,
    label: &str,
    event: &str,
    payload: S,
) -> Result<(), String> {
    authorize(app, label)?;
    deliver_document_event(label, event, payload, |target, event, payload| {
        app.emit_to(target, event, payload)
            .map_err(|e| e.to_string())
    })
}
fn deliver_document_event<S>(
    label: &str,
    event: &str,
    payload: S,
    send: impl FnOnce(&str, &str, S) -> Result<(), String>,
) -> Result<(), String> {
    send(label, event, payload)
}
#[cfg(test)]
mod tests {
    #[test]
    fn utility_label_reservation_rejects_closed_owners_and_cross_owner_collisions() {
        let mut directory = super::Directory {
            labels: vec!["main".into(), "document-2".into()],
            ..Default::default()
        };
        directory
            .reserve_utility_owner("toolset-claimed", "main")
            .unwrap();
        directory
            .reserve_utility_owner("toolset-claimed", "main")
            .unwrap();
        assert!(directory
            .reserve_utility_owner("toolset-claimed", "document-2")
            .is_err());
        assert_eq!(directory.utilities.get("toolset-claimed").unwrap(), "main");
        assert!(directory
            .reserve_utility_owner("toolset-late", "document-closed")
            .is_err());
        assert!(!directory.utilities.contains_key("toolset-late"));
    }

    use super::*;
    #[test]
    fn save_as_path_identity_survives_creation_and_deletion() {
        let folder = std::env::temp_dir().join(format!(
            "chemdraft-owner-path-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&folder).unwrap();
        let file = folder.join("New Drawing.chemdraft");
        let before = path_key(file.to_str().unwrap()).unwrap();
        std::fs::write(&file, "drawing").unwrap();
        assert_eq!(path_key(file.to_str().unwrap()).unwrap(), before);
        assert_eq!(
            path_key(file.canonicalize().unwrap().to_str().unwrap()).unwrap(),
            before
        );
        std::fs::remove_file(&file).unwrap();
        assert_eq!(path_key(file.to_str().unwrap()).unwrap(), before);
        std::fs::remove_dir(&folder).unwrap();
    }
    #[test]
    fn file_ownership_rejects_relative_paths() {
        assert!(path_key("relative.chemdraft").is_err());
    }
    fn flush() -> WindowQuit {
        WindowQuit {
            participants: vec!["main".into(), "document-2".into()],
            remaining: vec!["main".into(), "document-2".into()],
            prompting: None,
            close_only: false,
            flush_id: 17,
        }
    }
    #[test]
    fn flush_barrier_requires_every_owner_and_ignores_stale_or_duplicate_answers() {
        let mut quit = flush();
        assert!(!quit.acknowledge_flush("main", 16));
        assert!(!quit.acknowledge_flush("palette-main", 17));
        assert_eq!(quit.remaining.len(), 2);
        assert!(!quit.acknowledge_flush("main", 17));
        assert!(!quit.acknowledge_flush("main", 17));
        assert_eq!(quit.remaining, vec!["document-2"]);
        assert!(quit.acknowledge_flush("document-2", 17));
    }
    #[test]
    fn flush_answer_cannot_skip_an_outstanding_save_prompt() {
        let mut quit = flush();
        quit.prompting = Some("main".into());
        assert!(!quit.acknowledge_flush("main", 17));
        assert_eq!(quit.remaining.len(), 2);
    }
    fn transfer_directory() -> Directory {
        let mut directory = Directory::default();
        directory.sessions.insert("main".into(), serde_json::json!({"version":1,"tabs":[{"tabId":"tab","contents":"source"}],"activeTabIndex":0,"unrestoredTabs":[{"version":99,"contents":"recovery"}]}));
        directory.sessions.insert("document-2".into(), serde_json::json!({"version":1,"tabs":[{"tabId":"tab","contents":"destination"}],"activeTabIndex":0}));
        directory
            .files
            .insert("file".into(), ("main".into(), "tab".into()));
        directory.transfers.insert(
            "transfer".into(),
            Transfer {
                transfer_id: "transfer".into(),
                tab_id: "tab".into(),
                snapshot: Value::Null,
                source: "main".into(),
                target: "document-2".into(),
                status: "pending".into(),
            },
        );
        directory
    }
    #[test]
    fn accepted_transfer_candidate_preserves_live_source_until_disk_commit() {
        let source = transfer_directory();
        let candidate = transfer_accept_candidate(&source, "document-2", "transfer").unwrap();
        assert_eq!(source.transfers["transfer"].status, "pending");
        assert_eq!(source.sessions["main"]["tabs"].as_array().unwrap().len(), 1);
        assert_eq!(source.files["file"].0, "main");
        assert_eq!(candidate.transfers["transfer"].status, "accepted");
        assert!(candidate.sessions["main"]["tabs"]
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(
            candidate.sessions["main"]["unrestoredTabs"][0]["contents"],
            "recovery"
        );
        assert_eq!(candidate.files["file"].0, "document-2");
        assert_eq!(
            candidate.sessions["document-2"]["tabs"][0]["contents"],
            "destination"
        );
    }
    #[test]
    fn recovery_has_one_owner_before_and_after_transfer_commit() {
        let mut directory = transfer_directory();
        for status in ["pending", "cancelled"] {
            directory.transfers.get_mut("transfer").unwrap().status = status.into();
            let disk = directory.persisted_sessions();
            assert_eq!(disk["main"]["tabs"].as_array().unwrap().len(), 1);
            assert!(disk["document-2"]["tabs"].as_array().unwrap().is_empty());
            // Filtering disk recovery must not discard the destination's acceptance proof.
            assert_eq!(
                directory.sessions["document-2"]["tabs"]
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
        }
        directory.transfers.get_mut("transfer").unwrap().status = "pending".into();
        let committed = transfer_accept_candidate(&directory, "document-2", "transfer").unwrap();
        let disk = committed.persisted_sessions();
        assert!(disk["main"]["tabs"].as_array().unwrap().is_empty());
        assert_eq!(disk["document-2"]["tabs"].as_array().unwrap().len(), 1);
        assert_eq!(disk["main"]["unrestoredTabs"][0]["contents"], "recovery");
        let mut later = committed;
        let mut cancelled = later.transfers["transfer"].clone();
        cancelled.transfer_id = "older-cancelled".into();
        cancelled.status = "cancelled".into();
        later
            .transfers
            .insert(cancelled.transfer_id.clone(), cancelled);
        assert_eq!(
            later.persisted_sessions()["document-2"]["tabs"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn transfer_cannot_delete_source_before_destination_is_persisted_or_after_cancel() {
        let mut source = transfer_directory();
        assert!(transfer_accept_candidate(&source, "main", "transfer").is_err());
        source.sessions.remove("document-2");
        assert!(transfer_accept_candidate(&source, "document-2", "transfer").is_err());
        source.sessions.insert(
            "document-2".into(),
            serde_json::json!({"tabs":[{"tabId":"different"}]}),
        );
        assert!(transfer_accept_candidate(&source, "document-2", "transfer").is_err());
        source.transfers.get_mut("transfer").unwrap().status = "cancelled".into();
        assert!(transfer_accept_candidate(&source, "document-2", "transfer").is_err());
        assert_eq!(source.sessions["main"]["tabs"].as_array().unwrap().len(), 1);
    }
    #[test]
    fn transfer_chunks_round_trip_below_tauri_shared_queue_threshold() {
        let payload = serde_json::json!({"text":"\\\"\n\u{6f22}\u{1f600}".repeat(4000)});
        let chunks = transfer_payload_chunks(&payload).unwrap();
        assert!(chunks.len() > 1);
        assert!(chunks
            .iter()
            .all(|chunk| serde_json::to_vec(chunk).unwrap().len() < 8192));
        assert_eq!(
            serde_json::from_str::<Value>(&chunks.concat()).unwrap(),
            payload
        );
    }
    #[test]
    fn second_document_never_receives_first_windows_quit_flush_or_open_document() {
        let mut received: HashMap<String, Vec<String>> =
            HashMap::from([("main".into(), vec![]), ("document-2".into(), vec![])]);
        for event in [
            super::super::QUIT_FLUSH_REQUEST_EVENT,
            super::super::OPEN_DOCUMENT_EVENT,
        ] {
            deliver_document_event("main", event, (), |target, event, ()| {
                received.get_mut(target).unwrap().push(event.into());
                Ok(())
            })
            .unwrap();
        }
        assert_eq!(received["main"].len(), 2);
        assert!(received["document-2"].is_empty());
    }
    #[test]
    fn removing_transferred_tab_preserves_peer_and_active_mirror() {
        let mut session = serde_json::json!({"version":1,"tabs":[{"tabId":"move","contents":"a"},{"tabId":"keep","contents":"b"}],"activeTabIndex":0});
        remove_session_tab(&mut session, "move");
        assert_eq!(session["tabs"].as_array().unwrap().len(), 1);
        assert_eq!(session["contents"], "b");
        assert_eq!(session["tabId"], "keep");
    }
}
