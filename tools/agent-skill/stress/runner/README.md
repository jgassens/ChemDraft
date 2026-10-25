# Stress runner

Run from the checkout, with output outside the checkout and its parent
directory (for example, `~/chemdraft-stress-runs`):

```sh
node tools/agent-skill/stress/runner/run.mjs --cases /path/to/cases.json --out /path/to/results --agent codex
```

`--agent` accepts `claude` (the default) or `codex`. Both accept `--model`,
`--ids S01,S02`, `--split dev|heldout|all`, `--timeout-min`, `--concurrency`,
`--checkout`, `--force`, and `--dry-run`. Claude defaults to
`claude-sonnet-5-5`; Codex keeps its own default unless `--model` is supplied.
`--max-turns` applies only to Claude; Codex is bounded by the case timeout. The
runner refuses to start either agent unless the checkout has the built OPSIN Java
runtime at `apps/desktop/src-tauri/resources/opsin/jre/bin/java` (`java.exe` on
Windows). `--skip-preflight` exists only for fake-runner tests.
Completed cases resume only for the same agent; use separate output directories
when comparing agents or models, or `--force` to replace an attempt.
An `--out` directory inside a different ChemDraft checkout makes every case fail
as a foreign-checkout isolation leak.

## Claude isolation

The runner was checked against Claude Code `2.1.304` with `claude --help` on
2026-10-22. Each invocation uses `--setting-sources project` and
`--strict-mcp-config`; its only project is the empty per-case work folder,
which contains the copied ChemDraft skill and no settings. `--bare` is omitted
so normal OAuth sign-in and automatic skill discovery remain available.
Claude keeps the parent's `HOME` unchanged because its sign-in depends on it.
The init event must report only the connected `chemdraft` MCP server and the
`chemdraft` skill; otherwise the case records an isolation error.

A live probe on 2026-10-22 with Claude Code 2.1.x showed that
`--setting-sources project` excludes `~/.claude/CLAUDE.md`, user skills and
hooks. The runner also rejects init skill names found in `~/.claude/skills`
other than `chemdraft` as `isolation-leak`.

For both agents, every ancestor of `--out` is checked for `CLAUDE.md`,
`AGENTS.md`, `.claude/` and `.codex/`, through the home directory (or filesystem
root for outputs outside home). Only the user's own `~/.claude` and `~/.codex`
folders are exempt. Symlink destinations are checked too. Checkout git status
is recorded before the run and after each case. New changes set
`checkoutModified: true` and fail isolation. Claude Write/Edit/NotebookEdit and
Codex file-change events inside the checkout are audited as `source-write` and
also fail isolation, including writes reverted before the status check.

For unattended operation it uses `--dangerously-skip-permissions`,
`--permission-mode bypassPermissions`, `--permission-prompts none`, and
`--allowedTools` for Bash, the named file/search/web/skill tools, and
`mcp__chemdraft__*`. These option spellings are centralized in `runner.mjs`.

## Codex isolation

The installed Codex `0.162.1` was inspected using `codex exec --help`,
`codex --help`, and its embedded strings on 2026-10-22. The invocation is
`codex exec --json --skip-git-repo-check -- <verbatim prompt>`, with the prompt
passed as one spawn argument and the empty per-case `work/` as cwd.
`CHEMDRAFT_STRESS_CODEX_BIN` overrides the binary (default `codex`).

Each case gets `<out>/<id>/codex-home` as `CODEX_HOME`. Only `auth.json` is
copied from `CHEMDRAFT_STRESS_CODEX_AUTH_HOME` (default `~/.codex-openai`);
missing auth fails clearly. Source settings, plugins, and instructions are not
copied. Treat the output directory as private: it contains that copied auth.
The generated `config.toml` contains only the optional model, unattended
approval/workspace/network settings, `[features] plugins = false`, and
`[mcp_servers.chemdraft]` launching `pnpm -s --dir <checkout> chemdraft-mcp`.
That server has `default_tools_approval_mode = "approve"`, so tool calls can run
under Codex's otherwise `never` approval policy. Shell commands can write the
working directory and access the network for lookups such as PubChem.

Codex also gets `<out>/<id>/home` as `HOME` (and `USERPROFILE` on Windows).
Inside it, `.codex/skills/chemdraft` links to `<checkout>/skills/chemdraft`, using
a directory junction on Windows. The skill's documented install resolution
therefore reaches the checkout under test. `PATH` and every other parent
environment variable are preserved; `CODEX_HOME` stays the isolated directory
described above, so login shells can still find Node and pnpm.

The ChemDraft skill at `$CODEX_HOME/skills/chemdraft` links to
`<checkout>/skills/chemdraft`, using a directory junction on Windows. This
matches the link under the fake home and Codex's documented install layout, so
the skill's checkout discovery resolves the checkout under test. This uses
Codex's user skill location; the installed binary's embedded skill documentation references
`$CODEX_HOME/skills/.system/...` (the CLI help does not list skill roots).
The copied home and initial work directory are checked for `AGENTS.md`.
Codex may subsequently create its own session/cache files in the isolated home.

Isolation succeeds when the generated config remains unchanged (and therefore
contains only ChemDraft with plugins disabled), no `plugins/` folder appears in
`CODEX_HOME`, and neither events nor saved `stderr.log` names another MCP
server. A completed or failed ChemDraft MCP call is positive evidence that the
server is ours; a run with no ChemDraft calls is still isolated and complete if
those configuration and leak checks pass. A leak makes the case `error` with
reason `isolation-leak`. Metadata records the check and the sole configured
server. No real Codex or Claude inference was run to verify this runner; tests
use fixture executables.

## Events and outputs

Both agents produce `transcript.jsonl`, `final.md`, `tool-calls.json`, `images/`,
`files.json`, `outputs/`, `outputs.json`, `assets.json`, and `meta.json`. The
assets manifest associates saved images and copied outputs with their zero-based
tool call index and original path when available; A6 pairs PNG/SVG from the same
call or original basename. After each case, the
runner copies supported output files named in the final report or passed through
`--out`, `--out-dir`, or shell redirection into `outputs/`; `outputs.json`
records each original path, copied name, byte size, and SHA-256. Paths under the
isolated Codex home are excluded, and output directories with more than 50 files
are not traversed. File inputs passed through `--document`, `--batch`, `--reaction`,
`--input`, `--jobs`, their `-file`/`-path` variants, or MCP `documentPath`,
`batchPath`, `reactionPath`, and `inputPath` are retained the same way, including
outside `work/`. These copies keep `requestedPath`, canonical `originalPath`, and
`toolCallIndex`, and use the same traversal limits as outputs. Explicit input
files are retained regardless of extension. Input retention copies any file the
agent names, so `outputs/` may hold files from anywhere the agent pointed; do not
share run folders blindly.
Metadata's `repoAccess` records agent shell commands that name the checkout,
classified as the ChemDraft CLI or a source read, plus Claude file/search calls.
It also classifies referenced absolute paths in shell commands and
Read/Grep/Glob/Write/Edit/NotebookEdit calls (and Codex file changes) as
`foreign-checkout` when an ancestor contains both
`packages/chemdraft-cli/package.json` and `skills/chemdraft/SKILL.md` and is not
`--checkout`. Ancestor detection is cached and resolves symlinks, including
the fake home's skill link. Any foreign checkout access makes the case `error`
with reason `isolation-leak: foreign checkout <path>`. This audits recorded
paths; it does not interpret arbitrary shell programs or prevent disk access.
`run.json` and each case's
metadata identify the agent. Codex metadata also records `codexVersion`,
reported model, and event token usage; no dollar cost is inferred.

On Windows hosts Claude's Bash is Git Bash, while retention parsing still uses
cmd rules; this is a known limitation.

Codex event handling follows the official
[non-interactive JSONL documentation](https://developers.openai.com/codex/noninteractive/)
and installed exec/protocol strings (`item.started/updated/completed`,
`mcp_tool_call`, `command_execution`, `agent_message`, `turn.completed`,
`aggregated_output`, `server`, `arguments`, and `result`). A call's lifecycle
events produce one tool entry. MCP names become `mcp__chemdraft__<tool>`;
shell executions become `Bash` with `{command}` input and text content output.
MCP results retain `{content: [...]}` with image base64 removed; image and SVG
content is saved separately before stripping. The transcript remains raw.

Field fallbacks accept `server_name/serverName`, `tool_name/toolName`,
`input` or JSON-encoded `arguments`, JSON-encoded results, and
`aggregatedOutput/output`. Startup checks also accept wrapped `event_msg`
events. Model fields accept `model/model_name/modelName` and nested config,
settings, or `thread_settings`. Because public exec stdout may omit the model,
the runner also checks JSONL session events under that case's isolated
`codex-home/sessions/` (for example, `turn_context.payload.model`). If no event
reports it, metadata records `model: null`; it never guesses a default.

The usage guard checks `agentctl usage --json` before each new case: Claude's
`claude` pool and Codex's `openai` pool each halt below 15%. If usage cannot be
read or the relevant pool is missing/invalid, both warn on stderr and proceed.
Exit code 3 means usage halted work;
case failures/timeouts are recorded in metadata as before.

## Verification

```sh
pnpm vitest run --configLoader runner tools/agent-skill/stress/runner
```

Tests use fake Claude, Codex, and agentctl executables only. macOS was checked;
Windows remains unverified and needs this same fake-runner suite, especially
path/config quoting, process spawning, and timeout cleanup.
