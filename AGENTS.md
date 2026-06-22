# Agent Instructions for ChemDraft Structure Inspector Branch

**Current Build**: 6.22.08.41-claude

> [!IMPORTANT]
> When implementation work starts or a significant slice is finished, update this build stamp and the corresponding `Build` string in `apps/desktop/src/MainWindow.tsx`. Use `[month].[day].[hour].[minute]-[agent_name]`.

This branch is for the rings-first Molecule Inspector worktree only.

- Worktree: `/Users/jeremiahgassensmith/Documents/programming/chemdraw-structure inspector`
- Branch: `codex/structure-inspector`
- Planning source: `PLANS.md`
- Current state: staging and planning only. Do not start coding until the user explicitly asks.

## Required Reading Before Coding

Before editing implementation files, read:

```text
PLANS.md
AGENTS.md
README.md
package.json
pnpm-workspace.yaml
```

If the work touches a package, also read that package's README or local documentation before editing.

## Slice 1 Scope

Ship rings first:

- Ring identity.
- Per-ring fill rendering.
- Ring interior selection and hit-testing.
- Ring fill/effect UI in a dedicated `Molecule Inspector` palette.

Defer these to later slices:

- Drawing tab/settings.
- Atom-label typography/settings.
- Indicator settings.
- Per-bond width, opacity, and effects.

Do not add `NativeMoleculeDrawingSettings`, `NativeAtomLabelSettings`, or `NativeMoleculeIndicatorSettings` in slice 1.

## Reuse Existing Systems

Verify existing code before adding new code.

- Whole-molecule fill/stroke color, paint type, opacity, none, and visual effects already apply to molecule objects through `documentWorkflow.ts` and `artInspectorModel.ts`. Reuse those paths where applicable.
- Per-bond color already exists through `applyColorToNativeMoleculePart`, writing `style.bondColors` and `style.atomLabelColors`.
- Per-bond style identity already lives on `bond.display.bondStyle`. Do not add a duplicate `style.bondStyles` map.
- The live inspector pattern already exists in `ArtToolbarStyleControls`. Mirror its model, payload, controls, and preview/commit/cancel behavior.
- Commands use value-encoded IDs and factory helpers. Do not introduce generic `*.set` commands with hidden value parameters.
- `exportDocumentToSvg` already reuses `planPageSvgRender`; per-ring render-plan paths should flow to export through that existing route.

## Hard Boundaries

- Do not change the main checkout. Work only in this worktree for this branch.
- Do not copy proprietary assets, icons, dialog art, help text, sample files, command IDs, trade dress, or branded UI.
- Keep chemical identity stable. Ring styling must not mutate atoms, bonds, bond order, charges, stereochemistry, reactions, or molecule metadata.
- Ring geometry and key logic must live in `packages/layout-engine`; app code imports helpers and does not duplicate ring math.
- The only new slice-1 storage concept is `style.ringStyles`, keyed by topology-derived ring keys.
- Ring keys must derive from sorted bond IDs, never coordinates.
- The Molecule Inspector must be hidden by default, compact, dense, and floating. Do not create a permanent right inspector or card/dashboard UI.
- Keep `core.moleculeInspector` and `view.toggleMoleculeInspector` as the dedicated palette path. Be aware that `view.toggleInspector` and disabled `tool.settings` already exist; do not multiply inspector concepts.
- Do not expand CDXML/CDX, clipboard, OCSR, style-sheet import, or broad toolbar customization work as part of this slice.

## Slice 1 Verification

Run targeted tests for touched files, including:

```bash
pnpm vitest run packages/layout-engine/src/index.test.ts packages/export-engine/src/svg.test.ts apps/desktop/src/documentWorkflow.test.ts apps/desktop/src/App.test.ts
pnpm lint
git diff --check
```

If hit-testing, pointer behavior, or the agent bridge changes, also run:

```bash
pnpm vitest run apps/desktop/src/agentBridge.test.ts apps/desktop/src/App.test.ts apps/desktop/src/drawingTools.test.ts
cargo test agent_bridge
```

## Closeout Requirements

At implementation closeout:

- Update the build stamp in this file.
- Update the `Build` string in `apps/desktop/src/MainWindow.tsx`.
- Report tests run and any skipped verification.
- Keep the final answer focused on the branch and the specific slice completed.
