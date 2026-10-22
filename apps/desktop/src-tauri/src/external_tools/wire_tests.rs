//! These serde values are also consumed by plugin-api's Zod parity test.
use super::*;
use run::{ExternalToolRunPoll, OutputLine, OutputStream, RunStatus};
use serde_json::{to_value, Value};
use std::collections::BTreeMap;

#[test]
fn wire_fixtures_are_current() {
    let mut fixtures = BTreeMap::<String, Value>::new();
    let at = "2026-10-22T12:00:00Z";
    let mut status = ExternalToolStatus {
        tool: ToolId::Claude,
        publisher: "Anthropic".into(),
        state: ToolState::Missing,
        source: None,
        path: None,
        version: None,
        pinned_version: pins::CLAUDE_VERSION.into(),
        pinned_download_bytes: 274675680,
        free_disk_bytes: Some(4_000_000_000),
        managed: None,
        signed_in: None,
        auth_method: None,
        detail: None,
        progress: None,
        can_install: true,
        consented: false,
        probed_at: at.into(),
    };
    fixtures.insert("status-missing".into(), to_value(&status).unwrap());
    status.state = ToolState::Broken;
    status.detail = Some("The managed tool executable is missing.".into());
    fixtures.insert("status-broken".into(), to_value(&status).unwrap());
    status.state = ToolState::Unsupported;
    status.can_install = false;
    status.pinned_download_bytes = 0;
    status.free_disk_bytes = None;
    fixtures.insert("status-unsupported".into(), to_value(&status).unwrap());
    status.state = ToolState::Installing;
    status.can_install = true;
    status.pinned_download_bytes = 274675680;
    status.free_disk_bytes = Some(4_000_000_000);
    status.detail = None;
    fixtures.insert("status-installing".into(), to_value(&status).unwrap());
    for (name, phase) in [
        ("checking-disk", ToolInstallPhase::CheckingDisk),
        ("downloading", ToolInstallPhase::Downloading),
        ("verifying", ToolInstallPhase::Verifying),
        ("installing", ToolInstallPhase::Installing),
        ("done", ToolInstallPhase::Done),
    ] {
        status.progress = Some(ToolInstallProgress {
            phase,
            message: "Installing the tool.".into(),
            bytes_done: if phase == ToolInstallPhase::Downloading {
                Some(1024)
            } else {
                None
            },
            bytes_total: if phase == ToolInstallPhase::Downloading {
                Some(274675680)
            } else {
                None
            },
        });
        fixtures.insert(
            format!("status-installing-{name}"),
            to_value(&status).unwrap(),
        );
    }
    status.state = ToolState::Installed;
    status.tool = ToolId::Codex;
    status.publisher = "OpenAI".into();
    status.pinned_version = pins::CODEX_VERSION.into();
    status.pinned_download_bytes = 167080091;
    status.free_disk_bytes = Some(8_000_000_000);
    status.can_install = true;
    status.consented = true;
    status.progress = None;
    status.detail = None;
    status.source = Some(ToolSource::Managed);
    // Deliberately use portable literal paths so these fixtures are identical on both hosts.
    status.path = Some(PathBuf::from(r"C:\ChemDraft\external-tools\codex.exe"));
    status.version = Some(pins::CODEX_VERSION.into());
    status.managed = Some(ManagedTool {
        version: pins::CODEX_VERSION.into(),
        path: status.path.clone().unwrap(),
    });
    status.signed_in = Some(true);
    status.auth_method = Some("subscription".into());
    fixtures.insert(
        "status-installed-managed".into(),
        to_value(&status).unwrap(),
    );
    status.source = Some(ToolSource::User);
    status.path = Some(PathBuf::from("/usr/local/bin/codex"));
    status.signed_in = Some(false);
    fixtures.insert("status-installed-user".into(), to_value(&status).unwrap());

    let statuses = [
        ("running", RunStatus::Running),
        (
            "exited",
            RunStatus::Exited {
                code: Some(0),
                signal: None,
                duration_ms: 123,
            },
        ),
        (
            "exited-signal",
            RunStatus::Exited {
                code: None,
                signal: Some(2),
                duration_ms: 456,
            },
        ),
        (
            "cancelled",
            RunStatus::Killed {
                reason: KillReason::Cancelled,
            },
        ),
        (
            "timeout",
            RunStatus::Killed {
                reason: KillReason::Timeout,
            },
        ),
        (
            "app-exit",
            RunStatus::Killed {
                reason: KillReason::AppExit,
            },
        ),
        (
            "plugin-unregistered",
            RunStatus::Killed {
                reason: KillReason::PluginUnregistered,
            },
        ),
        (
            "failed",
            RunStatus::Failed {
                message: "Could not wait for external tool.".into(),
            },
        ),
    ];
    for (name, status) in statuses {
        fixtures.insert(
            format!("poll-{name}"),
            to_value(ExternalToolRunPoll {
                lines: vec![
                    OutputLine {
                        stream: OutputStream::Stdout,
                        seq: 2,
                        text: "{\"type\":\"message\",\"text\":\"水\"}".into(),
                        truncated: false,
                    },
                    OutputLine {
                        stream: OutputStream::Stderr,
                        seq: 3,
                        text: "truncated warning".into(),
                        truncated: true,
                    },
                ],
                next_cursor: 4,
                dropped_lines: 2,
                status,
            })
            .unwrap(),
        );
    }
    fixtures.insert(
        "poll-empty".into(),
        to_value(ExternalToolRunPoll {
            lines: vec![],
            next_cursor: 0,
            dropped_lines: 0,
            status: RunStatus::Running,
        })
        .unwrap(),
    );
    fixtures.insert(
        "run-handle".into(),
        to_value(ExternalToolRunStarted {
            run_id: "run-123".into(),
            pid: 1234,
            cwd: PathBuf::from("/ChemDraft/runs/conversation_1"),
            started_at: at.into(),
        })
        .unwrap(),
    );
    for (name, code) in [
        ("not-installed", RunErrorCode::NotInstalled),
        ("not-consented", RunErrorCode::NotConsented),
        ("busy", RunErrorCode::Busy),
        ("invalid-args", RunErrorCode::InvalidArgs),
        ("unknown-run", RunErrorCode::UnknownRun),
        ("not-owner", RunErrorCode::NotOwner),
        ("spawn-failed", RunErrorCode::SpawnFailed),
        ("limit", RunErrorCode::Limit),
    ] {
        fixtures.insert(
            format!("run-error-{name}"),
            to_value(ExternalToolRunError::new(
                code,
                "External tool run refused.",
            ))
            .unwrap(),
        );
    }
    for (name, method, detail) in [
        ("macos", terminal::SignInMethod::TerminalCommand, None),
        (
            "windows",
            terminal::SignInMethod::NewConsole,
            Some("Sign in in the new console.".into()),
        ),
    ] {
        fixtures.insert(
            format!("sign-in-{name}"),
            to_value(terminal::SignInLaunch {
                launched: true,
                method,
                detail,
            })
            .unwrap(),
        );
    }
    fixtures.insert(
        "consent-list-empty".into(),
        to_value(Vec::<consent::Consent>::new()).unwrap(),
    );
    fixtures.insert(
        "consent-list".into(),
        to_value(vec![
            consent::Consent {
                tool: ToolId::Claude,
                plugin_id: "org.chemdraft.assistant".into(),
                granted: true,
                at: at.into(),
            },
            consent::Consent {
                tool: ToolId::Codex,
                plugin_id: "org.chemdraft.assistant".into(),
                granted: false,
                at: at.into(),
            },
        ])
        .unwrap(),
    );

    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/externalTools/__fixtures__/wire");
    let update = std::env::var("CHEMDRAFT_UPDATE_WIRE_FIXTURES").as_deref() == Ok("1");
    if update {
        fs::create_dir_all(&dir).unwrap();
    }
    for (name, value) in &fixtures {
        let path = dir.join(format!("{name}.json"));
        if update {
            fs::write(
                &path,
                format!("{}\n", serde_json::to_string_pretty(value).unwrap()),
            )
            .unwrap();
        } else {
            let bytes = fs::read(&path).unwrap_or_else(|e| {
                panic!(
                    "{}: {e}; regenerate with CHEMDRAFT_UPDATE_WIRE_FIXTURES=1",
                    path.display()
                )
            });
            let actual: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(&actual, value, "Wire fixture {} drifted", path.display());
        }
    }
    let actual: std::collections::BTreeSet<_> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    let expected = fixtures.keys().map(|name| format!("{name}.json")).collect();
    assert_eq!(actual, expected, "Stale or missing wire fixtures");
}
