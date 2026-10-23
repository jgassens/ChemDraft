//! Fixed, host-owned CLI contracts. No plugin-supplied command line is accepted.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Audited default-on features for the pinned Codex CLI. These grant no additional tools or
/// external reach. The pinned-binary parity test requires every default-on feature to be classified.
pub const CODEX_FEATURES_KEEP: &[&str] = &[
    "api_key_model_discovery", // Model catalog discovery; no model-callable capability.
    "auth_elicitation",        // Authentication flow for the explicitly configured MCP server.
    "compaction_image_budget", // Context compaction accounting; does not expose image tools.
    "content_item_kinds",      // Message content representation, not a tool registration.
    "enable_request_compression", // Compresses existing API traffic; adds no destination.
    // Codex's own encrypted local secrets backend for its login, not a model-callable capability;
    // disabling could hide a user's existing Codex login. Default-on only on Windows.
    "secret_auth_storage",
    "system_proxy_fallback", // Transport for existing requests, not model-directed networking.
    "tool_call_mcp_elicitation", // Protocol replies for the explicitly configured MCP server.
    "unbounded_connection_retries", // Retry policy for existing connections, not new reach.
];

/// All other default-on features are denied, including removed compatibility switches (no-ops)
/// and convenience features whose reach is unnecessary or uncertain. Use --disable, not legacy
/// tools.* settings. Keep this list explicit so pin upgrades require a deliberate review.
pub const CODEX_FEATURES_DISABLE: &[&str] = &[
    "api_key_cyber_access_programs", // Additional access programs are unnecessary.
    "apps",                          // Connected applications.
    "browser_annotation_api",        // Browser interaction.
    "browser_use",                   // Browser tools.
    "browser_use_external",          // External browser access.
    "browser_use_full_cdp_access",   // Full browser debugging protocol access.
    "cli_daybreak",                  // Unneeded CLI mode; reach is not audited.
    "code_mode",                     // Unneeded without its host; avoids unavailable-host noise.
    "code_mode_host",                // Code execution host.
    "code_mode_interrupt",           // Code execution control is unnecessary.
    "collaboration_modes",           // Removed compatibility switch; no need to retain it.
    "computer_use",                  // Computer interaction tools.
    "daemon_auto_start",             // Background process startup.
    "fast_mode",                     // Unnecessary execution mode.
    "goals",                         // Autonomous goal management.
    "guardian_approval",             // Alternative approval machinery; host uses never.
    "guardian_reuse_parent_compaction", // Guardian context reuse is unnecessary.
    "hooks",                         // User-configured command execution.
    "image_generation",              // External image generation tools.
    "in_app_browser",                // In-app browser surface.
    "in_app_chat",                   // In-app chat surface.
    "in_app_dictation",              // Audio input surface.
    "in_app_local_automation",       // Local automation access.
    "in_app_updates",                // App update machinery.
    "in_app_voice",                  // Voice interaction surface.
    "instant_interrupt",             // Unneeded experimental turn handling.
    "item_ids",                      // Removed compatibility switch.
    "memories",                      // Persistent context outside the conversation.
    "mentions_v2",                   // Extra context discovery.
    "multi_agent",                   // Delegated agents.
    "plugin_sharing",                // Plugin distribution.
    "plugins",                       // Additional plugin capabilities.
    "realtime_conversation",         // Realtime interaction surface.
    "remote_plugin",                 // Remote plugin loading.
    "resize_all_images",             // Removed compatibility switch.
    "shell_snapshot",                // Shell environment capture.
    "shell_tool",                    // Shell execution.
    "skill_mcp_dependency_install",  // Skill-triggered MCP installation.
    "skill_search",                  // Skills beyond the host instructions.
    "sleep_tool",                    // Additional model-callable tool.
    "sqlite",                        // Removed compatibility switch.
    "steer",                         // Removed compatibility switch.
    "terminal_resize_reflow",        // Removed compatibility switch.
    "tool_search_always_defer_mcp_tools", // Removed tool-discovery switch.
    "tool_suggest",                  // Additional tool discovery.
    "tui_app_server",                // Removed compatibility switch.
    "ultrafast_mode",                // Unnecessary execution mode.
    "unified_exec",                  // Process execution.
    "unified_exec_tty",              // Interactive process execution.
    "view_image",                    // Local image access is a feature, not tools.view_image.
    "workspace_dependencies",        // Workspace dependency discovery.
    "worktrees",                     // Worktree management.
    "write_stdin_approval",          // Process input approval is unnecessary without execution.
];

/// Features whose availability differs by platform, mapped to the platforms where they exist.
/// Add an entry only after verifying the pinned binaries on every supported platform; a missing
/// entry is otherwise a parity failure. The list is currently empty.
pub const CODEX_FEATURES_PLATFORM_ONLY: &[(&str, &[super::pins::ToolPlatform])] = &[];

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
    pub fn parse_auth(&self, code: Option<i32>, stdout: &str, stderr: &str) -> AuthStatus {
        match self.tool {
            ToolId::Claude => {
                let json: serde_json::Value =
                    serde_json::from_str(stdout).unwrap_or(serde_json::Value::Null);
                let auth_method = json.get("authMethod").and_then(|v| v.as_str());
                let logged_in =
                    code == Some(0) && json.get("loggedIn").and_then(|v| v.as_bool()) == Some(true);
                AuthStatus {
                    signed_in: logged_in
                        && matches!(auth_method, Some("claude.ai" | "oauth_token")),
                    auth_method: auth_method.map(str::to_owned),
                    detail: (logged_in
                        && matches!(auth_method, Some("api_key" | "api_key_helper" | "third_party")))
                    .then(|| "Signed in with an API key; ChemDraft runs use your Claude subscription login — sign in with claude auth login".to_owned()),
                }
            }
            ToolId::Codex => AuthStatus {
                // Codex login status normally writes its human-readable result to stderr.
                signed_in: code == Some(0)
                    && stdout
                        .lines()
                        .chain(stderr.lines())
                        .any(|line| line.starts_with("Logged in")),
                auth_method: None,
                detail: None,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
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
            // Bare web permission names cover every domain; host-owned, never plugin input.
            args.extend(strings(&[
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
            ]));
            args.push(path(input.system_prompt_file));
            // Keep the subscription login, but never load user/project plugins or skills.
            args.extend(strings(&[
                "--setting-sources",
                "",
                "--disable-slash-commands",
            ]));
            // 2.1.308 loads these built-in plugins even with settings sources disabled.
            // The init parity test requires an empty plugin list on each pin upgrade.
            args.extend(strings(&["--settings", r#"{"disableAllHooks":true,"enabledPlugins":{"cc-plugin-agents-md@builtin":false,"cc-plugin-plugin-authoring@builtin":false}}"#]));
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
            debug_assert!(CODEX_FEATURES_KEEP
                .iter()
                .all(|feature| !CODEX_FEATURES_DISABLE.contains(feature)));
            for feature in CODEX_FEATURES_DISABLE {
                args.extend(strings(&["--disable", feature]));
            }
            for setting in [
                "approval_policy=\"never\"",
                "web_search=\"live\"",
                "check_for_update_on_startup=false",
                "analytics.enabled=false",
            ] {
                args.extend(strings(&["-c", setting]));
            }
            if !input.mcp_url.is_empty() {
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
