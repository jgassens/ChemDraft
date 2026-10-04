# @chemdraft/rdkit-adapter

`@chemdraft/rdkit-adapter` is ChemDraft's real RDKit implementation: analysis and
ETKDGv3 conformers run on the vendored, custom RDKit MinimalLib WebAssembly build in
[`vendor/`](vendor/). It implements the engine-neutral contract in
`@chemdraft/chemistry-adapter`; the pure analysis result and method-contract types are
owned by `@chemdraft/analysis-core`. It is an engine adapter, not a document or UI
package, as required by AGENTS.md §6 Package boundaries.

## Entry points

| Import | Exports and intended caller |
| --- | --- |
| `@chemdraft/rdkit-adapter` | The browser or worker-facing barrel. It groups the analysis API, whose reports cover composition, mass, descriptor, pKa, and ionization methods (`analyzeStructure`, `analyzeStructureDetailed`, `AnalyzeStructureRequest`, `DetailedAnalysis`); composition helpers (`compositionFromRdkitJson`, `hillFormula`, `DerivedComposition`); conformers and loader registration (`generateSmiles2DMolfile`, `generate3DConformerProgressive`, `rdkitConformerGenerator`, `setRdkitModuleLoader`, `ensureRdkit`); isotope-envelope building (`computeEnvelope`, `isotopeEnvelopeContract`, `ISOTOPE_ENVELOPE_METHOD_ID`); derived interpretations (`deriveInterpretation`, `sourceInterpretation`); and RDKit method contracts (`rdkitMethodContracts`, `PINNED_RDKIT_VERSION`, `PINNED_RDKIT_WASM_SHA256`). It also re-exports the legacy adapter entry point. Engine-bound calls reject with `RdkitNotConfiguredError` until a loader is registered, but pure helpers such as `hillFormula`, `compositionFromRdkitJson`, and `rdkitMethodContracts` do not need one. The barrel statically reaches the pKa model through its analysis export, which is why the lighter `./constants` entry exists. |
| `@chemdraft/rdkit-adapter/adapter` | `createRdkitAdapter`, `rdkitAdapterCapabilities`, and `rdkitAdapterStatus`. Use this narrower compatibility shim for the `ChemistryAdapter` contract; its methods load analysis on demand. |
| `@chemdraft/rdkit-adapter/identifiers` | `computeStructureIdentifiers` and `StructureIdentifiers`. Use for engine-provided canonical SMILES, InChI, and InChI Key from a molblock. |
| `@chemdraft/rdkit-adapter/constants` | `ISOTOPE_ENVELOPE_METHOD_ID`, `PINNED_PKA_MODEL_SHA256`, `PINNED_RDKIT_VERSION`, `PINNED_RDKIT_WASM_SHA256`, `SOURCE_INTERPRETATION_ID`, and `sourceInterpretation`. Use when constants or the source interpretation are needed without importing the analysis barrel. |
| `@chemdraft/rdkit-adapter/node` | `installNodeRdkitModuleLoader`. Node callers use it to install the RDKit and IsoSpec loader setup. |
| `@chemdraft/rdkit-adapter/testing` | `installRealRdkitModuleLoader`. Tests use it to install the vendored Node loaders before exercising the real engine. |

The main entry point exposes the public analysis API rather than direct pKa or
ionization implementation helpers. Analysis results carry method contracts,
interpretations, warnings, and statuses; a method can decline with an unsupported
status. This keeps the adapter aligned with AGENTS.md §8 Analysis and prediction
claims.

## Loading

Importing this package never instantiates RDKit. The adapter holds a registered
`RdkitModuleLoader`; the engine is created only when `ensureRdkit` calls that loader,
and the resulting module is cached. AGENTS.md §13 Security, errors, and performance
asks that RDKit load lazily and never at startup.

One path starts it soon after launch. When the document window opens,
[`apps/desktop/src/MainWindow.tsx`](../../apps/desktop/src/MainWindow.tsx) schedules a
conformer-worker warm-up with `requestIdleCallback` (1500 ms timeout; a 600 ms timer
where that call is missing). The warm-up calls `currentEngine()` with the default
`auto` preference, whatever engine the user has chosen, and that calls `ensureRdkit`.
So RDKit is created in the conformer worker, off the main thread, within about 1.5
seconds of the window opening and without any user action.

In desktop browser and Web Worker code,
[`apps/desktop/src/rdkitWasmLoader.ts`](../../apps/desktop/src/rdkitWasmLoader.ts)
uses Vite's `?raw` import for `RDKit_minimal.js` and `?url` import for
`RDKit_minimal.wasm`. `registerRdkitWasmLoader` evaluates the UMD glue to obtain its
factory, supplies the emitted WASM URL, and first tries to fetch bytes for the
factory's `wasmBinary` option before falling back to the glue's own loading path.
Registration does not instantiate the module.

[`apps/desktop/src/analysisWorker.ts`](../../apps/desktop/src/analysisWorker.ts)
registers the RDKit and IsoSpec loaders once when it first handles a non-cancellation
request, rather than at module scope; its warm-up and analysis requests then call
`analyzeStructure`. The module remains resident in that worker after its first
initialization. [`apps/desktop/src/conformerWorker.ts`](../../apps/desktop/src/conformerWorker.ts)
calls `registerRdkitWasmLoader()` at worker module scope. Its `ensureRdkit` probe is
triggered by the document-window idle warm-up and by Spin 3D conformer requests with
the `auto` or `rdkit` preference while RDKit has not yet been probed; initialization is
deferred until then.

In Node,
[`src/node.ts`](src/node.ts)'s `installNodeRdkitModuleLoader` installs the Node IsoSpec
loader and an RDKit loader. The latter reads the vendored glue source and WASM bytes,
constructs the Emscripten factory with Node's `require` context, and provides the
artifact path and bytes to the factory. Installation is process-wide and idempotent;
it reads the bootstrap assets, but instantiation still waits for `ensureRdkit`.

## Consumers

The desktop app uses the adapter in its analysis and conformer workers, and the
loader above supports those workers. Other production desktop importers are
[`MainWindow.tsx`](../../apps/desktop/src/MainWindow.tsx),
[`analysisClient.ts`](../../apps/desktop/src/analysisClient.ts),
[`moleculeSmiles.ts`](../../apps/desktop/src/moleculeSmiles.ts),
[`smilesListPaste.ts`](../../apps/desktop/src/smilesListPaste.ts), and the plugin
integration modules
[`plugins/pluginChemistry.ts`](../../apps/desktop/src/plugins/pluginChemistry.ts)
and [`plugins/pluginStructureRecognition.ts`](../../apps/desktop/src/plugins/pluginStructureRecognition.ts),
which both route their dynamic adapter imports through `loadRdkitWithAppLoader` in
[`plugins/rdkitAppLoader.ts`](../../apps/desktop/src/plugins/rdkitAppLoader.ts). It
registers the app's WASM loader before handing back the imported adapter.

The CLI installs the Node engines through
[`packages/chemdraft-cli/src/engine.ts`](../chemdraft-cli/src/engine.ts).
[`packages/chemdraft-cli/src/commands/analyze.ts`](../chemdraft-cli/src/commands/analyze.ts)
uses `analyzeStructureDetailed`; the CLI's document and export modules and its reaction
command also import adapter entry points or types.
`packages/document-workflow-core/src/moleculeSmiles.ts` exposes the
`ComputeStructureIdentifiers` type at the package boundary rather than loading the
engine itself.

## Dependencies and boundary

This package depends on `@chemdraft/analysis-core`,
`@chemdraft/chemistry-adapter`, and `@chemdraft/isospec-adapter`. The dependency
direction is deliberate: `@chemdraft/isospec-adapter` must never depend on this
package. `src/envelope.ts` builds isotope-envelope results by combining RDKit-derived
composition with IsoSpec distribution data; that builder belongs here, not in the
IsoSpec adapter. The adapter must not add a second chemistry interpretation engine;
AGENTS.md §8 Analysis and prediction claims keeps composition, charge, and mass with
RDKit.

## Vendored build and licence

`vendor/` contains `RDKit_minimal.js`, `RDKit_minimal.wasm`, the seven local patches,
[`BUILD.md`](vendor/BUILD.md), and
[`RDKit-LICENSE.txt`](vendor/RDKit-LICENSE.txt), as well as the pKa-model assets.
`vendor/BUILD.md` is the rebuild record for the custom MinimalLib artifact, including
its pin, patches, build procedure, and artifact hashes. The RDKit licence file is the
full licence text for the vendored build.

RDKit MinimalLib and IsoSpec have entries in the repository
[`NOTICE`](../../NOTICE) and
[`dependency inventory`](../../docs/architecture/dependency-inventory.md). Any new
vendored binary must update both records in the same change, following
AGENTS.md §4.7 Licensing and redistribution.

## Testing

Run this package's unit and real-engine suites with:

```bash
pnpm vitest run packages/rdkit-adapter/src
```

The root Vitest configuration includes `packages/**/*.test.ts`, so it includes both
plain `*.test.ts` files and `*.real.test.ts` files. Plain tests cover pure helpers,
contracts, and loader behavior without necessarily initializing RDKit. Suites that
need the engine install `installRealRdkitModuleLoader` in their setup, then run the
vendored RDKit and IsoSpec builds through Node; suites that reset the adapter pair
that setup with `resetRdkitForTesting`. AGENTS.md §14 Testing and verification expects
every meaningful change to add or update tests in its area.
