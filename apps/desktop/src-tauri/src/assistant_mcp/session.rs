//! Rust-only credentials and lifecycle. No credential type implements Serialize or Debug.
use super::protocol::{McpBridgeRequest, McpBridgeResponse};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use tokio::sync::{oneshot, watch, Semaphore};

pub trait BridgeSink: Send + Sync {
    fn send(&self, request: McpBridgeRequest) -> Result<(), String>;
}

pub(super) struct Pending {
    pub rpc_id: Value,
    pub answer: oneshot::Sender<Result<McpBridgeResponse, String>>,
}

pub(super) struct Session {
    pub id: String,
    pub plugin_id: String,
    token: String,
    pub sink: Arc<dyn BridgeSink>,
    pub initialized: AtomicBool,
    pub closed: AtomicBool,
    pub pending: Mutex<HashMap<String, Pending>>,
    pub permits: Arc<Semaphore>,
    pub sequence: AtomicU64,
    bound_run: Mutex<Option<String>>,
}

impl Session {
    pub fn authorized(&self, supplied: &[u8]) -> bool {
        // Always visit every secret byte, including for a wrong-length credential.
        let expected = self.token.as_bytes();
        let mut difference = expected.len() ^ supplied.len();
        for (i, byte) in expected.iter().enumerate() {
            difference |= usize::from(std::hint::black_box(
                byte ^ supplied.get(i).copied().unwrap_or(0),
            ));
        }
        difference == 0
    }

    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        let pending: Vec<_> = self.pending.lock().unwrap().drain().collect();
        for (request_id, pending) in pending {
            let _ = self.sink.send(McpBridgeRequest {
                session_id: self.id.clone(),
                request_id,
                method: "cancel".into(),
                params: serde_json::json!({"reason":"MCP session closed"}),
            });
            let _ = pending.answer.send(Err("ChemDraft session closed".into()));
        }
    }

    pub fn next_id(&self) -> String {
        self.sequence.fetch_add(1, Ordering::Relaxed).to_string()
    }
}

struct Listener {
    port: u16,
    stop: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Default)]
struct Inner {
    sessions: HashMap<String, Arc<Session>>,
    listener: Option<Listener>,
    shutting_down: bool,
}

#[derive(Default)]
pub(crate) struct SessionManager {
    inner: Mutex<Inner>,
    /// Tests can shorten waits without changing production deadlines.
    pub(super) timeout_override: Option<Duration>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOpened {
    pub session_id: String,
    pub server_name: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub listening: bool,
    pub session_count: usize,
}

fn random_hex<const N: usize>() -> Result<String, String> {
    let mut bytes = [0; N];
    getrandom::fill(&mut bytes).map_err(|e| format!("MCP random generation failed: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

impl SessionManager {
    #[cfg(test)]
    pub(super) fn with_timeout(timeout_override: Option<Duration>) -> Self {
        Self {
            timeout_override,
            inner: Mutex::new(Inner::default()),
        }
    }

    pub fn open(
        self: &Arc<Self>,
        plugin_id: String,
        plugin_name: String,
        sink: Arc<dyn BridgeSink>,
    ) -> Result<SessionOpened, String> {
        if !crate::external_tools::valid_plugin_id(&plugin_id)
            || plugin_name.trim().is_empty()
            || plugin_name.len() > 256
        {
            return Err("Invalid MCP plugin identity".into());
        }
        let mut inner = self.inner.lock().unwrap();
        if inner.shutting_down {
            return Err("MCP server is shutting down".into());
        }
        if inner.sessions.len() >= 8
            || inner
                .sessions
                .values()
                .filter(|s| s.plugin_id == plugin_id)
                .count()
                >= 2
        {
            return Err("MCP session limit reached".into());
        }
        let id = random_hex::<16>()?;
        let token = random_hex::<32>()?;
        if inner.listener.is_none() {
            let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
                .map_err(|e| e.to_string())?;
            listener.set_nonblocking(true).map_err(|e| e.to_string())?;
            let port = listener.local_addr().map_err(|e| e.to_string())?.port();
            let listener =
                tokio::net::TcpListener::from_std(listener).map_err(|e| e.to_string())?;
            let (stop, receiver) = watch::channel(false);
            let manager = Arc::downgrade(self);
            let task = tokio::spawn(super::server::listen(listener, manager, receiver));
            inner.listener = Some(Listener { port, stop, task });
        }
        inner.sessions.insert(
            id.clone(),
            Arc::new(Session {
                id: id.clone(),
                plugin_id,
                token,
                sink,
                initialized: AtomicBool::new(false),
                closed: AtomicBool::new(false),
                pending: Mutex::new(HashMap::new()),
                permits: Arc::new(Semaphore::new(4)),
                sequence: AtomicU64::new(1),
                bound_run: Mutex::new(None),
            }),
        );
        Ok(SessionOpened {
            session_id: id,
            server_name: "chemdraft",
        })
    }

    pub(super) fn lookup(&self, id: &str) -> Option<Arc<Session>> {
        self.inner
            .lock()
            .unwrap()
            .sessions
            .get(id)
            .cloned()
            .filter(|s| !s.closed.load(Ordering::SeqCst))
    }

    pub fn close(&self, id: &str) {
        let session = {
            let mut inner = self.inner.lock().unwrap();
            let session = inner.sessions.remove(id);
            if inner.sessions.is_empty() {
                stop_listener(&mut inner);
            }
            session
        };
        if let Some(session) = session {
            session.close();
        }
    }

    pub fn shutdown(&self) {
        let sessions: Vec<_> = {
            let mut inner = self.inner.lock().unwrap();
            inner.shutting_down = true;
            let sessions = inner.sessions.drain().map(|(_, s)| s).collect();
            stop_listener(&mut inner);
            sessions
        };
        for session in sessions {
            session.close();
        }
    }

    pub fn status(&self) -> McpStatus {
        let inner = self.inner.lock().unwrap();
        McpStatus {
            listening: inner.listener.is_some(),
            session_count: inner.sessions.len(),
        }
    }

    pub fn credentials(&self, id: &str) -> Option<(String, String)> {
        let inner = self.inner.lock().unwrap();
        let session = inner.sessions.get(id)?;
        if session.closed.load(Ordering::SeqCst) {
            return None;
        }
        Some((
            format!(
                "http://127.0.0.1:{}/mcp/{id}",
                inner.listener.as_ref()?.port
            ),
            session.token.clone(),
        ))
    }

    pub fn respond(
        &self,
        session_id: &str,
        request_id: &str,
        response: McpBridgeResponse,
    ) -> Result<(), String> {
        if serde_json::to_vec(&match &response {
            McpBridgeResponse::Result { result } => result.clone(),
            McpBridgeResponse::Error { error } => {
                serde_json::to_value(error).map_err(|e| e.to_string())?
            }
        })
        .map_err(|e| e.to_string())?
        .len()
            > super::protocol::RESULT_LIMIT
        {
            return Err("MCP result exceeds 8 MiB".into());
        }
        let session = self.lookup(session_id).ok_or("Unknown MCP session")?;
        let pending = session
            .pending
            .lock()
            .unwrap()
            .remove(request_id)
            .ok_or("Unknown MCP request")?;
        pending
            .answer
            .send(Ok(response))
            .map_err(|_| "MCP caller disconnected".into())
    }
}

fn stop_listener(inner: &mut Inner) {
    if let Some(listener) = inner.listener.take() {
        let _ = listener.stop.send(true);
        // Abort drops the listening socket immediately; pending calls resolve through Session::close.
        listener.task.abort();
    }
}

impl Drop for SessionManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub(crate) fn manager() -> &'static Arc<SessionManager> {
    static MANAGER: OnceLock<Arc<SessionManager>> = OnceLock::new();
    MANAGER.get_or_init(|| Arc::new(SessionManager::default()))
}

/// Only the Rust run renderer may obtain the bearer token. Never register as a Tauri command.
pub(crate) fn session_credentials(session_id: &str) -> Option<(String, String)> {
    manager().credentials(session_id)
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum BindError {
    UnknownSession,
    NotOwner,
    AlreadyBound,
}

/// Holds the reservation through preparation, spawn, and child supervision.
/// Dropping on any failure or terminal path permits the next turn to reuse it.
pub(crate) struct RunBinding {
    session: Arc<Session>,
    pub run_id: String,
}
impl Drop for RunBinding {
    fn drop(&mut self) {
        let mut binding = self.session.bound_run.lock().unwrap();
        if binding.as_deref() == Some(&self.run_id) {
            *binding = None;
        }
    }
}

impl SessionManager {
    pub(crate) fn bind(
        &self,
        session_id: &str,
        plugin_id: &str,
        run_id: &str,
    ) -> Result<RunBinding, BindError> {
        // Serialize with close, so close cannot race a successful reservation.
        let inner = self.inner.lock().unwrap();
        let session = inner
            .sessions
            .get(session_id)
            .ok_or(BindError::UnknownSession)?;
        if session.closed.load(Ordering::SeqCst) {
            return Err(BindError::UnknownSession);
        }
        if session.plugin_id != plugin_id {
            return Err(BindError::NotOwner);
        }
        let mut binding = session.bound_run.lock().unwrap();
        if binding.is_some() {
            return Err(BindError::AlreadyBound);
        }
        *binding = Some(run_id.into());
        // Each CLI process starts a fresh MCP handshake, even on a reused conversation.
        session.initialized.store(false, Ordering::SeqCst);
        Ok(RunBinding {
            session: session.clone(),
            run_id: run_id.into(),
        })
    }
}

pub(crate) fn bind_session(
    session_id: &str,
    plugin_id: &str,
    run_id: &str,
) -> Result<RunBinding, BindError> {
    manager().bind(session_id, plugin_id, run_id)
}

#[cfg(test)]
mod binding_tests {
    use super::*;

    struct Sink;
    impl BridgeSink for Sink {
        fn send(&self, _: McpBridgeRequest) -> Result<(), String> {
            Ok(())
        }
    }

    /// Exercise reservation policy without needing permission to bind a test socket.
    fn fixture() -> (Arc<SessionManager>, Arc<Session>) {
        let manager = Arc::new(SessionManager::default());
        let session = Arc::new(Session {
            id: "session".into(),
            plugin_id: "plugin.a".into(),
            token: "rust-only".into(),
            sink: Arc::new(Sink),
            initialized: AtomicBool::new(true),
            closed: AtomicBool::new(false),
            pending: Mutex::new(HashMap::new()),
            permits: Arc::new(Semaphore::new(4)),
            sequence: AtomicU64::new(1),
            bound_run: Mutex::new(None),
        });
        manager
            .inner
            .lock()
            .unwrap()
            .sessions
            .insert(session.id.clone(), session.clone());
        (manager, session)
    }

    #[test]
    fn binding_requires_a_live_session_and_matching_owner() {
        let (manager, session) = fixture();
        assert!(matches!(
            manager.bind("missing", "plugin.a", "run"),
            Err(BindError::UnknownSession)
        ));
        assert!(matches!(
            manager.bind("session", "plugin.b", "run"),
            Err(BindError::NotOwner)
        ));
        assert!(session.bound_run.lock().unwrap().is_none());
        assert!(session.initialized.load(Ordering::SeqCst));
        manager.close("session");
        assert!(matches!(
            manager.bind("session", "plugin.a", "run"),
            Err(BindError::UnknownSession)
        ));
    }

    #[test]
    fn exclusive_binding_releases_on_drop_and_resets_each_handshake() {
        let (manager, session) = fixture();
        let binding = manager.bind("session", "plugin.a", "run.1").unwrap();
        assert_eq!(session.bound_run.lock().unwrap().as_deref(), Some("run.1"));
        assert!(!session.initialized.load(Ordering::SeqCst));
        session.initialized.store(true, Ordering::SeqCst);
        assert!(matches!(
            manager.bind("session", "plugin.a", "run.2"),
            Err(BindError::AlreadyBound)
        ));
        // A refused reservation must not disrupt the active process's handshake.
        assert!(session.initialized.load(Ordering::SeqCst));
        drop(binding);
        assert!(session.bound_run.lock().unwrap().is_none());
        assert_eq!(manager.status().session_count, 1);
        let next = manager.bind("session", "plugin.a", "run.2").unwrap();
        assert!(!session.initialized.load(Ordering::SeqCst));
        manager.close("session");
        drop(next); // Closing a bound session and then dropping its guard is safe.
        assert!(session.bound_run.lock().unwrap().is_none());
    }
}
