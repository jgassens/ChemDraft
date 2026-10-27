# Bounded 2D depiction

The synchronous CoordGen WASM call used to run in the document window during SMILES paste.
Large carbocycles could occupy that thread for minutes. All paste/insert coordinate generation,
including the existing OpenChemLib fallback and stereo perception, now runs in a terminable worker.

## Guard and worker lifetime

`rdkit-adapter/src/conformer.ts` reads RDKit's `rdkitRepresentation.atomRings` (SSSR) from
`get_json()` before generating the optional CoordGen candidate. Any ring over 30 atoms skips that
candidate. The standard RDKit layout, isomeric-identity checks, candidate preference, and horizontal
orientation policy are unchanged. The 30-atom boundary still permits CoordGen. Unreadable ring
information disables it; legacy injected mocks without `get_json()` retain their old behavior.

CoordGen eligibility is deterministic from the parsed graph: at most 80 atoms and 100 bonds
summed over the whole input, at most 30 atoms in any SSSR ring, and at most 120 summed SSSR
ring memberships per component. The 30-atom ring
boundary and the 63-atom polyether fixture remain eligible. Larger or more cyclic graphs use the
standard layout. These conservative size limits keep the optional candidate comfortably below the
layout budget on the measured fixtures; the deadline remains a safety net for pathological inputs
or host load, never an algorithm-selection heuristic.

The shared `createDepictionWorkerClient` serializes requests. A new worker has a bounded 10-second
bootstrap period that includes RDKit WASM fetch/compilation/initialization and the OpenChemLib import.
It waits for both initialization attempts to settle and posts `ready` if either engine loaded.
A failed RDKit initialization is remembered for the worker's lifetime: later requests skip all
RDKit calls, including validation/canonicalization, and use OpenChemLib with a warning naming the
RDKit load failure. If only OpenChemLib fails to load, RDKit still provides layouts, with a warning
that stereo center counts are unavailable. Only both engines failing makes bootstrap fail.
The client sends no layout request before readiness. Each active layout attempt then has its own
2-second deadline; bootstrap and queue waiting
do not consume the layout budget. The worker publishes an identity-checked standard result
**before** entering CoordGen. At a layout deadline the caller terminates the worker and returns
that standard result **with a warning**. If no standard result exists, it retries standard/OCL-only
layout once in a fresh worker, with a separate bootstrap cap and layout deadline. A successful retry
also carries a warning; a second layout timeout fails specifically. The retry mainly helps transient
host load: a deterministically stuck standard layout may fail again. Engine bootstrap failures do not
trigger this retry. No generator runs on the calling/UI thread.

Workers remain alive for 60 seconds of idleness. Node workers and their idle timers are unreferenced
so CLI commands exit promptly; active requests keep the worker referenced. Transport errors preserve
chemistry-refusal and explicit not-SMILES markers. Errors during bootstrap report that the 2D
depiction worker failed to load; errors after readiness report that it stopped unexpectedly.
A crash after the standard layout arrived returns that layout with a warning. `messageerror`
reports an unreadable worker reply. Idle error/exit listeners discard dead workers immediately,
so the next request starts a new worker without spending a layout deadline on the dead transport.
Failed workers are discarded before queued work continues.

Each request accepts an `AbortSignal`: queued cancellation removes just that request; active
cancellation terminates its worker and allows the queue to continue on a fresh worker. SMILES lists
accept a signal and check it between entries, and submit entries at background priority. Interactive
single pastes pass queued background entries without preempting an active layout. Plugin structure
insertion and the CLI depiction entry also accept optional signals. MainWindow aborts a pending
SMILES list on another paste, document switch/close, or unmount and ignores its late results/status.
The plugin runtime supplies command-scoped signals to default structure builders (including the
request-bound chemistry services); ending or unregistering the command's plugin aborts pending
depiction. Injected custom providers retain their existing contract.

The document window uses a dedicated lazy module worker, following the existing conformer worker's
Vite URL/loader pattern without sharing its long-running 3D queue. `worker.format: "es"` remains
unchanged in `vite.config.ts`. Node hosts use `worker_threads` and the existing `tsx` loader; no new
dependency, network access, platform branch, or capability is involved. The desktop Node transport and loader bootstrap live under `apps/desktop/src/test/`; they are
used only by Node tests and kept out of the web bundle. The desktop client imports the shared
transport through `@chemdraft/rdkit-adapter/depiction`, avoiding the analysis barrel and its pKa
model on the UI thread. The CLI/MCP worker runs the complete existing RDKit/OCL depiction chain.

## Caller audit

| Caller or surface | Result |
| --- | --- |
| `smilesListPaste.ts: depictSmilesForPaste`, called by MainWindow's single-SMILES paste | Dispatches `depiction2d/client.ts`. Explicit parser/chemistry refusals or an empty graph permit text fallback; engine failures reach MainWindow's existing status path without inserting text. Deadline warnings are shown in the paste status. |
| `smilesListPaste.ts: depictSmilesListCandidates` | Each entry uses the same bounded client with background priority and cancellation. Progress and per-entry chemistry refusals remain; engine failures surface specifically, and deadline warnings travel with the result. |
| `plugins/pluginChemistry.ts: structureFromSmilesForPlugin` | Uses the same worker client; object building and permission/patch handling remain in the host. Deadline warnings are retained in the object's compatibility warning. |
| Insert Name / OPSIN | `nameToStructureForPlugin` only obtains SMILES from the native OPSIN process. The installed plugin builds its object through `chemistry.structureFromSmiles`, covered above. No 2D generation occurs in name conversion itself. |
| In-app assistant tools and local assistant MCP | `assistant/writeBuilder.ts` calls `context.chemistry.structureFromSmiles`; runtime wiring reaches the bounded plugin host function. |
| In-app agent bridge | Paste reaches MainWindow's existing paste route. No additional bridge gate or API was added. |
| Templates | Native template placement uses predefined editable graphs and shared layout functions. Search found no RDKit/CoordGen/OCL 2D invocation in the template paths; no change needed. |
| `chemdraft-cli/src/document.ts: depictSmiles` | Dispatches `depictionClient.ts`'s Node worker after existing layout-free input admission. The old engine chain is now the worker-only `depictSmilesInWorker`; it publishes a complete standard result before CoordGen. |
| CLI `render`, `document`, `grid`, `reaction`, `export`, `stereo`, `nmr`, and rendered name conversion | Their shared `buildSmilesDocument`/`depictSmiles` path inherits the ring guard and deadline. |
| Standalone MCP server | Calls the CLI modules in-process, which now dispatch the Node worker. No separate MCP implementation or edits were needed. |
| `rdkit-adapter/src/ionization.ts: depictionFor` | Uses the same size guard. `AnalyzeStructureRequest.includeDepiction` explicitly controls the optional depiction, defaulting to true for worker/headless callers. The legacy chemistry adapter passes false because it can run on the document thread and does not consume the depiction. No global window/document sniffing: a concurrent PDF export installing JSDOM cannot suppress an MCP analysis depiction. |
| Direct generator calls in tests | Remain headless fixture/engine tests; the production generator callers are the desktop and CLI worker entries listed above. |

## Measurements and identity

Representative local macOS Node/vendored-WASM measurements, milliseconds, with engines warm:

| Input | Prior CoordGen | Guarded RDKit result | Paste worker round trip |
| --- | ---: | ---: | ---: |
| 30-carbon ring | 78 locally; about 330 in the original report | 139 | 88 |
| 38-carbon ring | 39–40 seconds in the report | 1.7 | 9.8 |
| 60-carbon ring | over 75 seconds in the report | 2.5 | 9.9 |
| 100-carbon ring | main window froze for 14+ minutes in the report | 7.4 | 204 |
| 36-crown-12 | 11.9 locally | 1.4 | 5.2 |

The unsafe old 38/60/100-ring cases were also rechecked in isolated Node workers and terminated
after two seconds; the much longer prior figures above are the user's measurements, not new runs.
Timings vary with host load: the required package suite measured the guarded 30/38/60/100/crown
layouts at 359/1.9/2.9/6.4/1.3 ms and a complete CLI 100-ring SVG+PNG render at 955 ms.

Tests require the warm macrocycle layouts to complete within three seconds and compare canonical
isomeric SMILES using RDKit. Adjacent three-digit V2000 atom/bond counts were fixed on main in
#220 (`53616751`). Large cyclic graphs now use the normal V2000 serialization; only dative bonds
require V3000 here. A >=100-atom/100-bond regression verifies that stored unspecified E/Z survives
the current-graph CTAB comparison. Structured OCL fallback remains for other molfile limitations.

Normal successful layouts use the same graph-based eligibility and candidate preference on cold
and warm workers. Worker-path tests compare identical molfile bytes for representative fused,
tetrahedral-stereo, and macrocycle SMILES. Pinned-WASM SHA-256 fixtures retain the original bytes
for ethanol, one tetrahedral stereoisomer, benzene, decalin, and the 63-atom polyether. This is
fixture coverage, not a universal byte-identical guarantee across engines, versions, or hosts.
A safety deadline can return a different standard layout or a standard-only retry; that exceptional
result always carries a warning and is excluded from the normal byte-equality guarantee.

Tests also cover engine readiness before dispatch, independent bootstrap/layout budgets, one fresh
standard-only retry, timeout warnings, idle reuse, Node process exit, active/queued cancellation,
interactive priority, browser load/message errors, UI failure status without text insertion, and
explicit ionization depiction policy with a global JSDOM window present.

Review regression coverage:

| Item | Verification |
| --- | --- |
| 1. Partial engine bootstrap failure | Desktop `depiction2d/workerBootstrap.test.ts` and CLI `depictionWorkerBootstrap.test.ts` stub RDKit initialization failure, request two OCL layouts, check the warning and single RDKit initialization call. Both also cover OCL-only failure and both engines failing. |
| 2. Lightweight UI import | Production web build with `--manifest`: `assets/depiction-z76dDnYP.js` is 2,896 bytes and its manifest entry has no imports or dynamic imports. The separate `assets/analysis-OUOD2pk7.js` is 4,166,323 bytes; importing depiction cannot fetch it. These filenames identify this local verification build. |
| 3. Crash fallback and idle death | `rdkit-adapter/src/depictionWorkerClient.test.ts` preserves an arrived standard layout with a crash warning, and verifies immediate creation/dispatch after an idle exit notification. |
| 4. Load versus crash text | The same transport suite checks empty and detailed errors before/after readiness. |
| 5. Production cancellation | `test/depictionPaste.dom.test.tsx` dispatches real DOM paste/close events while the first list item waits, verifies abortion and no remaining entries/insertion/stale failure status. `plugins/createPluginRuntime.test.ts` verifies pending default structure generation is aborted on successful and throwing command completion. |
| 6. Cancel between timeout and retry | The transport suite fires the deadline synchronously, aborts before its rejection microtask runs, and requires `AbortError`/`cancelled` with no second worker. |
| 7. Guard/fallback/retry documentation | Limits above match `coordGenWithinSizeGuard`: atom/bond totals are over the whole input; ring-membership limits remain per component. Bootstrap fallback and the transient-load purpose of retry are documented above. |

The build stamp remains `10.26.22.10-codex` in this review fix. MainWindow changes add one abort
controller ref with unmount cleanup, pass its signal to list depiction, ignore cancelled completions,
and abort at existing paste and document-session/close entry points (12 additions, one deletion).

## Verification limits

Automated verification runs on macOS. Windows native/WebView2 execution and a hands-on macOS native
launch remain unverified. No network access or dependency installation is permitted for this task;
missing dependency directories are symlinked from the owner's existing checkout.

Before integration, run the packaged app on both platforms and paste each ring size and crown
ether, then repeat through a SMILES list, Insert Name, and plugin structure insertion. Confirm that
menus and drawing remain responsive, check the deadline/failure notices, cancel a long list through
its caller-provided signal, and verify CLI/MCP rendering and process exit on Windows. This is the
recommended next task. Automated checks alone do not verify a launched native window.

Review checks passed on macOS: `pnpm lint`; `pnpm vitest run packages/rdkit-adapter
packages/chemdraft-cli --maxWorkers=2` (1,164 passed, six existing skips); and `pnpm vitest run
apps/desktop/src -t 'paste|smiles|depict|structureFromSmiles' --maxWorkers=2` (127 passed).
The two-worker cap avoids the contention observed when the initial suites and build ran together.
`pnpm --filter @chemdraft/desktop exec vite build --manifest` verifies module-worker bundling
and the lightweight chunk evidence above; `git diff --check` verifies whitespace. The standalone
MCP package was not rerun in this review fix. Native app launch and Windows execution remain unverified.
