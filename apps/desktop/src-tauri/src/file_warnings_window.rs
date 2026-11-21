//! Display-only transient above floating palettes. Document authority stays in `main`.
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{ipc::Channel, Manager, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent};

#[cfg(any(windows, test))]
use super::panel_window_frame::{Monitor, Placement};

const LABEL: &str = "file-warnings";
const MAX_BYTES: usize = 4 * 1024 * 1024;
const WIDTH: f64 = 520.0;
const HEIGHT: f64 = 360.0;

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
pub(crate) enum DocumentCommand {
    #[serde(rename = "edit.undo")]
    Undo,
    #[serde(rename = "edit.redo")]
    Redo,
    #[serde(rename = "edit.selectAll")]
    SelectAll,
}
impl DocumentCommand {
    fn forwarded_id(&self) -> &'static str {
        match self {
            Self::Undo => "edit.undo:forceDocumentHistory",
            Self::Redo => "edit.redo:forceDocumentHistory",
            Self::SelectAll => "edit.selectAll:forceDocumentHistory",
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Action {
    Unavailable {
        #[serde(rename = "sessionId")]
        session_id: String,
        revision: u32,
        message: String,
    },
    Command {
        #[serde(rename = "sessionId")]
        session_id: String,
        revision: u32,
        #[serde(rename = "commandId")]
        command_id: DocumentCommand,
    },
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

/// Other utilities are AppKit children and hide with their document. Warnings must keep their
/// higher floating level, so observe the owner instead of adding a child (which resets that level).
/// Like owner movement/close, minimization dismisses this transient and clears the owner's toggle.
#[cfg(target_os = "macos")]
pub(crate) fn observe_document<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    use objc2_app_kit::NSWindowWillMiniaturizeNotification;
    use objc2_foundation::{NSNotification, NSNotificationCenter};
    use std::ptr::NonNull;
    let main = super::main_ns_window(app).ok_or("Document window is unavailable")?;
    let app = app.clone();
    let callback = block2::RcBlock::new(move |_: NonNull<NSNotification>| dismiss(&app));
    // Process lifetime, matching the document's app-hide observer. Main is never recreated.
    std::mem::forget(unsafe {
        NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(NSWindowWillMiniaturizeNotification),
            Some(main),
            None,
            &callback,
        )
    });
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn observe_document<R: Runtime>(_app: &tauri::AppHandle<R>) -> Result<(), String> {
    // HWND ownership hides warnings with the owner; its resize event dismisses the session.
    Ok(())
}

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

fn window_config(
    has_document_parent: bool,
    native_wayland: bool,
) -> tauri::utils::config::WindowConfig {
    tauri::utils::config::WindowConfig {
        label: LABEL.into(),
        url: WebviewUrl::App("/?window=fileWarnings".into()),
        title: "File warnings — ChemDraft".into(),
        // An HWND owner on Windows and a transient on Linux. AppKit needs an independent
        // window to keep its separately configured floating + 1 level.
        parent: has_document_parent.then(|| super::MAIN_WINDOW_LABEL.into()),
        width: WIDTH,
        height: HEIGHT,
        focus: false,
        focusable: true,
        skip_taskbar: true,
        visible: false,
        decorations: false,
        resizable: native_wayland,
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
        super::utility_window::set_visible(window, true)?;
        super::raise_among_owned_windows(window)?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn place<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    _document: &tauri::WebviewWindow<R>,
    anchor: Anchor,
) -> Result<(), String> {
    let monitors =
        super::monitor_query::available_monitors(window.app_handle()).map_err(|e| e.to_string())?;
    let monitor = monitors
        .iter()
        .find(|monitor| {
            let (left, top, right, bottom) = super::monitor_logical_bounds(monitor);
            anchor.x >= left && anchor.x < right && anchor.y >= top && anchor.y < bottom
        })
        .or(monitors.first())
        .ok_or("No monitor is available for file warnings")?;
    let area = super::monitor_logical_work_area(monitor);
    let width = WIDTH.min(area.width);
    let height = HEIGHT.min(area.height);
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

#[cfg(any(windows, test))]
fn windows_placement(
    anchor: Anchor,
    document_scale: f64,
    monitors: &[Monitor],
    primary: &Monitor,
) -> Placement {
    // The webview sends its document's logical content origin plus the button offset.
    let physical_anchor = (anchor.x * document_scale, anchor.y * document_scale);
    let monitor =
        super::monitor_containing_physical_point(monitors, physical_anchor).unwrap_or(primary);
    let (left, top) = monitor.identity.position;
    let (left, top) = (f64::from(left), f64::from(top));
    let scale = monitor.scale;
    let area = monitor.work_area;
    let width = WIDTH.min(area.width);
    let height = HEIGHT.min(area.height);
    let x = ((physical_anchor.0 - left) / scale).clamp(area.x, area.x + (area.width - width));
    let y =
        ((physical_anchor.1 - top) / scale - height).clamp(area.y, area.y + (area.height - height));
    Placement {
        position: (
            (left + x * scale).round() as i32,
            (top + y * scale).round() as i32,
        ),
        size: (
            (width * scale).round() as u32,
            (height * scale).round() as u32,
        ),
        scale,
    }
}

#[cfg(windows)]
fn place<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    document: &tauri::WebviewWindow<R>,
    anchor: Anchor,
) -> Result<(), String> {
    let document_scale = document.scale_factor().map_err(|e| e.to_string())?;
    let app = window.app_handle();
    let monitors: Vec<_> = super::monitor_query::available_monitors(app)
        .map_err(|e| e.to_string())?
        .iter()
        .map(Monitor::from_native)
        .collect();
    let primary = super::monitor_query::primary_monitor(app)
        .ok()
        .flatten()
        .as_ref()
        .map(Monitor::from_native);
    let primary = primary
        .as_ref()
        .or_else(|| monitors.first())
        .ok_or("No monitor is available for file warnings")?;
    let placement = windows_placement(anchor, document_scale, &monitors, primary);
    let target = window.clone();
    super::run_on_main_thread_blocking(window, move || {
        let webview: &tauri::Webview<R> = target.as_ref();
        super::panel_full_size::apply(&webview.window(), placement, "file warnings placement")
    })?
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
            let native_wayland = super::utility_window::uses_native_wayland(app)?;
            let config = window_config(cfg!(any(windows, target_os = "linux")), native_wayland);
            let target = WebviewWindowBuilder::from_config(app, &config)
                .map_err(|e| e.to_string())?
                .build()
                .map_err(|e| e.to_string())?;
            super::disable_default_context_menus(&target);
            super::utility_window::prepare(
                &target,
                super::utility_window::Kind::FileWarnings,
                native_wayland,
            )?;
            configure(&target, false)?;
            target
        }
    };
    super::utility_window::set_visible(&target, false)?;
    place(&target, &window, anchor)?;
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
        }
        | Action::Command {
            session_id,
            revision,
            ..
        }
        | Action::Unavailable {
            session_id,
            revision,
            ..
        } => (session_id, revision),
    };
    session_id == &snapshot.session_id
        && match action {
            Action::Close { .. } => true,
            Action::Command { .. } | Action::Unavailable { .. } => *revision == snapshot.revision,
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
        if matches!(action, Action::Show { .. } | Action::Unavailable { .. }) {
            return session.owner.send(action).map_err(|e| e.to_string());
        }
    }
    if let Action::Command { command_id, .. } = action {
        let app = window.app_handle();
        if !super::utility_windows_suspended() {
            super::emit_command_to_main(app, command_id.forwarded_id())?;
            super::focus_main_document_window_impl(app, super::MainWindowFocusMode::Force)?;
        }
        return Ok(());
    }
    dismiss(window.app_handle());
    Ok(())
}

fn dismiss_session(state: &Mutex<State>) -> bool {
    let session = state
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .session
        .take();
    if let Some(session) = session {
        let _ = session.owner.send(Action::Close {
            session_id: session.snapshot.session_id,
            revision: session.snapshot.revision,
        });
        true
    } else {
        false
    }
}

pub(crate) fn dismiss<R: Runtime>(app: &tauri::AppHandle<R>) {
    if dismiss_session(&STATE) {
        if let Some(window) = app.get_webview_window(LABEL) {
            let _ = super::utility_window::set_visible(&window, false);
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
    fn owner_minimize_dismisses_once_and_restore_cannot_resurrect_a_transient() {
        let deliveries = std::sync::Arc::new(Mutex::new(Vec::new()));
        let received = deliveries.clone();
        let state = Mutex::new(State {
            session: Some(Session {
                snapshot: snapshot(),
                owner: Channel::new(move |message| {
                    received.lock().unwrap().push(format!("{message:?}"));
                    Ok(())
                }),
                focus: false,
                revealed: true,
            }),
            host: None,
        });
        assert!(dismiss_session(&state)); // WillMiniaturize hides and clears the document toggle.
        assert!(state.lock().unwrap().session.is_none());
        assert!(!dismiss_session(&state)); // Subsequent blur/resize/restore events are harmless.
        let messages = deliveries.lock().unwrap();
        assert_eq!(messages.len(), 1);
        assert!(messages[0].contains("close"));
        assert!(messages[0].contains("session-1"));

        let source = include_str!("file_warnings_window.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        assert!(source.contains("Some(NSWindowWillMiniaturizeNotification)"));
        assert!(source.contains("Some(main),"));
        assert!(include_str!("lib.rs").contains("file_warnings_window::observe_document(app)?"));
    }
    #[test]
    fn document_shortcuts_are_narrow_and_require_the_current_session_and_revision() {
        for (command_id, forwarded) in [
            ("edit.undo", "edit.undo:forceDocumentHistory"),
            ("edit.redo", "edit.redo:forceDocumentHistory"),
            ("edit.selectAll", "edit.selectAll:forceDocumentHistory"),
        ] {
            let command: DocumentCommand =
                serde_json::from_value(serde_json::json!(command_id)).unwrap();
            assert_eq!(command.forwarded_id(), forwarded);
            let action = |session_id: &str, revision| Action::Command {
                session_id: session_id.into(),
                revision,
                command_id: command.clone(),
            };
            assert!(accepts(&snapshot(), &action("session-1", 1)));
            assert!(!accepts(&snapshot(), &action("old", 1)));
            assert!(!accepts(&snapshot(), &action("session-1", 2)));
        }
        assert!(
            serde_json::from_value::<DocumentCommand>(serde_json::json!("document.save")).is_err()
        );
    }
    #[test]
    fn config_preserves_document_parent_and_avoids_activation_on_show() {
        for (has_document_parent, native_wayland) in [(false, false), (true, false), (true, true)] {
            let config = window_config(has_document_parent, native_wayland);
            assert_eq!(
                config.parent.as_deref(),
                has_document_parent.then_some("main")
            );
            assert!(!config.focus);
            assert!(config.focusable); // Tab and Escape after keyboard open or an explicit click.
            assert_eq!(config.resizable, native_wayland);
            assert!(config.skip_taskbar);
            assert!(!config.visible);
            assert!(!config.always_on_top);
        }
        assert_eq!(window_level(3), 4);
    }

    #[test]
    fn windows_warnings_use_the_physical_anchor_and_destination_scale() {
        use super::super::{panel_window_frame::MonitorIdentity, ScreenRect};

        let monitors = [
            Monitor {
                identity: MonitorIdentity {
                    name: None,
                    position: (0, 0),
                    size: (1920, 1080),
                },
                scale: 1.0,
                work_area: ScreenRect::new(0.0, 0.0, 1920.0, 1040.0),
            },
            Monitor {
                identity: MonitorIdentity {
                    name: None,
                    position: (1920, 0),
                    size: (2560, 1600),
                },
                scale: 2.0,
                work_area: ScreenRect::new(0.0, 20.0, 1280.0, 740.0),
            },
        ];
        let place =
            |x, y, scale| windows_placement(Anchor { x, y }, scale, &monitors, &monitors[0]);

        // The logical point overlaps the primary display, but its pixels are on the secondary.
        assert_eq!(
            place(1200.0, 650.0, 2.0),
            Placement {
                position: (2400, 580),
                size: (1040, 720),
                scale: 2.0,
            },
        );
        // A document at 100% can extend onto the 200% display. Use the button's monitor.
        assert_eq!(
            place(1920.0, 400.0, 1.0),
            Placement {
                position: (1920, 40),
                size: (1040, 720),
                scale: 2.0,
            },
        );
        assert_eq!(
            place(-50.0, -10.0, 2.0),
            Placement {
                position: (0, 0),
                size: (520, 360),
                scale: 1.0,
            },
        );
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
