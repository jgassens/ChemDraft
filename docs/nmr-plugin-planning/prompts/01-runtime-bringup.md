# Assignment 01: Bring Up the Live Plugin Runtime

- **Status:** done (executed 2026-07-07 → [reports/0001](../reports/0001-runtime-bringup-2026-07-07.md))
- **Milestones:** M1–M3 (canonical numbering in `PLANS.md` → "Implementation sequence")
- **Supersedes:** `FIRSTPROMPT.md` (revised 2026-07-07 after repository verification at commit `64cf513e`)
- **Next assignment:** `prompts/02-selection-analysis-apis.md` (M4–M5)

Work in the ChemDraft repository worktree for this feature.

Read `AGENTS.md` and `PLANS.md` in full before editing — including the
"Repository verification (2026-07-07)" section of `PLANS.md`. Follow them as
repository instructions.

Implement **Milestones 1–3 only**:

1. inventory and test the current plugin/runtime behavior;
2. create a persistent desktop plugin runtime (host, panel-report renderer, Analyze-menu adaptation, diagnostics);
3. mount the existing `molscribe-ocsr` plugin as the first live bundled-plugin canary.

Do **not** implement the NMR plugin, selection API extension, analysis API, predictor, worker, spectrum report, or any `nmr-predictor` dependency in this assignment.

## Objective

Prove this path in the running desktop and in tests:

```text
molscribe-ocsr manifest
  -> persistent PluginHost
  -> bundled registration
  -> manifest-derived Analyze contribution
  -> command invocation
  -> declarative panel report rendered by the desktop
  -> bundled-plugin diagnostics
```

The OCR model or OCR workflow itself does not need to be completed. A simple canary command that pushes a `PluginPanelReport` is sufficient, provided it uses the existing plugin manifest and the real host registration path.

## Verified repository state (re-verify cheaply; `main` may have moved)

These were verified at commit `64cf513e` on 2026-07-07. Confirm each still
holds before relying on it; report any drift in the final report's
"assumption discrepancies" section.

- `PluginHost` is instantiated only in `packages/plugin-host` tests, never by the desktop.
- `MainWindow.tsx` (~23,500 lines) constructs `CommandRegistry` directly inside a `useMemo` (~line 6306). Audit the memo's dependency array as part of Milestone 1 and record whether the registry is recreated on document changes.
- An `invokeCommandRef` ref-based invocation pattern exists (~line 1714).
- The conformer worker/client request-ID pattern exists (`conformerWorker.ts`, `conformerClient.ts`). No worker work is required in this assignment.
- `molscribe-ocsr` exists as an example package (`examples/plugins/molscribe-ocsr`) with a validated manifest, and is not referenced anywhere in `apps/desktop`.
- The plugin API already has: permission-gated optional `selection` and `panels` context properties; a declarative `PluginPanelReport` model (text/keyValue/table/svg sections, svg ≤ 512 KB); `PluginHostOptions.showPanelReport`; `validateTrustedPluginManifest`; `unregisterPlugin`; an injectable `now` clock.
- The desktop never supplies `showPanelReport`, so no report renderer surface exists. That renderer is part of this assignment.
- An Analyze menu section exists in `apps/desktop/src/appMenu.ts` (~line 241) with one core item. `appMenu.test.ts` asserts the web menu mirrors the native Tauri menu (`src-tauri/src/lib.rs`, `MENU_COMMAND_IDS`) one-for-one, with a `nativePredefined` exclusion mechanism.
- `apps/desktop/src/toolsets.ts` distinguishes plugin commands from core commands by the `plugin.` command-ID prefix.
- No bundled-plugin list or diagnostics view exists.
- A selection-architecture refactor is planned in `PLANS-selection-policy.md` (planning only). Nothing in this assignment may deepen coupling to current selection internals.

When an assumption is wrong, adapt to the actual repository and document the discrepancy in the final report. Do not silently change the architecture.

## Required implementation

### 1. Add current-state coverage (M1)

Add or update tests that characterize existing behavior before or alongside the refactor:

- plugin manifest parsing;
- plugin registration and duplicate rejection;
- command registration and invocation;
- permission enforcement relevant to the canary;
- panel-report validation and routing through `showPanelReport`;
- the current `molscribe-ocsr` manifest.

Record (test or report) whether the `CommandRegistry` `useMemo` is recreated on document changes.

Avoid brittle tests that merely assert source text. Test public behavior and runtime identity where possible.

### 2. Create a persistent desktop plugin runtime (M2)

Create a focused desktop plugin integration area (suggested: `apps/desktop/src/plugins/` — see `PLANS.md` "Desktop plugin runtime" for the suggested files; adapt names to repository conventions). Responsibilities:

- create one persistent `PluginHost`, supplying `getActiveDocument`, `getSelection`, `showPanelReport`, and (optionally in this milestone) a storage factory;
- register bundled plugins once;
- expose current document and selection through refs or provider callbacks without recreating the host;
- invoke plugin commands through the host;
- subscribe React to relevant runtime changes;
- retain existing core command behavior.

The host must not be recreated because of document edits, selection changes, active-page changes, viewport changes, or undo-history changes. Add a test or testable runtime seam that proves host identity remains stable while current-state providers return updated values.

Do not migrate core commands into `PluginHost` in this assignment. Core commands and plugin commands coexist; document the convergence target instead.

Keep new logic out of `MainWindow.tsx` except minimal wiring calls.

### 3. Add the desktop panel-report renderer (M2)

Plugins push declarative `PluginPanelReport` data; the desktop renders it. Do **not** build a React panel-component registry (superseded design — see `PLANS.md` "Panel reports and the desktop report renderer").

Implement:

- a renderer for the four section kinds (text, keyValue, table, svg), with svg rendered through a script-inert path (`<img>` with a data/blob URL — never `dangerouslySetInnerHTML`);
- open-panel state (`pluginId`, `panelId`, `report`, `openedAt`); one open panel is sufficient;
- desktop-owned chrome: panel title from the manifest contribution, a close control, and a "Run again" action when the panel contribution declares a `commandId` (dispatch through `PluginHost.invokeCommand`);
- a controlled diagnostic (not a crash, not a silent no-op) for a report referencing an unknown or undeclared panel ID.

Keep React out of `packages/plugin-api` and `packages/plugin-host`.

### 4. Add manifest-driven Analyze integration (M2)

Render registered plugin menu contributions whose location is `analyze` by extending the existing `appMenu.ts` model (resolved design — see `PLANS.md` "Manifest-driven menu integration"):

- plugin-contributed items carry a marker (e.g. `pluginContributed: true`) and the native-sync drift test excludes them from the `MENU_COMMAND_IDS` comparison, following the existing `nativePredefined` exclusion precedent;
- native Tauri menu support for plugin items may be deferred; if deferred, plugin items are web-menu-only and the gap is documented in the final report;
- selecting a plugin menu item must invoke the contribution's command through `PluginHost`, not the core command path;
- a manifest menu contribution referencing an unknown command must be rejected or surfaced as a registration diagnostic;
- do not import the toolset registry or app-menu model into `plugin-host`.

### 5. Add bundled-plugin diagnostics (M2)

Add a small diagnostics view or panel listing successfully registered bundled plugins: plugin ID, name, version, and declared contributions. Call them "bundled plugins" — do not imply arbitrary external plugins can be installed.

### 6. Mount `molscribe-ocsr` as the canary (M3)

Register the existing `molscribe-ocsr` manifest and command handlers through the new bundled-plugin runtime. Its command may simply push a canary `PluginPanelReport` (plugin name, version, command state, a statement that the runtime path is active, placeholder OCR status) to its declared panel.

The assignment is complete when the canary proves:

```text
manifest -> host -> Analyze item -> command -> rendered report
```

Do not implement OCR model execution.

## Architectural constraints

- Keep generic host packages UI-framework neutral (no React in `plugin-api`/`plugin-host`).
- Follow the verified naming conventions (AGENTS.md "Naming and manifest conventions").
- Do not add NMR-specific types or code.
- Do not add dynamic arbitrary-JavaScript loading or plugin sandboxing.
- Do not add network or filesystem permissions.
- Do not add new state-management or RPC frameworks.
- Reuse existing ref and subscription patterns.
- Preserve existing core command and document behavior.
- Do not write plugin state into the native ChemDraft document.
- Update the build stamp in `AGENTS.md` and `MainWindow.tsx` per repository convention.
- Do not commit or push unless explicitly instructed.

## Acceptance criteria

1. The desktop constructs one persistent `PluginHost`.
2. Document edits do not reconstruct the host.
3. Current-state provider callbacks still observe the latest document/selection state.
4. `molscribe-ocsr` registers through the bundled-plugin path via `validateTrustedPluginManifest`/`registerPlugin`.
5. Its registered identity can be enumerated.
6. Its Analyze menu contribution is visible in the web menu bar.
7. The native-menu drift test passes with the documented plugin-item exclusion.
8. Selecting the contribution invokes its command through `PluginHost`, and the command's pushed report renders in the desktop panel surface (all four section kinds render; svg is script-inert).
9. The panel can close cleanly; "Run again" re-invokes the contribution's command.
10. Unknown or undeclared panel identifiers produce a controlled diagnostic.
11. A diagnostics view lists the bundled plugin ID, name, version, and contributions.
12. Existing core commands continue to function.
13. Existing duplicate-registration and permission semantics remain covered by tests.
14. `packages/plugin-api` and `packages/plugin-host` contain no React imports.
15. No NMR code or NMR dependency is added.

## Validation

Run the most targeted tests during development. Before reporting completion, run as much of the following as the environment supports:

```bash
pnpm lint
pnpm test
pnpm build
```

Also run package-specific tests for `plugin-api`, `plugin-host`, `molscribe-ocsr`, and the desktop integration.

Do not claim that a command passed unless it was actually run. When a build cannot run because Rust, Tauri, browser APIs, or another local toolchain is unavailable, report the limitation and run the closest available TypeScript/web validation.

## Final report

Structure the report for verbatim archiving (it will be filed under `reports/` in the planning workspace). Include:

- milestones completed;
- **assumption discrepancies**: a table of the "Verified repository state" items above with confirmed/changed verdicts (include even if empty);
- files changed;
- how host persistence is achieved;
- how menu contributions enter the app menu and how the drift test was handled;
- how panel reports are rendered without React entering generic packages;
- how `molscribe-ocsr` is registered and invoked;
- tests and builds actually run, with outcomes;
- deviations from `PLANS.md` and why;
- unresolved runtime risks;
- the next milestone (M4–M5: selection extension + analysis API), without implementing it.

Stop after Milestones 1–3. Do not begin the NMR implementation in the same change set.
