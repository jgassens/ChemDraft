//! Bridge-gated timing log. Clock and writer are shared by every webview in this process.
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    sync::Mutex,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const MAX_BYTES: u64 = 20 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 16 * 1024;

struct Clock {
    instant: Instant,
    epoch_ms: f64,
}
pub(crate) struct PerfLog {
    clock: Option<Clock>,
    writer: Mutex<()>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClockSample {
    now: f64,
    process_start: f64,
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
        }
    }
    fn sample(&self) -> Result<ClockSample, String> {
        let clock = self.clock.as_ref().ok_or("Agent bridge is disabled")?;
        Ok(ClockSample {
            now: clock.epoch_ms + clock.instant.elapsed().as_secs_f64() * 1000.0,
            process_start: clock.epoch_ms,
        })
    }
    fn append(&self, directory: &Path, line: &str, max_bytes: u64) -> Result<(), String> {
        self.sample()?; // Gate BEFORE validation, path access, mkdir and opening files.
        validate_line(line)?;
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
            // Windows rename does not replace an existing destination.
            match fs::remove_file(&rotated) {
                Ok(()) => (),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(error) => return Err(error.to_string()),
            }
            fs::rename(&path, &rotated).map_err(|e| e.to_string())?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| e.to_string())?;
        file.write_all(format!("{line}\n").as_bytes())
            .map_err(|e| e.to_string())
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
pub(crate) fn perf_log_clock(state: tauri::State<'_, PerfLog>) -> Result<ClockSample, String> {
    state.sample()
}

#[tauri::command]
pub(crate) async fn perf_log_append(app: tauri::AppHandle, line: String) -> Result<(), String> {
    // Reject before even resolving app_data_dir. The state was constructed using precisely the
    // existing agent_bridge_status env/argument parser, never renderer flags.
    app.state::<PerfLog>().sample()?;
    tauri::async_runtime::spawn_blocking(move || {
        let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
        app.state::<PerfLog>().append(&directory, &line, MAX_BYTES)
    })
    .await
    .map_err(|e| e.to_string())?
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
        && frame.is_none_or(|f| f.is_finite() && f >= at)
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
    fn disabled_rejects_without_creating_directory_or_file() {
        let path = dir();
        let state = PerfLog::new(false);
        assert!(state.sample().is_err());
        assert!(state.append(&path, &line(), MAX_BYTES).is_err());
        assert!(!path.exists());
    }
    #[test]
    fn appends_and_rotates_once_before_crossing_cap() {
        let path = dir();
        let state = PerfLog::new(true);
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
            2.0,
            Some(1.0)
        ));
    }
}
