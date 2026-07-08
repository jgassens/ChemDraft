# Agent Instructions for the ChemDraft NMR Plugin Branch

**Current Build**: 7.8.8.42-opus

> [!IMPORTANT]
> When implementation work starts or a significant slice is finished, update this build stamp and the corresponding `Build` string in `apps/desktop/src/MainWindow.tsx`. Use `[month].[day].[hour].[minute]-[agent_name]`. This is an established repository convention — see the structure-inspector branch's AGENTS.md.

- Worktree: `/Users/jeremiahgassensmith/Documents/programming/chemdraw-nmr`
- Branch: `codex/nmr-plugin`
- Planning source: `PLANS.md` (this branch's active plan)
- Planning workspace (prompts, status ledger, decisions, reports): `~/Documents/programming/Chemdraw-NMRplugin`
- Notary and app-signing instructions live at `~/Documents/programming/.notary`. Read that directory before signing, notarizing, packaging, or changing release automation.

## Purpose

This branch implements the first live bundled-plugin runtime for ChemDraft and then a Phase 1 structure-to-NMR-prediction plugin.

`PLANS.md` is the authoritative technical plan for this effort. Read it — including its "Repository verification (2026-07-07)" section — before changing code. Work is issued as one bounded assignment prompt per milestone (the first is `prompts/01-runtime-bringup.md` in the planning workspace; `FIRSTPROMPT.md` is its legacy name). Existing repository documentation, tests, and source code remain authoritative when they contradict an assumption in these files: report the discrepancy, adapt, and keep the intended boundary.

Do not treat the entire plan as one undifferentiated task. Work milestone by milestone and keep runtime bring-up separate from NMR chemistry.

## Required reading before editing

Read, in this order:

1. `AGENTS.md`
2. `PLANS.md`
3. the active assignment prompt for the current milestone
4. `README.md`
5. `PLAN.md` (the overall project plan — it exists)
6. root `package.json`
7. `pnpm-workspace.yaml`
8. `packages/plugin-api` (all of it — the selection, panel-report, and manifest contracts live here)
9. `packages/plugin-host` (including `selectionStorage.test.ts`)
10. `packages/chem-core/src/schemas.ts`
11. `packages/ocl-adapter`
12. `apps/desktop/src/MainWindow.tsx` — targeted regions only; it is ~23,500 lines. At minimum: the `CommandRegistry` `useMemo` (~line 6306), `invokeCommandRef` (~line 1714), and current selection state handling
13. `apps/desktop/src/appMenu.ts` and `apps/desktop/src/appMenu.test.ts` (the native-menu drift test)
14. `apps/desktop/src/toolsets.ts` (plugin-vs-core command sourcing)
15. `apps/desktop/src/documentWorkflow.ts`
16. `apps/desktop/src/conformerWorker.ts` and `apps/desktop/src/conformerClient.ts`
17. `examples/plugins/molscribe-ocsr` (the ID-naming and manifest conventions to copy)
18. `PLANS-selection-policy.md` (pending selection refactor the selection provider must not fight)
19. tests and package manifests adjacent to every file you expect to modify

Search the repository before asserting that a capability does not exist. Verify actual types, imports, construction sites, and tests.

## Execution order

Milestone numbering is canonical in `PLANS.md` → "Implementation sequence".
This list mirrors it exactly; if they ever disagree, `PLANS.md` wins and this
file must be fixed.

Use this order unless the user explicitly changes it:

1. **M1** — Inventory and characterize the current plugin/runtime behavior.
2. **M2** — Create the persistent desktop plugin runtime: `PluginHost`, panel-report renderer, Analyze-menu adaptation, diagnostics view.
3. **M3** — Mount `molscribe-ocsr` as the runtime canary.
4. **M4** — Extend the existing selection API (fingerprint, immutability, format enum, document/page identity).
5. **M5** — Add the generic analysis API and store.
6. **M6** — Create the NMR plugin package with the fixture-backed provider.
7. **M7** — Add the NMR worker and client.
8. **M8** — Add the NMR command and analysis integration.
9. **M9** — Add the NMR panel report.
10. **M10** — Investigate an OCL-native predictor.
11. **M11** — Investigate `nmr-predictor` only as an optional, bounded compatibility spike.
12. **M12** — Documentation and provenance.

Do not begin NMR implementation until the canary path works:

```text
manifest -> host -> menu -> command -> panel
```

Do not make `nmr-predictor` a prerequisite for any earlier milestone.

## Scope discipline

For the initial implementation, do not add:

- experimental spectrum import;
- JCAMP parsing;
- spectrum-to-structure inference;
- structure/spectrum matching;
- candidate ranking;
- dynamic loading of arbitrary third-party JavaScript;
- plugin sandboxing;
- Python;
- PyTorch;
- TensorFlow;
- native model services;
- remote prediction;
- model downloads;
- DFT calculations;
- viewport atom highlighting;
- multiplicity prediction;
- coupling constants;
- synthetic line-shape simulation;
- persistent analysis data in the ChemDraft document.

Do not expand the assignment merely because a nearby refactor looks attractive. Make the smallest coherent change that advances the current milestone and leaves the documented extension points intact.

## Repository architecture boundaries

### `packages/plugin-api`

Owns generic, framework-independent contracts only.

Allowed examples:

- plugin manifests;
- plugin permissions;
- selected-structure snapshots;
- generic analysis records;
- generic provenance;
- generic warnings;
- command context interfaces.

Not allowed:

- React types;
- NMR nuclei or shifts;
- OpenChemLib objects;
- Cheminfo result types;
- desktop panel components;
- Tauri-specific types.

### `packages/plugin-host`

Owns generic runtime behavior and policy enforcement.

Allowed examples:

- plugin registration;
- permission checks;
- command-context construction;
- selected-structure snapshot access;
- generic analysis storage;
- contribution enumeration;
- subscriptions;
- host-generated IDs and timestamps.

Not allowed:

- React rendering;
- NMR interpretation;
- direct knowledge of ChemDraft panels;
- third-party prediction dependencies.

### `apps/desktop`

Owns application and React integration.

Allowed examples:

- persistent host lifecycle;
- current-document and current-selection providers;
- bundled-plugin registration;
- menu-model adaptation;
- panel component registry;
- panel open/close state;
- plugin diagnostics UI.

Do not move React component types into generic packages to simplify imports.

### NMR plugin package

Owns all spectroscopy-specific contracts and behavior.

Allowed examples:

- nuclei;
- shifts;
- resonances;
- assignments;
- predictor capabilities;
- scientific warnings;
- result normalization;
- fixture provider;
- SVG stick spectrum;
- future matching contracts.

### Provider adapters

Own dependency-specific code.

Only adapter code may import or expose knowledge of:

- OpenChemLib prediction methods;
- `nmr-predictor` functions;
- Cheminfo data structures;
- dependency-specific atom identifiers;
- provider-specific errors;
- provider-specific environment-code conventions.

Do not let dependency types escape into the application service, worker protocol, React panel, generic plugin API, or analysis store.

## Naming and manifest conventions

These are verified repository conventions; follow them exactly:

- command IDs: `plugin.<pluginName>.<action>` (e.g. `plugin.nmrPredictor.predictSelectedStructure`). The desktop's toolset layer distinguishes plugin commands from core commands by the `plugin.` prefix, and toolset contribution IDs are schema-enforced to start with `plugin.`;
- menu IDs: `menu.<pluginName>.<action>`; panel IDs: `panel.<pluginName>.<name>`; analyzer IDs: `analyzer.<pluginName>.<name>`; recognizer IDs: `recognizer.<pluginName>.<name>` — mirroring `examples/plugins/molscribe-ocsr`;
- manifest `apiVersion`: `"^0.1.0"` (caret), matching the molscribe example; the host exports `PluginApiVersion = "0.1.0"` and does not enforce semantic compatibility — do not claim otherwise;
- the contributions object has twelve keys, all defaulting to `[]`; declare the full shape explicitly when annotating with `PluginManifest` (see molscribe);
- register bundled manifests through `validateTrustedPluginManifest` / `PluginHost.registerPlugin` so schema and permission validation run at registration;
- new-dependency versioning follows existing repository convention (caret ranges); exact-pin only the `nmr-predictor` spike package.

## Runtime rules

Create one persistent desktop plugin runtime. It must not be recreated because the document, selection, page, viewport, or undo state changes.

Use refs or provider callbacks to give the host current state. Reuse existing repository patterns such as the command invocation ref and the conformer worker/client protocol.

The first runtime milestone does not require migrating every core command into `PluginHost`. Preserve existing core command behavior and converge toward one command system incrementally.

Panels are declarative: plugins push `PluginPanelReport` data (text, keyValue, table, svg sections) through `context.panels.showReport`; the desktop owns the one renderer that displays validated reports plus the panel chrome (title, close, run-again). Plugins never provide UI components, and SVG renders in a script-inert context. Do not build a React panel-component registry; that design was superseded after repository verification (see `PLANS.md`).

Unknown plugin, command, menu, or panel identifiers must produce controlled errors or diagnostics rather than crashes or silent no-ops.

Do not imply that the diagnostics view is a general plugin installer. It lists bundled plugins registered by the application.

## Selection API rules

A selection API already exists: `PluginSelectionAPI.getSelection()` returning `PluginSelectionSnapshot` (`objectIds` + `molecules`), exposed as a permission-gated optional context property with tested behavior (`selectionStorage.test.ts`). Extend it in place; do not rename it, do not add a parallel `getSelectedStructures()` contract, and do not change the optional-property convention inside an NMR milestone (ADR-0008).

The extended selected-molecule snapshot may include:

- `objectId`;
- structure format (narrowed to the document-model enum);
- structure payload;
- `sourceFingerprint`;
- `documentId` and `pageId` where the document model provides them.

Supported snapshot formats are:

- `smiles`;
- `molfile-v2000`;
- `molfile-v3000`;
- `unknown`.

The NMR prediction request must reject `unknown` before invoking a worker.

Selection snapshots must be copied or immutable. Never expose live document object references to a plugin.

The initial fingerprint is a change detector, not a canonical chemical identity. Do not rename or document it as a molecular hash.

## Analysis API rules

Analysis records are derived session data in Phase 1.

Do not:

- place them in the native document;
- create document patches for them;
- grant the NMR plugin document-write permissions;
- mutate an older analysis record when rerunning a prediction.

The host owns:

- record ID;
- plugin ID;
- creation timestamp.

Deep-copy data entering and leaving the store. Tests must prove that callers cannot mutate stored records through retained references.

Define analysis-read visibility explicitly. The initial preferred policy is:

- a plugin reads its own records;
- trusted desktop code can render all records;
- cross-plugin reading is not exposed without a deliberate permission model.

## Worker rules

Follow the existing conformer worker/client style unless repository inspection shows a better established pattern.

Required worker properties:

- request IDs;
- typed request and response unions;
- lazy provider initialization;
- deterministic error normalization;
- cancellation or supersession;
- late-result suppression;
- explicit disposal;
- serializable plain-data results.

The fixture provider must work when `fetch` and `XMLHttpRequest` throw. Do not add network access, remote imports, or filesystem access.

Do not introduce an RPC framework merely to avoid a small amount of repeated worker code.

## Chemistry and scientific-claim rules

The Phase 1 predictor is an architecture test, not a validated scientific product.

The required working backend is a ChemDraft-owned deterministic fixture-fragment provider.

Required labeling:

- ¹³C is enabled by default;
- ¹H is disabled by default or visibly marked experimental;
- fixture values are identified as synthetic architecture-test data;
- stick height is identified as predicted equivalent nuclei, not integration;
- unsupported atom environments produce warnings and omitted resonances.

Do not claim or display:

- experimental accuracy that has not been benchmarked;
- multiplicity;
- J coupling;
- line width;
- realistic multiplets;
- experimental integration;
- solvent correction;
- conformational averaging;
- calibrated confidence percentages;
- stable ChemDraft atom identity from provider atom indices.

Never fabricate a chemical shift for an unmatched environment. Do not silently substitute zero, a molecule average, or an undisclosed generic atom average.

A partially supported structure should return a partial result with warnings.

## Structure normalization rules

Use ChemDraft’s existing OpenChemLib dependency for parsing and normalization where possible.

The NMR application boundary must handle:

- SMILES;
- V2000 molfile;
- V3000 molfile.

It must reject:

- `unknown` format;
- empty structures;
- parse failures.

Preserve or warn about:

- formal charge;
- isotopes;
- radicals;
- stereochemistry.

Do not claim atom-index stability until it is demonstrated by tests across supported formats and hydrogen handling.

## Dependency rules

Do not add a new dependency without first checking whether the repository already provides the required capability.

Use exact versions for new direct dependencies unless existing repository policy requires another convention.

Before evaluating `nmr-predictor`, run and record:

```bash
pnpm view nmr-predictor version license dependencies peerDependencies optionalDependencies dist-tags --json
pnpm why openchemlib
pnpm why openchemlib-extended
```

Treat `nmr-predictor` as an optional compatibility investigation. Reject it as the planned provider if it requires:

- broad Node polyfills;
- replacement of ChemDraft’s current OpenChemLib version;
- unsafe global mutation;
- remote data access;
- main-thread prediction;
- weakened bundler checks;
- undocumented database redistribution.

A failed compatibility investigation is a valid result. Record the exact reason and retain the fixture-backed provider.

Code licensing and data licensing are separate. Do not assume an MIT package license covers an included or downloaded NMR database.

## Coding practices

Follow existing repository formatting, linting, naming, test, and module conventions.

Prefer focused modules over adding more unrelated logic to `MainWindow.tsx`.

Avoid speculative abstraction. Generalize an existing pattern only when at least two real consumers benefit without losing clarity.

Do not create empty implementation files or placeholder interfaces solely to match a future directory diagram.

Use stable error and warning codes. Keep human-readable messages separate from programmatic codes.

Keep worker messages and stored analysis payloads serializable.

Avoid `any`. When an external package lacks adequate types, contain the unsafe boundary in its adapter and normalize immediately.

Do not edit generated artifacts, lockfiles, or snapshots unless the change requires it. Do not overwrite unrelated user work.

Do not commit, push, rewrite history, or open a pull request unless explicitly requested.

## Testing requirements

Add tests with the implementation, not afterward.

At minimum, run the most targeted tests after each meaningful change. Before reporting completion, run as much of the following as the environment supports:

```bash
pnpm lint
pnpm test
pnpm build
```

Also run package-specific and desktop-specific tests relevant to modified files.

When a command cannot run because the environment lacks Rust, Tauri, a browser runtime, or another local toolchain, report that clearly. Do not state that a build passed when it was not run.

Key properties to test include:

- persistent host identity across document changes;
- canary plugin registration;
- menu and panel contribution rendering;
- permission enforcement;
- immutable selection snapshots;
- deterministic fingerprints;
- deep-copy analysis storage;
- deterministic latest-record selection;
- no document mutation from NMR prediction;
- fixture prediction determinism;
- partial-result warnings;
- no-network operation;
- worker cancellation and late-result suppression;
- reversed NMR axes;
- stale-result detection.

## Handling discrepancies

The plan contains repository-state assumptions. Verify them.

When an assumption is wrong:

1. identify the exact discrepancy;
2. cite the relevant file and symbol in the implementation report;
3. adapt the implementation while preserving the intended boundary;
4. do not silently reshape the task;
5. do not stop merely because the repository differs from the plan.

Prefer working code and tests over preserving an illustrative filename or pseudocode signature verbatim.

## Completion reporting

Every implementation response must include:

- milestone completed;
- files changed;
- architecture decisions made;
- deviations from `PLANS.md` and why;
- dependencies added or removed, with exact versions;
- tests and builds actually run;
- commands that failed and the relevant failure summary;
- unresolved risks;
- the next milestone, without implementing it unless requested.

For NMR work, also report:

- active predictor ID and version;
- data version and provenance;
- whether values are synthetic fixtures;
- supported nuclei;
- unsupported chemistry;
- whether `nmr-predictor` was evaluated;
- any duplicate-OpenChemLib or bundling issue.

Do not claim scientific validation, full plugin sandboxing, dynamic plugin installation, or production readiness unless those claims are supported by completed tests and documented evidence.

Structure the final report so it can be archived verbatim: the operator files it under `reports/` in the planning workspace and updates `STATUS.md` (milestone table, assumption ledger, open decisions) from it. Include an explicit "assumption discrepancies" section, even when it is empty.
