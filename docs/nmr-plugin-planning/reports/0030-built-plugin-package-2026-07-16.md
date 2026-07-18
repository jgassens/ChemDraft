# Report 0030 — M35: built plugin package + load from the built artifact

- **Assignment:** `prompts/05-built-plugin-package.md`
- **Decision:** ADR-0029 (permissive runtime plugin installer); ADR-0028 (SDK boundary) still in force
- **Worktree:** `~/Documents/programming/chemdraw-nmr`, branch `codex/nmr-plugin`, tip `6c4208df` — no commits, no pushes; all changes in the working tree
- **Build stamp:** `7.16.09.05-claude`

> **Control-room verification (independent, 2026-07-16):** HEAD confirmed unchanged at `6c4208df`; the
> claimed change set is present (8 modified, 10 new files incl. `tools/plugin-package/`);
> `plugin:package` + `plugin:extract` both registered in `package.json`. Ran the relevant tests
> directly: **33 passed** — `boundary.test.ts` (10) + `extract.test.ts` (6) = **M33's 16 regression
> tests green unmodified** after the shared-gates refactor, plus `package.test.ts` (10) and
> `packagedPluginLoad.test.ts` (7), including *"loaded from its built package, the plugin writes the
> same analysis record and renders the same report as the statically-bundled path."* The full
> 1,545-test suite and `tauri build` were not re-run here; those are the agent's, reproduced below.
> **`examples/plugins/mass-fragment-demo/LICENSE` was read in full:** it records the existing
> "not finalized" status and defers to the project owner (D-11) — it invents no license and grants no
> rights. Appropriate; not a licensing decision made by an agent.

---

## Result headline

`pnpm plugin:package` produces a built, installable package (`manifest.json` + ES-module worker entry +
chunks/assets + `LICENSE`, plus a `.sha256` sidecar), reusing M33's fail-closed gates. A plugin loaded
**from that built artifact** produces a byte-identical analysis record and panel report to the
statically-bundled path.

**The key unknown is resolved:** the NMR package's nested OpenChemLib worker and its 7.5 MB database
**do resolve from a built artifact** — but only under one loading strategy, and the answer
**invalidates the literal mechanism ADR-0029 §6 names for M37**.

## Assumption-discrepancy verdicts

| # | Spec claim | Verdict | Notes |
|---|---|---|---|
| 1 | M34's boundary is committed and is what M35 builds on (`workerProtocol.ts`, `workerRuntime.ts`, `PluginWorkerBridge.ts`, static entries, `registerBundledPlugins.ts` routing) | **TRUE** | Built on unchanged. The packaged load path reuses `PluginWorkerBridge` + `createWorkerRoutedOptions` verbatim — a packaged plugin *is* the bundled path with a different script URL. |
| 2 | `worker.format: "es"` set and mandatory | **TRUE** | Mirrored in the packaging build; confirmed necessary (the emitted worker bundle code-splits). |
| 3 | Nested workers run in Tauri macOS WKWebView; NMR spawns via `new Worker(new URL("./nmrWorker.ts", import.meta.url))`; OCL chunk carries ~7.5 MB DB | **TRUE** | Re-proven from a *built package*. "~7.5 MB" accurate at the emitted-chunk level: **7,556,074 bytes**. Nuance: raw DB JSON on disk is 6,366,992 bytes (6.07 MiB); the 7.5 MB figure is DB + OCL + predictor code after bundling. |
| 4 | Reuse M33's `extract.ts` gates + `checkBoundary.ts` | **TRUE / honored** | Shared gates factored into `tools/plugin-extract/gates.ts`; both tools call one implementation. M33's 16 tests pass unmodified. |
| 5 | The two plugins (`org.chemdraft.mass.fragment` simple; `org.chemdraft.nmr.predictor` hard) | **TRUE, with a material discrepancy** | **`mass-fragment-demo` has no `LICENSE`** (only `nmr-predictor` had one). The LICENSE gate correctly refuses it, so the spec's command cannot succeed until one is added and committed. See Deviations. |
| 6 | `PluginManifestSchema`; `apiVersion` nonempty caret string; `documents` always present | **TRUE** | The schema is `.strict()`, so packaging provenance could not be added by extension — see Package format. |

**Additional discrepancies found (not in the spec's list):**

- **A plugin-agnostic generated entry is impossible.** `createNmrRegistration(services)` requires a
  predictor (the nested OCL worker client must be constructed first). Only the plugin knows how to wire
  its own runtime → hence the `src/workerEntry.ts` convention rather than tool-side generation.
- **The desktop's `nmrPredictorPluginWorker.ts` could not be moved into the plugin verbatim:** its
  fallback does `import("@chemdraft/plugin-nmr-predictor")`, an **ADR-0028 boundary violation** as plugin
  source. The plugin's entry uses a relative import (`./providers/ocl/OclHosePredictor`) instead.
- **M34 observed an *absolute* `new Worker(new URL("/assets/nmrWorker-*.js", …))`** — a consequence of
  the app's `base: "/"`. An absolute path resolves against the *origin root* and would miss a package
  staged elsewhere. Packaging must build with **`base: "./"`** — the single most load-bearing setting in
  the tool.

## Asset-resolution verdict (first-class result)

**Yes — the nested worker and 7.5 MB database resolve from a built artifact, but only from a real,
co-located, *same-origin* URL.**

Evidence: a Swift 6.3.3 command-line **WKWebView** (`AppleWebKit/605.1.15`, no Chrome/Electron token —
the engine Tauri v2 uses on macOS) serving the **real built NMR package** through a
`WKURLSchemeHandler` (precisely how Tauri serves the app). Every served request was logged — the
discriminator that matters, because the plugin silently falls back to an in-thread predictor if the
nested worker fails, so only the fetch log distinguishes real nesting from a fallback. The probe drove a
full ¹³C prediction end-to-end.

| Strategy | Result | Evidence |
|---|---|---|
| **A — blob URL** | **FAILS** | Handshake *succeeds* (`ready protocolVersion=1`), then the command returns `{ok:false, NMR_PROVIDER_FAILURE: "The NMR worker is unavailable in this environment."}`. **No sibling file was ever fetched.** |
| **B — same-origin, co-located** | **FULL SUCCESS** | `SERVE 200 /pkg/entry.js (1182561 bytes)` → handshake → **`SERVE 200 /pkg/assets/nmrWorker-BcY5tkZR.js (7556074 bytes)`** → `command settled ok=true`; 1 analysis record, 2 panel reports; `backend={id:"chemdraft.ocl-hose", dataVersion:"NMRShiftDB2 (full NMReDATA export)"}`; benzene → **128.1 ppm** (literature ≈128.5). The fallback chunk was **never requested** — the nested worker genuinely spawned. |
| **C — cross-origin, co-located (CORS `*`)** | **FAILS** | Worker error; **no SERVE line at all** — WebKit refused the worker script load before the handler. Worker scripts are same-origin-only; permissive CORS does not help. |

Two findings deserve emphasis:

1. **The blob failure is late and deep, not at load.** NMR creates its nested worker lazily, so a blob
   URL passes the `ready` handshake and only fails when a prediction is attempted. A verdict based on
   startup alone would have been wrong. This is exactly the "silent fallback hides the constraint" trap
   — so `loadPackagedPlugin` **refuses a `blob:`/`data:` base up front** with an explicit message.
2. **Inlining is not a way out.** Avoiding siblings would mean inlining a 7.5 MB database into one
   script — explicitly not acceptable.

### What this constrains for M36 (desktop staging)

The staged package must be reachable at a URL **on the app's own origin**, files co-located. For this
repo (Tauri v2, no asset protocol enabled, `csp: null`, app served from `tauri://localhost` on macOS):

- **Tauri's `asset://` protocol is ruled out** — separate origin (scenario C).
- **Registering a *new* custom scheme for plugins is ruled out** — a new scheme is a new origin.
- **What works (proven):** one URI-scheme handler serving *both* the document and the staged package. So
  M36 must have the app's own protocol handler resolve a reserved path prefix (e.g.
  `/installed-plugins/<id>/…`) to the app-data plugins directory. **Whether Tauri v2 exposes that hook
  for its built-in `tauri://` handler is the open M36 question**; if not, the fallback is to serve the
  frontend *and* plugins from one app-registered scheme (`WebviewUrl::CustomProtocol`) or a localhost
  HTTP origin. Staging location is otherwise unconstrained — the package is relocatable.

### What this constrains for M37 (web) — surfaced early, as intended

**ADR-0029 §6's literal mechanism will not work.** It states the browser build "installs from an
in-memory / IndexedDB **blob**". A blob URL **cannot host a multi-file package** (scenario A, measured).
The NMR plugin cannot be installed this way at all.

The web surface needs a mechanism making unpacked bytes addressable at **same-origin URLs with
siblings**. The realistic option is a **Service Worker** intercepting a virtual path
(`/installed-plugins/<id>/*`) and serving from IndexedDB/Cache Storage. Stated honestly: **this was not
tested**, and it carries real risk (whether a SW reliably intercepts *nested* worker script loads) plus a
hard requirement (secure context; no `file://`). **If no Service Worker is available, M37 cannot support
a multi-file package.** This is an **ADR-0029 §6 amendment trigger** and should be decided before M37
starts (→ **D-13**).

## Package format actually produced

Flat zip (no wrapping directory), so a host unpacks straight into the staged directory — preserving the
co-location that makes resolution work.

**`@chemdraft/plugin-mass-fragment`** — 5 files, **2.40 MB unpacked / 0.79 MB zipped**: `resources-*.json`
(1320.3 KB, openchemlib asset), `massAnalysis-*.js` (1069.1 KB, dynamic-import chunk), `entry.js`
(67.6 KB), `manifest.json` (2.1 KB), `LICENSE` (0.4 KB).

**`@chemdraft/plugin-nmr-predictor`** — 7 files, **17.01 MB unpacked / 3.45 MB zipped**:
`assets/nmrWorker-BcY5tkZR.js` (7379.0 KB — **nested OCL worker + reference DB**),
`OclHosePredictor-*.js` (6238.3 KB — in-thread fallback, **duplicate DB**), `assets/resources-*.json`
(1320.3 KB), `resources-*.json` (1320.3 KB), `entry.js` (1154.8 KB), `manifest.json` (2.7 KB), `LICENSE`.

`resources.json` appears twice because each referring directory gets its own sibling — correct, and a
direct consequence of relative resolution. **~6.2 MB (36%) is the in-thread fallback's duplicate
database**, carried because M34 kept that fallback as a safety net; never used when nesting works.
Dropping it is a behavior change and was left alone.

`manifest.json` is a **superset of `PluginManifest`** (the schema is `.strict()`, so provenance could not
be added by extension; the parser splits `chemdraftPackage` off and validates the manifest half against
the *identical* schema a bundled plugin faces):

```json
{
  "id": "org.chemdraft.nmr.predictor", "name": "NMR Shift Predictor",
  "version": "0.0.0", "apiVersion": "^0.1.0", "entry": "entry.js",
  "permissions": ["selection.read","analysis.write","ui.menu","ui.panel"],
  "description": "…", "contributes": { /* all 12 keys */ },
  "chemdraftPackage": {
    "sdk": "@chemdraft/plugin-api", "sdkVersion": "0.1.0",
    "sourceCommit": "…", "sourceTree": "clean",
    "licenseFile": "LICENSE", "packagedAt": "2026-07-16T14:07:19.768Z"
  }
}
```

Verified: zip integrity clean (`unzip -t` → "No errors detected"); sidecar digest matches byte-for-byte;
`manifest.json` contains no monorepo paths; `entry.js` retains no bare specifiers (asserted in a test) —
the package needs nothing from this monorepo.

## Files changed

**New (SDK):** `packages/plugin-api/src/packageManifest.ts`. **New (tooling):**
`tools/plugin-extract/gates.ts`; `tools/plugin-package/package.ts`, `.../package.test.ts` (10 tests),
`.../committedCopy.ts`. **New (desktop):** `apps/desktop/src/plugins/loadPackagedPlugin.ts`,
`.../packagedPluginLoad.test.ts` (7 tests). **New (plugin source, additive only):**
`examples/plugins/{mass-fragment-demo,nmr-predictor}/src/workerEntry.ts`;
`examples/plugins/mass-fragment-demo/LICENSE`. **Modified:** `packages/plugin-api/src/index.ts`;
`tools/plugin-extract/extract.ts` (shared gates; behavior unchanged);
`apps/desktop/src/plugins/registerBundledPlugins.ts` (export `createWorkerRoutedOptions`);
`package.json` (`plugin:package`); `tsconfig.json`; `docs/plugin-architecture/AUTHORING.md`;
`AGENTS.md` + `MainWindow.tsx` (build stamp).

## Tests and builds actually run (agent)

- **`pnpm lint`** → exit 0, clean.
- **`pnpm test`** → exit 0: **1545 passed | 9 skipped (1554), 117 files**. M34 baseline 1528/1537 across
  115 → **+17 tests, +2 files**.
- **`pnpm build`** (`pnpm lint && tauri build`) → exit 0: vite 23.13s; Rust release 1m19s; `ChemDraft.app`
  + `.dmg` bundled. App build still emits `nmrWorker-*.js` at 7,556.09 kB — matching the package chunk.
- **WKWebView probe** — `swiftc -O`, run against the real built NMR package (results above). Built in the
  scratchpad, not committed (M34 precedent).
- **Criterion 7** — `plugin:extract` still produces its unchanged source zip; M33's 16 tests unmodified.

## Deviations from the spec / ADR-0029

1. **`mass-fragment-demo` had no `LICENSE`; one was added** stating the *same* "not finalized" status the
   owner already applied to `nmr-predictor` (D-11). It grants no rights and makes no licensing decision —
   it records existing status so the gate can pass. Without it, criteria 1–2 are unreachable.
2. **Criterion 1's exact command does not succeed in the current working tree** — the new files are
   **uncommitted**, and the git-clean gate correctly refuses them. Honest output, not a bug:
   `package-plugin: plugin has uncommitted or untracked files; commit or clean them before distributing`.
   **Committing these files makes the exact spec commands work.** It also means `plugin:extract` currently
   refuses `nmr-predictor` for the same reason (its new `workerEntry.ts`). To prove the pipeline
   regardless, `committedCopy.ts` packages a **committed copy of the real plugin source** through the
   **real gates** — artifact bytes are real; only the recorded provenance commit is from a throwaway
   repo. Documented as test support, explicitly not a way to distribute uncommitted work.
3. **Plugins now own `src/workerEntry.ts`** (new author-facing convention, documented in `AUTHORING.md`).
   Forced by the discrepancies above. `--entry` overrides it. The desktop's static entries were **left in
   place** (the spec says M35 makes them *unnecessary*, not removed); they now duplicate wiring, which M36
   can collapse.
4. **`tools/` imports `plugin-api` by relative path**, not package specifier — `tools/` is not a workspace
   package; the sibling extractor already reaches that file by path. Avoids a global vitest-alias change
   affecting 1500+ tests.
5. **Vite resolved from `apps/desktop`** via `createRequire`, typed structurally — it is not a root
   dependency, and adding it would touch the lockfile. The unsafe boundary is contained in one adapter.

## Unresolved risks

- **M37 is blocked on a mechanism decision** (ADR-0029 §6 blob install disproven). Highest priority; the
  Service Worker route is untested. → **D-13**.
- **M36's same-origin serving hook is unverified** in Tauri v2. The evidence rules out the two obvious
  approaches; it does not confirm the replacement.
- **NMR package is 17 MB unpacked**, ~6.2 MB a duplicate database for a fallback that never runs when
  nesting works. Worth revisiting once the nesting guarantee is trusted.
- **Provenance in the demo artifacts is synthetic** (throwaway commit), per deviation 2. Real
  distributions must be packaged from a committed repo.
- **`loadPackagedPlugin` imports from `registerBundledPlugins`**, so M36's installer pulls in the bundled
  catalog. Zero cost today, but a layering seam M36 may want to split.
- **D-11 still open and now more pressing**: both packages ship "not licensed for public redistribution"
  terms, and a one-click downloadable makes redistribution more tempting.
- **Manifest labeling bug:** the NMR manifest still describes a "fixture-backed… synthetic data"
  predictor while shipping the real NMRShiftDB2-derived `chemdraft.ocl-hose` backend. That text is now
  copied verbatim into `manifest.json` and **will surface in M36's install UI**. Out of scope here (no
  plugin-logic changes); flagged as a follow-up.

## Next milestone (named, NOT implemented)

**M36 — install/uninstall UX (desktop):** wire the deferred "Add plugin from package…" button;
checksum-verify (integrity only); show declared permissions (no consent gate); stage → load → register;
uninstall = `terminate()` + remove + forget; persist installs across restart. **Its first task is
resolving the same-origin serving hook above.**
