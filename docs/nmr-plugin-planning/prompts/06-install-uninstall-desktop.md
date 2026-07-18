# Assignment 06: Install and uninstall a plugin package from the desktop UI

- **Status:** ready to issue
- **Milestones:** M36 (canonical numbering in `STATUS.md` → "Milestones"; ADR-0029)
- **Depends on:** M35 / `reports/0030-built-plugin-package-2026-07-16.md` (the built package + `loadPackagedPlugin`, committed at `0fd3ecee`); M34 / `reports/0029` (the worker bridge + `terminate()` teardown); ADR-0029 (permissive posture); ADR-0027 / M32 (the core-owned manager UI)
- **Next assignment:** M37 (web install) — **blocked on D-13**; do not start it

Work in the ChemDraft repository worktree (`~/Documents/programming/chemdraw-nmr`, branch
`codex/nmr-plugin`, tip `0fd3ecee`).

Read `AGENTS.md` and `PLANS.md` in full before editing. Follow them as repository instructions.

Implement **Milestone M36 only**: make the deferred "Add plugin from package…" control real, so a user
can **install a plugin package zip and uninstall it** from the existing manager, with installs surviving
a restart.

Do **not** implement:

- **No web install surface** (M37 — blocked on D-13; ADR-0029 §6's blob mechanism is disproven).
- **No signing and no consent prompts.** Permissive posture (ADR-0029): declared permissions are
  **auto-granted** and merely *displayed*. The checksum is **integrity only** — corruption detection,
  never a trust gate.
- **No changes to `plugin:package`** (M35) or to any plugin's logic, manifest text, or permissions.
- **Do not collapse the desktop's static worker entries** (`apps/desktop/src/plugins/workers/*`), which
  now duplicate the plugins' own `src/workerEntry.ts`. Known debt; note it, leave it.

## Task 1 — resolve the same-origin serving hook FIRST (gating; may stop the milestone)

M35 proved by measurement (reports/0030) that a packaged plugin loads **only from a real, co-located,
same-origin URL**:

- a **blob URL fails** — no sibling files, so NMR's nested OCL worker and 7.5 MB database never resolve
  (and the failure is late: the `ready` handshake *succeeds*, the prediction then fails);
- **cross-origin fails** — worker scripts are same-origin-only; permissive CORS does not help;
- **Tauri's `asset://` is ruled out** — separate origin;
- **registering a new custom scheme is ruled out** — a new scheme is a new origin.

**What must work:** one URI-scheme handler serving *both* the document and the staged package — i.e. the
app's own origin resolving a reserved path prefix (e.g. `/installed-plugins/<id>/…`) to the app-data
plugins directory. **Whether Tauri v2 exposes that hook for its built-in `tauri://` handler is
unverified — that is your first task.**

Investigate and report before building any UI. If the hook exists, use it.

**STOP-and-report condition:** if the only viable route **changes the app's origin** (e.g. serving the
frontend *and* plugins from one app-registered scheme via `WebviewUrl::CustomProtocol`, or from a
localhost HTTP origin), **do not proceed** — report instead. An origin change is a user decision, not an
agent decision, because origin-keyed persisted state (localStorage/IndexedDB — including M32's disabled
plugin preferences and any other app data) would be **orphaned**. Quantify what would be orphaned, and
stop.

## Objective

```text
Plugins ▸ Add or Remove Plugins ▸ "Add plugin from package…"
  -> pick nmr-predictor-0.0.0.zip
  -> verify .sha256 (integrity) -> parse+validate manifest.json -> DISPLAY declared permissions
  -> stage into the app-data plugins dir -> served on the app's own origin
  -> loadPackagedPlugin -> PluginWorkerBridge -> registerPlugin
  -> the plugin's Analyze commands appear and a real prediction runs
  -> Uninstall: terminate() + remove dir + unregister + forget -> gone, nothing lingering
  -> restart: still installed
```

## Verified repository state (re-verify cheaply)

Verified 2026-07-16 at tip `0fd3ecee`.

- **`pnpm plugin:package` works on a clean tree** and produced the real artifact this milestone must
  install: `dist/plugin-packages/nmr-predictor-0.0.0.zip`, **3.45 MB**, sha256
  `9d83a901d94764d60bc4ba2c7aaf1bac90f9b8fc5e5577cd9aaeac182a56d8c9`, sidecar verified `OK`, provenance
  `sourceCommit 0fd3ecee / sourceTree clean`, 7 files / 17.01 MB unpacked (`entry.js`,
  `assets/nmrWorker-*.js` = nested OCL worker + DB, `OclHosePredictor-*.js` fallback,
  two `resources-*.json`, `manifest.json`, `LICENSE`). **Use this real zip as the install fixture.**
- **`apps/desktop/src/plugins/loadPackagedPlugin.ts` (M35)** loads a plugin from an unpacked built
  package through `PluginWorkerBridge`, honors the `ready`/`apiVersion` handshake, and **refuses a
  `blob:`/`data:` base up front**. It currently imports from `registerBundledPlugins` (a layering seam —
  splitting it is optional, not required).
- **`apps/desktop/src/plugins/PluginWorkerBridge.ts` (M34)** exposes `terminate()`, asserted to fully
  stop a plugin (no capability calls, panel pushes, or timers afterward). **This is the uninstall
  teardown — use it, do not reinvent it.**
- **`apps/desktop/src/plugins/PluginManagerDialog.tsx`** is the M32 core-owned manager. The
  `data-action="add-plugin-package"` button is **`disabled`** with the note "Installing plugins from a
  package arrives with the plugin-packaging milestone." That milestone is this one. Bundled
  enable/disable (`applyEnabledPlugins`, `saveDisabledPluginIds`) must keep working alongside installs.
- **A disabled plugin cannot be listed from `PluginHost.listPlugins()`** — M32 therefore keeps a runtime
  catalog of bundled descriptors and uses the host only for live enabled state. Installed plugins need
  the same treatment: an installed plugin that is disabled must remain listed and re-enableable.
- **`manifest.json` in the package** is a superset of `PluginManifest` with a `chemdraftPackage`
  provenance block (sdk, sdkVersion, sourceCommit, sourceTree, licenseFile, packagedAt); the manifest
  half validates against the identical schema a bundled plugin faces. Its `description` and permissions
  are what your install UI displays — they are now accurate as of `0fd3ecee`.

Adapt to the actual repository if any of this drifted, and record the discrepancy.

## Required implementation

1. **The serving hook** (Task 1 above) — the staged directory reachable on the app's own origin.
2. **Install:** native file picker → read the zip → **verify the `.sha256` sidecar if present, and the
   archive's integrity regardless** → unpack → parse + validate `manifest.json` → **display** the
   plugin's name, version, description, and declared permissions → stage into the app-data plugins
   directory (keyed by plugin id) → load → register. No consent gate.
3. **Uninstall:** `terminate()` the worker, remove the staged directory, unregister from the host, and
   forget the install record.
4. **Persistence:** an install record store (id, version, staged path, source checksum); reload
   installed plugins at startup; survive restart; coexist with M32's disabled-id preferences.
5. **Fail closed, loudly, with a clear message** on: checksum/integrity mismatch, malformed or missing
   `manifest.json`, an `apiVersion`/protocol-incompatible package (M34's handshake), a duplicate plugin
   id already installed, and a zip whose entries would escape the staging directory (path traversal).

## Architectural constraints

- Permissive (ADR-0029/D-12): auto-granted declared permissions; no consent gate; no signing.
- The manager stays **core-owned** (ADR-0027); generic packages stay React-free; desktop runtime code
  under `apps/desktop/src/plugins/`; `MainWindow.tsx` gets only wiring.
- Update the build stamp in `AGENTS.md` and the `Build` string in `MainWindow.tsx`.
- Do not commit or push unless explicitly instructed.

## Acceptance criteria

1. **In the running desktop app**, installing `dist/plugin-packages/nmr-predictor-0.0.0.zip` through the
   manager makes its Analyze commands appear, and **a real ¹³C prediction runs from the installed
   plugin** — with the nested OCL worker resolving from the staged location (evidence: the nested worker
   chunk is actually fetched, not the in-thread fallback).
2. The install UI **displays** the package's declared permissions and description; **no consent prompt
   gates the install.**
3. A **corrupted/tampered** zip is refused with a clear message (flip a byte and show it).
4. An **apiVersion/protocol-incompatible** package fails the install loudly, never half-loading.
5. **Uninstall** removes the plugin from the menus and the manager, terminates its worker, and deletes
   the staged directory; no capability call arrives after teardown.
6. **Installs persist across an app restart**; bundled enable/disable still works; an installed-but-
   disabled plugin stays listed and re-enableable.
7. A zip containing a path-traversal entry cannot write outside the staging directory.
8. `pnpm lint`, `pnpm test`, `pnpm build` green; tests cover install, uninstall, persistence, and each
   fail-closed path.

## Validation

```bash
pnpm lint
pnpm test
pnpm build
```

Do not claim a command passed unless it was actually run. Criterion 1 requires the **running app**, not
only a test — M34/M35 set the bar by proving webview behavior with real evidence; meet it, and be
explicit about what was driven by hand versus asserted in a test.

## Final report

For verbatim archiving as `reports/0031-install-uninstall-desktop-*.md`. Include:

- milestone completed (M36);
- **the serving-hook verdict as a first-class result:** which mechanism serves the staged package on the
  app's own origin, with evidence — or, if it required an origin change, the STOP report with what
  persisted state would be orphaned;
- assumption-discrepancy verdict table;
- files changed;
- how install, uninstall, and persistence work (staging layout, the install-record store);
- each fail-closed path and how it was proven;
- what was verified in the running app vs. in tests;
- tests and builds actually run, with the final count;
- deviations from ADR-0029 and why; unresolved risks;
- the next milestone (M37 — web install, **blocked on D-13**), without implementing it.

Stop after M36.
