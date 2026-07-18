# Report 0031 — M36: install/uninstall a plugin package from the desktop UI

- **Assignment:** `prompts/06-install-uninstall-desktop.md`
- **Decision:** ADR-0029 (§6 as amended by report 0030; web half since withdrawn — D-13); ADR-0027, ADR-0028 still in force
- **Worktree:** `~/Documents/programming/chemdraw-nmr`, branch `codex/nmr-plugin`, tip `0fd3ecee` — no commits, no pushes; all changes in the working tree
- **Build stamp:** `7.16.12.05-claude`

> **Control-room verification (independent, 2026-07-16):** HEAD confirmed unchanged at `0fd3ecee`; the
> claimed change set is present (10 modified, 10 new). **The load-bearing hook is real:**
> `apps/desktop/src-tauri/src/lib.rs:310` — `.register_uri_scheme_protocol("tauri",
> installed_plugins::handle_tauri_request)`, with `mod installed_plugins;` at line 3 and the module
> present (14 KB); `capabilities/default.json` adds `fs:allow-mkdir/remove/read-dir` scoped to
> `$APPDATA/installed-plugins*`. Ran the tests directly: **54 passed** — `pluginPackageArchive` (17),
> `installPluginPackage` (24), `PluginManagerDialog.dom` (6), plus M35's `packagedPluginLoad` (7) still
> green. The full 1,590-test suite, `tauri build`, and `cargo test` were not re-run here; those are the
> agent's, reproduced below. Two trivial path slips in the agent's file list (`src-tauri/…` is actually
> `apps/desktop/src-tauri/…`; `zipFixture.ts` sits at `apps/desktop/src/testSupport/`, not under
> `plugins/`) — cosmetic, files verified present.

---

## Result headline

**The gate passes — no origin change, so no STOP.** The deferred "Add plugin from package…" control is
real: the manager installs `nmr-predictor-0.0.0.zip`, displays its declared permissions with no consent
gate, stages it into app data, serves it **from the app's own `tauri://localhost` origin**, loads it
through `loadPackagedPlugin` + `PluginWorkerBridge`, and registers it. Uninstall is `terminate()` +
remove + unregister + forget. Installs survive restart.

## Serving-hook verdict (first-class result)

**Mechanism: `tauri::Builder::register_uri_scheme_protocol("tauri", …)` pre-empts Tauri's *built-in*
`tauri://` handler, leaving the origin byte-identical.** Verified against **tauri 2.11.2 source**, not
documentation:

| Evidence | Finding |
|---|---|
| `manager/webview.rs:228–242` | `prepare_webview` drains the app-registered protocol map **first**, pushing each name into `registered_scheme_protocols`. |
| `manager/webview.rs:267` | `if !registered_scheme_protocols.contains(&"tauri".into())` — the built-in installs **only if the app didn't register one**. Ours wins. |
| `app.rs:2122–2143` | `register_uri_scheme_protocol` is public and an unguarded `HashMap::insert`. Reserved scheme names are **not** rejected. |
| `manager/webview.rs:244` | `pending.url` is never touched. The window still loads `tauri://localhost`. |
| `app.rs:329/342` | `AppHandle::asset_resolver()` is public and delegates to the same `get_asset` the built-in uses — non-plugin paths keep the index.html fallback chain and CSP handling. |

**Because the scheme is unchanged, nothing is orphaned** — no localStorage (including M32's
`chemdraft.plugins.disabled`), no IndexedDB. The STOP condition never fired. Hence no reach for
`WebviewUrl::CustomProtocol` or a localhost origin.

**Empirically proven, not merely read:** every asset served was temporarily logged and the real release
app run — the handler served `app-asset /`, `/assets/index-*.js`, `/assets/index-*.css` (19 requests).
Since the app renders identically either way, "it launches" proves nothing; **the log is the positive
signal**. Probe removed afterwards.

**The hook that looks right and cannot work:** `on_web_resource_request` runs at `protocol/tauri.rs:222`
— *after* `manager.get_asset(path)?` at line 215. The `?` returns early for an unknown path, so it is
**never invoked** for a path absent from the embedded asset store. It can rewrite existing assets; it
cannot introduce new ones. Recorded so it is not retried.

**A trap worth passing on:** `dev = !custom_protocol` (tauri `build.rs:257`). A bare
`cargo build --release` leaves `custom-protocol` off → the binary runs in *dev* mode and loads `devUrl`,
so `tauri://` is never consulted. The handler looked broken when it wasn't. Always verify via
`tauri build`.

## Assumption-discrepancy verdicts

| # | Spec claim | Verdict | Notes |
|---|---|---|---|
| 1 | The real zip: 3.45 MB, sha256 `9d83a901…`, 7 files / 17.01 MB unpacked | **TRUE** | Exact: 3,618,230 bytes, digest identical, 7 entries, 17,834,630 unpacked, provenance `0fd3ecee / clean`. |
| 2 | `loadPackagedPlugin` loads via the bridge, honors handshake, refuses `blob:`/`data:` | **TRUE** | Reused verbatim, unmodified. |
| 3 | `PluginWorkerBridge.terminate()` is the uninstall teardown | **TRUE / honored** | Used, not reinvented. |
| 4 | The manager's package button is `disabled` with the packaging-milestone note | **TRUE** | Now real; its DOM test updated (it asserted the old contract). |
| 5 | A disabled plugin can't be listed from `listPlugins()`; installed plugins need M32's catalog treatment | **TRUE** | Installed descriptors are always built (bridge lazy → no worker spawned); only *enabled* ones register. Load-bearing: building lazily would have re-registered a disabled install with an **empty handler map**. |
| 6 | `manifest.json` is a superset with `chemdraftPackage`; its text is what the UI displays; accurate as of `0fd3ecee` | **TRUE** | **Resolves report 0030's flagged risk:** the description no longer says "fixture-backed/synthetic" — it states NMRShiftDB2-derived HOSE lookup with estimate/integration disclosures. The install UI displays AGENTS.md-compliant text. |
| 7 | Fail closed on "duplicate installed id" | **TRUE, but collides with criterion 1** | See Deviation 1 — the decisive discrepancy of this milestone. |

## Deviations from the spec / ADR-0029

**1. An installed package *replaces* a bundled plugin of the same id (it is not refused).** "Refuse an id
already compiled in" was implemented first — then found to make the milestone impossible: the packaged
manifest id is `org.chemdraft.nmr.predictor`, **byte-identical to the bundled one**, and *both*
packageable plugins are bundled. That rule would reject the spec's own fixture and leave the feature
undemonstrable. A package keeps the id of the plugin it was built from, so this is the *ordinary* case.
Install therefore unregisters the bundled copy and takes the id over — **after** the handshake passes, so
the bundled copy is only dropped once the replacement works; uninstall hands it back, honoring the
disabled-id set. The specified rule — a duplicate id **already installed** — is enforced exactly as
written. The manager dedupes by id (installed shadows bundled), so one live plugin never shows two rows.
**Flagged for owner review: "which copy is running?" is now a real question, answered by an "Installed"
badge.**

**2. Install-record store is a file in app data, not localStorage.** `installed-plugins.json`, a sibling
of the staging root (so a plugin id can never collide with it). The records describe **bytes on disk**;
keeping the index beside them means they cannot be separated by anything happening to the origin.
Coexists with M32's localStorage disabled-ids, read independently — asserted by test.

**3. Zero new dependencies.** The repo has no JS zip library (`plugin:package` shells out to system
`zip`); `fflate`/`pako` are transitive-only, so using them would be a phantom dependency. A ZIP reader
was written over the platform's `DecompressionStream("deflate-raw")` + `crypto.subtle`. In Rust, a
~15-line percent-decoder was hand-rolled rather than promote transitive `percent-encoding` to a direct
dep.

**4. Vite dev middleware added** (`vite.config.ts`). In `tauri dev`,
`PROXY_DEV_SERVER = cfg!(all(dev, mobile))` is **false** on desktop, so the webview loads `devUrl`
directly and the document origin is Vite — `tauri://` is never consulted. Same-origin is mandatory, so
whichever server owns the document must own `/installed-plugins/`. Without this, installs would work in
the shipped app and mysteriously 404 under `./run-app --dev`. Mirrors the Rust handler's contract.

**5. `PluginPanelController.reportDiagnostic` made public** — a failed install reload is exactly "a
controlled runtime diagnostic surfaced instead of crashing".

**6. Known debt left alone as instructed:** the desktop's static worker entries still duplicate the
plugins' `workerEntry.ts`. Not collapsed.

## Files changed

**New (desktop runtime):** `installedPluginPaths.ts` (the URL/dir contract mirrored in Rust),
`pluginPackageArchive.ts` (ZIP + CRC + sha256 + traversal), `pluginStagingFs.ts` (port + Tauri adapter),
`installedPluginStore.ts`, `installPluginPackage.ts`, `pickPluginPackage.ts`.
**New (Rust):** `apps/desktop/src-tauri/src/installed_plugins.rs` (serving hook + 5 unit tests).
**New (tests):** `pluginPackageArchive.test.ts` (17), `installPluginPackage.test.ts` (24),
`src/testSupport/zipFixture.ts`.
**Modified:** `PluginManagerDialog.tsx` (+ DOM test, 2→6), `usePluginRuntime.ts`,
`PluginPanelController.ts`, `App.css`, `vite.config.ts`, `src-tauri/src/lib.rs`,
`src-tauri/capabilities/default.json`, `MainWindow.tsx`, `AGENTS.md`.

## How it works

**Staging:** `<appData>/installed-plugins/<pluginId>/…` — flat, exactly as the zip, preserving the
co-location resolution depends on. Records at `<appData>/installed-plugins.json`.
**Serving:** `tauri://localhost/installed-plugins/<id>/…` → staging dir; everything else →
`asset_resolver`.
**Install:** verify sidecar (if present) → verify **every entry's CRC-32 regardless** → parse manifest →
check entry exists → check apiVersion → *display* → stage → load → **`await bridge.whenReady()`** →
register → record. Every post-staging failure **rolls back** the directory and any registration, so a
failed install is indistinguishable from one never attempted.
**Uninstall:** close panel (so `onPanelClosed` aborts in-flight work) → `terminate()` → unregister →
remove dir → forget record → restore the bundled copy if applicable.
**Startup:** installs reload **after** bundled registration, asynchronously, so a broken install cannot
delay or block startup; failures become diagnostics.

## Fail-closed paths and how each was proven

| Path | Proof |
|---|---|
| Checksum mismatch | Byte flipped in a real archive → refused (`PLUGIN_PACKAGE_CHECKSUM_MISMATCH`). |
| Archive integrity **without** a sidecar | Per-entry CRC-32 + length. Bad CRC, wrong length, undeflatable stream, non-zip, truncated, duplicate entry, empty archive, encrypted, unknown compression method, Zip64 — each refused. CRC verified against the standard vector `CRC-32("123456789") == 0xCBF43926`. |
| Missing/malformed manifest | No `manifest.json`; non-JSON; missing provenance; **and a contribution requiring an undeclared permission** (the cross-field rule a package must not smuggle past). |
| apiVersion/protocol incompatible | Both halves: refused up front by `isPluginApiVersionCompatible`, **and** a worker announcing protocol 99 or a contradicting apiVersion fails at `whenReady()` with **nothing staged, registered, or recorded**. |
| Duplicate installed id | Second install refused; first untouched. |
| Path traversal | `../../../../etc/passwd`, `assets/../../../etc/passwd`, `/etc/passwd`, `..\..\Windows\…`, `C:\…`, NUL — all refused, in TS **and independently in Rust at serve time** (two trust boundaries), including `%2e%2e%2f` decoded *before* the check. |

## Verified in the running app vs. in tests — stated plainly

**In the running release app** (`tauri build`, launched from terminal):

- The handler serves the app's own frontend → the `tauri://` override genuinely pre-empts the built-in.
- `[chemdraft] serve 200 /installed-plugins/org.chemdraft.nmr.predictor/entry.js` — the staged package
  served **on the app's own origin**; the worker spawned from it and passed the real handshake
  (registration only happens after `whenReady()`); no errors, no diagnostics.
- Persistence: the record survived a fresh start and reloaded.
- After uninstall: **no staged fetch at all** — nothing lingering.

**In a real WKWebView probe** (Swift 6.3.3, the engine Tauri uses; M34/M35 precedent), driving the
**real staged directory** at the **real `/installed-plugins/<id>/` path shape** through one same-origin
scheme handler:

```
SERVE 200 /installed-plugins/org.chemdraft.nmr.predictor/entry.js (1182925 bytes)
SERVE 200 /installed-plugins/org.chemdraft.nmr.predictor/assets/nmrWorker-DdhZM3S8.js (7556112 bytes)
ready protocolVersion=1 apiVersion=^0.1.0 → command settled ok=true
1 analysis record, 2 panel reports
backend={"engineId":"chemdraft.ocl-hose","dataVersion":"NMRShiftDB2 (full NMReDATA export)","method":"hose-fragment"}
benzene ¹³C → 128.1 ppm   (literature ≈128.5)
```

**The discriminator:** the 6.4 MB in-thread fallback chunk `OclHosePredictor-*.js` is present in the
staged package but was **requested 0 times**. Only the nested worker was fetched — the nesting is real,
not the fallback silently covering.

**What was NOT done by hand:** **the shipped app's GUI could not be clicked through — computer-use
access to ChemDraft was requested twice and denied both times.** So the *button-press* path (Add plugin
from package… → picker → review → Install → Analyze ▸ NMR) was **not** driven by hand. Instead the disk
half of install was executed by the **real installer modules** (`inspectPluginPackage` + real staging +
real record writer) bound to a `node:fs` adapter, and the app then performed the load half itself; the
prediction was proven by the WKWebView probe. The UI is covered by jsdom tests (6). **This is the one
acceptance-criterion gap: criterion 1's end-to-end GUI click-through is unverified by hand.** Everything
it composes is individually verified in a real engine; the composition through the actual button is not.
It should be re-checked with a single manual run.

## Commands actually run

- `pnpm lint` → **exit 0**, clean.
- `pnpm test` → **exit 0: 1590 passed | 9 skipped (1599), 119 files** (M35 baseline 1545/1554 across 117
  → **+45 tests, +2 files**).
- `pnpm build` (`pnpm lint && tauri build`) → **exit 0**; `ChemDraft.app` + `.dmg` bundled.
- `cargo test --lib installed_plugins` → **5 passed** (Rust path guards; not part of `pnpm test`).

## Unresolved risks

- **Criterion 1's GUI click-through unverified** (access denied) — the gap above.
- **Shadowing is a design decision made under a genuine spec collision** (Deviation 1). It is the only
  reading consistent with the spec's own fixture, but deserves owner review.
- **`crypto.subtle` under `tauri://localhost`** works (proven — the real app's install path computed
  digests), relying on WebKit treating a `localhost` host as potentially trustworthy. A scheme/host
  change would need re-checking.
- **17 MB unpacked per install**, ~6.4 MB a duplicate DB for a fallback that never runs when nesting
  works (inherited from M35).
- **`loadPackagedPlugin` still imports from `registerBundledPlugins`** — the layering seam M35 flagged.
- **Static worker entries still duplicate `workerEntry.ts`** — instructed debt.
- **D-11 (plugin license) still open**, and a working one-click installer makes redistribution more
  tempting.

## Next milestone

The agent named **M37 (web install)** as next-but-blocked. **Superseded by the control room the same
day: D-13 is resolved and M37 is dropped** — the browser build is a dev preview, not a product. **M36 is
the final slice of the ADR-0029 program.** The agent's closing observation is still worth recording: what
worked here was exactly "one handler owns both the document and the package on one origin", which is the
shape a Service Worker would have had to reproduce.
