//! Keep the embedded document's drawing tools on their owner-specific event routes without
//! granting the document access to Tauri's application-wide event commands.

#[cfg(windows)]
use tauri::{Listener, Manager, Runtime, WindowEvent};

#[cfg(any(windows, test))]
const TO_TOOLSET: &[&str] = &[
    "chemdraft://bond-stereo-popover-action",
    "chemdraft://dismiss-toolset-popovers",
    "chemdraft://toolset-active-tool",
    "chemdraft://toolset-command-specs",
    "chemdraft://toolset-customize-mode",
    "chemdraft://toolset-definitions",
    "chemdraft://toolset-flyout-key",
    "chemdraft://toolset-flyout-opening",
    "chemdraft://toolset-flyout-closed",
    "chemdraft://toolset-layout-state",
    "chemdraft://toolset-popover-closed",
    "chemdraft://toolset-popover-content",
    "chemdraft://toolset-text-style",
];

#[cfg(any(windows, test))]
const BETWEEN_UTILITIES: &[&str] = &[
    "chemdraft://toolset-popover-content-request",
    "chemdraft://toolset-popover-release",
];

#[cfg(windows)]
pub(crate) const NATIVE_POPOVER_CLOSE: &str = "chemdraft://office-popover-native-close";

#[cfg(any(windows, test))]
const FROM_TOOLSET: &[&str] = &[
    "chemdraft://bond-stereo-popover-action",
    "chemdraft://dismiss-toolset-popovers",
    "chemdraft://palette-command-cancel",
    "chemdraft://palette-command-commit",
    "chemdraft://palette-command-preview",
    "chemdraft://palette-inspector-action",
    "chemdraft://toolset-active-tool-request",
    "chemdraft://toolset-command-specs-request",
    "chemdraft://toolset-customize-mode-request",
    "chemdraft://toolset-definitions-request",
    "chemdraft://toolset-flyout-closed",
    "chemdraft://toolset-flyout-key",
    "chemdraft://toolset-flyout-opening",
    "chemdraft://toolset-layout-edit",
    "chemdraft://toolset-layout-state-request",
    "chemdraft://toolset-popover-closed",
    "chemdraft://toolset-popover-content",
    "chemdraft://toolset-popover-content-request",
    "chemdraft://toolset-popover-release",
    "chemdraft://toolset-text-style-request",
];

#[cfg(any(windows, test))]
const TO_TOOLTIP: &[&str] = &[
    "chemdraft://palette-tooltip-hide",
    "chemdraft://palette-tooltip-show",
];

#[cfg(windows)]
const SHARED_SETTINGS: &[&str] = &[
    "chemdraft://compound-layout-settings",
    "chemdraft://drawing-settings",
    "chemdraft://electron-mark-editing-settings",
    "chemdraft://keybinding-settings",
];

#[cfg(any(windows, test))]
fn utility_parts(label: &str) -> Option<(&str, &str)> {
    let (owner, kind) = label.strip_prefix("office-utility-")?.split_once("--")?;
    super::bridge::owner_id(owner).ok()?;
    (kind.starts_with("toolset-core-")
        || kind.starts_with("toolset-popover-")
        || kind == "toolset-tooltip")
        .then_some((owner, kind))
}

#[cfg(any(windows, test))]
fn outbound_owner<'a>(sender: &'a str, event: &str) -> Result<&'a str, String> {
    let (owner, allowed) = if super::bridge::owner_id(sender).is_ok() {
        (
            sender,
            TO_TOOLSET.contains(&event) || TO_TOOLTIP.contains(&event),
        )
    } else if let Some((owner, kind)) = utility_parts(sender) {
        let allowed = kind != "toolset-tooltip"
            && (FROM_TOOLSET.contains(&event) || TO_TOOLTIP.contains(&event));
        (owner, allowed)
    } else {
        return Err("This window does not own an Office editing tool".into());
    };
    if !allowed {
        return Err("This event is unavailable to Office editing tools".into());
    }
    Ok(owner)
}

#[cfg(any(windows, test))]
fn receives(owner: &str, target: &str, event: &str) -> bool {
    if target == owner {
        return FROM_TOOLSET.contains(&event);
    }
    match utility_parts(target) {
        Some((label, "toolset-tooltip")) if label == owner => TO_TOOLTIP.contains(&event),
        Some((label, _)) if label == owner => {
            TO_TOOLSET.contains(&event) || BETWEEN_UTILITIES.contains(&event)
        }
        _ => false,
    }
}

#[tauri::command]
pub(crate) fn office_toolset_emit(
    window: tauri::WebviewWindow,
    event: String,
    payload: Option<serde_json::Value>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        if event == super::bridge::EDITOR_PAINTED {
            return super::bridge::editor_painted(&window);
        }
        if event == "chemdraft://bond-stereo-popover-action"
            && payload
                .as_ref()
                .and_then(|value| value.get("action"))
                .and_then(|value| value.as_str())
                != Some("close")
        {
            return Err("Use the toolset command bridge to choose bond geometry".into());
        }
        let owner = outbound_owner(window.label(), &event)?;
        let app = window.app_handle();
        if app.get_webview_window(owner).is_none() {
            return Err("The owner Office editor has closed".into());
        }
        let payload = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
        for target in app.webview_windows().into_values() {
            if receives(owner, target.label(), &event) {
                deliver(&target, &event, &payload);
            }
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (window, event, payload);
        Err("Office embedded-object editing requires Windows".into())
    }
}

#[cfg(windows)]
pub(super) fn attach_settings<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Vec<tauri::EventId> {
    SHARED_SETTINGS
        .iter()
        .map(|&name| {
            let target = window.clone();
            window.listen(name, move |event| deliver(&target, name, event.payload()))
        })
        .collect()
}

#[cfg(windows)]
pub(crate) fn attach_utility<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let Some((_, kind)) = utility_parts(window.label()) else {
        return;
    };
    if kind == "toolset-tooltip" {
        return;
    }
    let subscriptions = attach_settings(window);
    let app = window.app_handle().clone();
    let target = window.clone();
    window.on_window_event(move |event| {
        let name = match event {
            WindowEvent::Moved(_) => "tauri://move",
            WindowEvent::Resized(_) => "tauri://resize",
            WindowEvent::ScaleFactorChanged { .. } => "tauri://scale-change",
            WindowEvent::Destroyed => {
                for &subscription in &subscriptions {
                    app.unlisten(subscription);
                }
                return;
            }
            _ => return,
        };
        deliver(&target, name, "null");
    });
}

#[cfg(windows)]
pub(crate) fn deliver<R: Runtime>(window: &tauri::WebviewWindow<R>, name: &str, payload: &str) {
    let name = serde_json::to_string(&format!("chemdraft:office-toolset:{name}")).unwrap();
    let payload = serde_json::to_string(payload).unwrap();
    if let Err(error) = window.eval(format!(
        "window.dispatchEvent(new CustomEvent({name}, {{ detail: JSON.parse({payload}) }}))"
    )) {
        eprintln!("Could not deliver an Office toolset event: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn office_toolset_publishes_only_approved_events_to_its_own_route() {
        let owner = "office-object-17";
        let event = "chemdraft://toolset-active-tool";
        assert_eq!(outbound_owner(owner, event), Ok(owner));
        assert!(outbound_owner(owner, "chemdraft://palette-command").is_err());
        assert!(outbound_owner(owner, "chemdraft://keybinding-settings").is_err());
        assert!(outbound_owner(owner, "chemdraft://toolset-active-tool/office-object-18").is_err());
        assert!(outbound_owner("main", event).is_err());
    }

    #[test]
    fn only_the_editor_window_can_report_its_first_paint() {
        use super::super::bridge::{painted_sender, EDITOR_PAINTED};
        assert_eq!(painted_sender("office-object-17"), Ok("office-object-17"));
        for label in [
            "main",
            "office-object-",
            "office-object-17-x",
            "office-utility-office-object-17--toolset-core-main",
            "office-utility-office-object-17--toolset-popover-core-main",
            "office-utility-office-object-17--toolset-tooltip",
            "dialog-office-object-17-pageSize-1",
            "toolset-core-main",
        ] {
            assert!(painted_sender(label).is_err(), "{label}");
        }
        // Handled before routing, and never delivered to (or accepted from) another window.
        for list in [TO_TOOLSET, BETWEEN_UTILITIES, FROM_TOOLSET, TO_TOOLTIP] {
            assert!(!list.contains(&EDITOR_PAINTED));
        }
        assert!(outbound_owner("office-object-17", EDITOR_PAINTED).is_err());
        let source = include_str!("toolset_events.rs");
        let emit = &source[source.find("pub(crate) fn office_toolset_emit(").unwrap()..];
        let windows = &emit[emit.find("#[cfg(windows)]").unwrap()..];
        assert!(windows.starts_with(
            "#[cfg(windows)]\n    {\n        if event == super::bridge::EDITOR_PAINTED {\n            return super::bridge::editor_painted(&window);"
        ));
        // The office-object window already holds this grant; utilities that also hold it are
        // refused by `painted_sender`. No other capability grants it.
        let object = include_str!("../../capabilities/office-object.json");
        let toolset = include_str!("../../capabilities/office-toolset.json");
        assert!(
            object.contains("\"office-object-*\"") && object.contains("allow-office-toolset-emit")
        );
        assert!(!toolset.contains("\"office-object-*\""));
    }

    #[test]
    fn office_utilities_cannot_send_unscoped_or_cross_owner_events() {
        let sender = "office-utility-office-object-17--toolset-core-main";
        let preview = "chemdraft://palette-command-preview";
        let owner = outbound_owner(sender, preview).unwrap();
        assert_eq!(owner, "office-object-17");
        assert!(receives(owner, owner, preview));
        assert!(!receives(owner, "office-object-18", preview));
        assert!(!receives(owner, "main", preview));
        let tooltip = "chemdraft://palette-tooltip-show";
        assert!(receives(
            owner,
            "office-utility-office-object-17--toolset-tooltip",
            tooltip
        ));
        assert!(!receives(
            owner,
            "office-utility-office-object-18--toolset-tooltip",
            tooltip
        ));
        assert!(!receives(owner, "toolset-tooltip", tooltip));
        assert!(outbound_owner(sender, &format!("{preview}/office-object-18")).is_err());
        assert!(outbound_owner(sender, "chemdraft://file-open-request").is_err());
        assert!(outbound_owner("office-utility-main--toolset-core-main", preview).is_err());
        assert!(
            outbound_owner("office-utility-office-object-17--toolset-tooltip", preview).is_err()
        );
        assert!(outbound_owner("toolset-core-main", preview).is_err());
        for capability in [
            include_str!("../../capabilities/office-toolset.json"),
            include_str!("../../capabilities/office-tooltip.json"),
        ] {
            assert!(!capability.contains("core:event:") && !capability.contains("core:default"));
        }
    }
}
