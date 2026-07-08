# NMR predictor plugin

`@chemdraft/plugin-nmr-predictor` (`examples/plugins/nmr-predictor`) — ChemDraft's
first real analyzer plugin. It predicts ¹H/¹³C shifts for a selected structure and
shows them in a declarative panel. This documents how the package is put together;
the generic runtime it sits on is in [plugin-runtime.md](plugin-runtime.md), and
its data/licensing in [nmr-prediction-data.md](nmr-prediction-data.md).

## Package layout

```
src/
├── manifest.ts        contributions: two commands (¹³C default, ¹H experimental),
│                      two Analyze menu items, one panel, one analyzer
├── register.ts        createNmrRegistration → { commandHandlers, onPanelClosed }
├── index.ts           public surface
├── domain/            framework/provider-neutral contracts (serializable)
│   ├── contracts.ts   NmrPredictor, request/result, resonances, NormalizedMolecule
│   ├── errors.ts      NMR_* hard-failure codes + NmrError
│   ├── warnings.ts    NMR_* warning codes + nmrWarning()
│   ├── schemas.ts     zod validators (worker/store serializability)
│   └── fingerprint.ts createStructureSourceFingerprint reuse
├── application/       orchestration
│   ├── normalizeStructure.ts   OCL parse boundary (+ reject "unknown"/empty)
│   ├── mapSelection.ts         selected molecule → ChemicalStructureInput
│   ├── determineAnalysisStatus.ts  complete / partial / failed
│   ├── workerPredictor.ts      NmrWorkerClient → NmrPredictor adapter
│   └── predictSelectedStructure.ts  the command
├── providers/
│   ├── fixture/       deterministic synthetic provider (tests / offline)
│   └── ocl/           OCL-native NMRShiftDB2 predictor (default)
├── worker/            protocol + core handler + entry + client
└── report/            declarative panel composition + stick-spectrum SVG
```

There is no `ui/` folder and no React dependency: "UI" is pure report composition
(strings + an SVG string) that unit-tests in Node.

## The predictor interface

Every provider implements one contract, so the command, worker, and panel are
provider-agnostic:

```ts
interface NmrPredictor {
  getCapabilities(): NmrPredictorCapabilities | Promise<…>;
  predict(request: NmrPredictionRequest, signal?: AbortSignal): Promise<NmrPredictionResult>;
}
```

`NmrPredictionResult` is fully JSON-serializable (no OCL instances, functions, or
cycles): resonances (δ, equivalent nuclei, atom refs, uncertainty, evidence),
warnings, a `backend` (id/version/method + optional data provenance), and the
`sourceFingerprint`.

## Providers

- **`OclHosePredictor` (default).** Reuses ChemDraft's OpenChemLib to derive each
  atom's environment code, looks it up in a compiled NMRShiftDB2 database
  **deepest-sphere-first with fallback**, and reports the aggregated median +
  dispersion + sample count + matched sphere. It **warns rather than fabricates**
  when coverage is thin. Method `hose-fragment`.
- **`FixtureHosePredictor`.** Deterministic synthetic data over a small
  environment table; used for tests and as an offline/no-`Worker` fallback. Method
  `fixture-fragment`.

Provider selection: the worker core picks OCL unless `initialize`'s `providerId`
is `chemdraft.fixture-hose`. The desktop uses the worker-backed predictor where
`Worker` exists, else an in-thread `OclHosePredictor`.

## Normalization

`normalizeStructure` parses SMILES / molfile with OCL, rejects `unknown`/empty
(`NMR_UNSUPPORTED_STRUCTURE_FORMAT` / `NMR_EMPTY_STRUCTURE`) and unparseable input
(`NMR_STRUCTURE_PARSE_FAILED`), materializes ring/aromaticity perception, and
returns the OCL molecule as the internal object plus a serializable summary. Both
providers share the same environment-code generator, which produces **identical
codes for explicit-H molfiles and implicit-H SMILES** — the invariant that lets a
molfile-built database match live SMILES selections.

## The command (M8)

`predictSelectedStructure` (via `createNmrRegistration`): validates the selection
(exactly one molecule; permission-gated), maps it to a prediction input, shows a
"predicting…" panel, drives the predictor, writes an `nmr.forward-prediction`
record (status complete/partial/failed) to the analysis store, and shows the
result panel. It returns a `PluginCommandResult` (never throws for expected
conditions); cancellation writes nothing and leaves the panel. ¹³C and ¹H are
**separate value-encoded commands** (ADR-0011), not an argument.

## The panel (M9)

`composePredictionReport` builds a declarative report: a **stick-spectrum SVG**
(reversed ppm axis), a shift table, notice sections for warnings, a "Reference
database" provenance section, and an experimental-vs-synthetic note. The desktop
adds chrome (title, Close, "Run again"), a staleness banner, and panel-close
cancellation.

## Testing

The package has ~72 unit tests: environment codes, fixture predictor, OCL
predictor (incl. an ingestion→predict round-trip and real-database provenance),
normalization, worker protocol + client, the command (guards, record write,
cancellation), report composition, and the manifest. Desktop integration is in
`apps/desktop/src/plugins/MainWindow.plugins.dom.test.ts`.
