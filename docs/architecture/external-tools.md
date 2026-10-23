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
Each pins the version, URL, size, SHA-256, archive type, main archive entry, and installed binary.
Run `node scripts/pin-external-tools.mjs` to fetch Claude's latest release and manifest and the
latest `openai/codex` GitHub release, fetch its `codex-package_SHA256SUMS`, cross-check the package
downloads against those hashes and the release asset sizes/digests, inspect the archives, and print the Rust
constants and rows. Use `node scripts/pin-external-tools.mjs --check` before a release; it exits 1
when that rendered block differs from `pins.rs`. When pins match, `--check` also downloads the
host Claude binary from the manifest's release URL, reuses the downloaded host Codex archive,
verifies both sizes and SHA-256 hashes, extracts them and makes the executables runnable. It runs
`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml pinned_ -- --include-ignored --nocapture`
with `CHEMDRAFT_PINNED_CODEX` and `CHEMDRAFT_PINNED_CLAUDE` pointing at those verified binaries;
a failing test makes `--check` fail. A tool with no pinned binary for the host platform/architecture
is explicitly skipped. Temporary downloads and binaries are removed afterward. Managed copies
run with updates disabled.

### Pin bumps

The parity check covers only binaries for the host platform running it; a macOS run cannot execute
the Windows Codex and Claude binaries, and a Windows run cannot execute the macOS binaries. Every pin
bump must run `node scripts/pin-external-tools.mjs --check` on both macOS and Windows. The command
prints the host platform it checked and the platform it did not check; run it on the other host too.

## Discovery, installation, and sign-in

User installs win over managed copies. macOS probes `~/.local/bin`, `/opt/homebrew/bin`,
`/usr/local/bin`, `~/.codex/bin`, and `~/.npm-global/bin`, then the cached login-shell PATH.
Windows probes `%USERPROFILE%\.local\bin`, `%LOCALAPPDATA%\Microsoft\WinGet\Links`,
`%APPDATA%\npm`, `%ProgramFiles%\nodejs`, then process PATH/PATHEXT; `.exe` is preferred and
`.cmd`/`.bat` shims are never executed. Probes run `--version` (10 s, 64 KiB) and the tool-specific
auth status command (15 s, 64 KiB). Claude needs at least 2.1.259; Codex needs at least 0.162.1.
Claude requires stdout JSON `loggedIn: true`, exit 0, and `authMethod` of `claude.ai` or
`oauth_token`. API-key methods (`api_key`, `api_key_helper`, `third_party`) retain their method
but report signed out with a subscription-login hint: run environments strip API keys and
`--setting-sources ""` excludes `apiKeyHelper`. Codex requires exit 0 and `Logged in`
at the start of any line of stdout or stderr; `codex login status` normally writes its result to stderr.

Managed files live below app-local data `external-tools/<tool>/<version>/`; conversations use
`external-tools/runs/<pluginId>/<conversationId>/`, created privately and reused by follow-ups.
Installation downloads into a partial directory and verifies size and SHA-256. Codex uses the official
`codex-package-<target>.tar.gz` on all three targets, including Windows. The bounded tar reader extracts
only `bin/codex` and `bin/codex-code-mode-host` (`.exe` on Windows), side by side in the managed directory.
It checks every header/path, refuses links, duplicates and oversized entries, and verifies gzip integrity.
`codex-package.json`, `codex-path/rg`, and all voice/other resources are **not extracted**. Both executables
must pass codesign/Authenticode verification; `codex --version` must contain the pinned version and the
helper must be present and executable. Claude remains a single native binary. The receipt is written last.

Discovery resolves the real Codex executable through filesystem links before checking for its sibling
`codex-code-mode-host`. A missing helper reports `broken` with a reinstall/managed-install hint. Runs use
the executable selected by their starting status; auth reconciliation never triggers binary rediscovery.

Sign-in is explicit user interaction. macOS creates a private, executable
`chemdraft-signin-<tool>-<nonce>.command` and opens it with `/usr/bin/open`; it runs `claude auth
login` or `codex login` in Terminal. Windows launches `%ComSpec% /D /K` in a new console with the
native executable and the same login arguments. The UI refreshes status; it does not infer success.

## How each CLI finds its own login

Claude uses `HOME` to find `~/.claude`, honouring `CLAUDE_CONFIG_DIR` when set. On macOS its
Keychain entry is keyed to that config directory; on Windows credentials live in
`%USERPROFILE%\.claude\.credentials.json` (or the configured directory). Codex uses `$CODEX_HOME`
or the default `~/.codex` directory (`%USERPROFILE%\.codex` on Windows) as its home.
Codex can keep its own login in `auth.json` there or use its own encrypted local secrets backend
through `secret_auth_storage`. Pinned Codex 0.163.0 lists this feature on both macOS and Windows;
it is default-on only on Windows and present but off on macOS.
ChemDraft keeps that feature enabled so an existing Codex login remains accessible; it grants
no tool to the model. The environment allowlist preserves `HOME`, `CLAUDE_CONFIG_DIR`, and
`CODEX_HOME`, plus Windows `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, and `LOCALAPPDATA`,
so the CLI can find its own subscription login. API-key variables are deliberately not passed:
a shell key must not silently change the account or billing method.

Codex runs and probes use the private, stable `external-tools/codex-home` for sessions and configuration,
with only `auth.json` linked from the user's resolved Codex home (symlink on macOS, hard link on Windows).
This excludes the user's global instructions. Sign-in still uses the user's own home. When linking fails
(including keychain-only login), the host records a reason and falls back to the user's home; that fallback
cannot promise global-instruction isolation.

Codex may refresh credentials by replacing the link with a regular file. Before reuse and after every
supervised exit, cancellation, timeout or shutdown, ChemDraft compares JSON `last_refresh` timestamps.
A newer valid refresh is staged privately beside the user's auth file. The original is first saved as
`auth.json.bak` (0600 on macOS; the user's private directory ACL on Windows), then the new file is renamed
over the original atomically. The host re-reads and parses the committed JSON, checks its expected
`last_refresh` and complete bytes, and only then deletes `.bak`. Failed verification restores the original
by rename and records a reason. An existing `.bak` is retained and blocks another write-back until reviewed.
If the original auth file disappeared, write-back is refused because no original can be backed up.
Conflicting/invalid refreshes are quarantined privately, without logging token contents; isolation falls
back with an explicit reason. User-owned symlinks are preserved by resolving their target before write-back.
Unit tests inject temporary homes with fake tokens and temporary stub binaries; test-only guards refuse
any binary/home outside registered temporary roots before spawning or reading credentials.

## Run contracts

These are the templates rendered by `catalog.rs` (optional resume/model/effort arguments are added
only when supplied):

```text
claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --strict-mcp-config --mcp-config <run>/claude-mcp.json --tools "WebSearch,WebFetch" --allowedTools "mcp__chemdraft__*,WebSearch,WebFetch" --permission-mode dontAsk --permission-prompts none --max-turns 40 --system-prompt-file <run>/system-prompt.md --setting-sources "" --disable-slash-commands --settings {"disableAllHooks":true,"enabledPlugins":{"cc-plugin-agents-md@builtin":false,"cc-plugin-plugin-authoring@builtin":false}} [--resume <id>] [--model <model>] [--effort low|medium|high]
```

Claude receives a newline-terminated stream-JSON user message on stdin. Its config points at the
host MCP URL when supplied; runs without a bound MCP session receive an empty `mcpServers` config.
Settings sources and slash commands are disabled to exclude user/project plugins and skills;
the real login directory is preserved, and hooks are disabled explicitly. The two plugins enabled
by default in pinned Claude 2.1.308 (`cc-plugin-agents-md@builtin` and
`cc-plugin-plugin-authoring@builtin`) are also explicitly disabled: settings-source isolation
alone does not disable built-in plugins. The init parity assertion catches newly enabled plugins
when pins change. `EndConversation` may remain alongside the explicitly enabled web and MCP tools.

```text
codex exec [resume <id>] --json [-C <run>] --skip-git-repo-check --ignore-user-config --ignore-rules
  [--sandbox read-only | -c sandbox_mode="read-only"]
  --disable api_key_cyber_access_programs --disable apps --disable browser_annotation_api --disable browser_use
  --disable browser_use_external --disable browser_use_full_cdp_access --disable cli_daybreak
  --disable collaboration_modes --disable computer_use --disable daemon_auto_start
  --disable fast_mode --disable goals --disable guardian_approval
  --disable guardian_reuse_parent_compaction --disable hooks --disable image_generation
  --disable in_app_browser --disable in_app_chat --disable in_app_dictation
  --disable in_app_local_automation --disable in_app_updates --disable in_app_voice
  --disable instant_interrupt --disable item_ids --disable memories --disable mentions_v2
  --disable multi_agent --disable multi_agent_v2 --disable plugin_sharing --disable plugins --disable realtime_conversation
  --disable remote_plugin --disable resize_all_images --disable shell_snapshot --disable shell_tool
  --disable skill_mcp_dependency_install --disable skill_search --disable sleep_tool
  --disable sqlite --disable steer --disable terminal_resize_reflow
  --disable tool_search_always_defer_mcp_tools --disable tool_suggest --disable tui_app_server
  --disable ultrafast_mode --disable unified_exec --disable unified_exec_tty
  --disable view_image --disable workspace_dependencies
  --disable worktrees --disable write_stdin_approval
  -c approval_policy="never" -c web_search="live" -c check_for_update_on_startup=false
  -c analytics.enabled=false
  [-c mcp_servers.chemdraft.url="<url>"
   -c mcp_servers.chemdraft.bearer_token_env_var="CHEMDRAFT_MCP_TOKEN"
   -c mcp_servers.chemdraft.required=true -c mcp_servers.chemdraft.default_tools_approval_mode="approve"
   -c mcp_servers.chemdraft.startup_timeout_sec=30 -c mcp_servers.chemdraft.tool_timeout_sec=120]
  -c model_instructions_file="<run>/system-prompt.md" [-m <model>]
  [-c model_reasoning_effort="low|medium|high"] -
```

Codex receives the prompt directly on stdin. Both templates reject dangerous bypass flags.
First turns and resumes apply the same explicit `CODEX_FEATURES_DISABLE` policy. Image viewing
is controlled by the `view_image` feature. Code mode, its host and interrupt support remain enabled:
ChemDraft's MCP tools are offered through `functions.exec` in the pinned CLI. `approve` permits those
explicitly bound read/write tools under `approval_policy="never"`. `CODEX_FEATURES_KEEP` also retains model discovery,
MCP authentication/elicitation, Codex login storage, content/compaction bookkeeping, compression,
proxy fallback, and connection retry behavior; each entry has a rationale in `catalog.rs`. Every other default-on
feature, including removed compatibility switches, is disabled. Pin upgrades must classify any
new default-on feature before shipping.

**Known limitation:** `collaboration.*` sub-agent tools remain present in Codex 0.162/0.163 even with
`multi_agent` and `multi_agent_v2` disabled. These flags do not guarantee tool removal. Sub-agents inherit
the same read-only sandbox and disabled shell/local-file configuration; the model receives no extra host
capability. The parity check permits this known surface and rejects unreviewed tool names.

Two ignored release parity tests exercise native binaries supplied by `CHEMDRAFT_PINNED_CODEX`
and `CHEMDRAFT_PINNED_CLAUDE` (absolute paths). Each verifies the binary's version against `pins.rs`
and runs in a temporary directory. Codex isolates configuration/auth directories to inspect the
CLI's defaults; Claude also uses a fake temporary home. Neither test inherits real account credentials.
The optional Claude init check may need synthetic login fixtures if a pinned release refuses to emit
init while signed out; it must never be repaired by restoring the real home.
An unset variable skips its test with a message.

```text
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml external_tools::tests::pinned_codex_accepts_rendered_run -- --ignored --nocapture
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml external_tools::tests::pinned_claude_accepts_rendered_run -- --ignored --nocapture
```

The Codex check parses `features list` and fails on any unclassified default-on feature reported
by that platform's binary. Every KEEP and DISABLE entry must appear in the pinned binary's list.
Only names explicitly listed in the platform-only allowlist may be absent on platforms where they
are not available; the allowlist is empty for the current pin.
It then runs the rendered first-turn arguments with a local test
provider requiring an absent API key and the MCP connection disabled: config validation finishes,
then authentication fails before a model request. A 30 s timeout bounds the check, which rejects
unknown/ignored flag or setting diagnostics. This covers the retained `-c` keys, including the
optional MCP and reasoning settings. The Claude check compares every rendered flag (including
resume, model, and effort) with `--help`; its documented hidden `--max-turns` and
`--system-prompt-file` flags have an explicit allowlist. It also runs the rendered first-turn
command in a temporary working directory planted with `.claude/settings.json` (a SessionStart
hook that writes a marker, plus an enabled plugin), a skill, a slash command, `.mcp.json` with a
`planted` server, and `CLAUDE.md`. It uses a one-line stream-JSON prompt, an unreachable
`127.0.0.1` MCP endpoint and the nonexistent model `chemdraft-parity-check-does-not-exist`, so no
model call can succeed. It reads stream-JSON until `system/init` (60 s limit), then kills the
process and checks that both `WebSearch` and `WebFetch` are present exactly once, with no other tools
except `mcp__chemdraft__*` and optional `EndConversation`, the only MCP
server is `chemdraft`, plugins and commands/skills are empty, and no hook events appeared. The
test also requires the hook marker to be absent, adds `--include-hook-events` for visibility,
and adds `--no-session-persistence` to avoid leaving a test transcript in `~/.claude/projects`.
That persistence flag is test-only; product runs retain transcripts for resume. A configured Claude
binary must emit init; a missing subscription login fails the check rather than skipping the web-tool
assertions. Consult the CLI reference
before adding a new help exception. Run these checks on macOS and Windows before changing pins or
releasing. Recorded auth fixtures under `external_tools/fixtures/auth/` cover both CLIs' signed-in
and signed-out status formats without executing binaries.

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

## Opt-in real-model Codex parity

`node scripts/check-codex-tools.mjs --codex <extracted-package-codex>` calls the real model and is
also invoked by the release pin script's `--check`. It uses the Rust-rendered argv/environment, a
stub MCP server, and a fresh temporary `CODEX_HOME`. The Rust renderer never reads auth or calls
production preparation/reconciliation. Only the script creates the login link; read-only access to
its real source is enforced by Seatbelt on macOS and a deny-write/delete file share on Windows.
The script fails closed if that protection or the link cannot be established (Windows hard links
require the temporary home and source to be on the same volume). A concurrent login writer may be
blocked during the Windows check. No real-model call belongs in ordinary CI.

After every outcome the script inspects the link. If Codex replaced it with a refreshed credential
file, it prints a warning that a refresh happened and the user's own Codex will refresh on next use,
then deletes the temporary copy **without write-back**. It removes the temporary home and retains only
the private parity artifacts. It never invokes the app's auth write-back code or alters the original's
permissions. Run `node scripts/check-codex-tools.mjs --self-test` and
`node scripts/pin-external-tools.mjs --self-test` for offline fake-credential/package assertions.

## Web access

Web access is on by owner decision (2026-10-22 20:30), including chemical-structure lookups.
It is open web: ChemDraft applies no domain allowlist to searches or page reads. Only the host-owned
`catalog.rs` run templates enable it, on first turns and resumes; there is no plugin parameter for
web access or arbitrary tools. CLI/provider restrictions can still make individual pages unavailable.

- Claude Code 2.1.308 exposes `WebSearch` and `WebFetch`, plus ChemDraft's MCP tools and optional
  `EndConversation`. The [CLI reference](https://code.claude.com/docs/en/cli-reference) distinguishes
  tool availability (`--tools`) from permission rules (`--allowedTools`). Bare `WebSearch` and
  `WebFetch` permission names allow all domains without prompting; a bare `WebFetch` grants fetches
  without widening shell-network permissions ([permission rules](https://code.claude.com/docs/en/permissions#allow-or-deny-every-fetch)).
- Codex 0.163.0 uses `-c web_search="live"`, its most capable supported search mode, to expose the
  native Responses web-search tool. That service supports live search and page opening/reading
  (and finding text within pages), rather than browser or computer automation. The pinned CLI's
  `features list` and configuration expose no separate plain-page-fetch switch, so no additional
  fetch capability is enabled. The pinned binary's generated app-server schema confirms
  `WebSearchMode` values `disabled`, `cached`, `indexed`, and `live`, and `WebSearchAction` variants
  `search`, `openPage`, and `findInPage` (plus `other`). The `CODEX_FEATURES_DISABLE` list is unchanged: `browser_use*`,
  `browser_annotation_api`, `computer_use`, `in_app_browser`, shell, execution, and local-image tools
  remain disabled. See the [configuration reference](https://developers.openai.com/codex/config-reference/)
  and [native web-search actions](https://developers.openai.com/api/docs/guides/tools-web-search).

Web pages are untrusted input and can try to steer the AI through prompt injection. For example,
a page might ask the AI to fetch an address carrying the drawing in its URL, disclosing unpublished
structures to that site. The open-web setting permits such outbound requests; the editing limits
and Undo do not prevent or reverse disclosure. Consent says “The AI can search the web and read
web pages.” once, in the shared disclosure, and states that the prompt and open page, including
unpublished structures, leave the computer and go to Anthropic (Claude Code) or OpenAI (Codex).

The assistant's host-enforced write scope is fixed at Send: it may change only what was selected
then, plus objects it inserted earlier in that request; with no selection it can only add. Results
land directly on the page without an approval window. Each request is one labelled Undo entry,
leaving changed objects selected. Undo and redo restore the recorded change exactly and never call
the AI. Shell, local-file tools, and other unrelated tools remain off; settings, hooks, plugins,
telemetry, and permission prompts retain the restrictions described above. Write-scope and history
enforcement belong to the assistant transaction layer in PR B, not to the CLI's web permissions.

## Consent and current Windows verification

Consent is per plugin and per tool in app-local `external-tools/consents.json`, atomically replaced
with private permissions. A plugin must have it before a run; the Plugin Manager can list/revoke it,
and uninstall clears that plugin's records. The consent UI names the tool publisher (Anthropic or
OpenAI) and its disclosure is the place to explain what leaves the computer.

Windows code paths are unit-tested through platform parameters, but this PR has not yet performed a
hands-on Windows verification of WinGet/npm discovery, shim resolution, new-console sign-in, absent
console flash, Authenticode verification, or Job Object child cleanup. Those remain required before
release.
