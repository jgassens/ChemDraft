//! Display-only transient above floating palettes. Document authority stays in `main`.
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{ipc::Channel, Manager, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const LABEL: &str = "file-warnings";
const MAX_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Row {
    code: String,
    message: String,
    target: String,
    missing: bool,
    can_show: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Report {
    heading: String,
    rows: Vec<Row>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Snapshot {
    session_id: String,
    revision: u32,
    reports: Vec<Report>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Anchor {
    x: f64,
    y: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Action {
    Close {
        #[serde(rename = "sessionId")]
        session_id: String,
        revision: u32,
    },
    Show {
        #[serde(rename = "sessionId")]
        session_id: String,
        revision: u32,
        #[serde(rename = "reportIndex")]
        report_index: usize,
        #[serde(rename = "warningIndex")]
        warning_index: usize,
    },
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Chunk {
    session_id: String,
    revision: u32,
    index: usize,
    total: usize,
    json: String,
}
struct Session {
    snapshot: Snapshot,
    owner: Channel<Action>,
    focus: bool,
    revealed: bool,
}
struct State {
    session: Option<Session>,
    host: Option<Channel<Chunk>>,
}
static STATE: Mutex<State> = Mutex::new(State {
    session: None,
    host: None,
});

fn authorize(label: &str, expected: &str) -> Result<(), String> {
    if label == expected {
        Ok(())
    } else {
        Err("File warnings caller is not authorized".into())
    }
}

fn validate(snapshot: &Snapshot) -> Result<(), String> {
    if snapshot.session_id.is_empty()
        || snapshot.session_id.len() > 64
        || !snapshot
            .session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
        || snapshot.revision == 0
        || snapshot.reports.is_empty()
        || snapshot.reports.len() > 2
        || snapshot.reports.iter().map(|r| r.rows.len()).sum::<usize>() > 20000
        || serde_json::to_vec(snapshot)
            .map_err(|e| e.to_string())?
            .len()
            > MAX_BYTES
    {
        return Err("File warnings exceed the native presentation limit".into());
    }
    Ok(())
}

fn chunks(snapshot: &Snapshot) -> Result<Vec<Chunk>, String> {
    let json = serde_json::to_string(snapshot).map_err(|e| e.to_string())?;
    // At most 512 Unicode scalars, each <= 6 escaped JSON bytes. Including the
    // envelope this stays below 4096, avoiding Tauri's unauthenticated fetch queue.
    let chars: Vec<char> = json.chars().collect();
    let total = chars.len().div_ceil(512);
    Ok(chars
        .chunks(512)
        .enumerate()
        .map(|(index, part)| Chunk {
            session_id: snapshot.session_id.clone(),
            revision: snapshot.revision,
            index,
            total,
            json: part.iter().collect(),
        })
        .collect())
}

fn publish(state: &State) -> Result<(), String> {
    if let (Some(session), Some(host)) = (&state.session, &state.host) {
        for chunk in chunks(&session.snapshot)? {
            host.send(chunk).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn window_config(windows: bool) -> tauri::utils::config::WindowConfig {
    tauri::utils::config::WindowConfig {
        label: LABEL.into(),
        url: WebviewUrl::App("/?window=fileWarnings".into()),
        title: "File warnings — ChemDraft".into(),
        // `parent` is a document HWND owner on Windows. Never an AppKit child:
        // addChildWindow would reset the separately configured floating + 1 level.
        parent: windows.then(|| super::MAIN_WINDOW_LABEL.into()),
        width: 520.0,
        height: 360.0,
        focus: false,
        focusable: true,
        skip_taskbar: true,
        visible: false,
        decorations: false,
        resizable: false,
        shadow: true,
        accept_first_mouse: true,
        always_on_top: false,
        ..Default::default()
    }
}

#[cfg(any(target_os = "macos", test))]
fn window_level(floating: isize) -> isize {
    floating + 1
}

#[cfg(target_os = "macos")]
fn configure<R: Runtime>(window: &tauri::WebviewWindow<R>, reveal: bool) -> Result<(), String> {
    use objc2_app_kit::{
        NSFloatingWindowLevel, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask,
    };
    let target = window.clone();
    super::run_on_main_thread_blocking(window, move || {
        let ptr = target.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
        let native = unsafe { ptr.as_ref() }.ok_or("File warnings native window is unavailable")?;
        native.setStyleMask(
            native.styleMask()
                | NSWindowStyleMask::UtilityWindow
                | NSWindowStyleMask::NonactivatingPanel,
        );
        native.setLevel(window_level(NSFloatingWindowLevel));
        native.setHidesOnDeactivate(true);
        native.setCanHide(true);
        native.setCollectionBehavior(
            NSWindowCollectionBehavior::Transient
                | NSWindowCollectionBehavior::Auxiliary
                | NSWindowCollectionBehavior::IgnoresCycle
                | NSWindowCollectionBehavior::MoveToActiveSpace,
        );
        if reveal {
            native.orderFront(None);
        }
        Ok(())
    })?
}

#[cfg(not(target_os = "macos"))]
fn configure<R: Runtime>(window: &tauri::WebviewWindow<R>, reveal: bool) -> Result<(), String> {
    if reveal {
        // focus:false uses SW_SHOWNOACTIVATE; HWND_TOP then raises among the
        // document's owned windows without activation or HWND_TOPMOST.
        window.show().map_err(|e| e.to_string())?;
        super::raise_among_owned_windows(window)?;
    }
    Ok(())
}

fn place<R: Runtime>(window: &tauri::WebviewWindow<R>, anchor: Anchor) -> Result<(), String> {
    let monitors = window.available_monitors().map_err(|e| e.to_string())?;
    let monitor = monitors
        .iter()
        .find(|monitor| {
            let (left, top, right, bottom) = super::monitor_logical_bounds(monitor);
            anchor.x >= left && anchor.x < right && anchor.y >= top && anchor.y < bottom
        })
        .or(monitors.first())
        .ok_or("No monitor is available for file warnings")?;
    let area = super::monitor_logical_work_area(monitor);
    let width = 520.0_f64.min(area.width);
    let height = 360.0_f64.min(area.height);
    // Size with the DESTINATION scale before moving; the hidden window may still
    // report the previous monitor's scale on a mixed-DPI Windows desktop.
    window
        .set_size(tauri::PhysicalSize::new(
            (width * monitor.scale_factor()).round() as u32,
            (height * monitor.scale_factor()).round() as u32,
        ))
        .map_err(|e| e.to_string())?;
    super::set_window_global_logical_position(
        window,
        anchor.x.min(area.x + area.width - width).max(area.x),
        (anchor.y - height)
            .min(area.y + area.height - height)
            .max(area.y),
    )
}

#[tauri::command]
pub(crate) async fn file_warnings_open(
    window: tauri::WebviewWindow,
    snapshot: Snapshot,
    anchor: Anchor,
    focus: bool,
    on_action: Channel<Action>,
) -> Result<(), String> {
    authorize(window.label(), super::MAIN_WINDOW_LABEL)?;
    validate(&snapshot)?;
    if !anchor.x.is_finite() || !anchor.y.is_finite() {
        return Err("Invalid file warnings anchor".into());
    }
    let app = window.app_handle();
    let _creation = super::lock_window_creation()?;
    let target = match app.get_webview_window(LABEL) {
        Some(target) => target,
        None => {
            let target = WebviewWindowBuilder::from_config(app, &window_config(cfg!(windows)))
                .map_err(|e| e.to_string())?
                .build()
                .map_err(|e| e.to_string())?;
            super::disable_default_context_menus(&target);
            configure(&target, false)?;
            target
        }
    };
    target.hide().map_err(|e| e.to_string())?;
    place(&target, anchor)?;
    let mut state = STATE.lock().map_err(|e| e.to_string())?;
    state.session = Some(Session {
        snapshot,
        owner: on_action,
        focus,
        revealed: false,
    });
    publish(&state)
}

#[tauri::command]
pub(crate) fn file_warnings_request(
    window: tauri::WebviewWindow,
    on_snapshot: Channel<Chunk>,
) -> Result<(), String> {
    authorize(window.label(), LABEL)?;
    let mut state = STATE.lock().map_err(|e| e.to_string())?;
    state.host = Some(on_snapshot);
    publish(&state)
}

#[tauri::command]
pub(crate) fn file_warnings_publish(
    window: tauri::WebviewWindow,
    snapshot: Snapshot,
) -> Result<(), String> {
    authorize(window.label(), super::MAIN_WINDOW_LABEL)?;
    validate(&snapshot)?;
    let mut state = STATE.lock().map_err(|e| e.to_string())?;
    if let Some(session) = &mut state.session {
        if session.snapshot.session_id == snapshot.session_id
            && snapshot.revision > session.snapshot.revision
        {
            session.snapshot = snapshot;
            publish(&state)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn file_warnings_ready(
    window: tauri::WebviewWindow,
    session_id: String,
    revision: u32,
) -> Result<(), String> {
    authorize(window.label(), LABEL)?;
    let focus = {
        let mut state = STATE.lock().map_err(|e| e.to_string())?;
        let Some(session) = &mut state.session else {
            return Ok(());
        };
        if session.snapshot.session_id != session_id
            || session.snapshot.revision != revision
            || session.revealed
        {
            return Ok(());
        }
        session.revealed = true;
        session.focus
    };
    if super::utility_windows_suspended() || !super::foreground_belongs_to_app() {
        dismiss(window.app_handle());
        return Ok(());
    }
    configure(&window, true)?;
    if focus {
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn accepts(snapshot: &Snapshot, action: &Action) -> bool {
    let (session_id, revision) = match action {
        Action::Close {
            session_id,
            revision,
        }
        | Action::Show {
            session_id,
            revision,
            ..
        } => (session_id, revision),
    };
    session_id == &snapshot.session_id
        && match action {
            Action::Close { .. } => true,
            Action::Show {
                report_index,
                warning_index,
                ..
            } => {
                *revision == snapshot.revision
                    && snapshot
                        .reports
                        .get(*report_index)
                        .and_then(|report| report.rows.get(*warning_index))
                        .is_some_and(|row| row.can_show)
            }
        }
}

#[tauri::command]
pub(crate) fn file_warnings_action(
    window: tauri::WebviewWindow,
    action: Action,
) -> Result<(), String> {
    authorize(window.label(), LABEL)?;
    {
        let state = STATE.lock().map_err(|e| e.to_string())?;
        let Some(session) = &state.session else {
            return Ok(());
        };
        if !accepts(&session.snapshot, &action) {
            return Ok(());
        }
        if !matches!(action, Action::Close { .. }) {
            return session.owner.send(action).map_err(|e| e.to_string());
        }
    }
    dismiss(window.app_handle());
    Ok(())
}

pub(crate) fn dismiss<R: Runtime>(app: &tauri::AppHandle<R>) {
    let session = STATE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .session
        .take();
    if let Some(session) = session {
        let _ = session.owner.send(Action::Close {
            session_id: session.snapshot.session_id,
            revision: session.snapshot.revision,
        });
        if let Some(window) = app.get_webview_window(LABEL) {
            let _ = window.hide();
        }
    }
}

#[tauri::command]
pub(crate) fn file_warnings_close(
    window: tauri::WebviewWindow,
    session_id: String,
) -> Result<(), String> {
    authorize(window.label(), super::MAIN_WINDOW_LABEL)?;
    let matches = STATE
        .lock()
        .map_err(|e| e.to_string())?
        .session
        .as_ref()
        .is_some_and(|session| session.snapshot.session_id == session_id);
    if matches {
        dismiss(window.app_handle());
    }
    Ok(())
}

/// A narrow dismissal-only grant for clicks in any other trusted app webview.
#[tauri::command]
pub(crate) fn file_warnings_dismiss(window: tauri::WebviewWindow) {
    if window.label() != LABEL {
        dismiss(window.app_handle());
    }
}

pub(crate) fn on_window_event<R: Runtime>(window: &tauri::Window<R>, event: &WindowEvent) {
    if matches!(event, WindowEvent::Focused(false))
        && STATE
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .session
            .is_some()
    {
        // A preserve-focus opening stays visible while the document is key. If
        // another app becomes foreground, dismiss after native activation settles.
        let app = window.app_handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(80));
            let target = app.clone();
            let _ = app.run_on_main_thread(move || {
                if !super::foreground_belongs_to_app() {
                    dismiss(&target);
                }
            });
        });
    }
    let host_blurred = window.label() == LABEL
        && matches!(event, WindowEvent::Focused(false))
        && window.is_visible().unwrap_or(false)
        && STATE
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .session
            .as_ref()
            .is_some_and(|session| session.revealed);
    if (window.label() == super::MAIN_WINDOW_LABEL
        && matches!(
            event,
            WindowEvent::CloseRequested { .. }
                | WindowEvent::Destroyed
                | WindowEvent::Moved(_)
                | WindowEvent::Resized(_)
        ))
        || (window.label() == LABEL
            && matches!(
                event,
                WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
            ))
        || host_blurred
        || (window.label() != LABEL
            && window.label() != super::MAIN_WINDOW_LABEL
            && matches!(event, WindowEvent::Focused(true)))
    {
        dismiss(window.app_handle());
    }
    if window.label() == LABEL && matches!(event, WindowEvent::Destroyed) {
        STATE.lock().unwrap_or_else(|e| e.into_inner()).host = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn snapshot() -> Snapshot {
        Snapshot {
            session_id: "session-1".into(),
            revision: 1,
            reports: vec![Report {
                heading: "Opened file".into(),
                rows: vec![Row {
                    code: "unknown".into(),
                    message: "warning".into(),
                    target: "Molecule".into(),
                    missing: false,
                    can_show: true,
                }],
            }],
        }
    }
    #[test]
    fn config_is_owned_only_on_windows_and_never_activates_on_show() {
        for windows in [false, true] {
            let config = window_config(windows);
            assert_eq!(config.parent.as_deref(), windows.then_some("main"));
            assert!(!config.focus);
            assert!(config.focusable); // Tab and Escape after keyboard open or an explicit click.
            assert!(config.skip_taskbar);
            assert!(!config.visible);
            assert!(!config.always_on_top);
        }
        assert_eq!(window_level(3), 4);
    }
    #[test]
    fn actions_require_live_session_revision_and_available_row() {
        let mut snapshot = snapshot();
        let action = |id: &str, revision, report_index, warning_index| Action::Show {
            session_id: id.into(),
            revision,
            report_index,
            warning_index,
        };
        assert!(accepts(&snapshot, &action("session-1", 1, 0, 0)));
        // Native outside-dismiss delivery can race a newer display revision.
        assert!(accepts(
            &snapshot,
            &Action::Close {
                session_id: "session-1".into(),
                revision: 0
            }
        ));
        for invalid in [
            action("old", 1, 0, 0),
            action("session-1", 2, 0, 0),
            action("session-1", 1, 2, 0),
            action("session-1", 1, 0, 8),
        ] {
            assert!(!accepts(&snapshot, &invalid));
        }
        snapshot.reports[0].rows[0].can_show = false;
        assert!(!accepts(&snapshot, &action("session-1", 1, 0, 0)));
    }
    #[test]
    fn snapshots_are_bounded_and_chunks_are_private_direct_deliveries() {
        let mut snapshot = snapshot();
        snapshot.reports[0].rows[0].message = "\"\\\n🧪".repeat(3000);
        validate(&snapshot).unwrap();
        let chunks = chunks(&snapshot).unwrap();
        assert!(chunks.len() > 1);
        let mut json = String::new();
        for chunk in chunks {
            assert!(serde_json::to_vec(&chunk).unwrap().len() < 4096);
            json.push_str(&chunk.json);
        }
        assert_eq!(json, serde_json::to_string(&snapshot).unwrap());
        snapshot.session_id = "bad/identity".into();
        assert!(validate(&snapshot).is_err());
        assert!(authorize("toolset-core-main", "main").is_err());
        assert!(authorize("main", LABEL).is_err());
    }
}
