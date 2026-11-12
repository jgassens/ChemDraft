use super::*;
use serde_json::json;
use std::sync::Arc;

fn capture() -> (Channel<Delivery>, Arc<Mutex<Vec<Value>>>) {
    let deliveries = Arc::new(Mutex::new(Vec::new()));
    let captured = deliveries.clone();
    let channel = Channel::new(move |body| {
        let tauri::ipc::InvokeResponseBody::Json(text) = body else {
            panic!("broker deliveries must be JSON");
        };
        assert!(
            text.len() <= CHANNEL_BYTES,
            "must avoid the shared fetch queue"
        );
        captured
            .lock()
            .unwrap()
            .push(serde_json::from_str(&text).unwrap());
        Ok(())
    });
    (channel, deliveries)
}

fn chunks(bytes: &[u8]) -> Vec<Chunk> {
    bytes
        .chunks(CHUNK_BYTES)
        .enumerate()
        .map(|(index, data)| Chunk {
            transfer_id: "transfer-1".into(),
            index,
            total: bytes.len().div_ceil(CHUNK_BYTES),
            bytes: bytes.len(),
            data: STANDARD.encode(data),
        })
        .collect()
}

fn message_chunks(message: Value) -> Vec<Chunk> {
    chunks(&serde_json::to_vec(&message).unwrap())
}

fn ready_documents() -> DocumentWindowRegistry {
    let documents = DocumentWindowRegistry::with_main();
    documents.set_ready("main");
    documents.register("doc-b", "doc-b").unwrap();
    documents.set_ready("doc-b");
    documents
}

fn connect(broker: &mut Broker, documents: &DocumentWindowRegistry, label: &str) -> String {
    broker
        .connect(documents, label, label, capture().0)
        .unwrap()
}

#[test]
fn native_disconnect_notifies_the_host_even_after_closing_membership_pruned_the_peer() {
    let documents = ready_documents();
    let mut broker = Broker::default();
    let (channel, received) = capture();
    let host_connection = broker.connect(&documents, HOST, HOST, channel).unwrap();
    connect(&mut broker, &documents, "main");
    let second = connect(&mut broker, &documents, "doc-b");
    documents.begin_closing("main");
    broker.prune(&documents);
    assert!(received.lock().unwrap().is_empty());
    broker.forget("main");
    assert!(broker.check_connection("doc-b", &second).is_ok());
    let received = received.lock().unwrap();
    assert_eq!(received.len(), 1);
    assert_eq!(received[0]["sender"], "main");
    assert_eq!(received[0]["connection"], host_connection);
    let bytes = STANDARD
        .decode(received[0]["chunk"]["data"].as_str().unwrap())
        .unwrap();
    let message: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(message["method"], "runtimeDocumentClosed");
    assert_eq!(message["payload"], json!({}));
    assert!(authorize_message("main", HOST, &bytes).is_ok());
}

#[test]
fn hidden_builder_flags_and_registry_exclusion_are_shared_on_both_platforms() {
    let config = runtime_window_config();
    assert_eq!(config.label, "runtime");
    assert_eq!(
        config.url,
        tauri::WebviewUrl::App("/?window=runtime".into())
    );
    assert!(!config.focus);
    assert!(!config.focusable);
    assert!(!config.visible);
    assert!(config.skip_taskbar);
    assert!(config.parent.is_none());
    let documents = ready_documents();
    documents.mark_activated("doc-b");
    assert!(documents.register(HOST, HOST).is_err());
    assert!(!documents.is_document_window(HOST));
    assert!(!documents.mark_activated(HOST));
    assert!(documents.owner_of(HOST).is_none());
    assert!(documents.registered_document_window(HOST).is_none());
    for command in ["edit.undo", "edit.redo", "edit.selectAll", "file.open"] {
        assert_eq!(
            crate::menu_command_target_label(&documents, command, Some(HOST)).as_deref(),
            Some("doc-b")
        );
        assert!(crate::menu_command_target_label(
            &DocumentWindowRegistry::default(),
            command,
            Some(HOST)
        )
        .is_none());
    }
    assert!(documents
        .all_document_windows()
        .iter()
        .all(|document| document.native_label != HOST));
    let source = include_str!("lib.rs");
    let install = source
        .split("fn install_app_menu<R: Runtime>")
        .nth(1)
        .unwrap()
        .split("fn reinstall_app_menu")
        .next()
        .unwrap();
    assert!(install.contains("#[cfg(target_os = \"macos\")]\n    app.set_menu(menu)?;"));
    assert!(install.contains("#[cfg(not(target_os = \"macos\"))]"));
    assert!(install.contains("active_document_webview(app)"));
    assert!(!install.contains("get_webview_window"));
    let runtime_source = include_str!("runtime_broker.rs");
    let builder = runtime_source
        .split("pub(crate) fn create_runtime_window")
        .nth(1)
        .unwrap();
    assert!(!builder.contains("cfg!(debug_assertions)"));
    assert!(!builder.contains("CHEMDRAFT_RUNTIME_HOST_WINDOW"));
    assert!(builder.contains("WebviewWindowBuilder::from_config(app, &runtime_window_config())"));
    assert!(!builder.contains(".set_menu("));
    assert!(!builder.contains(".register("));
    assert!(!builder.contains(".show("));
}

#[test]
fn caller_identity_membership_and_connection_checks_refuse_utilities_and_unknown_labels() {
    let documents = ready_documents();
    let mut broker = Broker::default();
    for label in [
        "toolset-core-main",
        "toolset-popover-core-main",
        "toolset-tooltip",
        "dialog-main-export-1",
        "plugin-panel-example",
        "preferences",
        "spin3d-debugger",
        "unknown",
        "doc-unknown",
        "runtime-other",
        "runtime\n",
        "doc-../main",
    ] {
        assert!(
            broker
                .connect(&documents, label, label, capture().0)
                .is_err(),
            "{label}"
        );
        assert!(
            broker
                .connect(&documents, label, HOST, capture().0)
                .is_err(),
            "{label}"
        );
        assert!(authorize_pair(&documents, HOST, label).is_err(), "{label}");
    }
    for (caller, claim) in [("main", HOST), (HOST, "main"), ("doc-b", "main")] {
        assert!(broker
            .connect(&documents, caller, claim, capture().0)
            .is_err());
    }
    documents.register("doc-creating", "doc-creating").unwrap();
    assert!(broker
        .connect(&documents, "doc-creating", "doc-creating", capture().0)
        .is_err());
    documents.register("alias", "doc-alias").unwrap();
    documents.set_ready("alias");
    assert!(broker
        .connect(&documents, "doc-alias", "doc-alias", capture().0)
        .is_err());
    let first = connect(&mut broker, &documents, "main");
    assert!(broker
        .connect(&documents, "main", "main", capture().0)
        .is_err());
    assert!(broker.check_connection("main", "forged").is_err());
    broker.forget("main");
    let second = connect(&mut broker, &documents, "main");
    assert_ne!(first, second);
    assert!(broker.check_connection("main", &first).is_err());
    documents.begin_closing("main");
    assert!(authorize_peer(&documents, "main").is_err());
    broker.prune(&documents);
    assert!(!broker.peers.contains_key("main"));
    documents.remove("doc-b");
    assert!(authorize_peer(&documents, "doc-b").is_err());
    assert!(authorize_pair(&documents, HOST, HOST).is_err());
    assert!(authorize_pair(&ready_documents(), "main", "doc-b").is_err());
}

#[test]
fn native_direction_validation_covers_every_method_and_captured_target() {
    for method in [
        "getContributions",
        "invokeCommand",
        "getDocument",
        "getSelection",
        "applyPatch",
        "undoOwnTransaction",
        "endInvocation",
    ] {
        let to_runtime = matches!(method, "getContributions" | "invokeCommand");
        let (sender, recipient) = if to_runtime {
            ("main", HOST)
        } else {
            (HOST, "main")
        };
        let reference = json!({"target":{"windowId":"main"}});
        let payload = match method {
            "getContributions" => json!({}),
            "invokeCommand" | "applyPatch" | "undoOwnTransaction" => {
                json!({"invocation":reference})
            }
            _ => reference,
        };
        let mut request =
            json!({"version":1,"kind":"request","id":"call","method":method,"payload":payload});
        let bytes = serde_json::to_vec(&request).unwrap();
        assert!(
            authorize_message(sender, recipient, &bytes).is_ok(),
            "{method}"
        );
        assert!(
            authorize_message(recipient, sender, &bytes).is_err(),
            "{method}"
        );
        if method != "getContributions" {
            if matches!(
                method,
                "invokeCommand" | "applyPatch" | "undoOwnTransaction"
            ) {
                request["payload"]["invocation"]["target"]["windowId"] = json!("doc-b");
            } else {
                request["payload"]["target"]["windowId"] = json!("doc-b");
            }
            assert!(
                authorize_message(sender, recipient, &serde_json::to_vec(&request).unwrap())
                    .is_err()
            );
        }
        for response in [
            json!({"version":1,"kind":"response","id":"call","method":method,"ok":true,"value":null}),
            json!({"version":1,"kind":"response","id":"call","method":method,"ok":true}),
            json!({"version":1,"kind":"response","id":"call","method":method,"ok":false,"error":"refused"}),
        ] {
            let bytes = serde_json::to_vec(&response).unwrap();
            assert!(authorize_message(recipient, sender, &bytes).is_ok());
            assert!(authorize_message(sender, recipient, &bytes).is_err());
        }
    }
    for message in [
        json!({"version":2,"kind":"request","id":"x","method":"getContributions","payload":{}}),
        json!({"version":1,"kind":"request","id":"x","method":"native.execute","payload":{}}),
        json!({"version":1,"kind":"request","id":"x","method":"getContributions","payload":{},"extra":1}),
        json!({"version":1,"kind":"response","id":"x","method":"getDocument","ok":false,"error":"x".repeat(4001)}),
    ] {
        assert!(authorize_message("main", HOST, &serde_json::to_vec(&message).unwrap()).is_err());
    }
    let contributions =
        serde_json::to_vec(&json!({"version":1,"kind":"contributions","payload":{}})).unwrap();
    assert!(authorize_message(HOST, "main", &contributions).is_ok());
    assert!(authorize_message("main", HOST, &contributions).is_err());
    assert!(authorize_message(HOST, "main", b"not JSON").is_err());
}

#[test]
fn reassembles_the_exact_ceiling_and_delivers_only_small_authenticated_chunks() {
    let documents = ready_documents();
    let mut broker = Broker::default();
    let (channel, received) = capture();
    broker.connect(&documents, HOST, HOST, channel).unwrap();
    let connection = connect(&mut broker, &documents, "main");
    let prefix =
        br#"{"version":1,"kind":"response","id":"call","method":"getDocument","ok":true,"value":""#;
    let mut bytes = prefix.to_vec();
    bytes.resize(MAX_BYTES - 2, b'x');
    bytes.extend_from_slice(b"\"}");
    assert_eq!(bytes.len(), MAX_BYTES);
    for chunk in chunks(&bytes) {
        broker
            .push(&documents, "main", "main", &connection, HOST, chunk)
            .unwrap();
    }
    assert!(broker.partials.is_empty());
    let received = received.lock().unwrap();
    assert_eq!(received.len(), MAX_CHUNKS);
    let reconstructed: Vec<u8> = received
        .iter()
        .flat_map(|delivery| {
            assert_eq!(delivery["sender"], "main");
            STANDARD
                .decode(delivery["chunk"]["data"].as_str().unwrap())
                .unwrap()
        })
        .collect();
    assert_eq!(reconstructed, bytes);
}

#[test]
fn private_delivery_waits_for_completion_and_rechecks_the_live_caller() {
    let documents = ready_documents();
    let mut broker = Broker::default();
    let (channel, received) = capture();
    broker.connect(&documents, HOST, HOST, channel).unwrap();
    let main = connect(&mut broker, &documents, "main");
    let other = connect(&mut broker, &documents, "doc-b");
    let parts = message_chunks(json!({"version":1,"kind":"response","id":"call",
        "method":"getDocument","ok":true,"value":"x".repeat(5000)}));
    broker
        .push(&documents, "main", "main", &main, HOST, parts[0].clone())
        .unwrap();
    assert!(received.lock().unwrap().is_empty());
    documents.begin_closing("main");
    assert!(broker
        .push(&documents, "main", "main", &main, HOST, parts[1].clone())
        .is_err());
    assert!(received.lock().unwrap().is_empty());
    assert!(!broker.partials.contains_key("main"));
    for (caller, claimed, connection) in [
        ("toolset-core-main", "doc-b", other.as_str()),
        ("doc-b", "runtime", other.as_str()),
        ("doc-b", "doc-b", main.as_str()),
    ] {
        assert!(broker
            .push(
                &documents,
                caller,
                claimed,
                connection,
                HOST,
                parts[0].clone()
            )
            .is_err());
    }
    for part in parts {
        broker
            .push(&documents, "doc-b", "doc-b", &other, HOST, part)
            .unwrap();
    }
    assert!(received
        .lock()
        .unwrap()
        .iter()
        .all(|delivery| delivery["sender"] == "doc-b"));
    assert_eq!(received.lock().unwrap().len(), 2);
}

#[test]
fn rejected_claims_and_stale_connections_preserve_a_live_callers_partial() {
    let documents = ready_documents();
    let mut broker = Broker::default();
    let (channel, received) = capture();
    broker.connect(&documents, HOST, HOST, channel).unwrap();
    let main = connect(&mut broker, &documents, "main");
    let parts = message_chunks(json!({"version":1,"kind":"response","id":"call",
        "method":"getDocument","ok":true,"value":"x".repeat(5000)}));
    broker
        .push(&documents, "main", "main", &main, HOST, parts[0].clone())
        .unwrap();
    for (caller, claimed, connection) in [
        ("toolset-core-main", "main", main.as_str()),
        ("main", "doc-b", main.as_str()),
        ("main", "main", "stale"),
    ] {
        assert!(broker
            .push(
                &documents,
                caller,
                claimed,
                connection,
                HOST,
                parts[1].clone()
            )
            .is_err());
        assert!(broker.partials.contains_key("main"));
        assert!(received.lock().unwrap().is_empty());
    }
    broker
        .push(&documents, "main", "main", &main, HOST, parts[1].clone())
        .unwrap();
    assert!(broker.partials.is_empty());
    assert_eq!(received.lock().unwrap().len(), 2);
}

#[test]
fn chunk_limits_order_replay_and_budget_are_enforced_before_delivery() {
    let documents = ready_documents();
    let mut broker = Broker::default();
    let (channel, received) = capture();
    broker.connect(&documents, HOST, HOST, channel).unwrap();
    let connection = connect(&mut broker, &documents, "main");
    let valid = message_chunks(
        json!({"version":1,"kind":"request","id":"x","method":"getContributions","payload":{}}),
    )
    .remove(0);
    let mut invalid = Vec::new();
    let mut c = valid.clone();
    c.bytes = MAX_BYTES + 1;
    invalid.push(c);
    let mut c = valid.clone();
    c.bytes = 0;
    invalid.push(c);
    let mut c = valid.clone();
    c.total = MAX_CHUNKS + 1;
    invalid.push(c);
    let mut c = valid.clone();
    c.total = 0;
    invalid.push(c);
    let mut c = valid.clone();
    c.index = 1;
    invalid.push(c);
    let mut c = valid.clone();
    c.data = "!".into();
    invalid.push(c);
    let mut c = valid.clone();
    c.data = "x".repeat(CHUNK_BYTES * 2);
    invalid.push(c);
    let mut c = valid.clone();
    c.transfer_id = "x".repeat(65);
    invalid.push(c);
    let mut c = valid.clone();
    c.bytes += 1;
    invalid.push(c);
    for chunk in invalid {
        assert!(broker
            .push(&documents, "main", "main", &connection, HOST, chunk)
            .is_err());
        assert!(broker.partials.is_empty());
    }
    let first = Chunk {
        transfer_id: "large".into(),
        index: 0,
        total: MAX_CHUNKS,
        bytes: MAX_BYTES,
        data: STANDARD.encode(vec![b'x'; CHUNK_BYTES]),
    };
    broker
        .push(&documents, "main", "main", &connection, HOST, first.clone())
        .unwrap();
    assert!(broker
        .push(&documents, "main", "main", &connection, HOST, first.clone())
        .is_err());
    assert!(broker.partials.is_empty());
    broker
        .push(&documents, "main", "main", &connection, HOST, first.clone())
        .unwrap();
    let mut changed = first.clone();
    changed.index = 1;
    changed.transfer_id = "changed".into();
    assert!(broker
        .push(&documents, "main", "main", &connection, HOST, changed)
        .is_err());
    broker
        .push(&documents, "main", "main", &connection, HOST, first.clone())
        .unwrap();
    let other = connect(&mut broker, &documents, "doc-b");
    broker
        .push(&documents, "doc-b", "doc-b", &other, HOST, first.clone())
        .unwrap();
    documents.register("doc-c", "doc-c").unwrap();
    documents.set_ready("doc-c");
    let third = connect(&mut broker, &documents, "doc-c");
    assert!(broker
        .push(&documents, "doc-c", "doc-c", &third, HOST, first.clone())
        .is_err());
    broker.partials.get_mut("main").unwrap().started = Instant::now() - TRANSFER_TTL;
    broker.prune(&documents);
    assert!(!broker.partials.contains_key("main"));
    broker.forget(HOST);
    assert!(broker.partials.is_empty());
    assert!(received.lock().unwrap().is_empty());
}

#[test]
fn transfer_and_peer_count_limits_and_disconnected_recipients_are_enforced() {
    let documents = ready_documents();
    let mut broker = Broker::default();
    connect(&mut broker, &documents, HOST);
    let mut connections = Vec::new();
    for index in 0..MAX_PEERS {
        let label = format!("doc-{index}");
        documents.register(&label, &label).unwrap();
        documents.set_ready(&label);
        let result = broker.connect(&documents, &label, &label, capture().0);
        if index + 1 < MAX_PEERS {
            connections.push((label, result.unwrap()));
        } else {
            assert!(result.is_err());
        }
    }
    let first = Chunk {
        transfer_id: "small".into(),
        index: 0,
        total: 2,
        bytes: CHUNK_BYTES + 1,
        data: STANDARD.encode(vec![b'x'; CHUNK_BYTES]),
    };
    for (index, (label, connection)) in connections.iter().take(MAX_TRANSFERS + 1).enumerate() {
        let result = broker.push(&documents, label, label, connection, HOST, first.clone());
        assert_eq!(result.is_ok(), index < MAX_TRANSFERS);
    }
    let (label, connection) = &connections[0];
    broker.forget(HOST);
    connect(&mut broker, &documents, HOST);
    let last = Chunk {
        index: 1,
        data: STANDARD.encode(b"x"),
        ..first
    };
    assert!(broker
        .push(&documents, label, label, connection, HOST, last)
        .is_err());
    assert!(broker.partials.is_empty());
}

#[test]
fn minimal_transport_capability_has_no_utility_event_or_native_privileges() {
    let grant: Value =
        serde_json::from_str(include_str!("../capabilities/runtime-broker.json")).unwrap();
    assert_eq!(grant["windows"], json!(["runtime", "main", "doc-*"]));
    assert_eq!(
        grant["permissions"],
        json!([
            "allow-runtime-broker-connect",
            "allow-runtime-broker-send",
            "allow-runtime-broker-disconnect"
        ])
    );
    let lib = include_str!("lib.rs");
    let handler = lib
        .split("generate_handler![")
        .nth(1)
        .unwrap()
        .split(']')
        .next()
        .unwrap();
    for (command, permission) in [
        (
            "runtime_broker_connect",
            include_str!("../permissions/autogenerated/runtime_broker_connect.toml"),
        ),
        (
            "runtime_broker_send",
            include_str!("../permissions/autogenerated/runtime_broker_send.toml"),
        ),
        (
            "runtime_broker_disconnect",
            include_str!("../permissions/autogenerated/runtime_broker_disconnect.toml"),
        ),
    ] {
        assert!(handler.contains(&format!("runtime_broker::{command},")));
        assert!(include_str!("../build.rs").contains(&format!("\"{command}\"")));
        assert!(permission.contains(&format!("commands.allow = [\"{command}\"]")));
    }
}

#[test]
fn cutover_adapter_directions_and_nested_targets_remain_authenticated() {
    for (method, to_runtime, shape) in [
        ("initializeRuntime", true, "empty"),
        ("getRuntimeView", true, "empty"),
        ("runtimeViewAction", true, "data"),
        ("acceptPreparedProposal", true, "root"),
        ("setDocumentMetadata", true, "root"),
        ("setCoreCommands", true, "data"),
        ("prepareAssistantWrite", true, "session"),
        ("runtimeDialogAction", true, "root"),
        ("getViewportRect", false, "root"),
        ("captureDocumentTarget", false, "window"),
        ("invokeDocumentPlugin", false, "root"),
        ("runtimeDialogRequest", false, "root"),
        ("assistantBegin", false, "invocation"),
        ("assistantOpenInvocation", false, "session"),
        ("assistantRead", false, "root"),
        ("assistantWrite", false, "session"),
        ("cancelAssistantWrite", false, "session"),
        ("assistantConsent", false, "session"),
        ("cancelAssistantConsent", false, "session"),
        ("assistantEnd", false, "session"),
        ("assistantUndo", false, "root"),
        ("commitProposal", false, "root"),
        ("retireProposalCommits", false, "data"),
        ("getCoreCommands", false, "empty"),
        ("getCoreCommand", false, "data"),
        ("invokeCoreCommand", false, "data"),
        ("chooseRuntimeFile", false, "data"),
    ] {
        let (sender, recipient) = if to_runtime {
            ("main", HOST)
        } else {
            (HOST, "main")
        };
        let target = json!({"target":{"windowId":"main"}});
        let payload = match shape {
            "empty" | "data" => json!({}),
            "window" => json!({"windowId":"main"}),
            "session" => json!({"session":target}),
            "invocation" => json!({"invocation":target}),
            _ => target,
        };
        let mut request =
            json!({"version":1,"kind":"request","id":"call","method":method,"payload":payload});
        let bytes = serde_json::to_vec(&request).unwrap();
        assert!(
            authorize_message(sender, recipient, &bytes).is_ok(),
            "{method}"
        );
        assert!(
            authorize_message(recipient, sender, &bytes).is_err(),
            "{method}"
        );
        let pointer = match shape {
            "window" => Some("/payload/windowId"),
            "session" => Some("/payload/session/target/windowId"),
            "invocation" => Some("/payload/invocation/target/windowId"),
            "root" => Some("/payload/target/windowId"),
            _ => None,
        };
        if let Some(pointer) = pointer {
            *request.pointer_mut(pointer).unwrap() = json!("doc-b");
            assert!(
                authorize_message(sender, recipient, &serde_json::to_vec(&request).unwrap())
                    .is_err(),
                "{method}"
            );
        }
        let response = serde_json::to_vec(&json!({"version":1,"kind":"response","id":"call","method":method,"ok":true,"value":null})).unwrap();
        assert!(
            authorize_message(recipient, sender, &response).is_ok(),
            "{method}"
        );
        assert!(
            authorize_message(sender, recipient, &response).is_err(),
            "{method}"
        );
    }
    let view =
        serde_json::to_vec(&json!({"version":1,"kind":"runtimeView","topic":"state","payload":{}}))
            .unwrap();
    assert!(authorize_message(HOST, "main", &view).is_ok());
    assert!(authorize_message("main", HOST, &view).is_err());
}
