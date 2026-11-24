use super::wire::*;
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, path::Path};

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
    }
    let mut actual: Vec<_> = fs::read_dir(&directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.ends_with(".json"))
        .collect();
    actual.sort();
    let expected: Vec<_> = values.keys().map(|name| format!("{name}.json")).collect();
    assert_eq!(actual, expected);
}
