# Report 0029 — M34: run a bundled plugin inside a per-plugin Web Worker

- **Assignment:** `prompts/04-worker-isolation-boundary.md`
- **Decision:** ADR-0029 (permissive runtime plugin installer)
- **Worktree:** `~/Documents/programming/chemdraw-nmr`, branch `codex/nmr-plugin`, tip `420f438a` (no commits/pushes — all changes in the working tree)
- **Build stamp:** `7.15.22.36-codex`

> **Control-room verification (independent, 2026-07-15):** working tree matches the claimed change set
> (5 modified, 7 new files across 2 new dirs); build stamp confirmed in `AGENTS.md` + `MainWindow.tsx`;
> `apps/desktop/vite.config.ts` sets `worker.format: "es"`. Ran the new tests directly — the two new
> files (`workerProtocol.test.ts` 11, `pluginWorkerBridge.test.ts` 8) plus the plugin's own protocol
> test (8) = **27 passed in 1.08s**. The full 1,528-test suite and the `tauri build` were **not**
> re-run here (39-min build); those outcomes are the agent's, reproduced verbatim below.

---

## Result headline
The plugin↔host capability contract now crosses a per-plugin Web Worker as a versioned async
request/response protocol. Both proof plugins produce byte-identical analysis records and panel
reports through the worker boundary as they do in-process (asserted by tests). Panel-close cancellation
(ADR-0012) survives the boundary. **The single biggest unknown is resolved: nested workers run in the
Tauri macOS WKWebView.**

## Assumption-discrepancy verdicts

| # | Spec claim | Verdict | Notes |
|---|---|---|---|
| 1 | Entire capability contract is async + data-only (`showReport` ~L423; `PluginStorage.*` ~L499–502; `getActiveDocument`/`proposePatch` ~L506–507; `getSelection` ~L537; `PluginAnalysisAPI.*` ~L627–629; context bag of optional `storage?/selection?/panels?/analysis?` ~L639). No sync method, no live-object return. | **TRUE** | Verified line-for-line in `packages/plugin-api/src/index.ts`. Every method returns `Promise`; every payload is plain data. The STOP condition (a sync method / live-object return) does not occur — the ADR-0029 approach is valid. Nuance: `documents` (PluginDocumentAPI) is **always present** (L641), not optional — its methods gate internally on `document.read`/`document.proposePatch`. |
| 2 | Desktop already injects the real capabilities; runtime is `createPluginRuntime.ts`; host exposes `subscribe`/`listPlugins`; `registerBundledPlugins.ts` registers bundled plugins. | **TRUE** | Capabilities are constructed in `PluginHost.createCommandContext(pluginId)` (`packages/plugin-host/src/index.ts` L323–385): selection L326, panels L337, analysis L351, storage L325, documents L371 — each permission-gated. Desktop supplies the data sources: `getSelection`/`getActiveDocument` (MainWindow refs → `usePluginRuntime`) and `showPanelReport` (→ `PluginPanelController`) via `createPluginRuntime.ts`. The bridge reuses these exact implementations by receiving the real `context` per invocation and routing worker requests to it — it does not reimplement any capability. |
| 3 | A worker req/resp pattern exists to mirror (`nmrWorkerClient`/`nmrWorker`, id-correlated). | **TRUE** | Mirrored: monotonic request-id correlation, id-keyed pending map, drop of superseded/settled ids. |
| 4 | Two proof plugins: mass-fragment (pure compute); NMR predictor (spawns own OCL worker; panel-close cancellation via AbortController). | **TRUE** (id nuance) | `@chemdraft/plugin-mass-fragment` (`examples/plugins/mass-fragment-demo`, manifest id `org.chemdraft.mass.fragment`); `@chemdraft/plugin-nmr-predictor` (`examples/plugins/nmr-predictor`, manifest id **`org.chemdraft.nmr.predictor`** — dot-separated). NMR spawns its OCL worker via `createNmrWorkerClient()` → `new Worker(new URL("./nmrWorker.ts", …))`; cancellation via `createNmrRegistration`'s shared `AbortController` + `onPanelClosed`. |
| 5 | Panels are declarative data (text/keyValue/table/svg; SVG as string), already serializable. | **TRUE** (bonus) | Also a richer `linkedFigure` section kind (ADR-0015) — still pure serializable data. All report kinds pass `structuredClone` at the boundary in tests. |
| 6 | ADR-0028 SDK boundary holds: plugin imports only `@chemdraft/plugin-api`; worker runtime must live behind that same import; plugin source gains no new `@chemdraft/*` import. | **TRUE / honored** | `runPluginWorker` lives in `@chemdraft/plugin-api` and is exported from its single index. Plugin sources are unchanged (zero new imports). The worker *entry* files are desktop-owned (`apps/desktop/src/plugins/workers/`), not plugin source, so outside the M33 boundary guard. |

## Nested-worker verdict (first-class result)

**YES — a plugin worker can spawn its OpenChemLib worker (nested dedicated module worker) in the Tauri
macOS WKWebView.** Proven three ways:

1. **Bundling (vite + full tauri build).** With `worker.format: "es"`, Rollup emits the plugin-worker
   chunks and the nested OCL-worker chunk. `dist/assets/nmrPredictorPluginWorker-*.js` contains
   `new Worker(new URL("/assets/nmrWorker-*.js", import.meta.url))` — the nested worker is bundled and
   referenced from inside the parent worker.
2. **Blink runtime** (Chrome 148 preview): a probe using the identical architecture (main → module
   worker → nested module worker → result relayed) reported `NESTED_WORKER_OK`.
3. **WKWebView runtime — decisive.** A minimal command-line `WKWebView` (Swift 6.3,
   `AppleWebKit/605.1.15`, no Chrome/Electron token — the exact engine Tauri v2 uses on macOS) loaded
   the same probe and reported `WKWEBVIEW_RESULT: NESTED_WORKER_OK`. Corroborated by WebKit bug #22723
   ("Implement nested Dedicated Workers"); a polyfill exists only for older Safari.

**Required build-config finding:** the default `worker.format: "iife"` cannot bundle these plugin
workers — each either spawns a nested worker (NMR→OCL) or uses dynamic `import()` (mass analysis; NMR
in-thread fallback), both forcing code-splitting *inside* the worker bundle, which iife/UMD reject.
`worker.format: "es"` was set in `apps/desktop/vite.config.ts` (all workers already use
`{ type: "module" }`). **Implication for M35–M37:** the built-package pipeline must ship ES-module
workers. A defensive in-thread OCL fallback remains inside the NMR plugin worker as a safety net.

*Caveat (honest scope):* the WKWebView proof uses a faithful architectural probe, not the shipped
`.app` GUI driven end-to-end through an NMR prediction. The nesting *capability* is proven in the real
engine; driving the full OCL pipeline in the packaged app was not GUI-automated.

## Message-protocol shape (`packages/plugin-api/src/workerProtocol.ts`)
Two discriminated-union envelopes keyed by `kind`, monotonic integer correlation ids, serializable
`{code, message}` error channel:

- **worker → host:** `ready{protocolVersion, apiVersion}` · `capabilityRequest{requestId, commandRequestId, namespace, method, args}` · `commandSettled{commandRequestId, ok, value|error}`
- **host → worker:** `invokeCommand{commandRequestId, commandId}` · `capabilityResult{requestId, ok, value|error}` · `panelClosed{panelId}` (ADR-0012 reverse signal) · `abort{commandRequestId}` (late-settlement suppression)
- **Capability namespaces:** `selection` · `analysis` · `storage` · `panels` · `documents`, each with a method whitelist (`PLUGIN_WORKER_CAPABILITY_METHODS`).
- **Version handshake:** on startup the worker posts `ready` with `PLUGIN_WORKER_PROTOCOL_VERSION` (=1)
  and the plugin's manifest `apiVersion`. The bridge validates both via `checkWorkerHandshake` — a
  protocol mismatch or incompatible `apiVersion` (caret/tilde/exact via `isPluginApiVersionCompatible`)
  rejects startup loudly and terminates the worker; never half-loads. (New check at the worker
  boundary; the host's manifest-registration path still does not verify semantic API compatibility.)

## Declared-only capability enforcement (`apps/desktop/src/plugins/PluginWorkerBridge.ts`)
The bridge is handed the real per-invocation `PluginCommandContext` (from `host.createCommandContext`,
permission-gated). For each `capabilityRequest`: (1) require a live invocation for the
`commandRequestId` (else `NoActiveCommand`); (2) resolve `context[namespace]` — if absent (manifest
didn't grant it, so the host never built it) reply `CapabilityNotGranted`; (3) check method against the
whitelist (`UnknownCapabilityMethod`); (4) call the real method and return its result. `documents` is
always present, so its `document.read`/`document.proposePatch` gate is enforced by the method throwing,
surfaced as an error reply. **No consent gate exists anywhere** (permissive ADR-0029) — a granted
capability just works; an ungranted one is refused with no prompt.

## Files changed
**New (SDK, React-free):** `packages/plugin-api/src/workerProtocol.ts`, `.../workerRuntime.ts`
(+ tests `workerProtocol.test.ts`). **New (desktop runtime):**
`apps/desktop/src/plugins/PluginWorkerBridge.ts`, `.../workers/nmrPredictorPluginWorker.ts`,
`.../workers/massFragmentPluginWorker.ts` (+ `pluginWorkerBridge.test.ts`). **Modified:**
`packages/plugin-api/src/index.ts` (re-export protocol+runtime),
`apps/desktop/src/plugins/registerBundledPlugins.ts` (route the two plugins through bridges when
`Worker` exists, else in-process; expose `bridge?` for M36 teardown), `apps/desktop/vite.config.ts`
(`worker.format:"es"`), `AGENTS.md` + `MainWindow.tsx` (build stamp). Plugin sources untouched.

## Tests / builds actually run (agent)
- **`pnpm lint`** (`tsc -p tsconfig.json --noEmit`) → exit 0, clean.
- **`pnpm test`** (`vitest run`) → **1528 passed | 9 skipped (1537), 115 files** — baseline ~1509
  **+19 new** (11 protocol/runtime, 8 bridge). Coverage: mass equivalence, NMR ¹³C equivalence,
  cross-boundary panel-close cancellation (not-ok, no record), declared-only enforcement, protocol +
  apiVersion handshake failures, `terminate()` teardown (pending rejects; no later capability call
  reaches the host), worker-runtime message handling, version-compat rules.
- **`pnpm build`** (`pnpm lint && tauri build`) → exit 0: Rust release compiled (1m09s),
  `ChemDraft.app` + `ChemDraft_0.0.0_aarch64.dmg` bundled. `build:web` (`vite build`) → succeeded,
  emitting `nmrPredictorPluginWorker-*.js`, `massFragmentPluginWorker-*.js`, `nmrWorker-*.js` with the
  nested reference above.

## Deviations from spec / ADR-0029
- `worker.format:"es"` in vite.config — a build-config change beyond the packages/desktop split, but
  mandatory (without it the worker bundle cannot code-split and the build fails). Desktop-scoped.
- Worker runtime exported from the SDK's single `index` (not a subpath) to preserve the one-SDK-import
  boundary; runtime touches worker globals only lazily inside `runPluginWorker`, so importing the SDK
  on the main thread stays side-effect-free.
- Worker routing is capability-gated, not flag-gated: the two plugins run in workers when `Worker`
  exists (webview) and in-process otherwise (node/jsdom tests) — keeps the ~1509 existing tests
  untouched; MolScribe stays in-process as the untouched control.
- `terminate()` is implemented and exposed on the descriptor but not wired into the manager's disable
  flow — that wiring is M36; M34 only had to deliver the teardown mechanism (asserted).

## Unresolved risks
- `documents.getActiveDocument`/`proposePatch` are routed but unexercised by the proof plugins; a
  `ChemDraftDocument` may carry non-structured-clone-safe fields. A future document-touching plugin in
  a worker could hit a clone failure — surfaced as an error reply (`PLUGIN_WORKER_UNCLONEABLE_RESULT`),
  not a crash, but needs validation when such a plugin is workerized.
- First-prediction cost relocates, not vanishes: the NMR plugin worker spawns the nested OCL worker
  lazily, and the OCL worker chunk eagerly carries the ~7.5 MB reference DB. Same cost as today's
  main-thread OCL worker, now one hop deeper.
- WKWebView nesting is proven by a faithful probe, not by the shipped app's full NMR run (see caveat).

## Next milestone (named, NOT implemented)
**M35 — built plugin package + `plugin:package` pipeline:** produce the installable zip
(`manifest.json` + built ES-module worker + `LICENSE` + `.sha256`) and have the worker load the *built
artifact* instead of a statically-bundled entry.
