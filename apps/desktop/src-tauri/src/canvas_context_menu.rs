//! Document-targeted, unattached popup menus. Tauri 2.11.2 delegates tracking to NSMenu on
//! macOS, the document HWND's native popup on Windows and a GTK popup on Linux; no utility window
//! gets a menu. The document window's canvas menus are built from the item tree it sends
//! (`popup_canvas_context_menu`, document window only). A floating toolbar's right-click menu is a
//! separate command (`popup_toolbar_context_menu`): the toolbar sends only its toolset id, and Rust
//! itself builds the fixed items and labels for the toolset its window was created for, so a plugin
//! toolbar cannot put any other text in a native menu. It is still presented by the document
//! window, at the pointer, so the palette never owns a menu.
use serde::{Deserialize, Serialize};
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

/// Where the popup opens. The document's own canvas menus open at the point it names; a floating
/// toolbar's menu opens at the pointer, which every platform reads in its own screen space
/// (`NSEvent::mouseLocation`, `GetCursorPos`, GTK's pointer), so no palette-to-document coordinate
/// conversion is needed across monitors with different scales.
#[derive(Debug, PartialEq)]
enum PopupAnchor {
    Document { x: f64, y: f64 },
    Pointer,
}

/// Floating toolbar windows (core, plugin and user toolsets). Popovers and the tooltip are not
/// toolbars and get no menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ToolsetPaletteKind {
    Core,
    Plugin,
    User,
}

fn toolset_palette_kind(label: &str) -> Option<ToolsetPaletteKind> {
    [
        ("toolset-core-", ToolsetPaletteKind::Core),
        ("toolset-plugin-", ToolsetPaletteKind::Plugin),
        ("toolset-user-", ToolsetPaletteKind::User),
    ]
    .into_iter()
    .find_map(|(prefix, kind)| {
        label
            .strip_prefix(prefix)
            .is_some_and(|suffix| !suffix.is_empty())
            .then_some(kind)
    })
}

/// The general canvas popup takes a caller-supplied item tree, so only the document window may
/// call it. Floating toolbars use `popup_toolbar_context_menu`, whose items Rust builds itself.
fn popup_anchor(caller: &str, position: &PopupPosition) -> Result<PopupAnchor, String> {
    if !position.x.is_finite()
        || !position.y.is_finite()
        || position.x.abs() > 100_000.0
        || position.y.abs() > 100_000.0
    {
        return Err("Invalid canvas menu position".into());
    }
    if caller == crate::MAIN_WINDOW_LABEL {
        Ok(PopupAnchor::Document {
            x: position.x,
            y: position.y,
        })
    } else {
        Err("Canvas menus belong to the document window".into())
    }
}

/// The only items a floating toolbar's menu can hold. Their ids, labels and order are fixed here;
/// the toolbar learns which one was chosen and runs the matching registered command itself
/// (`view.customizeMainToolbar`, or the View > Toolbars toggle `view.toolset.toggle.<id>`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ToolbarMenuChoice {
    Customize,
    Hide,
}

impl ToolbarMenuChoice {
    const ALL: [Self; 2] = [Self::Customize, Self::Hide];

    fn menu_id(self) -> &'static str {
        match self {
            Self::Customize => "canvas-context:toolbar:customize",
            Self::Hide => "canvas-context:toolbar:hide",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Customize => "Customize Toolbar…",
            Self::Hide => "Hide Toolbar",
        }
    }

    fn from_menu_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|choice| choice.menu_id() == id)
    }
}

/// The toolbar menu for `caller`, the window that asked. `registered` is the toolset id Rust
/// recorded when it created that window (`ToolsetWindowDirectory`), never a caller-supplied value:
/// the id the toolbar sends (`requested`) must match it exactly, or the request is refused. So a
/// plugin toolbar can neither name another toolbar nor add, relabel or reorder an item; it gets
/// Hide for its own toolset and nothing else. Customize is offered only on the core Main toolbar,
/// the one the customize gallery supports.
fn toolbar_menu_items(
    caller: &str,
    requested: &str,
    registered: Option<&str>,
) -> Result<Vec<ToolbarMenuChoice>, String> {
    let kind = toolset_palette_kind(caller)
        .ok_or_else(|| "Toolbar menus belong to floating toolbars".to_string())?;
    let registered =
        registered.ok_or_else(|| "This window is not a known floating toolbar".to_string())?;
    if crate::toolset_window_label(registered) != caller {
        return Err("This window is not a known floating toolbar".into());
    }
    if requested != registered {
        return Err("A toolbar's menu can name only its own toolbar".into());
    }
    let customize = kind == ToolsetPaletteKind::Core && registered == crate::MAIN_TOOLSET_ID;
    Ok(if customize {
        vec![ToolbarMenuChoice::Customize, ToolbarMenuChoice::Hide]
    } else {
        vec![ToolbarMenuChoice::Hide]
    })
}

fn toolbar_popup_items(choices: &[ToolbarMenuChoice]) -> ConvertedMenu {
    let mut items = Vec::new();
    for (index, choice) in choices.iter().enumerate() {
        if index > 0 {
            items.push(PopupItem::Separator);
        }
        items.push(PopupItem::Item {
            id: choice.menu_id().to_owned(),
            text: choice.label().to_owned(),
            enabled: true,
            checked: None,
        });
    }
    ConvertedMenu {
        items,
        selectable: choices
            .iter()
            .map(|choice| choice.menu_id().to_owned())
            .collect(),
    }
}

/// Whether a toolbar's menu may be presented now. On Windows, `menu.popup` on the document window
/// calls `SetForegroundWindow` before `TrackPopupMenu`, so presenting it while another process is
/// in front would pull ChemDraft forward from a right-click on a non-activating palette (AGENTS.md
/// §1: palettes never steal focus). There the menu opens only when ChemDraft's own process already
/// owns the foreground window; otherwise nothing happens. The other platforms present the menu
/// without activating the document window, so they always may.
fn toolbar_menu_may_present(
    popup_activates_document: bool,
    foreground_process: Option<u32>,
    own_process: u32,
) -> bool {
    !popup_activates_document || foreground_process == Some(own_process)
}

#[cfg(windows)]
const POPUP_ACTIVATES_DOCUMENT: bool = true;
#[cfg(not(windows))]
const POPUP_ACTIVATES_DOCUMENT: bool = false;

/// The process that owns the foreground window. None when there is no foreground window or the
/// lookup fails, which refuses the menu rather than letting it take focus from another process.
#[cfg(windows)]
fn foreground_process() -> Option<u32> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId,
    };
    // HWND is a pointer in windows-sys 0.61.
    unsafe {
        let foreground = GetForegroundWindow();
        if foreground.is_null() {
            return None;
        }
        let mut process: u32 = 0;
        (GetWindowThreadProcessId(foreground, &mut process) != 0 && process != 0).then_some(process)
    }
}

/// Off Windows the popup never activates the document window, so the foreground owner is not read.
#[cfg(not(windows))]
fn foreground_process() -> Option<u32> {
    None
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
    let anchor = popup_anchor(window.label(), &position)?;
    let converted = convert_spec(items)?;
    present(app, converted, anchor, false).await
}

/// A floating toolbar's right-click menu. The toolbar sends only its toolset id; Rust checks it
/// against the toolset its window was created for, builds the fixed items itself and returns which
/// of them was chosen (None when dismissed, or when the menu could not open without taking focus).
#[tauri::command]
pub(crate) async fn popup_toolbar_context_menu<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    toolset_id: String,
) -> Result<Option<ToolbarMenuChoice>, String> {
    let caller = window.label();
    let registered = crate::toolset_id_for_window_label(&app, caller);
    let choices = toolbar_menu_items(caller, &toolset_id, registered.as_deref())?;
    let selected = present(
        app,
        toolbar_popup_items(&choices),
        PopupAnchor::Pointer,
        true,
    )
    .await?;
    Ok(selected
        .as_deref()
        .and_then(ToolbarMenuChoice::from_menu_id)
        .filter(|choice| choices.contains(choice)))
}

/// Presents `converted` from the document window and waits for the user's choice. With
/// `keep_other_apps_in_front`, a menu that would have to activate ChemDraft (Windows) is skipped
/// unless ChemDraft already owns the foreground, and resolves as a dismissal.
async fn present<R: Runtime>(
    app: AppHandle<R>,
    converted: ConvertedMenu,
    anchor: PopupAnchor,
    keep_other_apps_in_front: bool,
) -> Result<Option<String>, String> {
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
        if keep_other_apps_in_front
            && !toolbar_menu_may_present(
                POPUP_ACTIVATES_DOCUMENT,
                foreground_process(),
                std::process::id(),
            )
        {
            if let Some(popup) = handle.state::<PopupState>().0.lock().unwrap().take() {
                let _ = popup.reply.send(Ok(None));
            }
            return;
        }
        let result = (|| {
            let document = handle
                .get_webview_window(crate::MAIN_WINDOW_LABEL)
                .ok_or_else(|| "Document window is unavailable".to_string())?;
            let menu = Menu::new(&handle).map_err(|e| e.to_string())?;
            for item in build_items(&handle, converted.items).map_err(|e| e.to_string())? {
                menu.append(&item).map_err(|e| e.to_string())?;
            }
            // This never calls set_menu, setAsAppMenu, or a utility-window popup: a toolbar's menu
            // is presented by the document window too. On Windows that popup calls
            // SetForegroundWindow on the document window, so a toolbar's menu is only presented
            // while ChemDraft already owns the foreground (checked above); it then moves focus
            // within ChemDraft, never from another application.
            match anchor {
                PopupAnchor::Document { x, y } => {
                    menu.popup_at(document.as_ref().window(), LogicalPosition::new(x, y))
                }
                PopupAnchor::Pointer => menu.popup(document.as_ref().window()),
            }
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

    /// Every capability granting `permission`, checked to hold exactly that grant for exactly
    /// `windows` on every platform; returns the capability files' names.
    fn grants_of(permission: &str, windows: serde_json::Value) -> Vec<String> {
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
                .any(|p| p.as_str().or_else(|| p["identifier"].as_str()) == Some(permission));
            if granted {
                assert_eq!(capability["windows"], windows, "{path:?}");
                assert!(capability.get("webviews").is_none());
                assert!(capability.get("platforms").is_none());
                assert!(capability.get("remote").is_none());
                assert_eq!(capability["permissions"], json!([permission]));
                grants.push(path.file_name().unwrap().to_str().unwrap().to_owned());
            }
        }
        grants
    }

    #[test]
    fn canvas_popup_is_document_only_and_toolbars_get_only_the_fixed_toolbar_menu() {
        for command in ["popup_canvas_context_menu", "popup_toolbar_context_menu"] {
            assert!(include_str!("../build.rs").contains(&format!("\"{command}\",")));
        }
        let permission =
            include_str!("../permissions/autogenerated/popup_canvas_context_menu.toml");
        assert!(permission.contains("identifier = \"allow-popup-canvas-context-menu\""));
        assert!(permission.contains("commands.allow = [\"popup_canvas_context_menu\"]"));
        assert!(permission.contains("commands.deny = [\"popup_canvas_context_menu\"]"));
        let permission =
            include_str!("../permissions/autogenerated/popup_toolbar_context_menu.toml");
        assert!(permission.contains("identifier = \"allow-popup-toolbar-context-menu\""));
        assert!(permission.contains("commands.allow = [\"popup_toolbar_context_menu\"]"));
        assert!(permission.contains("commands.deny = [\"popup_toolbar_context_menu\"]"));
        // The general popup takes a caller-built item tree: the document window only. No toolbar,
        // and above all no plugin toolbar, can reach it.
        assert_eq!(
            grants_of("allow-popup-canvas-context-menu", json!(["main"])),
            vec!["canvas-context-menu.json"]
        );
        assert_eq!(
            grants_of(
                "allow-popup-toolbar-context-menu",
                json!(["toolset-core-*", "toolset-plugin-*", "toolset-user-*"])
            ),
            vec!["toolbar-context-menu.json"]
        );
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
        assert!(popup.contains("popup_anchor(window.label(), &position)?"));
        assert!(popup.contains("get_webview_window(crate::MAIN_WINDOW_LABEL)"));
        assert!(popup.contains("menu.popup_at(document.as_ref().window()"));
        assert!(popup.contains("menu.popup(document.as_ref().window())"));
        // The caller (a palette) is only ever the requester, never the window the menu belongs to.
        assert!(!popup.contains("window.as_ref().window()"));
        assert!(!popup.contains(".set_menu("));
    }

    fn at(x: f64, y: f64) -> PopupPosition {
        PopupPosition { x, y }
    }

    #[test]
    fn only_the_document_window_opens_caller_built_menus() {
        assert_eq!(
            popup_anchor("main", &at(120.5, 64.0)),
            Ok(PopupAnchor::Document { x: 120.5, y: 64.0 })
        );
        for toolbar in [
            "toolset-core-main",
            "toolset-core-style",
            "toolset-plugin-example-tools",
            "toolset-user-quick",
        ] {
            assert!(popup_anchor(toolbar, &at(6.0, 30.0)).is_err(), "{toolbar}");
        }
    }

    #[test]
    fn popovers_tooltips_dialogs_and_bad_positions_get_no_menu() {
        for caller in [
            "toolset-popover-core-main",
            "toolset-tooltip",
            "toolset-core-",
            "toolset-plugin-",
            "toolset-user-",
            "preferences",
            "plugin-panel-example",
            "dialog-export",
            "",
        ] {
            assert!(popup_anchor(caller, &at(1.0, 1.0)).is_err(), "{caller}");
        }
        for position in [
            at(f64::NAN, 0.0),
            at(0.0, f64::INFINITY),
            at(100_001.0, 0.0),
            at(0.0, -100_001.0),
        ] {
            assert!(popup_anchor("main", &position).is_err());
            assert!(popup_anchor("toolset-core-main", &position).is_err());
        }
    }

    const MAIN_MENU: [ToolbarMenuChoice; 2] =
        [ToolbarMenuChoice::Customize, ToolbarMenuChoice::Hide];
    const HIDE_ONLY: [ToolbarMenuChoice; 1] = [ToolbarMenuChoice::Hide];

    #[test]
    fn core_toolbars_get_customize_on_main_only_and_hide_for_themselves() {
        assert_eq!(
            toolbar_menu_items("toolset-core-main", "core.main", Some("core.main")),
            Ok(MAIN_MENU.to_vec())
        );
        assert_eq!(
            toolbar_menu_items(
                "toolset-core-structure",
                "core.structure",
                Some("core.structure")
            ),
            Ok(HIDE_ONLY.to_vec())
        );
        assert_eq!(
            toolbar_menu_items("toolset-user-quick", "user.quick", Some("user.quick")),
            Ok(HIDE_ONLY.to_vec())
        );
        // The labels and ids are Rust's own, in a fixed order, with a separator between the two.
        let menu = toolbar_popup_items(&MAIN_MENU);
        assert_eq!(
            menu.items,
            vec![
                PopupItem::Item {
                    id: "canvas-context:toolbar:customize".into(),
                    text: "Customize Toolbar…".into(),
                    enabled: true,
                    checked: None
                },
                PopupItem::Separator,
                PopupItem::Item {
                    id: "canvas-context:toolbar:hide".into(),
                    text: "Hide Toolbar".into(),
                    enabled: true,
                    checked: None
                }
            ]
        );
        assert_eq!(
            menu.selectable,
            HashSet::from([
                "canvas-context:toolbar:customize".into(),
                "canvas-context:toolbar:hide".into()
            ])
        );
        assert_eq!(
            serde_json::to_value(MAIN_MENU).unwrap(),
            json!(["customize", "hide"])
        );
    }

    #[test]
    fn a_malicious_plugin_toolbar_gets_hide_for_its_own_toolset_and_nothing_else() {
        let caller = "toolset-plugin-evil-tools";
        let own = Some("plugin.evil.tools");
        // Its own toolset: Hide alone, with Rust's label, never Customize.
        assert_eq!(
            toolbar_menu_items(caller, "plugin.evil.tools", own),
            Ok(HIDE_ONLY.to_vec())
        );
        let menu = toolbar_popup_items(&HIDE_ONLY);
        assert_eq!(
            menu.items,
            vec![PopupItem::Item {
                id: "canvas-context:toolbar:hide".into(),
                text: "Hide Toolbar".into(),
                enabled: true,
                checked: None
            }]
        );
        // Another toolset's id, Main's included, or a label-colliding spelling of its own: refused.
        for other in [
            "core.main",
            "core.structure",
            "plugin.other.tools",
            "plugin.evil-tools",
            "plugin.evil.tools ",
            "",
        ] {
            assert!(toolbar_menu_items(caller, other, own).is_err(), "{other:?}");
        }
        // A window whose label claims Main's toolset but is a plugin window: no Customize, and the
        // id must still be the one Rust recorded for that window.
        assert!(
            toolbar_menu_items("toolset-plugin-core-main", "core.main", Some("core.main")).is_err()
        );
        // A window Rust never created as a toolbar, or whose record names another window's toolset.
        assert!(toolbar_menu_items(caller, "plugin.evil.tools", None).is_err());
        assert!(toolbar_menu_items(caller, "core.main", Some("core.main")).is_err());
        // Extra items, custom labels and checked or disabled state have nowhere to go: the command
        // takes the toolset id alone, and only the fixed items can be chosen.
        let source = include_str!("canvas_context_menu.rs");
        let command = source
            .split("pub(crate) async fn popup_toolbar_context_menu<R: Runtime>(")
            .nth(1)
            .unwrap()
            .split(") -> Result<Option<ToolbarMenuChoice>, String>")
            .next()
            .unwrap();
        assert_eq!(
            command.split_whitespace().collect::<Vec<_>>(),
            [
                "app:",
                "AppHandle<R>,",
                "window:",
                "WebviewWindow<R>,",
                "toolset_id:",
                "String,"
            ]
        );
        for spoofed in [
            "canvas-context:1:0",
            "canvas-context:toolbar:customize ",
            "view.customizeMainToolbar",
            "Hide Toolbar",
        ] {
            assert_eq!(ToolbarMenuChoice::from_menu_id(spoofed), None, "{spoofed}");
        }
    }

    #[test]
    fn non_toolbar_windows_get_no_toolbar_menu() {
        for caller in [
            "main",
            "toolset-popover-core-main",
            "toolset-tooltip",
            "toolset-core-",
            "toolset-plugin-",
            "plugin-panel-example",
            "preferences",
            "",
        ] {
            assert!(
                toolbar_menu_items(caller, "core.main", Some("core.main")).is_err(),
                "{caller}"
            );
        }
    }

    #[test]
    fn windows_presents_the_toolbar_menu_only_while_chemdraft_owns_the_foreground() {
        let own = 4242;
        // Windows: SetForegroundWindow precedes TrackPopupMenu, so only our own foreground passes.
        assert!(toolbar_menu_may_present(true, Some(own), own));
        assert!(!toolbar_menu_may_present(true, Some(7), own));
        assert!(!toolbar_menu_may_present(true, None, own));
        // macOS and Linux present without activating the document window.
        assert!(toolbar_menu_may_present(false, Some(7), own));
        assert!(toolbar_menu_may_present(false, None, own));
        assert_eq!(POPUP_ACTIVATES_DOCUMENT, cfg!(windows));
        // The check runs on the toolbar path only, before the popup, with this process's id.
        let popup = include_str!("canvas_context_menu.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        let compact: String = popup.split_whitespace().collect();
        assert!(compact
            .contains("present(app,toolbar_popup_items(&choices),PopupAnchor::Pointer,true,)"));
        assert!(compact.contains("present(app,converted,anchor,false)"));
        let gate = popup.find("foreground_process(),").unwrap();
        assert!(
            gate < popup
                .find("menu.popup(document.as_ref().window())")
                .unwrap()
        );
        assert!(popup.contains("std::process::id()"));
    }
}
