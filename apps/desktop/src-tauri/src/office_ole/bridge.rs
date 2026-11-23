//! The embedded editor connects from its own webview. It receives the selection and a
//! window-local close channel. Updates use a raw frame: little-endian u32 JSON byte length,
//! UTF-8 selection JSON, then the carrier PNG.

use serde::Serialize;
use tauri::ipc::{Channel, Request};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Open {
    pub object_id: String,
    pub json: String,
    pub container_app: String,
    pub container_document: String,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloseRequest {
    pub request_id: Option<u32>,
    pub prompt: bool,
    pub unsaved: bool,
    pub discard: bool,
}

#[tauri::command]
pub(crate) async fn prepare_office_editors_for_update(
    window: tauri::WebviewWindow,
    release: bool,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        use tauri::Manager;
        if window.label() != crate::MAIN_WINDOW_LABEL {
            return Err("Only the main ChemDraft window can install updates".into());
        }
        let server = window.state::<super::server::Server>();
        if release {
            server.release_update();
        } else {
            server.prepare_update().await?;
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (window, release);
        Err("Windows app updates require Windows".into())
    }
}

#[cfg(any(windows, test))]
pub(crate) fn owner_id(label: &str) -> Result<&str, String> {
    label
        .strip_prefix("office-object-")
        .filter(|id| !id.is_empty() && id.len() <= 20 && id.bytes().all(|b| b.is_ascii_digit()))
        .ok_or_else(|| "This window does not own an Office object".into())
}

#[cfg(any(windows, test))]
fn update_lengths(body: usize, json: usize) -> Result<usize, String> {
    use super::{emf::MAX_PNG_BYTES, storage::MAX_DOCUMENT_BYTES};
    let max_body = 4 + MAX_DOCUMENT_BYTES + MAX_PNG_BYTES;
    if body > max_body {
        return Err("Office update exceeds the 50 MiB content limit".into());
    }
    if json > MAX_DOCUMENT_BYTES {
        return Err("ChemDraftDocument exceeds 25 MiB".into());
    }
    let end = 4 + json;
    match body.checked_sub(end) {
        Some(png) if png > MAX_PNG_BYTES => Err("Preview PNG exceeds 25 MiB".into()),
        Some(png) if json > 0 && png > 0 => Ok(end),
        _ => Err("Office update must contain selection JSON and a preview PNG".into()),
    }
}

#[tauri::command]
pub(crate) async fn office_object_connect(
    window: tauri::WebviewWindow,
    channel: Channel<CloseRequest>,
) -> Result<Open, String> {
    #[cfg(windows)]
    {
        use tauri::Manager;
        window
            .state::<super::server::Server>()
            .request(
                owner_id(window.label())?.into(),
                super::server::Action::Connect(channel),
            )
            .await?
            .ok_or_else(|| "Office editor did not receive its document".into())
    }
    #[cfg(not(windows))]
    {
        let _ = (window, channel);
        Err("Office embedded-object editing requires Windows".into())
    }
}

#[tauri::command]
pub(crate) fn office_object_set_title(
    window: tauri::WebviewWindow,
    title: String,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        owner_id(window.label())?;
        window.set_title(&title).map_err(|error| error.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (window, title);
        Err("Office embedded-object editing requires Windows".into())
    }
}

/// A renderer's answer to a Windows session-end request (`office-session-publish`).
#[cfg(any(windows, test))]
#[derive(Debug, PartialEq, Eq)]
enum SessionReply {
    /// The frame carries the editor's whole drawing.
    Drawing(u32),
    /// Office already holds everything this editor shows; the body is ignored.
    Unchanged(u32),
    /// The editor could not render or send its drawing; the body is ignored. The editor stays
    /// at risk with a recovery copy instead of being waited on.
    Failed(u32),
}

#[cfg(any(windows, test))]
const SESSION_PUBLISH_HEADER: &str = "x-chemdraft-session-publish";
#[cfg(any(windows, test))]
const SESSION_UNCHANGED_HEADER: &str = "x-chemdraft-session-unchanged";
#[cfg(any(windows, test))]
const SESSION_FAILED_HEADER: &str = "x-chemdraft-session-failed";

#[cfg(any(windows, test))]
fn session_reply(headers: &tauri::http::HeaderMap) -> Result<Option<SessionReply>, String> {
    let unchanged = headers.get(SESSION_UNCHANGED_HEADER);
    let failed = headers.get(SESSION_FAILED_HEADER);
    let Some(value) = headers.get(SESSION_PUBLISH_HEADER) else {
        return match (unchanged, failed) {
            (None, None) => Ok(None),
            (Some(_), _) => Err("An unchanged Office reply needs a session-end request".into()),
            (None, Some(_)) => Err("A failed Office reply needs a session-end request".into()),
        };
    };
    let request = value
        .to_str()
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or("Invalid Office session-end publish request")?;
    match (
        unchanged.map(|value| value.as_bytes()),
        failed.map(|value| value.as_bytes()),
    ) {
        (None, None) => Ok(Some(SessionReply::Drawing(request))),
        (Some(b"1"), None) => Ok(Some(SessionReply::Unchanged(request))),
        (None, Some(b"1")) => Ok(Some(SessionReply::Failed(request))),
        (Some(_), Some(_)) => {
            Err("An Office session-end reply cannot be both unchanged and failed".into())
        }
        (Some(_), None) => Err("Invalid Office session-end unchanged marker".into()),
        (None, Some(_)) => Err("Invalid Office session-end failure marker".into()),
    }
}

#[tauri::command]
pub(crate) async fn office_object_update(
    window: tauri::WebviewWindow,
    request: Request<'_>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        use tauri::{ipc::InvokeBody, Manager};
        let id = owner_id(window.label())?.to_owned();
        let server = window.state::<super::server::Server>();
        let session = match session_reply(request.headers())? {
            Some(SessionReply::Unchanged(publish)) => {
                if !server.session_unchanged(publish, &id) {
                    return Err("The Office session-end publish request has expired".into());
                }
                crate::windows_session_end::office_session_changed(window.app_handle());
                return Ok(());
            }
            Some(SessionReply::Failed(publish)) => {
                if !server.session_publish_failed(publish, &id) {
                    return Err("The Office session-end publish request has expired".into());
                }
                crate::windows_session_end::office_session_changed(window.app_handle());
                return Ok(());
            }
            Some(SessionReply::Drawing(publish)) => Some(publish),
            None => None,
        };
        let InvokeBody::Raw(bytes) = request.body() else {
            return Err("Office updates require a raw selection and PNG payload".into());
        };
        let header: [u8; 4] = bytes
            .get(..4)
            .ok_or("Office update header is missing")?
            .try_into()
            .map_err(|_| "Invalid Office update header")?;
        let json_end = update_lengths(bytes.len(), u32::from_le_bytes(header) as usize)?;
        if session.is_some_and(|publish| !server.accepting_session_publish(publish, &id)) {
            return Err("The Office session-end publish request has expired".into());
        }
        let permit = if session.is_none() {
            Some(server.begin_update(&id)?)
        } else {
            None
        };
        let mut bytes = bytes.clone();
        let (content, permit) = tauri::async_runtime::spawn_blocking(move || {
            let png = bytes.split_off(json_end);
            bytes.drain(..4);
            let json = String::from_utf8(bytes)
                .map_err(|_| "Invalid Office selection UTF-8".to_owned())?;
            let content =
                super::presentation::Content::load(json, Some(png)).map_err(|e| e.to_string())?;
            Ok::<_, String>((content, permit))
        })
        .await
        .map_err(|e| e.to_string())??;
        if let Some(publish) = session {
            return if server.publish_for_session(publish, &id, content) {
                crate::windows_session_end::office_session_changed(window.app_handle());
                Ok(())
            } else {
                Err("The Office session-end publish request has expired".into())
            };
        }
        server
            .request(
                id,
                super::server::Action::Update {
                    content,
                    _permit: permit.expect("interactive update has a permit"),
                },
            )
            .await
            .map(drop)
    }
    #[cfg(not(windows))]
    {
        let _ = (window, request);
        Err("Office embedded-object editing requires Windows".into())
    }
}

#[tauri::command]
pub(crate) async fn office_object_close(
    window: tauri::WebviewWindow,
    object_id: String,
    save_changes: Option<bool>,
    request_id: Option<u32>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        use tauri::Manager;
        if owner_id(window.label())? != object_id {
            return Err("This window does not own the Office object".into());
        }
        window
            .state::<super::server::Server>()
            .request(
                object_id,
                super::server::Action::Close {
                    save_changes,
                    request_id,
                },
            )
            .await
            .map(drop)
    }
    #[cfg(not(windows))]
    {
        let _ = (window, object_id, save_changes, request_id);
        Err("Office embedded-object editing requires Windows".into())
    }
}

/// The editor window's first frame: `--cd-bg-app` in App.css, handed to
/// `first_paint::hidden_until_first_paint` (the window layer and WebView2's default background).
#[cfg(any(windows, test))]
const EDITOR_BACKGROUND: (u8, u8, u8) = (0xd8, 0xde, 0xe3);

/// Shows the editor if the page has not reported its first paint by then, so Office's
/// activation never waits on the page: `open_window` answers DoVerb when the window is shown,
/// well inside its 10 s limit. On Windows the page reported its first paint 1.35 s after the
/// hidden window was built, too close to the earlier 1.5 s; 4 s leaves room and still answers
/// Office well within its limit.
#[cfg(any(windows, test))]
const REVEAL_FALLBACK: std::time::Duration = std::time::Duration::from_millis(4000);

/// Longest container name carried into the loading message; matches `officeObjectLoading.ts`.
#[cfg(any(windows, test))]
const MAX_CONTAINER_APP_CHARS: usize = 80;

/// `index.html?officeObject=<id>&officeApp=<name>`. The name only labels the pre-mount loading
/// message; the editor still takes the document and container names from `office_object_connect`.
#[cfg(any(windows, test))]
fn editor_url(id: &str, container_app: &str) -> String {
    let name: String = container_app
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_CONTAINER_APP_CHARS)
        .collect();
    let mut url = format!("index.html?officeObject={id}");
    if !name.is_empty() {
        url.push_str("&officeApp=");
        for byte in name.bytes() {
            if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
                url.push(byte as char);
            } else {
                url.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    url
}

#[cfg(windows)]
pub(super) fn open_window(
    app: &tauri::AppHandle,
    id: &str,
    title: String,
    container_app: String,
    was_open: bool,
    signals: std::sync::Arc<super::server::WindowSignals>,
) -> Result<(), String> {
    use tauri::{Listener, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
    let handle = app.clone();
    let id = id.to_owned();
    // A successful send means DoVerb actually received the result. A one-slot channel can
    // accept a result just after recv_timeout, leaving a window for an abandoned activation.
    let (opened, status) = std::sync::mpsc::sync_channel(0);
    app.run_on_main_thread(move || {
        if handle.state::<super::server::Server>().session_ending() {
            let _ = opened.send(Err("The Windows session is ending".into()));
            return;
        }
        let label = format!("office-object-{id}");
        if let Some(window) = handle.get_webview_window(&label) {
            // A first activation still waiting for its paint is answered before this one.
            crate::first_paint::show_after_first_paint(&window);
            let result = window
                .set_title(&title)
                .and_then(|_| window.unminimize())
                .and_then(|_| window.show())
                .and_then(|_| window.set_focus());
            let _ = opened.send(result.map_err(|e| e.to_string()));
            return;
        }
        if was_open {
            let _ = opened.send(Err(
                "The previous Office editor is closing. Activate the object again.".into(),
            ));
            return;
        }
        let dev_origin = handle
            .config()
            .build
            .dev_url
            .as_ref()
            .filter(|_| cfg!(debug_assertions))
            .map(|url| url.origin());
        let (red, green, blue) = EDITOR_BACKGROUND;
        let result = crate::first_paint::hidden_until_first_paint(
            WebviewWindowBuilder::new(
                &handle,
                &label,
                WebviewUrl::App(editor_url(&id, &container_app).into()),
            )
            .title(&title)
            .inner_size(900.0, 640.0)
            .on_navigation(move |url| {
                url.origin().ascii_serialization() == "http://tauri.localhost"
                    || dev_origin.as_ref() == Some(&url.origin())
            }),
            tauri::window::Color(red, green, blue, 0xff),
        )
        .build();
        let window = match result {
            Ok(window) => window,
            Err(error) => {
                let _ = opened.send(Err(format!("Could not open Office editor: {error}")));
                return;
            }
        };
        // Like every webview window: WebView2's own menus can leave input stuck after they are
        // dismissed (webview_context_menus.rs). The window is still hidden here.
        crate::disable_default_context_menus(&window);
        let app = handle.clone();
        let subscriptions = super::toolset_events::attach_settings(&window);
        let editor = window.clone();
        window.on_window_event(move |event| {
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    signals.request_close();
                }
                WindowEvent::Destroyed => {
                    for &subscription in &subscriptions {
                        app.unlisten(subscription);
                    }
                    signals.destroyed();
                }
                WindowEvent::Moved(_) => {
                    super::toolset_events::deliver(&editor, "tauri://move", "null");
                    return;
                }
                WindowEvent::Resized(_) => {
                    super::toolset_events::deliver(&editor, "tauri://resize", "null");
                    return;
                }
                WindowEvent::ScaleFactorChanged { .. } => {
                    super::toolset_events::deliver(&editor, "tauri://scale-change", "null");
                    return;
                }
                _ => return,
            }
            app.state::<super::server::Server>().wake();
        });
        match crate::install_office_document_menu(
            &window,
            &[],
            crate::ViewMenuState::default(),
            None,
        ) {
            // Stay hidden until index.html has painted its loading screen, so the
            // WebView2 surface is never seen before the page's first frame. The page
            // reports the paint (`window_first_paint`); the timer covers a page that
            // never does. Either one shows the window and answers DoVerb, once; a window
            // destroyed first drops `opened`, which ends the DoVerb wait.
            Ok(()) => crate::first_paint::arm_first_paint_fallback_with(
                &window,
                REVEAL_FALLBACK,
                |window| {
                    if window.state::<super::server::Server>().session_ending() {
                        Err("The Windows session is ending".to_string())
                    } else {
                        Ok(())
                    }
                },
                move |window, _trigger, shown| {
                    // The user just activated the object: the editor takes focus.
                    let result =
                        shown.and_then(|()| window.set_focus().map_err(|error| error.to_string()));
                    let failed = result.is_err();
                    if opened.send(result).is_err() || failed {
                        let _ = window.destroy();
                    }
                },
            ),
            Err(error) => {
                let _ = opened.send(Err(error.to_string()));
                let _ = window.destroy();
            }
        }
    })
    .map_err(|error| error.to_string())?;
    status
        .recv_timeout(std::time::Duration::from_secs(10))
        .map_err(|error| format!("Office editor did not open: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, to_value};

    #[test]
    fn editor_contract() {
        let open = Open {
            object_id: "7".into(),
            json: "{}".into(),
            container_app: "Word".into(),
            container_document: "β.docx".into(),
        };
        assert_eq!(
            to_value(open).unwrap(),
            json!({"objectId":"7","json":"{}","containerApp":"Word","containerDocument":"β.docx"})
        );
        assert_eq!(
            to_value(CloseRequest {
                request_id: Some(2),
                prompt: true,
                unsaved: false,
                discard: false
            })
            .unwrap(),
            json!({"requestId":2,"prompt":true,"unsaved":false,"discard":false})
        );
        assert_eq!(owner_id("office-object-7").as_deref(), Ok("7"));
        assert!(owner_id("office-object-7-other").is_err());
        assert!(owner_id("main").is_err());
    }

    #[test]
    fn editor_url_carries_a_sanitized_container_name() {
        assert_eq!(editor_url("7", ""), "index.html?officeObject=7");
        assert_eq!(editor_url("7", " \t "), "index.html?officeObject=7");
        assert_eq!(
            editor_url("7", "Microsoft  Word"),
            "index.html?officeObject=7&officeApp=Microsoft%20Word"
        );
        assert_eq!(
            editor_url("12", "A&B=\u{7}<x>#é"),
            "index.html?officeObject=12&officeApp=A%26B%3D%3Cx%3E%23%C3%A9"
        );
        let long = editor_url("1", &"é".repeat(200));
        assert_eq!(long.matches("%C3%A9").count(), MAX_CONTAINER_APP_CHARS);
    }

    #[test]
    fn editor_window_paints_the_app_background_before_the_page_loads() {
        let css = include_str!("../../../src/App.css");
        let (r, g, b) = EDITOR_BACKGROUND;
        let token = format!("--cd-bg-app: #{r:02x}{g:02x}{b:02x};");
        assert!(css.contains(&token), "App.css no longer defines {token}");
        let html = include_str!("../../../index.html");
        assert!(html.contains(&format!("#{r:02x}{g:02x}{b:02x}")));

        let source = include_str!("bridge.rs");
        let builder = &source[source.find("WebviewWindowBuilder::new(").unwrap()..];
        let builder = &builder[..builder.find(".build()").unwrap()];
        assert!(builder.contains("editor_url(&id, &container_app)"));
        assert!(!builder.contains(".visible("));
        assert!(!builder.contains(".background_color("));
        let open = &source[source.find("pub(super) fn open_window(").unwrap()..];
        let step = &open[open
            .find("crate::first_paint::hidden_until_first_paint(")
            .unwrap()..];
        let step = &step[..step.find(".build();").unwrap()];
        assert!(step.contains("WebviewWindowBuilder::new("));
        assert!(step.contains("tauri::window::Color(red, green, blue, 0xff),\n        )"));
    }

    #[test]
    fn editor_window_stays_hidden_until_the_page_paints_or_the_fallback_fires() {
        let source = include_str!("bridge.rs");
        let body = |name: &str| {
            let start = source.find(name).unwrap();
            let rest = &source[start..];
            &rest[..rest.find("\n}\n").unwrap()]
        };
        // Nothing shows the new window between build and the first-paint reveal.
        let open = body("pub(super) fn open_window(");
        let built = &open[open.find(".build();").unwrap()..];
        assert!(
            !built.contains(".show()"),
            "open_window shows the editor before it paints"
        );
        let pending = &built[built.find("Ok(()) => ").unwrap()..];
        let pending = &pending[..pending.find("Err(error) => {").unwrap()];
        assert!(pending.starts_with(
            "Ok(()) => crate::first_paint::arm_first_paint_fallback_with(\n                &window,\n                REVEAL_FALLBACK,"
        ));
        assert_eq!(REVEAL_FALLBACK, std::time::Duration::from_millis(4000));
        // The helper shows; the editor declines during session end, then focuses and answers
        // DoVerb with the result.
        assert!(pending.contains("session_ending()"));
        assert!(pending.contains("shown.and_then(|()| window.set_focus()"));
        assert!(pending.contains("opened.send(result).is_err() || failed"));
        // A second activation of a still-hidden editor answers the first one too.
        let existing = &open[open.find("get_webview_window(&label)").unwrap()..];
        assert!(existing[..existing.find(".set_title(").unwrap()]
            .contains("crate::first_paint::show_after_first_paint(&window);"));
        // The old office-only reveal path is gone.
        for removed in [
            "PENDING_REVEALS",
            "take_pending_reveal",
            "fn editor_painted",
            "fn painted_sender",
            "office-object-painted",
        ] {
            assert!(!code_only(source).contains(removed), "{removed}");
        }
    }

    /// Each Office OLE command has its generated permission and is granted by exactly the
    /// capabilities listed here, so no other window can invoke it. A new `office_ole::` command
    /// fails until it is added.
    #[test]
    fn office_ole_commands_are_permitted_and_granted_only_to_their_windows() {
        let expected: [(&str, &[&str]); 6] = [
            ("office_object_connect", &["office-object"]),
            ("office_object_set_title", &["office-object"]),
            ("office_object_update", &["office-object"]),
            ("office_object_close", &["office-object"]),
            ("office_toolset_emit", &["office-object", "office-toolset"]),
            ("prepare_office_editors_for_update", &["app-updates"]),
        ];
        let registered: Vec<&str> =
            crate::handler_list::registered_commands(include_str!("../lib.rs"))
                .into_iter()
                .filter(|command| command.starts_with("office_ole::"))
                .map(|command| command.rsplit("::").next().unwrap())
                .collect();
        let mut listed: Vec<&str> = expected.iter().map(|(command, _)| *command).collect();
        let mut sorted = registered.clone();
        sorted.sort_unstable();
        listed.sort_unstable();
        assert_eq!(sorted, listed);

        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let build = include_str!("../../build.rs");
        let mut capabilities = Vec::new();
        for entry in std::fs::read_dir(root.join("capabilities")).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|e| e == "json") {
                let json: serde_json::Value =
                    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
                if json["identifier"] == "office-object" {
                    assert!(!json["permissions"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|permission| permission == "core:window:allow-set-title"));
                }
                capabilities.push(json);
            }
        }
        for (command, holders) in expected {
            assert!(build.contains(&format!("\"{command}\",")), "{command}");
            let permission = std::fs::read_to_string(
                root.join(format!("permissions/autogenerated/{command}.toml")),
            )
            .unwrap();
            assert!(permission.contains(&format!("commands.allow = [\"{command}\"]")));
            let allow = format!("allow-{}", command.replace('_', "-"));
            let mut granted: Vec<&str> = capabilities
                .iter()
                .filter(|capability| {
                    capability["permissions"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|p| {
                            p.as_str().or_else(|| p["identifier"].as_str()) == Some(allow.as_str())
                        })
                })
                .map(|capability| capability["identifier"].as_str().unwrap())
                .collect();
            granted.sort_unstable();
            assert_eq!(granted, holders, "{command}");
            for capability in &capabilities {
                if holders.contains(&capability["identifier"].as_str().unwrap()) {
                    assert_eq!(capability["platforms"], json!(["windows"]), "{command}");
                }
            }
        }
    }

    fn code_only(source: &str) -> String {
        let source = &source[..source.find("#[cfg(test)]\nmod tests").unwrap()];
        source
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn session_end_replies_carry_a_request_and_an_optional_unchanged_marker() {
        use tauri::http::{HeaderMap, HeaderValue};
        let headers = |pairs: &[(&'static str, &'static str)]| {
            let mut map = HeaderMap::new();
            for &(name, value) in pairs {
                map.insert(name, HeaderValue::from_static(value));
            }
            map
        };
        assert_eq!(session_reply(&headers(&[])), Ok(None));
        assert_eq!(
            session_reply(&headers(&[(SESSION_PUBLISH_HEADER, "54")])),
            Ok(Some(SessionReply::Drawing(54)))
        );
        assert_eq!(
            session_reply(&headers(&[
                (SESSION_PUBLISH_HEADER, "54"),
                (SESSION_UNCHANGED_HEADER, "1")
            ])),
            Ok(Some(SessionReply::Unchanged(54)))
        );
        assert_eq!(
            session_reply(&headers(&[
                (SESSION_PUBLISH_HEADER, "54"),
                (SESSION_FAILED_HEADER, "1")
            ])),
            Ok(Some(SessionReply::Failed(54)))
        );
        for bad in [
            &[(SESSION_UNCHANGED_HEADER, "1")][..],
            &[(SESSION_FAILED_HEADER, "1")],
            &[(SESSION_PUBLISH_HEADER, "54"), (SESSION_FAILED_HEADER, "0")],
            &[
                (SESSION_PUBLISH_HEADER, "54"),
                (SESSION_UNCHANGED_HEADER, "1"),
                (SESSION_FAILED_HEADER, "1"),
            ],
            &[(SESSION_PUBLISH_HEADER, "x")],
            &[(SESSION_PUBLISH_HEADER, "-1")],
            &[
                (SESSION_PUBLISH_HEADER, "54"),
                (SESSION_UNCHANGED_HEADER, "0"),
            ],
        ] {
            assert!(session_reply(&headers(bad)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn rejects_oversized_frames_and_individual_parts_before_decoding() {
        use super::super::{emf::MAX_PNG_BYTES, storage::MAX_DOCUMENT_BYTES};
        let full = 4 + MAX_DOCUMENT_BYTES + MAX_PNG_BYTES;
        assert_eq!(
            update_lengths(full, MAX_DOCUMENT_BYTES),
            Ok(4 + MAX_DOCUMENT_BYTES)
        );
        assert!(update_lengths(full + 1, MAX_DOCUMENT_BYTES)
            .unwrap_err()
            .contains("50 MiB"));
        assert!(update_lengths(full, MAX_DOCUMENT_BYTES + 1)
            .unwrap_err()
            .contains("ChemDraftDocument"));
        assert!(update_lengths(full, MAX_DOCUMENT_BYTES - 1)
            .unwrap_err()
            .contains("PNG"));
        assert!(update_lengths(4, 0).is_err());
        assert!(update_lengths(7, 100).is_err());
    }
}
