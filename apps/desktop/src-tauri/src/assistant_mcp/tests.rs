use super::{
    protocol::{self, McpBridgeRequest, McpBridgeResponse},
    session::{BridgeSink, SessionManager},
};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::TcpStream,
    sync::{mpsc, Arc},
    time::Duration,
};

impl BridgeSink for mpsc::Sender<McpBridgeRequest> {
    fn send(&self, request: McpBridgeRequest) -> Result<(), String> {
        mpsc::Sender::send(self, request).map_err(|e| e.to_string())
    }
}

struct Fixture {
    manager: Arc<SessionManager>,
    session_id: String,
    host: String,
    path: String,
    token: String,
    receiver: Arc<std::sync::Mutex<mpsc::Receiver<McpBridgeRequest>>>,
}

struct Reply {
    status: u16,
    headers: String,
    body: Vec<u8>,
}
impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap()
    }
    fn assert_status(&self, status: u16) {
        assert_eq!(self.status, status, "{}", self.headers);
        assert!(!self
            .headers
            .to_ascii_lowercase()
            .contains("access-control-"));
    }
}

impl Fixture {
    async fn new(timeout: Option<Duration>) -> Self {
        let manager = Arc::new(SessionManager::with_timeout(timeout));
        let (sender, receiver) = mpsc::channel();
        let opened = manager
            .open(
                "org.chemdraft.assistant".into(),
                "Assistant".into(),
                Arc::new(sender),
            )
            .unwrap();
        let (url, token) = manager.credentials(&opened.session_id).unwrap();
        assert_eq!(opened.session_id.len(), 32);
        assert_eq!(token.len(), 64);
        assert_eq!(opened.server_name, "chemdraft");
        let parts = url
            .strip_prefix("http://")
            .unwrap()
            .split_once('/')
            .unwrap();
        Self {
            manager,
            session_id: opened.session_id,
            host: parts.0.into(),
            path: format!("/{}", parts.1),
            token,
            receiver: Arc::new(std::sync::Mutex::new(receiver)),
        }
    }

    fn raw(&self, method: &str, extra: &str, body: &str) -> String {
        format!("{method} {} HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{extra}\r\n{body}", self.path, self.host, self.token, body.len())
    }

    async fn send(&self, raw: String) -> Reply {
        send(self.host.clone(), raw).await
    }
    async fn call(&self, value: Value) -> Reply {
        self.send(self.raw(
            "POST",
            &format!("Mcp-Session-Id: {}\r\n", self.session_id),
            &value.to_string(),
        ))
        .await
    }
    async fn initialize(&self) -> Reply {
        self.send(self.raw("POST", "", &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}).to_string())).await
    }
    async fn receive(&self) -> McpBridgeRequest {
        let receiver = self.receiver.clone();
        tokio::task::spawn_blocking(move || {
            receiver
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(3))
                .unwrap()
        })
        .await
        .unwrap()
    }
    fn start_call(&self, id: u64, name: &str) -> tokio::task::JoinHandle<Reply> {
        let raw = self.raw("POST", &format!("Mcp-Session-Id: {}\r\n", self.session_id), &json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":name,"arguments":{}}}).to_string());
        let host = self.host.clone();
        tokio::spawn(send(host, raw))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.shutdown();
    }
}

async fn send(host: String, raw: String) -> Reply {
    send_with_read_timeout(host, raw, Duration::from_secs(5)).await
}

async fn send_with_read_timeout(host: String, raw: String, read_timeout: Duration) -> Reply {
    tokio::task::spawn_blocking(move || {
        let mut socket = TcpStream::connect(host).unwrap();
        socket.set_read_timeout(Some(read_timeout)).unwrap();
        socket
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        // A rejected large request may close while the sender is still writing.
        let _ = socket.write_all(raw.as_bytes());
        let mut bytes = Vec::new();
        match socket.read_to_end(&mut bytes) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset && !bytes.is_empty() => {}
            Err(e) => panic!("HTTP read: {e}"),
        }
        let boundary = bytes
            .windows(4)
            .position(|b| b == b"\r\n\r\n")
            .expect("HTTP header terminator");
        let headers = String::from_utf8(bytes[..boundary].to_vec()).unwrap();
        let status = headers.split_whitespace().nth(1).unwrap().parse().unwrap();
        let reply = Reply {
            status,
            headers,
            body: bytes[boundary + 4..].to_vec(),
        };
        assert!(!reply
            .headers
            .to_ascii_lowercase()
            .contains("access-control-"));
        reply
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn initialize_shape_session_echo_versions_and_notifications() {
    for version in ["2025-06-18", "2025-03-26", "2024-11-05", "future-version"] {
        let f = Fixture::new(None).await;
        let reply = f.send(f.raw("POST", "", &json!({"jsonrpc":"2.0","id":"init","method":"initialize","params":{"protocolVersion":version}}).to_string())).await;
        reply.assert_status(200);
        assert!(reply
            .headers
            .to_ascii_lowercase()
            .contains(&format!("mcp-session-id: {}", f.session_id)));
        let value = reply.json();
        assert_eq!(value["id"], "init");
        assert_eq!(
            value["result"]["protocolVersion"],
            if version == "future-version" {
                "2025-06-18"
            } else {
                version
            }
        );
        assert_eq!(value["result"]["serverInfo"]["name"], "chemdraft");
        assert!(value["result"]["serverInfo"]["version"].is_string());
        assert_eq!(value["result"]["capabilities"]["tools"], json!({}));
        assert!(value["result"]["instructions"].is_string());
        for method in ["notifications/initialized", "notifications/other"] {
            let reply = f.call(json!({"jsonrpc":"2.0","method":method})).await;
            reply.assert_status(202);
            assert!(reply.body.is_empty());
        }
        let reply = f
            .call(json!({"jsonrpc":"2.0","id":2,"method":"ping"}))
            .await;
        assert_eq!(reply.json(), json!({"jsonrpc":"2.0","id":2,"result":{}}));
    }
}

#[tokio::test]
async fn http_methods_paths_authentication_host_origin_and_no_cors() {
    let f = Fixture::new(None).await;
    let body = r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#;
    for method in ["GET", "DELETE", "OPTIONS", "PUT"] {
        let reply = f.send(f.raw(method, "", body)).await;
        reply.assert_status(405);
        assert!(reply.headers.to_ascii_lowercase().contains("allow: post"));
    }
    for replacement in ["", "Bearer wrong", "Basic x"] {
        let raw = f
            .raw("POST", "", body)
            .replace(&format!("Bearer {}", f.token), replacement);
        let reply = f.send(raw).await;
        reply.assert_status(401);
        assert!(reply
            .headers
            .to_ascii_lowercase()
            .contains("www-authenticate: bearer"));
    }
    for index in [0, 63] {
        let mut wrong = f.token.as_bytes().to_vec();
        wrong[index] = if wrong[index] == b'a' { b'b' } else { b'a' };
        f.send(
            f.raw("POST", "", body)
                .replace(&f.token, std::str::from_utf8(&wrong).unwrap()),
        )
        .await
        .assert_status(401);
    }
    f.send(
        f.raw("POST", "", body)
            .replace(&format!("Authorization: Bearer {}\r\n", f.token), ""),
    )
    .await
    .assert_status(401);
    f.send(f.raw(
        "POST",
        &format!("Authorization: Bearer {}\r\n", f.token),
        body,
    ))
    .await
    .assert_status(401);
    for host in [
        "localhost:80",
        "evil.example",
        "127.0.0.1:1",
        "127.0.0.1.evil",
    ] {
        f.send(
            f.raw("POST", "", body)
                .replace(&format!("Host: {}", f.host), &format!("Host: {host}")),
        )
        .await
        .assert_status(403);
    }
    f.send(
        f.raw("POST", "", body)
            .replace(&format!("Host: {}\r\n", f.host), ""),
    )
    .await
    .assert_status(403);
    f.send(f.raw("POST", "Host: evil\r\n", body))
        .await
        .assert_status(403);
    f.send(
        f.raw("POST", "", body)
            .replacen(&f.path, &format!("http://evil{}", f.path), 1),
    )
    .await
    .assert_status(403);
    for origin in [
        "http://evil",
        "https://127.0.0.1.evil",
        "http://localhost@evil",
        "file://localhost",
        "http://127.0.0.1/",
        "http://[::1]evil",
        "http://[localhost]",
        "http://[127.0.0.1]",
        "http://localhost:bad",
        "null, http://evil",
    ] {
        f.send(f.raw("POST", &format!("Origin: {origin}\r\n"), body))
            .await
            .assert_status(403);
    }
    f.send(f.raw("POST", "Origin: null\r\nOrigin: http://evil\r\n", body))
        .await
        .assert_status(403);
    for origin in [
        "null",
        "http://127.0.0.1:3000",
        "http://127.0.0.2:3000",
        "http://localhost",
        "http://LOCALHOST:8080",
        "https://[::1]:1234",
    ] {
        let f = Fixture::new(None).await;
        f.send(f.raw("POST", &format!("Origin: {origin}\r\n"), body))
            .await
            .assert_status(200);
    }
    for path in ["/", "/mcp/no-such-session", "/mcp/a/b", "/mcp/"] {
        f.send(f.raw("POST", "", body).replacen(&f.path, path, 1))
            .await
            .assert_status(404);
    }
    f.send(
        f.raw("POST", "", body)
            .replacen(&f.path, &(f.path.clone() + "?x=1"), 1),
    )
    .await
    .assert_status(404);
}

#[tokio::test]
async fn header_body_content_type_and_json_rpc_limits() {
    let f = Fixture::new(None).await;
    let body = r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#;
    {
        let f = Fixture::new(None).await;
        let raw = f.raw("POST", "X-Padding: \r\n", body);
        let header_bytes = raw.find("\r\n\r\n").unwrap() + 4;
        let raw = raw.replace(
            "X-Padding: \r\n",
            &format!("X-Padding: {}\r\n", "x".repeat(16 * 1024 - header_bytes)),
        );
        f.send(raw).await.assert_status(200);
    }
    {
        let f = Fixture::new(None).await;
        let body = body.to_owned() + &" ".repeat(protocol::BODY_LIMIT - body.len());
        f.send(f.raw("POST", "", &body)).await.assert_status(200);
    }
    f.send(f.raw(
        "POST",
        &format!("X-Large: {}\r\n", "x".repeat(16 * 1024)),
        body,
    ))
    .await
    .assert_status(431);
    f.send(f.raw("POST", "", body).replace(
        &format!("Content-Length: {}", body.len()),
        "Content-Length: 1048577",
    ))
    .await
    .assert_status(413);
    for content_type in ["text/plain", "application/jsonp", ""] {
        f.send(
            f.raw("POST", "", body)
                .replace("application/json", content_type),
        )
        .await
        .assert_status(415);
    }
    let chunk = " ".repeat(protocol::BODY_LIMIT + 1);
    let raw = f
        .raw("POST", "", "")
        .replace("Content-Length: 0\r\n", "Transfer-Encoding: chunked\r\n")
        + &format!("{:x}\r\n{}\r\n0\r\n\r\n", chunk.len(), chunk);
    f.send(raw).await.assert_status(413);
    for body in [
        "[]",
        "[{}]",
        "null",
        "1",
        "{}",
        r#"{"jsonrpc":"1.0","id":1,"method":"ping"}"#,
        r#"{"jsonrpc":"2.0","id":{},"method":"ping"}"#,
        r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":1}"#,
    ] {
        let reply = f.send(f.raw("POST", "", body)).await;
        reply.assert_status(200);
        assert_eq!(reply.json()["error"]["code"], -32600);
    }
    let reply = f.send(f.raw("POST", "", "{")).await;
    assert_eq!(reply.json()["error"]["code"], -32700);
    f.initialize().await.assert_status(200);
    let ping = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
    f.send(f.raw("POST", "", ping)).await.assert_status(404);
    f.send(f.raw("POST", "Mcp-Session-Id: wrong\r\n", ping))
        .await
        .assert_status(404);
    f.send(f.raw(
        "POST",
        &format!(
            "Mcp-Session-Id: {}\r\nMCP-Protocol-Version: unknown\r\n",
            f.session_id
        ),
        ping,
    ))
    .await
    .assert_status(400);
    f.send(f.raw(
        "POST",
        &format!(
            "Mcp-Session-Id: {}\r\nMcp-Session-Id: {}\r\n",
            f.session_id, f.session_id
        ),
        ping,
    ))
    .await
    .assert_status(404);
    for version in protocol::VERSIONS {
        f.send(f.raw(
            "POST",
            &format!(
                "Mcp-Session-Id: {}\r\nMCP-Protocol-Version: {version}\r\n",
                f.session_id
            ),
            ping,
        ))
        .await
        .assert_status(200);
    }
    let reply = f
        .call(json!({"jsonrpc":"2.0","id":4,"method":"unknown"}))
        .await;
    assert_eq!(reply.json()["error"]["code"], -32601);
}

#[tokio::test]
async fn forwarded_tools_list_and_call_receive_results_and_errors() {
    let f = Fixture::new(None).await;
    f.initialize().await.assert_status(200);
    let call = f.start_call(17, "get_document");
    let request = f.receive().await;
    assert_eq!(request.method, "tools/call");
    assert_eq!(request.session_id, f.session_id);
    assert_eq!(
        request.params,
        json!({"name":"get_document","arguments":{}})
    );
    f.manager
        .respond(
            &f.session_id,
            &request.request_id,
            McpBridgeResponse::Result {
                result: json!({"content":[{"type":"text","text":"ok"}]}),
            },
        )
        .unwrap();
    let reply = call.await.unwrap();
    reply.assert_status(200);
    assert_eq!(reply.json()["id"], 17);
    assert_eq!(reply.json()["result"]["content"][0]["text"], "ok");
    let raw = f.raw(
        "POST",
        &format!("Mcp-Session-Id: {}\r\n", f.session_id),
        r#"{"jsonrpc":"2.0","id":"list","method":"tools/list"}"#,
    );
    let call = tokio::spawn(send(f.host.clone(), raw));
    let request = f.receive().await;
    assert_eq!(request.method, "tools/list");
    f.manager
        .respond(
            &f.session_id,
            &request.request_id,
            McpBridgeResponse::Result {
                result: json!({"tools":[]}),
            },
        )
        .unwrap();
    assert_eq!(call.await.unwrap().json()["result"], json!({"tools":[]}));
    let call = f.start_call(18, "get_document");
    let request = f.receive().await;
    f.manager
        .respond(
            &f.session_id,
            &request.request_id,
            serde_json::from_value(
                json!({"error":{"code":-32602,"message":"bad arguments","data":{"field":"x"}}}),
            )
            .unwrap(),
        )
        .unwrap();
    assert_eq!(
        call.await.unwrap().json()["error"],
        json!({"code":-32602,"message":"bad arguments","data":{"field":"x"}})
    );
    assert!(f
        .manager
        .respond(
            &f.session_id,
            &request.request_id,
            McpBridgeResponse::Result { result: json!({}) }
        )
        .is_err());
}

#[tokio::test]
async fn deadlines_busy_fifth_call_cancellation_and_close_mid_call() {
    let f = Fixture::new(Some(Duration::from_millis(100))).await;
    f.initialize().await;
    let call = f.start_call(1, "render");
    let request = f.receive().await;
    let reply = call.await.unwrap();
    assert_eq!(
        reply.json()["error"],
        json!({"code":-32000,"message":"ChemDraft did not answer in time"})
    );
    assert!(f
        .manager
        .respond(
            &f.session_id,
            &request.request_id,
            McpBridgeResponse::Result { result: json!({}) }
        )
        .is_err());
    let f = Fixture::new(None).await;
    f.initialize().await;
    let mut calls = Vec::new();
    for id in 1..=4 {
        calls.push(f.start_call(id, "render"));
        f.receive().await;
    }
    let reply = f.start_call(5, "render").await.unwrap();
    assert_eq!(
        reply.json()["error"],
        json!({"code":-32000,"message":"busy"})
    );
    f.call(json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}))
        .await
        .assert_status(202);
    let cancelled = f.receive().await;
    assert_eq!(cancelled.method, "cancel");
    assert_eq!(cancelled.request_id, "1");
    assert_eq!(
        calls.remove(0).await.unwrap().json()["error"]["message"],
        "ChemDraft request cancelled"
    );
    f.manager.close(&f.session_id);
    for call in calls {
        let reply = call.await.unwrap();
        reply.assert_status(200);
        assert_eq!(reply.json()["error"]["message"], "ChemDraft session closed");
    }
    tokio::task::yield_now().await;
    assert!(TcpStream::connect(&f.host).is_err());
}

#[test]
fn tool_deadlines_preserve_reads_and_allow_bounded_confirmation() {
    for (method, name, seconds) in [
        ("tools/list", "", 10),
        ("tools/call", "render", 60),
        ("tools/call", "name_to_structure", 45),
        ("tools/call", "structure_to_name", 45),
        ("tools/call", "get_document", 120),
        ("tools/call", "get_selection", 120),
        ("tools/call", "get_structure", 120),
        ("tools/call", "validate_smiles", 120),
        ("tools/call", "insert_structures", 480),
        ("tools/call", "insert_reaction", 480),
        ("tools/call", "insert_text", 480),
        ("tools/call", "edit_structure", 480),
        ("tools/call", "delete_objects", 480),
        ("tools/call", "style_objects", 480),
        ("tools/call", "move_objects", 480),
    ] {
        assert_eq!(
            protocol::deadline(method, &json!({"name":name})),
            Duration::from_secs(seconds)
        );
    }
}

#[tokio::test]
async fn write_call_survives_120_seconds_waiting_for_the_bridge() {
    // Exercise real HTTP, production deadlines and pending-call cancellation, without the
    // fixture's short timeout override. Tokio test-util is not enabled in the desktop crate.
    let f = Fixture::new(None).await;
    f.initialize().await.assert_status(200);
    let start = |id, name| {
        let raw = f.raw("POST", &format!("Mcp-Session-Id: {}\r\n", f.session_id),
            &json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":name,"arguments":{}}}).to_string());
        tokio::spawn(send_with_read_timeout(
            f.host.clone(),
            raw,
            Duration::from_secs(135),
        ))
    };
    let write = start(1, "insert_structures");
    let request = f.receive().await;
    assert_eq!(request.params["name"], "insert_structures");
    let read = start(2, "get_document");
    let read_request = f.receive().await;
    tokio::time::sleep(Duration::from_secs(121)).await;
    assert!(
        !write.is_finished(),
        "write timed out before the human decision cap"
    );
    assert_eq!(
        read.await.unwrap().json()["error"]["message"],
        "ChemDraft did not answer in time"
    );
    let cancelled = f.receive().await;
    assert_eq!(cancelled.method, "cancel");
    assert_eq!(cancelled.request_id, read_request.request_id);
    assert!(
        f.receiver.lock().unwrap().try_recv().is_err(),
        "write must not be cancelled"
    );
    f.manager
        .respond(
            &f.session_id,
            &request.request_id,
            McpBridgeResponse::Result {
                result: json!({"content":[{"type":"text","text":"inserted after confirmation"}]}),
            },
        )
        .unwrap();
    let reply = write.await.unwrap();
    reply.assert_status(200);
    assert_eq!(reply.json()["id"], 1);
    assert_eq!(
        reply.json()["result"]["content"][0]["text"],
        "inserted after confirmation"
    );
}

#[tokio::test]
async fn result_limit_and_dead_webview_breaks_session() {
    let f = Fixture::new(None).await;
    f.initialize().await;
    let call = f.start_call(1, "render");
    let request = f.receive().await;
    assert!(f
        .manager
        .respond(
            &f.session_id,
            &request.request_id,
            McpBridgeResponse::Result {
                result: json!("x".repeat(protocol::RESULT_LIMIT))
            }
        )
        .is_err());
    f.manager
        .respond(
            &f.session_id,
            &request.request_id,
            McpBridgeResponse::Result {
                result: json!("x".repeat(protocol::RESULT_LIMIT - 3)),
            },
        )
        .unwrap();
    assert_eq!(
        call.await.unwrap().json()["error"]["message"],
        "MCP result exceeds 8 MiB"
    );
    struct Gone;
    impl BridgeSink for Gone {
        fn send(&self, _: McpBridgeRequest) -> Result<(), String> {
            Err("webview gone".into())
        }
    }
    let opened = f
        .manager
        .open("org.test".into(), "Gone".into(), Arc::new(Gone))
        .unwrap();
    let (url, token) = f.manager.credentials(&opened.session_id).unwrap();
    let path = url.strip_prefix(&format!("http://{}", f.host)).unwrap();
    let raw = f
        .raw(
            "POST",
            &format!("Mcp-Session-Id: {}\r\n", opened.session_id),
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#,
        )
        .replace(&f.path, path)
        .replace(&f.token, &token);
    let reply = f.send(raw).await;
    assert_eq!(reply.json()["error"]["message"], "ChemDraft session closed");
    assert!(f.manager.credentials(&opened.session_id).is_none());
}

#[tokio::test]
async fn lazy_listener_session_limits_randomness_close_and_shutdown() {
    let manager = Arc::new(SessionManager::default());
    assert!(!manager.status().listening);
    let (sender, _) = mpsc::channel();
    for (plugin, name) in [
        ("../invalid", "Test"),
        ("good", ""),
        ("good", &"x".repeat(257)),
    ] {
        assert!(manager
            .open(plugin.into(), name.into(), Arc::new(sender.clone()))
            .is_err());
    }
    let mut ids = Vec::new();
    for plugin in 0..4 {
        for _ in 0..2 {
            ids.push(
                manager
                    .open(
                        format!("plugin.{plugin}"),
                        "Test".into(),
                        Arc::new(sender.clone()),
                    )
                    .unwrap()
                    .session_id,
            );
        }
        assert!(manager
            .open(
                format!("plugin.{plugin}"),
                "Test".into(),
                Arc::new(sender.clone())
            )
            .is_err());
    }
    assert!(manager
        .open("plugin.other".into(), "Test".into(), Arc::new(sender))
        .is_err());
    let credentials = ids
        .iter()
        .map(|id| manager.credentials(id).unwrap())
        .collect::<Vec<_>>();
    for i in 0..ids.len() {
        for j in i + 1..ids.len() {
            assert_ne!(ids[i], ids[j]);
            assert_ne!(credentials[i].1, credentials[j].1);
        }
    }
    let host = credentials[0]
        .0
        .strip_prefix("http://")
        .unwrap()
        .split('/')
        .next()
        .unwrap()
        .to_owned();
    manager.close(&ids[0]);
    assert_eq!(manager.status().session_count, 7);
    let raw = format!("POST /mcp/{} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{{}}", ids[0], host);
    send(host.clone(), raw).await.assert_status(404);
    manager.shutdown();
    tokio::task::yield_now().await;
    assert!(!manager.status().listening);
    assert_eq!(manager.status().session_count, 0);
    assert!(TcpStream::connect(host).is_err());
    let (sender, _) = mpsc::channel();
    assert!(manager
        .open("plugin.new".into(), "Test".into(), Arc::new(sender))
        .is_err());
}

#[tokio::test]
async fn sixteen_connections_and_header_timeout() {
    let f = Fixture::new(None).await;
    let mut sockets = Vec::new();
    for _ in 0..16 {
        sockets.push(tokio::net::TcpStream::connect(&f.host).await.unwrap());
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    use tokio::io::AsyncReadExt;
    let mut extra = tokio::net::TcpStream::connect(&f.host).await.unwrap();
    let mut byte = [0];
    let refused = tokio::time::timeout(Duration::from_secs(1), extra.read(&mut byte))
        .await
        .unwrap();
    assert!(
        matches!(refused, Ok(0))
            || refused.is_err_and(|e| e.kind() == std::io::ErrorKind::ConnectionReset)
    );
    // No response, and no lingering socket, after the production ten-second header deadline.
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(11), sockets[0].read(&mut byte))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    drop(sockets);
    f.initialize().await.assert_status(200);
}

#[test]
fn commands_have_generated_permissions_and_main_only_capability() {
    let capability: Value =
        serde_json::from_str(include_str!("../../capabilities/assistant-mcp.json")).unwrap();
    assert_eq!(capability["windows"], json!(["main"]));
    assert!(capability.get("webviews").is_none());
    let source = include_str!("../lib.rs");
    let handler = source
        .split_once("generate_handler![")
        .unwrap()
        .1
        .split(']')
        .next()
        .unwrap();
    let build = include_str!("../../build.rs");
    for command in [
        "assistant_mcp_session_open",
        "assistant_mcp_session_close",
        "assistant_mcp_respond",
        "assistant_mcp_status",
    ] {
        assert!(handler.contains(&format!("assistant_mcp::{command},")));
        assert!(build.contains(&format!("\"{command}\"")));
        let permission = format!("allow-{}", command.replace('_', "-"));
        assert!(capability["permissions"]
            .as_array()
            .unwrap()
            .contains(&json!(permission)));
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("permissions/autogenerated")
            .join(format!("{command}.toml"));
        assert!(std::fs::read_to_string(path)
            .unwrap()
            .contains(&format!("commands.allow = [\"{command}\"]")));
    }
    assert!(!handler.contains("session_credentials"));
}

#[tokio::test]
async fn idle_body_is_bounded_and_responses_close_connections() {
    assert_eq!(super::server::HEADER_TIMEOUT, Duration::from_secs(10));
    assert_eq!(super::server::IDLE_TIMEOUT, Duration::from_secs(60));
    // Exercise the same timer over a socket, without making CI wait a minute.
    let f = Fixture::new(Some(Duration::from_millis(200))).await;
    let mut socket = tokio::net::TcpStream::connect(&f.host).await.unwrap();
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let raw = f
        .raw("POST", "", "{")
        .replace("Content-Length: 1", "Content-Length: 100");
    socket.write_all(raw.as_bytes()).await.unwrap();
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(2), socket.read_to_end(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    let response = String::from_utf8(bytes).unwrap().to_ascii_lowercase();
    assert!(response.starts_with("http/1.1 400"));
    assert!(response.contains("connection: close"));
    assert!(!response.contains("access-control-"));
}
