# External tools

The external-tools runner lets a permitted plugin use a locally installed or ChemDraft-managed
Claude Code or Codex executable. It is a host-owned boundary: plugins send a typed request, never
argv, environment variables, or file paths. `apps/desktop/src-tauri/src/external_tools/` contains
the state and Tauri commands (`mod.rs`), fixed catalog/templates (`catalog.rs`), pins (`pins.rs`),
discovery (`probe.rs`), installation (`install.rs`), process supervision (`run.rs`), scrubbed
environment construction (`env.rs`), visible login (`terminal.rs`), and persistent consent
(`consent.rs`). The desktop adapter is `apps/desktop/src/externalTools/`; the shared dialog form is
`apps/desktop/src/dialogs/ToolInstallForm.tsx`.

## Commands and results

| Command | Arguments | Result |
| --- | --- | --- |
| `external_tool_status` | `tool`, `refresh` | `ExternalToolStatus` (installed/missing/broken/installing/unsupported, source, version, auth, install progress and consent) |
| `external_tool_install` | `tool`, progress `Channel` | installs one managed copy and streams `checkingDisk`, `downloading`, `verifying`, `installing`, `done` progress |
| `external_tool_cancel_install` | none | cancels the one active installation |
| `external_tool_uninstall` | `tool` | removes a managed copy after stopping its run |
| `external_tool_sign_in` | `tool` | `{ launched, method: "terminal.command" | "newConsole", detail? }` |
| `external_tool_consent_set` | `tool`, `pluginId`, `granted` | stores or revokes consent |
| `external_tool_consent_list` | none | all stored plugin/tool consents |
| `external_tool_run_start` | validated typed run request | `{ runId, pid, cwd, startedAt }` |
| `external_tool_run_poll` | `runId`, `cursor`, optional `maxLines`, `waitMs` | output lines, cursor, dropped-line count and run status |
| `external_tool_run_cancel` | `runId` | requests cancellation |
| `external_tool_conversation_clear` | `tool`, `pluginId`, `conversationId` | stops the conversation and removes its run directory |

The request permits `tool`, plugin/conversation IDs, prompt, system prompt, optional resume ID,
model, effort, MCP session ID, and timeout only. The host limits prompts to 32 KiB, system prompts
to 64 KiB, timeouts to 1,000–1,800,000 ms (default 600,000), and never accepts plugin argv/env.

## Pins and release upkeep

`pins.rs` has six `ToolPin` rows: Claude and Codex for Darwin ARM64, Darwin x64, and Windows x64.
Each pins the version, URL, size, SHA-256, archive type, single archive entry, and installed binary.
Run `node scripts/pin-external-tools.mjs` to fetch Claude's latest release and manifest and the
latest `openai/codex` GitHub release, verify/archive-inspect the Codex downloads, and print the Rust
constants and rows. Use `node scripts/pin-external-tools.mjs --check` before a release; it exits 1
when that rendered block differs from `pins.rs`. Managed copies run with updates disabled.

## Discovery, installation, and sign-in

User installs win over managed copies. macOS probes `~/.local/bin`, `/opt/homebrew/bin`,
`/usr/local/bin`, `~/.codex/bin`, and `~/.npm-global/bin`, then the cached login-shell PATH.
Windows probes `%USERPROFILE%\.local\bin`, `%LOCALAPPDATA%\Microsoft\WinGet\Links`,
`%APPDATA%\npm`, `%ProgramFiles%\nodejs`, then process PATH/PATHEXT; `.exe` is preferred and
`.cmd`/`.bat` shims are never executed. Probes run `--version` (10 s, 64 KiB) and the tool-specific
auth status command (15 s, 64 KiB). Claude needs at least 2.1.259; Codex needs at least 0.162.1.

Managed files live below app-local data `external-tools/<tool>/<version>/`; conversations use
`external-tools/runs/<pluginId>/<conversationId>/`, created privately and reused by follow-ups.
Installation downloads into a partial directory, verifies size and SHA-256, extracts/renames one
entry, verifies its version and platform signature, then writes the receipt last.

Sign-in is explicit user interaction. macOS creates a private, executable
`chemdraft-signin-<tool>-<nonce>.command` and opens it with `/usr/bin/open`; it runs `claude auth
login` or `codex login` in Terminal. Windows launches `%ComSpec% /D /K` in a new console with the
native executable and the same login arguments. The UI refreshes status; it does not infer success.

## Run contracts

These are the templates rendered by `catalog.rs` (optional resume/model/effort arguments are added
only when supplied):

```text
claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --strict-mcp-config --mcp-config <run>/claude-mcp.json --tools "" --allowedTools mcp__chemdraft__* --permission-mode dontAsk --permission-prompts none --max-turns 40 --system-prompt-file <run>/system-prompt.md --settings {"disableAllHooks":true} [--resume <id>] [--model <model>] [--effort low|medium|high]
```

Claude receives a newline-terminated stream-JSON user message on stdin. Its config points at the
host MCP URL when supplied; this PR currently stages an empty `mcpServers` config and passes no URL.

```text
codex exec [resume <id>] --json [-C <run>] --skip-git-repo-check --ignore-user-config --ignore-rules [--sandbox read-only | -c sandbox_mode="read-only"] -c approval_policy="never" -c features.shell_tool=false -c features.unified_exec=false -c tools.view_image=false -c web_search="disabled" -c check_for_update_on_startup=false -c analytics.enabled=false [-c mcp_servers.chemdraft.url="<url>" -c mcp_servers.chemdraft.bearer_token_env_var="CHEMDRAFT_MCP_TOKEN" -c mcp_servers.chemdraft.required=true -c mcp_servers.chemdraft.default_tools_approval_mode="auto" -c mcp_servers.chemdraft.startup_timeout_sec=30 -c mcp_servers.chemdraft.tool_timeout_sec=120] -c model_instructions_file="<run>/system-prompt.md" [-m <model>] [-c model_reasoning_effort="low|medium|high"] -
```

Codex receives the prompt directly on stdin. Both templates reject dangerous bypass flags.

Every child starts with `env_clear()`. The allowlist keeps `HOME`, `USER`, `LOGNAME`, `LANG`,
`LC_*`, `XDG_*`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, proxy variables, certificate variables, and
`NODE_EXTRA_CA_CERTS`; Windows also keeps the account, AppData, system, shell, architecture, and
PATHEXT variables needed to run native programs. It sets a binary-directory-plus-system `PATH`,
`TMPDIR`/`TEMP`/`TMP` to the run directory, `TERM=dumb`, `NO_COLOR=1`, and disables telemetry,
error reporting, and auto-update (plus managed updates). API-key variables, including
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `CODEX_API_KEY`, are scrubbed and never passed.

Output is bounded to 4 MiB or 20,000 lines (oldest lines are dropped and counted), 256 KiB per line,
and 5,000 lines per poll. Cancellation/timeout sends SIGINT on Unix, waits two seconds, then kills
the process tree. Windows also starts without a console flash and places the suspended child in a
kill-on-close Job Object before resuming it, so descendants die on cancellation or host loss.

## Consent and current Windows verification

Consent is per plugin and per tool in app-local `external-tools/consents.json`, atomically replaced
with private permissions. A plugin must have it before a run; the Plugin Manager can list/revoke it,
and uninstall clears that plugin's records. The consent UI names the tool publisher (Anthropic or
OpenAI) and its disclosure is the place to explain what leaves the computer.

Windows code paths are unit-tested through platform parameters, but this PR has not yet performed a
hands-on Windows verification of WinGet/npm discovery, shim resolution, new-console sign-in, absent
console flash, Authenticode verification, or Job Object child cleanup. Those remain required before
release.
