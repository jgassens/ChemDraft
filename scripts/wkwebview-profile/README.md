# WKWebView host/worker 3D profile

Run these commands **from the repository root on this Mac**, outside the agent sandbox.
Use the checkout's existing dependencies; no installation is needed. Xcode Command Line Tools
and a logged-in macOS graphical session are required. No clicks, installed ChemDraft app,
Tauri build, signing, or separate web server are required.

```sh
CHEMDRAFT_WKPROFILE=1 pnpm --filter @chemdraft/desktop build:web --configLoader runner
mkdir -p scripts/wkwebview-profile/.build
swiftc scripts/wkwebview-profile/main.swift -o scripts/wkwebview-profile/.build/wkprofile -framework WebKit -framework AppKit
scripts/wkwebview-profile/.build/wkprofile apps/desktop/dist/wkprofile > scripts/wkwebview-profile/.build/report.json
```

The build must finish before starting the runner. `--configLoader runner` avoids writing Vite's
bundled-config cache into a shared dependency directory in isolated worktrees. This is still the
production, minified Vite build with real module workers and the real vendored RDKit WASM.
Only `CHEMDRAFT_WKPROFILE=1` adds the page input and changes output to `apps/desktop/dist/wkprofile`;
ordinary builds retain their existing entry and `dist` output. A subsequent ordinary build can
clear this nested diagnostic output, so rebuild the profile before running it again.

Alternatively, interpret the same Swift source (after building the page):

```sh
swift scripts/wkwebview-profile/main.swift apps/desktop/dist/wkprofile > scripts/wkwebview-profile/.build/report.json
```

The runner binds an ephemeral **127.0.0.1-only HTTP server**, sets correct JS/WASM MIME types,
uses a fresh nonpersistent WKWebView data store, and attaches the view to a tiny, nearly transparent
window on the screen. The window is ordered forward without becoming key or activating the app;
WebKit's inactive scheduling is disabled where supported, and a process activity prevents App Nap.
These keep WebKit timers and workers running despite AppKit occlusion handling, without user
interaction. The runner does not touch the stable app or app data. HTTP avoids WebKit's
version-dependent `file://` restrictions on module workers and WASM; loopback is a secure context
for the real HMAC WebCrypto calls. The server refuses paths/symlinks outside the supplied dist.
The process exits after one JSON report, or after **120 seconds**, including server/page startup.
Progress goes to stderr; stdout contains one JSON object. Exit codes: 0 success, 1 page/native
failure or timeout, 2 invalid arguments. WebKit can also emit its own OS diagnostics on stderr.
Compilation is separate from the 120-second run deadline.

The page can also be opened at `/wkprofile.html` from an HTTP server serving that build directory.
Without the native `report` handler it writes the JSON into the page and console and sets
`document.title` to `ChemDraft WKWebView profile: ok` or `error`.

## What executes

Three sequential **embed3d → minimize3d → flatten3d** samples share one real
`createConformerWorkerPool({ onTiming })` and `createChemistry3dProviders(...)`. The fixture is:

```text
CBPQT4+: C1c2ccc(cc2)C[n+]2ccc(cc2)-c2cc[n+](cc2)Cc2ccc(cc2)C[n+]2ccc(cc2)-c2cc[n+]1cc2
PEG2-TTF: C1(COCCOCCOC)=C(COCCOCCOC)SC(S1)=C1SC(COCCOCCOC)=C(COCCOCCOC)S1
```

Seed 42; the explicit-H guest centroid is translated onto the host centroid, without rotation,
matching `scripts/profile-flatten-jsc.mjs`. Minimization uses MMFF94s, `interfragment: true`,
20,000 requested iterations maximum, in the production 1,000-step passes, stopping on convergence.
Flatten uses `view: "auto"`. There are no saved-model, engine, token, clash, validation or
transport substitutes. The normal host's chemistry timeouts and startup pause remain in force.
A refusal stops the sequence and preserves completed and failing method timings in the report.

The page composes the **actual** plugin-host request schemas, `Chemistry3dQueue`, providers,
and `chemistry3dResultError` in the host's order. The flatten result check therefore includes
`chem-core`'s `DocumentObjectSchema`. It invokes the real `conformerWorker.ts`, not a smaller
benchmark worker. Internal host imports are confined to this opt-in diagnostic entry.

The nine 3D timings exclude plugin registration/command dispatch and plugin-worker scheduling.
Their plugin bridge cost is a separately labelled `structuredClone` of the exact
`{ kind: "capabilityResult", requestId, ok: true, value }` envelope. This measures serialization
and deserialization on one thread; it does **not** measure plugin-worker delivery/scheduling.

After those timings, the page exercises the core analysis worker (ethanol composition), the bounded
2D depiction worker (ethanol through the real startup/layout-deadline client), and both platform
entries for the bundled mass analyzer. Each analyzer runs its real command through PluginWorkerBridge
and an in-memory PluginHost, including selection, lazy massAnalysis import and analysis/report writes.
These checks are separate from the 3D timings and appear under `workerExercises`. Counters are queried
only after all lazy work finishes, before terminating the workers.

## Read the report

`status: "ok"` means nine successful method measurements, successful additional worker exercises,
and one entry evaluation per worker. The native runner also requires one entry fetch per instance. Verify
`measurements[].result` for warning lists, object/atom counts, field status/energy, and contact/clash
results before interpreting timings. Expect 170 explicit-H model atoms, two components, and
two flattened objects retaining 86 atoms total. The first embed is cold; **all three flattens
follow embed and minimize on the reused worker**. No sample is silently discarded.

Each `measurements[]` entry contains `sample`, `method`, `status`, end-to-end `wallMs`,
`stages` sorted by descending total time, and the complete `events` with worker details and
host receipt times (`observedAtMs`, relative to profile start). Repeated component/parse events
are summed within a stage, with call counts and min/max. **Stages nest: do not add all their
totals to reconstruct wall time.** Durations use `performance.now()` on their own thread;
host receipt timestamps do not pretend to be worker start times.

`transport` separates the two delivery directions using
`performance.timeOrigin + performance.now()`, a shared clock across the page and worker:

- `requestDeliveryMs`: host job post → worker handler entry, including cold worker bootstrap.
- `resultDeliveryMs`: immediately before worker result post → host `onmessage` entry.
- `replyDispatchMs`: host entry → filtering/logging/timing, immediately before resolution.

The delivery events' `details` contain all four absolute timestamps; terminal entries in
`replies` also contain `workerReceivedAtEpochMs`, `workerPostedAtEpochMs` and
`hostReceivedAtEpochMs`. The host entry clock precedes the reply logger. These probes are
opt-in; ordinary calls acquire no new clocks or transport metadata. No timer, await or
engine cleanup occurs between the worker's result-post clock and `postMessage`.

| Stage | What a large value means |
| --- | --- |
| `pluginHost.<method>.request-schema` | Plugin-host input validation and snapshot |
| `pluginHost.<method>.queue-wait` | Real per-plugin queue admission; normally near zero for sequential samples |
| `host.<method>.provider-total` | Entire provider, including worker wait and token work; nested within `wallMs` |
| `host.<method>.request-schema` | Provider's second input validation/snapshot |
| `host.<method>.token-sign` / `token-verify` | Entire token operation, including nested model parse/encoding/crypto |
| `token.*.model-schema`, `.encode`, `.key-wait`, `.webcrypto`, `.serialize` | Individual token costs; first sign's key wait includes session HMAC key generation |
| `host.flatten3d.clash-screen` | Host-side contact refusal screen, before queueing worker work |
| `host.<method>.queue+worker-construction` | Pool enqueue/setup, global pool queue and lazy worker construction |
| `host.<method>.postMessage` | Synchronous outbound job serialization/send |
| `host.<method>.worker-roundtrip` | Just before postMessage through terminal reply receipt; excludes pool queue/construction |
| `host.<method>.request-delivery` | Outbound delivery/bootstrap or a worker still busy with earlier work |
| `host.<method>.result-delivery` | Result serialization/delivery/scheduling after the worker posts it |
| `host.<method>.reply-dispatch` | Host-side filtering/logging before resolving the pool call |
| `host.<method>.roundtrip` | Whole pool request, including queue/construction |
| `worker.protocol-total` | Whole worker handler job, including dynamic imports, loading and timing sends; ends before terminal result posting |
| `worker.module.*`, `worker.initialize` | Per-job module imports and engine readiness; repeated slow imports can be distinguished from compute |
| `wasm.ensure (fetch/read+compile+init on first call)` | RDKit initialization; should be tiny once warm |
| `worker.job` | Engine dispatch/import/readiness and chemistry after the profiling WASM ensure; nested in protocol total |
| `worker.flatten3d.module.flatten-import`, `.ensure-rdkit` | Cached flatten-module import and RDKit lookup during the actual flatten call |
| `worker.<method>.request-schema` | Worker-side input schema parse |
| `flatten.*`, `rdkit.*`, `embed.*`, `minimize.*` | Existing real worker/engine stages, including nested binding calls |
| `pluginHost.<method>.result-validation` | Real per-method host check; flatten traverses full native document objects |
| `bridge.<method>.structuredClone` | Isolated result-envelope clone benchmark, outside provider and validation |

`transportResidualMs` is **worker-roundtrip − worker.protocol-total**. A large gap contains
outbound/inbound cloning, delivery, pre-handler worker bootstrap, scheduling, and streamed timing
delivery. It is not proof that any single clone was slow. `null` means a required stage never
completed; small negative values are retained rather than hiding clock resolution differences.
Use `postMessage` to identify synchronous outbound serialization and `transport` to distinguish
outbound scheduling/backlog from inbound result delivery. Small signed clock-resolution
differences remain visible.

For example, with `jq` installed:

```sh
jq '.status, .environment, .runner, [.measurements[] | {sample, method, status, wallMs, transportResidualMs, result}]' scripts/wkwebview-profile/.build/report.json
jq '.measurements[] | select(.method == "flatten3d") | {sample, wallMs, transportResidualMs, stages}' scripts/wkwebview-profile/.build/report.json
```

## 10.27.14.15-codex handoff: synchronous worker entry boundaries

The baseline production output exported shared adapter/schema bindings from the conformer worker
entry. `engine-*.js` imported RDKit, schema and other shared bindings from that entry; `timing-*.js`
imported `ensureRdkit` from it; `flatten-*.js` also imported it. These were Rollup-generated imports,
not runtime source imports. WKWebView treated the worker bootstrap and the later module import as
separate module instances in one worker global, fetching and evaluating the entry twice. Thus all
its top-level effects ran twice, including WASM-loader/resource registration and listener setup.
The previous listener replacement fixed duplicate jobs, but could not prevent duplicate evaluation.

The f6cf4745 dynamic-import fix introduced a startup regression. The conductor's
`_master-scratch/wkprofile-report-3-tla-hang.json` (WebKit 21624.5.1.11.3) records one fetch each of
the conformer entry/runtime, no engine fetch, a 30-second first-job timeout and no diagnostic reply.
Its runtime listener was behind top-level `await import(...)`. Module evaluation can suspend at
that await; it is not a readiness handshake with `postMessage`. A message dispatched before its
listener exists is not replayed when the listener is added. The report also shows that registering
only the profiler listener before the await did not rescue this WebKit startup.

The relevant processing rules are HTML's [run a worker](https://html.spec.whatwg.org/multipage/workers.html#run-a-worker)
(worker script startup and enabling the implicit port's message queue),
[run a module script](https://html.spec.whatwg.org/multipage/webappapis.html#run-a-module-script)
(evaluation returns a promise for asynchronous modules), and
[DOM event dispatch](https://dom.spec.whatwg.org/#concept-event-listener-invoke)
(dispatch invokes listeners present then; later registration does not replay an event).
These are not a claim that every engine drops every message during TLA: the observed WebKit
startup hang is the regression, and the unit transport deliberately models the dropping behavior
instead of assuming Chromium's buffering. The fix relies on synchronous module evaluation running
to completion before message tasks execute, with the actual protocol listener already installed.

The conformer, analysis, depiction and both bundled analyzer entries now statically import runtime startup functions
and call them synchronously after recording their evaluation. The Windows entry first statically
imports `installWindowsWorkerShim.ts`; dependency evaluation installs the shim before plugin module
evaluation, including any module-scope nested-worker creation. `worker.format: "es"` is retained.
`worker.rollupOptions.output.manualChunks` puts every statically reachable dependency of an entry
in a separate `worker-runtime` chunk. `onlyExplicitManualChunks: true` keeps dynamic-only engine,
timing and flatten code lazy. Their shared imports resolve to the runtime, never to the entry.
The conformer types/pure cache keys remain in `conformerWorkerShared.ts`; engines, chemistry,
timeouts, scheduler, and the defensive Symbol-based listener replacement remain intact.

The bounded 2D depiction entry also calls a statically imported startup function. It assigns
`scope.onmessage` synchronously, immediately starts both engine-loading attempts, and queues
requests until they settle. With at least one engine available it posts the unchanged
`{ id: 0, stage: "ready" }` handshake before draining requests in arrival order, including requests
received during another layout. Total engine failure still surfaces as a worker error. Existing
clients wait for readiness, retaining the separate 10-second cold-start cap and two-second layout
deadline, cancellation, and OCL fallback after RDKit load failure. Bootstrap tests wait for the
handshake instead of module-import completion; new tests cover early queued requests and a
WebKit-style transport that drops messages delivered before listener registration.
The Windows shim test asserts the installer is the first static import and calls the shim at module
evaluation. Its real module-evaluation nested-worker test also passes.

Every browser module-worker URL in `apps/desktop/src` and `packages` was audited. All construction
sites (including the profile, Spin and plugin 3D pools) reduce to these five entries:

| Worker | Entry file under `apps/desktop/src` | Synchronous start | Entry back-imports |
| --- | --- | --- | --- |
| Analysis | `analysisWorker.ts` | Yes | None |
| Conformer | `conformerWorker.ts` | Yes | None |
| 2D depiction | `depiction2d/worker.ts` | Yes; queues until engines are ready | None |
| Mass fragment | `plugins/workers/massFragmentPluginWorker.ts` | Yes | None |
| Windows mass fragment | `plugins/workers/windowsMassFragmentPluginWorker.ts` | Yes; shim evaluates first | None |

There are no additional literal browser module-worker URLs in `packages`. Additional transports
and profiling coverage:

| Worker | Baseline result and change | Profiler coverage |
| --- | --- | --- |
| `conformerWorker.ts` (Spin and plugin 3D pools) | Static runtime startup; shared bindings pinned to a runtime chunk; no TLA. | Real 3D sequence on one reused pool worker; same entry as Spin. |
| `analysisWorker.ts` | Static runtime startup; records evaluation before synchronously registering its listener. | Real ethanol composition request. |
| `depiction2d/worker.ts` (#221) | Static runtime startup; synchronous listener, ordered readiness queue and unchanged ready handshake; no TLA. | Real bounded ethanol depiction. |
| `plugins/workers/massFragmentPluginWorker.ts` via PluginWorkerBridge | Static shared-runtime startup installs protocol listener synchronously; no TLA. | Real bridged analyzer command forces the analysis path. |
| `plugins/workers/windowsMassFragmentPluginWorker.ts` | Ordered static shim dependency, then the same synchronous runtime; no entry back-import or TLA. | Real bridged command; Windows custom-origin shim is inactive on loopback. |
| `chemistry3d/perfWorker.ts` | Node-only esbuild benchmark, `bundle: true` without splitting; no back-import. Added global evaluation count. | Not run by WKWebView. |
| `test/depictionNodeWorker.mjs` | Node-only test transport; direct imports of pure depiction functions, no worker-entry import. No change. | Not run by WKWebView. |
| `packages/chemdraft-cli/src/depictionWorker.mjs` | Node worker_threads transport with `execArgv`, not browser `type: "module"`; engine initialization uses top-level await. No app worker-entry imports. No change. | Not run by WKWebView. |
| Installed plugin factory (`loadPackagedPlugin.ts`) and `nestedModuleWorkerShim.js` | Generic external entry URLs; no app entry back-import. Windows wrappers intentionally import the external package once rather than bootstrap it twice. | External plugin packages/nested workers and WebView2 custom-origin wrappers are outside this app-build check. |

There are currently no Vite `?worker` uses. The source audit discovers future ones and requires
updating the audited inventory; it scans app and package sources and rejects runtime source imports
of worker entries, excluding dependency/build directories and Node worker_threads constructors.
`workerChunksGuard()` runs inside **every production Vite worker build**, on macOS/Windows/Linux,
including the existing CI `build:web` step. It checks Rollup output metadata for static **and**
dynamic entry imports, top-level await (including `for await`) in entries or their static dependency
chunks, and evaluation-time dynamic imports outside functions. It fails the build on any of those.
Async job-handler imports remain allowed. It emits inspectable
`dist/worker-chunks/*.json` (or `dist/wkprofile/worker-chunks/*.json`) for all five browser entries.
The cheap Rollup regression fixture reproduces the original generated import and proves the guard
rejects it, accepts static startup with a dedicated runtime chunk, preserves lazy engines, and
rejects both the await-import regression and TLA hidden in a static runtime dependency.

Each entry increments a global `Symbol.for("org.chemdraft.workerEntryEvaluations")` counter; it is
not a module-local guard. Only `CHEMDRAFT_WKPROFILE=1` builds expose a diagnostic request listener.
Ordinary builds have no diagnostic listener or extra messages. The native report combines the
late counter snapshots with its independent HTTP log. A failure in either count makes the runner
exit 1; a second evaluation cannot hide behind HTTP caching. `fetches` is the total for that URL
and `instances` is the number of tracked workers using it; repeated instances require one fetch
each, not one fetch globally. Browser-only page reports have evaluation counts but no native HTTP
counts. `workersNotCovered` always names excluded environments/packages.

**Exact conductor commands:** after the integration edits above, from the integrated checkout on
macOS outside the agent sandbox (no dependency installation):

```sh
pnpm lint
pnpm vitest run apps/desktop/src/chemistry3d apps/desktop/src/wkprofile apps/desktop/src/plugins tools/worker-chunks
pnpm vitest run apps/desktop/src/depiction2d apps/desktop/src/conformerWorker.test.ts apps/desktop/src/conformerClient.test.ts
CHEMDRAFT_WKPROFILE=1 pnpm --filter @chemdraft/desktop build:web --configLoader runner
mkdir -p scripts/wkwebview-profile/.build
swiftc scripts/wkwebview-profile/main.swift -o scripts/wkwebview-profile/.build/wkprofile -framework WebKit -framework AppKit
scripts/wkwebview-profile/.build/wkprofile apps/desktop/dist/wkprofile > scripts/wkwebview-profile/.build/report.json
```

In an isolated checkout with a shared read-only dependency directory, append
`--configLoader runner` to each Vitest command too. Inspect the result:

```sh
jq '{status, workers: [.workers[] | {worker, fetches, instances, evaluations, fetchedOncePerInstance, evaluatedOnce, status}], workerExercises, workersNotCovered}' scripts/wkwebview-profile/.build/report.json
jq '[.measurements[] | select(.method == "flatten3d") | {sample, status, wallMs}]' scripts/wkwebview-profile/.build/report.json
```

Measured successful worker rows (all five, independently):

```json
{"worker":"conformer","fetches":1,"instances":1,"evaluations":1,"fetchedOncePerInstance":true,"evaluatedOnce":true,"status":"ok"}
```

The conductor's WKWebView run on macOS 26.7.1, WebKit 21624.5.1.11.3, Apple M1 Pro (10 cores) measured flatten3d wall times of 21–34 ms, minimize3d 944–958 ms, embed3d 1139–1491 ms, and delivery residuals of 0–2 ms. Conformer, analysis, depiction2d, and both mass-fragment worker entries each fetched and evaluated once. Before the fix, flatten3d took 987–1989 ms with roughly 1000 ms quantized delivery residuals; minimize3d took 2134–2146 ms on samples 2–3. The earlier numbers came from WKWebView-only double evaluation of worker entry chunks.

The exercise registration grants `ui.panel` so a healthy run reports `status: "ok"`. Windows/WebView2 runtime verification remains outstanding.

Local verification: `pnpm lint` passes. First-job/drop-semantics tests now cover depiction and analysis
as well as the conformer and both bundled analyzers. The analysis test also verifies lazy engine loading
and diagnostic-message separation. The shim installer source assertions and the real nested-worker
evaluation-order test pass. Earlier verification of the chemistry3d, wkprofile, plugins, worker-chunks
and analysis suite reported 85 files passed, three skipped; 1,249 tests passed, five skipped.
The depiction follow-up passes all 42 tests across depiction2d, depictionWorkerClient, worker-chunks
and smilesListPaste.worker, using `--configLoader runner` to avoid writing bundled config into the
shared dependency directory. Both ordinary and profile production builds now pass with
`--configLoader runner` and the unchanged emitted-code guard. All five entry audit manifests are
emitted in each build, with no entry back-imports or startup TLA. Windows/WebView2 runtime verification remains outstanding. The source stamp `10.27.14.15-codex` and worktree/build-stamp
machinery were kept. Existing dependencies were reused; no installation was run.

For an ordinary production build with the same output guard (no profiler page/listeners):

```sh
pnpm --filter @chemdraft/desktop build:web --configLoader runner
```

The report includes the source/worktree build stamp, UA/visibility/focus, WebKit and macOS versions,
HTTP request counts and failures, and accepted/rejected worker reply IDs. On errors, inspect
`error`, `latestProgress` (native failures), `measurements`, and `runner.http.failedRequests`.
Missing JS/WASM, navigation errors and web-content process termination produce explicit JSON.
A page-module import failure is caught by the small bootstrap. If the bootstrap itself fails
to load, timeout output still includes the failed HTTP requests and navigation progress.

This isolates WKWebView over HTTP. It does not duplicate Tauri's asset-scheme handler, AppKit app
activity/focus state, or full plugin bridge. A passing run is a measurement, not proof of packaged
app parity. Profiling streams timing messages and wraps RDKit bindings; this overhead can affect
observed wall times. Native progress logging occurs outside each method's measured `wallMs`.
No WebView2 or Windows runner verification is claimed; this runner is intentionally macOS-only.

## Local checks

### First-flatten delivery investigation

The conductor's `wkprofile-report-firstflatten.json` reports first-sample flatten at 1041 ms:
995 ms host-to-worker request delivery, about 40 ms worker computation, and 1 ms result delivery.
Samples 2/3 flatten at 25/31 ms with 1 ms request delivery. This locates the delay before the
worker's protocol handler; it does not establish that the worker was computing during that gap.

Comparison with `origin/main:apps/desktop/src/conformerWorker.ts` found the scheduler, warm-up,
engine selection and generation bodies identical after the runtime extraction. Startup still only
sets the OCL resource URL and registers the lazy RDKit loader. Neither loads resources nor embeds
a warm-up molecule. The supplied HTTP log contains no OCL torsion-resource request. Consequently
an automatic OCL warm-up is not an established cause of this report's one-second gap.

The conformer scheduler now accepts only an explicit `kind: "warmup"` as a warm-up request;
unrelated messages no longer enter that queue. This is defensive dispatch hardening, not a
verified explanation of the first-flatten regression. Idle-startup tests also run queued timers
and plugin jobs, verify no speculative engine calls, and then prove an explicit warm-up runs.
The synchronous listener, loader setup, valid job behavior and build stamp are retained.

Profiler builds now return `workerActivity`, a buffered timeline independent of the currently
active host request. Spans use the same epoch clock as the delivery probe and include startup
registration, complete plugin requests, scheduler warm-up/prefetch/background-refine jobs, and
the individual RDKit/OCL warm-up phases. Dependency `setTimeout`, `setInterval` and `queueMicrotask`
callbacks are timed too; their records include scheduling time and requested delay. Instrumentation
creates no timers or heartbeat, retains the most recent 1000 spans per worker, and is disabled in
ordinary builds. Async spans include waiting time; callback spans measure callback execution only.

On the next real WKWebView run, compare `workerActivity` intervals with the first flatten's
`host.flatten3d.request-delivery.details` boundaries. A long warm-up/refine/callback span will name
the intervening work. If the preceding request has ended and no activity overlaps the gap, inspect
WebKit scheduling/VM activity rather than attributing the gap to an unobserved engine call.
The target remains first-sample flatten in tens of milliseconds and request delivery in a few
milliseconds. That result and the underlying cause still require conductor verification; the
current diagnostic/hardening change does not claim the regression is fixed.

```sh
pnpm lint
pnpm vitest run apps/desktop/src/chemistry3d apps/desktop/src/wkprofile apps/desktop/src/depiction2d tools/worker-chunks
pnpm vitest run apps/desktop/src/conformerWorker.test.ts apps/desktop/src/conformerClient.test.ts
pnpm vitest run --configLoader runner apps/desktop/src/depiction2d packages/rdkit-adapter/src/depictionWorkerClient.test.ts tools/worker-chunks apps/desktop/src/smilesListPaste.worker.test.ts
git diff --check
```

Aggregation tests cover repeated/nested stages, directional delivery, absent data and signed
residuals. Host timing tests cover disabled clocks/promise identity, failures, real HMAC
verification and tamper refusal. Reply tests pin the shared-clock boundaries, timer-free result
posting and a single listener across deliberate entry reevaluation. Worker-profile tests cover
global counters across module instances, opt-in exposure, diagnostic/chemistry message separation,
late snapshots, missing replies, real analyzer bridge execution and teardown. The four opt-in performance cases in
the full chemistry suite remain skipped unless explicitly enabled.
The WKWebView execution itself must run outside the agent sandbox; compiling Swift there succeeds,
but WebKit's service/XPC sandbox extensions are unavailable.
