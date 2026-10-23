//! JSON-only MCP wire contract. Chemistry and document writes remain in the host tool registry.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

pub const VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];
pub const BODY_LIMIT: usize = 1024 * 1024;
pub const RESULT_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpBridgeRequest {
    pub session_id: String,
    pub request_id: String,
    pub method: String,
    pub params: Value,
}

/// Exactly one of result/error, without the JSON-RPC envelope (Rust retains the caller's id).
#[derive(Debug, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum McpBridgeResponse {
    Result { result: Value },
    Error { error: McpError },
}

#[derive(Debug, Deserialize, Serialize)]
pub struct McpError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

pub fn error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc":"2.0", "id":id, "error":{"code":code,"message":message}})
}

pub fn result(id: Value, value: Value) -> Value {
    json!({"jsonrpc":"2.0", "id":id, "result":value})
}

pub fn deadline(method: &str, params: &Value) -> Duration {
    Duration::from_secs(if method == "tools/list" {
        10
    } else {
        match params.get("name").and_then(Value::as_str) {
            Some("render") => 60,
            Some("name_to_structure" | "structure_to_name") => 45,
            _ => 120,
        }
    })
}

pub fn initialize(params: &Value) -> Value {
    let requested = params.get("protocolVersion").and_then(Value::as_str);
    let version = requested
        .filter(|v| VERSIONS.contains(v))
        .unwrap_or(VERSIONS[0]);
    json!({
        "protocolVersion":version,
        "capabilities":{"tools":{}},
        "serverInfo":{"name":"chemdraft","version":env!("CARGO_PKG_VERSION")},
        "instructions":"Use ChemDraft tools to read and edit the open document. Changes are limited to the selection at Send and objects inserted in this request. Chemistry must be preserved."
    })
}
