# Adjustable wavy lines

Restored 2026-10-25 on `codex/adjustable-wavy-lines`, directly based on jgassens/ChemDraft main
`20112a1`. Only the wavy-line feature was extracted from the backup. Unrelated unmerged reaction,
arrangement and page-guide work is excluded; the original stash remains intact.

Selected wavy lines show Smooth, Height and Width sliders in
floating Art/Object Settings, using existing live preview and one Undo commit per drag. Settings
persist in native documents and use shared canvas/export geometry. Width fits whole wave cycles.

32 focused tests passed (ToolPalette DOM: 27; wavy-line geometry/persistence/commands: 5).
Whitespace check passed. No full suite or agent-run native build/launch: owner requests minimal usage.
Owner confirmed the preview looks good on 2026-10-25; Windows native verification remains open.
Source stamp `10.25.10.30-codex`.

Preview from the VS Code terminal:

```sh
cd "/Users/emily/ChemDraft Repository/ChemDraft"
./run-app
```

Look for `ChemDraft [codex/adjustable-wavy-lines]`, source stamp `10.25.10.30-codex`.
Draw/select a wavy line, open Object Settings, try the sliders and Undo.
User workflow preference: each feature starts directly from current jgassens/main on its own branch,
without unrelated changes from other unmerged PRs. Keep usage and checks minimal.

Root TypeScript check (`pnpm lint`) also passed after restoration onto main.
