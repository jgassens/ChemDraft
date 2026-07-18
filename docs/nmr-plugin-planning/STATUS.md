# STATUS

Single source of truth for where the ChemDraft NMR plugin effort stands.
Update this file after every assignment report, decision, or verification pass.

- **Target repository:** `~/Documents/programming/chemdraw` → `https://github.com/jgassens/ChemDraft.git`
- **Main state:** `main` has advanced to **`1a0467b5`** (2026-07-17) and now **ships the entire plugin system** — worker isolation, built-package installer, core-owned manager, unified in-app + floating panels, the toolbars union — with **no NMR bundled** (users install it from a zip). Historical base for the plugin work was `64cf513e` (2026-07-06).
- **Branches (all on `origin`):** `main` `1a0467b5` (plugin system, no NMR) · `core-only` `1a0467b5` (what was promoted) · `merge/plugin-union` `2d9bdef1` (the union incl. bundled NMR, hand-verified) · `codex/nmr-plugin` `125aebeb` (full NMR history — the source for the future standalone-repo subtree split). Active worktree: `~/Documents/programming/chemdraw-plugin-union` (currently on branch `sdk-publish` for M40/Phase 2).
- **Current phase:** the **plugin-separation program** (`PLAN-plugin-separation.md`) is in its final stretch. ✅ Union merged & verified (M38, ADR-0030) · ✅ core-only strip + from-zero install test PASSED (M39, Phase 4) · ✅ **promoted to `main`** (Phase 5). **Now: M40 SDK-publishable** (Phase 2, ADR-0031) → then Phases 6–7 (standalone plugin repo via `git subtree split`). Prior history: Phase 1 (M1–M12) plus M13–M37 delivered the runtime, the NMR predictor, results UX, the extraction architecture (ADR-0028), and the permissive runtime installer (ADR-0029). Last full green on the union: **1,807 tests**, lint, tauri build, 45 Rust tests; core-only: **1,641 tests**.
- **Last updated:** 2026-07-17 (**PLUGIN-SEPARATION PROGRAM COMPLETE.** The standalone plugin repo (M41+M42, Phases 6–7) is delivered at `~/programming/chemdraft-nmr-plugin` (off iCloud) — commit `38262c2`, vendored SDK, and it **self-builds `nmr-predictor-0.1.0.zip`** with zero monorepo (checksum verified, no chem-core, provenance points at its own commit); reports/0036. Seeded clean-init because `git subtree split` stays iCloud/SIGBUS-blocked — full history is safe on `codex/nmr-plugin` and graftable later. **Remaining owner actions (all off the critical path): (a)** create GitHub repos + push (the plugin repo `main`, and fold `sdk-publish`→main for the SDK build script); **(b)** the iCloud fix (`mv ~/Documents/programming ~/programming` or pause Desktop/Documents sync) — unblocks the history graft and cures the session-long FS flakiness; **(c)** optional: publish SDK to npm / graft full plugin history. Nothing else is blocking. Earlier same day: **M40 SDK-publishable DONE & verified** — `plugin-api`/`plugin-host` are self-contained MIT npm packages (chem-core bundled, not published; ADR-0028 boundary preserved), both `0.1.0`, esbuild+rollup-dts build (tsup crashed on Node 26); **external-consumer gate PASSED** (fresh dir, only the two tarballs installed, no chem-core, full `tsc` typecheck), lint clean, 1,641 tests, internal `src` resolution preserved; commit `60856d4b` on `sdk-publish`, not pushed; tauri build confirming. **The actual `npm publish` stays the owner's** (needs the `@chemdraft` npm org + make-public decision) — steps documented in reports/0035. Earlier: `main` promoted to ship the plugin system (`1a0467b5`, Phase 5) after the from-zero install test (M39/Phase 4, reports/0034); union GUI pass (reports/0033 addendum); M38 union merge (ADR-0030). **Open owner items:** `npm publish` + public-npm-vs-git/tarball distribution choice (D-15 follow-up, before Phases 6–7); promote `sdk-publish`→main once the tauri build confirms; D-14 shadowing; N1 pop-out sizing; root-app license; R8 dev-fixture-in-manager.)
- **Measured accuracy (held-out, seed 1, report 0025):** ¹H coverage 99.1%, MAE 0.36 / median 0.17 ppm; ¹³C coverage 99.4%, MAE 3.6 / median 1.6 ppm. Tiers order error exactly (high < medium < low, ~4–5× spread) — confidence is now a *measured* property. Increment table loses to HOSE overall (MAE 0.36 vs 0.22) and reaches parity only on the low tier — ADR-0023/0024's HOSE-first policy empirically confirmed.
- **Accuracy spot-check (strychnine vs SDBS 7596, report 0023):** 10/16 ¹H lines within 0.05 ppm, median |Δ| ≈ 0.045; three real misses (bridged N-CH methines +0.7…0.8, H-14 −0.44, peri-aromatic −0.44) — exactly the peaks the confidence system had marked weakest. CH₂ lines are pair centroids (diastereotopic spread not predicted; disclosed via the M25 warning).
- **Accuracy milestone (M17) complete; M25 policy follow-up complete:** HOSE stays primary; every chemically applicable v1.3 increment calculation is available as a versioned second opinion. Confidence/dispersion changes interpretation, not visibility.
- **Measured-J ambition closed (ADR-0021, report 0015):** M18 researched NP-MRD → **NO-GO**. Neither free atom-assigned source delivers broad measured J (NMRShiftDB2 has none; NP-MRD's is ~3,700 natural-product compounds, natural-product-biased, and 5.1M/5.5M spectra are *predicted*), and couplings don't transfer through single-atom HOSE codes anyway. **Topology-estimated J, labelled as estimated (M15/M16), is the accepted honest ceiling** for this free lookup plugin. No download taken.
- **Predictor status:** strong on shifts (~96% high/med confidence on common molecules, report 0014); confidence surfaced in table + figure (M17a/M17a2). Remaining NMR work is optional polish, not a new data source.
- **Extensibility proven (M19a, report 0016):** a second, non-NMR analyzer — **`@chemdraft/plugin-mass-fragment`** (formula + monoisotopic/average mass + ESI adduct m/z + isotope pattern) — runs on the same host/analysis/panel APIs, registered with one import + one `registerPlugin` call, zero NMR concepts. The generic infrastructure (ADR-0004/0005, M5) is demonstrated domain-agnostic, not just asserted.
- **Results UX (M20/M21, reports 0017–0018):** real summed-Lorentzian spectrum (multiplets resolve — linewidth sharpened after the 1.1px floor was merging doublets), ChemDraw-style good/medium/rough shift labels, draggable popup, two-finger horizontal pan, a **Full size** popup, **Copy** as PNG (pastes into Word) + SVG, and **Export** to JCAMP-DX via the native save dialog (the blob download was a no-op in the Tauri webview). Build stamp `7.9.14.18-opus`.

## Milestones

Canonical numbering lives in `PLANS.md` → "Implementation sequence". Do not renumber.

| # | Milestone | Status | Assignment | Report |
|---|-----------|--------|-----------|--------|
| M1 | Runtime inventory and characterization tests | **done** | prompts/01 | reports/0001 |
| M2 | Persistent desktop plugin runtime (host, menu, panel-report renderer, diagnostics) | **done** | prompts/01 | reports/0001 |
| M3 | `molscribe-ocsr` runtime canary | **done** | prompts/01 | reports/0001 |
| M4 | Selection API extension (fingerprint, immutability, document/page identity) | **done** | prompts/02 | reports/0002 |
| M5 | Generic analysis API and store | **done** | prompts/02 | reports/0002 |
| M6 | NMR plugin package with fixture provider | **done** | prompts/03 | reports/0003 |
| M7 | NMR worker and client | **done** | reports/0004 | reports/0004 |
| M8 | NMR command and analysis integration | **done** | reports/0005 | reports/0005 |
| M9 | NMR panel (declarative report) | **done** | reports/0006 | reports/0006 |
| M10 | OCL-native predictor investigation | **done** (NMRShiftDB2-backed, default) | reports/0007 | reports/0007 |
| M11 | `nmr-predictor` compatibility spike (optional) | **done → rejected** (ADR-0013) | reports/0007 | reports/0007 |
| M12 | Documentation and provenance | **done** | reports/0008 | reports/0008 |
| M13 | Interactive linked figure (zoomable spectrum + annotated structure + hover cross-highlight); ADR-0015 | **done** | (user-directed) | reports/0009 |
| M14 | Plugin commands in the native menu (prefix-routed bridge; core change in scope); ADR-0016 | **done** | (user-directed) | reports/0010 |
| M15 | Usable ¹H: full NMRShiftDB2 corpus (pruned 6.1 MB) + first-order multiplicity/J; ADR-0017 | **done** | (user-directed) | reports/0011 |
| M16 | Robust/honest ¹H: functional-group fallback, per-peak provenance, split-peak rendering; ADR-0018 | **done** | (user-directed) | reports/0012 |
| — | Structure-fidelity fix: lossless molfile at the plugin boundary (fused rings → straight chains); ADR-0019 | **done** | (user-reported bug) | reports/0013 |
| — | General SMILES writer for fused/bridged/spiro rings (fixes the app's own copy-as-SMILES; ADR-0019 follow-up) | **done** | (bg task) | commit 06f2a050 |
| — | Linked-figure update flicker: sync viewport during render, not a post-paint effect (no old-layout flash) | **done** | (user-reported) | commit b93bb504 |
| M17a | Honest per-peak confidence tier (surface HOSE sphere depth + reference n); ADR-0020 | **done** | (user-directed) | reports/0014 |
| M17b | Source-backed substituent-correction refinement for weak/high-dispersion classes; HOSE-first comparison; ADR-0023 | **done** | (user-directed) | reports/0020 |
| M18 | NP-MRD measured-J feasibility research → **NO-GO** (measured J not freely bundleable; estimated-J ceiling); ADR-0021 | **done** | (user-directed) | reports/0015 |
| M17a2 | Reflect low/estimated confidence in the linked figure (mute low-confidence peaks) | **done** | (user-directed) | commit f764099c |
| M19a | Second analyzer `@chemdraft/plugin-mass-fragment` (formula/mass/adducts/isotopes) proving the generic infra is domain-agnostic | **done** | (user-directed) | reports/0016 |
| M20 | NMR results UX: real (summed-Lorentzian) spectrum + ChemDraw-style quality-colored labels, draggable panel, copy-SVG + JCAMP-DX export | **done** | (user-directed) | reports/0017 |
| M21 | Results UX round 2: fix Export (native save), copy-as-PNG (+SVG) for Word, two-finger horizontal pan, Full-size popup; linewidth sharpened so multiplets resolve | **done** | (user-directed) | reports/0018 |
| — | Tight plotted ppm window (peaks ± ~1 ppm ¹H / ~10 ppm ¹³C, snapped) instead of the full conventional range | **done** | (user-directed) | commit 50b8b9da |
| M22 | Run again repeats the *viewed* nucleus (report `rerunCommandId`, generic) + dynamic shift-label font sizing for crowded structures | **done** | (user-directed) | commit d4fd2e0c |
| M23 | Solvent note (CDCl₃-predominant, measured results only) + spectrometer-field selector 300–1000 MHz (multiplet spacing + JCAMP freq) + pseudo-Voigt lineshape (no more identical base flare) | **done** | (user-directed) | commit 80539823 |
| — | Default spectrometer field 300 MHz | **done** | (user-directed) | commit e91b09e5 |
| M24 | Additive-increment ¹H second opinion: transparent cross-check + absolute/σ threshold (not %); presentation refined by M17b/ADR-0023 to Prefer HOSE + Show both | **done** | (user-directed) | reports/0019, reports/0020 |
| M25 | Every applicable increment visible; explicit HOSE-only disabled state; coverage-aware agreement; potentially nonequivalent CH2 disclosure; ADR-0024 | **done** | (user-directed) | reports/0021 |
| M26 | Low-confidence spectrum labels suppressed while curves/hover targets and molecular labels remain visible | **superseded by M27** | (user-directed) | reports/0022 |
| M27 | Confidence-free spectrum trace (uniform curves + labels; confidence in structure labels/table/notices only) + strychnine-vs-SDBS accuracy spot-check; ADR-0025 | **done** | (user-directed) | reports/0023 |
| M28 | Reproducible DB rebuild: pipeline-enforced `n ≥ 5` prune + raw-input SHA-256/bytes + prune rule recorded in provenance | **done** | (user-directed) | reports/0024 |
| M29 | Leakage-free accuracy benchmark: structure-identity split + production-lookup scoring + first full-corpus run (¹H median 0.17 ppm, ¹³C median 1.6 ppm held-out); ADR-0026 | **done** | (user-directed) | reports/0025 |
| M30 | Bundled DB regenerated via M28 pipeline: byte-identical entries (reproducibility proven), corpus identity (`inputSha256`) recorded in provenance | **done** | (user-directed) | reports/0026 |
| M31 | Measured per-tier error in the panel's Reference-database section, checksum-gated to the benchmarked corpus (claim drops for any other build) | **done** | (user-directed) | reports/0026 |
| M32 | Top-level Plugins menu + core Add or Remove Plugins manager; live/persisted bundled enable-disable; package install visibly deferred; ADR-0027 | **done; pushed** | (user-directed) | reports/0027 |
| M33 | Plugin extraction architecture: single-package SDK boundary + machine-enforced guard + source-distribution zip tool + documented core-enablement patch + author guide; ADR-0028 | **done; pushed** | (user-directed) | reports/0028 |
| M33h | Hardening: AST-based boundary parsing (subpaths/dynamic-imports/relative-escapes), git-clean + license fail-closed gates, checksum sidecar, corrected plugin license status (D-11) | **done; pushed** | (agent-continuation) | reports/0028 addendum |
| M34 | Runtime plugin isolation boundary: a bundled plugin runs in a per-plugin Web Worker over a versioned async message protocol; capabilities auto-granted per manifest (permissive); proven with mass-fragment + NMR — **nested workers confirmed in Tauri WKWebView**; ADR-0029 | **done; pushed** (`6c4208df`) | prompts/04 | reports/0029 |
| M35 | Built installable plugin package + `plugin:package` pipeline (manifest.json + built ES-module worker + LICENSE + checksum); worker loads the *built* artifact; **asset resolution requires a co-located same-origin URL — blob URLs disproven by measurement**; ADR-0029 | **done; pushed** (`0fd3ecee`) | prompts/05 | reports/0030 |
| — | NMR labeling correction: the manifest described a "fixture-backed / synthetic data" predictor while the shipped backend is OCL HOSE-fragment over NMRShiftDB2-derived statistics — about to become user-facing via `plugin:package` + M36's install UI. Root cause fixed too: AGENTS.md's Phase-1 chemistry rules still named the fixture provider as *required* and forbade the multiplicity/J that M15/M16 shipped as labeled topology estimates | **done; pushed** (`0fd3ecee`) | (user-directed) | — |
| M36 | Install/uninstall UX (desktop): wire "Add plugin from package…" — checksum-verify, show declared permissions (no consent gate), stage → load → register; uninstall = terminate + remove + forget; persist installs across restart. **Serving hook solved with no origin change** — the app registers the `tauri` scheme itself, pre-empting Tauri's built-in, so nothing persisted is orphaned; ADR-0029 | **done** (working tree; not committed) — one gap: GUI click-through unverified | prompts/06 | reports/0031 |
| M37 | ~~Web install surface~~ — **DROPPED (D-13, 2026-07-16)**: the browser build (`pnpm dev:web`) is a dev preview per the repo README, not a shipped product; a plugin installer for it buys nothing. ChemDraft installs plugins on the desktop only | **dropped** | — | — |
| — | Runtime reconciliation study: main independently built a rival plugin runtime (3 commits incl. the stable-registry refactor); collision mapped to 4 real clash points + 17 both-touched files; union proposal + panel options framed | **done; verified** | (user-directed) | reports/0032 |
| M38 | **Runtime union merge** (revised Phase 1 of PLAN-plugin-separation): trunk = main, plugin architecture = ours, main's 4 plugin pieces ported onto our runtime, **unified panels now** (owner chose Option C over the study's A-then-C: one renderer serving the in-app surface AND main's floating windows, + Run-again/staleness bridge); NMR stays bundled as the safety net; ADR-0030 | **done; verified; GUI-pass PASSED (2026-07-17); NOT pushed** (merge `1232a444` + tests `2d9bdef1` on `merge/plugin-union`) — 1,807 tests, full tauri build, unified panels shipped with no fallback; **hand-driven in the running app: prediction 128.10 ✓, pop-out window with linked figure ✓, staleness across the bridge both ways ✓, install→[Installed]→predict-from-installed→uninstall→clean disk ✓ — R11/the M36 gap is CLOSED** | prompts/07 | reports/0033 + addendum |
| M39 | **Core-only strip** (separation Phase 3, the user's "TestBranch"): bundled NMR removed entirely (−21.6 MB from the bundle; 67 files; zero refs) while the whole plugin system stays intact and tested via mass-fragment; 1,641 tests + full build + 45 cargo green | **done; verified; pushed** (`core-only` @ `1a0467b5`) | prompts/08 | reports/0034 |
| — | **Phase 4 — the from-zero install test: PASSED (2026-07-17).** The core-only app (no NMR anywhere) installed the real zip → review chips/checksum/provenance → Analyze menu regained ¹³C/¹H from the package alone → prediction ran → uninstall auto-closed the panel (designed teardown) and left **zero disk residue**. The user's original acceptance test is met. Driven live (assistant + user clicks where macOS window-server pathologies blocked automation) | **PASSED** | — | reports/0034 §Phase 4 |
| — | **Phase 5 — promote to `main`: DONE (2026-07-17).** Owner ran `push origin core-only:main` (`a3c77356..1a0467b5`, fast-forward, no history rewritten). **`main` now ships the whole plugin system** — worker isolation, installer, manager, unified panels, toolbars union — with **no NMR bundled** (installed from a zip). | **DONE** | — | — |
| M40 | **SDK publishable** (Phase 2): `@chemdraft/plugin-api` + `@chemdraft/plugin-host` become self-contained npm packages (chem-core **bundled**, not published — preserves ADR-0028), MIT, both `0.1.0`, esbuild+rollup-dts build (tsup crashed on Node 26); **external-consumer gate PASSED** (only api+host installed, full typecheck), lint clean, 1,641 tests, internal src-resolution preserved; **actual publish left to owner**; ADR-0031 | **done; fully verified** (commit `60856d4b` on `sdk-publish`, not pushed; lint + 1,641 tests + **full tauri build all green**) | prompts/09 | reports/0035 |
| M41+M42 | **Standalone plugin repo** (Phases 6–7): self-contained repo at **`~/programming/chemdraft-nmr-plugin`** (OFF iCloud), **SDK vendored as tarballs** (`file:` deps; ADR-0031 / D-15 resolved), vendor the packaging tool, cut the first release zip. **History path (`git subtree split`) stays FS-blocked** (SIGBUS on iCloud packs), so seeding is **clean-init from current source @ `125aebeb`** — full history remains safe on `origin/codex/nmr-plugin` and can be grafted in later once the repos are off iCloud. Building in the clean location (storm can't reach it). | **DONE & verified** — repo at `~/programming/chemdraft-nmr-plugin`, commit `38262c2`; **self-builds its own `nmr-predictor-0.1.0.zip`** (checksum OK, no monorepo, no chem-core, provenance = its own commit). **FULL HISTORY NOW GRAFTED** (2026-07-17): 25 commits = the plugin's real M6→M36 arc (subtree-split from a fresh GitHub clone off iCloud) + the standalone-setup commit on top; working tree byte-identical to pre-graft (verified), release zip still valid. | prompts/10 | reports/0036 |

## Next milestone

**Separation program approved (PLAN-plugin-separation.md; D-15/16/17 decided) — paused on a discovery.**
Pre-flight for the drift merge found **main independently built its own plugin runtime** (commits
`e04734ea`, `611f63f8`: `pluginRuntime.ts` + toolbar-catalog toolsets + `panelBridge`/`PluginPanelWindow`
separate-window panels + `PatchReviewTray` + an unconditionally-registered fixture plugin) in the same
`apps/desktop/src/plugins/` path ours occupies. `plugin-api`/`plugin-host` untouched on main — the
contracts held; the collision is desktop-layer only. The **reconciliation study is COMPLETE and
control-room-verified (reports/0032)**. Verdict: the collision is real in only four places (runtime
wrapper, command dispatch, panels, MainWindow.tsx); everything else is cleanly additive on one side.
Main's Phase-1 **stable CommandRegistry** refactor retires our A2/A3 workaround (the host can simply
share the registry — the injection seam already exists at `plugin-host/src/index.ts:150`). Main's panel
window would **silently drop** our `linkedFigure` section (`default: return null`), but the figure itself
is self-contained data — a separate window does NOT break hover linkage. Biggest surprise: the larger
merge mass is main's **toolbars subsystem** (4,211 lines + 5,112 toolsets.json), not plugins. Proposed
union: **main as git trunk, ours as plugin architecture**, porting main's four plugin pieces (registry
substrate, toolset stage + rollback, disk storage, patch-review tray) onto our runtime. **Two owner
decisions pending: (a) panel model — study recommends in-app now (Option A), unified renderer in main's
floating window (Option C) as follow-up; (b) confirm main-as-trunk/ours-as-plugin-base.** Risk R1: main
keeps moving — execute soon once decided. M36 is pushed (`125aebeb`); the ADR-0029 program is complete.

**Goal 1 — a downloadable zip — DELIVERED.** `pnpm plugin:package -- examples/plugins/nmr-predictor` on a
clean tree produces `dist/plugin-packages/nmr-predictor-0.0.0.zip`, **3.45 MB** (17.01 MB unpacked, 7
files), sha256 `9d83a901…56d8c9`, sidecar verifies `OK`, boundary clean, provenance **`sourceCommit
0fd3ecee / sourceTree clean`**. The corrected NMR description is confirmed *inside* that zip's
`manifest.json`. (mass-fragment: 0.79 MB / 2.40 MB, 5 files.)

**Goal 2 — install/uninstall from a simple interface — DELIVERED (M36, reports/0031).** "Add plugin from
package…" is real: verify → display declared permissions (no consent gate) → stage into
`<appData>/installed-plugins/<id>/` → serve → load → register. Uninstall = `terminate()` + remove +
unregister + forget. Installs persist across restart. 1590 tests (+45), lint + build green, 5 Rust tests.

**M36's serving-hook verdict — the gate passed, no origin change.**
`register_uri_scheme_protocol("tauri", …)` **pre-empts Tauri's built-in `tauri://` handler**
(`manager/webview.rs:267` installs the built-in only if the app registered none), so the origin stays
byte-identical and **nothing is orphaned** — no localStorage (incl. M32's disabled ids), no IndexedDB.
Verified against tauri 2.11.2 source *and* proven by logging real served requests in the release app.
Two negatives worth keeping so they are not retried: `on_web_resource_request` **cannot** serve new paths
(it runs *after* `get_asset(path)?` returns early for unknown ones — it can rewrite existing assets, never
introduce new); and `dev = !custom_protocol`, so a bare `cargo build --release` silently runs in dev mode
and loads `devUrl` — always verify via `tauri build`.

**Two follow-ups needing the project owner:**

1. **The GUI click-through is unverified — the one acceptance gap.** The M36 agent's computer-use access
   to ChemDraft was **requested twice and denied**, so nobody has driven Add plugin from package… →
   picker → Install → Analyze ▸ NMR by hand. Every component is verified in a real engine (the release
   app served `/installed-plugins/<id>/entry.js` on its own origin and the worker passed the handshake; a
   WKWebView probe drove benzene ¹³C → **128.1 ppm** from the staged package with the in-thread fallback
   chunk fetched **0 times**), and the UI has 6 jsdom tests — but the *composition through the actual
   button* is not. One manual run closes it.
2. **D-14 — shadowing:** an installed package replaces a bundled plugin of the same id. Needs confirming.

**Pending:** M36 is uncommitted by design (the prompt forbade committing).

**D-11 is RESOLVED — the plugins are MIT** (owner, 2026-07-16). This closed a live compliance gap, not just
a paperwork one: the nmrshiftdb2 Database License requires prediction software relying on the database to
be **OSI-licensed**, so an unlicensed plugin was failing a condition of the data it ships. MIT does **not**
cover the bundled database — that stays share-alike + attribution (ODbL-derived) and travels inside every
zip. **Packaged zips must be rebuilt** to carry the new terms (the LICENSE lives inside the package).
*Still open and flagged in Risks:* the app itself bundles that database while the root repo is
`UNLICENSED` — whether the OSI condition reaches ChemDraft is the owner's call.

Optional futures, unblocked: **publish** `@chemdraft/plugin-api`/`plugin-host` to a registry so an
installed plugin resolves the SDK from a real source; **slim the NMR package** (~6.4 MB of its 17 MB is a
duplicate DB for an in-thread fallback that never runs when nesting works); **collapse** the desktop's
static worker entries, which now duplicate the plugins' own `workerEntry.ts`; **split** the
`loadPackagedPlugin` → `registerBundledPlugins` layering seam.

## Assumption ledger

Every repository-state assumption the plan makes, with its verification verdict.
Re-verify rows marked `stale-risk` whenever `main` moves before an assignment starts.

| # | Assumption (from PLANS/FIRSTPROMPT) | Verdict | Evidence (at 64cf513e) |
|---|---|---|---|
| A1 | `PluginHost` is not instantiated by the desktop | **TRUE** | `new PluginHost` appears only in `packages/plugin-host/src/*.test.ts` |
| A2 | `MainWindow` constructs `CommandRegistry` directly | **TRUE** | `apps/desktop/src/MainWindow.tsx:6306` (inside a `useMemo`) |
| A3 | Command registry is recreated when document deps change | **TRUE** (confirmed M1) | `useMemo` dep array includes `selectedNativeMoleculePart` + `document.selection.objectIds` length, so it rebuilds on selection/document change — this is why the plugin host lives in a ref, not this memo |
| A4 | `molscribe-ocsr` exists as a package, not mounted in the desktop | **TRUE** | `examples/plugins/molscribe-ocsr/src/index.ts`; zero references in `apps/desktop/src` |
| A5 | No manifest-driven Analyze menu | **PARTIAL** | An `Analyze` menu section EXISTS (`appMenu.ts:241`) with one core item (`chemistry.validateSelection`); it is not plugin-fed. Web menu mirrors native Tauri menu one-for-one via a drift test (`appMenu.test.ts` reads `MENU_COMMAND_IDS` from `src-tauri/src/lib.rs`); `nativePredefined` exclusion precedent exists |
| A6 | No contributed panel host | **PARTIAL** | Host-side plumbing EXISTS: `PluginPanelAPI.showReport` + `PluginHostOptions.showPanelReport` + validated declarative `PluginPanelReport` (text/keyValue/table/svg sections, svg ≤ 512 KB, script-safe). The desktop never supplies `showPanelReport`, so no rendering surface exists |
| A7 | No bundled-plugin list or diagnostics UI | **TRUE** | no `listPlugins` callers in `apps/desktop/src` |
| A8 | `invokeCommandRef` ref-based invocation pattern exists | **TRUE** | `MainWindow.tsx:1714` |
| A9 | Conformer worker/client request-ID pattern exists | **TRUE** | `apps/desktop/src/conformerWorker.ts`, `conformerClient.ts` (+ tests) |
| A10 | Menu rendering belongs to desktop/toolset layer, not plugin-host | **TRUE** | `appMenu.ts` (web) + `src-tauri/src/lib.rs` (native); note: NOT the toolset registry — toolsets are separate floating windows |
| A11 | `PluginCommandContext` lacks a selection API | **FALSE** | `PluginSelectionAPI.getSelection(): Promise<PluginSelectionSnapshot>` exists (`plugin-api/src/index.ts:397`); permission-gated **optional** property (`selection?`), behavior covered by `selectionStorage.test.ts` |
| A12 | `PluginCommandContext` lacks an analysis API | **TRUE → BUILT in M5** | `analysis?` context API + in-memory `AnalysisStore` (host-stamped, deep-copied, queryable, plugin-scoped reads + desktop read-all) |
| A13 | Permissions include `selection.read` and `analysis.write` | **TRUE** | `plugin-api/src/index.ts:6-28`; also `selection.write`, `image.read`, and a `dangerousPluginPermissions` list |
| A14 | `apiVersion` is a nonempty string, not semantically enforced | **TRUE** | `PluginManifestSchema` (`index.ts:195`); NOTE: molscribe example uses `"^0.1.0"` (caret), host `PluginApiVersion = "0.1.0"` |
| A15 | Document formats are `smiles`, `molfile-v2000`, `molfile-v3000`, `unknown` | **TRUE** | `packages/chem-core/src/schemas.ts:347` |
| A16 | ChemDraft already ships OpenChemLib | **TRUE** | `openchemlib ^9.22.1` in `apps/desktop` and `packages/ocl-adapter` |
| A17 | Host lacks a selected-structure provider | **FALSE → gap FIXED in M4** | Provider existed; M4 added host deep-clone+freeze, `sourceFingerprint`, format enum, and document/page identity |
| A18 | Host lacks analysis store, subscriptions, contribution enumeration | **TRUE** | Host has only `listPlugins()` + `onProposedPatchesChanged` callback; no analysis store, no general `subscribe`, no per-contribution enumeration helpers |
| A19 | Host has injectable clock and duplicate/permission enforcement | **TRUE** | `PluginHostOptions.now`; duplicate registration throws; contribution permissions validated against declared permissions; `unregisterPlugin` and `validateTrustedPluginManifest` also exist (plan didn't know) |

## New facts the original plan did not know

1. **Declarative panel model is a settled repo decision.** Plugins push `PluginPanelReport` data (never framework components); the host renders with core UI; SVG travels as a string rendered in an `<img>` context so scripts can never execute. The plan's React-panel-registry design is replaced by a desktop **report renderer** (see PLANS.md "Panel reports" and ADR-0004).
2. **ID naming convention:** commands `plugin.<pluginName>.<action>`, menus `menu.<pluginName>.<action>`, panels `panel.<pluginName>.<name>`, recognizers/analyzers likewise. Toolset ids are regex-enforced to start with `plugin.`. `apps/desktop/src/toolsets.ts` keys plugin-vs-core off the `plugin.` command prefix. The plan's `nmr.*` ids are renamed accordingly.
3. **Contributions schema has 12 keys** (commands, menus, panels, toolbarButtons, toolsets, inspectors, templates, importers, exporters, analyzers, transformers, recognizers), all defaulting to `[]`.
4. **Per-branch doc convention:** each feature worktree carries its own `AGENTS.md` (with a build stamp `[month].[day].[hour].[minute]-[agent_name]` that must be kept in sync with the `Build` string in `MainWindow.tsx`), `PLANS.md` (the active slice plan), and numbered `CODEX_PROMPT_NN_<topic>.md` files. Notary/signing instructions live at `~/Documents/programming/.notary`.
5. **A selection-architecture refactor is pending** (`PLANS-selection-policy.md` in the repo, status: planning only). The M4 selection provider must stay a thin adapter over current selection state so that refactor can land without breaking plugins.
6. **`examples/plugins/` already has five entries** (advanced-style-pack, journal-style-pack, mass-fragment-demo, molscribe-ocsr, opsin-name-to-structure). Only molscribe-ocsr has code; mass-fragment-demo is a placeholder README and is the natural "second analyzer" that should later validate the generic analyzer path.
7. **`MainWindow.tsx` is ~23,500 lines** — far larger than the plan implies. Extracting the plugin runtime into focused modules is mandatory, not stylistic.
8. **A disabled plugin cannot be listed from `PluginHost.listPlugins()`.** M32 therefore keeps a runtime-scoped bundled descriptor catalog and uses the host only for live enabled state; otherwise a disabled row would disappear and could not be restored.
9. **The host change signal already existed.** `PluginHost.subscribe` and `usePluginRuntime`'s version bump already re-derive plugin menus after registration changes; M32 did not add a second signal.
10. **The pre-M32 diagnostics surface listed bundled plugins but had no toggle.** The manager is a separate core-owned modal; diagnostics remains diagnostics-only.

## Open decisions

| ID | Decision | Recommendation | Status |
|----|----------|----------------|--------|
| D-01 | How plugin Analyze items enter the menu without breaking the native-menu drift test | Extend the `appMenu.ts` model with a `pluginContributed` flag excluded from the `lib.rs` comparison (mirrors existing `nativePredefined` exclusion); native menu can adopt dynamic plugin items later the way toolset menus already do | **resolved & shipped (M2)** — ADR-0009 now accepted |
| D-02 | Keep `selection?` optional on the command context vs. always-present-and-throwing | Keep the existing tested optional contract for Phase 1; revisit only with a deliberate breaking-change decision | proposed (ADR-0008) |
| D-03 | Panel interactivity (Predict again, ¹H toggle, Cancel) under the declarative report model | Phase 1: host-rendered panel chrome offers "Run again" from the panel contribution's `commandId`; nucleus toggle via a second command or a future `actions` section kind; cancel via supersession | proposed — design in M9 prompt |
| D-04 | Worktree/branch name for implementation | e.g. `chemdraw-nmr` + branch `codex/nmr-plugin`, matching existing convention | pending user |
| D-05 | `nmr-predictor` spike go/no-go | Decide after M9; governed by kill criteria in PLANS.md | deferred |
| D-06 | Command failures via `PluginCommandResult {ok:false}` are silent (only thrown errors surface) | Desktop dispatch surfaces `ok:false` like a throw | **resolved & shipped (M8)** — ADR-0010; `MainWindow` inspects the resolved result |
| D-07 | Parameterized commands (¹H vs ¹³C) with no invoke payload | Value-encoded distinct commands, not an args channel | resolved (ADR-0011) |
| D-08 | Plugins get no panel-close signal; late reports resurrect closed panels | `onPanelClosed` hook + closed-panel reports don't reopen | **resolved & shipped (M9)** — ADR-0012; hook + abort-on-close + post-predict aborted check |
| D-09 | Report staleness needs an optional `source` ref on the report schema | Add `source?: {objectId, sourceFingerprint}` to `PluginPanelReportSchema`; consumed by desktop chrome | **resolved & shipped (M9)** — desktop compares `computeObjectFingerprint` to the report source and shows a stale banner |
| D-10 | What “Add or Remove Plugins” means before a plugin package format/installer exists | Manage the statically bundled catalog: disable=unregister, persist disabled IDs locally, and show package install as visibly deferred | **resolved & shipped (M32)** — ADR-0027 |
| D-11 | The NMR plugin's code license is not finalized. `LICENSE` now states this explicitly (M33 hardening) instead of the prior README/notices text incorrectly claiming MIT. The extraction tool refuses to build a zip without a `LICENSE`/`LICENSE.md` file present, so extraction works today, but the zip carries "not licensed for public redistribution" terms | **RESOLVED — MIT** (owner, 2026-07-16: *"the license on the plugin can be whatever makes sense. it's a separate dependency that does not need to share a license with the main program"*). Applied to both example plugins' `LICENSE` and `package.json`. MIT was **not** an arbitrary default: the **nmrshiftdb2 Database License requires prediction software relying on the database to be under an OSI-approved license**, so while unlicensed the plugin was *failing a condition of the very data it ships* — MIT satisfies it and makes `NMRSHIFTDB2_LICENSE.md`'s pre-existing "this plugin's code is MIT" claim true rather than aspirational. **The MIT grant explicitly does not cover the bundled database**, which remains a derivative database under the nmrshiftdb2 Database License (ODbL-derived), with share-alike + attribution travelling inside every packaged `.zip`. Carve-out written into both `LICENSE` files and AGENTS.md | **resolved (2026-07-16)** — packaged zips must be **rebuilt** to carry the new terms |
| D-12 | Runtime plugin execution model + security posture for the installer | Per-plugin **Web Worker** (clean `terminate()` uninstall + crash isolation + web-capable load; *not* a security sandbox) with a **permissive** policy — declared permissions auto-granted, no consent gate, no signing, checksum = integrity only. Rationale: niche audience whose realistic user is a self-authoring developer, not an attacker (user steer). Seams (worker boundary + declared-permission manifest) are the attach points if a stricter posture is ever needed | **resolved — ADR-0029**; delivered M34–M37 |
| D-13 | How — or whether — the **web build** installs a plugin. ADR-0029 §6 said "in-memory / IndexedDB blob"; M35 **disproved it by measurement** (reports/0030): a blob URL has no sibling files, so a multi-file package (NMR's nested worker + 7.5 MB DB) cannot resolve, and inlining 7.5 MB is unacceptable | **Dropped web install entirely.** The deciding fact was not the mechanism but the *surface*: the repo README calls `pnpm dev:web` "only a secondary browser preview while working on the React surface" — a dev convenience with no deploy and no CI, not a shipped product. Paying for an untested Service Worker shim to install plugins into a preview tool buys nothing. **ChemDraft installs plugins on the desktop only**; revisit only if a browser-hosted ChemDraft ever ships. (Origin of the error: the M34–M37 scoping question offered "Desktop + web" without first checking whether the web build was a real surface.) | **resolved (2026-07-16) — M37 dropped**; M36 unaffected |
| D-14 | An installed package **replaces (shadows) a bundled plugin of the same id** rather than being refused. Surfaced by a genuine spec collision in M36: a package keeps the id of the plugin it was built from, so the packaged id is byte-identical to the bundled one — and *both* packageable plugins are bundled. "Refuse an id already compiled in" would therefore reject the milestone's own fixture and leave the feature undemonstrable | **Keep it.** This is the ordinary case, not a workaround — and arguably a feature: a bundled plugin can be updated from a package without rebuilding the app. Implemented safely: the bundled copy is unregistered only *after* the replacement's handshake passes, uninstall hands the id back honoring the disabled-id set, and the manager dedupes by id with an "Installed" badge so one plugin never shows two rows. Worth an explicit confirmation because "which copy is running?" is now a real question | **proposed — needs owner confirmation** (reports/0031, Deviation 1) |

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| The desktop app **bundles** the NMR plugin and its nmrshiftdb2-derived database, while the **root repo is `UNLICENSED`** and its `LICENSE` is still "not finalized" | The nmrshiftdb2 Database License (per this repo's own summary in `NMRSHIFTDB2_LICENSE.md`) requires prediction software relying on the database to be under an **OSI-approved** license. The *plugin* now satisfies this (MIT, D-11). Whether that condition also reaches **ChemDraft itself** — which ships the plugin and the database inside the app — is unresolved | **Open — flagged 2026-07-16, needs the project owner.** Not a blocker for the plugin or for the packaged zip. Relevant before redistributing the *app*. Note the upstream license text governs, not this repo's summary of it — and this is a question for the owner (and if it matters commercially, a lawyer), not an agent |
| Native Tauri menu cannot easily host dynamic plugin items | Analyze contributions web-only at first | Precedent: toolset menus are already dynamic (`create_app_menu_for_toolsets`); fall back to web-menu-only + drift-test exclusion, document the gap |
| ~~Worker bundling across workspace packages~~ | ~~M7 blocked~~ | **RETIRED (M7, reports/0004):** `new Worker(new URL("./nmrWorker.ts", import.meta.url))` in the plugin package emits a `nmrWorker-*.js` chunk under the desktop Vite build, like the conformer worker. Prerequisite: desktop must declare the plugin as a workspace dep. No fallback needed |
| `main` moves before the NMR worktree is cut (assumption rot) | Prompts reference stale line numbers / APIs | Re-run the assumption ledger's checks when cutting the worktree; prompts instruct agents to verify before editing |
| Selection-policy refactor lands mid-effort | Selection provider breakage | Provider is a thin adapter; M4 tests pin snapshot semantics, not MainWindow internals |
| MainWindow size makes integration risky | Regressions in unrelated features | All new runtime code in `apps/desktop/src/plugins/` modules; MainWindow gets only wiring calls |
| ~~Database rebuild does not yet encode the shipped `n >= 5` pruning step~~ | ~~A raw-corpus rebuild may not reproduce the bundled database~~ | **RESOLVED (M28, report 0024):** pipeline enforces the prune and embeds raw-input SHA-256/bytes + rule in provenance. Residual: the original 2026-07-09 input's checksum is unrecoverable; recorded automatically at the next refresh |
| ~~No independent assigned-shift benchmark exists~~ | ~~Accuracy/general agreement not validated~~ | **RESOLVED (M29, report 0025):** leakage-free held-out benchmark shipped and run — ¹H median 0.17 ppm, ¹³C median 1.6 ppm; tiers empirically order error. Residual: one seed, NMRShiftDB2-like chemistry only |

## Workflow

1. Finalize the next assignment in `prompts/` (copy `prompts/TEMPLATE.md`).
2. Cut/refresh the implementation worktree; drop in the current `AGENTS.md`, `PLANS.md`, and the assignment prompt.
3. Run the agent; it must verify assumptions before editing and end with a structured report.
4. Archive the report under `reports/`, update the milestone table and assumption ledger here, and record any new decisions in `decisions/`.
5. Fix `PLANS.md`/`AGENTS.md` if the report contradicts them, then draft the next prompt.
