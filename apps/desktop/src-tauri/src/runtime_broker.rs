//! Private runtime/document IPC. Channels stay below Tauri's shared fetch-queue threshold.
//! The hidden host owns the sole plugin runtime; documents keep their drawing/history authority.

use std::{
    collections::BTreeMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{ipc::Channel, Manager, Runtime, WebviewWindowBuilder};

use crate::document_windows::DocumentWindowRegistry;

const HOST: &str = "runtime";
const MAX_BYTES: usize = 32 * 1024 * 1024;
const CHUNK_BYTES: usize = 4096;
const MAX_CHUNKS: usize = MAX_BYTES / CHUNK_BYTES;
const CHANNEL_BYTES: usize = 8191;
const MAX_PEERS: usize = 65;
const MAX_TRANSFERS: usize = 8;
const MAX_BUFFERED_BYTES: usize = 2 * MAX_BYTES;
const TRANSFER_TTL: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Chunk {
    transfer_id: String,
    index: usize,
    total: usize,
    bytes: usize,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Delivery {
    // Supplied by Rust from WebviewWindow, never by the renderer's message.
    sender: String,
    connection: String,
    chunk: Chunk,
}

struct Peer {
    connection: String,
    channel: Channel<Delivery>,
}

struct Partial {
    recipient: String,
    recipient_connection: String,
    transfer_id: String,
    bytes: usize,
    total: usize,
    next: usize,
    data: Vec<u8>,
    started: Instant,
}

#[derive(Default)]
struct Broker {
    peers: BTreeMap<String, Peer>,
    // One in-progress message per sender; senders serialize their own outgoing messages.
    partials: BTreeMap<String, Partial>,
    next_connection: u64,
}

#[derive(Default)]
pub(crate) struct State(Mutex<Broker>);

fn document_label(label: &str) -> bool {
    label.len() <= 128
        && (label == "main" || label.strip_prefix("doc-").is_some_and(|id| !id.is_empty()))
        && label
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == b'-' || ch == b'_')
}

fn authorize_peer(documents: &DocumentWindowRegistry, label: &str) -> Result<(), String> {
    if label == HOST {
        return Ok(());
    }
    if document_label(label)
        && documents
            .document_window(label)
            .is_some_and(|document| document.native_label == label)
    {
        return Ok(());
    }
    Err("Runtime broker access requires a live document window or the runtime host.".into())
}

fn authorize_caller(
    documents: &DocumentWindowRegistry,
    caller: &str,
    claimed: &str,
) -> Result<(), String> {
    if caller != claimed {
        return Err("Runtime broker caller does not match its claimed window label.".into());
    }
    authorize_peer(documents, caller)
}

fn authorize_pair(
    documents: &DocumentWindowRegistry,
    sender: &str,
    recipient: &str,
) -> Result<(), String> {
    authorize_peer(documents, sender)?;
    authorize_peer(documents, recipient)?;
    if (sender == HOST) == (recipient == HOST) {
        return Err("Runtime broker messages must cross the runtime/document boundary.".into());
    }
    Ok(())
}

/// Validate protocol direction again natively, after bounded reassembly and before any delivery.
/// Payload schemas, command permissions and document write-scope checks remain in the broker/host.
fn authorize_message(sender: &str, recipient: &str, bytes: &[u8]) -> Result<(), String> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|_| "Runtime broker message is not valid bounded JSON.".to_string())?;
    let object = value
        .as_object()
        .ok_or("Invalid runtime broker envelope.")?;
    let text = |key: &str| value.get(key).and_then(Value::as_str);
    if value.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("Unsupported runtime broker protocol version.".into());
    }
    let kind = text("kind").ok_or("Missing runtime broker message kind.")?;
    if kind == "contributions" {
        if sender != HOST
            || object.len() != 3
            || !value.get("payload").is_some_and(Value::is_object)
        {
            return Err("Only the runtime host can publish contributions.".into());
        }
        return Ok(());
    }
    if kind == "runtimeView" {
        if sender != HOST
            || object.len() != 4
            || !text("topic").is_some_and(|topic| topic.chars().count() <= 40)
            || !object.contains_key("payload")
        {
            return Err("Only the runtime host can publish runtime views.".into());
        }
        return Ok(());
    }
    if !text("id").is_some_and(|id| !id.is_empty() && id.chars().count() <= 256) {
        return Err("Invalid runtime broker request id.".into());
    }
    let method = text("method").ok_or("Missing runtime broker method.")?;
    let runtime_destination = match method {
        "initializeRuntime"
        | "invokeCommand"
        | "getContributions"
        | "getRuntimeView"
        | "runtimeViewAction"
        | "acceptPreparedProposal"
        | "setDocumentMetadata"
        | "setCoreCommands"
        | "prepareAssistantWrite"
        | "runtimeDialogAction" => true,
        "getDocument"
        | "getSelection"
        | "getViewportRect"
        | "applyPatch"
        | "undoOwnTransaction"
        | "endInvocation"
        | "captureDocumentTarget"
        | "invokeDocumentPlugin"
        | "runtimeDialogRequest"
        | "assistantBegin"
        | "assistantOpenInvocation"
        | "assistantRead"
        | "assistantWrite"
        | "cancelAssistantWrite"
        | "assistantConsent"
        | "cancelAssistantConsent"
        | "assistantEnd"
        | "assistantUndo"
        | "commitProposal"
        | "getCoreCommands"
        | "getCoreCommand"
        | "invokeCoreCommand"
        | "chooseRuntimeFile" => false,
        _ => return Err("Unknown runtime broker method.".into()),
    };
    match kind {
        "request" => {
            if object.len() != 5 || (recipient == HOST) != runtime_destination {
                return Err("Invalid runtime broker request direction or envelope.".into());
            }
            let payload = value
                .get("payload")
                .ok_or("Missing runtime request payload.")?;
            if matches!(
                method,
                "initializeRuntime" | "getContributions" | "getRuntimeView" | "getCoreCommands"
            ) {
                if !payload
                    .as_object()
                    .is_some_and(|payload| payload.is_empty())
                {
                    return Err("Invalid empty runtime request payload.".into());
                }
            } else if matches!(
                method,
                "setCoreCommands"
                    | "getCoreCommand"
                    | "invokeCoreCommand"
                    | "runtimeViewAction"
                    | "chooseRuntimeFile"
            ) {
                if !payload.is_object() {
                    return Err("Invalid runtime data request payload.".into());
                }
            } else {
                let reference = match method {
                    "invokeCommand" | "applyPatch" | "undoOwnTransaction" | "assistantBegin" => {
                        payload.get("invocation")
                    }
                    "assistantOpenInvocation"
                    | "assistantWrite"
                    | "prepareAssistantWrite"
                    | "cancelAssistantWrite"
                    | "assistantConsent"
                    | "cancelAssistantConsent"
                    | "assistantEnd" => payload.get("session"),
                    _ => Some(payload),
                };
                let target = if method == "captureDocumentTarget" {
                    payload.get("windowId").and_then(Value::as_str)
                } else {
                    reference
                        .and_then(|reference| reference.get("target"))
                        .and_then(|target| target.get("windowId"))
                        .and_then(Value::as_str)
                };
                let document = if sender == HOST { recipient } else { sender };
                if target != Some(document) {
                    return Err("Runtime broker invocation targets another document window.".into());
                }
            }
        }
        "response" => {
            if (sender == HOST) != runtime_destination {
                return Err("Invalid runtime broker response direction or envelope.".into());
            }
            match value.get("ok").and_then(Value::as_bool) {
                // JSON omits an undefined command result; the TS protocol accepts it.
                Some(true)
                    if object.len() == 5 || (object.len() == 6 && object.contains_key("value")) => {
                }
                Some(false)
                    if object.len() == 6
                        && text("error").is_some_and(|error| error.chars().count() <= 4000) => {}
                _ => return Err("Invalid runtime broker response payload.".into()),
            }
        }
        _ => return Err("Unknown runtime broker message kind.".into()),
    }
    Ok(())
}

fn token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == b'-' || ch == b'_')
}

impl Chunk {
    fn decode(&self) -> Result<Vec<u8>, String> {
        if !token(&self.transfer_id)
            || self.bytes == 0
            || self.bytes > MAX_BYTES
            || self.total == 0
            || self.total > MAX_CHUNKS
            || self.total != self.bytes.div_ceil(CHUNK_BYTES)
            || self.index >= self.total
            || self.data.len() > CHUNK_BYTES.div_ceil(3) * 4
        {
            return Err("Runtime broker chunk size or count limit exceeded.".into());
        }
        let data = STANDARD
            .decode(&self.data)
            .map_err(|_| "Invalid runtime broker chunk encoding.".to_string())?;
        let expected = if self.index + 1 == self.total {
            self.bytes - self.index * CHUNK_BYTES
        } else {
            CHUNK_BYTES
        };
        if data.len() != expected {
            return Err("Runtime broker chunk length does not match its declaration.".into());
        }
        Ok(data)
    }
}

impl Broker {
    fn forget(&mut self, label: &str) {
        self.peers.remove(label);
        self.partials
            .retain(|sender, partial| sender != label && partial.recipient != label);
    }

    fn prune(&mut self, documents: &DocumentWindowRegistry) {
        self.peers
            .retain(|label, _| authorize_peer(documents, label).is_ok());
        self.partials.retain(|sender, partial| {
            partial.started.elapsed() < TRANSFER_TTL
                && self.peers.contains_key(sender)
                && self
                    .peers
                    .get(&partial.recipient)
                    .is_some_and(|peer| peer.connection == partial.recipient_connection)
        });
    }

    fn connect(
        &mut self,
        documents: &DocumentWindowRegistry,
        caller: &str,
        claimed: &str,
        channel: Channel<Delivery>,
    ) -> Result<String, String> {
        authorize_caller(documents, caller, claimed)?;
        self.prune(documents);
        if self.peers.contains_key(caller) || self.peers.len() >= MAX_PEERS {
            return Err("Runtime broker window already connected or peer limit exceeded.".into());
        }
        self.next_connection = self
            .next_connection
            .checked_add(1)
            .ok_or("Connection id exhausted.")?;
        let connection = self.next_connection.to_string();
        self.peers.insert(
            caller.into(),
            Peer {
                connection: connection.clone(),
                channel,
            },
        );
        Ok(connection)
    }

    fn check_connection(&self, caller: &str, connection: &str) -> Result<(), String> {
        if !self
            .peers
            .get(caller)
            .is_some_and(|peer| peer.connection == connection)
        {
            return Err("Runtime broker connection is closed or stale.".into());
        }
        Ok(())
    }

    fn push(
        &mut self,
        documents: &DocumentWindowRegistry,
        caller: &str,
        claimed: &str,
        connection: &str,
        recipient: &str,
        chunk: Chunk,
    ) -> Result<(), String> {
        // A closing caller must release its buffered transfers even when authorization fails.
        self.prune(documents);
        authorize_caller(documents, caller, claimed)?;
        self.check_connection(caller, connection)?;
        authorize_pair(documents, caller, recipient)?;
        let recipient_connection = self
            .peers
            .get(recipient)
            .ok_or("Runtime broker recipient is not connected.")?
            .connection
            .clone();
        let result = (|| {
            let data = chunk.decode()?;
            if chunk.index == 0 {
                if self.partials.contains_key(caller) {
                    return Err("Runtime broker sender already has an incomplete message.".into());
                }
                let reserved: usize = self.partials.values().map(|partial| partial.bytes).sum();
                if self.partials.len() >= MAX_TRANSFERS
                    || reserved + chunk.bytes > MAX_BUFFERED_BYTES
                {
                    return Err("Runtime broker reassembly budget exceeded.".into());
                }
                self.partials.insert(
                    caller.into(),
                    Partial {
                        recipient: recipient.into(),
                        recipient_connection,
                        transfer_id: chunk.transfer_id.clone(),
                        bytes: chunk.bytes,
                        total: chunk.total,
                        next: 0,
                        data: Vec::new(),
                        started: Instant::now(),
                    },
                );
            }
            let partial = self
                .partials
                .get_mut(caller)
                .ok_or("Missing runtime broker first chunk.")?;
            if partial.recipient != recipient
                || partial.transfer_id != chunk.transfer_id
                || partial.total != chunk.total
                || partial.bytes != chunk.bytes
                || partial.next != chunk.index
            {
                return Err(
                    "Runtime broker chunk is out of order or changed its transfer identity.".into(),
                );
            }
            partial.data.extend_from_slice(&data);
            partial.next += 1;
            if partial.next != partial.total {
                return Ok(());
            }
            let partial = self
                .partials
                .remove(caller)
                .ok_or("Missing runtime broker transfer.")?;
            authorize_pair(documents, caller, recipient)?;
            authorize_message(caller, recipient, &partial.data)?;
            let peer = self
                .peers
                .get(recipient)
                .ok_or("Runtime broker recipient disconnected.")?;
            if peer.connection != partial.recipient_connection {
                return Err("Runtime broker recipient connection changed.".into());
            }
            // Serialize all chunks while holding the broker lock: deliveries cannot interleave.
            for (index, data) in partial.data.chunks(CHUNK_BYTES).enumerate() {
                authorize_pair(documents, caller, recipient)?;
                let delivery = Delivery {
                    sender: caller.into(),
                    connection: peer.connection.clone(),
                    chunk: Chunk {
                        transfer_id: partial.transfer_id.clone(),
                        index,
                        total: partial.total,
                        bytes: partial.bytes,
                        data: STANDARD.encode(data),
                    },
                };
                if serde_json::to_vec(&delivery)
                    .map_err(|error| error.to_string())?
                    .len()
                    > CHANNEL_BYTES
                {
                    return Err("Runtime broker private channel limit exceeded.".into());
                }
                peer.channel
                    .send(delivery)
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        })();
        if result.is_err() {
            self.partials.remove(caller);
        }
        result
    }
}

#[tauri::command]
pub(crate) async fn runtime_broker_connect(
    window: tauri::WebviewWindow,
    sender: String,
    channel: Channel<Delivery>,
) -> Result<String, String> {
    let documents = window.state::<DocumentWindowRegistry>();
    let state = window.state::<State>();
    let mut broker = state.0.lock().unwrap_or_else(|p| p.into_inner());
    broker.connect(&documents, window.label(), &sender, channel)
}

#[tauri::command]
pub(crate) async fn runtime_broker_send(
    window: tauri::WebviewWindow,
    sender: String,
    connection: String,
    recipient: String,
    chunk: Chunk,
) -> Result<(), String> {
    if window.app_handle().get_webview_window(&recipient).is_none() {
        return Err("Runtime broker recipient window no longer exists.".into());
    }
    let documents = window.state::<DocumentWindowRegistry>();
    let state = window.state::<State>();
    let mut broker = state.0.lock().unwrap_or_else(|p| p.into_inner());
    broker.push(
        &documents,
        window.label(),
        &sender,
        &connection,
        &recipient,
        chunk,
    )
}

#[tauri::command]
pub(crate) async fn runtime_broker_disconnect(
    window: tauri::WebviewWindow,
    sender: String,
    connection: String,
) -> Result<(), String> {
    authorize_caller(
        &window.state::<DocumentWindowRegistry>(),
        window.label(),
        &sender,
    )?;
    let state = window.state::<State>();
    let mut broker = state.0.lock().unwrap_or_else(|p| p.into_inner());
    broker.check_connection(window.label(), &connection)?;
    broker.forget(window.label());
    Ok(())
}

pub(crate) fn forget_window<R: Runtime>(app: &tauri::AppHandle<R>, label: &str) {
    app.state::<State>()
        .0
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .forget(label);
}

fn runtime_window_config() -> tauri::utils::config::WindowConfig {
    tauri::utils::config::WindowConfig {
        label: HOST.into(),
        url: tauri::WebviewUrl::App("/?window=runtime".into()),
        title: format!("{} runtime", crate::main_window_title()),
        focus: false,
        focusable: false,
        visible: false,
        skip_taskbar: true,
        ..Default::default()
    }
}

pub(crate) fn create_runtime_window<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    if app.get_webview_window(HOST).is_some() {
        return Err("The runtime host window already exists.".into());
    }
    // No registry/session registration, document ownership, menu, focus-return or reveal call.
    // macOS retains its application menu; Windows installs menus only on registered documents.
    let window = WebviewWindowBuilder::from_config(app, &runtime_window_config())
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())?;
    crate::disable_default_context_menus(&window);
    Ok(())
}

#[cfg(test)]
#[path = "runtime_broker_tests.rs"]
mod tests;
