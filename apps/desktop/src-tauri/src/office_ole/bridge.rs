//! Embedded editor IPC, Windows only. Each activation opens `index.html?officeObject=<id>`
//! in the local webview labelled `office-object-<id>`. IDs are opaque strings.
//! Listen on this window for `office-object://open`, then emit `office-object://ready` to
//! this window's label. The STA replies with {objectId, json, containerApp, containerDocument}.
//! This handshake also works after a renderer reload. `json` is the exact UTF-8 selection text.
//! Invoke `office_object_update` with {objectId, json, pngBase64} (standard base64 carrier PNG,
//! no data URL). Await success before invoking `office_object_close` with {objectId, saveChanges}.
//! Both resolve to null or reject with a diagnostic. Update publishes to the container immediately.
//! Close(true) retries any dirty save, and Close(false) discards unpublished editor changes.
//! A native window close releases the edit session. Only its own webview may operate on an ID.

#[cfg(any(windows, test))]
use serde::{Deserialize, Serialize};

#[cfg(any(windows, test))]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Open {
    pub object_id: String,
    pub json: String,
    pub container_app: String,
    pub container_document: String,
}

#[cfg(any(windows, test))]
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Update {
    pub object_id: String,
    pub json: String,
    pub png_base64: String,
}

#[cfg(any(windows, test))]
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Close {
    pub object_id: String,
    pub save_changes: bool,
}

#[cfg(any(windows, test))]
pub(super) fn opens_editor(verb: i32) -> bool {
    matches!(verb, -2..=1) // OLEIVERB_OPEN, SHOW, PRIMARY/Edit, our Open
}

#[cfg(any(windows, test))]
fn require_owner(label: &str, id: &str) -> Result<(), String> {
    if label.strip_prefix("office-object-") == Some(id) && !id.is_empty() {
        Ok(())
    } else {
        Err("This window does not own the Office object".into())
    }
}

#[tauri::command]
pub(crate) async fn office_object_update(
    window: tauri::WebviewWindow,
    object_id: String,
    json: String,
    png_base64: String,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        use tauri::Manager;
        require_owner(window.label(), &object_id)?;
        let update = Update {
            object_id,
            json,
            png_base64,
        };
        let (id, content) = tauri::async_runtime::spawn_blocking(move || {
            let data = super::presentation::Content::from_update(&update.json, &update.png_base64)?;
            Ok::<_, super::OleError>((update.object_id, data))
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
        window
            .state::<super::server::Server>()
            .request(id, super::server::Action::Update(content))
            .await
    }
    #[cfg(not(windows))]
    {
        let _ = (window, object_id, json, png_base64);
        Err("Office embedded-object editing requires Windows".into())
    }
}

#[tauri::command]
pub(crate) async fn office_object_close(
    window: tauri::WebviewWindow,
    object_id: String,
    save_changes: bool,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        use tauri::Manager;
        require_owner(window.label(), &object_id)?;
        let close = Close {
            object_id,
            save_changes,
        };
        window
            .state::<super::server::Server>()
            .request(
                close.object_id,
                super::server::Action::Close(close.save_changes),
            )
            .await
    }
    #[cfg(not(windows))]
    {
        let _ = (window, object_id, save_changes);
        Err("Office embedded-object editing requires Windows".into())
    }
}

#[cfg(windows)]
pub(super) fn open_window(
    app: &tauri::AppHandle,
    id: &str,
    title: String,
    was_open: bool,
) -> Result<(), String> {
    use tauri::{Listener, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
    let handle = app.clone();
    let id = id.to_owned();
    let (opened, status) = std::sync::mpsc::sync_channel(1);
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
            // Its Destroyed notification is in the STA queue. A later activation gets a fresh ID.
            let _ = opened.send(Err(
                "The previous Office editor is closing. Activate the object again.".into(),
            ));
            return;
        }
        let ready_id = id.clone();
        let listener = std::sync::Arc::new(std::sync::OnceLock::new());
        let ready_listener = listener.clone();
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
        .inner_size(900.0, 640.0)
        .on_navigation(move |url| {
            url.origin().ascii_serialization() == "http://tauri.localhost"
                || dev_origin.as_ref() == Some(&url.origin())
        })
        .on_page_load(move |window, page| {
            if matches!(page.event(), tauri::webview::PageLoadEvent::Started) {
                let app = window.app_handle().clone();
                let id = ready_id.clone();
                ready_listener.get_or_init(|| {
                    window.listen("office-object://ready", move |_| {
                        app.state::<super::server::Server>()
                            .post(&id, super::server::Action::Ready);
                    })
                });
            } else {
                let _ = window.set_title(&title);
            }
        })
        .build();
        match result {
            Ok(window) => {
                let app = handle.clone();
                window.on_window_event(move |event| {
                    if matches!(event, WindowEvent::Destroyed) {
                        if let Some(event) = listener.get() {
                            app.unlisten(*event);
                        }
                        app.state::<super::server::Server>()
                            .post(&id, super::server::Action::Destroyed);
                    }
                });
                if opened.send(Ok(())).is_err() {
                    // DoVerb timed out while WebView2 was starting.
                    let _ = window.destroy();
                }
            }
            Err(error) => {
                if let Some(event) = listener.get() {
                    handle.unlisten(*event);
                }
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
            to_value(Update {
                object_id: "7".into(),
                json: "{}".into(),
                png_base64: "AA==".into()
            })
            .unwrap(),
            json!({"objectId":"7","json":"{}","pngBase64":"AA=="})
        );
        assert_eq!(
            to_value(Close {
                object_id: "7".into(),
                save_changes: true
            })
            .unwrap(),
            json!({"objectId":"7","saveChanges":true})
        );
        assert!(require_owner("office-object-7", "7").is_ok());
        assert!(require_owner("office-object-7", "8").is_err());
        assert!(require_owner("main", "7").is_err());
        for verb in [-2, -1, 0, 1] {
            assert!(opens_editor(verb));
        }
        for verb in [-6, -5, -4, -3, 2] {
            assert!(!opens_editor(verb));
        }
    }
}
