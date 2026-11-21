//! Keep the embedded document's drawing tools on their owner-specific event routes without
//! granting the document access to Tauri's application-wide event commands.

#[cfg(windows)]
use tauri::{Emitter, Listener};

#[cfg(any(windows, test))]
const TO_TOOLSET: &[&str] = &[
    "chemdraft://dismiss-toolset-popovers",
    "chemdraft://palette-tooltip-hide",
    "chemdraft://palette-tooltip-show",
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

#[cfg(windows)]
pub(crate) const NATIVE_POPOVER_CLOSE: &str = "chemdraft://office-popover-native-close";

#[cfg(windows)]
const FROM_TOOLSET: &[&str] = &[
    NATIVE_POPOVER_CLOSE,
    "chemdraft://bond-stereo-popover-action",
    "chemdraft://dismiss-toolset-popovers",
    "chemdraft://palette-command-cancel",
    "chemdraft://palette-command-commit",
    "chemdraft://palette-command-preview",
    "chemdraft://palette-inspector-action",
    "chemdraft://palette-pointer",
    "chemdraft://palette-pointer-leave",
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
    "chemdraft://toolset-window-state",
];

#[cfg(windows)]
const SHARED_SETTINGS: &[&str] = &[
    "chemdraft://compound-layout-settings",
    "chemdraft://drawing-settings",
    "chemdraft://electron-mark-editing-settings",
    "chemdraft://keybinding-settings",
];

#[cfg(any(windows, test))]
fn outbound_event(owner: &str, event: &str) -> Result<String, String> {
    if !TO_TOOLSET.contains(&event) {
        return Err("This event is unavailable to Office editing tools".into());
    }
    super::bridge::owner_id(owner)?;
    Ok(format!("{event}/{owner}"))
}

#[tauri::command]
pub(crate) fn office_toolset_emit(
    window: tauri::WebviewWindow,
    event: String,
    payload: Option<serde_json::Value>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let event = outbound_event(window.label(), &event)?;
        window.emit(&event, payload).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (window, event, payload);
        Err("Office embedded-object editing requires Windows".into())
    }
}

#[cfg(windows)]
pub(super) fn attach(window: &tauri::WebviewWindow) -> Vec<tauri::EventId> {
    let owned = FROM_TOOLSET
        .iter()
        .map(|&event| (event, format!("{event}/{}", window.label())));
    let settings = SHARED_SETTINGS
        .iter()
        .map(|&event| (event, event.to_owned()));
    owned
        .chain(settings)
        .map(|(name, route)| {
            let target = window.clone();
            window.listen(route, move |event| deliver(&target, name, event.payload()))
        })
        .collect()
}

#[cfg(windows)]
pub(super) fn deliver(window: &tauri::WebviewWindow, name: &str, payload: &str) {
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
        assert_eq!(outbound_event(owner, event), Ok(format!("{event}/{owner}")));
        assert!(outbound_event(owner, "chemdraft://palette-command").is_err());
        assert!(outbound_event(owner, "chemdraft://keybinding-settings").is_err());
        assert!(outbound_event(owner, "chemdraft://toolset-active-tool/office-object-18").is_err());
        assert!(outbound_event("main", event).is_err());
    }
}
