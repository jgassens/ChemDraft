use super::*;
use catalog::{
    render_run, ToolRunInputs, CODEX_FEATURES_DISABLE, CODEX_FEATURES_KEEP,
    CODEX_FEATURES_PLATFORM_ONLY,
};
use env::ParentEnv;
use pins::ToolPlatform;
use probe::{Candidate, ProbePlatform};
use run::{OutputStream, RunStatus};
use std::{process::Command, sync::OnceLock, thread, time::Instant};

struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("chemdraft-tools-{}", nonce()));
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn map(pairs: &[(&str, &str)]) -> ParentEnv {
    pairs
        .iter()
        .map(|(k, v)| ((*k).into(), (*v).into()))
        .collect()
}
fn inputs(resume_id: Option<&str>) -> ToolRunInputs<'_> {
    ToolRunInputs {
        run_dir: Path::new("/runs/conversation"),
        prompt_file: "draw ethanol\nthen water",
        system_prompt_file: Path::new("/runs/conversation/system-prompt.md"),
        mcp_config_file: Path::new("/runs/conversation/claude-mcp.json"),
        mcp_url: "http://127.0.0.1:5321/mcp/route",
        resume_id,
        model: None,
        effort: None,
        managed_copy: false,
    }
}
#[test]
fn version_and_auth_parsers_fail_closed() {
    let claude = ToolId::Claude.spec();
    let codex = ToolId::Codex.spec();
    assert_eq!(claude.publisher, "Anthropic");
    assert_eq!(codex.publisher, "OpenAI");
    assert_eq!(
        claude.parse_version("2.1.296 (Claude Code)\n").as_deref(),
        Some("2.1.296")
    );
    assert_eq!(
        codex.parse_version("codex-cli 0.162.1\n").as_deref(),
        Some("0.162.1")
    );
    for bad in ["", "2.1", "2.1.259.3", "hello"] {
        assert!(claude.parse_version(bad).is_none());
    }
    assert!(claude.supports_version("2.1.259"));
    assert!(!claude.supports_version("2.1.258"));
    assert!(!claude.supports_version("bogus"));
    let auth = claude.parse_auth(Some(0), r#"{"loggedIn":true,"authMethod":"claude.ai"}"#, "");
    assert!(auth.signed_in);
    assert_eq!(auth.auth_method.as_deref(), Some("claude.ai"));
    for (code, json) in [
        (Some(1), r#"{"loggedIn":true}"#),
        (Some(0), r#"{"loggedIn":false}"#),
        (Some(0), r#"{"loggedIn":"true"}"#),
        (Some(0), "garbage"),
    ] {
        assert!(
            !claude
                .parse_auth(code, json, "Logged in using ChatGPT")
                .signed_in
        );
    }
    assert!(
        codex
            .parse_auth(Some(0), "Logged in using ChatGPT", "")
            .signed_in
    );
    assert!(!codex.parse_auth(Some(1), "", "Logged in").signed_in);
    assert!(!codex.parse_auth(Some(0), "", "noise Logged in").signed_in);
    assert!(
        codex
            .parse_auth(Some(0), "", "Logged in using ChatGPT\n")
            .signed_in
    );
    for code in [Some(0), Some(1), None] {
        assert!(!codex.parse_auth(code, "", "Not logged in\n").signed_in);
    }
    assert!(
        !claude
            .parse_auth(Some(0), "", r#"{"loggedIn":true}"#)
            .signed_in
    );
}
#[test]
fn claude_auth_method_fixtures_require_subscription_login() {
    for (method, signed_in, has_detail) in [
        ("claude.ai", true, false),
        ("oauth_token", true, false),
        ("api_key", false, true),
        ("api_key_helper", false, true),
        ("third_party", false, true),
        ("none", false, false),
        ("unknown", false, false),
    ] {
        let fixture = serde_json::json!({"loggedIn": true, "authMethod": method});
        let auth = ToolId::Claude
            .spec()
            .parse_auth(Some(0), &fixture.to_string(), "");
        assert_eq!(auth.signed_in, signed_in, "{method}");
        assert_eq!(auth.auth_method.as_deref(), Some(method));
        assert_eq!(auth.detail.is_some(), has_detail, "{method}");
        if let Some(detail) = auth.detail {
            assert!(detail.contains("claude auth login"));
            assert!(detail.contains("subscription login"));
        }
    }
}

#[test]
fn codex_auth_accepts_status_after_warning_on_either_stream() {
    let fixture = "Warning: optional configuration unavailable\nLogged in using ChatGPT\n";
    for (stdout, stderr) in [(fixture, ""), ("", fixture)] {
        assert!(
            ToolId::Codex
                .spec()
                .parse_auth(Some(0), stdout, stderr)
                .signed_in
        );
        assert!(
            !ToolId::Codex
                .spec()
                .parse_auth(Some(1), stdout, stderr)
                .signed_in
        );
    }
}

#[test]
fn recorded_auth_status_fixtures() {
    let claude = ToolId::Claude.spec();
    let signed_in = claude.parse_auth(
        Some(0),
        include_str!("fixtures/auth/claude-signed-in.json"),
        "",
    );
    assert!(signed_in.signed_in);
    assert_eq!(signed_in.auth_method.as_deref(), Some("claude.ai"));
    let signed_out = claude.parse_auth(
        Some(1),
        include_str!("fixtures/auth/claude-signed-out.json"),
        "",
    );
    assert!(!signed_out.signed_in);
    assert_eq!(signed_out.auth_method.as_deref(), Some("none"));
    let codex = ToolId::Codex.spec();
    assert!(
        codex
            .parse_auth(
                Some(0),
                "",
                include_str!("fixtures/auth/codex-signed-in.stderr")
            )
            .signed_in
    );
    assert!(
        !codex
            .parse_auth(
                Some(1),
                "",
                include_str!("fixtures/auth/codex-signed-out.stderr")
            )
            .signed_in
    );
}
#[test]
fn run_templates_first_turn_and_resume() {
    for tool in [ToolId::Claude, ToolId::Codex] {
        for resume in [None, Some("thread_123")] {
            let run = render_run(&tool.spec(), inputs(resume)).unwrap();
            for forbidden in [
                "--dangerously-skip-permissions",
                "--allow-dangerously-skip-permissions",
                "bypassPermissions",
                "--dangerously-bypass-approvals-and-sandbox",
                "danger-full-access",
                "--bare",
                "--ephemeral",
                "--no-session-persistence",
            ] {
                assert!(!run.args.iter().any(|a| a.contains(forbidden)));
            }
            assert!(!run.args.iter().any(|arg| arg.contains("draw ethanol")));
            if tool == ToolId::Claude {
                let expected = [
                    "-p",
                    "--input-format",
                    "stream-json",
                    "--output-format",
                    "stream-json",
                    "--verbose",
                    "--include-partial-messages",
                    "--strict-mcp-config",
                    "--mcp-config",
                    "/runs/conversation/claude-mcp.json",
                    "--tools",
                    "WebSearch,WebFetch",
                    "--allowedTools",
                    "mcp__chemdraft__*,WebSearch,WebFetch",
                    "--permission-mode",
                    "dontAsk",
                    "--permission-prompts",
                    "none",
                    "--max-turns",
                    "40",
                    "--system-prompt-file",
                    "/runs/conversation/system-prompt.md",
                    "--setting-sources",
                    "",
                    "--disable-slash-commands",
                    "--settings",
                    r#"{"disableAllHooks":true,"enabledPlugins":{"cc-plugin-agents-md@builtin":false,"cc-plugin-plugin-authoring@builtin":false}}"#,
                ];
                assert_eq!(run.args[..expected.len()], expected);
                if let Some(id) = resume {
                    assert_eq!(run.args[expected.len()..], ["--resume", id]);
                } else {
                    assert_eq!(run.args.len(), expected.len());
                }
                let message: serde_json::Value =
                    serde_json::from_str(run.stdin.as_ref().unwrap()).unwrap();
                assert_eq!(message["message"]["content"], inputs(None).prompt_file);
            } else {
                assert_eq!(run.args[0], "exec");
                assert_eq!(run.args.last().unwrap(), "-");
                assert_eq!(run.stdin.as_deref(), Some(inputs(None).prompt_file));
                let disabled: Vec<_> = run
                    .args
                    .windows(2)
                    .filter(|pair| pair[0] == "--disable")
                    .map(|pair| pair[1].as_str())
                    .collect();
                assert_eq!(disabled, CODEX_FEATURES_DISABLE);
                assert!(!run
                    .args
                    .iter()
                    .any(|arg| arg.starts_with("features.") || arg.starts_with("tools.")));
                assert!(run.args.contains(&"approval_policy=\"never\"".into()));
                assert!(run
                    .args
                    .windows(2)
                    .any(|pair| pair == ["-c", "web_search=\"live\""]));
                assert!(run
                    .args
                    .contains(&"mcp_servers.chemdraft.required=true".into()));
                assert!(run.args.contains(
                    &"mcp_servers.chemdraft.bearer_token_env_var=\"CHEMDRAFT_MCP_TOKEN\"".into()
                ));
                assert_eq!(run.args.contains(&"-C".into()), resume.is_none());
                assert_eq!(run.args.contains(&"--sandbox".into()), resume.is_none());
                assert_eq!(
                    run.args.contains(&"sandbox_mode=\"read-only\"".into()),
                    resume.is_some()
                );
                if let Some(id) = resume {
                    assert_eq!(run.args[1..3], ["resume", id]);
                }
            }
        }
    }
    for tool in [ToolId::Claude, ToolId::Codex] {
        let mut input = inputs(None);
        input.model = Some("model-1.2");
        input.effort = Some(Effort::High);
        let rendered = render_run(&tool.spec(), input).unwrap();
        assert!(rendered.args.contains(&"model-1.2".into()));
        let mut input = inputs(None);
        input.resume_id = Some("--dangerously-skip-permissions");
        // An id remains a value even when it begins with '-'; reject option-looking ids outright.
        assert!(render_run(&tool.spec(), input).is_err());
    }
}
#[test]
fn codex_feature_policy_has_no_duplicates_or_overlap() {
    let mut classified = std::collections::HashSet::new();
    for feature in CODEX_FEATURES_KEEP.iter().chain(CODEX_FEATURES_DISABLE) {
        assert!(
            classified.insert(feature),
            "Feature classified twice: {feature}"
        );
    }
}

// Deliberately opt-in: release checks must use the pins, not whichever CLI happens to be on PATH.
// Codex needs isolated config/auth to report defaults; Claude needs the real subscription login.
fn pinned_cli(tool: ToolId, variable: &str, dir: &Path) -> Option<(catalog::ToolSpec, ParentEnv)> {
    let Some(binary) = std::env::var_os(variable) else {
        eprintln!("Skipping pinned CLI parity: {variable} is unset.");
        return None;
    };
    let mut spec = tool.spec();
    spec.program = fs::canonicalize(binary).expect("pinned CLI binary must exist");
    let mut parent: ParentEnv = std::env::vars().collect();
    if tool == ToolId::Codex {
        let private_home = dir.join("home");
        fs::create_dir_all(&private_home).unwrap();
        for key in [
            "HOME",
            "USERPROFILE",
            "CODEX_HOME",
            "CLAUDE_CONFIG_DIR",
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
        ] {
            parent.insert(key.into(), private_home.to_string_lossy().into_owned());
        }
    }
    let version = parity_probe(&spec, spec.version_args, &parent, dir);
    let expected = match tool {
        ToolId::Claude => pins::CLAUDE_VERSION,
        ToolId::Codex => pins::CODEX_VERSION,
    };
    assert_eq!(version.code, Some(0), "{}", version.stderr);
    assert_eq!(
        spec.parse_version(&version.stdout).as_deref(),
        Some(expected),
        "{variable} must point at the pinned version"
    );
    Some((spec, parent))
}

fn parity_probe(
    spec: &catalog::ToolSpec,
    args: &[&str],
    parent: &ParentEnv,
    dir: &Path,
) -> probe::ProbeOutput {
    probe::execute(
        &spec.program,
        args,
        parent,
        dir,
        true,
        Duration::from_secs(30),
        1024 * 1024,
    )
    .expect("pinned CLI parity probe must finish within 30 seconds and the output cap")
}

fn codex_feature_rows(output: &str) -> Vec<(&str, bool)> {
    output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let mut fields = line.split_whitespace();
            let name = fields.next().expect("feature name");
            // The stage can contain spaces (e.g. 'under development'); the last field is the default.
            let enabled = match fields.next_back() {
                Some("true") => true,
                Some("false") => false,
                _ => panic!("Unexpected features list row: {line}"),
            };
            (name, enabled)
        })
        .collect()
}

#[test]
fn codex_feature_rows_parse_multiword_stages() {
    assert_eq!(
        codex_feature_rows("apps stable true\nexperimental_tool under development false\n"),
        [("apps", true), ("experimental_tool", false)]
    );
}

fn classify_codex_features_with_platform_only(
    features: &[(&str, bool)],
    platform: ToolPlatform,
    keep: &[&str],
    disable: &[&str],
    platform_only: &[(&str, &[ToolPlatform])],
) -> Result<(), String> {
    for feature in keep.iter().chain(disable) {
        if !features.iter().any(|(name, _)| name == feature) {
            if platform_only
                .iter()
                .any(|(name, platforms)| name == feature && !platforms.contains(&platform))
            {
                continue;
            }
            return Err(format!(
                "Classified Codex feature not listed on this platform: {feature}"
            ));
        }
    }
    for &(name, enabled) in features {
        if enabled && !keep.contains(&name) && !disable.contains(&name) {
            return Err(format!("Unclassified default-on Codex feature: {name}"));
        }
    }
    Ok(())
}

fn classify_codex_features(
    features: &[(&str, bool)],
    platform: ToolPlatform,
) -> Result<(), String> {
    classify_codex_features_with_platform_only(
        features,
        platform,
        CODEX_FEATURES_KEEP,
        CODEX_FEATURES_DISABLE,
        CODEX_FEATURES_PLATFORM_ONLY,
    )
}

#[test]
fn codex_feature_classification_allows_explicit_platform_only_absence() {
    let features = codex_feature_rows("apps stable true\n");
    let platform_only = [("auth_elicitation", &[ToolPlatform::WindowsX64][..])];
    assert_eq!(
        classify_codex_features_with_platform_only(
            &features,
            ToolPlatform::DarwinArm64,
            &["apps", "auth_elicitation"],
            &[],
            &platform_only
        ),
        Ok(())
    );
}

#[test]
fn codex_feature_classification_rejects_missing_disable_entry() {
    let typo = "typo_feature";
    let features = codex_feature_rows("apps stable true\n");
    assert_eq!(
        classify_codex_features_with_platform_only(
            &features,
            ToolPlatform::DarwinArm64,
            &["apps"],
            &[typo],
            &[],
        ),
        Err(format!(
            "Classified Codex feature not listed on this platform: {typo}"
        ))
    );
}

#[test]
fn codex_feature_classification_rejects_unknown_default_on() {
    assert_eq!(
        classify_codex_features_with_platform_only(
            &codex_feature_rows("unknown_tool stable true\n"),
            ToolPlatform::DarwinArm64,
            &[],
            &[],
            &[],
        ),
        Err("Unclassified default-on Codex feature: unknown_tool".into())
    );
    assert_eq!(
        classify_codex_features_with_platform_only(
            &codex_feature_rows("unknown_tool stable false\n"),
            ToolPlatform::DarwinArm64,
            &[],
            &[],
            &[],
        ),
        Ok(())
    );
}

#[test]
#[ignore = "set CHEMDRAFT_PINNED_CODEX to the pinned native binary; run before updating pins"]
fn pinned_codex_accepts_rendered_run() {
    let temp = TempDir::new();
    let Some((spec, parent)) = pinned_cli(ToolId::Codex, "CHEMDRAFT_PINNED_CODEX", &temp.0) else {
        return;
    };
    let output = parity_probe(&spec, &["features", "list"], &parent, &temp.0);
    assert_eq!(output.code, Some(0), "{}", output.stderr);
    let features = codex_feature_rows(&output.stdout);
    assert!(!features.is_empty(), "features list must report features");
    let platform = current_platform().expect("pinned parity runs on a supported desktop platform");
    classify_codex_features(&features, platform).unwrap_or_else(|message| panic!("{message}"));

    let system_prompt = temp.0.join("system-prompt.md");
    fs::write(&system_prompt, "ChemDraft CLI parity check.").unwrap();
    let mut input = inputs(None);
    input.run_dir = &temp.0;
    input.system_prompt_file = &system_prompt;
    input.effort = Some(Effort::High);
    let mut rendered = render_run(&spec, input).unwrap();
    assert!(rendered
        .args
        .windows(2)
        .any(|pair| pair == ["-c", "web_search=\"live\""]));
    let disabled: Vec<_> = rendered
        .args
        .windows(2)
        .filter(|pair| pair[0] == "--disable")
        .map(|pair| pair[1].as_str())
        .collect();
    assert_eq!(disabled, CODEX_FEATURES_DISABLE);
    // An undefined provider exits before ignored-setting diagnostics are emitted. Instead use a
    // valid local provider whose required key is absent from the scrubbed environment: config
    // validation completes, then authentication fails before any model request. Disable the MCP
    // connection for this check while still parsing every rendered MCP setting.
    rendered.args.splice(
        rendered.args.len() - 1..rendered.args.len() - 1,
        [
            "-c".into(),
            "model=\"chemdraft-parity-check-does-not-exist\"".into(),
            "-c".into(),
            "model_provider=\"chemdraft-parity\"".into(),
            "-c".into(),
            "model_providers.chemdraft-parity={name=\"Parity\",base_url=\"http://127.0.0.1:1\",env_key=\"CHEMDRAFT_PARITY_NO_SUCH_KEY\",wire_api=\"responses\"}".into(),
            "-c".into(),
            "mcp_servers.chemdraft.enabled=false".into(),
        ],
    );
    let environment = env::child_env(
        ProbePlatform::current(),
        &parent,
        &spec.program,
        &temp.0,
        true,
    );
    let run = ToolRun::spawn_with_output_limit(
        rendered,
        &temp.0,
        &environment,
        Duration::from_secs(30),
        Some(1024 * 1024),
    )
    .unwrap();
    let output = run
        .capture_output(1024 * 1024, || false)
        .unwrap_or_else(|_| panic!("Pinned CLI exceeded the parity output cap"));
    assert!(
        matches!(output.status, RunStatus::Exited { code: Some(code), .. } if code != 0),
        "{:?}",
        output.status
    );
    let diagnostics = format!("{}\n{}", output.stdout, output.stderr).to_ascii_lowercase();
    assert!(
        diagnostics.contains("missing environment variable: `chemdraft_parity_no_such_key`"),
        "Must finish config validation and fail local authentication: {diagnostics}"
    );
    for line in diagnostics.lines() {
        assert!(
            ![
                "unrecognized",
                "ignored",
                "ignoring",
                "unknown",
                "unexpected argument"
            ]
            .iter()
            .any(|word| line.contains(word)),
            "Pinned CLI rejected a flag or setting: {line}"
        );
    }
}

#[test]
#[ignore = "set CHEMDRAFT_PINNED_CLAUDE to the pinned native binary; run before updating pins"]
fn pinned_claude_accepts_rendered_run() {
    let temp = TempDir::new();
    let Some((spec, parent)) = pinned_cli(ToolId::Claude, "CHEMDRAFT_PINNED_CLAUDE", &temp.0)
    else {
        return;
    };
    let help = parity_probe(&spec, &["--help"], &parent, &temp.0);
    assert_eq!(help.code, Some(0), "{}", help.stderr);
    // Claude --help does not list every supported flag. These hidden flags are documented in the
    // Claude Code CLI reference (https://code.claude.com/docs/en/cli-reference) and Appendix A of
    // the assistant design. Check that reference before treating a newly missing flag as invalid.
    const UNLISTED_FLAGS: &[&str] = &["--max-turns", "--system-prompt-file"];
    let mut input = inputs(Some("thread_123"));
    input.model = Some("model-1.2");
    input.effort = Some(Effort::High);
    let rendered = render_run(&spec, input).unwrap();
    for flag in rendered.args.iter().filter(|arg| arg.starts_with('-')) {
        assert!(
            help.stdout
                .split_whitespace()
                .any(|word| word.trim_end_matches(',') == flag)
                || UNLISTED_FLAGS.contains(&flag.as_str()),
            "Pinned Claude help is missing {flag}; check the CLI reference"
        );
    }

    // Plant project configuration so isolation is exercised even on a clean host.
    let run_dir = temp.0.join("run");
    fs::create_dir(&run_dir).unwrap();
    let claude_dir = run_dir.join(".claude");
    fs::create_dir_all(claude_dir.join("skills/planted-skill")).unwrap();
    fs::create_dir_all(claude_dir.join("commands")).unwrap();
    let hook_marker = run_dir.join("planted-hook-marker");
    // Relative command works in both the Unix shell and Windows cmd.exe.
    fs::write(claude_dir.join("settings.json"),
        serde_json::to_vec(&serde_json::json!({
            "hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": "echo planted > planted-hook-marker"}]}]},
            "enabledPlugins": {"planted@planted": true}
        })).unwrap()).unwrap();
    fs::write(claude_dir.join("skills/planted-skill/SKILL.md"),
        "---\nname: planted-skill\ndescription: Planted parity skill.\n---\nReport planted skill.\n").unwrap();
    fs::write(
        claude_dir.join("commands/planted.md"),
        "Report planted command.",
    )
    .unwrap();
    fs::write(
        run_dir.join(".mcp.json"),
        r#"{"mcpServers":{"planted":{"type":"http","url":"http://127.0.0.1:1/mcp/planted"}}}"#,
    )
    .unwrap();
    fs::write(
        run_dir.join("CLAUDE.md"),
        "Planted project instructions for parity check.",
    )
    .unwrap();
    let system_prompt = temp.0.join("system-prompt.md");
    let mcp_config = temp.0.join("claude-mcp.json");
    fs::write(&system_prompt, "ChemDraft CLI parity check.").unwrap();
    fs::write(
        &mcp_config,
        r#"{"mcpServers":{"chemdraft":{"type":"http","url":"http://127.0.0.1:1/mcp/parity"}}}"#,
    )
    .unwrap();
    let mut input = inputs(None);
    input.run_dir = &run_dir;
    input.prompt_file = "ChemDraft parity check.";
    input.system_prompt_file = &system_prompt;
    input.mcp_config_file = &mcp_config;
    let mut rendered = render_run(&spec, input).unwrap();
    rendered.args.extend([
        "--model".into(),
        "chemdraft-parity-check-does-not-exist".into(),
    ]);
    // Observability only: surface lifecycle events to detect hooks before init.
    rendered.args.push("--include-hook-events".into());
    // Test-only: no resume needed, and no transcript left in the user's login directory.
    rendered.args.push("--no-session-persistence".into());
    let environment = env::child_env(
        ProbePlatform::current(),
        &parent,
        &spec.program,
        &run_dir,
        true,
    );
    let run = ToolRun::spawn_with_output_limit(
        rendered,
        &run_dir,
        &environment,
        Duration::from_secs(60),
        Some(1024 * 1024),
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut cursor = 0;
    let mut diagnostics = String::new();
    let mut events = Vec::new();
    let mut init = None;
    let mut bounded_output = true;
    while Instant::now() < deadline {
        let poll = run.poll(cursor, 5000, 100);
        cursor = poll.next_cursor;
        let drained = poll.lines.is_empty();
        bounded_output &= poll.dropped_lines == 0 && !run.output_limit_exceeded();
        for line in poll.lines {
            bounded_output &= !line.truncated;
            diagnostics.push_str(&line.text);
            diagnostics.push('\n');
            if line.stream == OutputStream::Stdout {
                if let Ok(event) = serde_json::from_str::<serde_json::Value>(&line.text) {
                    if event["type"] == "system" && event["subtype"] == "init" {
                        init = Some(event.clone());
                    }
                    events.push(event);
                }
            }
        }
        if init.is_some() || !bounded_output || (!poll.status.is_running() && drained) {
            break;
        }
    }
    // Always kill/reap before assertions (including failure), leaving no CLI behind.
    run.cancel(run::KillReason::Cancelled);
    assert!(
        run.wait_finished(Duration::from_secs(5)),
        "Claude parity process did not stop"
    );
    assert!(
        !hook_marker.exists(),
        "Claude ran the planted SessionStart hook"
    );
    assert!(bounded_output, "Claude parity exceeded the output cap");
    for event in &events {
        for field in ["type", "subtype"] {
            assert!(
                !event[field]
                    .as_str()
                    .is_some_and(|s| s.to_ascii_lowercase().contains("hook")),
                "Claude emitted a hook event: {event}"
            );
        }
    }
    let init = init.unwrap_or_else(|| {
        panic!("Claude did not emit system/init within 60 seconds: {diagnostics}")
    });
    assert_claude_init_is_restricted(&init);
}

// Fail closed on unexpected init shapes as well as unexpected capabilities.
fn assert_claude_init_is_restricted(init: &serde_json::Value) {
    let tools = init["tools"].as_array().expect("init must list tools");
    for required in ["WebSearch", "WebFetch"] {
        assert_eq!(
            tools
                .iter()
                .filter(|tool| tool.as_str() == Some(required))
                .count(),
            1,
            "Claude must expose {required} exactly once: {tools:?}"
        );
    }
    for tool in tools {
        let name = tool.as_str().expect("tool name must be a string");
        // CLI reference: https://code.claude.com/docs/en/cli-reference
        // The pinned CLI may retain EndConversation alongside explicitly enabled tools.
        assert!(
            name.starts_with("mcp__chemdraft__")
                || matches!(name, "EndConversation" | "WebSearch" | "WebFetch"),
            "Unexpected Claude tool: {name}"
        );
    }
    let servers = init["mcp_servers"]
        .as_array()
        .expect("init must list MCP servers");
    assert_eq!(
        servers.len(),
        1,
        "init must list only the configured MCP server"
    );
    assert_eq!(servers[0]["name"], "chemdraft");
    assert_eq!(
        init["plugins"]
            .as_array()
            .expect("init must list plugins")
            .len(),
        0,
        "Claude loaded plugins: {}",
        init["plugins"]
    );
    for (key, value) in init.as_object().expect("init must be an object") {
        if key == "slash_commands" || key.to_ascii_lowercase().contains("skill") {
            assert!(
                value.as_array().is_some_and(Vec::is_empty),
                "Claude exposed commands/skills in {key}: {value}"
            );
        }
    }
}

#[test]
fn claude_init_restriction_assertions_reject_extra_capabilities() {
    let init = serde_json::json!({"tools":["WebSearch", "WebFetch", "EndConversation", "mcp__chemdraft__draw"], "mcp_servers":[{"name":"chemdraft","status":"failed"}], "plugins":[], "slash_commands":[], "skills":[]});
    assert_claude_init_is_restricted(&init);
    for (key, value) in [
        ("tools", serde_json::json!(["WebSearch"])),
        ("tools", serde_json::json!(["WebFetch"])),
        (
            "tools",
            serde_json::json!(["WebSearch", "WebFetch", "Bash"]),
        ),
        (
            "tools",
            serde_json::json!(["WebSearch", "WebFetch", "Read"]),
        ),
        (
            "tools",
            serde_json::json!(["WebSearch", "WebFetch", "Edit"]),
        ),
        (
            "tools",
            serde_json::json!(["WebSearch", "WebFetch", "WebFetch"]),
        ),
        (
            "tools",
            serde_json::json!(["WebSearch", "WebFetch", "mcp__other__draw"]),
        ),
        ("mcp_servers", serde_json::json!([{"name":"other"}])),
        ("mcp_servers", serde_json::json!([])),
        ("plugins", serde_json::json!([{"name":"user-plugin"}])),
        ("slash_commands", serde_json::json!(["user-command"])),
        ("skills", serde_json::json!(["user-skill"])),
    ] {
        let mut bad = init.clone();
        bad[key] = value;
        assert!(
            std::panic::catch_unwind(|| assert_claude_init_is_restricted(&bad)).is_err(),
            "Accepted unexpected {key}"
        );
    }
}

#[test]
fn pins_are_complete_and_valid() {
    assert_eq!(pins::PINS.len(), 6);
    for pin in &pins::PINS {
        assert_eq!(pin.sha256.len(), 64);
        assert!(pin.sha256.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(pin.size, 0);
        assert!(pin.url.starts_with("https://"));
        assert!(!pin.entry.is_empty());
        assert!(!pin.binary.is_empty());
        assert_eq!(pins::pin_for(pin.tool, pin.platform).url, pin.url);
    }
}
#[test]
fn zip_tree_pin_binaries_are_safe_relative_paths() {
    for pin in pins::PINS
        .iter()
        .filter(|pin| pin.archive == pins::ArchiveKind::ZipTree)
    {
        let path = std::path::Path::new(pin.binary);
        assert!(path.is_relative(), "{}", pin.binary);
        assert!(
            path.components()
                .all(|component| matches!(component, std::path::Component::Normal(_))),
            "{}",
            pin.binary
        );
    }
}
#[test]
fn environment_is_an_allowlist_for_both_platforms() {
    let parent = map(&[
        ("HOME", "/home/user"),
        ("USERPROFILE", r"C:\Users\user"),
        ("SystemRoot", r"D:\Windows"),
        ("PATH", "/untrusted/node/bin"),
        ("HTTP_PROXY", "http://proxy"),
        ("LC_ALL", "en_US.UTF-8"),
        ("XDG_CONFIG_HOME", "/home/user/.config"),
        ("ANTHROPIC_API_KEY", "secret"),
        ("OPENAI_API_KEY", "secret"),
        ("CODEX_API_KEY", "secret"),
        ("CHEMDRAFT_AGENT_BRIDGE", "1"),
        ("CHEMDRAFT_MCP_TOKEN", "secret"),
        ("NODE_OPTIONS", "--require evil"),
        ("DYLD_INSERT_LIBRARIES", "evil"),
        ("LD_PRELOAD", "evil"),
        ("DISABLE_UPDATES", "1"),
        ("SHELL", "/evil"),
    ]);
    for platform in [ProbePlatform::MacOS, ProbePlatform::Windows] {
        for managed in [false, true] {
            let binary = if platform == ProbePlatform::Windows {
                Path::new(r"C:\Tools\codex.exe")
            } else {
                Path::new("/tools/codex")
            };
            let child = env::child_env(platform, &parent, binary, Path::new("run"), managed);
            for key in [
                "ANTHROPIC_API_KEY",
                "OPENAI_API_KEY",
                "CODEX_API_KEY",
                "CHEMDRAFT_AGENT_BRIDGE",
                "CHEMDRAFT_MCP_TOKEN",
                "NODE_OPTIONS",
                "DYLD_INSERT_LIBRARIES",
                "LD_PRELOAD",
                "SHELL",
            ] {
                assert!(!child.contains_key(key));
            }
            assert_eq!(child.get("HOME"), parent.get("HOME"));
            assert_eq!(child["HTTP_PROXY"], "http://proxy");
            assert_eq!(child["TERM"], "dumb");
            assert_eq!(child["NO_COLOR"], "1");
            for key in ["TMPDIR", "TEMP", "TMP"] {
                assert_eq!(child[key], "run");
            }
            assert_eq!(child.contains_key("DISABLE_UPDATES"), managed);
            if platform == ProbePlatform::MacOS {
                assert_eq!(child["PATH"], "/tools:/usr/bin:/bin:/usr/sbin:/sbin");
                assert!(!child.contains_key("SystemRoot"));
            } else {
                assert_eq!(
                    child["PATH"],
                    r"C:\Tools;D:\Windows\System32;D:\Windows;D:\Windows\System32\Wbem"
                );
            }
        }
    }
}
#[test]
fn discovery_both_platforms_and_batch_shims() {
    let mac = probe::candidate_paths(
        ToolId::Claude,
        ProbePlatform::MacOS,
        Path::new("/Users/a"),
        &ParentEnv::new(),
        Some(":/shell/bin:/opt/homebrew/bin:"),
    );
    assert_eq!(
        mac,
        [
            "/Users/a/.local/bin/claude",
            "/opt/homebrew/bin/claude",
            "/usr/local/bin/claude",
            "/Users/a/.codex/bin/claude",
            "/Users/a/.npm-global/bin/claude",
            "/shell/bin/claude"
        ]
        .map(PathBuf::from)
    );
    let parent = map(&[
        ("USERPROFILE", r"C:\Users\a"),
        ("LOCALAPPDATA", r"C:\Local"),
        ("APPDATA", r"C:\Roaming"),
        ("ProgramFiles", r"C:\Program Files"),
        ("PATH", r";C:\Path;"),
        ("PATHEXT", ".CMD;.EXE;.BAT"),
    ]);
    let windows = probe::candidate_paths(
        ToolId::Codex,
        ProbePlatform::Windows,
        Path::new("ignored"),
        &parent,
        None,
    );
    assert_eq!(
        windows[0],
        PathBuf::from(r"C:\Users\a\.local\bin\codex.exe")
    );
    for path in [
        r"C:\Local\Microsoft\WinGet\Links\codex.exe",
        r"C:\Roaming\npm\codex.cmd",
        r"C:\Program Files\nodejs\codex.exe",
        r"C:\Path\codex.exe",
    ] {
        assert!(windows.contains(&PathBuf::from(path)));
    }
    let paths = [
        PathBuf::from("codex.cmd"),
        PathBuf::from("codex.bat"),
        PathBuf::from("codex.exe"),
    ];
    assert_eq!(
        probe::resolve_candidates(&paths, |_| true),
        Candidate::Runnable(PathBuf::from("codex.exe"))
    );
    assert_eq!(
        probe::resolve_candidates(&paths[..2], |_| true),
        Candidate::ShimNeedsResolution(PathBuf::from("codex.cmd"))
    );
    assert_eq!(
        probe::resolve_candidates(&paths, |_| false),
        Candidate::Missing
    );
}
#[test]
fn login_shell_markers_and_probe_cache() {
    assert_eq!(
        probe::parse_login_shell_path(
            "welcome\nnoise\n__CHEMDRAFT_PATH__/bin:/usr/bin\nmore noise"
        )
        .unwrap(),
        "/bin:/usr/bin"
    );
    assert!(probe::parse_login_shell_path("noise only").is_err());
    assert!(probe::parse_login_shell_path("__CHEMDRAFT_PATH__\n").is_err());
    let cache = probe::ProbeCache::default();
    assert_eq!(
        cache
            .get_or_probe(ToolId::Claude, false, || Err("cached".into()))
            .unwrap_err(),
        "cached"
    );
    assert_eq!(
        cache
            .get_or_probe(ToolId::Claude, false, || panic!(
                "cached value must be used"
            ))
            .unwrap_err(),
        "cached"
    );
    assert_eq!(
        cache
            .get_or_probe(ToolId::Claude, true, || Err("fresh".into()))
            .unwrap_err(),
        "fresh"
    );
}

#[test]
fn probing_releases_cache_lock_and_does_not_store_invalidated_results() {
    let cache = probe::ProbeCache::default();
    cache
        .get_or_probe(ToolId::Claude, false, || {
            // This would deadlock if the cache mutation lock were held during probing.
            cache.invalidate(ToolId::Claude);
            Err("stale".into())
        })
        .unwrap_err();
    assert_eq!(
        cache
            .get_or_probe(ToolId::Claude, false, || Err("fresh".into()))
            .unwrap_err(),
        "fresh"
    );
}

fn stub() -> &'static Path {
    static STUB: OnceLock<PathBuf> = OnceLock::new();
    STUB.get_or_init(||{
        let root=std::env::temp_dir().join(format!("chemdraft-tool-stub-{}",nonce()));fs::create_dir_all(&root).unwrap();
        let source=root.join("stub.rs");let binary=root.join(if cfg!(windows) {"stub.exe"}else {"stub"});
        fs::write(&source,r#"
use std::{env,fs,io::{self,Read,Write},process::{Command,Stdio},thread,time::Duration};
fn main() {
 let args:Vec<_>=env::args().collect();
 if matches!(args.get(1).map(String::as_str), Some("-p" | "exec"))
     && fs::read_to_string("system-prompt.md").is_ok_and(|s| s.starts_with("mcp-live")) {
   mcp_live(&args);
   return;
 }
 match args.get(1).map(String::as_str).unwrap_or("") {
  "--version"=>{println!("2.1.296 (Claude Code)");},
  "codex-version"=>{println!("codex-cli 0.163.0");},
  "auth"=>{println!("{{\"loggedIn\":true,\"authMethod\":\"claude.ai\"}}");},
  "login"=>{eprintln!("Logged in using ChatGPT");},
  "lines"=>{
   println!("out-1");io::stdout().flush().unwrap();thread::sleep(Duration::from_millis(60));
   eprintln!("err-1");io::stderr().flush().unwrap();thread::sleep(Duration::from_millis(60));
   println!("out-2");let mut input=String::new();io::stdin().read_to_string(&mut input).unwrap();println!("stdin:{input}");
  },
  "long"=>{println!("{}", "x".repeat(300_000));println!("after");},
  "overflow"=>{for i in 0..21_000 {println!("{i}");}},
  "bytes"=>{for _ in 0..20 {println!("{}","x".repeat(256*1024));}},
  "descendant"=>{
    // Ignore Ctrl-C so cancellation must use the hard-kill path.
    #[cfg(unix)] unsafe { unsafe extern "C" {fn signal(sig:i32,handler:usize)->usize;} signal(2,1); }
    fs::write(&args[2],"ready").unwrap();thread::sleep(Duration::from_secs(4));fs::write(&args[3],"survived").unwrap();thread::sleep(Duration::from_secs(30));
  },
  "tree"=>{
    #[cfg(unix)] unsafe { unsafe extern "C" {fn signal(sig:i32,handler:usize)->usize;} signal(2,1); }
    let mut command=Command::new(env::current_exe().unwrap());
    command.args(["descendant",&args[2],&args[3]]).stdin(Stdio::null());
    #[cfg(windows)] {use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
    let _child=command.spawn().unwrap();thread::sleep(Duration::from_secs(30));
  },
  "sleep"=>{thread::sleep(Duration::from_secs(30));},
  "flood"=>{for _ in 0..70_000 {print!("x");}println!();},
  _=>{},
 }
}

fn json_string<'a>(text: &'a str, key: &str) -> &'a str {
 text.split(&format!("\"{key}\":\"")).nth(1).unwrap().split('"').next().unwrap()
}
fn post(url: &str, token: &str, session: bool, body: &str) -> String {
 let (host,path)=url.strip_prefix("http://").unwrap().split_once('/').unwrap();
 let mut socket=std::net::TcpStream::connect(host).unwrap();
 socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
 let session_header=if session {format!("Mcp-Session-Id: {}\r\n",path.strip_prefix("mcp/").unwrap())} else {String::new()};
 let request=format!("POST /{path} HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{session_header}\r\n{body}",body.len());
 socket.write_all(request.as_bytes()).unwrap();
 let mut response=String::new();socket.read_to_string(&mut response).unwrap();
 assert!(response.starts_with("HTTP/1.1 200"),"{response}");
 response
}
fn mcp_live(args: &[String]) {
 let (url,token)=if args[1]=="-p" {
   assert!(env::var("CHEMDRAFT_MCP_TOKEN").is_err());
   let index=args.iter().position(|a|a=="--mcp-config").unwrap();
   let config=fs::read_to_string(&args[index+1]).unwrap();
   assert_eq!(json_string(&config,"type"),"http");
   (json_string(&config,"url").to_owned(),json_string(&config,"Authorization").strip_prefix("Bearer ").unwrap().to_owned())
 } else {
   assert!(args.iter().any(|a|a=="mcp_servers.chemdraft.bearer_token_env_var=\"CHEMDRAFT_MCP_TOKEN\""));
   (args.iter().find_map(|a|a.strip_prefix("mcp_servers.chemdraft.url=")).unwrap().trim_matches('"').to_owned(),env::var("CHEMDRAFT_MCP_TOKEN").unwrap())
 };
 assert_eq!(token.len(),64);
 assert!(args.iter().all(|a|!a.contains(&token)));
 let initialized=post(&url,&token,false,"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\"}}");
 assert!(initialized.contains("\"serverInfo\""));
 let listed=post(&url,&token,true,"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}");
 assert!(listed.contains("\"tools\":[]"));
 println!("mcp-live-ok");io::stdout().flush().unwrap();
 if fs::read_to_string("system-prompt.md").unwrap()=="mcp-live-wait" {
   while !std::path::Path::new("release").exists() { thread::sleep(Duration::from_millis(20)); }
 }
}
"#).unwrap();
        let output=Command::new("rustc").args(["--crate-name","chemdraft_external_tool_stub","--edition=2021"]).arg(&source).arg("-o").arg(&binary).output().unwrap();
        assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));binary
    })
}
fn rendered(args: &[&str], stdin: Option<&str>) -> RenderedRun {
    RenderedRun {
        program: stub().to_owned(),
        args: args.iter().map(|s| (*s).into()).collect(),
        env: Vec::new(),
        stdin: stdin.map(str::to_owned),
    }
}
fn spawn(args: &[&str], stdin: Option<&str>, cwd: &Path, timeout: Duration) -> Arc<ToolRun> {
    ToolRun::spawn(
        rendered(args, stdin),
        cwd,
        &env::child_env(
            ProbePlatform::current(),
            &ParentEnv::new(),
            stub(),
            cwd,
            false,
        ),
        timeout,
    )
    .unwrap()
}
fn finished(run: &ToolRun) -> run::ExternalToolRunPoll {
    assert!(run.wait_finished(Duration::from_secs(8)));
    run.poll(0, 5000, 0)
}
#[test]
fn line_streams_stdin_and_cursor_delivery() {
    let temp = TempDir::new();
    let run = spawn(&["lines"], Some("hello"), &temp.0, Duration::from_secs(10));
    let mut cursor = 0;
    let mut lines = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        assert!(Instant::now() < deadline);
        let poll = run.poll(cursor, 1, 1000);
        assert!(poll.lines.len() <= 1);
        cursor = poll.next_cursor;
        let empty = poll.lines.is_empty();
        lines.extend(poll.lines);
        if !poll.status.is_running() && empty {
            break;
        }
    }
    assert_eq!(
        lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(),
        ["out-1", "err-1", "out-2", "stdin:hello"]
    );
    assert_eq!(
        lines.iter().map(|l| l.seq).collect::<Vec<_>>(),
        [0, 1, 2, 3]
    );
    assert_eq!(lines[1].stream, OutputStream::Stderr);
    assert_eq!(cursor, 4);
    assert!(run.poll(cursor, 5000, 1000).lines.is_empty());
    assert!(matches!(
        run.status(),
        RunStatus::Exited { code: Some(0), .. }
    ));
}
#[test]
fn truncated_lines_and_both_ring_limits() {
    let temp = TempDir::new();
    let run = spawn(&["long"], None, &temp.0, Duration::from_secs(10));
    let poll = finished(&run);
    assert_eq!(poll.lines.len(), 2);
    assert_eq!(poll.lines[0].text.len(), run::MAX_LINE_BYTES);
    assert!(poll.lines[0].truncated);
    assert_eq!(poll.lines[1].text, "after");
    let run = spawn(&["overflow"], None, &temp.0, Duration::from_secs(10));
    assert!(run.wait_finished(Duration::from_secs(10)));
    let poll = run.poll(0, usize::MAX, 0);
    assert_eq!(poll.lines.len(), 5000);
    assert_eq!(poll.dropped_lines, 1000);
    assert_eq!(poll.lines[0].seq, 1000);
    assert_eq!(poll.next_cursor, 6000);
    let run = spawn(&["bytes"], None, &temp.0, Duration::from_secs(10));
    let poll = finished(&run);
    assert_eq!(poll.dropped_lines, 4);
    assert_eq!(poll.lines.len(), 16);
    assert_eq!(
        poll.lines.iter().map(|l| l.text.len()).sum::<usize>(),
        run::MAX_BYTES
    );
}
fn wait_file(path: &Path) {
    let until = Instant::now() + Duration::from_secs(30);
    while !path.exists() {
        assert!(Instant::now() < until, "child never started");
        thread::sleep(Duration::from_millis(10));
    }
}
#[test]
fn timeout_and_cancel_kill_descendants() {
    for cancel in [false, true] {
        let temp = TempDir::new();
        let ready = temp.0.join("ready");
        let survived = temp.0.join("survived");
        let run = spawn(
            &["tree", ready.to_str().unwrap(), survived.to_str().unwrap()],
            None,
            &temp.0,
            if cancel {
                Duration::from_secs(20)
            } else {
                Duration::from_secs(1)
            },
        );
        wait_file(&ready);
        let started = Instant::now();
        if cancel {
            run.cancel(KillReason::Cancelled);
        }
        let poll = finished(&run);
        assert_eq!(
            poll.status,
            RunStatus::Killed {
                reason: if cancel {
                    KillReason::Cancelled
                } else {
                    KillReason::Timeout
                }
            }
        );
        // The stub writes after four seconds. Observe past that deadline even for a fast cancel.
        thread::sleep(Duration::from_millis(4500).saturating_sub(started.elapsed()));
        assert!(!survived.exists(), "descendant survived tree kill");
    }
}
fn request(tool: ToolId, conversation: &str) -> ExternalToolRunRequest {
    ExternalToolRunRequest {
        tool,
        plugin_id: "org.chemdraft.test".into(),
        conversation_id: conversation.into(),
        prompt: "hello".into(),
        system_prompt: "system".into(),
        resume_id: None,
        model: None,
        effort: None,
        mcp_session_id: "mcp12345".into(),
        timeout_ms: Some(10_000),
    }
}

#[test]
fn capability_is_main_only_and_exactly_matches_registered_commands() {
    use std::collections::BTreeSet;
    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../../capabilities/external-tools.json")).unwrap();
    assert_eq!(capability["identifier"], "external-tools");
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    assert!(capability.get("webviews").is_none());
    assert!(capability.get("remote").is_none());
    let source = include_str!("../lib.rs");
    let handler = source
        .split("generate_handler![")
        .nth(1)
        .unwrap()
        .split(']')
        .next()
        .unwrap();
    let commands: BTreeSet<_> = handler
        .lines()
        .filter_map(|line| {
            line.trim()
                .trim_end_matches(',')
                .strip_prefix("external_tools::")
        })
        .collect();
    assert_eq!(commands.len(), 13);
    let expected: BTreeSet<_> = commands
        .iter()
        .map(|c| format!("allow-{}", c.replace('_', "-")))
        .collect();
    let actual: BTreeSet<_> = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    assert_eq!(expected, actual);
    assert_eq!(
        actual.len(),
        capability["permissions"].as_array().unwrap().len()
    );
    for command in commands {
        let permission = fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("permissions/autogenerated")
                .join(format!("{command}.toml")),
        )
        .unwrap();
        assert!(permission.contains(&format!("commands.allow = [\"{command}\"]")));
    }
    // A second grant must not expose these commands to a utility window.
    for file in fs::read_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities")).unwrap() {
        let path = file.unwrap().path();
        if path.extension().is_some_and(|e| e == "json")
            && path.file_name().unwrap() != "external-tools.json"
        {
            assert!(!fs::read_to_string(path)
                .unwrap()
                .contains("allow-external-tool-"));
        }
    }
}

#[test]
fn command_run_refuses_unknown_mcp_and_missing_consent_before_probing_or_writing() {
    let temp = TempDir::new();
    let state = ExternalToolsState::default();
    let mut req = request(ToolId::Claude, "converse_1");
    assert_eq!(
        run_start_impl(&temp.0, &state, req.clone(), &ParentEnv::new())
            .unwrap_err()
            .code,
        RunErrorCode::InvalidArgs
    );
    req.mcp_session_id.clear();
    assert!(req.validate().is_ok());
    assert_eq!(
        run_start_impl(&temp.0, &state, req, &ParentEnv::new())
            .unwrap_err()
            .code,
        RunErrorCode::NotConsented
    );
    assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 0);
}

#[test]
fn install_serialization_progress_recovery_cancel_and_reset() {
    let temp = TempDir::new();
    let state = ExternalToolsState::default();
    let reset = state.begin_install(ToolId::Claude).unwrap();
    assert!(state.begin_install(ToolId::Codex).is_err());
    *state.install_snapshot.lock().unwrap() = Some((
        ToolId::Claude,
        Some(ToolInstallProgress {
            phase: ToolInstallPhase::Downloading,
            message: "Downloading".into(),
            bytes_done: Some(12),
            bytes_total: Some(24),
        }),
    ));
    if current_platform().is_some() {
        let status = status_impl(
            &temp.0,
            &state,
            ToolId::Claude,
            false,
            None,
            &ParentEnv::new(),
        )
        .unwrap();
        assert!(matches!(status.state, ToolState::Installing));
        assert_eq!(status.progress.unwrap().bytes_done, Some(12));
        assert_eq!(status.publisher, "Anthropic");
    }
    state.cancel_install.store(true, Ordering::SeqCst);
    drop(reset);
    assert!(!state.installing.load(Ordering::SeqCst));
    assert!(state.install_snapshot.lock().unwrap().is_none());
    let reset = state.begin_install(ToolId::Codex).unwrap();
    assert!(!state.cancel_install.load(Ordering::SeqCst));
    drop(reset);
    state.shutdown();
    assert!(state.begin_install(ToolId::Claude).is_err());
}

#[test]
fn uninstall_only_removes_managed_tree_and_preserves_consent_and_user_binary() {
    let temp = TempDir::new();
    let state = ExternalToolsState::default();
    let user_binary = temp.0.join("user-claude");
    fs::write(&user_binary, b"user install").unwrap();
    fs::create_dir_all(temp.0.join("claude/version")).unwrap();
    fs::write(temp.0.join("claude/version/claude"), b"managed").unwrap();
    consent::ConsentStore::new(&temp.0)
        .set(ToolId::Claude, "plugin.test", true)
        .unwrap();
    uninstall_impl(&temp.0, &state, ToolId::Claude).unwrap();
    assert!(!temp.0.join("claude").exists());
    assert_eq!(fs::read(user_binary).unwrap(), b"user install");
    assert!(consent::ConsentStore::new(&temp.0)
        .get(ToolId::Claude, "plugin.test")
        .unwrap());
    assert_eq!(consent::ConsentStore::new(&temp.0).list().unwrap().len(), 1);
}

#[test]
fn codex_without_mcp_keeps_restrictions_without_a_required_server() {
    let mut input = inputs(None);
    input.mcp_url = "";
    let run = render_run(&ToolId::Codex.spec(), input).unwrap();
    assert!(!run.args.iter().any(|s| s.starts_with("mcp_servers.")));
    for feature in CODEX_FEATURES_DISABLE {
        assert!(run
            .args
            .windows(2)
            .any(|pair| pair == ["--disable", feature]));
    }
}

fn cached_stub(state: &ExternalToolsState, tool: ToolId) {
    state
        .probes
        .get_or_probe(tool, true, || {
            Ok(probe::ProbeResult {
                path: stub().to_owned(),
                version: "2.1.296".into(),
                auth: catalog::AuthStatus {
                    signed_in: true,
                    auth_method: Some("claude.ai".into()),
                    detail: None,
                },
                probed_at: "2026-10-22T00:00:00Z".into(),
            })
        })
        .unwrap();
}

#[test]
fn status_preserves_subscription_login_hint_for_api_key_auth() {
    if current_platform().is_none() {
        return;
    }
    let temp = TempDir::new();
    let state = ExternalToolsState::default();
    state
        .probes
        .get_or_probe(ToolId::Claude, true, || {
            Ok(probe::ProbeResult {
                path: stub().to_owned(),
                version: "2.1.308".into(),
                auth: ToolId::Claude.spec().parse_auth(
                    Some(0),
                    r#"{"loggedIn":true,"authMethod":"api_key_helper"}"#,
                    "",
                ),
                probed_at: "2026-10-22T00:00:00Z".into(),
            })
        })
        .unwrap();
    let status = status_impl(
        &temp.0,
        &state,
        ToolId::Claude,
        false,
        None,
        &ParentEnv::new(),
    )
    .unwrap();
    assert_eq!(status.signed_in, Some(false));
    assert_eq!(status.auth_method.as_deref(), Some("api_key_helper"));
    assert!(status.detail.unwrap().contains("claude auth login"));
}

#[test]
fn command_start_renders_and_stages_host_inputs_and_tracks_session() {
    if current_platform().is_none() {
        return;
    }
    let temp = TempDir::new();
    let state = ExternalToolsState::default();
    cached_stub(&state, ToolId::Claude);
    let mut req = request(ToolId::Claude, "converse_1");
    req.mcp_session_id.clear();
    consent::ConsentStore::new(&temp.0)
        .set(req.tool, &req.plugin_id, true)
        .unwrap();
    let status = status_impl(
        &temp.0,
        &state,
        req.tool,
        false,
        Some(&req.plugin_id),
        &ParentEnv::new(),
    )
    .unwrap();
    assert!(status.consented);
    assert_eq!(status.publisher, "Anthropic");
    let started = run_start_impl(&temp.0, &state, req.clone(), &ParentEnv::new()).unwrap();
    assert!(started.cwd.starts_with(temp.0.join("runs")));
    assert_eq!(
        fs::read_to_string(started.cwd.join("system-prompt.md")).unwrap(),
        req.system_prompt
    );
    assert_eq!(
        fs::read_to_string(started.cwd.join("claude-mcp.json")).unwrap(),
        r#"{"mcpServers":{}}"#
    );
    let run = state.run_by_id(&started.run_id).unwrap();
    assert!(run.wait_finished(Duration::from_secs(5)));
    assert_eq!(
        state.inner.lock().unwrap().runs[&started.run_id].mcp_session_id,
        ""
    );
    conversation_clear_impl(
        &temp.0,
        &state,
        ToolId::Claude,
        &req.plugin_id,
        &req.conversation_id,
        &ParentEnv::new(),
    )
    .unwrap();
    assert!(!started.cwd.exists());
    assert!(state.inner.lock().unwrap().conversations.is_empty());
}

#[test]
fn command_busy_refuses_to_overwrite_live_inputs_and_uninstall_stops_run() {
    if current_platform().is_none() {
        return;
    }
    let temp = TempDir::new();
    let state = ExternalToolsState::default();
    cached_stub(&state, ToolId::Claude);
    let mut req = request(ToolId::Claude, "converse_1");
    req.mcp_session_id.clear();
    consent::ConsentStore::new(&temp.0)
        .set(req.tool, &req.plugin_id, true)
        .unwrap();
    let started = state
        .start(
            &temp.0,
            &req,
            rendered(&["sleep"], None),
            &ParentEnv::new(),
            false,
        )
        .unwrap();
    fs::write(started.cwd.join("system-prompt.md"), "original").unwrap();
    assert_eq!(
        run_start_impl(&temp.0, &state, req, &ParentEnv::new())
            .unwrap_err()
            .code,
        RunErrorCode::Busy
    );
    assert_eq!(
        fs::read_to_string(started.cwd.join("system-prompt.md")).unwrap(),
        "original"
    );
    uninstall_impl(&temp.0, &state, ToolId::Claude).unwrap();
    assert!(!state
        .run_by_id(&started.run_id)
        .unwrap()
        .status()
        .is_running());
    state.shutdown();
}
#[test]
fn busy_directory_reuse_ownership_and_shutdown() {
    let temp = TempDir::new();
    let state = ExternalToolsState::default();
    let req = request(ToolId::Claude, "conversation_1");
    let first = state
        .start(
            &temp.0,
            &req,
            rendered(&["sleep"], None),
            &ParentEnv::new(),
            false,
        )
        .unwrap();
    let error = state
        .start(
            &temp.0,
            &req,
            rendered(&["sleep"], None),
            &ParentEnv::new(),
            false,
        )
        .unwrap_err();
    assert_eq!(error.code, RunErrorCode::Busy);
    assert_eq!(
        state.owned_run(&first.run_id, "other").err().unwrap().code,
        RunErrorCode::NotOwner
    );
    let run = state.owned_run(&first.run_id, &req.plugin_id).unwrap();
    run.cancel(KillReason::Cancelled);
    assert!(run.wait_finished(Duration::from_secs(5)));
    fs::write(first.cwd.join("persistent"), "resume state").unwrap();
    let second = state
        .start(
            &temp.0,
            &req,
            rendered(&["sleep"], None),
            &ParentEnv::new(),
            false,
        )
        .unwrap();
    assert_eq!(first.cwd, second.cwd);
    assert!(second.cwd.join("persistent").exists());
    let codex = state
        .start(
            &temp.0,
            &request(ToolId::Codex, "conversation_2"),
            rendered(&["sleep"], None),
            &ParentEnv::new(),
            false,
        )
        .unwrap();
    let second_run = state.owned_run(&second.run_id, &req.plugin_id).unwrap();
    let codex_run = state.owned_run(&codex.run_id, &req.plugin_id).unwrap();
    state.shutdown();
    assert_eq!(
        second_run.status(),
        RunStatus::Killed {
            reason: KillReason::AppExit
        }
    );
    assert_eq!(
        codex_run.status(),
        RunStatus::Killed {
            reason: KillReason::AppExit
        }
    );
    assert!(!second.cwd.exists());
}
#[test]
fn conversation_paths_validate_and_are_private() {
    let temp = TempDir::new();
    let path = conversation_dir(&temp.0, "org.chemdraft.test", "conversation_1").unwrap();
    assert_eq!(
        conversation_dir(&temp.0, "org.chemdraft.test", "conversation_1").unwrap(),
        path
    );
    for plugin in ["..", "../escape", "a/b", "a\\b"] {
        assert!(conversation_dir(&temp.0, plugin, "conversation_1").is_err());
    }
    assert!(conversation_dir(&temp.0, "org.chemdraft.test", "../escape").is_err());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    remove_stale_runs(&temp.0).unwrap();
    assert!(!path.exists());
    remove_stale_runs(&temp.0).unwrap();
}
#[test]
fn terminal_scripts_and_windows_command_are_injectable() {
    let temp = TempDir::new();
    let mut spec = ToolId::Claude.spec();
    spec.program = PathBuf::from("/Tools/a'b/claude");
    terminal::launch_sign_in(
        ProbePlatform::MacOS,
        &spec,
        &temp.0,
        &ParentEnv::new(),
        false,
        |command| {
            assert_eq!(command.program, PathBuf::from("/usr/bin/open"));
            assert!(!command.new_console);
            let path = Path::new(&command.args[0]);
            let script = fs::read_to_string(path).unwrap();
            assert!(script.starts_with("#!/bin/sh\nexec /usr/bin/env -i "));
            assert!(script.ends_with(" '/Tools/a'\\''b/claude' 'auth' 'login'\n"));
            assert!(script.contains("'DISABLE_AUTOUPDATER=1'"));
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    fs::metadata(path).unwrap().permissions().mode() & 0o777,
                    0o700
                );
            }
            Ok(())
        },
    )
    .unwrap();
    spec.program = PathBuf::from(r"C:\Tools\Claude Code\claude.exe");
    assert_eq!(
        terminal::windows_login_line(&spec).unwrap(),
        r#"title ChemDraft sign-in && "C:\Tools\Claude Code\claude.exe" auth login"#
    );
    terminal::launch_sign_in(
        ProbePlatform::Windows,
        &spec,
        &temp.0,
        &map(&[("ComSpec", r"C:\Windows\System32\cmd.exe")]),
        false,
        |command| {
            assert_eq!(command.args[..2], ["/D", "/K"]);
            assert!(command.new_console);
            Ok(())
        },
    )
    .unwrap();
    for path in [
        "bad\"path",
        "bad&path",
        "bad|path",
        "bad%PATH%",
        "bad\npath",
        "codex.cmd",
        "claude.BAT",
    ] {
        spec.program = PathBuf::from(path);
        assert!(terminal::windows_login_line(&spec).is_err());
    }
}
#[test]
fn consent_round_trip_revocation_and_plugin_clear() {
    let temp = TempDir::new();
    let store = consent::ConsentStore::new(&temp.0);
    assert!(!store.get(ToolId::Claude, "org.test").unwrap());
    store.set(ToolId::Claude, "org.test", true).unwrap();
    store.set(ToolId::Codex, "org.test", true).unwrap();
    store.set(ToolId::Codex, "org.other", true).unwrap();
    assert!(consent::ConsentStore::new(&temp.0)
        .get(ToolId::Claude, "org.test")
        .unwrap());
    store.revoke(ToolId::Claude, "org.test").unwrap();
    assert!(!store.get(ToolId::Claude, "org.test").unwrap());
    store.clear_for_plugin("org.test").unwrap();
    assert!(!store.get(ToolId::Codex, "org.test").unwrap());
    assert!(store.get(ToolId::Codex, "org.other").unwrap());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(temp.0.join("consents.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    let entries: Vec<consent::Consent> =
        serde_json::from_slice(&fs::read(temp.0.join("consents.json")).unwrap()).unwrap();
    assert_eq!(entries.len(), 1);
}

#[test]
fn consent_transactions_serialize_across_store_instances() {
    let temp = TempDir::new();
    let barrier = Arc::new(std::sync::Barrier::new(16));
    let threads: Vec<_> = (0..16)
        .map(|i| {
            let store = consent::ConsentStore::new(&temp.0);
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                store
                    .set(ToolId::Claude, &format!("org.test.plugin{i}"), true)
                    .unwrap();
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    assert_eq!(
        consent::ConsentStore::new(&temp.0).list().unwrap().len(),
        16
    );
    let state = ExternalToolsState::default();
    consent_clear_plugin_impl(&temp.0, &state, "org.test.plugin0").unwrap();
    let store = consent::ConsentStore::new(&temp.0);
    assert_eq!(store.list().unwrap().len(), 15);
    assert!(!store.get(ToolId::Claude, "org.test.plugin0").unwrap());
    assert!(store.get(ToolId::Claude, "org.test.plugin1").unwrap());
}

#[test]
fn clearing_plugin_consent_cancels_only_that_plugins_runs() {
    let temp = TempDir::new();
    let state = ExternalToolsState::default();
    let first = request(ToolId::Claude, "conversation_1");
    let mut other = request(ToolId::Codex, "conversation_2");
    other.plugin_id = "org.test.other".into();
    for req in [&first, &other] {
        consent::ConsentStore::new(&temp.0)
            .set(req.tool, &req.plugin_id, true)
            .unwrap();
    }
    let first_run = state
        .start(
            &temp.0,
            &first,
            rendered(&["sleep"], None),
            &ParentEnv::new(),
            false,
        )
        .unwrap();
    let other_run = state
        .start(
            &temp.0,
            &other,
            rendered(&["sleep"], None),
            &ParentEnv::new(),
            false,
        )
        .unwrap();
    consent_clear_plugin_impl(&temp.0, &state, &first.plugin_id).unwrap();
    let run = state.run_by_id(&first_run.run_id).unwrap();
    assert!(run.wait_finished(Duration::from_secs(5)));
    assert_eq!(
        run.status(),
        RunStatus::Killed {
            reason: KillReason::PluginUnregistered
        }
    );
    assert!(state
        .run_by_id(&other_run.run_id)
        .unwrap()
        .status()
        .is_running());
    let store = consent::ConsentStore::new(&temp.0);
    assert!(!store.get(first.tool, &first.plugin_id).unwrap());
    assert!(store.get(other.tool, &other.plugin_id).unwrap());
    state.shutdown();
}

#[test]
fn status_sizes_use_each_platform_pin_and_the_install_volume() {
    let temp = TempDir::new();
    for pin in &pins::PINS {
        let status = install::managed_status(&temp.0.join("not-created-yet"), pin);
        assert_eq!(status.pinned_download_bytes, pin.size);
        assert!(status.free_disk_bytes.is_some());
    }
}

#[test]
fn run_request_accepts_absent_or_empty_mcp_session() {
    let mut value = serde_json::to_value(request(ToolId::Claude, "conversation_1")).unwrap();
    value.as_object_mut().unwrap().remove("mcpSessionId");
    let absent: ExternalToolRunRequest = serde_json::from_value(value.clone()).unwrap();
    absent.validate().unwrap();
    bind_mcp_session(&absent).unwrap();
    value["mcpSessionId"] = serde_json::json!("");
    bind_mcp_session(&serde_json::from_value(value.clone()).unwrap()).unwrap();
    value["mcpSessionId"] = serde_json::json!("session_123");
    assert_eq!(
        bind_mcp_session(&serde_json::from_value(value).unwrap())
            .err()
            .unwrap()
            .code,
        RunErrorCode::InvalidArgs
    );
}
#[test]
fn probe_execution_uses_version_and_auth_contracts() {
    let temp = TempDir::new();
    let result = probe::probe_tool(
        &ToolId::Claude.spec(),
        stub(),
        &ParentEnv::new(),
        &temp.0,
        false,
    )
    .unwrap();
    assert_eq!(result.version, "2.1.296");
    assert!(result.auth.signed_in);
    let mut codex = ToolId::Codex.spec();
    codex.version_args = &["codex-version"];
    let result = probe::probe_tool(&codex, stub(), &ParentEnv::new(), &temp.0, false).unwrap();
    assert_eq!(result.version, "0.163.0");
    assert!(
        result.auth.signed_in,
        "Codex auth must read captured stderr"
    );
}

#[test]
fn probe_timeout_output_cap_and_login_shell_capture() {
    let temp = TempDir::new();
    let start = Instant::now();
    let error = probe::execute(
        stub(),
        &["sleep"],
        &ParentEnv::new(),
        &temp.0,
        false,
        Duration::from_millis(50),
        64 * 1024,
    )
    .err()
    .unwrap();
    assert!(error.contains("timed out"));
    assert!(start.elapsed() < Duration::from_secs(4));
    let error = probe::execute(
        stub(),
        &["flood"],
        &ParentEnv::new(),
        &temp.0,
        false,
        Duration::from_secs(5),
        64 * 1024,
    )
    .err()
    .unwrap();
    assert!(error.contains("output limit"));
    #[cfg(unix)]
    {
        let path = probe::LoginShellPath::default()
            .capture(Path::new("/bin/sh"), &ParentEnv::new(), &temp.0)
            .unwrap();
        assert!(!path.is_empty());
        assert!(path.contains("/usr/bin"));
    }
}

#[test]
fn request_validation_and_serialization_match_the_wire_contract() {
    let req = request(ToolId::Claude, "conversation_1");
    assert!(req.validate().is_ok());
    let mut value = serde_json::to_value(&req).unwrap();
    value["argv"] = serde_json::json!(["--dangerously-skip-permissions"]);
    assert!(serde_json::from_value::<ExternalToolRunRequest>(value).is_err());
    for bad in ["short", "../escape", "a/b_long"] {
        let mut req = req.clone();
        req.conversation_id = bad.into();
        assert!(req.validate().is_err());
    }
    let mut oversized = req.clone();
    oversized.prompt = "x".repeat(32 * 1024 + 1);
    assert!(oversized.validate().is_err());
    let mut oversized = req.clone();
    oversized.system_prompt = "x".repeat(64 * 1024 + 1);
    assert!(oversized.validate().is_err());
    for timeout in [0, 999, 1_800_001] {
        let mut req = req.clone();
        req.timeout_ms = Some(timeout);
        assert!(req.validate().is_err());
    }
    let wire = serde_json::to_value(RunStatus::Exited {
        code: Some(0),
        signal: None,
        duration_ms: 21,
    })
    .unwrap();
    assert_eq!(wire["state"], "exited");
    assert_eq!(wire["durationMs"], 21);
    assert_eq!(
        serde_json::to_value(RunStatus::Killed {
            reason: KillReason::PluginUnregistered
        })
        .unwrap(),
        serde_json::json!({"state":"killed","reason":"pluginUnregistered"})
    );
}

#[test]
fn long_poll_caps_wait_and_shims_are_rejected_at_spawn() {
    let temp = TempDir::new();
    let run = spawn(&["sleep"], None, &temp.0, Duration::from_secs(10));
    let start = Instant::now();
    let poll = run.poll(0, 5001, 10_000);
    assert!(poll.lines.is_empty());
    assert!(start.elapsed() >= Duration::from_millis(900));
    assert!(start.elapsed() < Duration::from_millis(1800));
    run.cancel(KillReason::Cancelled);
    assert!(run.wait_finished(Duration::from_secs(5)));
    let mut batch = rendered(&[], None);
    batch.program = PathBuf::from("codex.CMD");
    assert!(
        ToolRun::spawn(batch, &temp.0, &ParentEnv::new(), Duration::from_secs(1))
            .err()
            .unwrap()
            .contains("Batch shims")
    );
}

#[test]
fn only_a_bound_rust_token_may_enter_the_child_environment() {
    let inherited = map(&[
        ("CHEMDRAFT_MCP_TOKEN", "stolen"),
        ("chemdraft_mcp_token", "also-stolen"),
        ("CHEMDRAFT_AGENT_BRIDGE", "1"),
        ("chemdraft_other", "forbidden"),
        ("HOME", "home"),
    ]);
    for platform in [ProbePlatform::MacOS, ProbePlatform::Windows] {
        let child = env::child_env(
            platform,
            &inherited,
            Path::new("binary"),
            Path::new("run"),
            false,
        );
        for token in [None, Some("rust-only")] {
            let child = env::with_mcp_token(child.clone(), token);
            assert_eq!(child.get("CHEMDRAFT_MCP_TOKEN").map(String::as_str), token);
            assert_eq!(
                child
                    .keys()
                    .filter(|k| k.to_ascii_uppercase().starts_with("CHEMDRAFT_"))
                    .count(),
                usize::from(token.is_some())
            );
        }
    }
    // Even accidental inherited variants are scrubbed before the explicit token is inserted.
    let bound = env::with_mcp_token(inherited, Some("rust-only"));
    assert_eq!(bound["CHEMDRAFT_MCP_TOKEN"], "rust-only");
    assert!(!bound.contains_key("chemdraft_mcp_token"));
    assert!(!bound.contains_key("CHEMDRAFT_AGENT_BRIDGE"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_mcp_run_binding_ownership_credentials_and_cleanup() {
    if current_platform().is_none() {
        return;
    }
    use crate::assistant_mcp::{McpBridgeRequest, McpBridgeResponse};
    let manager = session::manager();
    let (sender, receiver) = std::sync::mpsc::channel::<McpBridgeRequest>();
    let plugin = "org.chemdraft.test";
    let opened = manager
        .open(plugin.into(), "Test".into(), Arc::new(sender))
        .unwrap();
    let session_id = opened.session_id;
    let (url, token) = session::session_credentials(&session_id).unwrap();
    let answer_session = session_id.clone();
    let responder = thread::spawn(move || {
        while let Ok(request) = receiver.recv() {
            if request.method == "cancel" {
                continue;
            }
            assert_eq!(request.method, "tools/list");
            // A cancelled child may disconnect before the bridge answer arrives.
            let _ = session::manager().respond(
                &answer_session,
                &request.request_id,
                McpBridgeResponse::Result {
                    result: serde_json::json!({"tools":[]}),
                },
            );
        }
    });
    let temp = TempDir::new();
    let state = ExternalToolsState::default();
    for tool in [ToolId::Claude, ToolId::Codex] {
        cached_stub(&state, tool);
        consent::ConsentStore::new(&temp.0)
            .set(tool, plugin, true)
            .unwrap();
    }
    let mut req = request(ToolId::Claude, "mcp_conversation");
    req.mcp_session_id = session_id.clone();
    req.system_prompt = "mcp-live".into();

    // Reject cross-plugin use before any probing, consent lookup, or file writes.
    let mut foreign = req.clone();
    foreign.plugin_id = "org.chemdraft.other".into();
    assert_eq!(
        run_start_impl(&temp.0, &state, foreign, &ParentEnv::new())
            .unwrap_err()
            .code,
        RunErrorCode::NotOwner
    );
    assert!(!temp.0.join("runs").exists());

    // Both first and follow-up CLI processes must be able to initialize the same session.
    for tool in [ToolId::Claude, ToolId::Codex, ToolId::Claude] {
        req.tool = tool;
        let started = run_start_impl(
            &temp.0,
            &state,
            req.clone(),
            &map(&[("CHEMDRAFT_MCP_TOKEN", "untrusted")]),
        )
        .unwrap();
        let config_path = started.cwd.join("claude-mcp.json");
        if tool == ToolId::Claude {
            let config: serde_json::Value =
                serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
            assert_eq!(
                config,
                serde_json::json!({"mcpServers":{"chemdraft":{
                    "type":"http", "url":url, "headers":{"Authorization":format!("Bearer {token}")}
                }}})
            );
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    fs::metadata(&config_path).unwrap().permissions().mode() & 0o777,
                    0o600
                );
            }
        }
        // Assert the actual catalog inputs produce no bearer token in argv.
        let mut input = inputs(None);
        input.mcp_url = &url;
        input.mcp_config_file = &config_path;
        let rendered = render_run(&tool.spec(), input).unwrap();
        assert!(rendered.args.iter().all(|a| !a.contains(&token)));
        let run = state.run_by_id(&started.run_id).unwrap();
        assert!(run.wait_finished(Duration::from_secs(10)));
        let poll = run.poll(0, 5000, 0);
        assert!(
            matches!(poll.status, RunStatus::Exited { code: Some(0), .. }),
            "{poll:?}"
        );
        assert!(
            poll.lines.iter().any(|l| l.text == "mcp-live-ok"),
            "{poll:?}"
        );
        assert!(poll.lines.iter().all(|l| !l.text.contains(&token)));
        assert_eq!(
            state.inner.lock().unwrap().runs[&started.run_id].mcp_session_id,
            session_id
        );
        // Completion releases the reservation and preserves the session.
        drop(session::bind_session(&session_id, plugin, "after-exit").unwrap());
        assert!(session::session_credentials(&session_id).is_some());
    }
    let cwd = conversation_dir(&temp.0, plugin, &req.conversation_id).unwrap();
    conversation_clear_impl(
        &temp.0,
        &state,
        req.tool,
        plugin,
        &req.conversation_id,
        &ParentEnv::new(),
    )
    .unwrap();
    assert!(!cwd.exists());
    assert!(!cwd.join("claude-mcp.json").exists());
    assert!(session::session_credentials(&session_id).is_some());

    req.tool = ToolId::Claude;
    req.system_prompt = "mcp-live-wait".into();
    // Cancel, timeout, and shutdown all release the supervisor's binding.
    for mode in ["cancel", "timeout", "shutdown"] {
        req.timeout_ms = Some(if mode == "timeout" { 1000 } else { 10_000 });
        let started = run_start_impl(&temp.0, &state, req.clone(), &ParentEnv::new()).unwrap();
        let run = state.run_by_id(&started.run_id).unwrap();
        // Bind is already reserved before the child makes any MCP request.
        let mut second = req.clone();
        second.tool = ToolId::Codex;
        second.conversation_id = "mcp_second".into();
        assert_eq!(
            run_start_impl(&temp.0, &state, second, &ParentEnv::new())
                .unwrap_err()
                .code,
            RunErrorCode::Busy
        );
        match mode {
            "cancel" => run.cancel(KillReason::Cancelled),
            "shutdown" => state.shutdown(),
            _ => {}
        }
        assert!(run.wait_finished(Duration::from_secs(10)));
        let expected = match mode {
            "cancel" => KillReason::Cancelled,
            "shutdown" => KillReason::AppExit,
            _ => KillReason::Timeout,
        };
        assert_eq!(run.status(), RunStatus::Killed { reason: expected });
        drop(session::bind_session(&session_id, plugin, "after-kill").unwrap());
        if mode == "shutdown" {
            assert!(!started.cwd.exists());
            assert!(!started.cwd.join("claude-mcp.json").exists());
        }
    }
    failed_run_preparation_and_spawn_release_mcp_binding();
    manager.close(&session_id);
    responder.join().unwrap();
}

fn failed_run_preparation_and_spawn_release_mcp_binding() {
    let manager = session::manager();
    let (sender, _receiver) = std::sync::mpsc::channel::<crate::assistant_mcp::McpBridgeRequest>();
    let mut req = request(ToolId::Claude, "mcp_fail_conversation");
    // Keep the failure cases separate from the live conversation's per-plugin state.
    req.plugin_id = "org.chemdraft.failure".into();
    let opened = manager
        .open(req.plugin_id.clone(), "Test".into(), Arc::new(sender))
        .unwrap();
    req.mcp_session_id = opened.session_id;
    let temp = TempDir::new();
    let state = ExternalToolsState::default();
    cached_stub(&state, req.tool);
    consent::ConsentStore::new(&temp.0)
        .set(req.tool, &req.plugin_id, true)
        .unwrap();
    let cwd = conversation_dir(&temp.0, &req.plugin_id, &req.conversation_id).unwrap();
    fs::create_dir(cwd.join("claude-mcp.json")).unwrap();
    assert_eq!(
        run_start_impl(&temp.0, &state, req.clone(), &ParentEnv::new())
            .unwrap_err()
            .code,
        RunErrorCode::SpawnFailed
    );
    drop(
        session::bind_session(&req.mcp_session_id, &req.plugin_id, "after-prepare-failed").unwrap(),
    );

    let binding = bind_mcp_session(&req).unwrap();
    let mut command = rendered(&[], None);
    command.program = temp.0.join("missing-binary");
    assert_eq!(
        state
            .start_bound(&temp.0, &req, command, &ParentEnv::new(), false, binding)
            .unwrap_err()
            .code,
        RunErrorCode::SpawnFailed
    );
    drop(session::bind_session(&req.mcp_session_id, &req.plugin_id, "after-spawn-failed").unwrap());
    manager.close(&req.mcp_session_id);
}
