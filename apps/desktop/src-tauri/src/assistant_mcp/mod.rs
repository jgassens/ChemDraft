//! Main-window-only loopback MCP boundary. Tokens are only accessible to the Rust run binding.
mod protocol;
mod server;
pub(crate) mod session;
#[cfg(test)]
mod tests;

pub use protocol::{McpBridgeRequest, McpBridgeResponse};
use session::{manager, BridgeSink, McpStatus, SessionOpened};
use std::sync::Arc;
use tauri::ipc::Channel;

impl BridgeSink for Channel<McpBridgeRequest> {
    fn send(&self, request: McpBridgeRequest) -> Result<(), String> {
        Channel::send(self, request).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn assistant_mcp_session_open(
    plugin_id: String,
    plugin_name: String,
    on_request: Channel<McpBridgeRequest>,
) -> Result<SessionOpened, String> {
    manager().open(plugin_id, plugin_name, Arc::new(on_request))
}

#[tauri::command]
pub fn assistant_mcp_session_close(session_id: String) {
    manager().close(&session_id);
}

#[tauri::command]
pub fn assistant_mcp_respond(
    session_id: String,
    request_id: String,
    response: McpBridgeResponse,
) -> Result<(), String> {
    manager().respond(&session_id, &request_id, response)
}

#[tauri::command]
pub fn assistant_mcp_status() -> McpStatus {
    manager().status()
}

pub fn shutdown() {
    manager().shutdown();
}
