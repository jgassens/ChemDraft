//! Document identities and routing authority. A2 still creates only the migrated first window.

use std::{collections::BTreeMap, sync::Mutex, time::Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DocumentWindowLifecycle {
    Creating,
    Ready,
    Closing,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocumentWindow {
    pub window_id: String,
    pub native_label: String,
    pub created_at: Instant,
    pub last_activated_at: Option<Instant>,
    pub lifecycle: DocumentWindowLifecycle,
}

#[derive(Default)]
pub struct DocumentWindowRegistry {
    windows: Mutex<BTreeMap<String, DocumentWindow>>,
}

impl DocumentWindowRegistry {
    pub fn with_main() -> Self {
        let registry = Self::default();
        // The first migrated/config-created window retains its label and saved-frame identity.
        registry
            .register("main", "main")
            .expect("the initial document registry is empty");
        registry
    }

    /// Only the document label namespace may be registered. Utilities cannot become documents.
    pub fn register(&self, window_id: &str, native_label: &str) -> Result<(), String> {
        if window_id.is_empty()
            // The first window retains its migrated label; future documents use their own namespace.
            || !(native_label == "main"
                || native_label
                    .strip_prefix("doc-")
                    .is_some_and(|id| !id.is_empty()))
        {
            return Err("A document window requires an id and a document label.".into());
        }
        let mut windows = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        if windows.contains_key(window_id)
            || windows
                .values()
                .any(|window| window.native_label == native_label)
        {
            return Err("The document window id or label is already registered.".into());
        }
        windows.insert(
            window_id.into(),
            DocumentWindow {
                window_id: window_id.into(),
                native_label: native_label.into(),
                created_at: Instant::now(),
                last_activated_at: None,
                lifecycle: DocumentWindowLifecycle::Creating,
            },
        );
        Ok(())
    }

    pub fn set_ready(&self, window_id: &str) -> bool {
        let mut windows = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        let Some(window) = windows.get_mut(window_id) else {
            return false;
        };
        if window.lifecycle == DocumentWindowLifecycle::Closing {
            return false;
        }
        window.lifecycle = DocumentWindowLifecycle::Ready;
        true
    }

    /// Takes a native label, as supplied by a focus event. Utility focus is ignored.
    pub fn mark_activated(&self, label: &str) -> bool {
        let mut windows = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        let Some(window) = windows
            .values_mut()
            .find(|window| window.native_label == label)
        else {
            return false;
        };
        if window.lifecycle == DocumentWindowLifecycle::Closing {
            return false;
        }
        window.last_activated_at = Some(Instant::now());
        true
    }

    pub fn begin_closing(&self, window_id: &str) -> bool {
        let mut windows = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        let Some(window) = windows.get_mut(window_id) else {
            return false;
        };
        window.lifecycle = DocumentWindowLifecycle::Closing;
        true
    }

    pub fn remove(&self, window_id: &str) -> Option<DocumentWindow> {
        self.windows
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(window_id)
    }

    pub fn active_document_window(&self) -> Option<DocumentWindow> {
        self.windows
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|window| window.lifecycle == DocumentWindowLifecycle::Ready)
            .max_by_key(|window| (window.last_activated_at, window.created_at))
            .cloned()
    }

    pub fn is_document_window(&self, label: &str) -> bool {
        self.windows
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .any(|window| window.native_label == label)
    }

    /// Until explicit ownership lands, existing utilities all belong to the migrated main window.
    /// The hidden runtime is an application service, not an owned document utility.
    pub fn owner_of(&self, label: &str) -> Option<DocumentWindow> {
        let windows = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(window) = windows.values().find(|window| window.native_label == label) {
            return Some(window.clone());
        }
        if label.starts_with("toolset-")
            || label.starts_with("dialog-")
            || label.starts_with("plugin-panel-")
            || matches!(label, "preferences" | "spin3d-debugger")
        {
            // A1 migration ownership: explicit per-utility owners/labels land in A4/A5.
            return windows.get("main").cloned();
        }
        None
    }

    pub fn all_document_windows(&self) -> Vec<DocumentWindow> {
        self.windows
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::{DocumentWindowLifecycle as Lifecycle, DocumentWindowRegistry};

    #[test]
    fn registers_unique_ids_and_labels_in_creating_state() {
        let registry = DocumentWindowRegistry::with_main();
        let main = registry.all_document_windows().remove(0);
        assert_eq!(main.window_id, "main");
        assert_eq!(main.native_label, "main");
        assert_eq!(main.lifecycle, Lifecycle::Creating);
        assert_eq!(main.last_activated_at, None);
        assert!(registry.active_document_window().is_none());
        assert!(registry.register("main", "doc-other").is_err());
        assert!(registry.register("other", "main").is_err());
        assert!(registry.register("", "doc-other").is_err());
        assert!(registry.register("other", "doc-").is_err());
        assert!(registry.register("other", "doc-other").is_ok());
        assert_eq!(registry.all_document_windows().len(), 2);
        assert!(registry.is_document_window("doc-other"));
        assert!(!registry.is_document_window("other"));
    }

    #[test]
    fn ready_activation_and_closing_preserve_lifecycle() {
        let registry = DocumentWindowRegistry::with_main();
        assert!(registry.set_ready("main"));
        assert_eq!(registry.active_document_window().unwrap().window_id, "main");
        assert!(registry.mark_activated("main"));
        let main = registry.active_document_window().unwrap();
        assert!(main.last_activated_at.unwrap() >= main.created_at);
        registry.register("other", "doc-other").unwrap();
        assert!(registry.set_ready("other"));
        // A new ready window must not steal activation from a focused document.
        assert_eq!(registry.active_document_window().unwrap().window_id, "main");
        assert!(registry.mark_activated("doc-other"));
        assert_eq!(
            registry.active_document_window().unwrap().window_id,
            "other"
        );
        assert!(registry.begin_closing("other"));
        assert!(!registry.set_ready("other"));
        assert!(!registry.mark_activated("doc-other"));
        assert_eq!(registry.active_document_window().unwrap().window_id, "main");
        assert_eq!(
            registry.remove("other").unwrap().lifecycle,
            Lifecycle::Closing
        );
        assert!(!registry.is_document_window("doc-other"));
        assert!(registry.remove("other").is_none());
        assert!(!registry.set_ready("missing"));
        assert!(!registry.begin_closing("missing"));
        assert!(!registry.mark_activated("missing"));
        assert!(registry.begin_closing("main"));
        assert!(registry.active_document_window().is_none());
        registry.remove("main");
        assert!(registry.all_document_windows().is_empty());
    }

    #[test]
    fn utilities_and_runtime_never_count_as_documents_or_steal_activation() {
        let registry = DocumentWindowRegistry::with_main();
        registry.set_ready("main");
        registry.mark_activated("main");
        for label in [
            "toolset-main",
            "toolset-popover-main",
            "toolset-tooltip",
            "dialog-main-pageSize-1",
            "plugin-panel-example",
            "preferences",
            "spin3d-debugger",
            "runtime",
        ] {
            assert!(!registry.is_document_window(label), "{label}");
            assert!(!registry.mark_activated(label), "{label}");
            assert!(registry.register(label, label).is_err(), "{label}");
            assert_eq!(registry.active_document_window().unwrap().window_id, "main");
            if label == "runtime" {
                assert!(registry.owner_of(label).is_none());
            } else {
                assert_eq!(registry.owner_of(label).unwrap().window_id, "main");
            }
        }
        assert_eq!(registry.all_document_windows().len(), 1);
        assert_eq!(registry.owner_of("main").unwrap().window_id, "main");
        registry.register("other", "doc-other").unwrap();
        assert_eq!(registry.owner_of("doc-other").unwrap().window_id, "other");
        assert!(registry.owner_of("unknown").is_none());
        registry.remove("main");
        assert!(registry.owner_of("toolset-main").is_none());
    }
}
