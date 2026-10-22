# Stress runner

Run from the checkout, with output outside it:

```sh
node tools/agent-skill/stress/runner/run.mjs --cases /path/to/cases.json --out /path/to/results --agent codex
```

`--agent` accepts `claude` (the default) or `codex`. Both accept `--model`,
`--ids S01,S02`, `--split dev|heldout|all`, `--timeout-min`, `--concurrency`,
`--checkout`, `--force`, and `--dry-run`. Claude defaults to
`claude-sonnet-5-5`; Codex keeps its own default unless `--model` is supplied.
`--max-turns` applies only to Claude; Codex is bounded by the case timeout.
Completed cases resume only for the same agent; use separate output directories
when comparing agents or models, or `--force` to replace an attempt.

## Claude isolation

The runner was checked against Claude Code `2.1.304` with `claude --help` on
2026-10-22. Each invocation uses `--setting-sources project` and
`--strict-mcp-config`; its only project is the empty per-case work folder,
which contains the copied ChemDraft skill and no settings. `--bare` is omitted
so normal OAuth sign-in and automatic skill discovery remain available.
The init event must report only the connected `chemdraft` MCP server and the
`chemdraft` skill; otherwise the case records an isolation error.

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
approval/workspace/network settings, and `[mcp_servers.chemdraft]` launching
`pnpm -s --dir <checkout> chemdraft-mcp`. Shell commands can write the working
directory and access the network for lookups such as PubChem.

The ChemDraft skill is copied, with symlinks dereferenced, to
`$CODEX_HOME/skills/chemdraft`. This uses Codex's user skill location; the
installed binary's embedded skill documentation references
`$CODEX_HOME/skills/.system/...` (the CLI help does not list skill roots).
The copied home and initial work directory are checked for `AGENTS.md`.
Codex may subsequently create its own session/cache files in the isolated home.

Isolation succeeds only if events show a connected/ready ChemDraft MCP server
or a successful ChemDraft MCP call, no observed server has another name, and
the generated config is unchanged. Metadata records the check and the sole
configured server. No real Codex or Claude inference was run to verify this
runner; tests use fixture executables.

## Events and outputs

Both agents produce `transcript.jsonl`, `final.md`, `tool-calls.json`, `images/`,
`files.json`, and `meta.json`. `run.json` and each case's metadata identify the
agent. Codex metadata also records `codexVersion`, reported model, and event
token usage; no dollar cost is inferred.

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
`claude` pool is unchanged; Codex requires at least 15% in the `openai` pool
and halts if that pool cannot be read. Exit code 3 means usage halted work;
case failures/timeouts are recorded in metadata as before.

## Verification

```sh
pnpm vitest run --configLoader runner tools/agent-skill/stress/runner
```

Tests use fake Claude, Codex, and agentctl executables only. macOS was checked;
Windows remains unverified and needs this same fake-runner suite, especially
path/config quoting, process spawning, and timeout cleanup.
