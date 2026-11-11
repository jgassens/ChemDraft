//! The sole session-file writer. Documents submit revisioned snapshots, never file writes.
//! Opaque JSON is intentional: newer metadata and unreadable drawings must survive this host.
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

const WRITE_INTERVAL: Duration = Duration::from_millis(800);

#[derive(Default)]
pub(crate) struct SessionCoordinator {
    state: Mutex<SessionState>,
}

#[derive(Default)]
struct SessionState {
    path: Option<PathBuf>,
    error: Option<String>,
    envelope: Option<Value>,
    original_v1: Option<String>,
    restores: HashMap<String, Value>,
    hydrated: HashSet<String>,
    revisions: HashMap<String, u64>,
    frames: HashMap<String, Value>,
    closed: HashSet<String>,
    fresh_start_guard: bool,
    dirty: bool,
    last_write: Option<Instant>,
    timer_pending: bool,
    next_offer: u64,
    offers: HashMap<u64, HandoffOffer>,
}

// A10b consumes these hooks later; no renderer command or tab movement is enabled by A6.
#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct HandoffOffer {
    pub id: u64,
    pub from: String,
    pub to: String,
    pub tab_id: String,
    pub state: Value,
    installed: bool,
}

fn valid_tabs(window: &Value) -> bool {
    window
        .get("tabs")
        .and_then(Value::as_array)
        .is_some_and(|tabs| {
            window
                .get("activeTabIndex")
                .and_then(Value::as_u64)
                .is_some_and(|index| index < tabs.len() as u64 || (tabs.is_empty() && index == 0))
        })
        && window.get("unrestoredTabs").is_none_or(Value::is_array)
}

fn migrate(raw: Value, first_id: &str) -> Result<Value, String> {
    match raw.get("version").and_then(Value::as_u64) {
        Some(1) => {
            // Validate the outer structure only. Individual tabs (including future versions) are
            // never parsed, normalized, reordered, or discarded by the coordinator.
            let mut window = raw.clone();
            if raw.get("tabs").is_some() {
                if !valid_tabs(&raw) || raw["tabs"].as_array().is_none_or(Vec::is_empty) {
                    return Err("Document session has invalid tabs or active tab index".into());
                }
            } else {
                if !super::document_session::readable_tab(&raw) {
                    return Err("Document session has an unreadable outer envelope".into());
                }
                window["tabs"] = json!([raw]);
                window["activeTabIndex"] = json!(0);
            }
            window.as_object_mut().unwrap().remove("version");
            window["id"] = json!(first_id);
            if window.get("frame").is_none() {
                window["frame"] = Value::Null;
            }
            Ok(json!({ "version": 2, "windows": [window], "activeWindowId": first_id }))
        }
        Some(2) => {
            let windows = raw
                .get("windows")
                .and_then(Value::as_array)
                .ok_or("Document session has no windows array")?;
            let mut ids = HashSet::new();
            for window in windows {
                let id = window
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .ok_or("Document session has an invalid window id")?;
                if !ids.insert(id) || !valid_tabs(window) {
                    return Err("Document session has duplicate windows or invalid tabs".into());
                }
            }
            if !raw
                .get("activeWindowId")
                .is_some_and(|id| id.is_null() || id.as_str().is_some_and(|id| ids.contains(id)))
            {
                return Err("Document session has an invalid active window id".into());
            }
            Ok(raw)
        }
        _ => {
            Err("Document session version is unsupported; the file will not be overwritten".into())
        }
    }
}

/// A6 fallback until A10 creates restored native windows. Keep all tabs in file window order;
/// select the saved active window's active tab. Other windows' opaque metadata is retained too.
fn collapse_into_first(envelope: &mut Value, first_id: &str) {
    let windows = envelope["windows"].as_array().unwrap();
    if windows.is_empty() {
        return;
    }
    let mut first = windows[0].clone();
    if windows.len() > 1 {
        let mut tabs = Vec::new();
        let mut kept = Vec::new();
        let mut active = 0;
        for window in windows {
            if window["id"] == envelope["activeWindowId"] {
                active = tabs.len() + window["activeTabIndex"].as_u64().unwrap() as usize;
            }
            tabs.extend(window["tabs"].as_array().unwrap().iter().cloned());
            if let Some(raw) = window.get("unrestoredTabs").and_then(Value::as_array) {
                kept.extend(raw.iter().cloned());
            }
        }
        first["tabs"] = json!(tabs);
        first["activeTabIndex"] = json!(if active < tabs.len() { active } else { 0 });
        first["unrestoredTabs"] = json!(kept);
        // Preserve the complete source windows, including unknown fields with conflicting names.
        // This is provenance only and is never interpreted as additional restore candidates.
        first["collapsedSessionWindows"] = json!(windows);
    }
    if first["id"] != first_id {
        first["restoredWindowId"] = first["id"].clone();
    }
    first["id"] = json!(first_id);
    envelope["windows"] = json!([first]);
    envelope["activeWindowId"] = json!(first_id);
}

fn window_restore(window: &Value) -> Value {
    // The document's existing v1 parser and recovery UI remain the chemistry boundary.
    let mut restore = window.clone();
    restore["version"] = json!(1);
    restore
}

impl SessionCoordinator {
    /// Called once in setup. Read errors are sticky: even another renderer cannot reopen writes.
    pub(crate) fn initialize(&self, path: PathBuf, first_id: &str, collapse: bool) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.path.is_some() {
            return;
        }
        state.path = Some(path.clone());
        let read = (|| {
            let bytes = match fs::read_to_string(&path) {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(format!("Could not read document session: {error}")),
            };
            let raw: Value = serde_json::from_str(&bytes)
                .map_err(|error| format!("Document session is invalid: {error}"))?;
            let v1 = raw["version"] == 1;
            let mut envelope = migrate(raw, first_id)?;
            if collapse {
                collapse_into_first(&mut envelope, first_id);
            }
            if v1 {
                state.original_v1 = Some(bytes);
            }
            Ok(Some(envelope))
        })();
        match read {
            Ok(envelope) => {
                if let Some(envelope) = &envelope {
                    for window in envelope["windows"].as_array().unwrap() {
                        state.restores.insert(
                            window["id"].as_str().unwrap().into(),
                            window_restore(window),
                        );
                    }
                }
                state.envelope = envelope;
            }
            Err(error) => state.error = Some(error),
        }
    }

    pub(crate) fn restore_window(
        &self,
        id: &str,
        fresh_start: bool,
    ) -> Result<Option<Value>, String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        state.check_read()?;
        // Only the first startup read establishes the whole-session fresh-start preference.
        if state.hydrated.is_empty() {
            state.fresh_start_guard = fresh_start;
        }
        state.hydrated.insert(id.into());
        Ok(state.restores.get(id).cloned())
    }

    /// `replace_preserved` means the frontend's sticky fresh-start guard observed real new work.
    /// `flush` bypasses the rate limit and reports disk failure to quit/update callers.
    pub(crate) fn submit(
        &self,
        id: &str,
        revision: u64,
        snapshot: Value,
        replace_preserved: bool,
        flush: bool,
        now: Instant,
    ) -> Result<Option<Duration>, String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        state.check_read()?;
        if !state.hydrated.contains(id) {
            return Err("Document session restore has not completed for this window".into());
        }
        if state.closed.contains(id)
            || state
                .revisions
                .get(id)
                .is_some_and(|latest| revision <= *latest)
        {
            return if flush {
                state.persist(now, true)
            } else {
                Ok(None)
            };
        }
        if !valid_tabs(&snapshot) {
            return Err("Document session snapshot has invalid tabs or active tab index".into());
        }
        if state.fresh_start_guard && !replace_preserved {
            return Ok(None);
        }
        state.fresh_start_guard = false;
        let frame = state.frames.get(id).cloned().unwrap_or(Value::Null);
        let envelope = state.envelope.get_or_insert_with(|| {
            json!({
                "version": 2, "windows": [], "activeWindowId": id
            })
        });
        if envelope["activeWindowId"].is_null() {
            envelope["activeWindowId"] = json!(id);
        }
        let windows = envelope["windows"].as_array_mut().unwrap();
        let index = windows.iter().position(|window| window["id"] == id);
        let mut window = index
            .map(|index| windows[index].clone())
            .unwrap_or_else(|| json!({ "frame": frame }));
        for (key, value) in snapshot.as_object().unwrap() {
            if key != "version" && key != "id" && key != "frame" {
                window[key] = value.clone();
            }
        }
        // An absent known optional field clears it; unknown fields remain opaque and intact.
        for key in [
            "unrestoredTabs",
            "path",
            "restoreSavePathError",
            "openWarnings",
            "saveWarnings",
            "nativeDocumentVersions",
            "view",
            "pristine",
        ] {
            if snapshot.get(key).is_none() {
                window.as_object_mut().unwrap().remove(key);
            }
        }
        window["id"] = json!(id);
        if let Some(index) = index {
            windows[index] = window;
        } else {
            windows.push(window);
        }
        state.revisions.insert(id.into(), revision);
        state.dirty = true;
        state.persist(now, flush)
    }

    pub(crate) fn tick(&self, now: Instant) -> Result<Option<Duration>, String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        state.timer_pending = false;
        state.persist(now, false)
    }

    pub(crate) fn flush(&self) -> Result<(), String> {
        self.state
            .lock()
            .map_err(|e| e.to_string())?
            .persist(Instant::now(), true)
            .map(|_| ())
    }

    pub(crate) fn set_active(&self, id: &str) -> Result<Option<Duration>, String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        if let Some(envelope) = &mut state.envelope {
            if envelope["windows"]
                .as_array()
                .unwrap()
                .iter()
                .any(|window| window["id"] == id)
                && envelope["activeWindowId"] != id
            {
                envelope["activeWindowId"] = json!(id);
                if !state.fresh_start_guard && !state.hydrated.is_empty() {
                    state.dirty = true;
                }
            }
        }
        state.persist(Instant::now(), false)
    }

    pub(crate) fn set_frame(&self, id: &str, frame: Value) -> Result<Option<Duration>, String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        state.frames.insert(id.into(), frame.clone());
        if let Some(window) = state
            .envelope
            .as_mut()
            .and_then(|envelope| envelope["windows"].as_array_mut())
            .and_then(|windows| windows.iter_mut().find(|window| window["id"] == id))
        {
            if let (Some(previous), Some(next)) =
                (window["frame"].as_object_mut(), frame.as_object())
            {
                previous.extend(next.clone());
            } else {
                window["frame"] = frame;
            }
            if !state.fresh_start_guard && !state.hydrated.is_empty() {
                state.dirty = true;
            }
        }
        state.persist(Instant::now(), false)
    }

    /// Actual close, not hide or process teardown. Tombstone the id to refuse late snapshots.
    pub(crate) fn close_window(&self, id: &str) -> Result<Option<Duration>, String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        state.closed.insert(id.into());
        state
            .offers
            .retain(|_, offer| offer.from != id && offer.to != id);
        if let Some(envelope) = &mut state.envelope {
            let windows = envelope["windows"].as_array_mut().unwrap();
            let before = windows.len();
            windows.retain(|window| window["id"] != id);
            let next = windows
                .first()
                .map(|window| window["id"].clone())
                .unwrap_or(Value::Null);
            let changed = before != windows.len();
            if envelope["activeWindowId"] == id {
                envelope["activeWindowId"] = next;
            }
            if changed && !state.fresh_start_guard {
                state.dirty = true;
            }
        }
        state.persist(Instant::now(), false)
    }

    // Held A10b: transport-neutral, one-use hand-off receipts. They deliberately do not edit tabs.
    #[allow(dead_code)]
    pub(crate) fn offer(
        &self,
        from: &str,
        to: &str,
        tab_id: &str,
        data: Value,
    ) -> Result<HandoffOffer, String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        if from == to
            || !state.hydrated.contains(from)
            || !state.hydrated.contains(to)
            || state.closed.contains(from)
            || state.closed.contains(to)
            || state.offers.values().any(|offer| offer.tab_id == tab_id)
        {
            return Err("Tab hand-off requires two live windows and no existing offer".into());
        }
        state.next_offer += 1;
        let offer = HandoffOffer {
            id: state.next_offer,
            from: from.into(),
            to: to.into(),
            tab_id: tab_id.into(),
            state: data,
            installed: false,
        };
        state.offers.insert(offer.id, offer.clone());
        Ok(offer)
    }

    #[allow(dead_code)]
    pub(crate) fn installed(&self, to: &str, receipt: u64) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        let offer = state
            .offers
            .get_mut(&receipt)
            .filter(|offer| offer.to == to && !offer.installed)
            .ok_or("Unknown, foreign, or already installed tab hand-off")?;
        offer.installed = true;
        Ok(())
    }

    #[allow(dead_code)]
    pub(crate) fn release(&self, from: &str, receipt: u64) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        if !state
            .offers
            .get(&receipt)
            .is_some_and(|offer| offer.from == from && offer.installed)
        {
            return Err("Tab hand-off has not been installed, or belongs to another source".into());
        }
        state.offers.remove(&receipt);
        Ok(())
    }
}

impl SessionState {
    fn check_read(&self) -> Result<(), String> {
        if let Some(error) = &self.error {
            return Err(error.clone());
        }
        if self.path.is_none() {
            return Err("Document session coordinator has not started".into());
        }
        Ok(())
    }

    fn persist(&mut self, now: Instant, flush: bool) -> Result<Option<Duration>, String> {
        if !self.dirty || self.fresh_start_guard {
            return Ok(None);
        }
        self.check_read()?;
        if !flush {
            if let Some(remaining) = self
                .last_write
                .and_then(|last| WRITE_INTERVAL.checked_sub(now.saturating_duration_since(last)))
                .filter(|remaining| !remaining.is_zero())
            {
                if self.timer_pending {
                    return Ok(None);
                }
                self.timer_pending = true;
                return Ok(Some(remaining));
            }
        }
        let path = self.path.as_ref().unwrap();
        // A failed backup MUST stop replacement. The original bytes (including whitespace) are
        // retained until both atomic writes succeed. Existing backups are never overwritten.
        if let Some(original) = &self.original_v1 {
            let backup = backup_path(path);
            match fs::symlink_metadata(&backup) {
                Ok(metadata) if metadata.is_file() && !metadata.is_symlink() => {}
                Ok(_) => return Err("Document session v1 backup is not a regular file".into()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    super::write_file_atomic(&backup, original)?;
                }
                Err(error) => {
                    return Err(format!(
                        "Could not inspect document session backup: {error}"
                    ))
                }
            }
        }
        let contents = serde_json::to_string_pretty(self.envelope.as_ref().unwrap())
            .map_err(|e| e.to_string())?;
        // The mutex stays held through replacement: an older writer can never publish last.
        super::write_file_atomic(path, &contents)?;
        self.original_v1 = None;
        self.last_write = Some(now);
        self.dirty = false;
        Ok(None)
    }
}

fn backup_path(path: &Path) -> PathBuf {
    let mut backup = path.as_os_str().to_owned();
    backup.push(".v1.bak");
    PathBuf::from(backup)
}

/// One timer per coordinator, including metadata-only updates. No renderer is needed to finish a
/// delayed write; a strict flush takes the same mutex and completes immediately.
pub(crate) fn schedule<R: tauri::Runtime>(app: &tauri::AppHandle<R>, delay: Option<Duration>) {
    let Some(mut delay) = delay else { return };
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(delay);
        use tauri::Manager;
        match app.state::<SessionCoordinator>().tick(Instant::now()) {
            Ok(Some(next)) => delay = next,
            Ok(None) => break,
            Err(error) => {
                eprintln!("Could not autosave document session: {error}");
                break;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Files(PathBuf);
    impl Files {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "chemdraft-session-coordinator-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn path(&self) -> PathBuf {
            self.0.join("document-session.json")
        }
        fn start(&self, session: &Value, collapse: bool) -> SessionCoordinator {
            fs::write(self.path(), serde_json::to_string_pretty(session).unwrap()).unwrap();
            let coordinator = SessionCoordinator::default();
            coordinator.initialize(self.path(), "main", collapse);
            coordinator
        }
        fn read(&self) -> Value {
            serde_json::from_str(&fs::read_to_string(self.path()).unwrap()).unwrap()
        }
    }
    impl Drop for Files {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn tab(name: &str) -> Value {
        json!({ "version": 1, "contents": format!("drawing {name}"), "payloadHash": name,
            "blank": false, "path": format!("{name}.chemdraft"), "displayName": name,
            "dirty": true, "savedAt": "unchanged", "futureTab": { "doNotDrop": [1, 2] } })
    }
    fn snapshot(name: &str) -> Value {
        let mut value = tab(name);
        value["tabs"] = json!([tab(name)]);
        value["activeTabIndex"] = json!(0);
        value
    }
    fn window(id: &str, names: &[&str], active: usize) -> Value {
        json!({ "id": id, "frame": { "x": 4, "futureFrame": "keep" },
            "activeTabIndex": active, "tabs": names.iter().map(|name| tab(name)).collect::<Vec<_>>(),
            "futureWindow": id })
    }

    #[test]
    fn migrates_v1_verbatim_and_backs_up_original_bytes_exactly_once() {
        let files = Files::new();
        let unreadable =
            json!({ "version": 99, "contents": "do not decode", "unknown": [false, null] });
        let mut old = snapshot("first");
        old["tabs"] = json!([tab("first"), unreadable, tab("third")]);
        old["activeTabIndex"] = json!(2);
        old["unrestoredTabs"] = json!([{"raw": "kept"}, 42]);
        old["futureOuter"] = json!({ "keep": true });
        let original = format!(" \n{}\n  ", serde_json::to_string(&old).unwrap());
        fs::write(files.path(), &original).unwrap();
        let coordinator = SessionCoordinator::default();
        coordinator.initialize(files.path(), "main", true);
        let restored = coordinator.restore_window("main", false).unwrap().unwrap();
        for key in ["tabs", "activeTabIndex", "unrestoredTabs", "futureOuter"] {
            assert_eq!(restored[key], old[key]);
        }
        assert!(!backup_path(&files.path()).exists()); // read alone never rewrites user data
        coordinator
            .submit("main", 1, restored.clone(), true, true, Instant::now())
            .unwrap();
        assert_eq!(
            fs::read_to_string(backup_path(&files.path())).unwrap(),
            original
        );
        assert_eq!(files.read()["windows"][0]["tabs"], old["tabs"]);
        coordinator
            .submit("main", 2, restored, true, true, Instant::now())
            .unwrap();
        assert_eq!(
            fs::read_to_string(backup_path(&files.path())).unwrap(),
            original
        );
        // A later launch over another v1 file must not overwrite the existing backup either.
        let next = files.start(&snapshot("later"), true);
        next.restore_window("main", false).unwrap();
        next.submit("main", 1, snapshot("later"), true, true, Instant::now())
            .unwrap();
        assert_eq!(
            fs::read_to_string(backup_path(&files.path())).unwrap(),
            original
        );
    }

    #[test]
    fn legacy_single_document_and_one_window_content_have_parity() {
        let files = Files::new();
        let old = tab("single");
        let coordinator = files.start(&old, true);
        let restore = coordinator.restore_window("main", false).unwrap().unwrap();
        assert_eq!(restore["tabs"], json!([old]));
        coordinator
            .submit("main", 1, restore, true, true, Instant::now())
            .unwrap();
        let actual = files.read();
        assert_eq!(actual["version"], 2);
        assert_eq!(actual["activeWindowId"], "main");
        for (key, value) in old.as_object().unwrap() {
            if key != "version" {
                assert_eq!(&actual["windows"][0][key], value);
            }
        }
        assert_eq!(actual["windows"][0]["tabs"][0], old);
    }

    #[test]
    fn interleaved_windows_keep_latest_revisions_and_rate_limit_the_merged_file() {
        let files = Files::new();
        let session = json!({ "version": 2, "windows": [window("a", &["a0"], 0), window("b", &["b0"], 0)],
            "activeWindowId": "a", "futureEnvelope": { "exact": true } });
        let coordinator = files.start(&session, false);
        coordinator.restore_window("a", false).unwrap();
        coordinator.restore_window("b", false).unwrap();
        let now = Instant::now();
        coordinator
            .submit("a", 2, snapshot("a2"), true, false, now)
            .unwrap();
        assert_eq!(files.read()["windows"][0]["tabs"][0], tab("a2"));
        let delay = coordinator
            .submit(
                "b",
                5,
                snapshot("b5"),
                true,
                false,
                now + Duration::from_millis(10),
            )
            .unwrap();
        assert_eq!(delay, Some(Duration::from_millis(790)));
        coordinator
            .submit(
                "a",
                4,
                snapshot("a4"),
                true,
                false,
                now + Duration::from_millis(20),
            )
            .unwrap();
        coordinator
            .submit(
                "a",
                3,
                snapshot("STALE"),
                true,
                false,
                now + Duration::from_millis(30),
            )
            .unwrap();
        coordinator
            .submit(
                "b",
                5,
                snapshot("DUPLICATE"),
                true,
                false,
                now + Duration::from_millis(40),
            )
            .unwrap();
        assert_eq!(files.read()["windows"][1]["tabs"][0], tab("b0"));
        assert_eq!(
            coordinator.tick(now + Duration::from_millis(799)).unwrap(),
            Some(Duration::from_millis(1))
        );
        coordinator.tick(now + Duration::from_millis(800)).unwrap();
        let actual = files.read();
        assert_eq!(actual["windows"][0]["tabs"][0], tab("a4"));
        assert_eq!(actual["windows"][1]["tabs"][0], tab("b5"));
        assert_eq!(actual["futureEnvelope"], session["futureEnvelope"]);
        assert_eq!(actual["windows"][0]["futureWindow"], "a");
        assert_eq!(
            actual["windows"][0]["frame"],
            session["windows"][0]["frame"]
        );
    }

    #[test]
    fn quit_and_update_flush_bypass_the_timer_and_stale_flush_does_not_replace_newer_data() {
        let files = Files::new();
        let coordinator = files.start(&snapshot("old"), true);
        coordinator.restore_window("main", false).unwrap();
        let now = Instant::now();
        coordinator
            .submit("main", 1, snapshot("first"), true, false, now)
            .unwrap();
        coordinator
            .submit("main", 3, snapshot("latest"), true, false, now)
            .unwrap();
        assert_eq!(files.read()["windows"][0]["tabs"][0], tab("first"));
        coordinator.flush().unwrap();
        assert_eq!(files.read()["windows"][0]["tabs"][0], tab("latest"));
        coordinator
            .submit("main", 2, snapshot("late-quit"), true, true, now)
            .unwrap();
        assert_eq!(files.read()["windows"][0]["tabs"][0], tab("latest"));
    }

    #[test]
    fn every_native_exit_and_update_route_drains_a_deferred_snapshot_once() {
        // Pair each real entry point with its flush wiring. These checks catch bypasses of the
        // coordinator, while the disk assertions below exercise the shared drain on every route.
        let lib = include_str!("lib.rs");
        let appkit = include_str!("macos_quit.rs");
        let windows_update = include_str!("../../src/appUpdates.ts");
        for (route, source, start, end, flush) in [
            (
                "quit decision / Windows last-window close",
                lib,
                "    fn exit(&self) {",
                "    /// Windows:",
                "flush_session_before_exit(self)",
            ),
            (
                "ExitRequested",
                lib,
                "            RunEvent::ExitRequested { code, api, .. } => {",
                "            RunEvent::Exit => {",
                "flush_session_before_exit(app)",
            ),
            (
                "Windows forced exit",
                lib,
                "    fn force_exit(&self, waited: Duration, reason: QuitReason) {",
                "        self.state::<ocsr_engine::OcsrEngineState>()",
                "flush_session_before_exit(self)",
            ),
            (
                "Exit",
                lib,
                "            RunEvent::Exit => {",
                "            // Dock-icon click",
                "flush_session_before_exit(app)",
            ),
            (
                "AppKit / Sparkle termination",
                appkit,
                "unsafe extern \"C\" fn should_terminate(",
                "    NSApplicationTerminateReply::TerminateNow",
                "super::flush_session(app)",
            ),
            (
                "Windows update install",
                windows_update,
                "export function tauriUpdateFlowDeps(",
                "    check: async () => {",
                "await invoke(\"flush_document_session\")",
            ),
        ] {
            let body = source
                .split_once(start)
                .unwrap()
                .1
                .split_once(end)
                .unwrap()
                .0;
            assert!(body.contains(flush), "{route} must drain the coordinator");
            let files = Files::new();
            let coordinator = files.start(&snapshot("old"), true);
            coordinator.restore_window("main", false).unwrap();
            let now = Instant::now();
            // Reproduce a metadata write followed by an accepted renderer edit inside 800 ms.
            coordinator.set_frame("main", json!({"x": 42})).unwrap();
            assert!(coordinator
                .submit("main", 1, snapshot("deferred"), true, false, now)
                .unwrap()
                .is_some());
            assert_eq!(files.read()["windows"][0]["tabs"][0], tab("old"), "{route}");
            coordinator.flush().unwrap();
            assert_eq!(
                files.read()["windows"][0]["tabs"][0],
                tab("deferred"),
                "{route}"
            );
            let written_at = coordinator.state.lock().unwrap().last_write;
            // ExitRequested, Exit and AppKit may follow a decided quit, and the old timer may
            // still fire. None may write the same snapshot a second time.
            coordinator.flush().unwrap();
            coordinator.tick(now + WRITE_INTERVAL).unwrap();
            assert_eq!(
                coordinator.state.lock().unwrap().last_write,
                written_at,
                "{route}"
            );
            assert_eq!(
                files.read()["windows"][0]["tabs"][0],
                tab("deferred"),
                "{route}"
            );
        }
        let windows_close = lib
            .split_once("// Elsewhere there is no Dock")
            .unwrap()
            .1
            .split_once("WindowEvent::Destroyed =>")
            .unwrap()
            .0;
        assert!(windows_close.contains("request_quit(window.app_handle())"));
        let update_command = lib
            .split_once("fn flush_document_session(")
            .unwrap()
            .1
            .split_once("/// JS pushes")
            .unwrap()
            .0;
        assert!(update_command.contains("flush_session(&app)"));
    }

    #[test]
    fn a_failed_terminal_flush_preserves_the_pending_snapshot_for_retry() {
        let files = Files::new();
        let coordinator = files.start(&snapshot("old"), true);
        coordinator.restore_window("main", false).unwrap();
        coordinator.set_frame("main", json!({"x": 42})).unwrap();
        coordinator
            .submit("main", 1, snapshot("deferred"), true, false, Instant::now())
            .unwrap();
        fs::remove_file(files.path()).unwrap();
        fs::create_dir(files.path()).unwrap();
        assert!(coordinator.flush().is_err());
        assert!(coordinator.state.lock().unwrap().dirty);
        fs::remove_dir(files.path()).unwrap();
        coordinator.flush().unwrap();
        assert_eq!(files.read()["windows"][0]["tabs"][0], tab("deferred"));
        coordinator.flush().unwrap();
    }

    #[test]
    fn restore_is_read_once_and_distributes_only_each_windows_own_tabs() {
        let files = Files::new();
        let session = json!({ "version": 2, "windows": [window("a", &["a1", "a2"], 1), window("b", &["b"], 0)],
            "activeWindowId": "a" });
        let coordinator = files.start(&session, false);
        fs::write(files.path(), "changed after startup").unwrap();
        for (index, id) in ["a", "b"].iter().enumerate() {
            let own = coordinator.restore_window(id, false).unwrap().unwrap();
            assert_eq!(own["tabs"], session["windows"][index]["tabs"]);
            assert_eq!(
                own["activeTabIndex"],
                session["windows"][index]["activeTabIndex"]
            );
            assert_eq!(coordinator.restore_window(id, false).unwrap(), Some(own));
        }
        assert_eq!(coordinator.restore_window("new", false).unwrap(), None);
    }

    #[test]
    fn a6_collapses_all_saved_windows_in_order_and_retains_unreadable_entries_and_metadata() {
        let files = Files::new();
        let mut a = window("old-a", &["a1", "a2"], 0);
        let raw = json!({ "version": 22, "mystery": [1, false, "drawing"] });
        a["tabs"][1] = raw.clone();
        a["unrestoredTabs"] = json!([null]);
        let mut b = window("old-b", &["b1", "b2"], 1);
        b["unrestoredTabs"] = json!([raw]);
        let session =
            json!({ "version": 2, "windows": [a, b], "activeWindowId": "old-b", "extra": "keep" });
        let coordinator = files.start(&session, true);
        let restore = coordinator.restore_window("main", false).unwrap().unwrap();
        assert_eq!(
            restore["tabs"],
            json!([tab("a1"), raw, tab("b1"), tab("b2")])
        );
        assert_eq!(restore["activeTabIndex"], 3);
        assert_eq!(restore["unrestoredTabs"], json!([null, raw]));
        coordinator
            .submit("main", 1, restore, true, true, Instant::now())
            .unwrap();
        let actual = files.read();
        assert_eq!(actual["windows"].as_array().unwrap().len(), 1);
        assert_eq!(
            actual["windows"][0]["collapsedSessionWindows"],
            session["windows"]
        );
        assert_eq!(actual["extra"], "keep");
        assert_eq!(actual["activeWindowId"], "main");
    }

    #[test]
    fn fresh_start_guards_the_whole_session_including_frames_focus_and_quit() {
        let files = Files::new();
        let old = snapshot("unsaved");
        let coordinator = files.start(&old, true);
        let original = fs::read_to_string(files.path()).unwrap();
        coordinator.set_frame("main", json!({ "x": 9 })).unwrap();
        coordinator.restore_window("main", true).unwrap();
        coordinator.restore_window("second", false).unwrap(); // cannot change the session preference
        coordinator.set_active("main").unwrap();
        coordinator.set_frame("main", json!({ "x": 10 })).unwrap();
        coordinator
            .submit("main", 1, snapshot("blank"), false, true, Instant::now())
            .unwrap();
        coordinator.flush().unwrap();
        assert_eq!(fs::read_to_string(files.path()).unwrap(), original);
        assert!(!backup_path(&files.path()).exists());
        coordinator
            .submit(
                "second",
                1,
                snapshot("new work"),
                true,
                true,
                Instant::now(),
            )
            .unwrap();
        assert_eq!(files.read()["windows"][0]["tabs"], old["tabs"]);
        assert_eq!(files.read()["windows"][1]["tabs"][0], tab("new work"));
    }

    #[test]
    fn unreadable_outer_envelopes_block_all_writes_and_backup_failure_keeps_v1() {
        for invalid in [
            json!({ "version": 99, "future": "data" }),
            json!({ "version": 1, "tabs": [tab("a")], "activeTabIndex": 4 }),
            json!({ "version": 2, "windows": [window("a", &["a"], 0)], "activeWindowId": "missing" }),
        ] {
            let files = Files::new();
            let coordinator = files.start(&invalid, true);
            assert!(coordinator.restore_window("main", true).is_err());
            assert!(coordinator
                .submit("main", 1, snapshot("blank"), true, true, Instant::now())
                .is_err());
            coordinator.flush().unwrap();
            assert_eq!(files.read(), invalid);
        }
        let files = Files::new();
        let old = snapshot("important");
        let coordinator = files.start(&old, true);
        coordinator.restore_window("main", false).unwrap();
        fs::create_dir(backup_path(&files.path())).unwrap();
        assert!(coordinator
            .submit("main", 1, snapshot("new"), true, true, Instant::now())
            .is_err());
        assert_eq!(files.read(), old);
        fs::remove_dir(backup_path(&files.path())).unwrap();
        coordinator.flush().unwrap();
        assert_eq!(files.read()["windows"][0]["tabs"][0], tab("new"));
    }

    #[test]
    fn close_removes_only_that_window_and_refuses_late_snapshots() {
        let files = Files::new();
        let coordinator = files.start(
            &json!({ "version": 2, "windows": [window("a", &["a"], 0), window("b", &["b"], 0)],
            "activeWindowId": "b" }),
            false,
        );
        coordinator.restore_window("a", false).unwrap();
        coordinator.restore_window("b", false).unwrap();
        coordinator.close_window("b").unwrap();
        coordinator
            .submit("b", 999, snapshot("late"), true, true, Instant::now())
            .unwrap();
        assert_eq!(files.read()["windows"].as_array().unwrap().len(), 1);
        assert_eq!(files.read()["windows"][0]["id"], "a");
        assert_eq!(files.read()["activeWindowId"], "a");
    }

    #[test]
    fn handoff_stub_client_dry_run_transfers_opaque_state_only_after_installation() {
        let files = Files::new();
        let coordinator = files.start(&snapshot("source"), true);
        coordinator.restore_window("main", false).unwrap();
        coordinator.restore_window("destination", false).unwrap();
        let history = json!({ "past": [{ "drawing": "before" }], "present": { "drawing": "now" },
            "future": [{ "drawing": "redo" }], "undoLabels": ["label"], "dirty": true,
            "tabId": "stable-tab", "savedBaseline": { "raw": "exact" } });
        let offer = coordinator
            .offer("main", "destination", "stable-tab", history.clone())
            .unwrap();
        assert_eq!(offer.state, history); // the stub destination installs exactly these bytes
        assert_eq!(offer.tab_id, "stable-tab");
        assert!(coordinator.release("main", offer.id).is_err());
        assert!(coordinator.installed("foreign", offer.id).is_err());
        assert!(coordinator
            .offer("main", "destination", "stable-tab", Value::Null)
            .is_err());
        coordinator.installed("destination", offer.id).unwrap();
        assert!(coordinator.installed("destination", offer.id).is_err());
        assert!(coordinator.release("foreign", offer.id).is_err());
        coordinator.release("main", offer.id).unwrap();
        assert!(coordinator.release("main", offer.id).is_err());
        // A6 exposes hooks only: neither the saved session nor live tabs are moved.
        assert_eq!(files.read(), snapshot("source"));
    }
}
