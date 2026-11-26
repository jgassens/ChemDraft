#[cfg(any(target_os = "macos", windows))]
use super::identity::App;
use super::{
    arming::{ApprovedBuild, ResultSession, State, RACE},
    catalog,
    command_line::{open_command, Pipeline, Platform},
    consent::{ListedConsent, Row, Store},
    dialogs::{self, Action},
    identity,
    runner::{self, CaptureError, ChildProcess},
    temp_files::{self, TempFiles},
    wire::{Call, Extension, Input, RunCode, StepResult},
};
use serde_json::{json, Value};
use std::{
    ffi::{OsStr, OsString},
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{atomic::AtomicBool, OnceLock},
    time::{Duration, Instant, SystemTime},
};

const PLUGIN: &str = "org.chemdraft.handoff.crystalBuilder";
const COMMAND: &str = "plugin.crystalBuilder.build";
const APP_ID: &str = "0123456789abcdef0123456789abcdef";
const INSTALL_ID: &str = "first-install";
const XYZ: &str = "3\n1 2\nC 0 0 0\nX 1 0 0\nX -1 0 0\n0 1 S\n0 2 S\n";

struct TestDir(PathBuf);
impl TestDir {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "chemdraft-handoff-{}",
            temp_files::nonce().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn template() -> Value {
    json!({
        "id":"mofBuild", "tool":{"macos":"Contents/MacOS/xtal", "windows":"bin\\XTAL~1.exe"},
        "testedVersions":["1.1.1"],
        "steps":[
            {"id":"preflight","args":["capabilities","--json"],"timeoutSeconds":5},
            {"id":"build","args":["run","mof.build","-p","repeat={combination.repeat}",
                "-p","edges={inputStem}","-p","bb_dir={inputDir}","-o","{outputFile:cif}","--json"],
                "input":{"extension":"xyz"},"timeoutSeconds":5},
            {"id":"inspect","args":["inspect","{previousOutput}","--json"],"timeoutSeconds":5}
        ],
        "combinations":{
            "small":{"repeat":"1x1x1","rebuildAs":"large"},
            "large":{"repeat":"2x2x2"},
            "exit":{"repeat":"exit"},
            "bad-json":{"repeat":"bad-json"},
            "no-file":{"repeat":"no-file"}
        }
    })
}

fn pipeline() -> Pipeline {
    serde_json::from_value(template()).unwrap()
}

#[test]
fn shared_companion_pipeline_fixtures_match_sdk_validation() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../packages/plugin-api/src/__fixtures__/companion-pipelines.json"
    ))
    .unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let mut pipeline = fixture["base"].as_object().unwrap().clone();
        pipeline.extend(case["overrides"].as_object().unwrap().clone());
        let validated = serde_json::from_value::<Pipeline>(Value::Object(pipeline))
            .map_err(|error| error.to_string())
            .and_then(|pipeline| pipeline.validate());
        assert_eq!(
            validated.is_ok(),
            case["valid"].as_bool().unwrap(),
            "{}: {validated:?}",
            case["name"]
        );
    }
}

fn build(combination: &str) -> ApprovedBuild {
    ApprovedBuild {
        app_id: APP_ID.into(),
        pipeline: "mofBuild".into(),
        combination: combination.into(),
        input: Some(Input {
            extension: Extension::Xyz,
            text: XYZ.into(),
        }),
        open_output: true,
        warnings: vec!["The node supplies these carboxylates.".into()],
    }
}

#[test]
fn both_platform_command_lines_preserve_one_argument_per_template_slot() {
    let pipeline = pipeline();
    pipeline.validate().unwrap();
    assert_eq!(
        pipeline.tool_path(Platform::Mac).unwrap(),
        Path::new("Contents").join("MacOS").join("xtal")
    );
    assert_eq!(
        pipeline.tool_path(Platform::Windows).unwrap(),
        Path::new("bin").join("XTAL~1.exe")
    );
    for (platform, directory) in [
        (Platform::Mac, Path::new("/tmp/A β")),
        (Platform::Windows, Path::new(r"C:\Users\DEVNAM~1\A β")),
    ] {
        let args = pipeline
            .render(&pipeline.steps[1], "small", directory, "cdx_example", None)
            .unwrap();
        let output = directory.join("output-build.cif");
        assert_eq!(args.output.as_deref(), Some(output.as_path()));
        assert!(args.args.iter().any(|arg| arg == "repeat=1x1x1"));
        let mut input = OsString::from("bb_dir=");
        input.push(directory);
        assert!(args.args.contains(&input));
        let inspect = pipeline
            .render(
                &pipeline.steps[2],
                "small",
                directory,
                "cdx_example",
                Some(&output),
            )
            .unwrap();
        assert_eq!(
            inspect.args,
            [
                "inspect".into(),
                output.as_os_str().to_owned(),
                "--json".into()
            ]
        );
        let (program, args) = open_command(
            platform,
            Path::new("Mol.app"),
            Path::new("Mol.exe"),
            &output,
        );
        match platform {
            Platform::Mac => {
                assert_eq!(program, Path::new("/usr/bin/open"));
                assert_eq!(
                    args,
                    [
                        "-a".into(),
                        "Mol.app".into(),
                        "--".into(),
                        output.into_os_string()
                    ]
                );
            }
            Platform::Windows => {
                assert_eq!(program, Path::new("Mol.exe"));
                assert_eq!(args, [output.into_os_string()]);
            }
        }
    }
}

#[test]
fn invalid_pipelines_refuse_traversal_arguments_and_unbound_inspection() {
    for (key, path) in [
        ("macos", "Contents/../xtal"),
        ("macos", "/usr/bin/xtal"),
        ("windows", "C:\\tools\\tool.exe"),
        ("windows", "tools\\.\\tool.exe"),
        ("windows", "tools\\.. \\tool.exe"),
        ("windows", "tools\\tool.cmd"),
        ("windows", "tools\\LPT².exe"),
        ("windows", "tools\\tool.exe:alternate"),
    ] {
        let mut raw = template();
        raw["tool"][key] = json!(path);
        assert!(
            serde_json::from_value::<Pipeline>(raw)
                .unwrap()
                .validate()
                .is_err(),
            "{path}"
        );
    }
    for parameter in [
        "--help",
        "@response",
        "a..b",
        "a b",
        "a|b",
        "a&b",
        "a=b",
        "a\\b",
        "a/b",
    ] {
        let mut raw = template();
        raw["combinations"]["small"]["repeat"] = json!(parameter);
        assert!(
            serde_json::from_value::<Pipeline>(raw)
                .unwrap()
                .validate()
                .is_err(),
            "{parameter}"
        );
    }
    let mut raw = template();
    raw["steps"][2]["args"] = json!(["inspect", "/elsewhere.cif", "--json"]);
    assert!(serde_json::from_value::<Pipeline>(raw)
        .unwrap()
        .validate()
        .is_err());
    let mut raw = template();
    raw["steps"][0]["args"] = json!(["run", "--json"]);
    assert!(serde_json::from_value::<Pipeline>(raw)
        .unwrap()
        .validate()
        .is_err());
}

#[test]
fn rendered_inspect_requires_the_immediately_preceding_build_output() {
    let mut raw = template();
    for (id, row) in raw["combinations"].as_object_mut().unwrap() {
        row["action"] = json!(if id == "small" { "inspect" } else { "check" });
    }
    raw["steps"][2]["args"][0] = json!("{combination.action}");
    let validate = |template| {
        serde_json::from_value::<Pipeline>(template)
            .unwrap()
            .validate()
    };
    assert!(validate(raw.clone()).is_ok());
    let mut wrong_previous = raw.clone();
    wrong_previous["steps"][1]["id"] = json!("generate");
    assert!(validate(wrong_previous)
        .unwrap_err()
        .contains("preceding build"));
    raw["steps"][2]["args"] = json!(["{combination.action}", "literal.cif", "{previousOutput}"]);
    assert!(validate(raw).unwrap_err().contains("preceding build"));
}

#[test]
fn live_menu_invocation_authenticates_each_method_before_any_side_effect() {
    let state = State::default();
    let now = Instant::now();
    let stale = state.arm(PLUGIN, COMMAND, now).unwrap().invocation(PLUGIN);
    state.begin(&stale, now).unwrap();
    let current = state.arm(PLUGIN, COMMAND, now).unwrap().invocation(PLUGIN);
    assert_ne!(current.nonce, stale.nonce);
    assert!(
        state.for_call(&current, now, true).is_err(),
        "must start the invocation first"
    );
    assert!(state.begin(&stale, now).is_err());
    state.finish(&stale);
    state.begin(&current, now).unwrap();
    assert!(state.begin(&current, now).is_err(), "cannot dispatch twice");
    let mut effects = Vec::new();
    let send = json!({"appId":APP_ID,"extension":"cif","fileName":"test","text":"x"});
    let mut relay = |invocation: Value, method: &str, request: Value| -> Result<(), String> {
        let call = super::endpoint::authorize_call(
            &state,
            json!({"invocation":invocation,"method":method,"request":request}),
            now,
        )?;
        if let Some(submission) = call.submission {
            submission.show_box()?;
            effects.push("box");
            effects.push("write");
            submission.launch(|| effects.push("launch"))?;
        } else if matches!(call.request, super::wire::Request::Choose(_)) {
            effects.push("picker");
        }
        Ok(())
    };
    for invalid in [
        json!({"pluginId": PLUGIN, "commandId": COMMAND}),
        json!({"pluginId": PLUGIN, "commandId": COMMAND, "nonce": ""}),
        json!(stale),
        json!({"pluginId": "other", "commandId": COMMAND, "nonce": current.nonce}),
        json!({"pluginId": PLUGIN, "commandId": "other", "nonce": current.nonce}),
    ] {
        for (method, request) in [
            ("chooseApp", json!({"purpose":"Open"})),
            ("status", json!({"appId": APP_ID})),
            ("sendFile", send.clone()),
            (
                "runCompanion",
                json!({"appId":APP_ID,"pipeline":"mofBuild","combination":"large"}),
            ),
        ] {
            assert!(relay(invalid.clone(), method, request).is_err());
        }
    }
    relay(json!(current), "status", json!({"appId":APP_ID})).unwrap();
    relay(json!(current), "chooseApp", json!({"purpose":"Open"})).unwrap();
    relay(json!(current), "sendFile", send.clone()).unwrap();
    assert!(relay(json!(current), "sendFile", send).is_err());
    assert_eq!(effects, ["picker", "box", "write", "launch"]);
    state.finish(&current);
    assert!(state.for_call(&current, now, true).is_err());
}

#[test]
fn refuses_stale_calls_during_pending_submission_and_after_expiry_or_unused_finish() {
    let state = State::default();
    let now = Instant::now();
    let stale = state.arm(PLUGIN, COMMAND, now).unwrap().invocation(PLUGIN);
    assert!(state.begin(&stale, now + Duration::from_secs(60)).is_err());
    let active = state.arm(PLUGIN, COMMAND, now).unwrap().invocation(PLUGIN);
    state.begin(&active, now).unwrap();
    let pending = state
        .for_call(&active, now, true)
        .unwrap()
        .submit(now)
        .unwrap();
    assert!(state.for_call(&stale, now, true).is_err());
    state.finish(&stale);
    pending.assert_pending().unwrap();
    drop(pending);
    assert!(state
        .for_call(&active, now + Duration::from_secs(60), false)
        .is_err());
    state.finish(&active);
    assert!(state.for_call(&active, now, true).is_err());
}

#[test]
fn wire_refuses_fields_outside_the_authenticated_envelope() {
    let invocation = json!({"pluginId": PLUGIN,"commandId": COMMAND,"nonce": APP_ID});
    let payload = json!({"invocation":invocation,"method":"sendFile","request":{"appId":APP_ID,"extension":"cif","fileName":"test","text":"x"}});
    assert!(Call::parse(payload.clone()).is_ok());
    for key in [
        "token",
        "arming",
        "armingId",
        "invocationId",
        "commandId",
        "combination",
        "nativeEvent",
        "nonce",
    ] {
        let mut extra = payload.clone();
        extra[key] = json!(COMMAND);
        assert!(Call::parse(extra).is_err());
        let mut extra = payload.clone();
        extra["request"][key] = json!(COMMAND);
        assert!(Call::parse(extra).is_err());
    }
    for (method, request) in [
        ("chooseApp", json!({"purpose":"Open a file"})),
        ("status", json!({"appId":APP_ID})),
        (
            "runCompanion",
            json!({"appId":APP_ID,"pipeline":"mofBuild","combination":"large"}),
        ),
    ] {
        let mut payload = json!({"invocation":invocation,"method":method,"request":request});
        assert!(Call::parse(payload.clone()).is_ok());
        payload["request"]["commandId"] = json!(COMMAND);
        assert!(Call::parse(payload).is_err());
    }
}

#[test]
fn wire_refuses_non_xyz_companion_input() {
    let arm = State::default()
        .arm(PLUGIN, COMMAND, Instant::now())
        .unwrap();
    let request = |extension| {
        json!({
            "invocation": arm.invocation(PLUGIN),
            "method": "runCompanion",
            "request": { "appId": APP_ID, "pipeline": "mofBuild", "combination": "small",
                "input": { "extension": extension, "text": XYZ } }
        })
    };
    assert!(Call::parse(request("xyz")).is_ok());
    assert!(Call::parse(request("cif")).is_err());
}

#[test]
fn duplicate_submissions_refuse_both_before_any_launch() {
    let state = State::default();
    let now = Instant::now();
    let arm = state.arm(PLUGIN, COMMAND, now).unwrap();
    let first = arm.submit(now).unwrap();
    first.show_box().unwrap();
    let cancel = first.invalidated();
    let duplicate = std::thread::spawn(move || arm.submit(now).err().unwrap())
        .join()
        .unwrap();
    assert_eq!(duplicate, RACE);
    assert!(*cancel.borrow());
    assert_eq!(
        first
            .launch(|| panic!("neither request may launch"))
            .unwrap_err(),
        RACE
    );
}

#[test]
fn refusal_before_a_box_releases_the_allowance_cancel_after_a_box_consumes_it() {
    let state = State::default();
    let now = Instant::now();
    let arm = state.arm(PLUGIN, COMMAND, now).unwrap();
    drop(arm.submit(now).unwrap());
    let shown = arm.submit(now).unwrap();
    shown.show_box().unwrap();
    drop(shown);
    assert!(arm.submit(now).is_err());
    let rebuild = state.arm_host_event(PLUGIN, COMMAND, now).unwrap();
    assert!(state.live(PLUGIN, now).is_err());
    assert_eq!(
        rebuild.launch(|| "Rust callback only").unwrap(),
        "Rust callback only"
    );
}

#[test]
fn build_dialog_open_failure_preserves_the_allowance() {
    let state = State::default();
    let now = Instant::now();
    let arm = state.arm(PLUGIN, COMMAND, now).unwrap();
    let submission = arm.submit(now).unwrap();
    let error = tauri::async_runtime::block_on(submission.open_box(
        std::future::ready(Err::<(), _>("window creation failed".into())),
        |()| panic!("there is no window to close"),
    ));
    assert_eq!(error.unwrap_err(), "window creation failed");
    drop(submission);
    let retry = arm.submit(now).unwrap();
    tauri::async_runtime::block_on(retry.open_box(std::future::ready(Ok(())), |()| {
        panic!("the window should stay open")
    }))
    .unwrap();
    drop(retry);
    assert!(arm.submit(now).is_err());
}

#[test]
fn native_handoff_commands_expose_no_arming_endpoint() {
    let host = include_str!("endpoint.rs");
    let names: Vec<&str> = host
        .split("#[tauri::command]")
        .skip(1)
        .map(|section| {
            section
                .split_once("fn ")
                .unwrap()
                .1
                .split_once('(')
                .unwrap()
                .0
        })
        .collect();
    assert_eq!(
        names,
        [
            "app_handoff_menu_invocation",
            "app_handoff_call",
            "app_handoff_consent_list",
            "app_handoff_consent_revoke",
            "app_handoff_consent_clear_plugin",
        ]
    );
    let capability: Value =
        serde_json::from_str(include_str!("../../capabilities/app-handoff.json")).unwrap();
    assert_eq!(capability["windows"], json!(["main"]));
    let native_menu = include_str!("../lib.rs")
        .split(".on_menu_event(|app, event| {")
        .nth(1)
        .unwrap()
        .split(".on_window_event")
        .next()
        .unwrap();
    assert!(
        native_menu.find("arm_native_menu").unwrap()
            < native_menu.find("emit_menu_command").unwrap()
    );
    let delivery = include_str!("../lib.rs")
        .split_once("if let Some(invocation) = handoff {")
        .unwrap()
        .1
        .split_once("if target_label == MAIN_WINDOW_LABEL")
        .unwrap()
        .0;
    assert!(delivery.contains("__CHEMDRAFT_NATIVE_HANDOFF__"));
    assert!(!delivery.contains("dispatch_dom") && !delivery.contains(".emit("));
    assert!(!include_str!("../lib.rs").contains("chemdraft:native-handoff-command"));
    assert_eq!(
        include_str!("../lib.rs")
            .matches("app_handoff::arm_native_menu")
            .count(),
        1
    );
}

#[test]
fn dialog_choice_is_bound_to_declared_combination_and_rebuild_keeps_original_input() {
    let input = build("small");
    let digest = dialogs::composition(input.input.as_ref().unwrap()).unwrap();
    assert_eq!((digest.formula.as_str(), digest.atom_count), ("CX2", 3));
    let confirm: Action =
        serde_json::from_value(json!({"action":"confirm","combinationId":"large"})).unwrap();
    let snapshot = json!({"mode":"confirm","combinations":template()["combinations"]});
    assert!(confirm.valid_for(&snapshot));
    assert!(!confirm.valid_for(&json!({"mode":"result"})));
    let unknown: Action =
        serde_json::from_value(json!({"action":"confirm","combinationId":"undeclared"})).unwrap();
    assert!(!unknown.valid_for(&snapshot));
    assert!(
        serde_json::from_value::<Action>(json!({"action":"rebuild","input":"new selection"}))
            .is_err()
    );

    let now = Instant::now();
    let session = || ResultSession {
        build: input.clone(),
        template_digest: pipeline().digest(),
        handoff_graph_digest: Some(digest.graph_digest.clone()),
        consent: (),
        rebuild_as: "large".into(),
        expires: now + Duration::from_secs(600),
    };
    let arming = State::default();
    let arm = arming.arm(PLUGIN, COMMAND, now).unwrap();
    let submission = arm.submit(now).unwrap();
    submission.bind_build(&input).unwrap();
    assert!(submission.bind_build(&build("large")).is_err());
    assert!(submission
        .launch_build(&build("large"), || panic!(
            "cannot replace the confirmed combination"
        ))
        .is_err());
    assert_eq!(
        submission
            .launch_build(&input, || "bound combination launched")
            .unwrap(),
        "bound combination launched"
    );

    let later_selection = Input {
        extension: Extension::Xyz,
        text: "1\n\nH 0 0 0\n".into(),
    };
    let rebuilt = session().take_rebuild(now).unwrap();
    assert_eq!(rebuilt.combination, "large");
    assert_eq!(rebuilt.warnings, input.warnings);
    assert_eq!(rebuilt.input.unwrap().text, XYZ);
    assert_ne!(later_selection.text, XYZ);
    assert!(session()
        .take_rebuild(now + Duration::from_secs(600))
        .is_err());
}

#[test]
fn confirmation_size_preflight_uses_the_private_dialog_envelope() {
    let mut pipeline = pipeline();
    let snapshot = |pipeline: &Pipeline, warnings: &[String]| {
        dialogs::confirmation_snapshot(
            pipeline,
            "Crystal Builder",
            "Send to Crystal Builder",
            "small",
            None,
            warnings,
        )
    };
    assert!(snapshot(&pipeline, &[]).is_ok());
    let state = State::default();
    let now = Instant::now();
    let arm = state.arm(PLUGIN, COMMAND, now).unwrap();
    let oversized = vec!["🧪".repeat(300); 20]; // Valid request fields, too many bytes for a dialog.
    let first = arm.submit(now).unwrap();
    assert!(snapshot(&pipeline, &oversized).is_err());
    drop(first);
    let corrected = arm.submit(now).unwrap();
    assert!(snapshot(&pipeline, &["Small warning.".into()]).is_ok());
    corrected.show_box().unwrap();
    drop(corrected); // Cancel closes the presented confirmation without launching.
    assert!(arm.submit(now).is_err());

    for index in 0..100 {
        pipeline.combinations.insert(
            format!("case-{index}"),
            [("repeat".into(), "x".repeat(32))].into(),
        );
    }
    assert!(pipeline.validate().is_ok());
    assert!(snapshot(&pipeline, &[]).is_err());
}

#[test]
fn confirmation_and_result_show_the_same_sanitized_warning_lines() {
    let pipeline = pipeline();
    let warnings = dialogs::display_warnings(&[
        " \u{202e}<b>Poten\u{200b}tial</b>\u{2069}\r\nloss\u{7}.\u{2028}Review\u{ad}\u{e0001}. "
            .into(),
        "\u{61c} \t \u{9f}".into(),
        "--flag=value".into(),
    ]);
    let confirm = dialogs::confirmation_snapshot(
        &pipeline,
        "Crystal Builder",
        "ChemDraft",
        "small",
        None,
        &warnings,
    )
    .unwrap();
    let result = serde_json::to_value(dialogs::result_snapshot(
        &pipeline,
        "Crystal Builder",
        "ChemDraft",
        "small",
        "large",
        Some(6.0),
        &warnings,
    ))
    .unwrap();
    assert_eq!(
        confirm["warnings"],
        json!(["<b>Potential</b> loss. Review.", "--flag=value"])
    );
    assert_eq!(result["warnings"], confirm["warnings"]);
    assert_eq!(confirm["pluginName"], "ChemDraft");
    assert_eq!(result["pluginName"], confirm["pluginName"]);
    assert!(crate::dialog_windows::validate_app_handoff_snapshot(&result).is_ok());
}

#[test]
fn send_file_message_attributes_and_bounds_plugin_text() {
    let name = format!("ChemDraft\u{200d}\u{7}{}", "🧪".repeat(1000));
    assert_eq!(
        dialogs::plugin_display_name(&name),
        format!("ChemDraft{}", "🧪".repeat(69))
    );
    assert_eq!(dialogs::plugin_display_name("\u{2060}\u{7}"), "Unknown");
    assert_eq!(
        dialogs::send_warning_message("Crystal Builder", &name, &[
            "ChemDraft verified\u{200b} this build.\r\nReview\u{e0020}.".into()
        ]),
        format!("Send the file to Crystal Builder?\n\nPlugin (ChemDraft{}) warnings\nChemDraft verified this build. Review.", "🧪".repeat(69))
    );
    let warnings = vec!["🧪".repeat(300); 20];
    let message = dialogs::send_warning_message("Crystal Builder", "ChemDraft", &warnings);
    assert_eq!(message.split_once(" warnings\n").unwrap().1.len(), 24_019);
}

#[test]
fn only_a_valid_rebuild_click_can_continue_a_completed_build() {
    assert!(!dialogs::rebuild_requested(Err(
        "result dialog unavailable".into()
    )));
    assert!(!dialogs::rebuild_requested(Ok(Action::Cancel {})));
    assert!(dialogs::rebuild_requested(Ok(Action::Rebuild {})));

    let mut pipeline = pipeline();
    pipeline
        .combinations
        .get_mut("small")
        .unwrap()
        .insert("topology".into(), "square".into());
    let target = pipeline.combinations.get_mut("large").unwrap();
    target.insert("topology".into(), "hex".into());
    target.insert("repeat".into(), "1x1x1".into());
    assert_eq!(
        dialogs::rebuild_changes(&pipeline, "small", "large"),
        [("topology", Some("hex"))].into()
    );
}

#[test]
fn twist_parsing_fails_closed_when_missing_ambiguous_or_non_numeric() {
    for (value, expected) in [
        (json!("6.000"), Some(6.0)),
        (json!(0.0), Some(0.0)),
        (json!("NaN"), None),
        (json!("unknown"), None),
    ] {
        let build = StepResult {
            id: "build".into(),
            json: json!({"tables":[{"rows":[{"label":"Joint twist left","value":value}]}]}),
        };
        assert_eq!(dialogs::twist(&[build]), expected);
    }
    assert!(dialogs::twist(&[StepResult {
        id: "build".into(),
        json: json!({"ok":false})
    }])
    .is_none());
    assert!(dialogs::twist(&[StepResult {
        id: "build".into(),
        json: json!({"tables":[
            {"label":"Joint twist left","value":0}, {"label":"Joint twist left","value":0}
        ]})
    }])
    .is_none());
}

#[test]
fn temporary_files_use_portable_stems_and_only_remove_old_host_directories() {
    for (name, expected) in [
        (r"..\beta/ file. ", "..beta file"),
        ("CON.txt", "handoff"),
        ("COM1 .txt", "handoff"),
        ("LPT².cif", "handoff"),
        ("COM0", "COM0"),
        ("構造 file", "構造 file"),
    ] {
        assert_eq!(temp_files::safe_name(name), expected);
    }
    let parent = TestDir::new();
    let mut keep = TempFiles::new(&parent.0, PLUGIN).unwrap();
    let second = TempFiles::new(&parent.0, PLUGIN).unwrap();
    assert_ne!(keep.stem, second.stem);
    assert_eq!(keep.stem.len(), 36);
    assert!(keep.stem.starts_with("cdx_"));
    assert!(TempFiles::new(&parent.0, r"..\unsafe").is_err());
    assert_eq!(
        keep.write("AUX", Extension::Cif, "structures")
            .unwrap()
            .file_name(),
        Some(OsStr::new("handoff.cif"))
    );
    let later = second.root.clone();
    drop(second);
    assert!(!later.exists());
    keep.keep_for_open_app();
    let path = keep.root.clone();
    let unrelated = path.parent().unwrap().join("keep unrelated");
    fs::create_dir(&unrelated).unwrap();
    drop(keep);
    temp_files::clean(&parent.0, SystemTime::now());
    assert!(path.exists());
    temp_files::clean(&parent.0, SystemTime::now() + Duration::from_secs(86401));
    assert!(!path.exists());
    assert!(unrelated.exists());
}

#[test]
fn provenance_follows_the_native_build_identifier() {
    let dir = TestDir::new();
    let stable = catalog::is_development_build("org.chemdraft.desktop");
    let dev = catalog::is_development_build("org.chemdraft.desktop.dev");
    assert!(!stable);
    assert!(dev);
    assert!(!catalog::is_development_build("org.other.dev"));
    let package = dir.0.join("installed-plugins").join(PLUGIN);
    fs::create_dir_all(&package).unwrap();
    let manifest = json!({
        "id":PLUGIN,"name":"Crystal Builder","version":"1.0.0","permissions":["apps.handoff","native.execute"],
        "contributes":{"commands":[{"id":COMMAND}],"menus":[{"commandId":COMMAND}]},"companions":[template()]
    });
    fs::write(package.join("manifest.json"), manifest.to_string()).unwrap();
    let mut record = json!({"id":PLUGIN,"version":"1.0.0","stagedPath":format!("installed-plugins/{PLUGIN}"),"sourceChecksum":"a".repeat(64),"installedAt":"2026-11-24T00:00:00Z"});
    let save = |record: &Value| {
        fs::write(
            dir.0.join("installed-plugins.json"),
            json!({"version":1,"plugins":[record]}).to_string(),
        )
        .unwrap()
    };
    for source in [None, Some("sideload")] {
        if let Some(source) = source {
            record["source"] = json!(source);
        }
        save(&record);
        let refusal = catalog::load(&dir.0, PLUGIN, stable).err().unwrap();
        assert!(refusal.contains("checksum-verified install"));
        let plugin = catalog::load(&dir.0, PLUGIN, dev).unwrap();
        assert!(plugin.owns_menu_command(COMMAND));
        assert!(!plugin.owns_menu_command("plugin.crystalBuilder.other"));
        assert_eq!(
            plugin.consent_note().trim(),
            "This hand-installed package is accepted only because this is a ChemDraft development build."
        );
    }
    record["source"] = json!("catalog");
    record["repository"] = json!("jgassens/ChemDraft-CrystalBuilder-Plugin");
    save(&record);
    assert!(catalog::load(&dir.0, PLUGIN, dev).is_err());
    record["checksumVerified"] = json!(true);
    save(&record);
    for build in [stable, dev] {
        assert_eq!(
            catalog::load(&dir.0, PLUGIN, build).unwrap().consent_note(),
            ""
        );
    }
    let mut updated = manifest;
    updated["permissions"] = json!(["native.execute"]);
    fs::write(package.join("manifest.json"), updated.to_string()).unwrap();
    assert!(catalog::load(&dir.0, PLUGIN, stable).is_err());
    assert!(State::default().live(PLUGIN, Instant::now()).is_err());

    record["id"] = json!("org.other");
    record["source"] = json!("sideload");
    save(&record);
    for build in [stable, dev] {
        let refusal = catalog::load(&dir.0, "org.other", build).err().unwrap();
        assert!(refusal.contains("outside the official app handoff catalog"));
    }
}

#[cfg(unix)]
#[test]
fn catalog_refuses_a_fifo_without_waiting_for_a_writer() {
    use std::{ffi::CString, os::unix::ffi::OsStrExt, sync::mpsc};

    let dir = TestDir::new();
    let path = dir.0.join("installed-plugins.json");
    let path = CString::new(path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    let (send, receive) = mpsc::channel();
    let root = dir.0.clone();
    std::thread::spawn(move || {
        let _ = send.send(catalog::load(&root, PLUGIN, false).err());
    });
    let error = receive
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .unwrap();
    assert!(error.contains("could not read the installed app handoff plugin"));
}

fn rust_stub() -> &'static Path {
    static STUB: OnceLock<PathBuf> = OnceLock::new();
    STUB.get_or_init(|| {
        // Unit tests have OUT_DIR, which belongs to cargo clean. Isolate concurrent test binaries.
        let path = Path::new(env!("OUT_DIR")).join(format!(
            "xtal-stub-{}{}",
            std::process::id(),
            std::env::consts::EXE_SUFFIX
        ));
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("app_handoff")
            .join("stub_tool.rs");
        let compile = Command::new(std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()))
            .arg("--edition=2021")
            .arg(fixture)
            .arg("-o")
            .arg(&path)
            .output()
            .unwrap();
        assert!(
            compile.status.success(),
            "{}",
            String::from_utf8_lossy(&compile.stderr)
        );
        path
    })
}

#[test]
fn companion_runs_ordered_steps_and_reports_preflight_and_step_failures() {
    let dir = TestDir::new();
    let files = TempFiles::new(&dir.0, PLUGIN).unwrap();
    files.write(&files.stem, Extension::Xyz, XYZ).unwrap();
    let stopped = AtomicBool::new(false);
    let run = |name| {
        runner::run(
            &pipeline(),
            &build(name),
            &files,
            |args, cwd, _, deadline| {
                ChildProcess::spawn_before(rust_stub(), args, cwd, deadline, &stopped)
            },
            &stopped,
        )
    };
    fs::write(files.root.join("untested"), "").unwrap();
    assert_eq!(run("small").err().unwrap().code, RunCode::VersionUntested);
    fs::remove_file(files.root.join("untested")).unwrap();
    let failed = run("exit").err().unwrap();
    let diagnostic = failed.diagnostic.unwrap();
    assert_eq!(failed.code, RunCode::ExitNonzero);
    assert_eq!(diagnostic.exit_code, Some(2));
    assert_eq!(
        diagnostic.json.unwrap()["summary"],
        "Build failed because a joint could not bond."
    );
    assert!(!diagnostic.stderr_tail.unwrap().contains("/tmp/"));
    assert_eq!(run("bad-json").err().unwrap().code, RunCode::BadOutput);
    assert_eq!(run("no-file").err().unwrap().code, RunCode::BadOutput);
    let success = run("small").ok().unwrap();
    assert_eq!(
        success
            .steps
            .iter()
            .map(|step| step.id.as_str())
            .collect::<Vec<_>>(),
        ["preflight", "build", "inspect"]
    );
    assert_eq!(success.steps[2].json["formula"], "CX");
    assert!(runner::verified_output(
        &files.root,
        &success.output.unwrap()
    ));
    assert_eq!(
        run("small").err().unwrap().code,
        RunCode::BadOutput,
        "build must write a new file"
    );
}

#[test]
fn companion_does_not_spawn_if_authorization_uses_the_pipeline_deadline() {
    let dir = TestDir::new();
    let error = ChildProcess::spawn_before(
        &dir.0.join("missing"),
        &[],
        &dir.0,
        Instant::now(),
        &AtomicBool::new(false),
    )
    .err()
    .unwrap();
    assert_eq!(
        error.code,
        RunCode::Timeout,
        "spawn would return ToolMissing"
    );
}

#[test]
fn companion_concurrently_drains_full_pipes_and_stops_on_either_cap() {
    let dir = TestDir::new();
    let stop = AtomicBool::new(false);
    for (args, limit) in [
        (["pipes", "262144"], false),
        (["pipes", "262145"], true),
        (["stdout", ""], true),
    ] {
        let args = args.map(OsString::from);
        let mut child = ChildProcess::spawn(rust_stub(), &args, &dir.0).unwrap();
        let capture = child.capture(Duration::from_secs(5), &stop);
        if limit {
            assert_eq!(capture.unwrap_err(), CaptureError::Limit);
        } else {
            let output = capture.unwrap();
            assert!(output.status.success());
            assert_eq!(output.stdout.len(), 256 * 1024);
            assert_eq!(output.stderr.len(), 256 * 1024);
        }
    }
}

#[test]
fn companion_watchdog_kills_descendants() {
    let dir = TestDir::new();
    let mut child = ChildProcess::spawn(rust_stub(), &["tree".into()], &dir.0).unwrap();
    let stop = AtomicBool::new(false);
    let result = child.capture(Duration::from_secs(2), &stop);
    assert_eq!(result.unwrap_err(), CaptureError::Timeout);
    assert!(
        dir.0.join("child-ready").is_file(),
        "stub descendant actually started"
    );
    std::thread::sleep(Duration::from_millis(2300));
    assert!(!dir.0.join("child-survived").exists());
}

#[cfg(unix)]
#[test]
fn companion_capture_times_out_when_a_detached_descendant_holds_pipes_open() {
    let dir = TestDir::new();
    let mut child = ChildProcess::spawn(rust_stub(), &["detached-tree".into()], &dir.0).unwrap();
    let start = Instant::now();
    let captured = child.capture(Duration::from_secs(2), &AtomicBool::new(false));
    assert_eq!(captured.unwrap_err(), CaptureError::Timeout);
    assert!(dir.0.join("child-ready").exists());
    assert!(start.elapsed() < Duration::from_secs(3));
}

#[test]
fn picker_refuses_shortcuts_scripts_and_wrong_platform_types() {
    assert!(identity::valid_pick(
        Platform::Mac,
        Path::new("Crystal Builder.app")
    ));
    assert!(identity::valid_pick(
        Platform::Windows,
        Path::new("Crystal Builder.EXE")
    ));
    for path in [
        "app.lnk",
        "app.exe.lnk",
        "app.cmd",
        "app.bat",
        "app.ps1",
        "app.exe:stream",
    ] {
        assert!(!identity::valid_pick(Platform::Windows, Path::new(path)));
        assert!(!identity::valid_pick(Platform::Mac, Path::new(path)));
    }
}

#[cfg(any(target_os = "macos", windows))]
fn install_stub(dir: &Path) -> (Platform, PathBuf, PathBuf) {
    let platform = Platform::current().unwrap();
    let app = match platform {
        Platform::Mac => {
            let app = dir.join("Chosen app.app");
            let contents = app.join("Contents");
            let executable = contents.join("MacOS");
            fs::create_dir_all(&executable).unwrap();
            fs::write(contents.join("Info.plist"), r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>App</string><key>CFBundleIdentifier</key><string>org.test.app</string></dict></plist>"#).unwrap();
            fs::copy(rust_stub(), executable.join("App")).unwrap();
            app
        }
        Platform::Windows => {
            let app = dir.join("Chosen app.exe");
            fs::copy(rust_stub(), &app).unwrap();
            app
        }
    };
    let root = if platform == Platform::Mac {
        app.as_path()
    } else {
        app.parent().unwrap()
    };
    let tool = root.join(pipeline().tool_path(platform).unwrap());
    fs::create_dir_all(tool.parent().unwrap()).unwrap();
    fs::copy(rust_stub(), &tool).unwrap();
    (platform, app, tool)
}

#[cfg(any(target_os = "macos", windows))]
#[test]
fn app_and_companion_swapped_after_initial_identity_check_never_launch() {
    let dir = TestDir::new();
    let (platform, path, tool) = install_stub(&dir.0);
    let pipeline = pipeline();
    let target = App::read(platform, &path, Some(&pipeline)).unwrap();
    let main = App::read(platform, &path, None).unwrap();
    assert!(target.verify(platform, Some(&pipeline)).is_ok());
    assert!(main.verify(platform, None).is_ok());
    assert_eq!(
        target
            .with_verified_launch(platform, Some(&pipeline), |current| {
                current.tool().unwrap().to_owned()
            })
            .unwrap(),
        tool.canonicalize().unwrap()
    );

    // Simulate a replacement while the user's box was open or the input was being written.
    fs::write(&tool, b"replacement tool").unwrap();
    assert_eq!(
        target.with_verified_launch(platform, Some(&pipeline), |_| panic!(
            "replacement tool launched"
        )),
        Err::<(), _>(identity::Error::Changed)
    );
    let executable = match platform {
        Platform::Mac => path.join("Contents").join("MacOS").join("App"),
        Platform::Windows => path,
    };
    fs::write(executable, b"replacement application").unwrap();
    assert_eq!(
        main.with_verified_launch(platform, None, |_| panic!(
            "replacement application launched"
        )),
        Err::<(), _>(identity::Error::Changed)
    );
}

#[cfg(target_os = "macos")]
#[test]
fn symlink_to_the_exact_same_bundle_is_refused_at_launch() {
    use std::os::unix::fs::symlink;
    let dir = TestDir::new();
    let (platform, path, _) = install_stub(&dir.0);
    let target = App::read(platform, &path, None).unwrap();
    let moved = dir.0.join("Moved app.app");
    fs::rename(&path, &moved).unwrap();
    symlink(&moved, &path).unwrap();
    assert_eq!(
        target.with_verified_launch(platform, None, |_| panic!("symlinked bundle launched")),
        Err::<(), _>(identity::Error::Changed)
    );
}

#[cfg(any(target_os = "macos", windows))]
#[test]
fn failed_consent_cleanup_requires_fresh_approval_after_reinstall() {
    let dir = TestDir::new();
    let (platform, path, _) = install_stub(&dir.0);
    let pipeline = pipeline();
    let target = App::read(platform, &path, Some(&pipeline)).unwrap();
    let digest = pipeline.digest();
    let store = Store::new(&dir.0);
    let app_id = store
        .pick(PLUGIN, App::read(platform, &path, None).unwrap(), |_| None)
        .unwrap();
    let get = || {
        store
            .get(PLUGIN, &app_id, Some(&pipeline.id))
            .unwrap()
            .unwrap()
    };
    store
        .replace(&get(), &target, digest.clone(), INSTALL_ID)
        .unwrap();

    let consents = dir.0.join("app-handoff").join("consents.json");
    let backup = consents.with_extension("backup");
    fs::rename(&consents, &backup).unwrap();
    fs::create_dir(&consents).unwrap();
    assert!(store.clear(PLUGIN).is_err());
    fs::remove_dir(&consents).unwrap();
    fs::rename(&backup, &consents).unwrap();

    let stale = get();
    assert!(stale
        .row
        .grants(&target, Some(&pipeline.id), &digest, INSTALL_ID));
    assert_eq!(
        json!(super::endpoint::ConsentSummary::new(
            stale.row.clone(),
            Some("second-install")
        ))["status"],
        "inactive"
    );
    assert!(
        !stale
            .row
            .grants(&target, Some(&pipeline.id), &digest, "second-install"),
        "the consent box is required"
    );
    store
        .replace(&stale, &target, digest.clone(), "second-install")
        .unwrap();
    let approved = get().row;
    assert!(approved.grants(&target, Some(&pipeline.id), &digest, "second-install"));
    assert!(!approved.grants(&target, Some(&pipeline.id), &digest, INSTALL_ID));
}

fn stored_grant() -> Row {
    serde_json::from_value(json!({
        "pluginId": PLUGIN, "appId": APP_ID, "appPath": "Test App",
        "appIdentity": {"main": {"path": "test-app", "sha256": "a".repeat(64)}},
        "templateDigest": "b".repeat(64), "handoffInstallId": "first-install",
        "consentTextVersion": 1, "granted": true, "at": "2026-11-23T12:00:00Z"
    }))
    .unwrap()
}

fn stored_target(pipeline: bool) -> identity::App {
    let send = stored_grant();
    let mut app_identity = send.app_identity;
    if pipeline {
        app_identity.companion = Some(
            serde_json::from_value(json!({"path": "test-companion", "sha256": "c".repeat(64)}))
                .unwrap(),
        );
    }
    identity::App {
        path: send.app_path,
        name: "Test App".into(),
        identity: app_identity,
    }
}

fn allow_send_and_build(store: &Store) -> (Row, Row) {
    let send = stored_grant();
    store.insert(send.clone()).unwrap();
    let pipeline = pipeline();
    let pending = store
        .get(PLUGIN, APP_ID, Some(&pipeline.id))
        .unwrap()
        .unwrap();
    let build = store
        .replace(
            &pending,
            &stored_target(true),
            pipeline.digest(),
            INSTALL_ID,
        )
        .unwrap();
    (send, build)
}

#[test]
fn per_operation_consent_keeps_both_send_and_build_grants() {
    let dir = TestDir::new();
    let store = Store::new(&dir.0);
    let (send, build) = allow_send_and_build(&store);
    let rows = store.list().unwrap();
    assert!(
        rows.iter().any(|entry| {
            matches!(entry, ListedConsent::Operation(row) if row.same_grant(&send))
        }),
        "granting mofBuild erased the file-send grant"
    );
    assert!(rows
        .iter()
        .any(|entry| { matches!(entry, ListedConsent::Operation(row) if row.same_grant(&build)) }));
}

#[test]
fn per_operation_consent_alternates_without_reapproval() {
    let dir = TestDir::new();
    let store = Store::new(&dir.0);
    let (send, build) = allow_send_and_build(&store);
    for (grant, target) in [
        (&send, stored_target(false)),
        (&build, stored_target(true)),
        (&send, stored_target(false)),
    ] {
        let operation = grant.pipeline.as_deref();
        let current = store.get(PLUGIN, APP_ID, operation).unwrap().unwrap().row;
        assert!(
            current.grants(&target, operation, &grant.template_digest, INSTALL_ID),
            "alternating operations asked for consent again"
        );
    }
}

#[test]
fn per_operation_consent_revokes_only_the_selected_operation() {
    let dir = TestDir::new();
    let store = Store::new(&dir.0);
    let (send, build) = allow_send_and_build(&store);
    store.revoke(PLUGIN, &build.consent_id()).unwrap();
    assert_eq!(store.with_grant(&build, |_| ()).unwrap(), None);
    assert_eq!(
        store.with_grant(&send, |_| ()).unwrap(),
        Some(()),
        "revoking mofBuild left no file-send grant"
    );
}

#[test]
fn grants_are_bound_to_the_operation_even_if_digests_match() {
    let dir = TestDir::new();
    let store = Store::new(&dir.0);
    let (send, build) = allow_send_and_build(&store);
    let send_app = stored_target(false);
    let build_app = stored_target(true);
    assert!(!send.grants(
        &send_app,
        build.pipeline.as_deref(),
        &send.template_digest,
        INSTALL_ID
    ));
    assert!(!build.grants(&build_app, None, &build.template_digest, INSTALL_ID));
    assert!(!build.grants(
        &build_app,
        Some("otherBuild"),
        &build.template_digest,
        INSTALL_ID
    ));
    assert!(!build.grants(
        &send_app,
        build.pipeline.as_deref(),
        &build.template_digest,
        INSTALL_ID
    ));
    let pending = store
        .get(PLUGIN, APP_ID, Some("otherBuild"))
        .unwrap()
        .unwrap();
    assert!(!pending.row.granted);
    assert!(store
        .replace(
            &pending,
            &send_app,
            build.template_digest.clone(),
            INSTALL_ID
        )
        .is_err());
    let other = store
        .replace(
            &pending,
            &build_app,
            build.template_digest.clone(),
            INSTALL_ID,
        )
        .unwrap();
    let summaries = store
        .list()
        .unwrap()
        .into_iter()
        .map(|entry| match entry {
            ListedConsent::Operation(row) => {
                json!(super::endpoint::ConsentSummary::new(row, Some(INSTALL_ID)))
            }
            ListedConsent::Conflict(_) => panic!("operation grants were classified as conflicting"),
        })
        .collect::<Vec<_>>();
    assert_eq!(summaries.len(), 3);
    for (summary, row) in summaries.iter().zip([&send, &build, &other]) {
        assert_eq!(summary["status"], "allowed");
        assert_eq!(summary["pipeline"], json!(row.pipeline));
        assert_eq!(summary["consentId"], row.consent_id());
        assert!(summary.get("appId").is_none());
        assert!(!summary.to_string().contains(APP_ID));
    }
    let ids = summaries
        .iter()
        .map(|row| row["consentId"].as_str().unwrap())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(ids.len(), 3);
    store.revoke(PLUGIN, &other.consent_id()).unwrap();
    assert_eq!(store.with_grant(&build, |_| ()).unwrap(), Some(()));
    assert_eq!(store.with_grant(&send, |_| ()).unwrap(), Some(()));
    assert_eq!(store.with_grant(&other, |_| ()).unwrap(), None);
}

#[test]
fn legacy_send_and_pipeline_grants_migrate_only_for_their_original_operation() {
    for pipeline_grant in [false, true] {
        let dir = TestDir::new();
        let store = Store::new(&dir.0);
        let (send, build) = allow_send_and_build(&store);
        let row = if pipeline_grant { build } else { send };
        let operation = row.pipeline.as_deref();
        let target = stored_target(pipeline_grant);
        let mut legacy = json!(row);
        legacy.as_object_mut().unwrap().remove("revision");
        legacy["futureRow"] = json!({"nested": true});
        legacy["appIdentity"]["futureIdentity"] = json!(17);
        legacy["appIdentity"]["main"]["futureExecutable"] = json!("kept");
        let path = dir.0.join("app-handoff").join("consents.json");
        fs::write(
            &path,
            json!({
                "schemaVersion": 1, "rows": [legacy], "futureTop": [true, null]
            })
            .to_string(),
        )
        .unwrap();

        let check = || {
            let expected = store.get(PLUGIN, APP_ID, operation).unwrap().unwrap().row;
            assert!(expected.grants(&target, operation, &row.template_digest, INSTALL_ID));
            let other_operation = if pipeline_grant {
                None
            } else {
                Some("mofBuild")
            };
            let other = store
                .get(PLUGIN, APP_ID, other_operation)
                .unwrap()
                .unwrap()
                .row;
            assert!(!other.granted);
            assert_eq!(store.with_grant(&expected, |_| ()).unwrap(), Some(()));
            assert_eq!(store.with_grant(&other, |_| ()).unwrap(), None);
        };
        check();
        assert_eq!(
            store.pick(PLUGIN, stored_target(false), |_| None).unwrap(),
            APP_ID
        );
        // Reapproval forces a write without creating a grant for another operation.
        let entry = store.get(PLUGIN, APP_ID, operation).unwrap().unwrap();
        store
            .replace(&entry, &target, row.template_digest.clone(), INSTALL_ID)
            .unwrap();
        check();
        let saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            saved["schemaVersion"], 2,
            "older readers accept only version 1"
        );
        assert_eq!(saved["futureTop"], json!([true, null]));
        assert_eq!(saved["rows"].as_array().unwrap().len(), 1);
        assert_eq!(saved["rows"][0]["futureRow"], json!({"nested": true}));
        assert_eq!(saved["rows"][0]["appIdentity"]["futureIdentity"], 17);
        assert_eq!(
            saved["rows"][0]["appIdentity"]["main"]["futureExecutable"],
            "kept"
        );
    }
}

#[test]
fn duplicate_and_conflicting_rows_fail_closed() {
    let dir = TestDir::new();
    let store = Store::new(&dir.0);
    let (send, build) = allow_send_and_build(&store);
    let pending = store.get(PLUGIN, APP_ID, None).unwrap().unwrap();
    let path = dir.0.join("app-handoff").join("consents.json");
    let mut revoked = json!(build);
    revoked["granted"] = json!(false);
    let mut other_app = json!(build);
    other_app["appPath"] = json!("Conflicting Path");
    for (version, rows) in [
        (1, json!([send, send])),
        (1, json!([send, build])),
        (2, json!([send, build, build])),
        (2, json!([send, build, revoked])),
        (2, json!([send, other_app])),
    ] {
        let corrupt = json!({"schemaVersion": version, "rows": rows}).to_string();
        fs::write(&path, &corrupt).unwrap();
        let listed = store.list().unwrap();
        let [ListedConsent::Conflict(group)] = listed.as_slice() else {
            panic!("Expected one conflicted app group, got {listed:?}");
        };
        let summary = json!(super::endpoint::ConsentSummary::conflict(group.clone()));
        assert_eq!(summary["status"], "conflict");
        assert_eq!(summary["pipeline"], Value::Null);
        assert!(!summary.to_string().contains(APP_ID));
        assert!(store
            .replace(
                &pending,
                &stored_target(false),
                send.template_digest.clone(),
                INSTALL_ID
            )
            .is_err());
        assert!(store.pick(PLUGIN, stored_target(false), |_| None).is_err());
        assert!(store
            .with_grant(&send, |_| panic!("ambiguous store launched"))
            .is_err());
        assert!(store.revoke(PLUGIN, &send.consent_id()).is_err());
        assert!(store.revoke(PLUGIN, &build.consent_id()).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), corrupt);
        store
            .revoke(PLUGIN, summary["consentId"].as_str().unwrap())
            .unwrap();
        assert!(store.for_app(PLUGIN, APP_ID).unwrap().is_empty());
    }
}

fn conflicting_legacy_store(store: &Store, dir: &TestDir) -> (PathBuf, Row, Row, Row, Row) {
    let (send, build) = allow_send_and_build(store);
    let mut other_app = send.clone();
    other_app.app_id = "a".repeat(32);
    let mut other_plugin = send.clone();
    other_plugin.plugin_id = "org.chemdraft.handoff.other".into();
    let mut legacy_build = json!(build);
    legacy_build["unknownRowField"] = json!({"values": [true, null]});
    let path = dir.0.join("app-handoff").join("consents.json");
    fs::write(
        &path,
        json!({
            "schemaVersion": 1,
            "rows": [send, legacy_build, other_app, other_plugin],
            "unknownStoreField": {"kept": true}
        })
        .to_string(),
    )
    .unwrap();
    (path, send, build, other_app, other_plugin)
}

#[test]
fn conflicting_legacy_consent_only_blocks_its_own_group() {
    let dir = TestDir::new();
    let store = Store::new(&dir.0);
    let (path, send, build, other_app, other_plugin) = conflicting_legacy_store(&store, &dir);
    let before = fs::read(&path).unwrap();
    for row in [&send, &build] {
        let error = store
            .get(PLUGIN, APP_ID, row.pipeline.as_deref())
            .err()
            .expect("conflicting consent was returned");
        assert!(error.to_string().contains("Conflicting"));
        assert!(store
            .with_grant(row, |_| panic!("conflicting grant launched"))
            .is_err());
    }
    assert!(
        matches!(store.with_grant(&other_app, |_| ()), Ok(Some(()))),
        "a conflict blocked another app's grant"
    );
    assert!(
        matches!(store.with_grant(&other_plugin, |_| ()), Ok(Some(()))),
        "a conflict blocked another plugin's grant"
    );
    assert_eq!(fs::read(&path).unwrap(), before);
    store
        .revoke(&other_plugin.plugin_id, &other_plugin.consent_id())
        .unwrap();
    assert_eq!(store.with_grant(&other_plugin, |_| ()).unwrap(), None);
    store.clear(&other_plugin.plugin_id).unwrap();
    assert!(store
        .for_app(&other_plugin.plugin_id, APP_ID)
        .unwrap()
        .is_empty());
    assert!(
        store.for_app(PLUGIN, APP_ID).is_err(),
        "migration activated a conflicting group"
    );
    assert_eq!(store.with_grant(&other_app, |_| ()).unwrap(), Some(()));
    let original: Value = serde_json::from_slice(&before).unwrap();
    let saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["schemaVersion"], 2);
    assert_eq!(saved["rows"], json!([other_app]));
    assert_eq!(
        saved["quarantinedRows"],
        json!([original["rows"][0], original["rows"][1]])
    );
    assert_eq!(saved["unknownStoreField"], original["unknownStoreField"]);
    store.revoke(PLUGIN, &send.conflict_id()).unwrap();
    assert!(store.for_app(PLUGIN, APP_ID).unwrap().is_empty());
}

#[test]
fn clear_removes_all_conflicting_rows_for_the_uninstalled_plugin() {
    let dir = TestDir::new();
    let store = Store::new(&dir.0);
    let (path, send, build, other_app, other_plugin) = conflicting_legacy_store(&store, &dir);
    store
        .clear(PLUGIN)
        .expect("clear must recover a conflicting store");
    assert!(store.for_app(PLUGIN, APP_ID).unwrap().is_empty());
    for row in [&send, &build, &other_app] {
        assert_eq!(store.with_grant(row, |_| ()).unwrap(), None);
    }
    assert_eq!(store.with_grant(&other_plugin, |_| ()).unwrap(), Some(()));
    let saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["schemaVersion"], 2);
    assert_eq!(saved["rows"], json!([other_plugin]));
    assert_eq!(saved["unknownStoreField"], json!({"kept": true}));
}

#[test]
fn revoke_removes_the_entire_conflicting_legacy_group() {
    let dir = TestDir::new();
    let store = Store::new(&dir.0);
    let (path, send, build, other_app, other_plugin) = conflicting_legacy_store(&store, &dir);
    let conflict_id = send.conflict_id();
    store
        .revoke(PLUGIN, &conflict_id)
        .expect("revoke must remove the entire conflicting group");
    assert!(store.for_app(PLUGIN, APP_ID).unwrap().is_empty());
    for row in [&send, &build] {
        assert_eq!(store.with_grant(row, |_| ()).unwrap(), None);
    }
    assert_eq!(store.with_grant(&other_app, |_| ()).unwrap(), Some(()));
    assert_eq!(store.with_grant(&other_plugin, |_| ()).unwrap(), Some(()));
    let saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["schemaVersion"], 2);
    assert_eq!(saved["rows"], json!([other_app, other_plugin]));
    assert_eq!(saved["unknownStoreField"], json!({"kept": true}));
}

#[cfg(any(unix, windows))]
#[test]
fn failed_conflicting_consent_removal_preserves_file_and_retry_recovers() {
    let dir = TestDir::new();
    let store = Store::new(&dir.0);
    let (path, _, _, _, other_plugin) = conflicting_legacy_store(&store, &dir);
    let before = fs::read(&path).unwrap();
    #[cfg(unix)]
    let error = {
        use std::os::unix::fs::PermissionsExt;
        let directory = path.parent().unwrap();
        fs::set_permissions(directory, fs::Permissions::from_mode(0o500)).unwrap();
        let result = store.clear(PLUGIN);
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
        result.unwrap_err()
    };
    #[cfg(windows)]
    let error = {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
        let _handle = fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&path)
            .unwrap();
        store.clear(PLUGIN).unwrap_err()
    };
    assert_eq!(fs::read(&path).unwrap(), before);
    store
        .clear(PLUGIN)
        .expect("retry must remove the conflicting group");
    assert!(
        error.raw_os_error().is_some(),
        "expected a filesystem write failure, got {error}"
    );
    assert!(store.for_app(PLUGIN, APP_ID).unwrap().is_empty());
    assert_eq!(store.with_grant(&other_plugin, |_| ()).unwrap(), Some(()));
}

#[test]
fn picked_app_keeps_its_id_and_declining_creates_no_operation_grant() {
    let dir = TestDir::new();
    let store = Store::new(&dir.0);
    let pick = || store.pick(PLUGIN, stored_target(false), |_| None).unwrap();
    let app_id = pick();
    assert_eq!(pick(), app_id);
    assert_eq!(store.for_app(PLUGIN, &app_id).unwrap().len(), 1);
    let pending_send = store.get(PLUGIN, &app_id, None).unwrap().unwrap();
    let pending_build = store
        .get(PLUGIN, &app_id, Some("mofBuild"))
        .unwrap()
        .unwrap();
    assert!(!pending_send.row.granted && !pending_build.row.granted);
    assert_eq!(store.for_app(PLUGIN, &app_id).unwrap().len(), 1);
    assert!(store.list().unwrap().is_empty());
    assert!(store
        .revoke(PLUGIN, &pending_send.row.consent_id())
        .is_err());
    let send = store
        .replace(
            &pending_send,
            &stored_target(false),
            "send".into(),
            INSTALL_ID,
        )
        .unwrap();
    let build = store
        .replace(
            &pending_build,
            &stored_target(true),
            "build".into(),
            INSTALL_ID,
        )
        .unwrap();
    assert_eq!(pick(), app_id);
    assert_eq!(store.with_grant(&send, |_| ()).unwrap(), Some(()));
    assert_eq!(store.with_grant(&build, |_| ()).unwrap(), Some(()));
    let abandoned = store
        .get(PLUGIN, &app_id, Some("abandoned"))
        .unwrap()
        .unwrap();
    assert!(!abandoned.row.granted);
    assert_eq!(store.list().unwrap().len(), 2);
}

#[test]
fn revocation_and_clear_refuse_stale_consent_replacement() {
    let dir = TestDir::new();
    let store = Store::new(&dir.0);
    let (send, build) = allow_send_and_build(&store);
    let operation = build.pipeline.as_deref();
    let stale_build = store.get(PLUGIN, APP_ID, operation).unwrap().unwrap();
    let missing = store
        .get(PLUGIN, APP_ID, Some("otherBuild"))
        .unwrap()
        .unwrap();
    store.revoke(PLUGIN, &build.consent_id()).unwrap();
    assert!(store
        .replace(
            &stale_build,
            &stored_target(true),
            build.template_digest.clone(),
            INSTALL_ID
        )
        .is_err());
    let revoked = store.get(PLUGIN, APP_ID, operation).unwrap().unwrap();
    store.revoke(PLUGIN, &build.consent_id()).unwrap();
    assert!(store
        .replace(
            &revoked,
            &stored_target(true),
            build.template_digest.clone(),
            INSTALL_ID
        )
        .is_err());
    assert_eq!(store.with_grant(&send, |_| ()).unwrap(), Some(()));
    let fresh = store.get(PLUGIN, APP_ID, operation).unwrap().unwrap();
    let build = store
        .replace(
            &fresh,
            &stored_target(true),
            build.template_digest,
            INSTALL_ID,
        )
        .unwrap();
    store.clear(PLUGIN).unwrap();
    assert!(store.list().unwrap().is_empty());
    assert!(store.for_app(PLUGIN, APP_ID).unwrap().is_empty());
    assert_eq!(store.with_grant(&send, |_| ()).unwrap(), None);
    assert_eq!(store.with_grant(&build, |_| ()).unwrap(), None);
    assert!(store
        .replace(
            &fresh,
            &stored_target(true),
            build.template_digest,
            INSTALL_ID
        )
        .is_err());
    assert_ne!(
        store.pick(PLUGIN, stored_target(false), |_| None).unwrap(),
        APP_ID
    );
    assert!(store
        .replace(&missing, &stored_target(true), "other".into(), INSTALL_ID)
        .is_err());
}

#[test]
fn revocation_disarms_only_the_matching_consent_box() {
    let arms = State::default();
    let now = Instant::now();
    let arm = arms.arm(PLUGIN, COMMAND, now).unwrap();
    let pending = arm.submit(now).unwrap();
    pending.bind_consent("build-consent".into()).unwrap();
    pending.show_box().unwrap();
    arms.disarm_consent(PLUGIN, "send-consent");
    assert!(pending.assert_pending().is_ok());
    arms.disarm_consent(PLUGIN, "build-consent");
    assert!(pending.assert_pending().is_err());
}

#[cfg(any(target_os = "macos", windows))]
#[test]
fn pipeline_only_consent_keeps_file_send_available_after_companion_disappears() {
    use super::endpoint::{load_target, target_status};

    let dir = TestDir::new();
    let (platform, path, tool) = install_stub(&dir.0);
    let pipeline = pipeline();
    let operation = Some(pipeline.id.as_str());
    let store = Store::new(&dir.0);
    let app_id = store
        .pick(PLUGIN, App::read(platform, &path, None).unwrap(), |_| None)
        .unwrap();
    let get = |op| store.get(PLUGIN, &app_id, op).unwrap().unwrap();
    let target = App::read(platform, &path, Some(&pipeline)).unwrap();
    store
        .replace(&get(operation), &target, pipeline.digest(), INSTALL_ID)
        .unwrap();
    fs::remove_file(tool).unwrap();

    let report = target_status(platform, &store.for_app(PLUGIN, &app_id).unwrap(), |_| {
        Some(pipeline.clone())
    });
    let send = get(None).row;
    let main = load_target(platform, &send, None).expect("main app still supports file send");
    assert!(!send.granted);
    assert!(
        !send.grants(&main, None, "send", INSTALL_ID),
        "file send must ask its own consent"
    );
    assert!(matches!(
        load_target(platform, &get(operation).row, Some(&pipeline)),
        Err(identity::Error::Changed)
    ));
    assert!(
        report.available,
        "a missing companion made file send unavailable"
    );
    assert_eq!(report.display_name.as_deref(), Some(main.name.as_str()));
    assert_eq!(
        report.reason.as_deref(),
        Some(identity::Error::Changed.message())
    );
    let approved = store
        .replace(&get(None), &main, "send".into(), INSTALL_ID)
        .unwrap();
    assert!(approved.grants(&main, None, "send", INSTALL_ID));
}

#[cfg(any(target_os = "macos", windows))]
#[test]
fn status_and_identity_handle_send_and_pipeline_independently() {
    use super::endpoint::{load_target, target_status};
    use std::io::Write;

    let dir = TestDir::new();
    let (platform, path, tool) = install_stub(&dir.0);
    let pipeline = pipeline();
    let operation = Some(pipeline.id.as_str());
    let digest = pipeline.digest();
    let store = Store::new(&dir.0);
    let pick = || App::read(platform, &path, None).unwrap();
    let app_id = store.pick(PLUGIN, pick(), |_| None).unwrap();
    let get = |op| store.get(PLUGIN, &app_id, op).unwrap().unwrap();
    assert!(target_status(platform, &store.for_app(PLUGIN, &app_id).unwrap(), |_| None).available);
    let send = store
        .replace(&get(None), &pick(), "send".into(), INSTALL_ID)
        .unwrap();
    let target = App::read(platform, &path, Some(&pipeline)).unwrap();
    let build = store
        .replace(&get(operation), &target, digest.clone(), INSTALL_ID)
        .unwrap();

    let mut changed = template();
    changed["steps"][1]["timeoutSeconds"] = json!(6);
    let changed: Pipeline = serde_json::from_value(changed).unwrap();
    let resolve = |_: &str| Some(pipeline.clone());
    let report = || target_status(platform, &store.for_app(PLUGIN, &app_id).unwrap(), resolve);
    assert!(report().reason.is_none());
    let changed_status = target_status(platform, &store.for_app(PLUGIN, &app_id).unwrap(), |_| {
        Some(changed.clone())
    });
    assert!(changed_status.available);
    assert_eq!(
        changed_status.reason.as_deref(),
        Some("The companion pipeline changed and needs consent again.")
    );
    assert!(
        target_status(platform, &store.for_app(PLUGIN, &app_id).unwrap(), |_| None)
            .reason
            .is_some()
    );

    let update = |path: &Path| {
        fs::OpenOptions::new()
            .append(true)
            .open(path)
            .unwrap()
            .write_all(b"changed executable")
            .unwrap();
    };
    update(&tool);
    assert!(report().available);
    assert_eq!(
        report().reason.as_deref(),
        Some(identity::Error::Changed.message())
    );
    let before_pick = get(operation);
    assert!(matches!(
        load_target(platform, &before_pick.row, Some(&pipeline)),
        Err(identity::Error::Changed)
    ));
    let replacement = App::read(platform, &path, Some(&pipeline)).unwrap();
    assert!(store
        .replace(&before_pick, &replacement, digest.clone(), INSTALL_ID)
        .is_err());
    assert_eq!(
        store
            .pick(PLUGIN, pick(), |_| replacement.identity.companion.clone())
            .unwrap(),
        app_id
    );
    let repicked = get(operation);
    assert!(load_target(platform, &repicked.row, Some(&pipeline)).is_ok());
    assert!(!repicked
        .row
        .grants(&replacement, operation, &digest, INSTALL_ID));
    assert!(repicked.row.grants(&target, operation, &digest, INSTALL_ID));
    assert_eq!(store.with_grant(&send, |_| ()).unwrap(), Some(()));
    assert_eq!(store.with_grant(&build, |_| ()).unwrap(), None);
    let build = store
        .replace(&repicked, &replacement, digest.clone(), INSTALL_ID)
        .unwrap();

    let executable = match platform {
        Platform::Mac => path.join("Contents").join("MacOS").join("App"),
        Platform::Windows => path.clone(),
    };
    update(&executable);
    assert!(!report().available);
    assert_eq!(
        report().reason.as_deref(),
        Some(identity::Error::Changed.message())
    );
    assert!(!send.grants(&pick(), None, &send.template_digest, INSTALL_ID));
    assert!(!build.grants(
        &App::read(platform, &path, Some(&pipeline)).unwrap(),
        operation,
        &digest,
        INSTALL_ID
    ));
    assert!(matches!(
        load_target(platform, &get(None).row, None),
        Err(identity::Error::Changed)
    ));
    assert!(matches!(
        load_target(platform, &get(operation).row, Some(&pipeline)),
        Err(identity::Error::Changed)
    ));
    fs::rename(&path, dir.0.join("Moved app")).unwrap();
    assert!(!report().available);
    assert_eq!(
        report().reason.as_deref(),
        Some(identity::Error::Missing.message())
    );
}

#[test]
fn acknowledged_revocation_prevents_the_next_step_spawn() {
    let dir = TestDir::new();
    let store = Store::new(&dir.0);
    let grant = stored_grant();
    let consent_id = grant.consent_id();
    store.insert(grant.clone()).unwrap();
    std::thread::scope(|scope| {
        use std::sync::mpsc;

        let (entered, verified) = mpsc::channel();
        let (allow_spawn, ready) = mpsc::channel();
        let (revoking, started) = mpsc::channel();
        let (revoked, acknowledged) = mpsc::channel();
        let (store, grant) = (&store, &grant);
        let launch = scope.spawn(move || {
            store
                .with_grant(grant, |_| {
                    entered.send(()).unwrap();
                    ready.recv().unwrap();
                    "spawned"
                })
                .unwrap()
        });
        verified.recv().unwrap();
        scope.spawn(move || {
            revoking.send(()).unwrap();
            store.revoke(PLUGIN, &consent_id).unwrap();
            revoked.send(()).unwrap();
        });
        started.recv().unwrap();
        let early_ack = acknowledged.recv_timeout(Duration::from_millis(100));
        allow_spawn.send(()).unwrap();
        assert_eq!(early_ack, Err(mpsc::RecvTimeoutError::Timeout));
        assert_eq!(launch.join().unwrap(), Some("spawned"));
        acknowledged.recv().unwrap();
        assert_eq!(
            store
                .with_grant(grant, |_| panic!("revoked step spawned"))
                .unwrap(),
            None::<()>
        );
    });
}

#[test]
fn oversized_consent_insert_preserves_the_readable_prior_file() {
    const MAX: usize = 1024 * 1024;
    let dir = TestDir::new();
    let store = Store::new(&dir.0);
    let grant = stored_grant();
    store.insert(grant.clone()).unwrap();
    let path = dir.0.join("app-handoff").join("consents.json");
    let mut document: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    document["futureField"] = json!("");
    let len = document.to_string().len();
    document["futureField"] = json!("x".repeat(MAX - len));
    let before = document.to_string();
    assert_eq!(before.len(), MAX);
    fs::write(&path, &before).unwrap();

    let mut extra = grant.clone();
    extra.app_id = "f".repeat(32);
    assert!(store
        .insert(extra)
        .unwrap_err()
        .to_string()
        .contains("1 MiB"));
    assert_eq!(fs::read(&path).unwrap(), before.as_bytes());
    assert!(store
        .get(PLUGIN, APP_ID, None)
        .unwrap()
        .unwrap()
        .row
        .same_grant(&grant));
}

#[cfg(unix)]
#[test]
fn consent_store_refuses_existing_group_or_world_accessible_directory_and_file() {
    use std::{io, os::unix::fs::PermissionsExt};

    let dir = TestDir::new();
    let root = dir.0.join("app-handoff");
    let path = root.join("consents.json");
    let store = Store::new(&dir.0);
    let set_mode =
        |path, mode| fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
    store.clear(PLUGIN).unwrap();
    for (unsafe_path, mode, safe_mode) in [(&root, 0o750, 0o700), (&path, 0o604, 0o600)] {
        set_mode(unsafe_path, mode);
        assert_eq!(
            store.list().unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(
            store.clear(PLUGIN).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        set_mode(unsafe_path, safe_mode);
        assert!(store.list().unwrap().is_empty());
    }
}

#[cfg(windows)]
#[test]
fn consent_store_refuses_an_existing_file_with_inherited_acl() {
    use std::io;

    let dir = TestDir::new();
    let root = dir.0.join("app-handoff");
    fs::create_dir(&root).unwrap();
    fs::write(
        root.join("consents.json"),
        br#"{"schemaVersion":1,"rows":[]}"#,
    )
    .unwrap();
    let store = Store::new(&dir.0);
    assert_eq!(
        store.list().unwrap_err().kind(),
        io::ErrorKind::PermissionDenied
    );
    assert_eq!(
        store.clear(PLUGIN).unwrap_err().kind(),
        io::ErrorKind::PermissionDenied
    );
}

#[test]
#[cfg(any(target_os = "macos", windows))]
fn consent_survives_disable_but_changed_template_app_revoke_and_uninstall_refuse() {
    let dir = TestDir::new();
    let (platform, app, tool) = install_stub(&dir.0);
    let pipeline = pipeline();
    let app =
        App::read(platform, &app, Some(&pipeline)).unwrap_or_else(|error| panic!("{error:?}"));
    let digest = pipeline.digest();
    let store = Store::new(&dir.0);
    let app_id = store
        .pick(
            PLUGIN,
            App::read(platform, &app.path, None).unwrap(),
            |_| None,
        )
        .unwrap();
    let operation = Some(pipeline.id.as_str());
    let get = || store.get(PLUGIN, &app_id, operation).unwrap().unwrap();
    let allowed = store
        .replace(&get(), &app, digest.clone(), INSTALL_ID)
        .unwrap();
    assert!(allowed.grants(&app, operation, &digest, INSTALL_ID));
    // Disabling or re-enabling a plugin touches the native menu, not its persisted consent.
    let state = State::default();
    state.arm(PLUGIN, COMMAND, Instant::now()).unwrap();
    state.disarm(PLUGIN);
    assert!(state.live(PLUGIN, Instant::now()).is_err());
    let before_revoke = get();
    assert!(before_revoke
        .row
        .grants(&app, operation, &digest, INSTALL_ID));
    let mut changed = template();
    changed["steps"][1]["timeoutSeconds"] = json!(6);
    assert!(!allowed.grants(
        &app,
        operation,
        &serde_json::from_value::<Pipeline>(changed)
            .unwrap()
            .digest(),
        INSTALL_ID
    ));

    fs::remove_file(tool).unwrap();
    assert!(matches!(
        app.verify(platform, Some(&pipeline)),
        Err(identity::Error::Changed)
    ));

    let path = dir.0.join("app-handoff").join("consents.json");
    let mut document: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    document["futureTop"] = json!(true);
    document["rows"][1]["futureRow"] = json!("kept");
    fs::write(&path, document.to_string()).unwrap();
    let summary = json!(super::endpoint::ConsentSummary::new(
        allowed.clone(),
        Some(INSTALL_ID)
    ));
    assert_eq!(summary["status"], "allowed");
    assert_eq!(summary["consentId"], allowed.consent_id());
    assert!(summary.get("appId").is_none());
    assert!(!summary.to_string().contains(&app_id));
    assert!(store.revoke(PLUGIN, &app_id).is_err());
    assert!(store
        .get(PLUGIN, &allowed.consent_id(), operation)
        .unwrap()
        .is_none());
    store.revoke(PLUGIN, &allowed.consent_id()).unwrap();
    let revoked = get().row;
    assert!(!revoked.grants(&app, operation, &digest, INSTALL_ID));
    assert_eq!(
        json!(super::endpoint::ConsentSummary::new(revoked, None))["status"],
        "revoked"
    );
    assert!(
        store
            .replace(&before_revoke, &app, digest.clone(), INSTALL_ID)
            .is_err(),
        "revoked consent must not be restored by a stale box"
    );
    let saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["futureTop"], true);
    assert_eq!(saved["rows"][1]["futureRow"], "kept");
    assert_private_consent(&path);
    store.clear(PLUGIN).unwrap();
    assert!(store.list().unwrap().is_empty());
}

#[cfg(target_os = "macos")]
fn assert_private_consent(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
}

#[cfg(windows)]
fn assert_private_consent(path: &Path) {
    use std::{os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::{
                ConvertSecurityDescriptorToStringSecurityDescriptorW, GetNamedSecurityInfoW,
                SE_FILE_OBJECT,
            },
            DACL_SECURITY_INFORMATION,
        },
    };
    let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut descriptor = ptr::null_mut();
    unsafe {
        assert_eq!(
            GetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                &mut descriptor
            ),
            0
        );
        let mut sddl = ptr::null_mut();
        let mut len = 0;
        assert_ne!(
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor,
                1,
                DACL_SECURITY_INFORMATION,
                &mut sddl,
                &mut len
            ),
            0
        );
        let value = String::from_utf16_lossy(std::slice::from_raw_parts(sddl, len as usize));
        LocalFree(sddl.cast());
        LocalFree(descriptor.cast());
        assert_eq!(value.trim_end_matches('\0'), "D:P(A;;FA;;;OW)");
    }
}

#[cfg(unix)]
#[test]
fn companion_path_and_output_refuse_symlinks_and_escape() {
    use std::os::unix::fs::symlink;
    let folder = TestDir::new();
    let root = folder.0.canonicalize().unwrap();
    let outside = TestDir::new();
    let script = outside.0.join("tool");
    fs::write(&script, "test").unwrap();
    symlink(&outside.0, root.join("escape")).unwrap();
    symlink(&script, root.join("out.cif")).unwrap();
    assert!(
        temp_files::plain_path(&root, Path::new("escape").join("tool").as_path(), false).is_err()
    );
    assert!(!runner::verified_output(&root, &root.join("out.cif")));
}

#[cfg(windows)]
#[test]
fn companion_path_and_output_refuse_windows_junctions() {
    let folder = TestDir::new();
    let root = folder.0.canonicalize().unwrap();
    let outside = TestDir::new();
    fs::write(outside.0.join("tool.exe"), "test").unwrap();
    fs::write(outside.0.join("output.cif"), "test").unwrap();
    crate::local_engine::handoff_test_junction(
        &outside.0.canonicalize().unwrap(),
        &root.join("escape"),
    )
    .unwrap();
    let escape = Path::new("escape").join("tool.exe");
    assert!(temp_files::plain_path(&root, &escape, false).is_err());
    assert!(!runner::verified_output(
        &root,
        &root.join("escape").join("output.cif")
    ));
}

#[test]
fn companion_clears_parent_overrides_and_uses_null_stdin() {
    const MARKER: &str = "CHEMDRAFT_HANDOFF_STUB_ENV_TEST";
    if std::env::var_os(MARKER).is_none() {
        let parent = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "app_handoff::tests::companion_clears_parent_overrides_and_uses_null_stdin",
            ])
            .env(MARKER, "1")
            .envs(
                ["XTAL_", "PYTHON", "DYLD_", "LD_"]
                    .map(|prefix| (format!("{prefix}CHEMDRAFT_HANDOFF"), "present in parent")),
            )
            .output()
            .unwrap();
        assert!(
            parent.status.success(),
            "{}",
            String::from_utf8_lossy(&parent.stdout)
        );
        return;
    }
    assert_eq!(
        std::env::var("XTAL_CHEMDRAFT_HANDOFF").as_deref(),
        Ok("present in parent")
    );
    let dir = TestDir::new();
    let mut child = ChildProcess::spawn(rust_stub(), &["capabilities".into()], &dir.0).unwrap();
    let result = child
        .capture(Duration::from_secs(5), &AtomicBool::new(false))
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}
