//! Document-owned, modeless native dialog host. Webviews receive drafts, never document authority.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, Manager, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const MAX_BYTES: usize = 16 * 1024;
// Tauri 2.11.2 queues JSON >= 8192 bytes app-wide, outside receiver authentication.
// Measure the complete delivery after JSON escaping, well below that threshold.
const MAX_CHANNEL_BYTES: usize = 4096;
const OVERSIZED_ERROR: &str = "Dialog operation failed; error details exceeded the delivery limit.";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Message {
    protocol_version: u32,
    owner_window_id: String,
    document_tab_id: String,
    dialog_kind: String,
    session_id: String,
    request_id: String,
    snapshot_revision: u64,
    #[serde(rename = "type")]
    message_type: String,
    data: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    title: String,
    width: f64,
    height: f64,
    unit: String,
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
enum Action {
    Apply {
        width: f64,
        height: f64,
        unit: String,
    },
    Cancel,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    status: String,
    error: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Closed {
    reason: String,
}

fn token(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
fn valid_size(width: f64, height: f64, unit: &str) -> bool {
    width.is_finite()
        && height.is_finite()
        && width > 0.0
        && height > 0.0
        && width <= 100000.0
        && height <= 100000.0
        && matches!(unit, "inch" | "mm" | "css-px")
}
fn valid_reason(reason: &str) -> bool {
    matches!(
        reason,
        "apply"
            | "cancel"
            | "close"
            | "destroy"
            | "ownerTabClose"
            | "ownerClose"
            | "quit"
            | "error"
    )
}
impl Message {
    fn validate(&self) -> Result<(), String> {
        if serde_json::to_vec(self).map_err(|e| e.to_string())?.len() > MAX_BYTES
            || self.protocol_version != 1
            || self.owner_window_id != super::MAIN_WINDOW_LABEL
            || self.dialog_kind != "pageSize"
            || !token(&self.document_tab_id)
            || !token(&self.session_id)
            || !token(&self.request_id)
            || self.snapshot_revision == 0
            || self.snapshot_revision > 9_007_199_254_740_991
        {
            return Err("Invalid dialog envelope or payload limit exceeded".into());
        }
        let valid = match self.message_type.as_str() {
            "snapshot" => serde_json::from_value::<Snapshot>(self.data.clone()).is_ok_and(|s| {
                !s.title.is_empty()
                    && s.title.encode_utf16().count() <= 256
                    && valid_size(s.width, s.height, &s.unit)
            }),
            "action" => {
                serde_json::from_value::<Action>(self.data.clone()).is_ok_and(|a| match a {
                    Action::Cancel => true,
                    Action::Apply {
                        width,
                        height,
                        unit,
                    } => valid_size(width, height, &unit),
                })
            }
            "request" | "ready" => self.data.as_object().is_some_and(|d| d.is_empty()),
            "result" => serde_json::from_value::<Receipt>(self.data.clone()).is_ok_and(|r| {
                matches!(r.status.as_str(), "applied" | "cancelled" | "error")
                    && self.data.get("error").is_none_or(|e| e.is_string())
                    && r.error.is_none_or(|e| e.encode_utf16().count() <= 2048)
            }),
            "closed" => serde_json::from_value::<Closed>(self.data.clone())
                .is_ok_and(|c| valid_reason(&c.reason)),
            _ => false,
        };
        if valid {
            Ok(())
        } else {
            Err("Invalid dialog kind payload".into())
        }
    }
    fn same_session(&self, other: &Self) -> bool {
        self.owner_window_id == other.owner_window_id
            && self.document_tab_id == other.document_tab_id
            && self.dialog_kind == other.dialog_kind
            && self.session_id == other.session_id
            && self.snapshot_revision == other.snapshot_revision
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Registration {
    host_id: String,
    window_label: String,
}
struct Session {
    registration: Registration,
    snapshot: Message,
    ready: bool,
    owner_channel: Option<Channel<Value>>,
    host_channel: Option<Channel<Value>>,
    terminal_request: Option<String>,
    // Request IDs are scoped to a session and bounded; a sender cannot grow this without limit.
    actions: HashMap<String, Message>,
    receipts: HashMap<String, Message>,
    transient_until: Instant,
    pending_move: Option<(Instant, SavedPosition)>,
}
#[derive(Default)]
struct Registry {
    sessions: HashMap<String, Session>,
    next_slot: u64,
}
static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(|| Mutex::new(Registry::default()));

pub(crate) fn is_dialog_label(label: &str) -> bool {
    label
        .strip_prefix("dialog-main-pageSize-")
        .is_some_and(|slot| {
            !slot.is_empty() && slot.len() <= 20 && slot.bytes().all(|c| c.is_ascii_digit())
        })
}
fn authorize(
    session: &Session,
    sender: &str,
    owner: bool,
    message: Option<&Message>,
) -> Result<(), String> {
    let expected = if owner {
        &session.snapshot.owner_window_id
    } else {
        &session.registration.window_label
    };
    if sender != expected || message.is_some_and(|m| !m.same_session(&session.snapshot)) {
        return Err(
            "Dialog caller, session, or revision does not match its registered native window"
                .into(),
        );
    }
    Ok(())
}
fn delivery(session: &Session, sender: &str, message: &Message) -> Result<Value, String> {
    let mut payload = json!({ "senderWindowId": sender, "windowLabel": session.registration.window_label, "message": message });
    let serialized_size = |value: &Value| {
        serde_json::to_vec(value)
            .map(|bytes| bytes.len())
            .map_err(|e| e.to_string())
    };
    if serialized_size(&payload)? > MAX_CHANNEL_BYTES
        && message.message_type == "result"
        && message.data.get("error").is_some_and(Value::is_string)
    {
        payload["message"]["data"]["error"] = json!(OVERSIZED_ERROR);
    }
    // Recheck after replacement: an oversized envelope or a future kind must fail closed.
    if serialized_size(&payload)? > MAX_CHANNEL_BYTES {
        return Err("Dialog channel delivery limit exceeded".into());
    }
    Ok(payload)
}
fn send_owner(session: &Session, sender: &str, message: &Message) -> Result<(), String> {
    session
        .owner_channel
        .as_ref()
        .ok_or("Dialog owner channel missing")?
        .send(delivery(session, sender, message)?)
        .map_err(|e| e.to_string())
}
fn send_host(session: &Session, message: &Message) -> Result<(), String> {
    session
        .host_channel
        .as_ref()
        .ok_or("Dialog host channel missing")?
        .send(delivery(session, super::MAIN_WINDOW_LABEL, message)?)
        .map_err(|e| e.to_string())
}
/// Reserve before forwarding: request-ID dedup alone cannot prevent two distinct Apply requests.
fn reserve_action(session: &mut Session, message: &Message) -> Result<bool, String> {
    if let Some(previous) = session.actions.get(&message.request_id) {
        if previous.data != message.data {
            return Err("A dialog request ID cannot be reused for another action".into());
        }
        return Ok(false);
    }
    if session.terminal_request.is_some() {
        return Err("A terminal dialog action is already pending".into());
    }
    if session.actions.len() >= 128 {
        return Err("Dialog action limit exceeded".into());
    }
    session.terminal_request = Some(message.request_id.clone());
    session
        .actions
        .insert(message.request_id.clone(), message.clone());
    Ok(true)
}
fn register(
    registry: &mut Registry,
    message: Message,
    quitting: bool,
) -> Result<(Registration, bool), String> {
    if quitting {
        return Err(super::QUITTING_WINDOW_REFUSAL.into());
    }
    message.validate()?;
    if message.message_type != "snapshot" {
        return Err("A dialog opens with a snapshot".into());
    }
    if let Some(session) = registry
        .sessions
        .values()
        .find(|s| s.snapshot.same_session(&message))
    {
        return Ok((session.registration.clone(), false));
    }
    if registry.sessions.len() >= 16 {
        return Err("Too many dialog windows are open".into());
    }
    if registry.sessions.values().any(|s| {
        s.snapshot.document_tab_id == message.document_tab_id
            && s.snapshot.dialog_kind == message.dialog_kind
    }) {
        return Err("A dialog for this drawing is already open".into());
    }
    registry.next_slot += 1;
    let registration = Registration {
        host_id: format!("h{:016x}", registry.next_slot),
        window_label: format!("dialog-main-{}-{}", message.dialog_kind, registry.next_slot),
    };
    registry.sessions.insert(
        registration.host_id.clone(),
        Session {
            registration: registration.clone(),
            snapshot: message,
            ready: false,
            owner_channel: None,
            host_channel: None,
            terminal_request: None,
            actions: HashMap::new(),
            receipts: HashMap::new(),
            transient_until: Instant::now() + Duration::from_millis(500),
            pending_move: None,
        },
    );
    Ok((registration, true))
}

/// Async, serialized, worker construction. Never take WINDOW_CREATION on the event thread.
#[tauri::command]
pub(crate) async fn dialog_open(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    message: Message,
    channel: Channel<Value>,
) -> Result<Registration, String> {
    if window.label() != super::MAIN_WINDOW_LABEL
        || app.get_webview_window(super::MAIN_WINDOW_LABEL).is_none()
    {
        return Err("Unknown dialog owner".into());
    }
    let _creation = super::lock_window_creation()?;
    if !window.is_visible().unwrap_or(false) {
        return Err("The document window is hidden; no dialog can open".into());
    }
    let (registration, build) = register(
        &mut REGISTRY.lock().unwrap_or_else(|p| p.into_inner()),
        message.clone(),
        super::quit_in_progress(),
    )?;
    let ready = {
        let mut registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
        let session = registry
            .sessions
            .get_mut(&registration.host_id)
            .ok_or("Unknown dialog host")?;
        session.owner_channel = Some(channel);
        session.ready && session.terminal_request.is_none()
    };
    if !build {
        if ready {
            if let Some(target) = app.get_webview_window(&registration.window_label) {
                super::run_on_main_thread_blocking(&window, move || show_on_main(&target))
                    .and_then(|result| result)?;
            }
        }
        return Ok(registration);
    }
    let snapshot: Snapshot = serde_json::from_value(message.data).map_err(|e| e.to_string())?;
    let builder = WebviewWindowBuilder::new(
        &app,
        &registration.window_label,
        WebviewUrl::App(format!("/?window=dialog&hostId={}", registration.host_id).into()),
    )
    .title(format!("Custom Page Size — {}", snapshot.title))
    .inner_size(420.0, 300.0)
    .min_inner_size(360.0, 260.0)
    .visible(false)
    .focused(false)
    .focusable(true)
    .skip_taskbar(true)
    .shadow(true)
    .decorations(true)
    .resizable(true)
    .minimizable(false);
    // On Windows .parent is a top-level OWNER, never a child control. AppKit attaches at reveal.
    #[cfg(windows)]
    let builder = builder.parent(&window).map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    let builder = builder;
    if let Err(error) = builder.build() {
        REGISTRY
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .sessions
            .remove(&registration.host_id);
        return Err(format!(
            "Could not create native Custom Page Size window: {error}"
        ));
    }
    // Owner close/quit does not wait on the construction lock. Discard a late build whose
    // registered session was already settled, rather than leaving an orphan hidden webview.
    if !REGISTRY
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .sessions
        .contains_key(&registration.host_id)
    {
        if let Some(window) = app.get_webview_window(&registration.window_label) {
            let _ = window.destroy();
        }
        return Err("Dialog owner closed during window creation".into());
    }
    if super::quit_in_progress() {
        close_session(&app, &registration.host_id, "quit");
        return Err(super::QUITTING_WINDOW_REFUSAL.into());
    }
    Ok(registration)
}

#[tauri::command]
pub(crate) fn dialog_request(
    window: tauri::WebviewWindow,
    host_id: String,
    protocol_version: u32,
    request_id: String,
    channel: Channel<Value>,
) -> Result<(), String> {
    if protocol_version != 1 || !token(&request_id) || !token(&host_id) {
        return Err("Invalid dialog bootstrap request".into());
    }
    let mut registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
    let session = registry
        .sessions
        .get_mut(&host_id)
        .ok_or("Unknown dialog host")?;
    authorize(session, window.label(), false, None)?;
    session.snapshot.validate()?;
    // This channel belongs to the actual calling dialog, not to a payload label.
    session.host_channel = Some(channel);
    send_host(session, &session.snapshot)?;
    let mut request = session.snapshot.clone();
    request.message_type = "request".into();
    request.request_id = request_id;
    request.data = json!({});
    send_owner(session, window.label(), &request)
}

#[tauri::command]
pub(crate) async fn dialog_send(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    host_id: String,
    message: Message,
) -> Result<(), String> {
    message.validate()?;
    if !matches!(message.message_type.as_str(), "ready" | "action") {
        return Err("Dialog can send only ready or a typed action".into());
    }
    let _creation = super::lock_window_creation()?;
    let reveal = {
        let mut registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
        let session = registry
            .sessions
            .get_mut(&host_id)
            .ok_or("Unknown dialog host")?;
        authorize(session, window.label(), false, Some(&message))?;
        let reveal = message.message_type == "ready" && !session.ready;
        if message.message_type == "action" {
            if !session.ready {
                return Err("Dialog is not ready".into());
            }
            if let Some(receipt) = session.receipts.get(&message.request_id) {
                return send_host(session, receipt);
            }
            if !reserve_action(session, &message)? {
                return Ok(());
            }
        }
        if reveal {
            session.ready = true;
        }
        // Only this Rust-validated path can write the owner's private channel.
        send_owner(session, window.label(), &message)?;
        reveal
    };
    // Deliver ready before showing so the owner's listener is authoritative even on a fast click.
    if reveal {
        let target = window.clone();
        if let Err(error) =
            super::run_on_main_thread_blocking(&window, move || reveal_on_main(&target))
                .and_then(|result| result)
        {
            eprintln!("Could not reveal native Custom Page Size: {error}");
            close_session(&app, &host_id, "error");
            return Err(error);
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn dialog_publish(
    window: tauri::WebviewWindow,
    host_id: String,
    message: Message,
) -> Result<(), String> {
    message.validate()?;
    if !matches!(message.message_type.as_str(), "snapshot" | "result") {
        return Err("Owner can publish only snapshot or result".into());
    }
    let mut registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
    let session = registry
        .sessions
        .get_mut(&host_id)
        .ok_or("Unknown dialog host")?;
    authorize(session, window.label(), true, Some(&message))?;
    if message.message_type == "result" {
        if !session.actions.contains_key(&message.request_id) {
            return Err("Unknown dialog action receipt".into());
        }
        if let Some(previous) = session.receipts.get(&message.request_id) {
            return send_host(session, previous);
        }
        if message.data["status"] == "error"
            && session.terminal_request.as_ref() == Some(&message.request_id)
        {
            session.terminal_request = None;
        }
        session
            .receipts
            .insert(message.request_id.clone(), message.clone());
    } else {
        session.snapshot = message.clone();
    }
    send_host(session, &message)
}

#[tauri::command]
pub(crate) async fn dialog_close(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    host_id: String,
    reason: String,
) -> Result<(), String> {
    if !valid_reason(&reason) {
        return Err("Invalid dialog close reason".into());
    }
    {
        let registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(session) = registry.sessions.get(&host_id) {
            authorize(session, window.label(), true, None)?;
        } else if window.label() != super::MAIN_WINDOW_LABEL {
            return Err("Unknown dialog owner".into());
        }
    }
    close_session(&app, &host_id, &reason);
    Ok(())
}
fn notify_closed(session: &Session, reason: &str) {
    super::UTILITY_SUSPENSION
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .closed(&session.registration.window_label);
    let mut closed = session.snapshot.clone();
    closed.message_type = "closed".into();
    closed.data = json!({"reason": reason});
    let _ = send_owner(session, super::MAIN_WINDOW_LABEL, &closed);
}
fn close_session<R: Runtime>(app: &tauri::AppHandle<R>, host_id: &str, reason: &str) {
    let session = REGISTRY
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .sessions
        .remove(host_id);
    if let Some(mut session) = session {
        flush_position(app, &mut session);
        notify_closed(&session, reason);
        if let Some(window) = app.get_webview_window(&session.registration.window_label) {
            let _ = window.destroy();
        }
    }
}
pub(crate) fn dismiss_owned<R: Runtime>(app: &tauri::AppHandle<R>, reason: &str) {
    let sessions = std::mem::take(&mut REGISTRY.lock().unwrap_or_else(|p| p.into_inner()).sessions);
    for mut session in sessions.into_values() {
        flush_position(app, &mut session);
        notify_closed(&session, reason);
        if let Some(window) = app.get_webview_window(&session.registration.window_label) {
            let _ = window.destroy();
        }
    }
}

fn reveal_on_main<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    if super::quit_in_progress() {
        return Err(super::QUITTING_WINDOW_REFUSAL.into());
    }
    place_window(window)?;
    show_on_main(window)
}
/// Reopening focuses without replacing the draft, resizing, or moving a user-positioned dialog.
fn show_on_main<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    if super::quit_in_progress() {
        return Err(super::QUITTING_WINDOW_REFUSAL.into());
    }
    if super::utility_windows_suspended() {
        super::UTILITY_SUSPENSION
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .defer_show(window.label().into());
        return Ok(());
    }
    if window
        .app_handle()
        .get_webview_window(super::MAIN_WINDOW_LABEL)
        .is_none_or(|owner| !owner.is_visible().unwrap_or(false))
    {
        return Err("Dialog owner is hidden".into());
    }
    window.unminimize().map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    configure_on_main(window)?;
    window.set_focus().map_err(|e| e.to_string())
}
/// Called by reveal and by the existing relative-order utility restore (already on main).
pub(crate) fn configure_on_main<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSNormalWindowLevel, NSWindow};
        let ptr = window.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
        let native = unsafe { ptr.as_ref() }.ok_or("Could not access native dialog window")?;
        native.setLevel(NSNormalWindowLevel);
        native.setHidesOnDeactivate(false);
        native.setCanHide(true);
        native.setIgnoresMouseEvents(false);
        super::attach_webview_window_to_main(window);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedPosition {
    monitor: String,
    x: f64,
    y: f64,
    offset_x: f64,
    offset_y: f64,
}
#[derive(Clone, Debug)]
struct WorkArea {
    id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
}
impl WorkArea {
    fn from_monitor(m: &tauri::Monitor) -> Self {
        let area = m.work_area();
        let scale = m.scale_factor();
        Self {
            id: m
                .name()
                .cloned()
                .unwrap_or_else(|| format!("{},{}", m.position().x, m.position().y)),
            x: f64::from(area.position.x) / scale,
            y: f64::from(area.position.y) / scale,
            width: f64::from(area.size.width) / scale,
            height: f64::from(area.size.height) / scale,
            scale,
        }
    }
    fn clamp(&self, x: f64, y: f64, width: f64, height: f64) -> (f64, f64) {
        // Keep the entire title bar reachable; also keep the whole dialog in the work area if it fits.
        (
            x.clamp(self.x, self.x + (self.width - width).max(0.0)),
            y.clamp(
                self.y,
                self.y + (self.height - height.min(self.height)).max(0.0),
            ),
        )
    }
}
fn position_for(
    saved: Option<&SavedPosition>,
    monitors: &[WorkArea],
    owner: &WorkArea,
    owner_rect: (f64, f64, f64, f64),
    size: (f64, f64),
) -> (f64, f64, f64) {
    if let Some(saved) = saved {
        if let Some(m) = monitors.iter().find(|m| m.id == saved.monitor) {
            let (x, y) = m.clamp(
                m.x + saved.offset_x * (m.width - size.0).max(0.0),
                m.y + saved.offset_y * (m.height - size.1).max(0.0),
                size.0,
                size.1,
            );
            return (x * m.scale, y * m.scale, m.scale);
        }
    }
    let (x, y, width, height) = owner_rect;
    let (x, y) = owner.clamp(
        x + (width - size.0) / 2.0,
        y + (height - size.1) / 2.0,
        size.0,
        size.1,
    );
    (x * owner.scale, y * owner.scale, owner.scale)
}
fn saved_path<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<std::path::PathBuf, String> {
    let folder = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(folder.join("dialog-positions.json"))
}
fn read_positions<R: Runtime>(app: &tauri::AppHandle<R>) -> HashMap<String, SavedPosition> {
    saved_path(app)
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .filter(|bytes| bytes.len() <= MAX_BYTES)
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}
fn place_window<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    let app = window.app_handle();
    let owner = app
        .get_webview_window(super::MAIN_WINDOW_LABEL)
        .ok_or("Unknown dialog owner")?;
    let monitor = owner
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("Document monitor unavailable")?;
    let work = WorkArea::from_monitor(&monitor);
    let monitors: Vec<_> = owner
        .available_monitors()
        .map_err(|e| e.to_string())?
        .iter()
        .map(WorkArea::from_monitor)
        .collect();
    let position = owner.inner_position().map_err(|e| e.to_string())?;
    let owner_size = owner.inner_size().map_err(|e| e.to_string())?;
    let frame = window.outer_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size = (
        f64::from(frame.width) / scale,
        f64::from(frame.height) / scale,
    );
    let positions = read_positions(app);
    let saved = positions.get("pageSize").filter(|p| {
        [p.x, p.y, p.offset_x, p.offset_y]
            .iter()
            .all(|v| v.is_finite())
    });
    let (x, y, destination_scale) = position_for(
        saved,
        &monitors,
        &work,
        (
            f64::from(position.x) / work.scale,
            f64::from(position.y) / work.scale,
            f64::from(owner_size.width) / work.scale,
            f64::from(owner_size.height) / work.scale,
        ),
        size,
    );
    let destination = saved
        .and_then(|s| monitors.iter().find(|m| m.id == s.monitor))
        .unwrap_or(&work);
    // WM_DPICHANGED runs when moving between Windows monitors. Move first, set the desired
    // client size at the destination DPI, then clamp using the measured final outer frame.
    finish_placement(
        (x, y, destination_scale),
        destination,
        |x, y| {
            window
                .set_position(tauri::PhysicalPosition::new(x as i32, y as i32))
                .map_err(|e| e.to_string())
        },
        |width, height| {
            window
                .set_size(tauri::PhysicalSize::new(width, height))
                .map_err(|e| e.to_string())
        },
        || {
            window
                .outer_size()
                .map(|s| (s.width, s.height))
                .map_err(|e| e.to_string())
        },
    )?;
    mark_transient(window.label());
    Ok(())
}
fn finish_placement(
    (x, y, scale): (f64, f64, f64),
    work: &WorkArea,
    mut move_to: impl FnMut(f64, f64) -> Result<(), String>,
    mut resize: impl FnMut(u32, u32) -> Result<(), String>,
    mut measure: impl FnMut() -> Result<(u32, u32), String>,
) -> Result<(), String> {
    move_to(x, y)?;
    resize((420.0 * scale) as u32, (300.0 * scale) as u32)?;
    let (width, height) = measure()?;
    let (x, y) = work.clamp(
        x / scale,
        y / scale,
        f64::from(width) / scale,
        f64::from(height) / scale,
    );
    move_to(x * scale, y * scale)
}
pub(crate) fn mark_transient(label: &str) {
    if let Some(session) = REGISTRY
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .sessions
        .values_mut()
        .find(|s| s.registration.window_label == label)
    {
        session.transient_until = Instant::now() + Duration::from_millis(500);
    }
}
fn should_persist(
    visible: bool,
    minimized: bool,
    quitting: bool,
    suspended: bool,
    ready: bool,
    transient: bool,
) -> bool {
    visible && !minimized && !quitting && !suspended && ready && !transient
}
fn persist_move<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let app = window.app_handle();
    let mut registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
    let Some(session) = registry
        .sessions
        .values_mut()
        .find(|s| s.registration.window_label == window.label())
    else {
        return;
    };
    if !should_persist(
        window.is_visible().unwrap_or(false),
        window.is_minimized().unwrap_or(true)
            || app
                .get_webview_window(super::MAIN_WINDOW_LABEL)
                .is_none_or(|owner| {
                    owner.is_minimized().unwrap_or(true) || !owner.is_visible().unwrap_or(false)
                }),
        super::quit_in_progress(),
        super::utility_windows_suspended(),
        session.ready,
        Instant::now() < session.transient_until,
    ) {
        return;
    }
    let Ok(position) = window.outer_position() else {
        return;
    };
    if !super::UTILITY_SUSPENSION
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .persist_move(window.label(), (position.x, position.y))
    {
        return;
    }
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let m = WorkArea::from_monitor(&monitor);
    let Ok(size) = window.outer_size() else {
        return;
    };
    let x = f64::from(position.x) / m.scale;
    let y = f64::from(position.y) / m.scale;
    let saved = SavedPosition {
        monitor: m.id,
        x,
        y,
        offset_x: ((x - m.x) / (m.width - f64::from(size.width) / m.scale).max(1.0))
            .clamp(0.0, 1.0),
        offset_y: ((y - m.y) / (m.height - f64::from(size.height) / m.scale).max(1.0))
            .clamp(0.0, 1.0),
    };
    session.pending_move = Some((Instant::now(), saved));
    drop(registry);
    let path = match saved_path(app) {
        Ok(path) => path,
        Err(_) => return,
    };
    // One process-wide worker, with at most one pending notification. No thread per Moved event.
    let _ = POSITION_WORKER.try_send(path);
}

type PositionWrites = Vec<(String, SavedPosition)>;
fn take_pending_positions(registry: &mut Registry) -> PositionWrites {
    let mut moves: Vec<_> = registry
        .sessions
        .values_mut()
        .filter_map(|s| {
            s.pending_move
                .take()
                .map(|(at, saved)| (at, s.snapshot.dialog_kind.clone(), saved))
        })
        .collect();
    // Several tabs can have the same kind open. Persist the most recent genuine move for that
    // kind, rather than letting HashMap iteration choose which position survives the burst.
    moves.sort_by_key(|(at, _, _)| *at);
    moves
        .into_iter()
        .map(|(_, kind, saved)| (kind, saved))
        .collect()
}
fn flush_pending_positions(registry: &Mutex<Registry>, write: impl FnOnce(PositionWrites)) {
    let writes = take_pending_positions(&mut registry.lock().unwrap_or_else(|p| p.into_inner()));
    write(writes);
}
static POSITION_IO: Mutex<()> = Mutex::new(());
static POSITION_WORKER: LazyLock<std::sync::mpsc::SyncSender<std::path::PathBuf>> =
    LazyLock::new(|| {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            debounce_positions(receiver, Duration::from_millis(200), |path| {
                // Serialize final close flushes with worker writes. Take the snapshot under REGISTRY,
                // then release REGISTRY before any file reads or writes.
                let _io = POSITION_IO.lock().unwrap_or_else(|p| p.into_inner());
                flush_pending_positions(&REGISTRY, |writes| write_positions(&path, writes));
            });
        });
        sender
    });
fn debounce_positions(
    receiver: std::sync::mpsc::Receiver<std::path::PathBuf>,
    delay: Duration,
    mut flush: impl FnMut(std::path::PathBuf),
) {
    while let Ok(mut path) = receiver.recv() {
        loop {
            match receiver.recv_timeout(delay) {
                Ok(next) => path = next,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    flush(path);
                    return;
                }
            }
        }
        flush(path);
    }
}
fn write_positions(path: &std::path::Path, writes: PositionWrites) {
    if writes.is_empty() {
        return;
    }
    if path
        .parent()
        .is_some_and(|parent| std::fs::create_dir_all(parent).is_err())
    {
        return;
    }
    let mut positions: HashMap<String, SavedPosition> = std::fs::read(path)
        .ok()
        .filter(|b| b.len() <= MAX_BYTES)
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    positions.extend(writes);
    if let Ok(bytes) = serde_json::to_vec(&positions) {
        let _ = std::fs::write(path, bytes);
    }
}
fn flush_position<R: Runtime>(app: &tauri::AppHandle<R>, session: &mut Session) {
    if let Some((_, saved)) = session.pending_move.take() {
        let _io = POSITION_IO.lock().unwrap_or_else(|p| p.into_inner());
        if let Ok(path) = saved_path(app) {
            write_positions(&path, vec![(session.snapshot.dialog_kind.clone(), saved)]);
        }
    }
}

/// Native close/destroy settles even if the renderer crashes or never executes cleanup.
pub(crate) fn on_window_event<R: Runtime>(window: &tauri::Window<R>, event: &WindowEvent) {
    if !is_dialog_label(window.label()) {
        return;
    }
    match event {
        WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed => {
            let mut registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
            let key = registry
                .sessions
                .iter()
                .find(|(_, s)| s.registration.window_label == window.label())
                .map(|(k, _)| k.clone());
            let session = key.and_then(|k| registry.sessions.remove(&k));
            drop(registry);
            if let Some(mut session) = session {
                flush_position(window.app_handle(), &mut session);
                notify_closed(
                    &session,
                    if matches!(event, WindowEvent::Destroyed) {
                        "destroy"
                    } else {
                        "close"
                    },
                );
            }
        }
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            if let Some(webview) = window.app_handle().get_webview_window(window.label()) {
                persist_move(&webview);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_channel_message_stays_receiver_private_at_worst_case() {
        let mut maximum = snapshot();
        maximum.document_tab_id = "t".repeat(128);
        maximum.session_id = "s".repeat(128);
        maximum.request_id = "r".repeat(128);
        maximum.snapshot_revision = 9_007_199_254_740_991;
        let mut registry = Registry {
            next_slot: u64::MAX - 1,
            ..Registry::default()
        };
        let (registration, _) = register(&mut registry, maximum.clone(), false).unwrap();
        let session = registry.sessions.get_mut(&registration.host_id).unwrap();
        let deliveries = std::sync::Arc::new(Mutex::new(Vec::new()));
        let capture = || {
            let deliveries = deliveries.clone();
            Channel::new(move |body| {
                let tauri::ipc::InvokeResponseBody::Json(bytes) = body else {
                    panic!("dialog deliveries must be JSON");
                };
                assert!(bytes.len() <= MAX_CHANNEL_BYTES);
                assert!(
                    bytes.len() < 8192,
                    "must never enter the app-wide fetch queue"
                );
                deliveries.lock().unwrap().push(bytes);
                Ok(())
            })
        };
        session.owner_channel = Some(capture());
        session.host_channel = Some(capture());
        for (kind, data) in [
            (
                "snapshot",
                json!({"title":"\u{0001}".repeat(256),"width":f64::MIN_POSITIVE,"height":9.999999999999999e-100,"unit":"css-px"}),
            ),
            ("request", json!({})),
            ("ready", json!({})),
            (
                "action",
                json!({"action":"apply","width":f64::MIN_POSITIVE,"height":9.999999999999999e-100,"unit":"css-px"}),
            ),
            ("action", json!({"action":"cancel"})),
            (
                "result",
                json!({"status":"error","error":"\u{0001}".repeat(2048)}),
            ),
            (
                "result",
                json!({"status":"applied","error":"\u{0001}".repeat(2048)}),
            ),
            (
                "result",
                json!({"status":"cancelled","error":"\u{0001}".repeat(2048)}),
            ),
            ("closed", json!({"reason":"ownerTabClose"})),
        ] {
            let message = Message {
                message_type: kind.into(),
                data,
                ..maximum.clone()
            };
            message.validate().unwrap();
            if kind == "result" {
                // Allowed 2048-character errors expand to over 12 KiB in JSON.
                assert!(serde_json::to_vec(&message).unwrap().len() >= 8192);
            }
            send_owner(session, &registration.window_label, &message).unwrap();
            send_host(session, &message).unwrap();
        }
        let deliveries = deliveries.lock().unwrap();
        assert_eq!(deliveries.len(), 18);
        for bytes in deliveries.iter() {
            let payload: Value = serde_json::from_str(bytes).unwrap();
            if payload["message"]["type"] == "result" {
                assert_eq!(payload["message"]["data"]["error"], OVERSIZED_ERROR);
            }
        }
    }
    #[test]
    fn oversized_non_error_deliveries_and_envelopes_fail_closed() {
        let mut registry = Registry::default();
        let (r, _) = register(&mut registry, snapshot(), false).unwrap();
        let session = registry.sessions.get_mut(&r.host_id).unwrap();
        let mut message = snapshot();
        message.data["title"] = json!("x".repeat(MAX_CHANNEL_BYTES));
        assert!(delivery(session, "main", &message).is_err());
        // Even replacing error text must not permit an oversized delivery envelope.
        session.registration.window_label = "x".repeat(MAX_CHANNEL_BYTES);
        message.message_type = "result".into();
        message.data = json!({"status":"error","error":"\u{0001}".repeat(2048)});
        assert!(delivery(session, "main", &message).is_err());
    }
    #[test]
    fn dialogs_disable_minimize_and_reopen_unminimizes_before_show_and_focus() {
        // Native builder/order contracts cannot be exercised by the headless mock runtime.
        let source = include_str!("dialog_windows.rs");
        let builder = source
            .split("let builder = WebviewWindowBuilder::new(")
            .nth(1)
            .unwrap()
            .split("if let Err(error) = builder.build()")
            .next()
            .unwrap();
        assert!(builder.contains(".minimizable(false)"));
        let reopen = source
            .split("fn show_on_main<R: Runtime>")
            .nth(1)
            .unwrap()
            .split("pub(crate) fn configure_on_main")
            .next()
            .unwrap();
        let unminimize = reopen.find("window.unminimize()").unwrap();
        let show = reopen.find("window.show()").unwrap();
        let focus = reopen.find("window.set_focus()").unwrap();
        assert!(unminimize < show && show < focus);
    }
    #[test]
    fn terminal_action_is_reserved_across_distinct_request_ids() {
        let mut registry = Registry::default();
        let (r, _) = register(&mut registry, snapshot(), false).unwrap();
        let session = registry.sessions.get_mut(&r.host_id).unwrap();
        let mut action = snapshot();
        action.message_type = "action".into();
        action.data = json!({"action":"apply","width":10,"height":15,"unit":"mm"});
        assert!(reserve_action(session, &action).unwrap());
        assert!(!reserve_action(session, &action).unwrap());
        action.request_id = "second".into();
        assert!(reserve_action(session, &action).is_err());
        session.terminal_request = None; // An error result releases the reservation.
        assert!(reserve_action(session, &action).unwrap());
    }
    #[test]
    fn placement_moves_before_destination_resize_and_clamps_the_measured_outer_frame() {
        use std::cell::RefCell;
        let calls = RefCell::new(Vec::new());
        let frame = RefCell::new((420, 330));
        let work = WorkArea {
            id: "high-dpi".into(),
            x: 1000.0,
            y: 0.0,
            width: 800.0,
            height: 600.0,
            scale: 2.0,
        };
        finish_placement(
            (3000.0, 1000.0, 2.0),
            &work,
            |x, y| {
                calls.borrow_mut().push(format!("move:{x},{y}"));
                if calls.borrow().len() == 1 {
                    // Simulate Windows WM_DPICHANGED rescaling the old client on the first move.
                    let old = *frame.borrow();
                    *frame.borrow_mut() = (old.0 * 2, old.1 * 2);
                }
                Ok(())
            },
            |w, h| {
                calls.borrow_mut().push(format!("size:{w},{h}"));
                *frame.borrow_mut() = (w + 32, h + 80);
                Ok(())
            },
            || {
                calls.borrow_mut().push("measure".into());
                Ok(*frame.borrow())
            },
        )
        .unwrap();
        assert_eq!(
            *calls.borrow(),
            ["move:3000,1000", "size:840,600", "measure", "move:2728,520"]
        );
        assert_eq!(*frame.borrow(), (872, 680));
    }
    #[test]
    fn persistence_worker_coalesces_a_burst_and_writes_after_registry_unlock() {
        use std::sync::mpsc;
        let (sender, receiver) = mpsc::sync_channel(1);
        let registry = std::sync::Arc::new(Mutex::new(Registry::default()));
        let (r, _) = register(&mut registry.lock().unwrap(), snapshot(), false).unwrap();
        let saved = SavedPosition {
            monitor: "display".into(),
            x: 1.0,
            y: 2.0,
            offset_x: 0.5,
            offset_y: 0.5,
        };
        let writes = std::sync::Arc::new(Mutex::new(Vec::new()));
        let worker_registry = registry.clone();
        let worker_writes = writes.clone();
        // The same worker loop used in production processes the entire movement burst.
        let worker = std::thread::spawn(move || {
            debounce_positions(receiver, Duration::from_secs(5), |_| {
                flush_pending_positions(&worker_registry, |snapshot| {
                    assert!(
                        worker_registry.try_lock().is_ok(),
                        "file IO must not hold REGISTRY"
                    );
                    worker_writes.lock().unwrap().push(snapshot);
                });
            })
        });
        for revision in 1u32..=1000 {
            registry
                .lock()
                .unwrap()
                .sessions
                .get_mut(&r.host_id)
                .unwrap()
                .pending_move = Some((
                Instant::now(),
                SavedPosition {
                    x: f64::from(revision),
                    ..saved.clone()
                },
            ));
            let _ = sender.try_send(std::path::PathBuf::from("positions.json"));
        }
        drop(sender);
        worker.join().unwrap();
        let writes = writes.lock().unwrap();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0][0].1.x, 1000.0);
        assert!(registry.lock().unwrap().sessions[&r.host_id]
            .pending_move
            .is_none());
    }
    #[test]
    fn a_coalesced_kind_remembers_the_latest_move_across_tabs() {
        let mut registry = Registry::default();
        let (first, _) = register(&mut registry, snapshot(), false).unwrap();
        let mut other = snapshot();
        other.document_tab_id = "tab-2".into();
        other.session_id = "session-2".into();
        let (second, _) = register(&mut registry, other, false).unwrap();
        let now = Instant::now();
        let position = SavedPosition {
            monitor: "display".into(),
            x: 1.0,
            y: 2.0,
            offset_x: 0.5,
            offset_y: 0.5,
        };
        registry
            .sessions
            .get_mut(&first.host_id)
            .unwrap()
            .pending_move = Some((now + Duration::from_millis(1), position.clone()));
        registry
            .sessions
            .get_mut(&second.host_id)
            .unwrap()
            .pending_move = Some((now, SavedPosition { x: 3.0, ..position }));
        let writes = take_pending_positions(&mut registry);
        assert_eq!(writes.last().unwrap().1.x, 1.0);
        assert!(registry.sessions.values().all(|s| s.pending_move.is_none()));
    }
    #[test]
    fn dialog_uses_shared_suspension_order_and_is_never_restored_after_close_or_quit() {
        let dialog = "dialog-main-pageSize-1";
        let toolbar = "toolset-core-main";
        assert!(super::super::is_suspended_utility_label(dialog));
        assert!(super::super::utility_window_has_document_parent(dialog));
        let mut suspension = super::super::utility_suspension::UtilitySuspension::default();
        suspension.begin(
            [
                (dialog.into(), true, false, true),
                (toolbar.into(), true, false, false),
            ],
            Some(vec![toolbar.into(), dialog.into()]),
        );
        assert!(suspension.visible(toolbar, false));
        assert_eq!(
            suspension.release(false),
            Some(vec![dialog.into(), toolbar.into()])
        );
        suspension.closed(dialog);
        assert_eq!(suspension.pending_restore(), Some(vec![toolbar.into()]));
        assert_eq!(suspension.release(true), None);
        assert_eq!(suspension.pending_restore(), None);
    }
    fn snapshot() -> Message {
        serde_json::from_value(json!({"protocolVersion":1,"ownerWindowId":"main","documentTabId":"tab-1","dialogKind":"pageSize","sessionId":"session-1","requestId":"request-1","snapshotRevision":1,"type":"snapshot","data":{"title":"Drawing","width":8.5,"height":11,"unit":"inch"}})).unwrap()
    }
    #[test]
    fn validates_kind_label_owner_and_payload() {
        let mut m = snapshot();
        assert!(m.validate().is_ok());
        for kind in ["export", "pageSize/../main", "unknown"] {
            m.dialog_kind = kind.into();
            assert!(m.validate().is_err());
        }
        m = snapshot();
        m.owner_window_id = "preferences".into();
        assert!(m.validate().is_err());
        m = snapshot();
        m.data["title"] = json!("x".repeat(MAX_BYTES));
        assert!(m.validate().is_err());
        m = snapshot();
        m.data["callback"] = json!("command");
        assert!(m.validate().is_err());
        m = snapshot();
        m.data["title"] = json!("😀".repeat(128));
        assert!(m.validate().is_ok());
        m.data["title"] = json!("😀".repeat(129));
        assert!(m.validate().is_err());
        m = snapshot();
        m.message_type = "result".into();
        m.data = json!({"status": "error", "error": null});
        assert!(m.validate().is_err());
        assert!(is_dialog_label("dialog-main-pageSize-12"));
        for label in [
            "dialog-main-export-0",
            "dialog-other-pageSize-0",
            "dialog-main-pageSize-../",
            "main",
        ] {
            assert!(!is_dialog_label(label));
        }
        let mut registry = Registry::default();
        let (r, _) = register(&mut registry, snapshot(), false).unwrap();
        let s = &registry.sessions[&r.host_id];
        assert!(authorize(s, &r.window_label, false, Some(&snapshot())).is_ok());
        assert!(authorize(s, "main", false, None).is_err());
        let mut stale = snapshot();
        stale.session_id = "stale".into();
        assert!(authorize(s, &r.window_label, false, Some(&stale)).is_err());
        stale = snapshot();
        stale.snapshot_revision += 1;
        assert!(authorize(s, &r.window_label, false, Some(&stale)).is_err());
    }
    #[test]
    fn quit_refuses_and_concurrent_same_session_builds_once() {
        assert!(register(&mut Registry::default(), snapshot(), true).is_err());
        let registry = std::sync::Arc::new(Mutex::new(Registry::default()));
        let builds = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let registry = registry.clone();
                let builds = builds.clone();
                std::thread::spawn(move || {
                    let (r, build) =
                        register(&mut registry.lock().unwrap(), snapshot(), false).unwrap();
                    if build {
                        builds.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    }
                    r.window_label
                })
            })
            .collect();
        let labels: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert!(labels.iter().all(|l| l == &labels[0]));
        assert_eq!(builds.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
    #[test]
    fn geometry_centers_clamps_and_recovers_monitor_loss_using_destination_scale() {
        let owner = WorkArea {
            id: "owner".into(),
            x: 0.0,
            y: 30.0,
            width: 1000.0,
            height: 700.0,
            scale: 2.0,
        };
        let other = WorkArea {
            id: "other".into(),
            x: 1000.0,
            y: 0.0,
            width: 800.0,
            height: 600.0,
            scale: 1.5,
        };
        assert_eq!(
            position_for(
                None,
                &[],
                &owner,
                (100.0, 100.0, 800.0, 600.0),
                (420.0, 330.0)
            ),
            (580.0, 470.0, 2.0)
        );
        let saved = SavedPosition {
            monitor: "other".into(),
            x: 0.0,
            y: 0.0,
            offset_x: 2.0,
            offset_y: -1.0,
        };
        assert_eq!(
            position_for(
                Some(&saved),
                &[other],
                &owner,
                (0.0, 0.0, 800.0, 600.0),
                (420.0, 330.0)
            ),
            (2070.0, 0.0, 1.5)
        );
        assert_eq!(
            position_for(
                Some(&saved),
                &[],
                &owner,
                (900.0, 650.0, 800.0, 600.0),
                (420.0, 330.0)
            ),
            (1160.0, 800.0, 2.0)
        );
    }
    #[test]
    fn persistence_excludes_hidden_minimized_teardown_suspension_and_restore_moves() {
        assert!(should_persist(true, false, false, false, true, false));
        for flags in [
            (false, false, false, false, true, false),
            (true, true, false, false, true, false),
            (true, false, true, false, true, false),
            (true, false, false, true, true, false),
            (true, false, false, false, false, false),
            (true, false, false, false, true, true),
        ] {
            assert!(!should_persist(
                flags.0, flags.1, flags.2, flags.3, flags.4, flags.5
            ));
        }
    }
}
