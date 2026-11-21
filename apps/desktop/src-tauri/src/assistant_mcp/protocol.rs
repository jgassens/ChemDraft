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

/// The native timer may win the race with the host's per-tool timer. Keep tool
/// failures model-visible in either case; non-tool requests retain protocol errors.
pub fn deadline_response(id: Value, method: &str) -> Value {
    if method == "tools/call" {
        result(
            id,
            json!({"isError":true,"content":[{"type":"text","text":"ChemDraft tool deadline exceeded"}]}),
        )
    } else {
        error(id, -32000, "ChemDraft did not answer in time")
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeadlineClass {
    Naming,
    Render,
    ReadCompute,
    RequestWrite,
}

impl DeadlineClass {
    fn ceiling(self) -> Duration {
        Duration::from_secs(match self {
            Self::Naming => 45,
            Self::Render => 60,
            Self::ReadCompute => 120,
            Self::RequestWrite => 480,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CatalogEntry {
    name: String,
    deadline: DeadlineClass,
}

#[derive(Default, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionCatalog {
    legacy: bool,
    tools: Vec<CatalogEntry>,
}

impl SessionCatalog {
    pub fn validate(&self) -> Result<(), String> {
        let mut names = std::collections::HashSet::new();
        if self.tools.len() > 32
            || self.tools.iter().any(|entry| {
                let name = entry.name.as_bytes();
                name.len() > 48
                    || !name.first().is_some_and(u8::is_ascii_lowercase)
                    || !name
                        .iter()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
                    || !names.insert(&entry.name)
            })
        {
            return Err("Invalid MCP tool catalog".into());
        }
        Ok(())
    }

    pub fn deadline(&self, method: &str, params: &Value) -> Option<Duration> {
        if method == "tools/list" {
            return Some(Duration::from_secs(10));
        }
        let name = params.get("name")?.as_str()?;
        self.tools
            .iter()
            .find(|entry| entry.name == name)
            .map(|entry| entry.deadline.ceiling())
    }

    pub fn unknown_tool(&self, id: Value, params: &Value) -> Value {
        if self.legacy {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return error(id, -32000, "An assistant tool name is required.");
            };
            return result(
                id,
                json!({"content":[{"type":"text","text":format!("Unknown assistant tool \"{name}\".")}],"isError":true}),
            );
        }
        error(id, -32602, "Unknown session tool.")
    }
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
