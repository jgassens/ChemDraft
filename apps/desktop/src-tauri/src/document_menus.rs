//! Per-document menu authority; utilities and the runtime never publish or select snapshots.
use std::{collections::HashMap, sync::Mutex};

use super::{
    document_windows::DocumentWindowRegistry, PluginMenuItemInput, ToolbarMenuEntry, ViewMenuState,
};

pub const NEW_WINDOW: &str = "window.new";
pub const CLOSE_WINDOW: &str = "window.close";
pub const ACTIVATE_PREFIX: &str = "window.activate.";
const SOURCE_PREFIX: &str = "document-menu:";

#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandState {
    pub command_id: String,
    pub enabled: bool,
    pub checked: Option<bool>,
}

#[derive(Clone, Default, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub entries: Vec<ToolbarMenuEntry>,
    pub view: ViewMenuState,
    pub plugin_items: Vec<PluginMenuItemInput>,
    pub commands: Vec<CommandState>,
    pub title: String,
}

#[derive(Default)]
pub struct DocumentMenus {
    snapshots: Mutex<HashMap<String, (u64, Snapshot)>>,
    pub pending_open: Mutex<Option<String>>,
}

impl DocumentMenus {
    pub fn snapshot(&self, registry: &DocumentWindowRegistry, label: &str) -> Snapshot {
        let Some(window) = registry.owner_of(label).filter(|w| w.native_label == label) else {
            return Snapshot::default();
        };
        self.snapshots
            .lock()
            .unwrap()
            .get(&window.window_id)
            .filter(|(incarnation, _)| *incarnation == window.incarnation)
            .map(|(_, snapshot)| snapshot.clone())
            .unwrap_or_default()
    }

    pub fn update(
        &self,
        registry: &DocumentWindowRegistry,
        label: &str,
        update: impl FnOnce(&mut Snapshot),
    ) -> Result<(Snapshot, Snapshot), String> {
        let window = registry
            .owner_of(label)
            .filter(|w| w.native_label == label)
            .ok_or("Only a registered document window can publish a menu snapshot.")?;
        let mut snapshots = self.snapshots.lock().unwrap();
        let entry = snapshots
            .entry(window.window_id)
            .or_insert_with(|| (window.incarnation, Snapshot::default()));
        if entry.0 != window.incarnation {
            *entry = (window.incarnation, Snapshot::default());
        }
        let previous = entry.1.clone();
        update(&mut entry.1);
        Ok((previous, entry.1.clone()))
    }

    pub fn remove(&self, window_id: &str) {
        self.snapshots.lock().unwrap().remove(window_id);
    }
}

/// Windows menu events have no HWND in Tauri/muda. Encode the source in every routed leaf id.
/// Length framing preserves document ids and command ids without separator ambiguity.
pub fn item_id(source: Option<&str>, command: &str) -> String {
    match source {
        Some(label) => format!("{SOURCE_PREFIX}{}:{label}{command}", label.len()),
        None => command.into(),
    }
}

pub fn decode_item(id: &str) -> Option<(&str, &str)> {
    let rest = id.strip_prefix(SOURCE_PREFIX)?;
    let (length, rest) = rest.split_once(':')?;
    let length: usize = length.parse().ok()?;
    if length == 0 || !rest.is_char_boundary(length) {
        return None;
    }
    let (label, command) = rest.split_at(length);
    if command.is_empty() {
        return None;
    }
    Some((label, command))
}

pub fn target(
    registry: &DocumentWindowRegistry,
    is_macos: bool,
    source: Option<&str>,
) -> Option<String> {
    if is_macos {
        registry.active_document_window().map(|w| w.native_label)
    } else {
        let source = source?;
        registry
            .owner_of(source)
            .filter(|w| {
                w.native_label == source && registry.document_window(&w.window_id).is_some()
            })
            .map(|w| w.native_label)
    }
}

pub fn installation_labels(
    registry: &DocumentWindowRegistry,
    is_macos: bool,
) -> Vec<Option<String>> {
    if is_macos {
        vec![None]
    } else {
        registry
            .all_document_windows()
            .into_iter()
            .filter(|w| registry.document_window(&w.window_id).is_some())
            .map(|w| Some(w.native_label))
            .collect()
    }
}

pub fn enabled_without_document(command: &str) -> bool {
    matches!(
        command,
        "document.new" | "document.open" | NEW_WINDOW | "app.quit" | "app.checkForUpdates"
    )
}

/// Tauri's Windows message hook tries every installed HACCEL, regardless of its owner HWND.
/// Inactive document menus must not supply a competing, source-encoded accelerator table.
pub fn owns_accelerators(is_macos: bool, source: Option<&str>, active: Option<&str>) -> bool {
    is_macos || source.is_some_and(|source| Some(source) == active)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn documents() -> DocumentWindowRegistry {
        let registry = DocumentWindowRegistry::with_main();
        registry.set_ready("main");
        registry.register("b", "doc-b").unwrap();
        registry.set_ready("b");
        registry.mark_activated("main");
        registry
    }
    #[test]
    fn platform_routing_and_installation_exclude_all_utilities() {
        let registry = documents();
        assert_eq!(installation_labels(&registry, true), vec![None]);
        assert_eq!(
            installation_labels(&registry, false),
            vec![Some("doc-b".into()), Some("main".into())]
        );
        assert_eq!(
            target(&registry, true, Some("doc-b")).as_deref(),
            Some("main")
        );
        assert_eq!(
            target(&registry, false, Some("doc-b")).as_deref(),
            Some("doc-b")
        );
        for utility in [
            "preferences",
            "toolset-core-main",
            "toolset-popover-bond",
            "toolset-tooltip",
            "dialog-main-pageSize-1",
            "plugin-panel-test",
            "runtime",
        ] {
            assert!(!registry.mark_activated(utility));
            assert_eq!(
                target(&registry, true, Some(utility)).as_deref(),
                Some("main")
            );
            assert!(target(&registry, false, Some(utility)).is_none());
            assert!(DocumentMenus::default()
                .update(&registry, utility, |_| {})
                .is_err());
        }
        registry.mark_activated("doc-b");
        assert_eq!(target(&registry, true, None).as_deref(), Some("doc-b"));
        registry.remove("main");
        registry.remove("b");
        assert!(target(&registry, true, None).is_none());
        assert_eq!(installation_labels(&registry, true), vec![None]);
        assert!(installation_labels(&registry, false).is_empty());
        for id in ["document.new", "document.open", NEW_WINDOW] {
            assert!(enabled_without_document(id));
        }
        for id in [
            "document.save",
            "edit.undo",
            CLOSE_WINDOW,
            "view.toggleRulers",
        ] {
            assert!(!enabled_without_document(id));
        }
    }
    #[test]
    fn snapshots_survive_activation_independently_and_never_leak_into_recreated_windows() {
        let registry = documents();
        let menus = DocumentMenus::default();
        menus
            .update(&registry, "main", |s| {
                s.title = "A".into();
                s.view.has_multiple_document_tabs = true;
                s.commands.push(CommandState {
                    command_id: "edit.undo".into(),
                    enabled: true,
                    checked: None,
                });
            })
            .unwrap();
        menus
            .update(&registry, "doc-b", |s| {
                s.title = "B".into();
                s.view.rulers_visible = false;
            })
            .unwrap();
        registry.mark_activated("doc-b");
        let a = menus.snapshot(&registry, "main");
        let b = menus.snapshot(&registry, "doc-b");
        assert_eq!(a.title, "A");
        assert_eq!(b.title, "B");
        assert!(a.view.has_multiple_document_tabs);
        assert!(!b.view.has_multiple_document_tabs);
        assert!(a.view.rulers_visible);
        assert!(!b.view.rulers_visible);
        assert_eq!(a.commands.len(), 1);
        assert!(b.commands.is_empty());
        registry.remove("main");
        registry.register("main", "main").unwrap();
        registry.set_ready("main");
        assert!(menus.snapshot(&registry, "main").title.is_empty());
    }
    #[test]
    fn source_ids_round_trip_without_confusing_commands_and_windows() {
        for label in ["main", "doc-a:b", "doc-α"] {
            let id = item_id(Some(label), "window.activate.doc-b");
            assert_eq!(decode_item(&id), Some((label, "window.activate.doc-b")));
        }
        for invalid in [
            "edit.undo",
            "document-menu:0:x",
            "document-menu:999:x",
            "document-menu:1:αx",
            "document-menu:4:main",
        ] {
            assert!(decode_item(invalid).is_none());
        }
    }

    #[test]
    fn only_the_active_windows_document_supplies_routed_accelerators() {
        for is_macos in [true, false] {
            assert!(owns_accelerators(is_macos, Some("main"), Some("main")));
            assert_eq!(
                owns_accelerators(is_macos, Some("doc-b"), Some("main")),
                is_macos
            );
            assert_eq!(owns_accelerators(is_macos, Some("main"), None), is_macos);
            assert_eq!(owns_accelerators(is_macos, None, None), is_macos);
        }
    }
}
