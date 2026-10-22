# Stress runner isolation

The runner was checked against Claude Code `2.1.304` with `claude --help` on
2026-10-22. Each invocation uses `--setting-sources project` and
`--strict-mcp-config`; its only project is the empty per-case work folder,
which contains the copied ChemDraft skill and no settings. `--bare` also
suppresses hooks, plugins, auto-memory, and `CLAUDE.md` discovery. The help
text confirms that skills remain available in bare mode.

For unattended operation it uses `--dangerously-skip-permissions`,
`--permission-mode bypassPermissions`, `--permission-prompts none`, and
`--allowedTools` for Bash, the named file/search/web/skill tools, and
`mcp__chemdraft__*`. These option spellings are centralized in `runner.mjs`.
