# ChemDraft NMR Predictor Plugin Plan

## Recommendation

Build Phase 1 as a bundled **analyzer plugin** with a replaceable `NmrPredictor` provider running in a Web Worker.

The primary Phase 1 predictor should be a small, deterministic **fixture-backed HOSE/fragment provider** owned by ChemDraft. Its purpose is to prove the complete plugin path—selection, command invocation, worker execution, analysis storage, menu contribution, panel rendering, and stale-result handling—without making the plugin runtime dependent on an old chemistry package or an uncertain external database.

In parallel, evaluate two production-oriented local predictors behind exactly the same `NmrPredictor` interface:

1. an OpenChemLib-native HOSE/fragment implementation using the OCL dependency ChemDraft already ships;
2. a time-limited compatibility evaluation of Cheminfo’s `nmr-predictor`.

Do not make `nmr-predictor` a requirement for completing Phase 1. It depends on the archived `openchemlib-extended` ecosystem and may introduce a second, incompatible OpenChemLib version, older bundling assumptions, Node-polyfill requirements, or unsafe global behavior. The plugin architecture should be considered successful even when only the ChemDraft-owned fixture provider is enabled.

Before the NMR plugin itself is integrated, bring the live plugin runtime into the desktop using the existing `molscribe-ocsr` example as the first canary plugin. ChemDraft currently has plugin schemas and a host package, but it does not yet have a functioning desktop plugin runtime: the application does not instantiate `PluginHost`, existing example plugins are not mounted, no manifest-driven Analyze menu exists, no contributed panel host exists, and no loaded-plugin UI exists. This is a larger runtime milestone than the earlier recommendation implied. Claude’s notes correctly identify that the runtime should be proven independently from NMR chemistry and legacy dependency issues.

The initial NMR feature should produce:

- predicted ¹³C chemical shifts;
- optional, explicitly experimental ¹H chemical shifts;
- equivalent-atom grouping;
- source atom-index assignments where the provider can preserve them;
- fragment-support information;
- uncertainty or dispersion information where supported;
- a reversed-axis stick spectrum;
- a prediction table;
- warnings for unsupported or weakly supported environments;
- analysis provenance;
- stale-result detection when the selected structure changes.

It should not claim:

- multiplicity;
- coupling constants;
- line shapes;
- experimental integrations;
- solvent correction;
- conformational averaging;
- calibrated confidence percentages;
- experimentally validated accuracy;
- persistent ChemDraft atom identity across arbitrary structure formats.

The revised development sequence is:

```text
Plugin runtime brought into the desktop
  ↓
Existing molscribe-ocsr plugin used as runtime canary
  ↓
Generic selection and analysis APIs
  ↓
ChemDraft-owned fixture NMR predictor
  ↓
NMR command, worker, panel, table, and stick spectrum
  ↓
OCL-native HOSE evaluation
  ↓
Optional nmr-predictor compatibility evaluation
  ↓
A licensed and scientifically useful prediction database
```

This prevents three independent problems from becoming entangled:

```text
desktop plugin-runtime bring-up
legacy JavaScript package compatibility
NMR prediction-data provenance
```

## Repository verification (2026-07-07)

This plan was audited against the live repository at commit `64cf513e`
("Add plugin toolset contributions, selection.read, storage, and panel APIs").
The full assumption-by-assumption ledger lives in the planning workspace
(`STATUS.md`). The corrections that change this plan's guidance:

1. **A selection API already exists.** `PluginSelectionAPI.getSelection()`
   returns `{ objectIds, molecules: [{ objectId, structureFormat, structure }] }`
   and is exposed as a permission-gated **optional** context property
   (`selection?`), with tested behavior. Milestone 4 is therefore an
   *extension* (fingerprint, immutability, document/page identity), not a
   creation. See "Reconciliation with the existing selection API" below.
2. **Panels are declarative data, not React components.** The plugin API
   defines `PluginPanelReport` (text / keyValue / table / svg sections; svg is
   a string ≤ 512 KB rendered in an `<img>` context so scripts can never
   execute), and the host already validates and routes reports through
   `PluginHostOptions.showPanelReport`. The desktop never supplies that
   renderer — the missing piece is a desktop **report renderer surface**, not
   a React panel registry. The panel sections of this plan are written
   against the declarative model.
3. **An Analyze menu already exists** (`apps/desktop/src/appMenu.ts:241`) with
   one core item. The web menu bar mirrors the native Tauri menu one-for-one,
   enforced by a drift test that reads `MENU_COMMAND_IDS` out of
   `src-tauri/src/lib.rs`. Plugin menu items must use the existing exclusion
   pattern (`nativePredefined` precedent) or extend the native menu the way
   dynamic toolset menus already do.
4. **ID naming is a convention the desktop keys on.** Commands are
   `plugin.<pluginName>.<action>` (toolset code distinguishes plugin vs core
   by that prefix; toolset ids are regex-enforced to start with `plugin.`);
   menus/panels/recognizers follow `menu.*` / `panel.*` / `recognizer.*`
   namespacing per the molscribe example. All NMR ids in this plan follow
   that convention.
5. **The manifest example convention is `apiVersion: "^0.1.0"`** (caret, per
   molscribe-ocsr), and the contributions object has twelve keys, all
   defaulting to empty arrays.
6. **The host is further along than assumed**: injectable clock,
   `unregisterPlugin`, `validateTrustedPluginManifest`, proposed-patch queue,
   and injectable storage backends all exist. Still genuinely missing:
   analysis store, general subscriptions, contribution enumeration helpers,
   desktop lifecycle integration, a desktop report renderer, and any
   loaded-plugin UI.
7. **A selection-architecture refactor is pending** in the repo
   (`PLANS-selection-policy.md`, planning-only). The plugin selection
   provider must remain a thin adapter over current selection state so that
   refactor can land without breaking plugins.

## Revised headline architecture

The target architecture remains:

```text
ChemDraft desktop
  ↓
Persistent PluginHost
  ↓
Manifest contributions:
  commands
  Analyze-menu items
  panels
  analyzers
  ↓
Generic PluginSelectionAPI
Generic PluginAnalysisAPI
  ↓
NMR plugin application service
  ↓
NmrPredictor interface
  ↓
Worker client
  ↓
One of:
  FixtureHosePredictor
  OclHosePredictor
  CheminfoHosePredictor
  future GNN provider
  future DFT provider
```

There should be no direct dependency from:

```text
ChemDraft desktop → nmr-predictor
ChemDraft plugin host → NMR types
desktop report renderer → Cheminfo result types
ChemDraft document model → prediction-result schema
```

The first runtime milestone should instead look like:

```text
ChemDraft desktop
  ↓
Persistent PluginHost
  ↓
Bundled molscribe-ocsr registration
  ↓
Manifest-derived Analyze item
  ↓
Trivial contributed panel
  ↓
Command invocation through host
```

Only after that works should the NMR package be registered as another bundled plugin.

## What the ChemDraft repository currently supports

ChemDraft already defines many of the right declarative plugin concepts:

- commands;
- Analyze-menu contribution locations;
- panels;
- analyzers;
- permissions including `selection.read`;
- permissions including `analysis.write`;
- UI permissions;
- plugin storage;
- an API version field;
- a `PluginHost` package;
- an example `molscribe-ocsr` plugin.

Those declarations are foundations, not a functioning desktop plugin runtime.

The current `PluginCommandContext` exposes plugin identity, document access, permission helpers, proposed document operations, optional storage, an optional permission-gated `selection` API (`getSelection()` returning object IDs plus molecule snapshots), and an optional permission-gated `panels` API (`showReport(panelId, report)` with schema-validated declarative sections). It does not expose a generic derived-analysis API, and the selection snapshot carries no source fingerprint, no document/page identity, and no immutability guarantee (the host returns the provider's object as-is).

The plugin host currently lacks:

- an analysis-result store (the `analysis.write` permission exists but grants nothing);
- analysis subscriptions and any general `subscribe` beyond the `onProposedPatchesChanged` callback;
- contribution enumeration suitable for rendering UI (only `listPlugins()` returning manifests);
- desktop lifecycle integration;
- a desktop-side panel-report renderer (the host-side `showPanelReport` option exists but the desktop never supplies it);
- loaded-plugin display state.

The plugin host already has: registration with duplicate rejection, contribution-permission validation, permission-gated command-context construction, `invokeCommand` with per-command permission checks, `unregisterPlugin`, a proposed-patch queue with accept/reject, injectable storage backends, `validateTrustedPluginManifest`, and an injectable clock (`now`).

The desktop does not currently instantiate `PluginHost`. It constructs and uses `CommandRegistry` directly.

The existing `molscribe-ocsr` plugin is a package and test fixture, not a plugin that is mounted in the live desktop. Its manifest contributions demonstrate the intended schema, but they do not currently result in a visible menu item, panel, or running command.

There is currently no manifest-driven Analyze menu, but an Analyze menu section already exists. The web menu bar is generated from the declarative model in `apps/desktop/src/appMenu.ts` (whose Analyze section holds one core item, `chemistry.validateSelection`), and the Tauri build renders the equivalent native menu from `src-tauri/src/lib.rs`. A drift test (`appMenu.test.ts`) asserts the two stay in sync one-for-one, with an existing exclusion mechanism (`nativePredefined`) for items that intentionally differ. Adding plugin Analyze contributions therefore means extending the existing `appMenu.ts` model with plugin-contributed items and handling the native-menu sync deliberately — not inventing a separate menu surface.

That work should be treated as a first-class application feature, not a minor helper.

There is also no loaded-plugin UI. Any acceptance criterion asserting that the NMR plugin “appears in the loaded-plugin UI” requires creating that UI first.

`MainWindow.tsx` is already very large. It creates the `CommandRegistry` through a memo whose dependencies include the current document, so document changes recreate the registry. Ref-based state access is already used elsewhere in the application, including the command-invocation path, so a persistent host supplied by refs is consistent with existing application style.

ChemDraft also already has a Web Worker request/client pattern for conformer work. The NMR worker should follow that pattern rather than introducing a second unrelated worker abstraction.

The document schema recognizes:

```text
molfile-v3000
molfile-v2000
smiles
unknown
```

The NMR provider contract should not accept `unknown`. A snapshot may report `unknown`, but request construction must reject it with `NMR_UNSUPPORTED_STRUCTURE_FORMAT`.

ChemDraft already ships OpenChemLib and already performs operations such as:

```ts
OCL.Molecule.fromSmiles(smiles).toMolfile();
```

That existing dependency materially changes the provider ranking. An OCL-native fragment predictor is not starting from zero: parsing, connection-table construction, SMILES conversion, molecule traversal, and worker bundling already have an established dependency path.

The `apiVersion` field should be treated carefully. The current manifest schema accepts a nonempty string; it does not enforce semantic compatibility (verified: `PluginManifestSchema` only requires a nonempty string, while the host exports `PluginApiVersion = "0.1.0"`). Use `"^0.1.0"` for this plugin, matching the existing `molscribe-ocsr` manifest convention, but do not claim that the host has verified API compatibility unless compatibility validation is separately implemented.

## Runtime milestone before NMR

The first live-plugin milestone should use `molscribe-ocsr`, because it separates application runtime work from NMR chemistry.

The runtime milestone should prove:

1. A persistent `PluginHost` is created by the desktop.
2. A bundled plugin can be registered.
3. Its manifest can be enumerated.
4. Its command can be invoked.
5. Its Analyze-menu contribution appears.
6. Its contributed panel can open.
7. Its plugin identity appears in a simple plugin list or diagnostic view.
8. Permission checks continue to apply.
9. The plugin host survives document edits without being recreated.
10. Existing core command behavior continues to work.

For the canary, the panel can initially show:

```text
Plugin name
Plugin version
Command state
Selected capability or placeholder status
```

The canary is not intended to complete the OCR workflow. It is intended to prove the runtime mechanics with an already existing plugin package.

Do not simultaneously:

- refactor every core command;
- integrate a legacy NMR dependency;
- add a prediction database;
- build the NMR panel;
- debug worker bundling;
- create plugin menu rendering.

Those should be staged.

The eventual architecture should have one coherent command-dispatch system, but the first runtime patch does not need to migrate every core command through `PluginHost` if doing so produces a large unrelated application refactor. A safer sequence is:

```text
Stage 1:
Persistent PluginHost owns plugin commands.
Existing core CommandRegistry remains operational.

Stage 2:
PluginHost is constructed with or delegates to the existing registry.

Stage 3:
Core and plugin command registration use one shared registry abstraction.

Stage 4:
Remove redundant command plumbing after behavior is covered by tests.
```

This preserves the original recommendation’s target—a single coherent command registry—without making full command migration a prerequisite for showing the first plugin panel.

## Phase 1 dependency options

| Option | Revised role | Advantages | Problems |
|---|---:|---|---|
| ChemDraft-owned `FixtureHosePredictor` | Required Phase 1 provider | Deterministic, testable, no network, no licensing ambiguity, proves complete architecture | Narrow chemical coverage; not a production predictor |
| OCL-native HOSE/fragment predictor | Preferred production-oriented investigation | Reuses ChemDraft’s existing OCL dependency and worker compatibility; avoids duplicate OCL runtimes; ChemDraft owns result schema and lookup behavior | Requires implementation of environment generation and acquisition of a licensed fragment database |
| `nmr-predictor` | Time-limited compatibility evaluation | Existing JavaScript predictor interface, molfile support, ¹H/¹³C fragment prediction | Old package ecosystem, archived transitive dependency, potential duplicate OCL versions, bundling/polyfill risk, database redistribution uncertainty |
| Direct `openchemlib-extended` integration | Generally avoid as a new architectural dependency | Existing diastereotopic and HOSE utilities | Repository archived; can conflict with ChemDraft’s current OCL version; exposes legacy types and assumptions |
| `nmrgnn` | Future optional provider | Pretrained atom-level model; replaces some manual fragment rules | Python, model files, coordinate workflow, heavier process boundary, solvent/reference limitations |
| CASCADE-style 3D model | Future research provider | Can include stereochemical and conformational information | Conformer generation, model packaging, older research dependencies, deployment complexity |
| NMRNet-like model | Future research provider | Learned representation and possible multitask extension | Substantially heavier than Phase 1; model and runtime packaging |
| DFT/GIAO with empirical scaling | Future high-accuracy provider | Physically grounded and useful for stereochemical discrimination | Computationally expensive; requires conformer generation and external quantum chemistry |
| Remote prediction service | Future optional integration | Central model updates and no local model bundle | Network permission, privacy, availability, reproducibility, operating cost, server versioning |
| Simple hand-authored substituent increments | Possible interim educational provider | Very small implementation, explainable, no model dependency | Limited scope, difficult to scale, poor treatment of nonadditive environments |
| Database nearest-neighbor by molecular fingerprints | Possible intermediate provider | Simpler than GNN; can report analogs and distances | Requires a suitable licensed shift-assigned database and reliable atom mapping |

The dependency table should now be interpreted as follows:

```text
Architecture success:
FixtureHosePredictor works end-to-end.

Scientific Phase 1.5:
OCL-native predictor or a compatible third-party predictor replaces fixtures.

Optional compatibility result:
nmr-predictor either works behind the adapter or is rejected with documented reasons.
```

Do not define Phase 1 completion as “`nmr-predictor` successfully bundles.”

## Recommended predictor sequence

### Predictor A: fixture-backed provider

Implement this first.

Its database should contain a small number of explicitly documented structures and environments. Suitable test fixtures could include:

- benzene;
- toluene;
- acetone;
- ethanol;
- ethyl acetate;
- acetonitrile;
- cyclohexane;
- anisole;
- a simple para-disubstituted benzene;
- one deliberately partially unsupported molecule.

The fixture provider should not merely map a complete SMILES string to a canned spectrum. That would test UI plumbing but not atom-level normalization.

It should preferably operate on a small internal representation such as:

```ts
interface FixtureAtomEnvironment {
  nucleus: "1H" | "13C";
  atomicNumber: number;
  aromatic: boolean;
  hybridization?: string;
  neighborSignature: string;
  predictedShiftPpm: number;
  equivalentNuclei?: number;
  sampleCount?: number;
  standardDeviationPpm?: number;
}
```

A minimal environment key can initially be generated from:

```text
central atom element
aromaticity
formal charge
bond orders to first-shell neighbors
neighbor elements
optional second-shell signature
```

This does not need to be presented as a validated HOSE implementation. It can be labeled:

```text
fixture-fragment
```

The fixture provider should deliberately produce:

- complete results for several test molecules;
- partial results for one molecule;
- no-match warnings for unsupported environments;
- equivalent groups;
- deterministic uncertainty metadata;
- deterministic provenance.

Synthetic values must be labeled as fixtures and must not be described as experimental reference data.

### Predictor B: OCL-native HOSE provider

Evaluate this as the preferred local evolution path.

The provider would use the OpenChemLib molecule already available in ChemDraft’s dependency graph to:

1. parse SMILES, V2000 molfile, or V3000 molfile;
2. normalize the molecule;
3. determine atom elements and bond topology;
4. determine aromaticity;
5. determine attached or implicit hydrogen counts;
6. derive atom-centered environment codes;
7. search a local fragment table from largest sphere to smallest;
8. aggregate matching reference shifts;
9. report median or mean;
10. report sample count and dispersion;
11. group equivalent or diastereotopic atoms where supported.

The exact environment-code format can be:

- a formal HOSE code;
- a stable ChemDraft-specific layered graph signature;
- an OCL-provided atom-environment representation.

Do not name a ChemDraft-specific graph signature “HOSE” unless it follows the HOSE definition closely enough to justify that name.

Advantages specific to ChemDraft include:

- one OCL version rather than two;
- known Vite/Tauri bundling behavior;
- reuse of existing molecule parsing;
- reuse of worker deployment patterns;
- control over atom-index mapping;
- no leakage of legacy package types;
- simpler dependency auditing.

The hard problem remains the fragment database. The provider implementation and the prediction data must be treated as separate assets with separate provenance and licenses.

### Predictor C: `nmr-predictor` compatibility evaluation

Treat this as a bounded investigation.

Before installation:

```bash
pnpm view nmr-predictor version license dependencies peerDependencies optionalDependencies dist-tags --json
pnpm why openchemlib
pnpm why openchemlib-extended
```

After adding it to an isolated branch or package:

```bash
pnpm install
pnpm lint
pnpm test
pnpm build
```

Inspect the resulting bundle for:

- multiple OpenChemLib versions;
- Node built-in imports;
- `process` assumptions;
- `Buffer` assumptions;
- global mutation;
- dynamic `require`;
- network calls;
- worker incompatibility;
- excessive bundle size;
- unsupported module formats.

The compatibility evaluation should have explicit termination criteria. Stop using the package as the planned provider when it requires any of the following:

- broad Node-polyfill installation in the desktop;
- changes to global browser objects;
- disabling standard bundler checks;
- patching ChemDraft’s primary OpenChemLib version;
- loading remote data;
- vendoring a database with undocumented redistribution terms;
- exposing legacy package result types beyond the adapter;
- running predictor code on the main UI thread.

A failed compatibility evaluation is a valid result. The fixture provider and generic architecture remain intact.

## Prediction-data provenance

Code licensing and data licensing must be tracked separately.

For every prediction table or fragment database, document:

```text
asset name
asset version
source
original authors
license
redistribution terms
modifications
number of entries
nuclei covered
solvent/reference conventions
generation date
validation status
```

Do not infer that a package’s MIT license covers:

- NMRShiftDB-derived records;
- compiled shift databases;
- a package author’s in-house proton data;
- files downloaded from a remote endpoint;
- generated derivative databases.

For the architecture test, use ChemDraft-owned synthetic fixtures.

For a scientifically useful release, viable data paths include:

- a database with clear redistribution terms;
- a user-supplied local database;
- a build step that downloads data directly from an authorized upstream source;
- a database generated from openly licensed records;
- an optional provider distributed separately from ChemDraft core.

The plugin should retain a `dataVersion` distinct from the predictor code version:

```ts
interface NmrPredictionBackend {
  id: string;
  version: string;
  dataVersion?: string;
  method: string;
}
```

That is important because the same algorithm can produce different results after a data update.

## Ownership and compartmentalization

Use five ownership layers.

### ChemDraft plugin API owns generic host contracts

`packages/plugin-api` should own only concepts that can apply to any analyzer:

- selected-structure snapshots;
- generic analysis sources;
- generic analysis records;
- analysis provenance;
- analysis warnings;
- analysis queries;
- permission-controlled access.

It must not contain:

- NMR nuclei;
- chemical shifts;
- spectrum peaks;
- coupling constants;
- solvent fields;
- HOSE codes;
- conformer ensembles.

### ChemDraft plugin host owns enforcement and generic runtime state

`packages/plugin-host` should own:

- plugin registration;
- permission enforcement;
- command-context construction;
- selected-structure snapshot retrieval;
- analysis-record storage;
- plugin and analysis subscriptions;
- contribution enumeration;
- host-generated IDs and timestamps;
- plugin identity stamping.

It should not interpret NMR payloads.

### ChemDraft desktop owns React rendering and application integration

`apps/desktop` should own:

- persistent host lifecycle;
- bundled-plugin registration;
- menu-model integration;
- the panel-report renderer and panel surface (chrome, open/close state);
- loaded-plugin diagnostics;
- selection-provider access to current desktop state;
- bridging host contributions into existing application UI.

React types must not enter `plugin-api` or `plugin-host`.

### The NMR plugin owns spectroscopy concepts

The NMR plugin should own:

- predictor requests;
- predictor responses;
- nuclei;
- shifts;
- assignments;
- equivalent groups;
- uncertainty;
- scientific warnings;
- result normalization;
- stick-spectrum generation;
- future matching and ranking contracts.

### Provider adapters own dependency-specific behavior

Only a provider adapter should know:

- OpenChemLib-specific molecule methods;
- `nmr-predictor` function names;
- Cheminfo database formats;
- dependency-specific atom identifiers;
- dependency-specific errors;
- dependency-specific HOSE sphere conventions.

This permits later replacement by:

- OCL-native fragment search;
- a WebAssembly predictor;
- a local Python sidecar;
- a remote predictor;
- a conformer-aware GNN;
- a DFT service.

## Generic host API additions

### Reconciliation with the existing selection API

The repository already defines (verified at `packages/plugin-api/src/index.ts:386-399`):

```ts
export interface PluginSelectedMolecule {
  objectId: string;
  structureFormat: string;
  structure: string;
}

export interface PluginSelectionSnapshot {
  objectIds: readonly string[];
  molecules: readonly PluginSelectedMolecule[];
}

export interface PluginSelectionAPI {
  getSelection(): Promise<PluginSelectionSnapshot>;
}
```

Do not introduce a parallel `PluginSelectedStructure` / `getSelectedStructures()`
contract. Milestone 4 **extends the existing types in place**:

```ts
export const PluginStructureFormatSchema = z.enum([
  "smiles",
  "molfile-v2000",
  "molfile-v3000",
  "unknown",
]);

export type PluginStructureFormat = z.infer<
  typeof PluginStructureFormatSchema
>;

export interface PluginSelectedMolecule {
  objectId: string;

  /** Narrowed from string to the document-model enum. */
  structureFormat: PluginStructureFormat;

  structure: string;

  /** Added where the document model provides them. */
  documentId?: string;
  pageId?: string;

  /**
   * Detects changes to the source payload.
   * It is not a canonical molecular identifier.
   */
  sourceFingerprint: string;
}
```

Milestone 4 must also fix two verified gaps in the current implementation:

1. the host returns the provider's snapshot object as-is — it must deep-copy
   or deep-freeze before handing it to a plugin;
2. the desktop never constructs a host, so no real selection provider exists —
   the desktop provider is written against the *current* selection state in
   `MainWindow.tsx` but kept a thin adapter, because a selection-architecture
   refactor is pending (`PLANS-selection-policy.md`).

Add the generic analysis types to `packages/plugin-api/src/index.ts`, or split
the file into focused modules if repository conventions permit.

The selected-structure API is intentionally generic. Future plugins may use it for:

- property prediction;
- naming;
- format export;
- similarity search;
- conformer generation;
- reaction analysis;
- safety annotation.

Add generic analysis types:

```ts
export interface PluginAnalysisSource {
  documentId: string;
  pageId: string;
  objectId: string;
  sourceFingerprint: string;
}

export interface PluginAnalysisProvenance {
  engineId: string;
  engineVersion?: string;
  dataVersion?: string;
  method: string;
}

export interface PluginAnalysisWarning {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  details?: Readonly<Record<string, unknown>>;
}

export interface PluginAnalysisRecordInput<
  TPayload = unknown,
> {
  analysisType: string;
  schemaVersion: string;
  source: PluginAnalysisSource;
  status: "complete" | "partial" | "failed";
  payload: TPayload;
  warnings?: readonly PluginAnalysisWarning[];
  provenance: PluginAnalysisProvenance;
}

export interface PluginAnalysisRecord<
  TPayload = unknown,
> extends PluginAnalysisRecordInput<TPayload> {
  id: string;
  pluginId: string;
  createdAt: string;
}

export interface PluginAnalysisQuery {
  pluginId?: string;
  analysisType?: string;
  documentId?: string;
  pageId?: string;
  objectId?: string;
}

export interface PluginAnalysisAPI {
  write<TPayload>(
    input: PluginAnalysisRecordInput<TPayload>,
  ): Promise<PluginAnalysisRecord<TPayload>>;

  list<TPayload = unknown>(
    query?: PluginAnalysisQuery,
  ): Promise<readonly PluginAnalysisRecord<TPayload>[]>;

  getLatest<TPayload = unknown>(
    query: PluginAnalysisQuery,
  ): Promise<
    PluginAnalysisRecord<TPayload> | undefined
  >;
}
```

Update the command context:

```ts
export interface PluginCommandContext {
  plugin: PluginRuntimeIdentity;
  documents: PluginDocumentAPI;
  storage?: PluginStorage;
  /** Present only when the plugin declares "selection.read". */
  selection?: PluginSelectionAPI;
  /** Present only when the plugin declares "ui.panel" and the host renders panels. */
  panels?: PluginPanelAPI;
  /** Present only when the plugin declares "analysis.write". */
  analysis?: PluginAnalysisAPI;

  hasPermission(permission: PluginPermission): boolean;
  requirePermission(permission: PluginPermission): void;
}
```

**Decision (ADR-0008):** an earlier draft of this plan argued that `selection`
and `analysis` should always exist and throw `PluginPermissionError` when the
permission is absent. The repository's shipped, tested convention is the
opposite: permission-gated **optional** properties (`storage?`, `selection?`,
`panels?`), with `selectionStorage.test.ts` asserting that a denied plugin
sees `undefined`. Phase 1 follows the existing convention — `analysis?` is
optional and present only with `analysis.write` — because consistency with a
tested contract beats stylistic preference, and because AGENTS.md makes the
repository authoritative on conflicts. Methods on a *present* API still
re-check permissions and throw `PluginPermissionError`, exactly as the
existing selection implementation does. Converting the whole context to
always-present throwing APIs remains a valid future breaking change, but it
must be its own deliberate task across all APIs at once, not a side effect of
the NMR milestones.

## Selected-structure snapshot behavior

The host should create immutable snapshots.

The snapshot procedure should:

1. Locate the active document.
2. Locate the active page.
3. Read selected object IDs.
4. Keep only molecule objects.
5. Copy the structure format.
6. Copy the structure payload.
7. Copy document, page, and object IDs.
8. Compute a deterministic source fingerprint.
9. Deep-freeze or deep-copy the returned values.

The initial fingerprint may be based on:

```text
documentId
pageId
objectId
structureFormat
trimmed structure payload
```

For example:

```ts
function createStructureSourceFingerprint(
  input: {
    documentId: string;
    pageId: string;
    objectId: string;
    structureFormat: string;
    structure: string;
  },
): string {
  return stableHash([
    input.documentId,
    input.pageId,
    input.objectId,
    input.structureFormat,
    input.structure.trim(),
  ].join("\u001f"));
}
```

This fingerprint is for invalidation, not chemical identity.

`stableHash` specification: use FNV-1a (64-bit, implemented on `BigInt` or as
two 32-bit lanes) over the UTF-8 bytes of the joined string, rendered as a
fixed-width lowercase hex string. It must be synchronous (no
`crypto.subtle`, which is async and unavailable in some worker/webview
contexts), dependency-free, deterministic across platforms, and documented as
**not cryptographic** — it is a change detector, and collisions merely cause
a stale-check false negative on adversarial input, which is not a Phase 1
threat.

A structure redraw, molfile reserialization, or atom-order change may mark an equivalent molecule stale. That is acceptable initially because false invalidation is safer than silently associating a result with a chemically changed source.

Later, the fingerprint may include:

- canonical isomeric SMILES;
- formal charges;
- isotope labels;
- explicit stereochemistry;
- an atom-order mapping;
- a structure serialization version.

Do not change the first implementation into a canonicalization project.

## Structure normalization before prediction

The snapshot API should preserve the original ChemDraft structure format. The NMR plugin should own conversion to its predictor’s input.

Use a separate normalization boundary:

```ts
export interface NormalizedMolecule {
  sourceFormat:
    | "smiles"
    | "molfile-v2000"
    | "molfile-v3000";

  canonicalSmiles?: string;
  molfileV3000?: string;

  /**
   * Atom indices used by the active provider.
   */
  providerAtomCount: number;

  /**
   * Optional source-to-provider atom index mapping.
   */
  atomIndexMap?: readonly {
    sourceAtomIndex: number;
    providerAtomIndex: number;
  }[];

  warnings: readonly NmrPredictionWarning[];
}
```

The normalization pipeline should be:

```text
PluginSelectedStructure
  ↓
reject unknown or empty payload
  ↓
parse with the existing OCL dependency
  ↓
normalize connection table
  ↓
retain formal charges, isotope labels, and stereochemistry when parseable
  ↓
determine explicit and implicit hydrogens
  ↓
produce provider molecule and index mapping
```

Format-specific behavior:

### SMILES

```text
SMILES
  ↓
OCL.Molecule.fromSmiles
  ↓
OCL molecule
  ↓
provider environment generation
```

Do not require a molfile conversion merely because an old predictor accepts molfile. The normalized OCL molecule should be the primary internal object for an OCL-native provider.

For `nmr-predictor`, conversion may be:

```text
SMILES
  ↓
OCL molecule
  ↓
molfile accepted by nmr-predictor
```

### Molfile V2000

Parse it with the same OCL version used elsewhere in ChemDraft. Preserve source atom ordering where feasible.

### Molfile V3000

Parse it directly when supported. Do not down-convert to V2000 when the structure exceeds V2000 limits or contains information that would be lost.

### Unknown

Hard-fail before worker prediction:

```text
NMR_UNSUPPORTED_STRUCTURE_FORMAT
```

The domain request type should not include `"unknown"`:

```ts
export interface ChemicalStructureInput {
  format:
    | "smiles"
    | "molfile-v2000"
    | "molfile-v3000";

  value: string;
}
```

The application mapper converts a generic plugin snapshot into this narrower type.

## Hydrogen treatment

¹H prediction needs explicit policy.

The provider must distinguish:

- explicit hydrogen atoms;
- implicit hydrogens attached to carbon;
- exchangeable heteroatom hydrogens;
- isotope-labeled hydrogens;
- hydrogens on charged atoms;
- stereotopic hydrogens when the provider can resolve them.

The Phase 1 options may be:

```ts
export interface NmrPredictionOptions {
  statistic: "median" | "mean";
  hoseLevels: readonly number[];
  ignoreLabileHydrogens: boolean;
}
```

The UI should default `ignoreLabileHydrogens` to `true` for the initial ¹H predictor unless the provider has defensible exchangeable-proton data.

When omitted, return:

```text
NMR_LABILE_PROTON_OMITTED
```

Do not create a zero-valued or placeholder resonance.

## Atom identity and assignments

Phase 1 may expose provider atom indices in the table, but it must not imply that they are stable ChemDraft atom IDs.

Use:

```ts
export interface NmrAtomReference {
  /**
   * Index in the normalized structure supplied to
   * the provider.
   */
  sourceAtomIndex: number;

  element: string;
  equivalentCount?: number;

  /**
   * Dependency-specific identity for diagnostics.
   */
  backendAtomId?: string;

  /**
   * Reserved for a later verified ChemDraft
   * atom-identity contract.
   */
  chemDraftAtomId?: string;
}
```

The normalization layer may produce an atom-index map, but viewport highlighting should remain deferred until tests establish that:

- atom order survives SMILES parsing;
- molfile atom order is preserved;
- hydrogen expansion is deterministic;
- equivalent-group behavior is understood;
- stereochemical normalization does not reorder atoms unexpectedly.

## Generic analysis storage

Add an `AnalysisStore` to `plugin-host`.

```ts
class AnalysisStore {
  write<T>(
    pluginId: string,
    input: PluginAnalysisRecordInput<T>,
  ): PluginAnalysisRecord<T>;

  list<T>(
    query?: PluginAnalysisQuery,
  ): readonly PluginAnalysisRecord<T>[];

  getLatest<T>(
    query: PluginAnalysisQuery,
  ): PluginAnalysisRecord<T> | undefined;

  subscribe(listener: () => void): () => void;
}
```

Required behavior:

- host generates record ID via an injectable ID factory (default
  `crypto.randomUUID`, injectable for deterministic tests, mirroring the
  existing injectable `now` clock);
- host stamps plugin ID;
- host stamps time using the injectable clock;
- the store is in-memory, session-scoped, and unbounded in Phase 1 — do not
  invent an eviction policy; records die with the session;
- input is deep-copied;
- returned records are copied or immutable;
- query fields are optional and conjunctive;
- records are returned in deterministic order;
- `getLatest` uses `createdAt`, with deterministic tie-breaking;
- analysis writes notify subscribers;
- writes require `analysis.write`;
- reads may initially be permitted to the creating plugin only, or governed by a future `analysis.read` permission.

Because the current permission list apparently includes `analysis.write` but may not include a separate `analysis.read`, define the initial read policy explicitly. A practical Phase 1 policy is:

```text
A plugin may read analysis records written under its own plugin ID.
The desktop may read all analysis records for rendering.
Cross-plugin analysis reading is not exposed yet.
```

Do not silently let every plugin inspect every other plugin’s derived data unless that is an intentional host policy.

Analysis results remain session-derived state. They should not enter the native document in Phase 1.

Therefore, the NMR plugin does not require:

```text
document.read
document.write
document.proposePatch
```

## Contribution enumeration

Add host-level enumeration methods:

```ts
interface RegisteredContribution<T> {
  pluginId: string;
  contribution: T;
}

listCommandContributions():
  readonly RegisteredContribution<
    PluginCommandContribution
  >[];

listMenuContributions(
  location?: PluginMenuContribution["location"],
):
  readonly RegisteredContribution<
    PluginMenuContribution
  >[];

listPanelContributions():
  readonly RegisteredContribution<
    PluginPanelContribution
  >[];

listAnalyzerContributions():
  readonly RegisteredContribution<
    PluginAnalyzerContribution
  >[];

listRegisteredPlugins():
  readonly PluginRuntimeIdentity[];

subscribe(listener: () => void): () => void;
```

Enumeration should include only:

- successfully registered plugins;
- manifest contributions that passed schema validation;
- contributions whose declared permissions are valid;
- contributions that can be associated with an existing command.

A menu contribution referencing an unknown command should produce a registration error or diagnostic rather than an inert menu entry.

Subscriptions should fire when:

- a plugin registers;
- a plugin unregisters, if supported;
- an analysis record is written;
- panel state changes, if panel state is host-owned.

Do not fire host-wide subscriptions for every unrelated document edit. The desktop already has its own document state.

## Desktop plugin runtime

Create a persistent runtime module outside `MainWindow.tsx`.

Suggested files (the desktop `src/` is mostly flat, but a subdirectory has
precedent — `surfaces/` — and MainWindow.tsx is ~23,500 lines, so new runtime
code must not be added there):

```text
apps/desktop/src/plugins/
├── createPluginRuntime.ts
├── registerBundledPlugins.ts
├── PluginReportRenderer.tsx     (renders validated PluginPanelReport sections)
├── PluginPanelSurface.tsx       (open-panel state + chrome: title, close, run again)
├── pluginMenuModel.ts           (adapts menu contributions into the appMenu model)
├── PluginDiagnosticsPanel.tsx
├── usePluginHostSnapshot.ts
└── types.ts
```

Suggested runtime structure:

```ts
export interface DesktopPluginRuntime {
  host: PluginHost;
  panelController: PluginPanelController;
}
```

The runtime supplies `showPanelReport` to the `PluginHost` constructor; the
panel controller stores the latest report per open panel and exposes
subscribe/open/close for React.

Construct it once:

```ts
const documentRef = useRef(document);
documentRef.current = document;

const selectionRef = useRef(selectionState);
selectionRef.current = selectionState;

const runtimeRef = useRef<DesktopPluginRuntime>();

if (!runtimeRef.current) {
  runtimeRef.current = createPluginRuntime({
    getActiveDocument: () => documentRef.current,
    getActiveSelection: () =>
      createSelectionSnapshot({
        document: documentRef.current,
        selection: selectionRef.current,
      }),
  });
}
```

Alternatively, use a zero-dependency `useMemo`, provided Strict Mode behavior and initialization side effects are handled safely.

Do not put the runtime creation in a memo dependent on:

- document;
- selection;
- undo history;
- active page;
- viewport;
- menu state.

The runtime reads current state through providers.

## Reuse existing command and worker patterns

The desktop already uses an invocation ref pattern. Use the same approach for plugin command invocation.

For example:

```ts
const invokePluginCommandRef = useRef(
  async (_commandId: string) => undefined,
);

invokePluginCommandRef.current = async (
  commandId: string,
) => {
  return runtime.host.invokeCommand(commandId);
};
```

The NMR worker should follow the repository’s existing conformer worker/client conventions:

```text
conformerWorker.ts
conformerClient.ts
requestId-based protocol
client factory
promise resolution
error normalization
testable worker boundary
```

Do not introduce an unrelated event-emitter or RPC package merely for NMR.

Extract a generic worker-request helper only when both conformer and NMR implementations can use it without distorting either protocol. Copying a small established pattern is preferable to prematurely creating a generalized worker framework.

## Manifest-driven menu integration

There is no current Analyze menu driven by plugin manifests, but the menu surface itself exists and is doubly rendered: `apps/desktop/src/appMenu.ts` is the declarative model for the in-viewport web menu, and `src-tauri/src/lib.rs` builds the equivalent native macOS menu. `appMenu.test.ts` fails when the two drift, with an existing per-item exclusion mechanism (`nativePredefined`) for deliberate differences.

**Resolved design (supersedes the earlier open Design A/B question):** extend the existing `appMenu.ts` model.

```text
PluginHost.listMenuContributions("analyze")
  ↓
appMenu.ts model builder appends plugin-contributed items
  ↓
web MenuBar renders them; selection dispatches through the plugin runtime
```

Requirements:

- plugin-contributed items carry a marker (for example `pluginContributed: true`) analogous to the existing `nativePredefined` flag, and the native-sync drift test excludes them from the `MENU_COMMAND_IDS` comparison;
- the native Tauri menu may adopt dynamic plugin items later using the same approach as the already-dynamic toolset menus (`create_app_menu_for_toolsets`); until then, plugin menu items may be web-menu-only, and that gap must be documented in the implementation report;
- menu selection for plugin items must dispatch through the plugin runtime (`runtime.host.invokeCommand`), not through the core command path, so permission checks apply;
- the plugin host must not import the toolset registry or the app-menu model; the desktop adapts host contributions into its own menu model.

A distinct plugin-only menu surface (the earlier Design B) is rejected: it would duplicate menu rendering, keyboard handling, and native-sync logic that already exist.

Menu selection should call:

```ts
runtime.host.invokeCommand(
  contribution.commandId,
);
```

The UI should disable or annotate commands that cannot run due to current selection state only when the host can determine that state generically. Otherwise, commands should execute and return typed errors.

## Panel reports and the desktop report renderer

**This section replaces the earlier "bundled panel registry" design.** The
repository has already made the panel architecture decision, and it is
stricter than the earlier plan draft: plugins never provide UI components.
`packages/plugin-api` defines a declarative `PluginPanelReport`:

```text
PluginPanelReport
├── title
└── sections: array of
    ├── { kind: "text",     title?, body }
    ├── { kind: "keyValue", title?, rows: [{label, value}] }
    ├── { kind: "table",    title?, columns, rows }
    └── { kind: "svg",      title?, svg (≤ 512 KB), caption? }
```

The API comment states the intent: "plugins describe results as data (never
framework components), and the host renders them with core UI. Spectra travel
as SVG strings rendered in an `<img>` context so scripts can never execute."
The host side already exists: `context.panels.showReport(panelId, report)`
validates the report against the schema, verifies the plugin declares the
panel, and forwards to `PluginHostOptions.showPanelReport`.

What the desktop must add (this is the real Milestone 2 panel work):

- supply `showPanelReport` when constructing the persistent host;
- a report renderer surface that renders validated sections with core UI
  (SVG via an `<img src="data:image/svg+xml,...">`-style sandboxed path,
  never `dangerouslySetInnerHTML`);
- open-panel state, tracked as:

```ts
interface OpenPluginPanel {
  pluginId: string;
  panelId: string;
  report: PluginPanelReport;
  openedAt: string;
}
```

- panel chrome owned by the desktop: the panel title from the manifest
  contribution, a close control, and — because the panel contribution schema
  already carries an optional `commandId` — a host-rendered "Run again"
  action that dispatches that command through `PluginHost.invokeCommand`;
- a controlled diagnostic (not a crash, not a silent no-op) when a report
  arrives for an unknown or undeclared panel ID.

Interactivity policy for Phase 1 (Decision D-03): all interactivity lives in
desktop-owned chrome (Run again, close). Plugins express state changes by
re-invoking commands and pushing a new report. If richer controls become
necessary (the ¹H toggle is the first candidate), the extension point is a
new declarative section kind — for example `{ kind: "actions", items:
[{ commandId, title }] }` validated the same way toolset items are: every
referenced command must be contributed by the same plugin. Do not reach for
plugin-provided components; that path is deliberately closed.

For Phase 1, a single open contributed panel is sufficient. Later it can
support tabs or multiple panels.

Do not place React components in the manifest.

Do not dynamically import arbitrary plugin JavaScript in this task.

## Canary registration using `molscribe-ocsr`

Add bundled registration such as:

```ts
export function registerBundledPlugins(
  runtime: DesktopPluginRuntime,
): void {
  registerMolscribeOcsrPlugin(runtime);
}
```

The first registration should:

1. register the manifest;
2. register command handlers;
3. confirm its Analyze contribution appears;
4. confirm its command can push a report to its declared panel;
5. confirm the desktop renders that report in the panel surface;
6. confirm the plugin is visible in a diagnostic plugin list.

The canary panel can initially be simple. The objective is to prove:

```text
manifest
  ↓
host
  ↓
menu
  ↓
command
  ↓
panel
```

Once this path is covered by tests, add:

```ts
registerNmrPredictorPlugin(runtime);
```

## NMR plugin package structure

```text
examples/plugins/nmr-predictor/
├── package.json
├── README.md
├── THIRD_PARTY_NOTICES.md
├── tsconfig.json
└── src
    ├── index.ts
    ├── manifest.ts
    ├── register.ts
    ├── domain
    │   ├── contracts.ts
    │   ├── schemas.ts
    │   ├── errors.ts
    │   ├── warnings.ts
    │   └── fingerprint.ts
    ├── application
    │   ├── predictSelectedStructure.ts
    │   ├── predictionService.ts
    │   ├── normalizeStructure.ts
    │   ├── normalizePrediction.ts
    │   └── determineAnalysisStatus.ts
    ├── providers
    │   ├── NmrPredictor.ts
    │   ├── fixture
    │   │   ├── FixtureHosePredictor.ts
    │   │   ├── fixtureDatabase.ts
    │   │   └── fixtureEnvironment.ts
    │   ├── ocl
    │   │   ├── OclHosePredictor.ts
    │   │   ├── createEnvironmentCode.ts
    │   │   ├── groupEquivalentAtoms.ts
    │   │   └── localDatabase.ts
    │   └── cheminfo
    │       ├── CheminfoHosePredictor.ts
    │       ├── cheminfoTypes.ts
    │       ├── localDatabase.ts
    │       └── transformCheminfoResult.ts
    ├── worker
    │   ├── protocol.ts
    │   ├── nmrWorker.ts
    │   └── nmrWorkerClient.ts
    ├── report
    │   ├── composePredictionReport.ts
    │   ├── stickSpectrumSvg.ts
    │   ├── predictionTable.ts
    │   └── reportNotices.ts
    └── tests
        ├── manifest.test.ts
        ├── predictionService.test.ts
        ├── normalizeStructure.test.ts
        ├── fixturePredictor.test.ts
        ├── oclEnvironment.test.ts
        ├── cheminfoTransform.test.ts
        ├── workerProtocol.test.ts
        ├── composePredictionReport.test.ts
        └── stickSpectrumSvg.test.ts
```

There is no `ui` folder and no React dependency in the plugin package: the
panel is a declarative `PluginPanelReport`, so "UI" code is pure report
composition (`report/`) — string/SVG generation that unit-tests in Node
without a DOM. React rendering of reports lives in the desktop, once, for all
plugins.

The `ocl` and `cheminfo` provider folders may initially contain design notes or remain absent until their respective investigations begin. Do not create large amounts of unused placeholder code.

The required working provider is:

```text
providers/fixture/FixtureHosePredictor.ts
```

## NMR domain contracts

```ts
export type NmrNucleus = "1H" | "13C";

export interface ChemicalStructureInput {
  format:
    | "smiles"
    | "molfile-v2000"
    | "molfile-v3000";

  value: string;
}

export interface NmrPredictorCapabilities {
  id: string;
  version: string;
  execution:
    | "worker-js"
    | "wasm"
    | "native-service"
    | "remote";

  nuclei: readonly NmrNucleus[];

  supportsAtomAssignments: boolean;
  supportsUncertainty: boolean;
  supportsCouplings: boolean;
  supportsSolvent: boolean;
  supportsConformers: boolean;
  supportsStereochemistry: boolean;
}

export interface NmrPredictionOptions {
  statistic: "median" | "mean";
  hoseLevels: readonly number[];
  ignoreLabileHydrogens: boolean;
}

export interface NmrPredictionRequest {
  structure: ChemicalStructureInput;
  nuclei: readonly NmrNucleus[];
  options: NmrPredictionOptions;
}

export interface NmrAtomReference {
  sourceAtomIndex: number;
  element: string;
  equivalentCount?: number;
  backendAtomId?: string;
  chemDraftAtomId?: string;
}

export interface NmrPredictionEvidence {
  method:
    | "fixture-fragment"
    | "hose-fragment"
    | "gnn"
    | "dft"
    | "hybrid";

  matchedSphere?: number;
  sampleCount?: number;
  environmentCode?: string;
}

export interface NmrPredictionUncertainty {
  standardDeviationPpm?: number;
  minimumPpm?: number;
  maximumPpm?: number;
}

export interface NmrResonance {
  id: string;
  nucleus: NmrNucleus;
  deltaPpm: number;

  atomRefs: readonly NmrAtomReference[];

  /**
   * Predicted equivalent nuclei.
   * This is not an experimental integral.
   */
  equivalentNuclei?: number;

  uncertainty?: NmrPredictionUncertainty;
  evidence?: NmrPredictionEvidence;
  flags: readonly string[];
}

export interface NmrPredictionBackend {
  id: string;
  version: string;
  dataVersion?: string;
  method: string;
}

export interface NmrPredictionWarning {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  atomIndices?: readonly number[];
  details?: Readonly<Record<string, unknown>>;
}

export interface NmrPredictionResult {
  schemaVersion: "1";
  sourceFingerprint: string;
  backend: NmrPredictionBackend;
  resonances: readonly NmrResonance[];
  warnings: readonly NmrPredictionWarning[];
  generatedAt: string;
}

export interface NmrPredictor {
  getCapabilities():
    | NmrPredictorCapabilities
    | Promise<NmrPredictorCapabilities>;

  predict(
    request: NmrPredictionRequest,
    signal?: AbortSignal,
  ): Promise<NmrPredictionResult>;
}
```

The result should remain serializable so it can cross the worker boundary and enter the generic analysis store.

Do not include:

- OCL molecule instances;
- class instances from `nmr-predictor`;
- functions;
- maps without serialization rules;
- cyclic objects;
- typed objects requiring a dependency to interpret.

## Future contracts

The plugin should be designed so later services can reuse the same normalized predictions.

Future contracts might include:

```ts
export interface ExperimentalNmrSpectrum {
  id: string;
  nucleus: NmrNucleus;
  sourceFormat: string;
  peaks: readonly ExperimentalNmrPeak[];
  metadata: ExperimentalNmrMetadata;
}

export interface NmrMatchRequest {
  prediction: NmrPredictionResult;
  experimental: ExperimentalNmrSpectrum;
  options: NmrMatchOptions;
}

export interface NmrMatchResult {
  score: number;
  assignments: readonly NmrPeakAssignment[];
  unmatchedPredicted: readonly string[];
  unmatchedObserved: readonly string[];
  warnings: readonly NmrPredictionWarning[];
}

export interface NmrCandidateRankingRequest {
  candidates: readonly ChemicalStructureInput[];
  experimental: ExperimentalNmrSpectrum;
}

export interface NmrCandidateRankingResult {
  ranked: readonly NmrCandidateScore[];
}

export interface NmrInversePredictionRequest {
  experimental: ExperimentalNmrSpectrum;
  molecularFormula?: string;
}
```

Do not implement these in Phase 1.

Do not create empty exported interfaces solely to suggest progress. Put future designs in the architecture document until they have real fields and consumers.

## Worker boundary

Follow the existing conformer worker/client style.

```ts
export type NmrWorkerRequest =
  | {
      type: "initialize";
      requestId: string;
      providerId: string;
    }
  | {
      type: "predict";
      requestId: string;
      request: NmrPredictionRequest;
      sourceFingerprint: string;
    }
  | {
      type: "cancel";
      requestId: string;
    };

export type NmrWorkerResponse =
  | {
      type: "ready";
      requestId: string;
      capabilities: NmrPredictorCapabilities;
    }
  | {
      type: "result";
      requestId: string;
      result: NmrPredictionResult;
    }
  | {
      type: "cancelled";
      requestId: string;
    }
  | {
      type: "error";
      requestId: string;
      error: {
        code: string;
        message: string;
        details?: unknown;
      };
    };
```

Worker behavior:

- lazy-load the active provider;
- lazy-load its database;
- keep one active calculation per client;
- cancel the prior request when a new prediction starts;
- ignore late results after cancellation;
- normalize all errors;
- never expose dependency instances;
- avoid network access;
- avoid persistent global mutation;
- preserve deterministic fixture behavior.

The client should resemble the existing conformer client:

```ts
export interface NmrWorkerClient {
  initialize(
    providerId: string,
  ): Promise<NmrPredictorCapabilities>;

  predict(
    request: NmrPredictionRequest,
    sourceFingerprint: string,
    signal?: AbortSignal,
  ): Promise<NmrPredictionResult>;

  dispose(): void;
}
```

Cancellation should not rely solely on the underlying provider respecting `AbortSignal`. The client must also ignore a result whose request is no longer active.

Worker-client ownership: the client is a plugin-scoped singleton created
lazily by the plugin's registration module and disposed when the plugin is
unregistered or the application shuts down. Closing the panel cancels the
active request but does not dispose the client; a superseding request cancels
its predecessor. Do not tie worker lifetime to panel visibility.

Panel-close lifecycle (ADR-0012): a plugin currently has no signal that its
panel closed, and `showReport` unconditionally (re)opens a panel — so a late
worker result could resurrect a panel the user just dismissed. Before async
prediction lands (this milestone), add an `onPanelClosed(panelId)` registration
hook so the client can cancel on close, and make the panel controller deliver a
report for a not-currently-open panel **without reopening** it (drop a
superseded late report with a diagnostic). This is what makes "closing the
panel cancels the request" real rather than aspirational.

Bundling note — RESOLVED in M7 (reports/0004): the spike confirmed that
`new Worker(new URL("./nmrWorker.ts", import.meta.url), { type: "module" })` in
the plugin package emits a dedicated `nmrWorker-*.js` chunk under the desktop's
Vite build, exactly like the conformer worker. The one prerequisite is that
`apps/desktop` declares `@chemdraft/plugin-nmr-predictor` as a `workspace:*`
dependency (otherwise tsc and Rollup cannot resolve the import). The
desktop-owned worker-entry fallback was therefore not needed.

## Manifest

Contribution IDs follow the verified repository convention (see
`molscribe-ocsr`): commands are namespaced `plugin.<pluginName>.<action>`
(the desktop's toolset layer distinguishes plugin commands from core commands
by that prefix, and toolset IDs are regex-enforced to start with `plugin.`),
menus/panels/analyzers use `menu.*` / `panel.*` / `analyzer.*` prefixes.

```ts
export const nmrPredictorCommandId =
  "plugin.nmrPredictor.predictSelectedStructure";
export const nmrPredictorPanelId = "panel.nmrPredictor.prediction";

export const nmrPredictorManifest: PluginManifest = {
  id: "org.chemdraft.nmr-predictor",
  name: "NMR Predictor",
  version: "0.1.0",
  apiVersion: "^0.1.0",
  entry: "dist/index.js",
  description:
    "Predicts simple 1H and 13C chemical shifts for a selected molecule.",
  license: "MIT",

  permissions: [
    "selection.read",
    "analysis.write",
    "ui.menu",
    "ui.panel",
    "plugin.storage"
  ],

  contributes: {
    commands: [
      {
        id: nmrPredictorCommandId,
        title: "Predict NMR Spectrum",
        category: "Analyze",
        description:
          "Predict simple 1H and 13C chemical shifts for the selected molecule.",
        requiredPermissions: ["selection.read", "analysis.write"],
        enabled: true
      }
    ],

    menus: [
      {
        id: "menu.nmrPredictor.predictSelectedStructure",
        title: "Predict NMR Spectrum",
        commandId: nmrPredictorCommandId,
        location: "analyze",
        requiredPermissions: ["ui.menu"]
      }
    ],

    panels: [
      {
        id: nmrPredictorPanelId,
        title: "NMR Prediction",
        commandId: nmrPredictorCommandId,
        requiredPermissions: ["ui.panel"]
      }
    ],

    toolbarButtons: [],
    toolsets: [],
    inspectors: [],
    templates: [],
    importers: [],
    exporters: [],

    analyzers: [
      {
        id: "analyzer.nmrPredictor.forwardPrediction",
        title: "NMR Chemical-Shift Prediction",
        commandId: nmrPredictorCommandId,
        requiredPermissions: ["selection.read", "analysis.write"]
      }
    ],

    transformers: [],
    recognizers: []
  }
};
```

Register it through `validateTrustedPluginManifest` /
`PluginHost.registerPlugin` like the molscribe example, so schema validation
(duplicate IDs, undeclared permissions) runs at registration time.

Do not request:

```text
document.read
document.write
document.proposePatch
network.fetch
native.execute
ml.inference
model.load
model.download
filesystem.read
filesystem.write
```

The manifest’s `apiVersion` should be consistent with current examples and host expectations, but the task should not claim that compatibility is enforced unless the host gains real compatibility checks.

## Command behavior

The command handler uses the verified context shape: `selection`, `panels`,
and `analysis` are permission-gated optional properties (see ADR-0008), and
the panel is populated by pushing a declarative report, not by opening a
React component.

```ts
export async function predictSelectedStructure(
  context: PluginCommandContext,
  services: {
    predictor: NmrPredictor;
  },
): Promise<PluginCommandResult<NmrPredictionResult>> {
  const { selection, panels, analysis } = context;

  if (!selection || !analysis) {
    return {
      ok: false,
      error: {
        code: "NMR_PERMISSION_UNAVAILABLE",
        message:
          "NMR prediction requires selection.read and analysis.write.",
      },
    };
  }

  const snapshot = await selection.getSelection();
  const molecules = snapshot.molecules;

  if (molecules.length === 0) {
    return {
      ok: false,
      error: {
        code: "NMR_NO_SELECTED_STRUCTURE",
        message:
          "Select one molecule before predicting an NMR spectrum.",
      },
    };
  }

  if (molecules.length > 1) {
    return {
      ok: false,
      error: {
        code: "NMR_MULTIPLE_SELECTED_STRUCTURES",
        message: "Select exactly one molecule.",
      },
    };
  }

  const source = molecules[0];

  const structure = mapSelectedMoleculeToPredictionInput(source);

  if (!structure.ok) {
    return structure.errorResult;
  }

  await panels?.showReport(
    nmrPredictorPanelId,
    composePendingReport(source),
  );

  try {
    const result = await services.predictor.predict({
      structure: structure.value,
      nuclei: ["13C"],
      options: {
        statistic: "median",
        hoseLevels: [4, 3, 2, 1],
        ignoreLabileHydrogens: true,
      },
    });

    const status = determineAnalysisStatus(result);

    await analysis.write({
      analysisType: "nmr.forward-prediction",
      schemaVersion: "1",
      source: {
        documentId: source.documentId,
        pageId: source.pageId,
        objectId: source.objectId,
        sourceFingerprint: source.sourceFingerprint,
      },
      status,
      payload: result,
      warnings: result.warnings,
      provenance: {
        engineId: result.backend.id,
        engineVersion: result.backend.version,
        dataVersion: result.backend.dataVersion,
        method: result.backend.method,
      },
    });

    await panels?.showReport(
      nmrPredictorPanelId,
      composePredictionReport(source, result),
    );

    return {
      ok: true,
      data: result,
      warnings: result.warnings,
    };
  } catch (error) {
    const normalized = normalizeNmrCommandError(error);
    await panels?.showReport(
      nmrPredictorPanelId,
      composeErrorReport(source, normalized),
    );
    return {
      ok: false,
      error: normalized,
    };
  }
}
```

Cancellation note: when a rerun supersedes an in-flight prediction, the
superseded promise rejects with `NMR_PREDICTION_CANCELLED`; the command
returns not-ok and writes no analysis record for the cancelled run.

Error-channel note (ADR-0010): returning `{ ok: false, error }` must reach the
user. As of the M1–M3 runtime, only *thrown* command errors surface (status
bar); a returned not-ok result resolves silently. Before this command ships
(M8), the desktop dispatch must inspect the resolved value and surface an
`ok: false` result the same way it surfaces a throw. Either channel is then
valid; do not rely on returning not-ok being visible until that lands.

The default command request should start with ¹³C only.

The panel may allow the user to enable ¹H. Label the initial ¹H mode as experimental until the active database and predictor have been benchmarked.

A later preference can remember the user’s last nucleus selection through plugin storage.

## Phase 1 UI

Under the declarative panel model, the "UI" is a `PluginPanelReport` composed
by the plugin plus chrome owned by the desktop. Composition is a pure,
testable function: `composePredictionReport(source, result)`.

Report sections (plugin-composed):

- `keyValue` — selected object identifier, source format, active predictor,
  predictor version, data version, prediction method;
- `text` — fixture-data notice when the fixture provider is active;
- `text` — experimental-proton notice when ¹H is included;
- `svg` — reversed-axis stick spectrum (an SVG string, ≤ 512 KB);
- `table` — prediction table;
- `text` — warnings, one line per warning with its stable code;
- `text` — stale-result indicator when the stored fingerprint no longer
  matches the current selection.

Desktop chrome (host-owned):

- panel title from the manifest contribution;
- close control;
- "Run again" action dispatching the panel contribution's `commandId`;
- loading presentation while a command is in flight (the command pushes a
  pending report first).

Nucleus selection under this model: the default command predicts ¹³C only.
¹H is exposed as a second, visibly experimental command and Analyze menu item
(for example `plugin.nmrPredictor.predictWithProtonExperimental`) rather than
a checkbox, until a declarative `actions` section kind exists (see the panel
section). Cancellation is by supersession: rerunning replaces the in-flight
request, and closing the panel cancels it.

Recommended header:

```text
NMR Prediction

Provider: ChemDraft Fixture Fragment Predictor
Method: fixture-fragment
Data: fixtures-0.1
Source: selected molecule
```

When fixtures are active:

```text
Architecture test data

These shifts are synthetic fixtures used to test
the plugin workflow. They are not validated
experimental predictions.
```

When ¹H is enabled:

```text
¹H prediction is experimental in this provider.
Exchangeable protons, solvent, conformational
effects, and coupling are not modeled.
```

## Stick spectrum

Use plain SVG, generated as a string by a pure function in the plugin's
`report/` module and delivered as a `{ kind: "svg" }` report section. This
fits the verified panel model exactly: the section schema caps SVG at 512 KB
and the desktop renders it in an `<img>` context, so the spectrum must be
self-contained (no external references, no scripts, no event handlers —
they would not execute anyway).

Do not add a charting dependency.

Default domains:

```text
¹H: 12 to 0 ppm
¹³C: 220 to 0 ppm
```

Extend the domain when a prediction lies outside the default range.

The x-axis should be reversed:

```ts
function ppmToX(
  ppm: number,
  maxPpm: number,
  minPpm: number,
  width: number,
): number {
  return (
    ((maxPpm - ppm) /
      (maxPpm - minPpm)) *
    width
  );
}
```

Stick height may reflect predicted equivalent nuclei:

```text
1 nucleus → base height
2 nuclei → taller
3 nuclei → taller
```

The legend must say:

```text
Stick height represents predicted equivalent nuclei.
It is not experimental integration.
```

When predicted equivalent counts are unavailable, use uniform stick height.

Do not broaden sticks into realistic peak shapes.

Do not synthesize multiplets.

## Prediction table

Columns:

```text
Nucleus
δ / ppm
Equivalent nuclei
Source atom indices
Matched environment sphere
Reference count
Standard deviation or range
Flags
```

Possible example:

```text
13C | 128.4 | 2 | 2, 6 | 3 | 14 | 1.8 ppm | -
```

Do not show:

```text
s
d
t
q
m
J / Hz
line width
experimental area
solvent corrected
confidence 96%
```

unless a future provider returns scientifically defensible values and the result schema is updated accordingly.

## Result staleness

Staleness is detected generically by the desktop, not inside plugin code,
because a declarative report cannot re-render itself.

Mechanism (ADR/D-09, an M9 schema change that depends on the M4 fingerprint
existing): extend `PluginPanelReportSchema` with an optional generic source
reference —

```ts
source?: {
  objectId: string;
  sourceFingerprint: string;
};
```

— which any analyzer plugin can stamp when composing a report. Do not add this
field before M9: it has no consumer until the desktop staleness chrome exists,
and it is meaningless until M4 gives selections a `sourceFingerprint`. The desktop
panel surface subscribes to selection changes; when the current selected
structure's fingerprint no longer matches the open report's
`source.sourceFingerprint` (or the object is no longer selected), the chrome
shows a stale banner:

```text
This prediction was generated for an earlier
version of the selected structure.
```

The analysis record independently carries the same fingerprint in
`analysis.source.sourceFingerprint`, so the stored record and the displayed
report stay reconcilable:

```text
pluginId
analysisType
documentId
objectId
sourceFingerprint
```

The previous result remains visible but visibly marked stale.

Do not silently replace it with an empty panel.

The chrome's "Run again" action re-invokes the panel's `commandId`, which
creates a new analysis record and pushes a fresh report rather than mutating
the old record.

## Warning codes

Use stable codes.

```text
NMR_UNSUPPORTED_STRUCTURE_FORMAT
NMR_EMPTY_STRUCTURE
NMR_STRUCTURE_PARSE_FAILED
NMR_UNSUPPORTED_ELEMENT
NMR_CHARGED_STRUCTURE
NMR_RADICAL_NOT_SUPPORTED
NMR_ISOTOPE_NOT_SUPPORTED
NMR_STEREOCHEMISTRY_NOT_MODELED
NMR_SOLVENT_NOT_MODELED
NMR_CONFORMERS_NOT_MODELED
NMR_LABILE_PROTON_OMITTED
NMR_NO_FRAGMENT_MATCH
NMR_LOW_HOSE_SPHERE_MATCH
NMR_SMALL_REFERENCE_POPULATION
NMR_PARTIAL_PREDICTION
NMR_PROVIDER_INITIALIZATION_FAILED
NMR_PROVIDER_FAILURE
NMR_PREDICTION_CANCELLED
NMR_STALE_RESULT
NMR_FIXTURE_DATA
NMR_EXPERIMENTAL_PROTON_MODEL
```

Recommended severity:

```text
NMR_FIXTURE_DATA                  info
NMR_SOLVENT_NOT_MODELED          info
NMR_CONFORMERS_NOT_MODELED       info
NMR_EXPERIMENTAL_PROTON_MODEL    warning
NMR_LOW_HOSE_SPHERE_MATCH        warning
NMR_SMALL_REFERENCE_POPULATION   warning
NMR_NO_FRAGMENT_MATCH            warning
NMR_PARTIAL_PREDICTION           warning
NMR_STRUCTURE_PARSE_FAILED       error
NMR_PROVIDER_FAILURE             error
```

A no-match atom should not receive:

- zero ppm;
- the molecule average;
- a random fallback;
- a generic element average without disclosure.

Omit that resonance and return a warning.

## ¹³C versus ¹H defaults

Give ¹³C and ¹H unequal default status.

Recommended defaults:

```text
¹³C: enabled
¹H: disabled, available as experimental
```

Reasons reflected in the product behavior:

- carbon fragment environments are generally simpler to group;
- proton prediction depends more strongly on stereotopic assignment;
- exchangeable hydrogens require special treatment;
- proton databases may have weaker provenance or coverage;
- a synthetic proton stick spectrum can look more authoritative than the underlying prediction warrants.

This does not remove ¹H from Phase 1. It changes the default and labeling.

The command may initially produce ¹³C results immediately, while the panel allows the user to rerun with ¹H enabled.

## More advanced local algorithmic predictors

A useful path beyond basic lookup does not need to begin with deep learning.

### Layered graph-environment lookup

Generate atom-centered environments at increasing radii:

```text
radius 4
radius 3
radius 2
radius 1
```

Search largest radius first.

For every match, retain:

```text
radius
reference count
median shift
mean shift
standard deviation
minimum
maximum
```

This produces useful applicability information.

### Hierarchical fragment backoff

Use structured fallback:

```text
exact stereochemical environment
  ↓
same graph without stereochemical distinction
  ↓
smaller environment radius
  ↓
element/hybridization class
  ↓
no prediction
```

Every fallback should produce a flag.

### Substituent correction model

For supported chemical classes:

```text
baseline atom-type shift
+
first-shell corrections
+
second-shell corrections
+
aromatic substituent corrections
```

This is explainable, but should be limited to classes with adequate calibration.

### Nearest-neighbor analog prediction

With a licensed atom-assigned reference database:

1. find molecules with similar fingerprints;
2. determine candidate atom correspondences;
3. aggregate matched atom shifts;
4. weight by molecular similarity and atom-environment similarity;
5. report analog identities and dispersion.

This is more advanced than a single fragment lookup without requiring a neural network.

### Fragment baseline plus residual model

Use:

```text
final prediction =
fragment prediction +
learned residual correction
```

A small regression model can use:

- atom element;
- aromaticity;
- formal charge;
- ring membership;
- local descriptors;
- global molecular descriptors;
- fragment prediction;
- solvent class if available.

The fragment estimate remains interpretable, while the residual model captures systematic nonlocal effects.

### Conformer-aware correction

Later:

1. generate conformers;
2. predict or calculate per-conformer corrections;
3. weight by conformer energy;
4. report ensemble mean;
5. report conformer-induced dispersion.

This can be implemented with a local model or DFT.

### Calibrated ensemble

Combine:

```text
fragment predictor
OCL-native model
GNN provider
DFT provider
```

Weight them according to applicability-domain evidence.

Do not implement this until every provider reports meaningful uncertainty and provenance.

## Extension-point inventory

The point of Phase 1 is not the NMR numbers; it is that each of the following
additions becomes cheap. For every extension: what you touch, and what you
must not touch. Violating a "never touch" column means the abstraction
failed — stop and fix the boundary instead of pushing through.

| To add… | Touch | Never touch |
|---|---|---|
| A new NMR provider (OCL-native, GNN, remote) | a new `providers/<name>/` adapter implementing `NmrPredictor`; provider selection wiring | worker protocol, report composition, analysis schema, plugin-api, plugin-host |
| A new nucleus (e.g. ¹⁵N, ¹⁹F) | `NmrNucleus` union, fixture/provider data, axis defaults, command options | plugin-api, plugin-host, desktop |
| A second analyzer plugin (mass-fragment is the queued candidate) | a new `examples/plugins/<name>/` package + one line in `registerBundledPlugins.ts` | plugin-api, plugin-host, desktop renderer, menu adapter |
| A new report section kind (e.g. `actions`) | `PluginPanelSectionSchema` + the desktop renderer + a schema-version note | individual plugins (old reports must stay valid) |
| A new Analyze menu item | the contributing plugin's manifest | `appMenu.ts` internals (the adapter picks contributions up), `lib.rs` |
| A new analysis consumer (e.g. an export of results) | desktop code reading the analysis store via the trusted-desktop read path | plugin internals, analysis record schema |
| A new worker-backed computation in another plugin | that plugin's worker following the conformer/NMR protocol pattern | a shared worker framework — copy the small pattern until ≥ 2 real consumers prove a generalization (per AGENTS.md) |
| Dynamic (non-bundled) plugin loading | a future milestone with sandboxing and its own plan | everything in Phase 1 — nothing may assume bundled-only in a way that blocks this, but nothing implements it either |

Two structural rules keep these columns true:

1. Generic layers never learn spectroscopy: `plugin-api` and `plugin-host`
   stay free of nuclei, shifts, and provider names. The analysis store carries
   `payload: unknown` plus `analysisType`/`schemaVersion` strings.
2. Every cross-boundary object is serializable plain data validated by a
   schema at the boundary (manifest, report, analysis record, worker
   messages). That is what makes providers, panels, and plugins swappable.

## Implementation sequence

This milestone list is canonical. `AGENTS.md`, `STATUS.md`, and every
assignment prompt reference these numbers; do not renumber or reorder them
elsewhere.

### Milestone 1: runtime inventory and tests

Before changing application code, add or update tests that capture the current behavior:

- plugin manifest parsing;
- plugin registration;
- command registration;
- command invocation;
- current duplicate-plugin behavior;
- permission enforcement;
- current `molscribe-ocsr` manifest.

Document that:

- desktop does not yet instantiate `PluginHost`;
- no live plugin panel exists;
- no manifest-driven Analyze menu exists;
- no loaded-plugin UI exists.

This prevents implementation from assuming those features are already present.

### Milestone 2: persistent desktop plugin runtime

Add:

```text
apps/desktop/src/plugins/createPluginRuntime.ts
apps/desktop/src/plugins/registerBundledPlugins.ts
apps/desktop/src/plugins/PluginReportRenderer.tsx
apps/desktop/src/plugins/PluginPanelSurface.tsx
apps/desktop/src/plugins/pluginMenuModel.ts
apps/desktop/src/plugins/PluginDiagnosticsPanel.tsx
apps/desktop/src/plugins/usePluginHostSnapshot.ts
```

Implement:

- persistent `PluginHost` (supplying `getActiveDocument`, `getSelection`,
  `showPanelReport`, and a storage factory);
- ref-backed active document provider;
- ref-backed active selection provider;
- bundled plugin registration;
- host subscriptions;
- the desktop panel-report renderer and panel surface;
- Analyze-menu adaptation into the `appMenu.ts` model, with the
  native-menu drift test handled per the menu-integration section;
- plugin list or diagnostics view;
- plugin command dispatch.

Do not add NMR code yet.

### Milestone 3: `molscribe-ocsr` runtime canary

Mount the existing plugin.

Prove:

- registration;
- plugin list;
- Analyze contribution;
- command invocation;
- trivial panel opening;
- runtime persistence after document edits.

The OCR engine itself does not need to be completed for the runtime test.

### Milestone 4: selection API extension

The selection API already exists (`PluginSelectionAPI.getSelection()`,
permission-gated optional context property, covered by
`selectionStorage.test.ts`). This milestone extends it without renaming or
breaking the tested contract.

Modify:

```text
packages/plugin-api/src/index.ts
packages/plugin-api/src/index.test.ts
packages/plugin-host/src/index.ts
packages/plugin-host/src/selectionStorage.test.ts
```

Implement:

- `PluginStructureFormat` enum narrowing of `structureFormat`;
- `sourceFingerprint` on `PluginSelectedMolecule` (see the fingerprint
  section for the hash specification);
- `documentId` / `pageId` where the document model provides them;
- host-side deep-copy or deep-freeze of snapshots (currently the provider
  object is returned as-is — verified gap);
- the desktop selection provider as a thin adapter over current
  `MainWindow.tsx` selection state (the pending selection-policy refactor in
  `PLANS-selection-policy.md` must be able to land without touching plugins).

### Milestone 5: generic analysis API

Add:

```text
packages/plugin-host/src/analysisStore.ts
```

Implement:

- analysis write;
- analysis list;
- latest analysis;
- host stamps;
- deep-copy behavior;
- subscriptions;
- generic desktop read access.

### Milestone 6: fixture NMR provider

Create the NMR plugin package.

Implement:

- domain contracts;
- structure normalization;
- fixture environment lookup;
- deterministic results;
- partial results;
- warnings;
- provenance;
- ¹³C default;
- optional experimental ¹H.

Do not add `nmr-predictor` yet.

### Milestone 7: NMR worker

Reuse the conformer worker/client design.

Implement:

- initialize;
- predict;
- cancel;
- request IDs;
- late-response suppression;
- disposal;
- error normalization.

### Milestone 8: NMR command and analysis integration

Register:

- manifest;
- command;
- Analyze item;
- panel contribution;
- analyzer contribution.

Write generic analysis records.

Verify document immutability.

### Milestone 9: NMR panel report

Implement:

- pure report composition (`composePredictionReport`, pending and error
  variants);
- fixture notice section;
- warnings section;
- reversed-axis SVG stick-spectrum section;
- prediction table section;
- stale-result handling (staleness section plus rerun via desktop chrome);
- experimental ¹H as a second, visibly experimental command/menu item;
- cancellation by supersession and panel close.

### Milestone 10: OCL-native predictor investigation

Implement environment-code generation or a focused technical prototype.

Evaluate:

- atom traversal;
- aromaticity;
- implicit hydrogens;
- equivalent atoms;
- stereochemical differentiation;
- data format;
- bundle impact.

This investigation can produce a provider behind the same interface without changing application code.

### Milestone 11: `nmr-predictor` compatibility investigation

Exact-pin the dependency in an isolated package.

Test:

- bundling;
- worker execution;
- OCL duplication;
- local database injection;
- no-network behavior;
- output normalization.

Do not make the main NMR plugin package depend on it until the investigation succeeds.

### Milestone 12: documentation and provenance

Add:

```text
README.md
THIRD_PARTY_NOTICES.md
docs/architecture/plugin-runtime.md
docs/architecture/nmr-predictor-plugin.md
docs/architecture/nmr-prediction-data.md
```

Document:

- runtime architecture;
- canary plugin;
- generic APIs;
- predictor interface;
- worker boundary;
- normalization;
- provider limitations;
- fixture-data status;
- third-party dependency results;
- database licensing status;
- future extension points.

## Acceptance tests

### Runtime tests

1. The desktop constructs one persistent `PluginHost`.
2. Editing the document does not reconstruct the host.
3. `molscribe-ocsr` registers as a bundled plugin.
4. Its manifest is visible through contribution enumeration.
5. Its Analyze menu item is rendered.
6. Its command can be invoked.
7. Its contributed panel can open.
8. A plugin list or diagnostics view displays its ID and version.
9. Unknown panel IDs produce a controlled diagnostic.
10. Existing core commands continue to work.

### Plugin API and host tests

11. `selection.read` is enforced.
12. `analysis.write` is enforced.
13. Selection snapshots are copied, not live references.
14. Snapshot fingerprints are deterministic.
15. Changing the structure payload changes the fingerprint.
16. The host stamps plugin ID.
17. The host stamps record ID.
18. The host stamps time from the injected clock.
19. Analysis input is deep-copied.
20. Returned records cannot mutate stored records.
21. Query filtering works by plugin.
22. Query filtering works by analysis type.
23. Query filtering works by document.
24. Query filtering works by object.
25. `getLatest` is deterministic.
26. Analysis writes notify subscribers.
27. Plugin registration notifies subscribers.
28. Menu contribution enumeration works.
29. Panel contribution enumeration works.
30. Analyzer contribution enumeration works.

### Structure normalization tests

31. A valid SMILES parses through the existing OCL dependency.
32. A valid V2000 molfile parses.
33. A valid V3000 molfile parses.
34. `unknown` fails with `NMR_UNSUPPORTED_STRUCTURE_FORMAT`.
35. An empty structure fails with `NMR_EMPTY_STRUCTURE`.
36. Invalid SMILES fails with `NMR_STRUCTURE_PARSE_FAILED`.
37. Formal charge is preserved or warned about.
38. Isotopes are preserved or warned about.
39. Atom-index mapping behavior is deterministic for fixture cases.
40. Implicit hydrogen counts are deterministic.

### Fixture predictor tests

41. Supported fixture molecules produce finite ¹³C shifts.
42. Enabled ¹H produces finite fixture shifts.
43. Equivalent environments are grouped.
44. Equivalent nuclei are not labeled integration.
45. Unsupported environments are omitted.
46. Unsupported environments produce no-match warnings.
47. A partially supported molecule returns `partial`.
48. The fixture result includes `NMR_FIXTURE_DATA`.
49. The ¹H result includes `NMR_EXPERIMENTAL_PROTON_MODEL`.
50. Results include provider and data versions.
51. Repeated predictions are deterministic.
52. No network calls occur.

### Worker tests

53. Initialization returns capabilities.
54. Prediction returns a serializable result.
55. Cancellation suppresses late results.
56. A newer request supersedes an older request.
57. Worker errors become stable plugin errors.
58. Client disposal rejects or cancels pending requests.
59. `fetch` can be replaced with a throwing spy without breaking fixture prediction.
60. `XMLHttpRequest` can be replaced with a throwing spy without breaking fixture prediction.

### NMR desktop tests

61. The NMR plugin registers after the canary runtime is working.
62. Its Analyze menu item is visible.
63. No selection produces `NMR_NO_SELECTED_STRUCTURE`.
64. Multiple molecule selection produces `NMR_MULTIPLE_SELECTED_STRUCTURES`.
65. Unknown structure format produces `NMR_UNSUPPORTED_STRUCTURE_FORMAT`.
66. A supported structure opens the panel.
67. The command writes a generic analysis record.
68. The command does not produce a document patch.
69. The native document remains unchanged.
70. The panel renders a reversed ¹³C axis.
71. ¹³C is enabled by default.
72. ¹H is disabled or marked experimental by default.
73. The table displays source atom indices.
74. The table displays fragment support.
75. The fixture-data notice is visible.
76. Changing the source structure marks the result stale.
77. Rerunning creates a new analysis record.
78. Closing the panel does not delete analysis records.
79. Cancel stops the active display update.
80. Plugin and provider types do not leak into ChemDraft core packages.

### Optional third-party compatibility tests

81. `nmr-predictor` can be loaded only inside its adapter.
82. Its result is transformed into `NmrPredictionResult`.
83. No remote database helper is called.
84. No remote prediction endpoint is called.
85. Its database is supplied locally.
86. The worker bundle contains no unsupported Node built-ins.
87. Its OCL dependency does not corrupt ChemDraft’s primary OCL runtime.
88. The output records the third-party engine and data versions.
89. The third-party provider can be disabled without changing the panel.
90. Fixture prediction remains available when the third-party provider is absent.

### Extensibility acceptance

These prove the user's core requirement — that the first plugin made the
*next* one cheap. They are Phase 1 exit criteria, not optional extras.

91. A trivial second analyzer plugin (a test fixture is sufficient; the
    queued real candidate is `mass-fragment-demo`) can register, contribute
    an Analyze item, invoke a command, write and read its own analysis
    records, and push a panel report **without any change** to
    `packages/plugin-api`, `packages/plugin-host`, the desktop report
    renderer, or the menu adapter — only a package plus one
    `registerBundledPlugins.ts` line.
92. A second `NmrPredictor` provider can be substituted behind the same
    interface without changes to the worker protocol, report composition,
    analysis schema, or any desktop code.
93. No plugin package imports React, `PluginHost` internals, another
    plugin's types, or a provider dependency outside its own adapter
    (enforceable as a dependency-boundary test or lint rule).

## Paste-ready Codex task

> **SUPERSEDED — do not paste this block as a single assignment.**
> It predates the 2026-07-07 repository verification (declarative panel
> reports, existing selection API, menu drift test, `plugin.*` ID naming) and
> it bundles all milestones into one task, which contradicts the
> milestone-by-milestone discipline in `AGENTS.md`. Assignments are issued
> per milestone from the planning workspace's `prompts/` directory
> (`prompts/01-runtime-bringup.md` is first). This block is retained only as
> a full-scope requirements inventory; where it conflicts with the sections
> above, the sections above win.

```text
Repository:
https://github.com/jgassens/ChemDraft

Objective:
Implement the first live bundled-plugin runtime in the ChemDraft desktop and
then implement a bundled “NMR Predictor” analyzer plugin that reads exactly
one selected molecule, runs a local fixture-backed chemical-shift predictor in
a Web Worker, writes a generic analysis record, and displays a prediction
panel with a table and reversed-axis SVG stick spectrum.

The NMR plugin is a narrow Phase 1 architecture test. Its required predictor
is a ChemDraft-owned deterministic fixture provider. A third-party
nmr-predictor integration is not required for Phase 1 completion.

Do not implement:
- experimental spectrum import
- JCAMP parsing
- structure/spectrum matching
- candidate ranking
- inverse structure elucidation
- dynamic untrusted plugin loading
- plugin sandboxing
- Python
- PyTorch
- TensorFlow
- native prediction services
- remote prediction
- model downloads
- DFT
- viewport atom highlighting
- multiplicity simulation
- coupling constants
- realistic line shapes

Read before editing:
- AGENTS.md
- PLANS.md
- README.md
- PLAN.md, if present
- root package.json
- pnpm-workspace.yaml
- packages/plugin-api
- packages/plugin-host
- packages/chem-core/src/schemas.ts
- packages/ocl-adapter
- apps/desktop/src/MainWindow.tsx
- apps/desktop/src/documentWorkflow.ts
- apps/desktop/src/conformerWorker.ts
- apps/desktop/src/conformerClient.ts
- examples/plugins/molscribe-ocsr
- toolset-registry menu code
- relevant tests and package manifests

Repository-state assumptions to verify:
- PluginCommandContext currently lacks selection and analysis APIs.
- Plugin manifests already describe commands, menus, panels, analyzers, and
  permissions including selection.read and analysis.write.
- PluginHost is not currently instantiated by the desktop.
- MainWindow constructs CommandRegistry directly.
- The command registry is recreated when document dependencies change.
- molscribe-ocsr is not mounted in the running desktop.
- There is no live manifest-driven Analyze menu.
- There is no loaded-plugin UI.
- There is an existing requestId-based conformer worker/client pattern.
- There is an existing ref-based command invocation pattern.
- ChemDraft already depends on OpenChemLib.
- Supported document structure formats include smiles, molfile-v2000,
  molfile-v3000, and unknown.
- The current apiVersion field is not necessarily enforcing semantic
  compatibility.

Do not silently change the task when any assumption is wrong. Report the
difference and adapt the implementation while preserving the architecture.

Repository constraints:
- Preserve chemical identity.
- Keep external engines behind adapters.
- Plugins must not directly mutate the native document.
- Do not add proprietary assets or undocumented prediction data.
- Do not silently fabricate predictions for unsupported environments.
- Keep plugin-api and plugin-host framework-neutral.
- Do not import React into plugin-api or plugin-host.
- Use pnpm workspace conventions.
- Exact-pin new third-party dependencies.
- Keep prediction local and offline.
- Do not add network permissions.
- Do not add filesystem permissions.
- Do not describe synthetic fixtures as experimental data.

PART 1: establish current runtime behavior

Add tests or documentation confirming the current plugin-host and desktop
integration state before performing the runtime refactor.

Confirm:
- no PluginHost exists in the live desktop;
- molscribe-ocsr is package-only;
- no contributed Analyze menu exists;
- no contributed panel host exists;
- no plugin list exists.

Preserve existing duplicate-registration and permission behavior.

PART 2: persistent desktop plugin runtime

Create:
- apps/desktop/src/plugins/createPluginRuntime.ts
- apps/desktop/src/plugins/registerBundledPlugins.ts
- apps/desktop/src/plugins/PluginPanelRegistry.ts
- apps/desktop/src/plugins/PluginPanelHost.tsx
- apps/desktop/src/plugins/PluginMenuModel.ts
- apps/desktop/src/plugins/PluginDiagnosticsPanel.tsx
- apps/desktop/src/plugins/usePluginHostSnapshot.ts
- supporting types where needed

Create one persistent PluginHost for the desktop.

Do not recreate it when:
- the document changes;
- selection changes;
- active page changes;
- viewport changes;
- undo history changes.

Use refs or state-provider callbacks to expose current document and selection
to the persistent host. Reuse the existing invokeCommandRef-style pattern.

The first runtime patch does not have to migrate every core command into the
plugin host. Preserve existing core command behavior. The eventual target is
one coherent command registry, but do not make a large core-command migration
a prerequisite for the first live plugin.

PART 3: bundled plugin panel registry

Keep manifest types UI-framework neutral.

Create a desktop-owned registry that associates:
- plugin ID
- panel ID
- React panel component

Support:
- register
- get
- list

Create a panel host capable of opening and closing at least one bundled plugin
panel.

Unknown panel IDs must produce a controlled diagnostic rather than crashing.

PART 4: manifest-driven menu surface

The current desktop menu system is not assumed to render plugin manifests.

Create either:
A. a plugin contribution adapter into the existing menu model; or
B. a distinct Analyze menu model for plugin contributions.

Do not import the toolset registry into plugin-host.

The desktop may combine toolset entries and plugin entries.

Menu actions must invoke commands through PluginHost.

PART 5: plugin diagnostics or loaded-plugin view

Add a small desktop view that lists successfully registered bundled plugins.

Show at least:
- plugin ID
- name
- version
- declared contributions

This may be a diagnostics panel rather than a full plugin manager.

Do not imply that arbitrary external plugins can be installed.

PART 6: use molscribe-ocsr as the runtime canary

Before adding NMR code, register the existing molscribe-ocsr package as a
bundled plugin.

Prove:
- manifest registration;
- plugin list display;
- Analyze contribution display;
- command invocation;
- trivial panel opening;
- runtime persistence after document edits.

The OCR engine itself does not need to be completed. The purpose is to verify:

manifest -> host -> menu -> command -> panel

Add integration tests for this path.

PART 7: generic selection API

Add generic selected-structure types to packages/plugin-api:

- PluginStructureFormat
- PluginSelectedStructure
- PluginSelectionAPI

Supported snapshot formats:
- smiles
- molfile-v2000
- molfile-v3000
- unknown

PluginSelectedStructure contains:
- documentId
- pageId
- objectId
- structure.format
- structure.value
- sourceFingerprint

Add selection: PluginSelectionAPI to PluginCommandContext.

The selection API must always exist on the context.

Its methods must throw PluginPermissionError when the plugin lacks
selection.read.

Extend PluginHost with a current-selection provider.

The provider must return immutable snapshots rather than live document object
references.

The desktop selection provider must:
1. locate the active page;
2. read selected object IDs;
3. retain only molecule objects;
4. copy structure format and payload;
5. compute a deterministic source fingerprint.

Compute the initial source fingerprint from:
- document ID
- page ID
- object ID
- structure format
- trimmed structure payload

Document that this fingerprint is for source-change detection and is not a
canonical chemical identifier.

PART 8: generic analysis API

Add generic types to packages/plugin-api:

- PluginAnalysisSource
- PluginAnalysisProvenance
- PluginAnalysisWarning
- PluginAnalysisRecordInput<T>
- PluginAnalysisRecord<T>
- PluginAnalysisQuery
- PluginAnalysisAPI

Add analysis: PluginAnalysisAPI to PluginCommandContext.

Support:
- write
- list
- getLatest

The host assigns:
- analysis ID
- plugin ID
- createdAt

Implement an in-memory AnalysisStore in plugin-host.

Required behavior:
- deep-copy writes;
- return copied or immutable records;
- filter by plugin ID;
- filter by analysis type;
- filter by document ID;
- filter by page ID;
- filter by object ID;
- return newest matching record deterministically;
- support subscriptions;
- use the host’s injectable clock;
- enforce analysis.write on writes.

Define the initial analysis-read policy explicitly. Prefer allowing a plugin to
read its own records while allowing the trusted desktop to render all records.

Analysis results are derived session data.

Do not put them in the native ChemDraft document.

Do not create proposed document patches.

PART 9: contribution discovery

Add PluginHost methods for:
- listRegisteredPlugins
- listCommandContributions
- listMenuContributions
- listPanelContributions
- listAnalyzerContributions
- subscribe

Every returned contribution includes its plugin ID.

Reject or report contributions that reference an unknown command.

Do not import React into plugin-host.

PART 10: create NMR plugin package

Create:
examples/plugins/nmr-predictor

Use package name:
@chemdraft/plugin-nmr-predictor

Organize into:
- domain
- application
- providers
- worker
- ui
- tests

Required working provider:
providers/fixture/FixtureHosePredictor.ts

Optional later providers:
- providers/ocl/OclHosePredictor.ts
- providers/cheminfo/CheminfoHosePredictor.ts

Do not make either optional provider necessary for Phase 1.

PART 11: NMR domain contracts

Implement:
- NmrNucleus = "1H" | "13C"
- ChemicalStructureInput
- NmrPredictorCapabilities
- NmrPredictionOptions
- NmrPredictionRequest
- NmrAtomReference
- NmrPredictionEvidence
- NmrPredictionUncertainty
- NmrResonance
- NmrPredictionBackend
- NmrPredictionWarning
- NmrPredictionResult
- NmrPredictor

NmrPredictor exposes:
- getCapabilities()
- predict(request, signal?)

ChemicalStructureInput accepts only:
- smiles
- molfile-v2000
- molfile-v3000

It must not accept unknown.

NmrAtomReference may contain:
- sourceAtomIndex
- element
- equivalentCount
- backendAtomId
- optional reserved chemDraftAtomId

Do not claim provider atom indices are stable ChemDraft atom IDs.

Do not implement viewport atom highlighting.

All worker results must be serializable plain data.

PART 12: structure normalization

Create an application-level structure normalizer.

Use ChemDraft’s existing OpenChemLib dependency.

Handle:
- SMILES -> OCL molecule
- V2000 molfile -> OCL molecule
- V3000 molfile -> OCL molecule

Reject:
- unknown
- empty payload
- parse failure

Stable errors:
- NMR_UNSUPPORTED_STRUCTURE_FORMAT
- NMR_EMPTY_STRUCTURE
- NMR_STRUCTURE_PARSE_FAILED

Preserve or warn about:
- formal charge
- isotopes
- radicals
- stereochemistry

Determine implicit hydrogen counts deterministically.

Produce an atom-index map where feasible, but do not expose a stable ChemDraft
atom identity unless it has been verified.

PART 13: fixture-backed predictor

Create a ChemDraft-owned deterministic fragment fixture database.

Include a small set of documented test molecules or atom environments.

Suitable fixtures:
- benzene
- toluene
- acetone
- ethanol
- ethyl acetate
- acetonitrile
- cyclohexane
- anisole
- one para-disubstituted aromatic
- one partially unsupported structure

Prefer environment-based matching over whole-molecule canned spectra.

A minimal fixture environment may use:
- nucleus
- central element
- aromaticity
- formal charge
- bond orders
- first-shell neighbor elements
- optional second-shell signature

Label the method:
fixture-fragment

Synthetic fixture values must:
- be explicitly labeled synthetic;
- include a fixture data version;
- never be represented as validated experimental predictions.

The provider must:
- predict 13C;
- optionally predict 1H;
- group equivalent environments;
- provide deterministic shifts;
- provide deterministic support metadata;
- provide warnings;
- return partial results when only part of a molecule matches;
- never invent shifts for no-match environments.

Default to 13C.

Mark 1H as experimental.

PART 14: Web Worker

Follow the existing conformer worker/client pattern.

Implement request types:
- initialize
- predict
- cancel

Implement response types:
- ready
- result
- cancelled
- error

Every message has requestId.

Lazy-load the provider and its data.

Allow one active request per client.

When a newer request begins:
- cancel or supersede the older request;
- ignore any late result from the older request.

Normalize exceptions into stable error codes.

Do not use:
- fetch
- XMLHttpRequest
- WebSocket
- remote dynamic import
- filesystem access

Add tests that replace fetch and XMLHttpRequest with throwing spies.

PART 15: NMR manifest

Use:

id: org.chemdraft.nmr-predictor
name: NMR Predictor
version: 0.1.0
apiVersion: 0.1.0

Permissions:
- selection.read
- analysis.write
- ui.menu
- ui.panel
- plugin.storage

Do not request:
- document.read
- document.write
- document.proposePatch
- network.fetch
- native.execute
- ml.inference
- model.load
- model.download
- filesystem.read
- filesystem.write

Contribute:
- command nmr.predictSelectedStructure
- Analyze menu item
- panel nmr.predictionPanel
- analyzer nmr.forwardPrediction

Do not claim apiVersion compatibility has been semantically verified unless
the host actually implements that validation.

PART 16: command flow

The command must:
1. call context.selection.getSelectedStructures();
2. require exactly one molecule;
3. reject unknown structure format;
4. normalize the structure;
5. open the NMR panel;
6. invoke the worker-backed NmrPredictor;
7. normalize the provider result;
8. write an analysis record through context.analysis;
9. return the result.

Stable errors:
- NMR_NO_SELECTED_STRUCTURE
- NMR_MULTIPLE_SELECTED_STRUCTURES
- NMR_UNSUPPORTED_STRUCTURE_FORMAT
- NMR_EMPTY_STRUCTURE
- NMR_STRUCTURE_PARSE_FAILED
- NMR_PROVIDER_INITIALIZATION_FAILED
- NMR_PROVIDER_FAILURE
- NMR_PREDICTION_CANCELLED

A partially supported structure produces a partial analysis, not a total
failure.

PART 17: NMR panel

Implement:
- selected object information
- source structure format
- provider ID
- provider version
- data version
- 13C checkbox enabled by default
- 1H checkbox disabled by default or visibly marked experimental
- Predict button
- Cancel button
- loading state
- warning list
- fixture-data notice
- reversed-axis SVG stick spectrum
- prediction table
- stale-result indicator

Default axes:
- 1H: 12 to 0 ppm
- 13C: 220 to 0 ppm

Expand the range when predictions fall outside the default.

Stick height may represent predicted equivalent nuclei.

Label this clearly as predicted equivalent nuclei, not integration.

The table must show:
- nucleus
- delta ppm
- equivalent nuclei
- source atom indices
- matched environment sphere or level
- sample count
- standard deviation or range
- flags

Do not display:
- multiplicity
- J values
- realistic line shapes
- experimental integration
- solvent-corrected values
- confidence percentages

unless a future provider genuinely supplies scientifically supported values.

PART 18: staleness

Read the latest NMR analysis associated with the selected object.

Compare its source fingerprint with the current selected-structure
fingerprint.

When they differ:
- keep the old result visible;
- mark it stale;
- offer Predict again.

Rerunning creates a new analysis record rather than mutating the previous
record.

PART 19: warning codes

Implement stable codes for:
- unsupported structure format
- empty structure
- parse failure
- unsupported elements
- charge
- radicals
- isotopes
- stereochemistry not modeled
- solvent not modeled
- conformers not modeled
- labile protons omitted
- no fragment match
- low environment radius match
- small reference population
- partial prediction
- fixture data
- experimental proton model
- provider initialization failure
- provider failure
- cancellation
- stale result

Never assign a fabricated shift when no environment matches.

PART 20: optional OCL-native predictor investigation

After the fixture provider works end-to-end, evaluate an OCL-native local
fragment predictor.

Reuse the OpenChemLib version already in ChemDraft.

Investigate:
- atom-centered layered graph environments
- aromaticity
- formal charge
- implicit hydrogens
- equivalent-atom grouping
- stereochemical distinctions
- local database format
- atom-index preservation
- worker performance

Keep it behind NmrPredictor.

Do not acquire or redistribute a reference database without documented terms.

PART 21: optional nmr-predictor compatibility investigation

This is a separate investigation, not a Phase 1 requirement.

Before installation run:
pnpm view nmr-predictor version license dependencies peerDependencies optionalDependencies dist-tags --json
pnpm why openchemlib
pnpm why openchemlib-extended

Exact-pin any tested version.

Import nmr-predictor only inside:
providers/cheminfo

Do not call:
- fetchProton
- fetchCarbon
- spinus
- fetch
- XMLHttpRequest

Supply data locally.

Inspect:
- duplicate OpenChemLib versions
- Node built-in imports
- process assumptions
- Buffer assumptions
- global mutation
- dynamic require
- worker compatibility
- bundle size
- module format

Stop treating the package as a planned provider when it requires:
- broad Node polyfills;
- changes to browser globals;
- weakening bundler checks;
- replacing ChemDraft’s existing OCL version;
- remote database access;
- undocumented data redistribution;
- main-thread prediction.

A failed compatibility investigation is an acceptable outcome.

Document the exact reason.

PART 22: prediction-data provenance

Add:
- THIRD_PARTY_NOTICES.md
- docs/architecture/nmr-prediction-data.md

For every data asset document:
- name
- version
- source
- license
- redistribution terms
- modifications
- number of records
- nuclei
- solvent/reference conventions
- validation status

Do not assume an MIT code license grants rights to bundled NMR databases.

Phase 1 fixture data must be ChemDraft-owned and labeled synthetic.

PART 23: tests

Runtime:
- persistent host
- molscribe canary registration
- menu contribution
- panel contribution
- plugin diagnostics
- runtime survives document edits

Plugin API/host:
- selection permission
- analysis permission
- immutable snapshots
- deterministic fingerprints
- host-generated record fields
- deep-copy storage
- query filtering
- latest-result behavior
- subscriptions
- contribution enumeration

Normalization:
- SMILES
- V2000
- V3000
- unknown rejection
- empty rejection
- invalid input
- charge/isotope/stereochemistry warnings
- deterministic implicit hydrogens

Fixture predictor:
- deterministic 13C
- optional experimental 1H
- equivalent groups
- partial results
- no-match warnings
- fixture notice
- provider provenance
- no network

Worker:
- initialization
- result
- cancellation
- late-response suppression
- disposal
- normalized errors
- throwing fetch/XMLHttpRequest spies

Desktop NMR integration:
- plugin registration
- Analyze item
- panel opening
- no-selection error
- multiple-selection error
- unsupported-format error
- analysis write
- no document patch
- unchanged native document
- reversed axis
- 13C default
- 1H experimental label
- fixture notice
- prediction table
- stale-result behavior
- rerun creates new record

Run:
- pnpm lint
- pnpm test
- the appropriate web build
- pnpm build when the local Tauri/Rust environment supports it

PART 24: documentation

Add:
- examples/plugins/nmr-predictor/README.md
- examples/plugins/nmr-predictor/THIRD_PARTY_NOTICES.md
- docs/architecture/plugin-runtime.md
- docs/architecture/nmr-predictor-plugin.md
- docs/architecture/nmr-prediction-data.md

Document:
- actual pre-change runtime state
- molscribe canary
- persistent host
- menu and panel integration
- generic selection API
- generic analysis API
- structure normalization
- predictor interface
- worker boundary
- fixture-data limitations
- 13C versus 1H defaults
- lack of solvent modeling
- lack of conformer modeling
- lack of coupling prediction
- atom-identity limitation
- OCL-native extension path
- nmr-predictor compatibility result
- data licensing status
- future spectrum-import, matching, ranking, and inverse-prediction extensions

Final implementation report:
- summarize files changed;
- identify the runtime changes separately from the NMR changes;
- list exact dependency versions;
- identify whether nmr-predictor was tested;
- report any duplicate-OCL or bundling problem;
- report prediction-data provenance;
- report tests and builds run;
- report unsupported local toolchains;
- do not claim experimental accuracy that was not benchmarked;
- do not describe fixtures as a useful scientific predictor.
```
