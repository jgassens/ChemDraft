use std::collections::BTreeMap;

use tauri::ipc::Origin;
use tauri::utils::{
    acl::{capability::Capability, manifest::Manifest, resolved::Resolved},
    platform::Target,
};

fn assert_shipped_access(label: &str, commands: &[&str], allowed: bool) {
    // These are the build.rs outputs consumed by generate_context!(), including every app
    // capability and the locked core/plugin manifests. Resolve them exactly as Tauri does,
    // without a display or a second generate_context!() (which duplicates macOS plist symbols).
    let acl: BTreeMap<String, Manifest> = serde_json::from_str(include_str!(concat!(
        env!("OUT_DIR"),
        "/acl-manifests.json"
    )))
    .expect("generated permission manifests");
    let capabilities: BTreeMap<String, Capability> =
        serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/capabilities.json")))
            .expect("generated app capabilities");
    let resolved =
        Resolved::resolve(&acl, capabilities, Target::current()).expect("resolve shipped ACL");
    let authority = tauri::runtime_authority!(acl, resolved);
    for command in commands {
        assert_eq!(
            authority
                .resolve_access(command, label, label, &Origin::Local)
                .is_some(),
            allowed,
            "shipped ACL: {label} access to {command} must be {allowed}"
        );
    }
}

#[test]
fn main_can_emit_panel_snapshots_and_replies() {
    // Tauri 2.11.2 applies denies by origin, ignoring their capability's window patterns.
    // A panel-only deny therefore breaks main too; checking strings or window globs misses it.
    assert_shipped_access("main", &["plugin:event|emit", "plugin:event|emit_to"], true);
}

#[test]
fn panels_cannot_bypass_authenticated_forwarders_with_event_emission() {
    assert_shipped_access(
        "plugin-panel-x",
        &["plugin:event|emit", "plugin:event|emit_to"],
        false,
    );
}

#[test]
fn panels_can_forward_requests_and_subscribe_to_replies() {
    assert_shipped_access(
        "plugin-panel-x",
        &[
            "plugin_panel_action_forward",
            "plugin_panel_event_forward",
            "plugin:event|listen",
            "plugin:event|unlisten",
        ],
        true,
    );
}

#[test]
fn only_panels_can_control_their_native_full_size_state() {
    assert_shipped_access("plugin-panel-x", &["set_plugin_panel_full_size"], true);
    for label in [
        "main",
        "preferences",
        "toolset-core-main",
        "dialog-export",
        "spin3d-debugger",
    ] {
        assert_shipped_access(label, &["set_plugin_panel_full_size"], false);
    }
    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/plugin-panel.json")).unwrap();
    let permissions: Vec<_> = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p.as_str().unwrap())
        .collect();
    assert_eq!(
        permissions,
        vec![
            "core:app:default",
            "core:path:default",
            "core:window:default",
            "core:webview:default",
            "core:image:default",
            "core:resources:default",
            "core:event:allow-listen",
            "core:event:allow-unlisten",
            "allow-plugin-panel-action-forward",
            "allow-plugin-panel-event-forward",
            "core:window:allow-hide",
            "core:window:allow-outer-position",
            "core:window:allow-scale-factor",
            "allow-register-plugin-panel-input-focus",
            "allow-set-plugin-panel-input-focus",
            "allow-set-plugin-panel-full-size",
            "core:window:allow-set-position",
            "core:window:allow-set-size",
        ]
    );
    assert_shipped_access(
        "plugin-panel-x",
        &[
            "plugin:fs|write_file",
            "plugin:dialog|open",
            "plugin:dialog|save",
            "plugin:dialog|message",
            "read_clipboard_payload",
            "write_clipboard_items",
            "write_clipboard_text_items",
            "write_clipboard_image",
            "open_plugin_panel_window",
        ],
        false,
    );
}
