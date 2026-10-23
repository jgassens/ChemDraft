use super::{
    protocol::{self, McpBridgeRequest, McpBridgeResponse},
    session::{Pending, Session, SessionManager},
};
use bytes::Bytes;
use http::{Request, Response, StatusCode};
use http_body_util::{BodyExt, Full, Limited};
use hyper::{body::Incoming, server::conn::http1, service::service_fn};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use std::{
    convert::Infallible,
    future::Future,
    io,
    pin::Pin,
    sync::{atomic::Ordering, Arc, Weak},
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf},
    net::{TcpListener, TcpStream},
    sync::{oneshot, watch, Semaphore},
    time::timeout,
};

const HEADER_LIMIT: usize = 16 * 1024;
pub(super) const HEADER_TIMEOUT: Duration = Duration::from_secs(10);
pub(super) const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

type Reply = Response<Full<Bytes>>;

pub(super) async fn listen(
    listener: TcpListener,
    manager: Weak<SessionManager>,
    mut stop: watch::Receiver<bool>,
) {
    let connections = Arc::new(Semaphore::new(16));
    let port = match listener.local_addr() {
        Ok(a) => a.port(),
        Err(_) => return,
    };
    loop {
        tokio::select! {
            _ = stop.changed() => break,
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { break };
                let Ok(permit) = connections.clone().try_acquire_owned() else { drop(stream); continue };
                let manager = manager.clone();
                let stop = stop.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    connection(stream, port, manager, stop).await;
                });
            }
        }
    }
}

/// Retain the bounded header read for hyper, without a second HTTP parser or unbounded buffering.
struct Prefixed {
    prefix: io::Cursor<Vec<u8>>,
    stream: TcpStream,
    write_idle: Option<Pin<Box<tokio::time::Sleep>>>,
    idle_timeout: Duration,
}
impl AsyncRead for Prefixed {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let pos = self.prefix.position() as usize;
        if pos < self.prefix.get_ref().len() {
            let n = buf.remaining().min(self.prefix.get_ref().len() - pos);
            buf.put_slice(&self.prefix.get_ref()[pos..pos + n]);
            self.prefix.set_position((pos + n) as u64);
            Poll::Ready(Ok(()))
        } else {
            Pin::new(&mut self.stream).poll_read(cx, buf)
        }
    }
}
impl AsyncWrite for Prefixed {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match Pin::new(&mut self.stream).poll_write(cx, buf) {
            Poll::Ready(result) => {
                self.write_idle = None;
                Poll::Ready(result)
            }
            Poll::Pending => {
                let idle_timeout = self.idle_timeout;
                if self
                    .write_idle
                    .get_or_insert_with(|| Box::pin(tokio::time::sleep(idle_timeout)))
                    .as_mut()
                    .poll(cx)
                    .is_ready()
                {
                    Poll::Ready(Err(io::ErrorKind::TimedOut.into()))
                } else {
                    Poll::Pending
                }
            }
        }
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}

async fn connection(
    mut stream: TcpStream,
    port: u16,
    manager: Weak<SessionManager>,
    mut stop: watch::Receiver<bool>,
) {
    let timeout_override = manager.upgrade().and_then(|m| m.timeout_override);
    let mut header = Vec::new();
    let read = async {
        loop {
            let byte = stream.read_u8().await?;
            header.push(byte);
            if header.ends_with(b"\r\n\r\n") {
                return Ok::<_, io::Error>(true);
            }
            if header.len() >= HEADER_LIMIT {
                return Ok(false);
            }
        }
    };
    let read = tokio::select! {
        _ = stop.changed() => return,
        result = timeout(timeout_override.unwrap_or(HEADER_TIMEOUT), read) => result,
    };
    match read {
        Ok(Ok(true)) => {}
        Ok(Ok(false)) => {
            let _ = stream.write_all(b"HTTP/1.1 431 Request Header Fields Too Large\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            let _ = stream.shutdown().await;
            // Drain briefly so Windows does not reset the connection with the reply still queued.
            let _ = timeout(
                Duration::from_millis(200),
                tokio::io::copy(&mut stream, &mut tokio::io::sink()),
            )
            .await;
            return;
        }
        _ => return,
    }
    let io = TokioIo::new(Prefixed {
        prefix: io::Cursor::new(header),
        stream,
        write_idle: None,
        idle_timeout: timeout_override.unwrap_or(IDLE_TIMEOUT),
    });
    let service = service_fn(move |request| {
        let manager = manager.clone();
        async move { Ok::<_, Infallible>(handle(request, port, manager).await) }
    });
    // A response closes its connection. This also bounds idle connections and avoids an SSE stream.
    let _ = http1::Builder::new()
        .keep_alive(false)
        .max_buf_size(HEADER_LIMIT)
        .serve_connection(io, service)
        .await;
}

fn reply(status: StatusCode, value: Option<Value>) -> Reply {
    let bytes = value
        .map(|v| serde_json::to_vec(&v).expect("JSON value"))
        .unwrap_or_default();
    Response::builder()
        .status(status)
        .header("Content-Type", "application/json")
        .header("Connection", "close")
        .body(Full::new(Bytes::from(bytes)))
        .unwrap()
}
fn rpc(value: Value) -> Reply {
    reply(StatusCode::OK, Some(value))
}
fn header<'a>(request: &'a Request<Incoming>, name: &str) -> Option<&'a str> {
    if request.headers().get_all(name).iter().count() != 1 {
        return None;
    }
    request.headers().get(name)?.to_str().ok()
}

fn valid_origin(origin: &str) -> bool {
    if origin == "null" {
        return true;
    }
    let Some(authority) = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
    else {
        return false;
    };
    if authority.contains(['/', '?', '#', '@']) {
        return false;
    }
    let (host, rest) = if let Some(ipv6) = authority.strip_prefix('[') {
        let Some((host, rest)) = ipv6.split_once(']') else {
            return false;
        };
        if !host
            .parse::<std::net::Ipv6Addr>()
            .is_ok_and(|ip| ip.is_loopback())
        {
            return false;
        }
        (host, rest)
    } else {
        authority
            .split_once(':')
            .map(|(host, _)| (host, &authority[host.len()..]))
            .unwrap_or((authority, ""))
    };
    let valid_port = rest.is_empty()
        || rest.strip_prefix(':').is_some_and(|port| {
            !port.is_empty()
                && port.bytes().all(|b| b.is_ascii_digit())
                && port.parse::<u16>().is_ok()
        });
    valid_port
        && (host.eq_ignore_ascii_case("localhost")
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback()))
}

async fn handle(request: Request<Incoming>, port: u16, manager: Weak<SessionManager>) -> Reply {
    if request.method() != http::Method::POST {
        let mut response = reply(StatusCode::METHOD_NOT_ALLOWED, None);
        response
            .headers_mut()
            .insert("allow", http::HeaderValue::from_static("POST"));
        return response;
    }
    if header(&request, "host") != Some(format!("127.0.0.1:{port}").as_str())
        || request
            .uri()
            .authority()
            .is_some_and(|a| a.as_str() != format!("127.0.0.1:{port}"))
        || (request.headers().contains_key("origin")
            && !header(&request, "origin").is_some_and(valid_origin))
    {
        return reply(StatusCode::FORBIDDEN, None);
    }
    let Some(manager) = manager.upgrade() else {
        return reply(StatusCode::NOT_FOUND, None);
    };
    let Some(session) = request
        .uri()
        .path()
        .strip_prefix("/mcp/")
        .filter(|_| request.uri().query().is_none())
        .and_then(|id| manager.lookup(id))
    else {
        return reply(StatusCode::NOT_FOUND, None);
    };
    let token = header(&request, "authorization")
        .and_then(|h| h.strip_prefix("Bearer "))
        .unwrap_or("");
    if !session.authorized(token.as_bytes()) {
        let mut response = reply(StatusCode::UNAUTHORIZED, None);
        response
            .headers_mut()
            .insert("www-authenticate", http::HeaderValue::from_static("Bearer"));
        return response;
    }
    if request.headers().contains_key("mcp-protocol-version")
        && !header(&request, "mcp-protocol-version")
            .is_some_and(|v| protocol::VERSIONS.contains(&v))
    {
        return reply(StatusCode::BAD_REQUEST, None);
    }
    if !header(&request, "content-type").is_some_and(|v| {
        v.split(';')
            .next()
            .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/json"))
    }) {
        return reply(StatusCode::UNSUPPORTED_MEDIA_TYPE, None);
    }
    if header(&request, "content-length")
        .and_then(|v| v.parse::<u64>().ok())
        .is_some_and(|n| n > protocol::BODY_LIMIT as u64)
    {
        return reply(StatusCode::PAYLOAD_TOO_LARGE, None);
    }
    let supplied_session = header(&request, "mcp-session-id").map(str::to_owned);
    let body = match timeout(
        manager.timeout_override.unwrap_or(IDLE_TIMEOUT),
        Limited::new(request.into_body(), protocol::BODY_LIMIT).collect(),
    )
    .await
    {
        Ok(Ok(body)) => body.to_bytes(),
        Ok(Err(error)) if error.is::<http_body_util::LengthLimitError>() => {
            return reply(StatusCode::PAYLOAD_TOO_LARGE, None)
        }
        _ => return reply(StatusCode::BAD_REQUEST, None),
    };
    let value: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return rpc(protocol::error(Value::Null, -32700, "Parse error")),
    };
    let id = value.get("id").cloned().unwrap_or(Value::Null);
    if !value.is_object()
        || value.get("jsonrpc") != Some(&json!("2.0"))
        || !value.get("method").is_some_and(Value::is_string)
        || value
            .get("id")
            .is_some_and(|v| !v.is_string() && !v.is_i64() && !v.is_u64() && !v.is_null())
        || value
            .get("params")
            .is_some_and(|v| !v.is_object() && !v.is_array())
    {
        return rpc(protocol::error(Value::Null, -32600, "Invalid Request"));
    }
    let method = value["method"].as_str().unwrap();
    let params = value.get("params").cloned().unwrap_or(json!({}));
    if (method != "initialize"
        || session.initialized.load(Ordering::SeqCst)
        || supplied_session.is_some())
        && supplied_session.as_deref() != Some(session.id.as_str())
    {
        return reply(StatusCode::NOT_FOUND, None);
    }
    if value.get("id").is_none() {
        if method == "notifications/cancelled" {
            if let Some(cancelled) = params.get("requestId") {
                let pending_id = session
                    .pending
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|(_, p)| &p.rpc_id == cancelled)
                    .map(|(id, _)| id.clone());
                if let Some(request_id) = pending_id {
                    if session
                        .sink
                        .send(McpBridgeRequest {
                            session_id: session.id.clone(),
                            request_id: request_id.clone(),
                            method: "cancel".into(),
                            params,
                        })
                        .is_err()
                    {
                        manager.close(&session.id);
                    }
                    if let Some(pending) = session.pending.lock().unwrap().remove(&request_id) {
                        let _ = pending
                            .answer
                            .send(Err("ChemDraft request cancelled".into()));
                    }
                }
            }
        }
        return reply(StatusCode::ACCEPTED, None);
    }
    match method {
        "initialize" => {
            session.initialized.store(true, Ordering::SeqCst);
            let mut response = rpc(protocol::result(id, protocol::initialize(&params)));
            response
                .headers_mut()
                .insert("mcp-session-id", session.id.parse().unwrap());
            response
        }
        "ping" => rpc(protocol::result(id, json!({}))),
        "tools/list" | "tools/call" => forward(manager, session, id, method, params).await,
        _ => rpc(protocol::error(id, -32601, "Method not found")),
    }
}

struct PendingGuard {
    session: Arc<Session>,
    request_id: String,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        let pending = self
            .session
            .pending
            .lock()
            .unwrap()
            .remove(&self.request_id);
        if pending.is_some() {
            // A timed-out/disconnected caller must not leave a document edit running in the host.
            let _ = self.session.sink.send(McpBridgeRequest {
                session_id: self.session.id.clone(),
                request_id: self.request_id.clone(),
                method: "cancel".into(),
                params: json!({"reason":"MCP caller disconnected or timed out"}),
            });
        }
    }
}

async fn forward(
    manager: Arc<SessionManager>,
    session: Arc<Session>,
    id: Value,
    method: &str,
    params: Value,
) -> Reply {
    let Ok(_permit) = session.permits.clone().try_acquire_owned() else {
        return rpc(protocol::error(id, -32000, "busy"));
    };
    let request_id = session.next_id();
    let (answer, receiver) = oneshot::channel();
    {
        let mut pending = session.pending.lock().unwrap();
        if session.closed.load(Ordering::SeqCst) {
            return rpc(protocol::error(id, -32000, "ChemDraft session closed"));
        }
        pending.insert(
            request_id.clone(),
            Pending {
                rpc_id: id.clone(),
                answer,
            },
        );
    }
    let _guard = PendingGuard {
        session: session.clone(),
        request_id: request_id.clone(),
    };
    let deadline = manager
        .timeout_override
        .unwrap_or_else(|| protocol::deadline(method, &params));
    if session
        .sink
        .send(McpBridgeRequest {
            session_id: session.id.clone(),
            request_id,
            method: method.into(),
            params,
        })
        .is_err()
    {
        manager.close(&session.id);
    }
    let value = match timeout(deadline, receiver).await {
        Ok(Ok(Ok(McpBridgeResponse::Result { result }))) => protocol::result(id, result),
        Ok(Ok(Ok(McpBridgeResponse::Error { error }))) => {
            json!({"jsonrpc":"2.0","id":id,"error":error})
        }
        Ok(Ok(Err(error))) => protocol::error(id, -32000, &error),
        Ok(Err(_)) => protocol::error(id, -32000, "ChemDraft session closed"),
        Err(_) => protocol::error(id, -32000, "ChemDraft did not answer in time"),
    };
    if serde_json::to_vec(&value).unwrap().len() > protocol::RESULT_LIMIT {
        rpc(protocol::error(
            value["id"].clone(),
            -32000,
            "MCP result exceeds 8 MiB",
        ))
    } else {
        rpc(value)
    }
}
