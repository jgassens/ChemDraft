//! Bridge-gated timing log. Clock and writer are shared by every webview in this process.
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const MAX_BYTES: u64 = 20 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 16 * 1024;
// Independent webview midpoint calibrations: allow at most 10 ms of receipt clock skew.
const COMPLETION_CLOCK_SKEW_MS: f64 = 10.0;

struct Clock {
    instant: Instant,
    epoch_ms: f64,
}
pub(crate) struct PerfLog {
    clock: Option<Clock>,
    build_stamp: Mutex<Option<String>>,
    writer: Mutex<()>,
    error_reported: AtomicBool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClockSample {
    now: f64,
    process_start: f64,
    build_stamp: Option<String>,
}
impl PerfLog {
    /// Call at the beginning of run(), before constructing the Tauri builder. Disabled runs do
    /// not read a clock, open a file, create a directory or install an initialization script.
    pub(crate) fn new(enabled: bool) -> Self {
        Self {
            clock: enabled.then(|| Clock {
                instant: Instant::now(),
                epoch_ms: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs_f64()
                    * 1000.0,
            }),
            writer: Mutex::new(()),
            build_stamp: Mutex::new(None),
            error_reported: AtomicBool::new(false),
        }
    }
    fn sample(&self) -> Result<ClockSample, String> {
        let clock = self.clock.as_ref().ok_or("Agent bridge is disabled")?;
        Ok(ClockSample {
            now: clock.epoch_ms + clock.instant.elapsed().as_secs_f64() * 1000.0,
            process_start: clock.epoch_ms,
            build_stamp: self
                .build_stamp
                .lock()
                .map_err(|_| "Perf stamp lock poisoned")?
                .clone(),
        })
    }
    fn register_stamp(&self, source: &str, stamp: String) -> Result<(), String> {
        self.sample()?;
        if source != "main" || stamp.is_empty() || stamp.chars().count() > 256 {
            return Err("Invalid perf build stamp or source window".into());
        }
        let mut stored = self
            .build_stamp
            .lock()
            .map_err(|_| "Perf stamp lock poisoned")?;
        if stored.as_ref().is_some_and(|previous| previous != &stamp) {
            return Err("Perf build stamp already registered".into());
        }
        *stored = Some(stamp);
        Ok(())
    }
    fn append(&self, directory: &Path, line: &str, max_bytes: u64) -> Result<(), String> {
        let sample = self.sample()?; // Gate BEFORE validation, path access, mkdir and opening files.
        let stamp = sample
            .build_stamp
            .ok_or("Perf build stamp not registered")?;
        validate_line(line)?;
        let mut record: serde_json::Value =
            serde_json::from_str(line).map_err(|e| e.to_string())?;
        record["buildStamp"] = stamp.into();
        let line = serde_json::to_string(&record).map_err(|e| e.to_string())?;
        validate_line(&line)?;
        let bytes = line.len() as u64 + 1;
        if bytes > max_bytes {
            return Err("Perf record exceeds log size cap".into());
        }
        let _guard = self.writer.lock().map_err(|_| "Perf log lock poisoned")?;
        fs::create_dir_all(directory).map_err(|e| e.to_string())?;
        let path = directory.join("perf-log.jsonl");
        let size = match fs::metadata(&path) {
            Ok(metadata) => metadata.len(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
            Err(error) => return Err(error.to_string()),
        };
        if size.saturating_add(bytes) > max_bytes {
            let rotated = directory.join("perf-log.1.jsonl");
            self.rotate_with(&path, &rotated, |from, to| fs::rename(from, to))
                .map_err(|e| e.to_string())?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| e.to_string())?;
        file.write_all(format!("{line}\n").as_bytes())
            .map_err(|e| e.to_string())
    }
    fn report_error_once(&self, error: &std::io::Error) {
        if !self.error_reported.swap(true, Ordering::Relaxed) {
            eprintln!("Perf log rotation failed; trying copy and truncate: {error}");
        }
    }
    fn rotate_with(
        &self,
        path: &Path,
        rotated: &Path,
        rename: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
    ) -> std::io::Result<()> {
        // Try replacement without deleting the backup first. Windows sharing restrictions can
        // refuse rename while still allowing copy and in-place truncation of the current log.
        if let Err(error) = rename(path, rotated) {
            self.report_error_once(&error);
            fs::copy(path, rotated)?;
            // Never truncate the current log until the backup copy has succeeded.
            OpenOptions::new().write(true).open(path)?.set_len(0)?;
        }
        Ok(())
    }
}

fn validate_line(line: &str) -> Result<(), String> {
    if line.is_empty() || line.len() > MAX_LINE_BYTES || line.contains(['\n', '\r']) {
        return Err("Perf record must be one JSON line of at most 16384 bytes".into());
    }
    let record: serde_json::Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
    let object = record.as_object().ok_or("Perf record must be an object")?;
    let allowed = [
        "v",
        "kind",
        "commandId",
        "window",
        "platform",
        "buildStamp",
        "t0",
        "firstFrameMs",
        "doneMs",
        "doneSignal",
        "extra",
    ];
    let one_of =
        |key: &str, values: &[&str]| record[key].as_str().is_some_and(|s| values.contains(&s));
    let number = |key: &str| {
        record[key]
            .as_f64()
            .is_some_and(|n| n.is_finite() && n >= 0.0)
    };
    if object.keys().any(|k| !allowed.contains(&k.as_str()))
        || record["v"] != 1
        || !one_of(
            "kind",
            &[
                "pointerdown",
                "click",
                "keydown",
                "native-command",
                "cold-launch",
                "document-open",
                "window-shown",
                "dialog-open",
            ],
        )
        || !one_of(
            "window",
            &[
                "main",
                "palette",
                "palette-popover",
                "dialog",
                "plugin-panel",
                "preferences",
                "spin3d-debugger",
            ],
        )
        || !one_of("platform", &["macos", "windows", "linux"])
        || !record["buildStamp"]
            .as_str()
            .is_some_and(|s| s.len() <= 1024)
        || !number("t0")
        || ["firstFrameMs", "doneMs"]
            .iter()
            .any(|key| object.contains_key(*key) && !number(key))
        || (object.contains_key("commandId")
            && !record["commandId"]
                .as_str()
                .is_some_and(|s| s.len() <= 1024))
        || (object.contains_key("extra") && !record["extra"].is_object())
        || (object.contains_key("doneSignal")
            && !one_of(
                "doneSignal",
                &[
                    "document-commit",
                    "window-shown",
                    "dialog-open",
                    "export-written",
                    "command-finished",
                    "gesture-ended",
                    "frame",
                    "canvas-ready",
                    "popover-shown",
                    "no-op",
                    "timeout",
                    "failed",
                ],
            ))
    {
        return Err("Invalid v1 perf record".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn perf_log_clock(
    state: tauri::State<'_, PerfLog>,
    window: tauri::WebviewWindow,
    build_stamp: Option<String>,
) -> Result<ClockSample, String> {
    if let Some(stamp) = build_stamp {
        state.register_stamp(window.label(), stamp)?;
    }
    state.sample()
}

#[tauri::command]
pub(crate) async fn perf_log_append(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    line: String,
) -> Result<(), String> {
    // Reject before even resolving app_data_dir. The state was constructed using precisely the
    // existing agent_bridge_status env/argument parser, never renderer flags.
    app.state::<PerfLog>().sample()?;
    let receipt = popover_receipt(window.label(), &line);
    let writer_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let directory = writer_app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?;
        writer_app
            .state::<PerfLog>()
            .append(&directory, &line, MAX_BYTES)
    })
    .await
    .map_err(|e| e.to_string())??;
    // Recording is already granted to popovers. Relay only their own shown boundary to their
    // owning palette, derived from the authenticated label, without granting general emission
    // or perf_log_complete access to either window.
    if let Some((target, payload)) = receipt {
        if let Some(destination) = app.get_webview_window(&target) {
            destination
                .eval(format!(
                    "window.dispatchEvent(new CustomEvent('chemdraft:perf-complete', {{detail:{payload}}}));"
                ))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn popover_receipt(source: &str, line: &str) -> Option<(String, serde_json::Value)> {
    let owner = source.strip_prefix("toolset-popover-")?;
    if owner.is_empty() || validate_line(line).is_err() {
        return None;
    }
    let row: serde_json::Value = serde_json::from_str(line).ok()?;
    if row["kind"] != "window-shown"
        || row["window"] != "palette-popover"
        || !matches!(
            row["doneSignal"].as_str(),
            Some("popover-shown" | "no-op" | "failed")
        )
    {
        return None;
    }
    let flyout = row["extra"]["surface"].as_str()?;
    if flyout.is_empty() || flyout.len() > 256 {
        return None;
    }
    let t0 = row["t0"].as_f64()?;
    let at = t0 + row["doneMs"].as_f64()?;
    let frame = row["firstFrameMs"].as_f64().map(|elapsed| t0 + elapsed);
    if !at.is_finite()
        || (row["doneSignal"] == "popover-shown" && frame.is_none())
        || frame.is_some_and(|frame| !frame.is_finite() || frame < at - COMPLETION_CLOCK_SKEW_MS)
    {
        return None;
    }
    Some((
        format!("toolset-{owner}"),
        serde_json::json!({ "requestKey": "popover-shown", "signal": row["doneSignal"],
            "flyoutId": flyout, "at": at, "frameAt": frame, "window": source }),
    ))
}

/// A completion has no command payload and cannot open windows or write arbitrary files. The
/// source window is native-authenticated; only main<->dialog receipts may cross this seam.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Completion {
    target: String,
    request_key: String,
    signal: String,
    at: f64,
    frame_at: Option<f64>,
}
#[tauri::command]
pub(crate) fn perf_log_complete(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    completion: Completion,
) -> Result<(), String> {
    app.state::<PerfLog>().sample()?;
    let Completion {
        target,
        request_key,
        signal,
        at,
        frame_at,
    } = completion;
    let source = window.label();
    if !valid_completion(source, &target, &request_key, &signal, at, frame_at) {
        return Err("Invalid perf completion route or payload".into());
    }
    let destination = app
        .get_webview_window(&target)
        .ok_or("Perf completion window closed")?;
    let payload = serde_json::json!({ "requestKey": request_key, "signal": signal, "at": at,
        "frameAt": frame_at, "window": source });
    destination
        .eval(format!(
        "window.dispatchEvent(new CustomEvent('chemdraft:perf-complete', {{detail:{payload}}}));"
    ))
        .map_err(|e| e.to_string())
}

fn valid_completion(
    source: &str,
    target: &str,
    key: &str,
    signal: &str,
    at: f64,
    frame: Option<f64>,
) -> bool {
    let route = (source == "main"
        && target.starts_with("dialog-main-")
        && matches!(signal, "export-written" | "document-commit" | "dialog-open"))
        || (source.starts_with("dialog-main-") && target == "main" && signal == "dialog-open");
    route
        && !key.is_empty()
        && key.len() <= 128
        && key
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b':'))
        && at.is_finite()
        && at >= 0.0
        && frame.is_none_or(|f| f.is_finite() && f >= 0.0 && f >= at - COMPLETION_CLOCK_SKEW_MS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    fn dir() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "chemdraft-perf-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }
    fn line() -> String {
        serde_json::json!({"v":1,"kind":"click","window":"main","platform":"windows","buildStamp":"test","t0":1,"firstFrameMs":2,"doneMs":3,"doneSignal":"document-commit"}).to_string()
    }
    #[test]
    fn popover_shown_receipt_is_restricted_to_the_authenticated_owner() {
        let row = serde_json::json!({"v":1,"kind":"window-shown","window":"palette-popover",
            "platform":"macos","buildStamp":"test","t0":100,"doneMs":30,
            "firstFrameMs":40,"doneSignal":"popover-shown","extra":{"surface":"arrows"}})
        .to_string();
        let (target, receipt) = popover_receipt("toolset-popover-core-main", &row).unwrap();
        assert_eq!(target, "toolset-core-main");
        assert_eq!(receipt["at"], 130.0);
        assert_eq!(receipt["frameAt"], 140.0);
        assert_eq!(receipt["flyoutId"], "arrows");
        let mut cancelled: serde_json::Value = serde_json::from_str(&row).unwrap();
        cancelled["doneSignal"] = "no-op".into();
        cancelled.as_object_mut().unwrap().remove("firstFrameMs");
        let (_, receipt) =
            popover_receipt("toolset-popover-core-main", &cancelled.to_string()).unwrap();
        assert_eq!(receipt["signal"], "no-op");
        for source in [
            "main",
            "preferences",
            "toolset-core-main",
            "toolset-popover-",
        ] {
            assert!(popover_receipt(source, &row).is_none());
        }
        for changed in [
            row.replace("popover-shown", "document-commit"),
            row.replace("window-shown", "click"),
            row.replace("palette-popover", "main"),
        ] {
            assert!(popover_receipt("toolset-popover-core-main", &changed).is_none());
        }
        for (kind, signal, role) in [
            ("dialog-open", "dialog-open", "dialog"),
            ("window-shown", "window-shown", "preferences"),
        ] {
            let row = serde_json::json!({"v":1,"kind":kind,"window":role,"platform":"windows",
                "buildStamp":"test","t0":1,"doneSignal":signal})
            .to_string();
            validate_line(&row).unwrap();
        }
    }
    #[test]
    fn dialog_rows_use_only_the_main_windows_registered_stamp() {
        let path = dir();
        let state = PerfLog::new(true);
        let mut dialog: serde_json::Value = serde_json::from_str(&line()).unwrap();
        dialog["window"] = "dialog".into();
        dialog["buildStamp"] = "secondary stamp".into();
        let dialog = dialog.to_string();
        assert!(state.append(&path, &dialog, MAX_BYTES).is_err());
        assert!(!path.exists());
        assert!(state
            .register_stamp("dialog-main-export-1", "wrong".into())
            .is_err());
        state.register_stamp("main", "main stamp".into()).unwrap();
        assert!(state.register_stamp("main", "replacement".into()).is_err());
        state.append(&path, &dialog, MAX_BYTES).unwrap();
        let row: serde_json::Value = serde_json::from_str(
            fs::read_to_string(path.join("perf-log.jsonl"))
                .unwrap()
                .trim(),
        )
        .unwrap();
        assert_eq!(row["window"], "dialog");
        assert_eq!(row["buildStamp"], "main stamp");
        fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn failed_rename_copies_before_truncating_and_logging_continues() {
        let directory = dir();
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("perf-log.jsonl");
        let backup = directory.join("perf-log.1.jsonl");
        let state = PerfLog::new(true);
        state.register_stamp("main", "test".into()).unwrap();
        let line = line();
        state.append(&directory, &line, MAX_BYTES).unwrap();
        fs::write(&backup, "old backup").unwrap();
        for _ in 0..2 {
            state
                .rotate_with(&path, &backup, |_, _| {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "simulated Windows sharing restriction",
                    ))
                })
                .unwrap();
            assert!(state.error_reported.load(Ordering::Relaxed));
            assert_eq!(fs::read_to_string(&backup).unwrap(), format!("{line}\n"));
            assert_eq!(fs::metadata(&path).unwrap().len(), 0);
            state.append(&directory, &line, MAX_BYTES).unwrap();
        }
        assert_eq!(fs::read_to_string(&path).unwrap(), format!("{line}\n"));
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn failed_fallback_preserves_current_log_for_a_later_retry() {
        let directory = dir();
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("perf-log.jsonl");
        let backup = directory.join("perf-log.1.jsonl");
        fs::write(&path, "keep this log").unwrap();
        fs::create_dir(&backup).unwrap();
        let state = PerfLog::new(true);
        state.register_stamp("main", "test".into()).unwrap();
        assert!(state
            .rotate_with(&path, &backup, |_, _| Err(std::io::Error::from(
                std::io::ErrorKind::PermissionDenied
            )))
            .is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "keep this log");
        fs::remove_dir(&backup).unwrap();
        state
            .rotate_with(&path, &backup, |from, to| fs::rename(from, to))
            .unwrap();
        assert_eq!(fs::read_to_string(&backup).unwrap(), "keep this log");
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn completion_accepts_only_bounded_clock_skew_and_distinct_roles_validate() {
        for delta in [0.0, 10.0] {
            assert!(valid_completion(
                "dialog-main-export-1",
                "main",
                "session-1",
                "dialog-open",
                100.0,
                Some(100.0 - delta)
            ));
        }
        for frame in [89.9, -1.0, f64::NAN, f64::INFINITY] {
            assert!(!valid_completion(
                "dialog-main-export-1",
                "main",
                "session-1",
                "dialog-open",
                100.0,
                Some(frame)
            ));
        }
        for role in ["preferences", "spin3d-debugger"] {
            validate_line(
                &line().replace("\"window\":\"main\"", &format!("\"window\":\"{role}\"")),
            )
            .unwrap();
        }
    }
    #[test]
    fn disabled_rejects_without_creating_directory_or_file() {
        let path = dir();
        let state = PerfLog::new(false);
        assert!(state.register_stamp("main", "test".into()).is_err());
        assert!(state.sample().is_err());
        assert!(state.append(&path, &line(), MAX_BYTES).is_err());
        assert!(!path.exists());
    }
    #[test]
    fn appends_and_rotates_once_before_crossing_cap() {
        let path = dir();
        let state = PerfLog::new(true);
        state.register_stamp("main", "test".into()).unwrap();
        let line = line();
        let cap = (line.len() as u64 + 1) * 2;
        for _ in 0..7 {
            state.append(&path, &line, cap).unwrap();
        }
        assert_eq!(
            fs::read_to_string(path.join("perf-log.jsonl")).unwrap(),
            format!("{line}\n")
        );
        assert_eq!(
            fs::read_to_string(path.join("perf-log.1.jsonl")).unwrap(),
            format!("{line}\n{line}\n")
        );
        assert_eq!(fs::read_dir(&path).unwrap().count(), 2);
        fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn invalid_and_oversized_lines_never_create_files() {
        let path = dir();
        let state = PerfLog::new(true);
        state.register_stamp("main", "test".into()).unwrap();
        for bad in [
            "{}".to_string(),
            format!("{}\n{}", line(), line()),
            "x".repeat(MAX_LINE_BYTES + 1),
            line().replace("\"v\":1", "\"v\":2"),
            line().replace("\"doneMs\":3", "\"doneMs\":-1"),
        ] {
            assert!(state.append(&path, &bad, MAX_BYTES).is_err(), "{bad}");
        }
        assert!(state.append(&path, &line(), 1).is_err());
        assert!(!path.exists());
    }
    #[test]
    fn clock_is_shared_and_monotonic() {
        let state = PerfLog::new(true);
        state.register_stamp("main", "test".into()).unwrap();
        let a = state.sample().unwrap();
        let b = state.sample().unwrap();
        assert_eq!(a.process_start, b.process_start);
        assert!(b.now >= a.now && a.now >= a.process_start);
    }
    #[test]
    fn completion_routes_are_narrow_and_numeric() {
        assert!(valid_completion(
            "main",
            "dialog-main-export-1",
            "request-1",
            "export-written",
            1.0,
            None
        ));
        assert!(valid_completion(
            "dialog-main-export-1",
            "main",
            "session-1",
            "dialog-open",
            1.0,
            Some(2.0)
        ));
        assert!(!valid_completion(
            "plugin-panel-1",
            "main",
            "session-1",
            "dialog-open",
            1.0,
            None
        ));
        assert!(!valid_completion(
            "main",
            "main",
            "request-1",
            "export-written",
            1.0,
            None
        ));
        assert!(!valid_completion(
            "main",
            "dialog-main-export-1",
            "request-1",
            "export-written",
            f64::NAN,
            None
        ));
        assert!(!valid_completion(
            "main",
            "dialog-main-export-1",
            "request-1",
            "export-written",
            20.0,
            Some(1.0)
        ));
    }
}
