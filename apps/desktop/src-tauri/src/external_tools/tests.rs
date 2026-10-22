use super::*;
use catalog::{render_run, ToolRunInputs};
use env::ParentEnv;
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
    let auth = claude.parse_auth(Some(0), r#"{"loggedIn":true,"authMethod":"claude.ai"}"#);
    assert!(auth.signed_in);
    assert_eq!(auth.auth_method.as_deref(), Some("claude.ai"));
    for (code, json) in [
        (Some(1), r#"{"loggedIn":true}"#),
        (Some(0), r#"{"loggedIn":false}"#),
        (Some(0), r#"{"loggedIn":"true"}"#),
        (Some(0), "garbage"),
    ] {
        assert!(!claude.parse_auth(code, json).signed_in);
    }
    assert!(
        codex
            .parse_auth(Some(0), "Logged in using ChatGPT")
            .signed_in
    );
    assert!(!codex.parse_auth(Some(1), "Logged in").signed_in);
    assert!(!codex.parse_auth(Some(0), "noise Logged in").signed_in);
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
                    "",
                    "--allowedTools",
                    "mcp__chemdraft__*",
                    "--permission-mode",
                    "dontAsk",
                    "--permission-prompts",
                    "none",
                    "--max-turns",
                    "40",
                    "--system-prompt-file",
                    "/runs/conversation/system-prompt.md",
                    "--settings",
                    r#"{"disableAllHooks":true}"#,
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
                assert!(run.args.contains(&"features.shell_tool=false".into()));
                assert!(run.args.contains(&"features.unified_exec=false".into()));
                assert!(run.args.contains(&"approval_policy=\"never\"".into()));
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

fn stub() -> &'static Path {
    static STUB: OnceLock<PathBuf> = OnceLock::new();
    STUB.get_or_init(||{
        let root=std::env::temp_dir().join(format!("chemdraft-tool-stub-{}",nonce()));fs::create_dir_all(&root).unwrap();
        let source=root.join("stub.rs");let binary=root.join(if cfg!(windows) {"stub.exe"}else {"stub"});
        fs::write(&source,r#"
use std::{env,fs,io::{self,Read,Write},process::{Command,Stdio},thread,time::Duration};
fn main() {
 let args:Vec<_>=env::args().collect();
 match args.get(1).map(String::as_str).unwrap_or("") {
  "--version"=>{println!("2.1.296 (Claude Code)");},
  "auth"=>{println!("{{\"loggedIn\":true,\"authMethod\":\"claude.ai\"}}");},
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
    assert_eq!(commands.len(), 11);
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
fn command_run_refuses_mcp_and_missing_consent_before_probing_or_writing() {
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
    assert!(run.args.contains(&"features.shell_tool=false".into()));
    assert!(run.args.contains(&"features.unified_exec=false".into()));
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
                },
                probed_at: "2026-10-22T00:00:00Z".into(),
            })
        })
        .unwrap();
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
