use super::{command_line::Pipeline, dialogs, wire::*};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, path::Path};

const APP_NAME: &str = "Crystal Builder";
const PLUGIN_NAME: &str = "Send to Crystal Builder";
const BUILD: &str = "pcu-N16-1x1x1";
const REBUILD: &str = "pcu-N16-2x2x2";

fn crystal_builder_choices() -> (Pipeline, dialogs::Composition) {
    let pipeline: Pipeline = serde_json::from_value(json!({
        "id": "mofBuild", "tool": {"macos": "Contents/MacOS/xtal", "windows": "xtal.exe"},
        "testedVersions": ["1.1.1"],
        "steps": [{"id": "preflight", "args": ["capabilities", "--json"], "timeoutSeconds": 30}],
        "combinations": {
            (BUILD): {"topology": "pcu", "node": "N16", "repeat": "1x1x1", "rebuildAs": REBUILD},
            (REBUILD): {"topology": "pcu", "node": "N16", "repeat": "2x2x2"}
        }
    }))
    .unwrap();
    let composition = dialogs::Composition {
        formula: "C6H4X2".into(),
        atom_count: 12,
        graph_digest: String::new(),
    };
    (pipeline, composition)
}

#[test]
fn crystal_builder_warning_bytes_match_the_documented_dialog_budget() {
    let (pipeline, composition) = crystal_builder_choices();
    let confirm = |warnings: &[String]| {
        dialogs::confirmation_snapshot(
            &pipeline,
            APP_NAME,
            PLUGIN_NAME,
            BUILD,
            Some(&composition),
            warnings,
            None,
        )
    };
    // Ten ASCII lines use 31 bytes of JSON array punctuation plus 2,739 bytes of text.
    let mut warnings = vec!["a".repeat(300); 9];
    warnings.push("a".repeat(39));
    assert!(confirm(&warnings).is_ok());
    warnings.last_mut().unwrap().push('a');
    assert!(confirm(&warnings).is_err());

    let rebuild = |warnings: &[String]| {
        let mut result = encode(dialogs::result_snapshot(
            &pipeline,
            APP_NAME,
            PLUGIN_NAME,
            BUILD,
            REBUILD,
            None,
            warnings,
        ))
        .unwrap();
        result["twist"] = Value::String("0".repeat(24));
        crate::dialog_windows::validate_app_handoff_snapshot(&result)
    };
    *warnings.last_mut().unwrap() = "a".repeat(169);
    assert!(rebuild(&warnings).is_ok());
    warnings.last_mut().unwrap().push('a');
    assert!(rebuild(&warnings).is_err());
}

#[test]
fn preflight_rejects_an_oversized_rebuild_even_without_warnings() {
    let (mut pipeline, _) = crystal_builder_choices();
    let mut parameters: BTreeMap<String, String> =
        (0..257).map(|i| (format!("p{i}"), "x".into())).collect();
    parameters.insert("rebuildAs".into(), "b".into());
    pipeline.combinations = [("a".into(), parameters), ("b".into(), BTreeMap::new())].into();
    assert!(pipeline.validate().is_ok());
    let confirm =
        |id| dialogs::confirmation_snapshot(&pipeline, APP_NAME, PLUGIN_NAME, id, None, &[], None);
    let snapshot = encode(dialogs::Snapshot::Confirm {
        title: "Confirm companion build",
        app_name: APP_NAME,
        plugin_name: PLUGIN_NAME,
        pipeline: &pipeline.id,
        composition: None,
        suggested_combination: "b",
        combinations: &pipeline.combinations,
        warnings: &[],
        retry: None,
    })
    .unwrap();
    assert!(crate::dialog_windows::validate_app_handoff_snapshot(&snapshot).is_ok());
    assert!(
        confirm("b").is_err(),
        "any declared choice could need a rebuild"
    );
}

#[test]
fn app_handoff_wire_fixtures_are_current() {
    let id = "0123456789abcdef0123456789abcdef";
    let mut values: BTreeMap<String, Value> = BTreeMap::from([
        (
            "choose-app-request".into(),
            encode(ChooseRequest {
                purpose: "Open the linker".into(),
            })
            .unwrap(),
        ),
        (
            "choose-app-request-overlapping".into(),
            encode(ChooseRequest {
                purpose: "Choose an app for the second command".into(),
            })
            .unwrap(),
        ),
        (
            "choose-app-request-retry".into(),
            encode(ChooseRequest {
                purpose: "Choose another app".into(),
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
                retry: None,
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
                retry: None,
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
                sequence: None,
            })
            .unwrap(),
        ),
        (
            "run-companion-declined".into(),
            encode(RunResult::Declined).unwrap(),
        ),
    ]);
    values.insert(
        "run-companion-done-unopened".into(),
        encode(RunResult::Done {
            steps: vec![
                StepResult {
                    id: "build".into(),
                    json: json!({"ok": true}),
                },
                StepResult {
                    id: "inspect".into(),
                    json: json!({"formula": "C6H4X2", "n_atoms": 12}),
                },
            ],
            opened: false,
            sequence: None,
        })
        .unwrap(),
    );
    // API 0.1.29 bounded retry: request, a result from the second input, and a later failure.
    let when = RetryCondition {
        step: "build".into(),
        label: "Joint twist left".into(),
        not_equal: 0.0,
    };
    values.insert(
        "run-companion-request-retry".into(),
        encode(RunRequest {
            app_id: id.into(),
            pipeline: "mofBuild".into(),
            combination: BUILD.into(),
            input: Some(Input {
                extension: Extension::Xyz,
                text: "2\n1\nC 0 0 0\nX 1 0 0\n0 1 S\n".into(),
            }),
            open_output: Some(true),
            warnings: None,
            retry: Some(Retry {
                inputs: vec![
                    "2\n2\nC 0 0 0\nX 1.01 0 0\n0 1 S\n".into(),
                    "2\n3\nC 0 0 0\nX 0.99 0 0\n0 1 S\n".into(),
                ],
                when: when.clone(),
            }),
        })
        .unwrap(),
    );
    values.insert(
        "run-companion-done-retry".into(),
        encode(RunResult::Done {
            steps: vec![StepResult {
                id: "build".into(),
                json: json!({"ok": true, "tables": [{"rows": [{"label": "Joint twist left", "value": "0.000"}]}]}),
            }],
            opened: true,
            sequence: Some(Sequence::after(2)),
        })
        .unwrap(),
    );
    values.insert(
        "run-companion-timeout-retry".into(),
        encode(RunResult::Failed {
            code: RunCode::Timeout,
            message: "Companion step \"build\" exceeded its time limit or was stopped.".into(),
            diagnostic: Some(Diagnostic {
                step: "build".into(),
                exit_code: None,
                json: None,
                stderr_tail: None,
            }),
            sequence: Some(Sequence::after(3)),
        })
        .unwrap(),
    );
    let (pipeline, composition) = crystal_builder_choices();
    values.insert(
        "dialog-confirm-retry".into(),
        dialogs::confirmation_snapshot(
            &pipeline,
            APP_NAME,
            PLUGIN_NAME,
            BUILD,
            Some(&composition),
            &[],
            Some(dialogs::RetryNotice::new(3, &when)),
        )
        .unwrap(),
    );
    let warnings = dialogs::display_warnings(&["ChemDraft verified\u{200b} this build.".into()]);
    values.insert(
        "dialog-confirm".into(),
        dialogs::confirmation_snapshot(
            &pipeline,
            APP_NAME,
            PLUGIN_NAME,
            BUILD,
            Some(&composition),
            &warnings,
            None,
        )
        .unwrap(),
    );
    values.insert(
        "dialog-rebuild".into(),
        encode(dialogs::result_snapshot(
            &pipeline,
            APP_NAME,
            PLUGIN_NAME,
            BUILD,
            REBUILD,
            Some(6.0),
            &warnings,
        ))
        .unwrap(),
    );
    values.insert(
        "dialog-confirm-unwarned".into(),
        dialogs::confirmation_snapshot(
            &pipeline,
            APP_NAME,
            PLUGIN_NAME,
            BUILD,
            Some(&composition),
            &[],
            None,
        )
        .unwrap(),
    );
    values.insert(
        "dialog-rebuild-unwarned".into(),
        encode(dialogs::result_snapshot(
            &pipeline,
            APP_NAME,
            PLUGIN_NAME,
            BUILD,
            REBUILD,
            None,
            &[],
        ))
        .unwrap(),
    );
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
                sequence: None,
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
        if let Some((method, _)) = name.split_once("-request") {
            let method = match method {
                "choose-app" => "chooseApp",
                "status" => "status",
                "send-file" => "sendFile",
                "run-companion" => "runCompanion",
                _ => panic!("Unknown wire request {name}"),
            };
            let call = json!({
                "invocation": {"pluginId": "plugin", "commandId": "plugin.build.run", "nonce": "0".repeat(32)},
                "method": method, "request": current
            });
            let (_, request) = Call::parse(call).unwrap();
            let decoded = match request {
                Request::Choose(request) => encode(request),
                Request::Status(request) => encode(request),
                Request::Send(request) => encode(request),
                Request::Run(request) => encode(request),
            };
            assert_eq!(decoded.unwrap(), current);
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
