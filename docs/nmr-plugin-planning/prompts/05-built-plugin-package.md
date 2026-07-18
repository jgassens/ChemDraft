# Assignment 05: Build the installable plugin package and load a plugin from the built artifact

- **Status:** ready to issue
- **Milestones:** M35 (canonical numbering in `STATUS.md` → "Milestones"; ADR-0029)
- **Depends on:** M34 / `reports/0029-worker-isolation-boundary-2026-07-15.md` (the worker boundary, committed at `6c4208df`); ADR-0029 (permissive runtime plugin installer); ADR-0028 (SDK boundary + fail-closed extraction — still in force)
- **Next assignment:** `prompts/06-install-uninstall-desktop.md` (M36 — do **not** start it here)

Work in the ChemDraft repository worktree for this feature
(`~/Documents/programming/chemdraw-nmr`, branch `codex/nmr-plugin`, tip `6c4208df`).

Read `AGENTS.md` and `PLANS.md` in full before editing. Follow them as repository instructions.

Implement **Milestone M35 only**: produce the **built, installable plugin package** (the zip a user
downloads and the app will later install), and prove a plugin can be **loaded and run from that built
artifact** instead of from a statically-bundled worker entry.

Do **not** implement, and do not let scope drift toward, any of the following:

- **No install/uninstall UI.** Do not touch the disabled "Add plugin from package…" button or
  `PluginManagerDialog` (that is M36).
- **No app-data staging, install records, or persistence** across restart (M36).
- **No web upload path** (M37).
- **No signing and no consent prompts.** The posture is permissive (ADR-0029): declared permissions are
  auto-granted; the checksum is **integrity only**, never a trust gate.
- **Do not remove or replace `plugin:extract`.** ADR-0029 keeps the ADR-0028 source-distribution zip as
  the developer/build-time artifact. M35 **adds** a built-package tool alongside it.
- Do not change any plugin's source logic, declared permissions, or analysis/panel output.

## Objective

Prove this path:

```text
pnpm plugin:package -- <plugin-dir>
  -> fail-closed gates (SDK boundary clean, git tree clean, LICENSE present)
  -> bundle the plugin's TS source into an ES-module worker that calls runPluginWorker
  -> zip { manifest.json, built worker entry (+ chunks/assets), LICENSE } + .sha256 sidecar
  -> host loads the BUILT artifact into a Worker, drives it through the M34 PluginWorkerBridge
  -> identical analysis record + panel report as the statically-bundled path
```

Success is **behavioral equivalence from a built artifact**: the plugin produces the same analysis
record and the same declarative panel report when loaded from its package as it does today when
bundled into the app.

## Verified repository state (re-verify cheaply)

Verified 2026-07-16 against tip `6c4208df`. Re-verify each and report drift.

- **M34's boundary is committed and is what you build on:** `packages/plugin-api/src/workerProtocol.ts`
  (envelopes, `PLUGIN_WORKER_PROTOCOL_VERSION` = 1, `PLUGIN_WORKER_CAPABILITY_METHODS` whitelist);
  `packages/plugin-api/src/workerRuntime.ts` (`runPluginWorker`, exported from the SDK's single index);
  `apps/desktop/src/plugins/PluginWorkerBridge.ts` (main-thread bridge; validates the `ready`
  handshake via `checkWorkerHandshake`; exposes `terminate()`);
  `apps/desktop/src/plugins/workers/{nmrPredictorPluginWorker,massFragmentPluginWorker}.ts` — the
  **statically-bundled** entries M35 must make unnecessary; `registerBundledPlugins.ts` routes the two
  plugins through bridges when `Worker` exists, in-process otherwise.
- **`worker.format: "es"` is set in `apps/desktop/vite.config.ts` and is mandatory** — the default
  `iife` cannot code-split a worker bundle, and these plugins force splitting (NMR spawns a nested
  worker; mass analysis uses dynamic `import()`). Your built package must ship **ES-module** workers.
- **Nested dedicated workers work in the Tauri macOS WKWebView** (proven in M34, reports/0029), so the
  NMR plugin's internal OpenChemLib worker is viable one hop deeper. NMR spawns it via
  `new Worker(new URL("./nmrWorker.ts", import.meta.url))`, and that OCL chunk eagerly carries a
  **~7.5 MB reference database**.
- **Reuse the M33 extraction infrastructure, do not reinvent it:** `tools/plugin-extract/extract.ts`
  (source zip `<name>-<version>.zip` + `.sha256` sidecar; **fail-closed** on a dirty git tree or a
  missing `LICENSE`) and `tools/plugin-extract/checkBoundary.ts` (`checkPluginBoundary`,
  `PLUGIN_SDK_PACKAGE`; AST-based — rejects SDK subpaths, unprovable dynamic imports, relative escapes).
- **The two plugins:** `@chemdraft/plugin-mass-fragment` (`examples/plugins/mass-fragment-demo`, id
  `org.chemdraft.mass.fragment`) — pure computation, the simple baseline;
  `@chemdraft/plugin-nmr-predictor` (`examples/plugins/nmr-predictor`, id `org.chemdraft.nmr.predictor`)
  — the hard case (nested worker + the 7.5 MB DB).
- **Manifest:** `PluginManifestSchema` in `packages/plugin-api/src/index.ts`; `apiVersion` is a nonempty
  string (caret ranges like `^0.1.0` are used). The `documents` capability is **always present** on the
  command context; `storage`/`selection`/`panels`/`analysis` are optional and permission-gated.

If any of this is now false, adapt to the actual repository and document the discrepancy. Do not
silently change the architecture.

## Required implementation

### 1. `pnpm plugin:package` — the built-package tool (M35)

Add a built-package tool (alongside, not replacing, `plugin:extract`). It must:

- run the **same fail-closed gates** as extraction: SDK-boundary clean (`checkPluginBoundary`), git tree
  clean, `LICENSE`/`LICENSE.md` present — reuse the existing helpers;
- **bundle the plugin's runtime source** into an **ES-module** worker entry that calls `runPluginWorker`
  from `@chemdraft/plugin-api`, emitting whatever chunks/assets it needs (nested worker, DB) alongside;
- emit a **`manifest.json`** sufficient for a host to load the plugin **without the monorepo** — id,
  name, version, `apiVersion`, declared permissions, contributions, and the **entry filename** (plus
  source commit + SDK version provenance, mirroring `EXTRACTED.md`);
- zip `{ manifest.json, entry + chunks/assets, LICENSE }` and write the **`.sha256` sidecar**
  (integrity only — not a trust gate);
- report the package's file layout and total size on success.

### 2. Load a plugin from its built artifact (M35)

Add a load path that takes a **built package** (already-unpacked contents are fine at this milestone —
staging/installation is M36) and runs the plugin in a Worker through the existing
`PluginWorkerBridge`, honoring the `ready`/`apiVersion` handshake. Prove it with **mass-fragment first**
(the simple baseline). This is a programmatic/dev-only path — **no user-facing UI**.

### 3. Resolve the asset-resolution question for NMR (M35's key unknown)

Package the NMR plugin and determine whether its **nested OCL worker and 7.5 MB database still resolve**
when the plugin is loaded from a built package rather than from the app's own build output. The concern
is concrete: inside a worker, `new Worker(new URL("./nmrWorker.js", import.meta.url))` resolves relative
to `import.meta.url`, which changes depending on how the package is loaded — a **blob URL** has no
sibling files (multi-file packages break; inlining a 7.5 MB DB into one JS file is not acceptable),
whereas a **file/asset-protocol URL** with co-located files resolves naturally.

Determine which loading strategy works, prove it with evidence (as M34 proved nested workers), and
state plainly what it **constrains for M36 (desktop staging location) and M37 (web, which has no
filesystem)**. If the web surface cannot support a multi-file package without a different mechanism,
say so now — that is exactly the kind of finding this milestone exists to surface early. Do not paper
over it with a fallback that hides the constraint.

## Architectural constraints

- Permissive posture (ADR-0029): auto-granted declared permissions; no consent gate; checksum =
  integrity only.
- ADR-0028's SDK boundary stays machine-enforced: a packaged plugin's source imports only
  `@chemdraft/plugin-api`. Packaging must **refuse** a boundary violation.
- Generic packages (`plugin-api`, `plugin-host`) stay React-free; new desktop code under
  `apps/desktop/src/plugins/`; tooling under `tools/`.
- Update the build stamp in `AGENTS.md` and the `Build` string in `MainWindow.tsx`.
- Do not commit or push unless explicitly instructed.

## Acceptance criteria

1. `pnpm plugin:package -- examples/plugins/mass-fragment-demo` produces a zip containing
   `manifest.json`, a built **ES-module** worker entry (+ any chunks), and `LICENSE`, plus a `.sha256`
   sidecar whose digest matches the zip.
2. The mass-fragment plugin **loaded from its built package** produces an analysis record and panel
   report **identical** to the statically-bundled path (asserted in a test).
3. `pnpm plugin:package -- examples/plugins/nmr-predictor` produces a package that includes the nested
   OCL worker chunk and the reference database; the layout and total size are reported.
4. The NMR package's **nested-worker + database URL resolution** is either proven to work from the
   intended load location (with evidence) **or** documented as a constraint with a recommended strategy
   for M36/M37.
5. Packaging **fails closed**, with a clear message, on: an SDK-boundary violation, a dirty git tree, and
   a missing `LICENSE`.
6. `manifest.json` alone is sufficient for a host to identify, permission, and load the plugin (id, name,
   version, apiVersion, permissions, contributions, entry) — no monorepo paths required.
7. `plugin:extract` (the ADR-0028 source zip) still works, unchanged.
8. `pnpm lint`, `pnpm test`, `pnpm build` are green; new tests cover the packaging tool (including the
   fail-closed gates) and the built-artifact load.

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
`reports/0030-built-plugin-package-*.md`). Include:

- milestone completed (M35);
- **assumption discrepancies:** a verdict table for every "Verified repository state" item above;
- files changed;
- **the asset-resolution verdict as a first-class result:** does the NMR package's nested worker + 7.5 MB
  DB resolve from a built artifact? by which loading strategy? with what evidence? and what does it
  constrain for M36 (desktop staging) and M37 (web)?
- the package format actually produced (file layout, sizes for both plugins, manifest.json shape);
- tests and builds actually run, with outcomes and the final test count;
- deviations from ADR-0029 / `PLANS.md` and why;
- unresolved risks;
- the next milestone (M36 — desktop install/uninstall UX), **without implementing it**.

Stop after Milestone M35. Do not begin M36's work in the same change set.
