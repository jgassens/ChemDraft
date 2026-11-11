//! Shared palettes follow the active document; an in-flight gesture keeps its captured target.
use crate::document_windows::DocumentWindowRegistry;
use std::{collections::BTreeMap, sync::Mutex};

#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PaletteTarget {
    pub window_id: String,
    pub tab_id: String,
}

#[derive(Default)]
pub struct PaletteRouting {
    tabs: Mutex<BTreeMap<String, String>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaletteRoutingState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<PaletteTarget>,
}

impl PaletteRouting {
    pub fn remember(&self, target: &PaletteTarget) {
        self.tabs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(target.window_id.clone(), target.tab_id.clone());
    }

    pub fn state(&self, registry: &DocumentWindowRegistry) -> PaletteRoutingState {
        let window_id = registry
            .active_document_window()
            .map(|window| window.window_id);
        let tabs = self.tabs.lock().unwrap_or_else(|e| e.into_inner());
        let target = window_id.as_ref().and_then(|id| {
            tabs.get(id).map(|tab_id| PaletteTarget {
                window_id: id.clone(),
                tab_id: tab_id.clone(),
            })
        });
        PaletteRoutingState { window_id, target }
    }
}

/// Resolve the captured id, never the currently active document or a utility owner fallback.
pub fn target_label(registry: &DocumentWindowRegistry, target: &PaletteTarget) -> Option<String> {
    if target.tab_id.is_empty() {
        return None;
    }
    registry
        .document_window(&target.window_id)
        .map(|window| window.native_label)
}

pub fn can_publish(
    registry: &DocumentWindowRegistry,
    caller: &str,
    target: &PaletteTarget,
) -> bool {
    registry.active_document_window().is_some_and(|window| {
        window.native_label == caller
            && window.window_id == target.window_id
            && !target.tab_id.is_empty()
    })
}

pub fn is_snapshot_event(event: &str) -> bool {
    matches!(
        event,
        "chemdraft://toolset-active-tool"
            | "chemdraft://toolset-text-style"
            | "chemdraft://toolset-command-specs"
            | "chemdraft://toolset-definitions"
            | "chemdraft://toolset-layout-state"
            | "chemdraft://toolset-customize-mode"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_payload_serializes_the_captured_target() {
        let payload = crate::ToolsetCommandPayload {
            command_id: "object.opacity:0.4".into(),
            target: PaletteTarget {
                window_id: "A".into(),
                tab_id: "tab-a".into(),
            },
        };
        assert_eq!(
            serde_json::to_value(payload).unwrap(),
            serde_json::json!({
                "commandId": "object.opacity:0.4",
                "target": { "windowId": "A", "tabId": "tab-a" }
            })
        );
        assert!(
            serde_json::from_value::<PaletteTarget>(serde_json::json!({ "windowId": "A" }))
                .is_err()
        );
    }

    #[test]
    fn publication_requires_the_active_document_and_a_snapshot_event() {
        let registry = DocumentWindowRegistry::with_main();
        let target = PaletteTarget {
            window_id: "main".into(),
            tab_id: "tab-a".into(),
        };
        assert!(!can_publish(&registry, "main", &target));
        assert!(target_label(&registry, &target).is_none());
        registry.set_ready("main");
        assert!(can_publish(&registry, "main", &target));
        for event in [
            "toolset-active-tool",
            "toolset-text-style",
            "toolset-command-specs",
            "toolset-definitions",
            "toolset-layout-state",
            "toolset-customize-mode",
        ] {
            assert!(is_snapshot_event(&format!("chemdraft://{event}")));
        }
        assert!(!is_snapshot_event("chemdraft://palette-command"));
        assert!(!can_publish(&registry, "toolset-main", &target));
        assert!(!can_publish(
            &registry,
            "main",
            &PaletteTarget {
                window_id: "other".into(),
                ..target.clone()
            }
        ));
        assert!(!can_publish(
            &registry,
            "main",
            &PaletteTarget {
                tab_id: String::new(),
                ..target
            }
        ));
    }

    #[test]
    fn captured_target_survives_activation_and_refuses_utilities_and_removed_windows() {
        let registry = DocumentWindowRegistry::with_main();
        registry.set_ready("main");
        registry.mark_activated("main");
        registry.register("B", "doc-b").unwrap();
        registry.set_ready("B");
        let target = PaletteTarget {
            window_id: "main".into(),
            tab_id: "tab-a".into(),
        };
        assert!(can_publish(&registry, "main", &target));
        registry.mark_activated("doc-b");
        assert_eq!(target_label(&registry, &target).as_deref(), Some("main"));
        assert!(!can_publish(&registry, "main", &target));
        assert!(!can_publish(&registry, "toolset-main", &target));
        assert!(target_label(
            &registry,
            &PaletteTarget {
                window_id: "toolset-main".into(),
                tab_id: "tab-a".into()
            }
        )
        .is_none());
        registry.remove("main");
        assert!(target_label(&registry, &target).is_none());
    }

    #[test]
    fn late_palette_gets_only_the_active_documents_latest_tab() {
        let registry = DocumentWindowRegistry::with_main();
        registry.set_ready("main");
        let routing = PaletteRouting::default();
        assert!(routing.state(&registry).target.is_none());
        let target = PaletteTarget {
            window_id: "main".into(),
            tab_id: "tab-a".into(),
        };
        routing.remember(&target);
        assert_eq!(routing.state(&registry).target, Some(target));
        registry.register("B", "doc-b").unwrap();
        registry.set_ready("B");
        registry.mark_activated("doc-b");
        assert!(routing.state(&registry).target.is_none());
        let target = PaletteTarget {
            window_id: "B".into(),
            tab_id: "tab-b".into(),
        };
        routing.remember(&target);
        assert_eq!(routing.state(&registry).target, Some(target));
    }
}
