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
}

#[cfg(any(windows, test))]
pub(super) fn owner_id(label: &str) -> Result<&str, String> {
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
pub(crate) async fn office_object_update(
    window: tauri::WebviewWindow,
    request: Request<'_>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        use tauri::{ipc::InvokeBody, Manager};
        let id = owner_id(window.label())?.to_owned();
        let InvokeBody::Raw(bytes) = request.body() else {
            return Err("Office updates require a raw selection and PNG payload".into());
        };
        let header: [u8; 4] = bytes
            .get(..4)
            .ok_or("Office update header is missing")?
            .try_into()
            .map_err(|_| "Invalid Office update header")?;
        let json_end = update_lengths(bytes.len(), u32::from_le_bytes(header) as usize)?;
        let server = window.state::<super::server::Server>();
        let permit = server.begin_update(&id)?;
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
        server
            .request(
                id,
                super::server::Action::Update {
                    content,
                    _permit: permit,
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

#[cfg(windows)]
pub(super) fn open_window(
    app: &tauri::AppHandle,
    id: &str,
    title: String,
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
        let label = format!("office-object-{id}");
        if let Some(window) = handle.get_webview_window(&label) {
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
        let result = WebviewWindowBuilder::new(
            &handle,
            &label,
            WebviewUrl::App(format!("index.html?officeObject={id}").into()),
        )
        .title(&title)
        .visible(false)
        .inner_size(900.0, 640.0)
        .on_navigation(move |url| {
            url.origin().ascii_serialization() == "http://tauri.localhost"
                || dev_origin.as_ref() == Some(&url.origin())
        })
        .build();
        match result {
            Ok(window) => {
                let app = handle.clone();
                let subscriptions = super::toolset_events::attach(&window);
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
                let result = crate::install_office_document_menu(
                    &window,
                    &[],
                    crate::ViewMenuState::default(),
                    None,
                )
                .map_err(|error| error.to_string())
                .and_then(|()| {
                    window
                        .show()
                        .and_then(|_| window.set_focus())
                        .map_err(|e| e.to_string())
                });
                let failed = result.is_err();
                if opened.send(result).is_err() || failed {
                    let _ = window.destroy();
                }
            }
            Err(error) => {
                let _ = opened.send(Err(format!("Could not open Office editor: {error}")));
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
                unsaved: false
            })
            .unwrap(),
            json!({"requestId":2,"prompt":true,"unsaved":false})
        );
        assert_eq!(owner_id("office-object-7").as_deref(), Ok("7"));
        assert!(owner_id("office-object-7-other").is_err());
        assert!(owner_id("main").is_err());
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
