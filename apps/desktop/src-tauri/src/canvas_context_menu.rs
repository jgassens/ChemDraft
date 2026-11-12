//! Document-targeted, unattached popup menus. Tauri 2.11.2 delegates tracking to NSMenu on
//! macOS and the document HWND's native popup on Windows; no utility window gets a menu.
use serde::Deserialize;
use std::collections::HashSet;
use std::sync::Mutex;
use tauri::menu::{
    CheckMenuItem, ContextMenu, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu,
};
use tauri::{AppHandle, LogicalPosition, Manager, Runtime, WebviewWindow};
use tokio::sync::oneshot;

const ID_PREFIX: &str = "canvas-context:";

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum NativeItem {
    Separator,
    Item {
        id: String,
        label: String,
        enabled: bool,
        #[serde(rename = "disabledReason")]
        disabled_reason: Option<String>,
        checked: Option<bool>,
    },
    Submenu {
        label: String,
        enabled: bool,
        items: Vec<NativeItem>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PopupPosition {
    x: f64,
    y: f64,
}

#[derive(Debug, PartialEq)]
enum PopupItem {
    Separator,
    Item {
        id: String,
        text: String,
        enabled: bool,
        checked: Option<bool>,
    },
    Submenu {
        text: String,
        enabled: bool,
        items: Vec<PopupItem>,
    },
}

struct ConvertedMenu {
    items: Vec<PopupItem>,
    selectable: HashSet<String>,
}

fn convert_spec(items: Vec<NativeItem>) -> Result<ConvertedMenu, String> {
    fn text(label: String, reason: Option<String>, enabled: bool) -> Result<String, String> {
        if label.is_empty() || label.len() > 1024 || label.chars().any(char::is_control) {
            return Err("Invalid canvas menu label".into());
        }
        let label = if let Some(reason) = reason.filter(|_| !enabled) {
            if reason.len() > 2048 || reason.chars().any(char::is_control) {
                return Err("Invalid canvas menu disabled reason".into());
            }
            // OS popup items have no portable tooltip. Keep the reason visible on both OSes.
            format!("{label} — {reason}")
        } else {
            label
        };
        // Muda treats '&' as a mnemonic on both platforms. Source labels are literal text.
        Ok(label.replace('&', "&&"))
    }
    fn walk(
        items: Vec<NativeItem>,
        depth: usize,
        parent_enabled: bool,
        count: &mut usize,
        seen: &mut HashSet<String>,
        selectable: &mut HashSet<String>,
    ) -> Result<Vec<PopupItem>, String> {
        if depth > 6 || items.is_empty() {
            return Err("Invalid canvas menu depth or empty submenu".into());
        }
        items
            .into_iter()
            .map(|item| {
                *count += 1;
                if *count > 512 {
                    return Err("Canvas menu has too many items".into());
                }
                Ok(match item {
                    NativeItem::Separator => PopupItem::Separator,
                    NativeItem::Item {
                        id,
                        label,
                        enabled,
                        disabled_reason,
                        checked,
                    } => {
                        if !id.starts_with(ID_PREFIX)
                            || id.len() > 256
                            || !id.chars().all(|ch| {
                                ch.is_ascii_alphanumeric() || matches!(ch, ':' | '-' | '_')
                            })
                            || !seen.insert(id.clone())
                        {
                            return Err("Invalid or duplicate canvas menu item ID".into());
                        }
                        if parent_enabled && enabled {
                            selectable.insert(id.clone());
                        }
                        PopupItem::Item {
                            id,
                            text: text(label, disabled_reason, enabled)?,
                            enabled,
                            checked,
                        }
                    }
                    NativeItem::Submenu {
                        label,
                        enabled,
                        items,
                    } => PopupItem::Submenu {
                        text: text(label, None, enabled)?,
                        enabled,
                        items: walk(
                            items,
                            depth + 1,
                            parent_enabled && enabled,
                            count,
                            seen,
                            selectable,
                        )?,
                    },
                })
            })
            .collect()
    }
    let mut selectable = HashSet::new();
    let items = walk(items, 0, true, &mut 0, &mut HashSet::new(), &mut selectable)?;
    Ok(ConvertedMenu { items, selectable })
}

fn build_items<R: Runtime>(
    app: &AppHandle<R>,
    items: Vec<PopupItem>,
) -> tauri::Result<Vec<MenuItemKind<R>>> {
    items
        .into_iter()
        .map(|item| {
            Ok(match item {
                PopupItem::Separator => {
                    MenuItemKind::Predefined(PredefinedMenuItem::separator(app)?)
                }
                PopupItem::Item {
                    id,
                    text,
                    enabled,
                    checked: Some(checked),
                } => MenuItemKind::Check(CheckMenuItem::with_id(
                    app,
                    id,
                    text,
                    enabled,
                    checked,
                    None::<&str>,
                )?),
                PopupItem::Item {
                    id,
                    text,
                    enabled,
                    checked: None,
                } => {
                    MenuItemKind::MenuItem(MenuItem::with_id(app, id, text, enabled, None::<&str>)?)
                }
                PopupItem::Submenu {
                    text,
                    enabled,
                    items,
                } => {
                    let submenu = Submenu::new(app, text, enabled)?;
                    for child in build_items(app, items)? {
                        submenu.append(&child)?;
                    }
                    MenuItemKind::Submenu(submenu)
                }
            })
        })
        .collect()
}

struct PendingPopup {
    selectable: HashSet<String>,
    selected: Option<String>,
    finished: bool,
    reply: oneshot::Sender<Result<Option<String>, String>>,
}

impl PendingPopup {
    fn choose(&mut self, id: &str) {
        if self.selected.is_none() && self.selectable.contains(id) {
            self.selected = Some(id.to_owned());
        }
    }
}

fn take_finished(pending: &mut Option<PendingPopup>) -> Option<PendingPopup> {
    if pending.as_ref().is_some_and(|popup| popup.finished) {
        pending.take()
    } else {
        None
    }
}

#[derive(Default)]
pub(crate) struct PopupState(Mutex<Option<PendingPopup>>);

/// Popup IDs must never enter the application's command-ID dispatcher as a second invocation.
pub(crate) fn menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) -> bool {
    if !id.starts_with(ID_PREFIX) {
        return false;
    }
    if let Some(popup) = app.state::<PopupState>().0.lock().unwrap().as_mut() {
        popup.choose(id);
    }
    true
}

/// Menu events are queued by Tauri's native tracking loop. Settle after the loop has drained,
/// not immediately when popup_at returns, or a click can be mistaken for cancellation.
pub(crate) fn events_cleared<R: Runtime>(app: &AppHandle<R>) {
    let popup = {
        let state = app.state::<PopupState>();
        let mut pending = state.0.lock().unwrap();
        take_finished(&mut pending)
    };
    if let Some(popup) = popup {
        let _ = popup.reply.send(Ok(popup.selected));
    }
}

#[tauri::command]
pub(crate) async fn popup_canvas_context_menu<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    items: Vec<NativeItem>,
    position: PopupPosition,
) -> Result<Option<String>, String> {
    if window.label() != crate::MAIN_WINDOW_LABEL {
        return Err("Canvas menus belong to the document window".into());
    }
    if !position.x.is_finite()
        || !position.y.is_finite()
        || position.x.abs() > 100_000.0
        || position.y.abs() > 100_000.0
    {
        return Err("Invalid canvas menu position".into());
    }
    let converted = convert_spec(items)?;
    let (reply, receive) = oneshot::channel();
    {
        let state = app.state::<PopupState>();
        let mut pending = state.0.lock().unwrap();
        if pending.is_some() {
            return Err("A canvas menu is already open".into());
        }
        *pending = Some(PendingPopup {
            selectable: converted.selectable,
            selected: None,
            finished: false,
            reply,
        });
    }
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        let result = (|| {
            let document = handle
                .get_webview_window(crate::MAIN_WINDOW_LABEL)
                .ok_or_else(|| "Document window is unavailable".to_string())?;
            let menu = Menu::new(&handle).map_err(|e| e.to_string())?;
            for item in build_items(&handle, converted.items).map_err(|e| e.to_string())? {
                menu.append(&item).map_err(|e| e.to_string())?;
            }
            // This never calls set_menu, setAsAppMenu, or a utility-window popup.
            menu.popup_at(
                document.as_ref().window(),
                LogicalPosition::new(position.x, position.y),
            )
            .map_err(|e| e.to_string())
        })();
        let state = handle.state::<PopupState>();
        let mut pending = state.0.lock().unwrap();
        match result {
            Ok(()) => {
                if let Some(popup) = pending.as_mut() {
                    popup.finished = true;
                }
            }
            Err(error) => {
                if let Some(popup) = pending.take() {
                    let _ = popup.reply.send(Err(error));
                }
            }
        }
    }) {
        app.state::<PopupState>().0.lock().unwrap().take();
        return Err(error.to_string());
    }
    receive
        .await
        .map_err(|_| "Canvas menu closed before completion".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn convert(value: serde_json::Value) -> Result<ConvertedMenu, String> {
        convert_spec(serde_json::from_value(value).unwrap())
    }

    #[test]
    fn spec_conversion_preserves_order_submenus_checks_and_disabled_reasons() {
        let converted = convert(json!([
            {"kind":"item", "id":"canvas-context:1:0", "label":"Layer 1 of 3", "enabled":false},
            {"kind":"separator"},
            {"kind":"submenu", "label":"Copy & export", "enabled":true, "items":[
                {"kind":"item", "id":"canvas-context:1:1", "label":"SVG", "enabled":true, "checked":false},
                {"kind":"item", "id":"canvas-context:1:2", "label":"PDF", "enabled":false, "disabledReason":"Select a molecule"}
            ]}
        ])).unwrap();
        assert_eq!(
            converted.selectable,
            HashSet::from(["canvas-context:1:1".into()])
        );
        assert_eq!(
            converted.items,
            vec![
                PopupItem::Item {
                    id: "canvas-context:1:0".into(),
                    text: "Layer 1 of 3".into(),
                    enabled: false,
                    checked: None
                },
                PopupItem::Separator,
                PopupItem::Submenu {
                    text: "Copy && export".into(),
                    enabled: true,
                    items: vec![
                        PopupItem::Item {
                            id: "canvas-context:1:1".into(),
                            text: "SVG".into(),
                            enabled: true,
                            checked: Some(false)
                        },
                        PopupItem::Item {
                            id: "canvas-context:1:2".into(),
                            text: "PDF — Select a molecule".into(),
                            enabled: false,
                            checked: None
                        }
                    ]
                }
            ]
        );
    }

    #[test]
    fn disabled_submenus_cannot_route_enabled_children() {
        let result = convert(
            json!([{"kind":"submenu", "label":"Arrange", "enabled":false, "items":[
                {"kind":"item", "id":"canvas-context:1:0", "label":"Row", "enabled":true}
            ]}]),
        )
        .unwrap();
        assert!(result.selectable.is_empty());
    }

    #[test]
    fn invalid_duplicate_unscoped_and_oversized_specs_are_refused() {
        let item =
            json!({"kind":"item", "id":"canvas-context:1:0", "label":"Copy", "enabled":true});
        assert!(convert(json!([item.clone(), item.clone()])).is_err());
        assert!(convert(
            json!([{ "kind":"item", "id":"clipboard.copy", "label":"Copy", "enabled":true }])
        )
        .is_err());
        assert!(convert(json!([])).is_err());
        assert!(
            convert(json!([{"kind":"submenu", "label":"Empty", "enabled":true, "items":[]}]))
                .is_err()
        );
        assert!(convert(serde_json::Value::Array(vec![
            json!({"kind":"separator"});
            513
        ]))
        .is_err());
        assert!(convert(json!([{"kind":"item", "id":"canvas-context:1:0", "label":"Bad\tlabel", "enabled":true}])).is_err());
    }

    #[test]
    fn completion_waits_for_queued_choice_and_routes_only_once() {
        let (reply, mut receive) = oneshot::channel();
        let mut pending = Some(PendingPopup {
            selectable: HashSet::from(["canvas-context:1:0".into(), "canvas-context:1:1".into()]),
            selected: None,
            finished: false,
            reply,
        });
        assert!(take_finished(&mut pending).is_none());
        // popup_at has returned, but the MenuEvent may still be in Tauri's event queue.
        pending.as_mut().unwrap().finished = true;
        pending.as_mut().unwrap().choose("canvas-context:old:0");
        pending.as_mut().unwrap().choose("canvas-context:1:1");
        pending.as_mut().unwrap().choose("canvas-context:1:0");
        let popup = take_finished(&mut pending).unwrap();
        popup.reply.send(Ok(popup.selected)).unwrap();
        assert_eq!(
            receive.try_recv().unwrap(),
            Ok(Some("canvas-context:1:1".into()))
        );
        assert!(take_finished(&mut pending).is_none());
    }

    #[test]
    fn cancellation_has_no_selected_command() {
        let (reply, mut receive) = oneshot::channel();
        let mut pending = Some(PendingPopup {
            selectable: HashSet::new(),
            selected: None,
            finished: true,
            reply,
        });
        let popup = take_finished(&mut pending).unwrap();
        popup.reply.send(Ok(popup.selected)).unwrap();
        assert_eq!(receive.try_recv().unwrap(), Ok(None));
    }

    #[test]
    fn popup_command_is_registered_and_granted_only_to_main_on_both_platforms() {
        assert!(include_str!("../build.rs").contains("\"popup_canvas_context_menu\","));
        let permission =
            include_str!("../permissions/autogenerated/popup_canvas_context_menu.toml");
        assert!(permission.contains("identifier = \"allow-popup-canvas-context-menu\""));
        assert!(permission.contains("commands.allow = [\"popup_canvas_context_menu\"]"));
        assert!(permission.contains("commands.deny = [\"popup_canvas_context_menu\"]"));
        let capabilities = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let mut grants = Vec::new();
        for entry in std::fs::read_dir(capabilities).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                continue;
            }
            let capability: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let granted = capability["permissions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|p| {
                    p.as_str().or_else(|| p["identifier"].as_str())
                        == Some("allow-popup-canvas-context-menu")
                });
            if granted {
                assert_eq!(capability["windows"], json!(["main"]));
                assert!(capability.get("webviews").is_none());
                assert!(capability.get("platforms").is_none());
                assert!(capability.get("remote").is_none());
                assert_eq!(
                    capability["permissions"],
                    json!(["allow-popup-canvas-context-menu"])
                );
                grants.push(path.file_name().unwrap().to_str().unwrap().to_owned());
            }
        }
        assert_eq!(grants, vec!["canvas-context-menu.json"]);
    }

    #[test]
    fn application_menus_stay_document_only_off_macos_and_popups_are_unattached() {
        let lib = include_str!("lib.rs");
        let install = lib
            .split("fn install_app_menu<")
            .nth(1)
            .unwrap()
            .split("fn reinstall_app_menu<")
            .next()
            .unwrap();
        assert!(install.contains("#[cfg(target_os = \"macos\")]\n    app.set_menu(menu)?;"));
        assert!(install.contains("#[cfg(not(target_os = \"macos\"))]"));
        assert!(install.contains("app.get_webview_window(MAIN_WINDOW_LABEL)"));
        assert!(install.contains("window.set_menu(menu)?;"));
        assert_eq!(lib.matches(".set_menu(").count(), 2);
        for forbidden in ["toolset", "palette", "popover", "webview_windows("] {
            assert!(!install.contains(forbidden));
        }
        let popup = include_str!("canvas_context_menu.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        assert!(popup.contains("window.label() != crate::MAIN_WINDOW_LABEL"));
        assert!(popup.contains("get_webview_window(crate::MAIN_WINDOW_LABEL)"));
        assert!(popup.contains("menu.popup_at("));
        assert!(!popup.contains(".set_menu("));
    }
}
