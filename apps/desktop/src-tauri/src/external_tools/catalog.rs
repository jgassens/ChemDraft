//! Fixed, host-owned CLI contracts. No plugin-supplied command line is accepted.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolId {
    Claude,
    Codex,
}

#[derive(Debug, Clone)]
pub struct ToolSpec {
    pub tool: ToolId,
    pub display_name: &'static str,
    pub publisher: &'static str,
    pub binary_macos: &'static str,
    pub binary_windows: &'static str,
    pub version_args: &'static [&'static str],
    pub auth_status_args: &'static [&'static str],
    pub login_args: &'static [&'static str],
    pub minimum_version: &'static str,
    /// Resolved native executable, replaced by the probe result before spawning.
    pub program: PathBuf,
}
impl ToolId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
    pub fn spec(self) -> ToolSpec {
        let (name, publisher, auth, login, minimum) = match self {
            Self::Claude => (
                "Claude Code",
                "Anthropic",
                &["auth", "status"][..],
                &["auth", "login"][..],
                "2.1.259",
            ),
            Self::Codex => (
                "Codex",
                "OpenAI",
                &["login", "status"][..],
                &["login"][..],
                "0.162.1",
            ),
        };
        let windows = match self {
            Self::Claude => "claude.exe",
            Self::Codex => "codex.exe",
        };
        ToolSpec {
            tool: self,
            display_name: name,
            publisher,
            binary_macos: self.as_str(),
            binary_windows: windows,
            version_args: &["--version"],
            auth_status_args: auth,
            login_args: login,
            minimum_version: minimum,
            program: PathBuf::from(if cfg!(windows) {
                windows
            } else {
                self.as_str()
            }),
        }
    }
}
impl ToolSpec {
    pub fn parse_version(&self, line: &str) -> Option<String> {
        let line = line.trim();
        let value = match self.tool {
            ToolId::Claude => line.split_whitespace().next()?,
            ToolId::Codex => line.strip_prefix("codex-cli ")?.split_whitespace().next()?,
        };
        version_tuple(value).map(|_| value.to_owned())
    }
    pub fn supports_version(&self, version: &str) -> bool {
        match (version_tuple(version), version_tuple(self.minimum_version)) {
            (Some(v), Some(min)) => v >= min,
            _ => false,
        }
    }
    pub fn parse_auth(&self, code: Option<i32>, stdout: &str) -> AuthStatus {
        match self.tool {
            ToolId::Claude => {
                let json: serde_json::Value =
                    serde_json::from_str(stdout).unwrap_or(serde_json::Value::Null);
                AuthStatus {
                    signed_in: code == Some(0)
                        && json.get("loggedIn").and_then(|v| v.as_bool()) == Some(true),
                    auth_method: json
                        .get("authMethod")
                        .and_then(|v| v.as_str())
                        .map(str::to_owned),
                }
            }
            ToolId::Codex => AuthStatus {
                signed_in: code == Some(0) && stdout.starts_with("Logged in"),
                auth_method: None,
            },
        }
    }
}
fn version_tuple(value: &str) -> Option<(u64, u64, u64)> {
    let mut parts = value.split('.');
    let result = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    if parts.next().is_some() {
        None
    } else {
        Some(result)
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub signed_in: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_method: Option<String>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    Low,
    Medium,
    High,
}
impl Effort {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }
}

pub struct ToolRunInputs<'a> {
    pub run_dir: &'a Path,
    /// UTF-8 contents of the staged prompt file, loaded by the caller. Rendering performs no IO.
    pub prompt_file: &'a str,
    pub system_prompt_file: &'a Path,
    pub mcp_config_file: &'a Path,
    pub mcp_url: &'a str,
    pub resume_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub effort: Option<Effort>,
    pub managed_copy: bool,
}
#[derive(Debug, Clone)]
pub struct RenderedRun {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Host-owned additions only; the complete allowlisted environment comes from env.rs.
    pub env: Vec<(String, String)>,
    pub stdin: Option<String>,
}

pub fn render_run(spec: &ToolSpec, input: ToolRunInputs<'_>) -> Result<RenderedRun, String> {
    if input
        .resume_id
        .is_some_and(|s| !identifier(s, 1, 128) || s.starts_with('-'))
        || input.model.is_some_and(|s| {
            s.is_empty()
                || s.starts_with('-')
                || s.len() > 64
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b".-".contains(&b))
        })
    {
        return Err("Invalid resume id or model.".into());
    }
    let path = |p: &Path| p.to_string_lossy().into_owned();
    let strings = |items: &[&str]| items.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
    let (mut args, stdin) = match spec.tool {
        ToolId::Claude => {
            let mut args = strings(&[
                "-p",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--strict-mcp-config",
                "--mcp-config",
            ]);
            args.push(path(input.mcp_config_file));
            args.extend(strings(&[
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
            ]));
            args.push(path(input.system_prompt_file));
            args.extend(strings(&["--settings", r#"{"disableAllHooks":true}"#]));
            if let Some(id) = input.resume_id {
                args.extend(strings(&["--resume", id]));
            }
            if let Some(model) = input.model {
                args.extend(strings(&["--model", model]));
            }
            if let Some(effort) = input.effort {
                args.extend(strings(&["--effort", effort.as_str()]));
            }
            let message = serde_json::json!({"type":"user", "message":{"role":"user", "content":input.prompt_file}});
            (args, format!("{message}\n"))
        }
        ToolId::Codex => {
            let mut args = strings(&["exec"]);
            if let Some(id) = input.resume_id {
                args.extend(strings(&["resume", id]));
            }
            args.push("--json".into());
            if input.resume_id.is_none() {
                args.extend(strings(&["-C", &path(input.run_dir)]));
            }
            args.extend(strings(&[
                "--skip-git-repo-check",
                "--ignore-user-config",
                "--ignore-rules",
            ]));
            if input.resume_id.is_none() {
                args.extend(strings(&["--sandbox", "read-only"]));
            } else {
                args.extend(strings(&["-c", "sandbox_mode=\"read-only\""]));
            }
            for setting in [
                "approval_policy=\"never\"",
                "features.shell_tool=false",
                "features.unified_exec=false",
                "tools.view_image=false",
                "web_search=\"disabled\"",
                "check_for_update_on_startup=false",
                "analytics.enabled=false",
            ] {
                args.extend(strings(&["-c", setting]));
            }
            for (key, value) in [
                ("mcp_servers.chemdraft.url", input.mcp_url),
                (
                    "mcp_servers.chemdraft.bearer_token_env_var",
                    "CHEMDRAFT_MCP_TOKEN",
                ),
            ] {
                args.extend([
                    "-c".into(),
                    format!(
                        "{key}={}",
                        serde_json::to_string(value).expect("string serialization")
                    ),
                ]);
            }
            for setting in [
                "mcp_servers.chemdraft.required=true",
                "mcp_servers.chemdraft.default_tools_approval_mode=\"auto\"",
                "mcp_servers.chemdraft.startup_timeout_sec=30",
                "mcp_servers.chemdraft.tool_timeout_sec=120",
            ] {
                args.extend(strings(&["-c", setting]));
            }
            args.extend([
                "-c".into(),
                format!(
                    "model_instructions_file={}",
                    serde_json::to_string(&path(input.system_prompt_file))
                        .expect("string serialization")
                ),
            ]);
            if let Some(model) = input.model {
                args.extend(strings(&["-m", model]));
            }
            if let Some(effort) = input.effort {
                args.extend([
                    "-c".into(),
                    format!("model_reasoning_effort=\"{}\"", effort.as_str()),
                ]);
            }
            (args, input.prompt_file.to_owned())
        }
    };
    if spec.tool == ToolId::Codex {
        args.push("-".into());
    }
    for arg in &args {
        if [
            "--dangerously-skip-permissions",
            "--allow-dangerously-skip-permissions",
            "bypassPermissions",
            "--dangerously-bypass-approvals-and-sandbox",
            "danger-full-access",
        ]
        .iter()
        .any(|flag| arg.contains(flag))
        {
            return Err("Unsafe external tool argument refused.".into());
        }
    }
    let mut env = super::env::tool_overrides(input.managed_copy);
    if spec.tool == ToolId::Claude {
        env.push(("MCP_TIMEOUT".into(), "10000".into()));
    }
    Ok(RenderedRun {
        program: spec.program.clone(),
        args,
        env,
        stdin: Some(stdin),
    })
}
pub(crate) fn identifier(s: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
