# Assignment 04: Run a bundled plugin inside a per-plugin Web Worker over an async message protocol

- **Status:** ready to issue
- **Milestones:** M34 (canonical numbering in `STATUS.md` → "Milestones"; ADR-0029)
- **Depends on:** ADR-0029 (permissive runtime plugin installer); ADR-0028 (SDK boundary — still in force); ADR-0004 (declarative panel reports); ADR-0012 (panel-close cancellation)
- **Next assignment:** `prompts/05-built-plugin-package.md` (M35 — do **not** start it here)

Work in the ChemDraft repository worktree for this feature
(`~/Documents/programming/chemdraw-nmr`, branch `codex/nmr-plugin`).

Read `AGENTS.md` and `PLANS.md` in full before editing. Follow them as repository instructions.

Implement **Milestone M34 only**: move plugin *execution* off the main thread into a per-plugin Web
Worker, with the entire plugin↔host capability contract crossing the worker as a versioned async
message protocol. Prove it with two already-bundled plugins.

Do **not** implement, and do not let scope drift toward, any of the following — each is a later
milestone and naming it vaguely is how this assignment would balloon:

- **No packaging.** Do not build `plugin:package`, a built-artifact zip, or a manifest-on-disk format
  (that is M35). The plugin stays **bundled**; only its *execution* moves into a worker. The worker
  entry may `import` the plugin module statically so Vite bundles it, exactly as `nmrWorker` is bundled
  today.
- **No install/uninstall UI.** Do not touch the disabled "Add plugin from package…" button or the
  `PluginManagerDialog` install affordance (that is M36).
- **No loading from disk, blob, or upload** (desktop staging dir is M36; web upload is M37).
- **No signing, no consent prompts, no permission-adjudication UX.** The policy is permissive
  (ADR-0029): declared manifest permissions are **auto-granted**. Do not add a consent gate.
- Do not change any plugin's **declared permissions** or its public analysis/panel output.

## Objective

Prove this path in the running desktop and in tests, for the mass-fragment analyzer first
(baseline) and the NMR predictor second (nested worker + cancellation):

```text
Analyze menu command (mass-fragment / NMR ¹H / ¹³C)
  -> plugin command handler runs INSIDE a per-plugin Web Worker
  -> handler calls context.selection / analysis / panels / storage
       -> each call is a request message to the main thread
       -> main thread services it against the SAME real host capabilities used today
       -> response message resolves the worker-side Promise
  -> plugin writes its analysis + pushes its declarative PluginPanelReport
  -> desktop renders a report BYTE-IDENTICAL to the in-process result
```

The success condition is **behavioral equivalence**: the same analysis record and the same
`PluginPanelReport` the plugin produces in-process today, produced instead via the worker boundary.

## Verified repository state (re-verify cheaply; the worktree tip may have moved past `420f438a`)

Each fact below was checked on 2026-07-15 against the planning workspace's reading of the worktree.
Re-verify each and report drift in the final report.

- **The entire capability contract is async + data-only** (this is what makes the boundary possible):
  in `packages/plugin-api/src/index.ts` — `PluginPanelAPI.showReport(...) : Promise<void>` (~L423);
  `PluginStorage.get/set/delete/listKeys` all `Promise` (~L499–502); `getActiveDocument(): Promise`
  and `proposePatch(...): Promise` (~L506–507); `PluginSelectionAPI.getSelection(): Promise<PluginSelectionSnapshot>`
  (~L537); `PluginAnalysisAPI.write/list/getLatest` all `Promise` (~L627–629); `PluginCommandContext`
  is a bag of **optional** capability objects `storage? / selection? / panels? / analysis?` (~L639).
  No method is synchronous and none returns a live object reference. **If any of this is now false,
  stop and report — it invalidates the ADR-0029 approach and must be surfaced, not worked around.**
- **The desktop already injects the real capabilities** the worker bridge must reuse. The runtime is
  `apps/desktop/src/plugins/createPluginRuntime.ts` (`DesktopPluginRuntime`); the host exposes
  `subscribe(...)` and `listPlugins()` (both consumed by `PluginManagerDialog.tsx`);
  `registerBundledPlugins.ts` is where bundled plugins are registered. Locate where `selection`,
  `analysis`, `storage`, and `panels` (the `showPanelReport` wiring) are constructed and supplied to
  plugins today; the main-thread bridge must call **those same implementations**, not reimplement them.
- **A worker request/response pattern already exists to mirror:** the NMR plugin's
  `nmrWorkerClient` / `nmrWorker` (request-id correlated `postMessage`, see reports/0004). Reuse its
  id-correlation shape for the capability protocol rather than inventing a new one.
- **The two proof plugins.** The mass-fragment analyzer (added in M19a — formula / monoisotopic +
  average mass / ESI adducts / isotope pattern; pure computation, **no external worker, no abort**) is
  the baseline. The NMR predictor `@chemdraft/plugin-nmr-predictor` is the hard case: it spawns its
  **own** OpenChemLib worker internally and supports **panel-close cancellation** via an
  `AbortController` (ADR-0012). Verify both package names/paths before wiring.
- **Panels are declarative data** (`PluginPanelReport`: text/keyValue/table/svg sections; SVG travels
  as a string). Reports are already serializable — they cross the boundary as-is with no framework
  objects.
- ADR-0028's SDK boundary holds: an extractable plugin imports **only** `@chemdraft/plugin-api`. The
  worker-side runtime you add must live behind that same single SDK import — a plugin's source must not
  gain any new `@chemdraft/*` import to run in a worker.

When an assumption is wrong, adapt to the actual repository and document the discrepancy in the final
report. Do not silently change the architecture.

## Required implementation

### 1. Versioned message protocol (M34)

Define one protocol module (envelope with a monotonic request id, a `kind`, a payload, and an
error channel) covering, in both directions:

- main → worker: `invokeCommand(commandId, invocation)`; reverse signals `panelClosed(panelId)` and
  `abort(requestId)`.
- worker → main: capability calls — `selection.getSelection`, `analysis.write/list/getLatest`,
  `storage.get/set/delete/listKeys`, `panels.showReport`, `document.getActiveDocument/proposePatch`.
- A **protocol/version handshake** on worker startup: the worker announces the plugin's `apiVersion`
  and the protocol version; a mismatch fails loudly (rejected startup with a clear message), never a
  silent partial load. Mirror `nmrWorkerClient`'s id-correlation.

### 2. Worker-side runtime in `@chemdraft/plugin-api` (M34)

Add a worker runtime so that, inside a worker, `registerPlugin` wires the plugin's command handlers to
a `PluginCommandContext` whose capability objects are **async stubs** that emit protocol requests and
resolve on the response. The plugin's own source is unchanged and still imports only the SDK. Keep the
package React-free.

### 3. Main-thread host bridge (M34)

Add (under `apps/desktop/src/plugins/`) a bridge that owns a plugin's `Worker`, forwards
`invokeCommand`, and services capability requests **by calling the existing real host
implementations** located in step "Verified repository state". It maps worker requests → real
capability calls → response messages, enforces that a plugin may only reach the capabilities its
**manifest declares** (auto-granted; ungranted capability requests are rejected at the bridge), and
forwards `panelClosed` / `abort` worker-ward. Terminating the worker must fully stop the plugin (the
teardown M36's uninstall will call).

### 4. A worker entry hosting a bundled plugin (M34)

A worker entry that statically imports a bundled plugin behind the runtime (bundled like `nmrWorker`).
Wire the desktop so the two proof plugins run via this worker path instead of in-process, capabilities
provided per manifest. Feature-flag or route this so unrelated plugins/tests are unaffected.

### 5. Prove equivalence, and resolve the nested-worker unknown (M34)

Exercise both plugins end-to-end via the worker path. For NMR, this is where the **nested worker**
(plugin worker spawning the OCL worker) and **cross-boundary abort** are proven — or found not to work
in the Tauri webview, in which case that is a **first-class finding** (with evidence) that reshapes
M35–M37, not a silent fallback.

## Architectural constraints

- Permissive posture (ADR-0029): declared permissions auto-granted; **no** consent gate, **no**
  signing, **no** deny-by-default. The bridge still provides *only* declared capabilities.
- Declarative panel data crosses the boundary as data; no framework objects over `postMessage`.
- Generic packages (`plugin-api`, `plugin-host`) stay React-free; all new desktop runtime code lives
  under `apps/desktop/src/plugins/`. `MainWindow.tsx` gets only wiring calls.
- Update the build stamp in `AGENTS.md` and the `Build` string in `MainWindow.tsx` per repository
  convention.
- Do not commit or push unless explicitly instructed.

## Acceptance criteria

Each is an observable behavior, checkable in the running desktop and/or a test:

1. Invoking the **mass-fragment** analyzer via the worker path writes the **same analysis record** and
   renders the **same `PluginPanelReport`** as the in-process path (assert structural equality in a
   test; confirm visually in the running desktop).
2. Invoking **NMR ¹H and ¹³C** via the worker path renders the same spectrum + shift-table panel as
   in-process, **with the plugin's internal OCL worker running inside the plugin worker** — or a
   documented, evidenced finding that nested workers do not run in the Tauri webview.
3. **Panel-close cancellation still works across the boundary:** closing the panel mid-prediction
   aborts the in-flight NMR run (ADR-0012 behavior preserved through the worker).
4. A capability **not declared** in a plugin's manifest is **unavailable** to that plugin in the
   worker (the bridge rejects the request); a declared one succeeds — no consent prompt appears for
   either.
5. A protocol/`apiVersion` **mismatch fails the worker startup loudly** with a clear message; it never
   silently half-loads.
6. **`worker.terminate()` fully stops the plugin** — no capability requests, panel pushes, or timers
   arrive after teardown (assert in a test; this is the mechanism M36 uninstall relies on).
7. `pnpm lint`, `pnpm test`, `pnpm build` are green; new tests cover the protocol, the bridge's
   capability routing + declared-permission enforcement, and the teardown.

## Validation

Run the most targeted tests during development. Before reporting completion:

```bash
pnpm lint
pnpm test
pnpm build
```

Do not claim a command passed unless it was actually run. Report unavailable toolchains explicitly.

## Final report

Structure the report for verbatim archiving under `reports/` (it will be filed as
`reports/0029-worker-isolation-*.md`). Include:

- milestone completed (M34);
- **assumption discrepancies:** a verdict table for every "Verified repository state" item above
  (include even if all TRUE) — the async-contract check and the capability-injection locations
  especially;
- files changed;
- **the nested-worker verdict as a first-class result:** does a plugin worker spawn the OCL worker in
  the Tauri webview? evidence either way, and the implication for M35–M37 if not;
- the message-protocol shape (kinds, envelope, version handshake);
- how the bridge enforces declared-only capabilities;
- tests and builds actually run, with outcomes;
- deviations from ADR-0029 / `PLANS.md` and why;
- unresolved risks;
- the next milestone (M35 — built package + `plugin:package` pipeline), **without implementing it**.

Stop after Milestone M34. Do not begin M35's work in the same change set.
