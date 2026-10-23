use super::{
    cancel_plugin_panel_restore, dispatch_plugin_panel_open, plugin_panel_window_label,
    resume_deferred_plugin_panels, utility_suspension::UtilitySuspension, OpenPluginPanelRequest,
};
use std::sync::Mutex;

fn panel_request(panel_id: &str) -> OpenPluginPanelRequest {
    serde_json::from_value(serde_json::json!({ "panelId": panel_id, "title": "Report" })).unwrap()
}

#[test]
fn closed_panel_is_not_restored_but_surviving_window_is() {
    let mut state = UtilitySuspension::default();
    let toolbar = "toolset-art";
    let panel = "plugin-panel-v1x61x62";
    state.begin(
        [toolbar, panel].map(|label| (label.into(), true, false, true)),
        None,
    );
    state.closed(panel);
    // Destroyed can follow CloseRequested; cancellation is idempotent.
    state.closed(panel);
    assert_eq!(state.release(false).unwrap(), vec![toolbar]);
    assert!(!state.needs_restore(panel));
    assert!(!state.visible(panel, false));
    state.restored(toolbar);
    state.finish_restore();
    assert!(!state.active());
}

#[test]
fn removal_while_waiting_for_owner_restore_cancels_the_panel_retry() {
    let mut state = UtilitySuspension::default();
    state.begin(
        ["toolset-art", "plugin-panel-v1x61x62"].map(|label| (label.into(), true, false, true)),
        None,
    );
    state.release(false).unwrap();
    state.finish_restore(); // Owner still minimized; neither show succeeded.
    state.closed("plugin-panel-v1x61x62");
    assert_eq!(state.pending_restore().unwrap(), vec!["toolset-art"]);
}

#[test]
fn report_removed_during_suspension_cancels_deferred_creation_only_for_its_owner() {
    let state = Mutex::new(UtilitySuspension::default());
    state.lock().unwrap().begin([], None);
    // pluginPanelWindowId("a", "b") and pluginPanelWindowId("c", "b").
    for id in ["v1x61x62", "v1x63x62"] {
        dispatch_plugin_panel_open(&state, panel_request(id), false, |_| panic!("suspended"))
            .unwrap();
    }
    cancel_plugin_panel_restore(&state, r#"{"pluginId":"a","panelId":"b","revision":2}"#);
    assert!(!state
        .lock()
        .unwrap()
        .has_deferred_panel("plugin-panel-v1x61x62"));
    assert_eq!(
        state.lock().unwrap().release(false).unwrap(),
        vec!["plugin-panel-v1x63x62"]
    );
    let mut built = Vec::new();
    resume_deferred_plugin_panels(
        &state,
        || false,
        |request| {
            built.push(request.panel_id);
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(built, vec!["v1x63x62"]);
    assert!(!state.lock().unwrap().active());
    // Reinstallation alone supplies no fresh report/open request.
    resume_deferred_plugin_panels(&state, || false, |_| panic!("removed report replayed")).unwrap();
}

#[test]
fn removal_cancels_requests_already_drained_to_the_creation_worker() {
    let state = Mutex::new(UtilitySuspension::default());
    state.lock().unwrap().begin([], None);
    for id in ["v1x61x62", "v1x63x62"] {
        dispatch_plugin_panel_open(&state, panel_request(id), false, |_| panic!("suspended"))
            .unwrap();
    }
    state.lock().unwrap().release(false).unwrap();
    let mut builds = 0;
    resume_deferred_plugin_panels(
        &state,
        || false,
        |_| {
            builds += 1;
            // Both requests were drained before the first build. Cancelling the other must
            // prevent its build; cancelling this build must prevent its failure from requeueing.
            for owner in ["a", "c"] {
                cancel_plugin_panel_restore(
                    &state,
                    &serde_json::json!({"pluginId": owner, "panelId": "b"}).to_string(),
                );
            }
            Err("build failed after panel removal".into())
        },
    )
    .unwrap_err();
    assert_eq!(builds, 1);
    assert!(!state.lock().unwrap().active());
    resume_deferred_plugin_panels(&state, || false, |_| panic!("cancelled build retried")).unwrap();
}

#[test]
fn removal_bridge_matches_typescript_utf8_hex_and_ignores_malformed_payloads() {
    let state = Mutex::new(UtilitySuspension::default());
    let label = plugin_panel_window_label("v1x612e62x70c3a9"); // "a.b", "pé"
    state
        .lock()
        .unwrap()
        .begin([(label.clone(), true, false, true)], None);
    for payload in ["null", "{}", r#"{"pluginId":5,"panelId":"pé"}"#] {
        cancel_plugin_panel_restore(&state, payload);
        assert!(state.lock().unwrap().needs_restore(&label));
    }
    cancel_plugin_panel_restore(&state, r#"{"pluginId":"a.b","panelId":"pé","revision":3}"#);
    assert!(state.lock().unwrap().release(false).unwrap().is_empty());
    state.lock().unwrap().finish_restore();
    assert!(!state.lock().unwrap().active());
}

#[test]
fn fresh_report_after_removal_can_open_and_failed_live_build_still_retries() {
    let state = Mutex::new(UtilitySuspension::default());
    state.lock().unwrap().begin([], None);
    let request = panel_request("v1x61x62");
    dispatch_plugin_panel_open(&state, request.clone(), false, |_| panic!("suspended")).unwrap();
    cancel_plugin_panel_restore(&state, r#"{"pluginId":"a","panelId":"b"}"#);
    // Only a fresh explicit open may enroll the same identity again.
    dispatch_plugin_panel_open(&state, request, false, |_| panic!("suspended")).unwrap();
    assert_eq!(
        state.lock().unwrap().release(false).unwrap(),
        vec!["plugin-panel-v1x61x62"]
    );
    resume_deferred_plugin_panels(&state, || false, |_| Err("temporary build failure".into()))
        .unwrap_err();
    assert!(state.lock().unwrap().active());
    assert!(state
        .lock()
        .unwrap()
        .has_deferred_panel("plugin-panel-v1x61x62"));
    let mut builds = 0;
    resume_deferred_plugin_panels(
        &state,
        || false,
        |_| {
            builds += 1;
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(builds, 1);
    assert!(!state.lock().unwrap().active());
}
