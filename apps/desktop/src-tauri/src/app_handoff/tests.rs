use super::{
    arming::{ApprovedBuild, ResultSession, State, RACE},
    catalog,
    command_line::{open_command, Pipeline, Platform},
    consent::{Row, Store},
    dialogs::{self, Action},
    identity::{self, App},
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
fn wire_refuses_all_renderer_credentials_and_replay_without_an_arm() {
    let state = State::default();
    let now = Instant::now();
    let payload = json!({"pluginId": PLUGIN,"method":"sendFile","request":{"appId":APP_ID,"extension":"cif","fileName":"test","text":"x"}});
    assert!(Call::parse(payload.clone()).is_ok());
    for key in [
        "token",
        "arming",
        "armingId",
        "invocationId",
        "commandId",
        "combination",
        "nativeEvent",
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
        let mut payload = json!({"pluginId":PLUGIN,"method":method,"request":request});
        assert!(Call::parse(payload.clone()).is_ok());
        payload["request"]["commandId"] = json!(COMMAND);
        assert!(Call::parse(payload).is_err());
    }

    assert!(state.live(PLUGIN, now).is_err());
    state.arm(PLUGIN, COMMAND, now);
    for method in ["status", "chooseApp"] {
        let request = if method == "status" {
            json!({"appId":APP_ID})
        } else {
            json!({"purpose":"Open"})
        };
        assert!(Call::parse(json!({"pluginId":PLUGIN,"method":method,"request":request})).is_ok());
        assert_eq!(state.live(PLUGIN, now).unwrap().command, COMMAND);
    }
    assert!(state.live("org.other", now).is_err());
    let active = state.live(PLUGIN, now).unwrap();
    let send = active.submit(now).unwrap();
    assert_eq!(send.launch(|| "launched").unwrap(), "launched");
    assert!(
        active.submit(now).is_err(),
        "same renderer values cannot be replayed"
    );
    assert!(state.live(PLUGIN, now + Duration::from_secs(60)).is_err());
    state.disarm(PLUGIN);
    assert!(Call::parse(payload).is_ok());
    assert!(state.live(PLUGIN, now).is_err());
}

#[test]
fn duplicate_submissions_refuse_both_before_any_launch() {
    let state = State::default();
    let now = Instant::now();
    let arm = state.arm(PLUGIN, COMMAND, now);
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
    let arm = state.arm(PLUGIN, COMMAND, now);
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
    let arm = arming.arm(PLUGIN, COMMAND, now);
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
    assert_eq!(rebuilt.input.unwrap().text, XYZ);
    assert_ne!(later_selection.text, XYZ);
    assert!(session()
        .take_rebuild(now + Duration::from_secs(600))
        .is_err());
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
fn stable_catalog_refuses_sideloads_and_disabled_commands_never_arm() {
    let dir = TestDir::new();
    let package = dir.0.join("installed-plugins").join(PLUGIN);
    fs::create_dir_all(&package).unwrap();
    let manifest = json!({
        "id":PLUGIN,"name":"Crystal Builder","version":"1.0.0","permissions":["apps.handoff","native.execute"],
        "contributes":{"commands":[{"id":COMMAND}],"menus":[{"commandId":COMMAND}]},"companions":[template()]
    });
    fs::write(package.join("manifest.json"), manifest.to_string()).unwrap();
    let mut record = json!({"id":PLUGIN,"version":"1.0.0","stagedPath":format!("installed-plugins/{PLUGIN}"),"sourceChecksum":"a".repeat(64)});
    let save = |record: &Value| {
        fs::write(
            dir.0.join("installed-plugins.json"),
            json!({"version":1,"plugins":[record]}).to_string(),
        )
        .unwrap()
    };
    save(&record);
    assert!(catalog::load(&dir.0, PLUGIN, false).is_err());
    let plugin = catalog::load(&dir.0, PLUGIN, true).unwrap();
    assert!(plugin.developer_sideload && plugin.owns_menu_command(COMMAND));
    assert!(!plugin.owns_menu_command("plugin.crystalBuilder.other"));
    assert!(catalog::load(&dir.0, "org.other", true).is_err());
    record["source"] = json!("catalog");
    record["repository"] = json!("jgassens/ChemDraft-CrystalBuilder-Plugin");
    record["checksumVerified"] = json!(true);
    save(&record);
    assert!(
        !catalog::load(&dir.0, PLUGIN, false)
            .unwrap()
            .developer_sideload
    );
    let mut updated = manifest;
    updated["permissions"] = json!(["native.execute"]);
    fs::write(package.join("manifest.json"), updated.to_string()).unwrap();
    assert!(catalog::load(&dir.0, PLUGIN, false).is_err());
    assert!(State::default().live(PLUGIN, Instant::now()).is_err());
}

fn rust_stub() -> &'static Path {
    static STUB: OnceLock<(TestDir, PathBuf)> = OnceLock::new();
    let (_, executable) = STUB.get_or_init(|| {
        let dir = TestDir::new();
        let path = dir
            .0
            .join(format!("xtal-stub{}", std::env::consts::EXE_SUFFIX));
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
        (dir, path)
    });
    executable
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
            |args, cwd, _| Ok(ChildProcess::spawn(rust_stub(), args, cwd).unwrap()),
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
    let row = Row::picked(
        PLUGIN,
        APP_ID.into(),
        App::read(platform, &app.path, None).unwrap(),
    );
    store.insert(row.clone()).unwrap();
    let mut allowed = row.clone();
    allowed.approve(&app, Some(pipeline.id.clone()), digest.clone());
    store.replace(&row, allowed.clone()).unwrap();
    assert!(allowed.grants(&app, &digest));
    // Disabling or re-enabling a plugin touches the native menu, not its persisted consent.
    let state = State::default();
    state.arm(PLUGIN, COMMAND, Instant::now());
    state.disarm(PLUGIN);
    assert!(state.live(PLUGIN, Instant::now()).is_err());
    assert!(store
        .get(PLUGIN, APP_ID)
        .unwrap()
        .unwrap()
        .grants(&app, &digest));
    let mut changed = template();
    changed["steps"][1]["timeoutSeconds"] = json!(6);
    assert!(!allowed.grants(
        &app,
        &serde_json::from_value::<Pipeline>(changed)
            .unwrap()
            .digest()
    ));

    fs::remove_file(tool).unwrap();
    assert!(matches!(
        app.verify(platform, Some(&pipeline)),
        Err(identity::Error::Changed)
    ));

    let path = dir.0.join("app-handoff").join("consents.json");
    let mut document: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    document["futureTop"] = json!(true);
    document["rows"][0]["futureRow"] = json!("kept");
    fs::write(&path, document.to_string()).unwrap();
    store.revoke(PLUGIN, APP_ID).unwrap();
    let revoked = store.get(PLUGIN, APP_ID).unwrap().unwrap();
    assert!(!revoked.grants(&app, &digest));
    assert!(
        store.replace(&allowed, allowed.clone()).is_err(),
        "revoked consent must not be restored by a stale box"
    );
    let saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["futureTop"], true);
    assert_eq!(saved["rows"][0]["futureRow"], "kept");
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
