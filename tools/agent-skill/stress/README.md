# ChemDraft agent-skill stress test

This fixed set tests chemist requests made through only the ChemDraft skill and MCP server.
Held-out cases are scored only for the baseline and final re-test; never read them while fixing the
skill, CLI, or MCP.

Refresh and verify the Chemistry reference lock with:

```sh
node tools/agent-skill/stress/verify-references.mjs
node tools/agent-skill/stress/verify-references.mjs --check
```

Run and grade the set using the commands in `SCORING.md`:

```sh
node tools/agent-skill/stress/runner/run.mjs
node tools/agent-skill/stress/grader/grade.mjs
```

Run outputs are never committed.
