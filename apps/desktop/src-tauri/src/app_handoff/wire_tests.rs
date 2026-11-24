use super::wire::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, path::Path};

#[test]
fn app_handoff_wire_fixtures_are_current() {
    // The marking request travels over the plugin Worker port, not the native launch endpoint.
    #[derive(Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct MarkRequest {
        object_id: String,
        anchors: Vec<String>,
    }
    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct HostIdentity {
        name: String,
        version: String,
    }
    #[derive(Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct SelectedAtoms {
        object_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        selected_atom_ids: Option<Vec<String>>,
    }
    let id = "0123456789abcdef0123456789abcdef";
    let mut values: BTreeMap<String, Value> = BTreeMap::from([
        (
            "mark-connection-points-request".into(),
            serde_json::to_value(MarkRequest {
                object_id: "linker".into(),
                anchors: vec!["anchor-1".into(), "anchor-2".into()],
            })
            .unwrap(),
        ),
        (
            "command-host-identity".into(),
            serde_json::to_value(HostIdentity {
                name: "ChemDraft".into(),
                version: "1.2.3".into(),
            })
            .unwrap(),
        ),
        (
            "selection-atoms".into(),
            serde_json::to_value(SelectedAtoms {
                object_id: "linker".into(),
                selected_atom_ids: Some(vec!["anchor-1".into()]),
            })
            .unwrap(),
        ),
        (
            "selection-atoms-empty".into(),
            serde_json::to_value(SelectedAtoms {
                object_id: "linker".into(),
                selected_atom_ids: Some(vec![]),
            })
            .unwrap(),
        ),
        (
            "selection-atoms-legacy".into(),
            serde_json::to_value(SelectedAtoms {
                object_id: "linker".into(),
                selected_atom_ids: None,
            })
            .unwrap(),
        ),
        (
            "choose-app-request".into(),
            encode(ChooseRequest {
                purpose: "Open the linker".into(),
            })
            .unwrap(),
        ),
        (
            "choose-app-chosen".into(),
            encode(ChooseResult::Chosen {
                app: ChosenApp {
                    app_id: id.into(),
                    display_name: "Crystal Builder".into(),
                },
            })
            .unwrap(),
        ),
        (
            "choose-app-cancelled".into(),
            encode(ChooseResult::Cancelled).unwrap(),
        ),
        (
            "status-request".into(),
            encode(StatusRequest { app_id: id.into() }).unwrap(),
        ),
        (
            "status-available".into(),
            encode(StatusResult {
                available: true,
                display_name: Some("Crystal Builder".into()),
                reason: None,
            })
            .unwrap(),
        ),
        (
            "status-unavailable".into(),
            encode(StatusResult {
                available: false,
                display_name: None,
                reason: Some("The chosen app changed.".into()),
            })
            .unwrap(),
        ),
        (
            "send-file-request".into(),
            encode(SendRequest {
                app_id: id.into(),
                file_name: "linker name".into(),
                extension: Extension::Cif,
                text: "data_linker\n".into(),
                warnings: Some(vec!["Isotopes are omitted.".into()]),
            })
            .unwrap(),
        ),
        ("send-file-sent".into(), encode(SendResult::Sent).unwrap()),
        (
            "send-file-declined".into(),
            encode(SendResult::Declined).unwrap(),
        ),
        (
            "run-companion-request".into(),
            encode(RunRequest {
                app_id: id.into(),
                pipeline: "mofBuild".into(),
                combination: "pcu-N16-2x2x2".into(),
                input: Some(Input {
                    extension: Extension::Xyz,
                    text: "2\n1\nC 0 0 0\nX 1 0 0\n0 1 S\n".into(),
                }),
                open_output: Some(true),
                warnings: None,
            })
            .unwrap(),
        ),
        (
            "run-companion-request-warnings".into(),
            encode(RunRequest {
                app_id: id.into(),
                pipeline: "mofBuild".into(),
                combination: "pcu-N16-2x2x2".into(),
                input: None,
                open_output: None,
                warnings: Some(vec![
                    "2 carboxylic acids cut to connection points (X).".into(),
                    "The chosen node supplies carboxylates 🧪.".into(),
                ]),
            })
            .unwrap(),
        ),
        (
            "run-companion-done".into(),
            encode(RunResult::Done {
                steps: vec![
                    StepResult {
                        id: "preflight".into(),
                        json: json!({"version":"1.1.1"}),
                    },
                    StepResult {
                        id: "build".into(),
                        json: json!({"ok":true,"tables":[]}),
                    },
                    StepResult {
                        id: "inspect".into(),
                        json: json!({"formula":"C8H4","n_atoms":12}),
                    },
                ],
                opened: true,
            })
            .unwrap(),
        ),
        (
            "run-companion-declined".into(),
            encode(RunResult::Declined).unwrap(),
        ),
    ]);
    for (name, code) in [
        ("app-missing", SendCode::AppMissing),
        ("app-changed", SendCode::AppChanged),
        ("launch-failed", SendCode::LaunchFailed),
        ("write-failed", SendCode::WriteFailed),
    ] {
        values.insert(
            format!("send-file-{name}"),
            encode(SendResult::Failed {
                code,
                message: "The app handoff could not send the file.".into(),
            })
            .unwrap(),
        );
    }
    for (name, code) in [
        ("app-missing", RunCode::AppMissing),
        ("app-changed", RunCode::AppChanged),
        ("tool-missing", RunCode::ToolMissing),
        ("bad-param", RunCode::BadParam),
        ("version-untested", RunCode::VersionUntested),
        ("timeout", RunCode::Timeout),
        ("exit-nonzero", RunCode::ExitNonzero),
        ("bad-output", RunCode::BadOutput),
        ("write-failed", RunCode::WriteFailed),
    ] {
        let diagnostic = (code == RunCode::ExitNonzero).then(|| Diagnostic {
            step: "build".into(),
            exit_code: Some(2),
            json: Some(json!({"ok":false,"summary":"The build failed."})),
            stderr_tail: Some("Build failed.".into()),
        });
        values.insert(
            format!("run-companion-{name}"),
            encode(RunResult::Failed {
                code,
                message: "The app handoff companion could not complete.".into(),
                diagnostic,
            })
            .unwrap(),
        );
    }
    let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("src")
        .join("appHandoff")
        .join("__fixtures__")
        .join("wire");
    let update = std::env::var("CHEMDRAFT_UPDATE_WIRE_FIXTURES").as_deref() == Ok("1");
    if update {
        fs::create_dir_all(&directory).unwrap();
    }
    for (name, value) in &values {
        let path = directory.join(format!("{name}.json"));
        if update {
            fs::write(
                &path,
                format!("{}\n", serde_json::to_string_pretty(value).unwrap()),
            )
            .unwrap();
        }
        let current: Value = serde_json::from_str(
            &fs::read_to_string(&path).unwrap_or_else(|_| panic!("Missing {}", path.display())),
        )
        .unwrap();
        assert_eq!(&current, value, "{name}.json");
        match name.as_str() {
            "mark-connection-points-request" => assert_eq!(
                serde_json::to_value(
                    serde_json::from_value::<MarkRequest>(current.clone()).unwrap()
                )
                .unwrap(),
                current
            ),
            "command-host-identity" => assert_eq!(
                serde_json::to_value(
                    serde_json::from_value::<HostIdentity>(current.clone()).unwrap()
                )
                .unwrap(),
                current
            ),
            "selection-atoms" | "selection-atoms-empty" | "selection-atoms-legacy" => assert_eq!(
                serde_json::to_value(
                    serde_json::from_value::<SelectedAtoms>(current.clone()).unwrap()
                )
                .unwrap(),
                current
            ),
            _ => {}
        }
        if name.starts_with("run-companion-request") {
            let call = json!({
                "invocation": {"pluginId": "plugin", "commandId": "plugin.build.run", "nonce": "0".repeat(32)},
                "method": "runCompanion", "request": current
            });
            let (_, Request::Run(request)) = Call::parse(call).unwrap() else {
                panic!("Expected a companion request.");
            };
            assert_eq!(encode(request).unwrap(), current);
        }
    }
    let mut actual: Vec<_> = fs::read_dir(&directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.ends_with(".json"))
        .collect();
    actual.sort();
    let mut expected: Vec<_> = values.keys().map(|name| format!("{name}.json")).collect();
    expected.sort();
    assert_eq!(actual, expected);
}

#[test]
fn handoff_warnings_share_the_same_unicode_bounds() {
    for (method, mut request) in [
        (
            "sendFile",
            json!({"appId": "0".repeat(32), "fileName": "block", "extension": "cif", "text": "data_block"}),
        ),
        (
            "runCompanion",
            json!({"appId": "0".repeat(32), "pipeline": "mofBuild", "combination": "small"}),
        ),
    ] {
        let parse = |request| {
            Call::parse(json!({
                "invocation": {"pluginId": "plugin", "commandId": "plugin.build.run", "nonce": "0".repeat(32)},
                "method": method, "request": request
            }))
        };
        let warning = "🧪".repeat(300);
        let mut warnings = vec![warning.clone(); 20];
        request["warnings"] = json!(warnings);
        assert!(parse(request.clone()).is_ok());
        warnings.push("extra".into());
        for invalid in [
            json!(warnings),
            json!([warning + "!"]),
            json!([0]),
            json!(["\0"]),
            Value::Null,
        ] {
            request["warnings"] = invalid;
            assert!(
                parse(request.clone()).is_err(),
                "{method}: {}",
                request["warnings"]
            );
        }
    }
}
