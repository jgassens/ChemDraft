# Report 0033 — Runtime union merge executed: `main` × `codex/nmr-plugin`, unified panels shipped

- **Assignment:** `prompts/07-runtime-union-merge.md`; **Decision:** ADR-0030 (on study report 0032)
- **Worktree:** `~/Documents/programming/chemdraw-plugin-union`, branch `merge/plugin-union` — **merge commit `1232a444`** (parents `a3c77356` = main, `125aebeb` = codex/nmr-plugin), one fix-up commit `2d9bdef1` (the new union tests). **Nothing pushed.** `chemdraw-nmr` (codex/nmr-plugin @ `125aebeb`) and the primary `chemdraw` checkout (main @ `a3c77356`) verified undisturbed.
- **Build stamp:** `7.16.17.45-fable` in `MainWindow.tsx`. AGENTS.md carries no stamp line — main's deliberately de-scoped AGENTS.md (kept as the union base) itself documents `CURRENT_BUILD_STAMP` in MainWindow.tsx as the stamp's home; the union tree's own convention was followed rather than reintroducing the branch-scoped header line.

> **Control-room verification (independent, 2026-07-16):** merge commit `1232a444` confirmed with the
> correct two parents; fix-up `2d9bdef1` present; union tree clean; `git ls-remote` shows **no**
> `merge/plugin-union` ref on origin (not pushed); `chemdraw-nmr` confirmed untouched and clean at
> `125aebeb`. Spot-checks: `PluginPanelWindow.tsx:118` renders `<PluginReportRenderer report=…/>` (the
> renderer swap is real); `createPluginRuntime.ts` carries `commandRegistry?` (:24, wired :73), the
> `ui.toolbar` gate (:98), and `listPluginToolsets` (:123); `usePluginRuntime.ts:196` has the R3
> ownership fix (`…?.pluginId !== undefined`); `lib.rs` has `mod installed_plugins` (:3), the
> `ToolbarsMenuModel` managed state (:131, :298), and the `tauri://` scheme pre-empt (:304). Ran the
> guard subset directly: **279 tests passed across 13 files** (App.test 177, MainWindow.plugins.dom 4,
> PluginPanelWindow.dom 6, PluginPanelSurface.dom 15, PluginPanelController 7, toolsetContributions 6,
> coreCommandRegistrar 5, pluginRuntime 9, usePluginRuntime.dom 1, installPluginPackage 24,
> pluginWorkerBridge 8, appMenu 10, packagedPluginLoad 7 — incl. the M35 byte-equivalence test). The
> full 1,807-test suite, tauri build, and cargo tests were not re-run here; those are the agent's,
> reproduced below.

## Outcome headline

**The union is complete and green, with the owner's unify-NOW panel choice shipped — the sanctioned fallback was not needed.** Full suite: **1,807 passed | 10 skipped (1,817), 135 files** — vs ours 1,590/1,599 (119 files) and main measured pre-merge at **1,410 passed | 9 skipped (1,419), 94 files**. `pnpm lint` clean, **full `pnpm build` (tauri) exit 0** (`ChemDraft.app` + `.dmg` bundled; worker chunks emitted at M35 sizes with the nested OCL-worker reference intact), `cargo test --lib` 45 passed. The interactive NMR linked figure now renders in main's floating panel window through our one renderer; window dismissal is a real ADR-0012 close; Run-again and staleness cross the bridge.

## The 17 conflicted files — disposition

| # | File | Disposition |
|---|---|---|
| 1 | AGENTS.md | **Hand-fused editorial.** Main's de-scoped repo-wide version wholesale + new section **"8a. Plugin runtime, packaging, and NMR rules"** folding in our durable repo truths: one-persistent-runtime + shared-registry + registration-through-the-runtime invariants, one-renderer panel rule, worker-isolation/install invariants (tauri:// pre-empt and dev middleware marked do-not-remove), naming conventions, the NMR scientific-claim rules, and the MIT-plugins + database-carve-out licensing block. |
| 2 | PLANS.md | **Editorial.** Main's trunk plan (Rings/Inspector) kept; prepended a short "Runtime union merge" section pointing at the planning workspace and the codex branch for the program's records. |
| 3 | apps/desktop/package.json | **Auto-merged by git, verified:** dnd-kit trio + our five workspace plugin deps coexist. |
| 4 | src-tauri/build.rs | **Hand-resolved (comment-only conflict → main's).** The command list had already auto-unioned (both sides' commands present). |
| 5 | capabilities/default.json | **Auto-merged, verified against study §4.5:** main's window globs (`toolset-*`, `plugin-panel-*`) + storage/panel/hide permissions AND our `allow-sync-plugin-menu-items`, fs permissions, `$APPDATA/installed-plugins*` scopes. |
| 6 | src-tauri/src/lib.rs | **Hand-fused structural** — detail under "Rust re-target" below. |
| 7 | src/App.css | **Hand-resolved:** appended both style families (disjointness held); +2 lines later adding `.plugin-panel-open-window` to the existing shared action-button selectors. |
| 8 | src/MainWindow.tsx | **Hand-fused** — main's side wholesale + our hunks with the three fusions (next section). |
| 9 | src/appMenu.ts | **Auto-merged, verified:** Customize items + Plugins menu + `appendPluginMenuItems` all present. |
| 10/11 | documentWorkflow.ts / .test.ts | **Auto-merged, verified** (disjoint exports/suites; `getSelectedMolecules` predates both). |
| 12 | plugins/pluginRuntime.test.ts | **Add/add:** ours kept at the path; main's 6 tests → **`toolsetContributions.test.ts`** repointed at the union runtime. Two honest adaptations: the fake selection needed the now-required `sourceFingerprint`, and the `showPanelReport`-spy assertion became a controller open-panel assertion (the union runtime wires reports to the panel controller, not a bare callback). |
| 13 | src/vite-env.d.ts | **Hand-resolved** (dedupe; main's comment). |
| 14 | vite.config.ts | **Hand-fused:** merged imports, main's comments/realpath dependency roots, **our M36 staged-package dev middleware preserved (R7)**, `worker.format: "es"` preserved. |
| 15 | pnpm-lock.yaml | Auto-merged; **regenerated** via `pnpm install` before any verification (regeneration produced zero drift). |
| 16 | run-app | **Hand-resolved** (comment-only; both sides had converged on the dev-server reaper). |
| 17 | vitest.config.ts | **Auto-merged, verified:** main's workspace aliases (incl. plugin-api/host) + label + our include patterns. |

## The ten MainWindow hunks

1. **Imports (@475)** — applied, adapted: `PLUGIN_MANAGER_COMMAND_ID` + our six plugin imports added; main's `createDesktopPluginRuntime` import **removed** (module deleted); panelBridge import widened with the three new messages + `hidePluginPanelWindow`; now-unused `getSelectedMolecules` dropped from the documentWorkflow import.
2. **Build stamp (@1204)** — applied as a fresh stamp `7.16.17.45-fable` per convention (not ours' verbatim value).
3. **Worktree-title effect (@1527)** — **NOT applied: main independently built the byte-equivalent effect** (line 8415). The "ten hunks" are actually nine live ones; see the study scoring.
4. **usePluginRuntime block (@1796)** — applied at **main's runtime-memo location** (it needs `registry`, created at ~7150), replacing main's `createDesktopPluginRuntime` memo = **fusion (ii)**: providers use `buildPluginSelectionSnapshot` (our frozen superset replaces main's inline provider), plus `commandRegistry: registry`, `createStorage: createPersistentPluginStorage`, `onProposedPatchesChanged` → patch-queue bump. Main's toolset-sync + DEV-fixture effect, panel re-serve effect, and accept/reject callbacks kept, re-targeted at `pluginRuntime.runtime.*`; our native-menu sync effect and D-09 staleness computation follow it; the new detached-window effects (below) live here too.
5. **plugins.manage (@6348)** — **fusion (i):** a `register(...)` entry inside main's `coreCommandBindings` memo (flows through the stable registrar), with the two dialog `useState`s declared just above the bindings ref.
6. **Dispatch (@6826)** — **fusion (iii):** diagnostics toggle, then ownership-gated ADR-0010 surfacing around **main's single `host.invokeCommand` fall-through** (our `invokePluginCommand` *is* that call): plugin-owned commands get `{ok:false}`/throw surfaced as "Plugin command failed: …", core commands keep main's plain catch — necessary because main's core registrar handler legitimately resolves `{ok:false, commandId}` when a binding vanishes, which must not surface as a plugin failure.
7. **Dispatch deps (@6788)** — applied; main's `pluginRuntime` dep replaced by the two stable callbacks.
8/9. **appMenu context (@13069/@13079)** — applied verbatim (`pluginMenuItems` + dep).
10. **Manager dialog + panel surface render (@13129)** — applied after the MenuBar line; the surface additionally gets `onOpenAsWindow={isDesktopRuntime() ? popOutOpenPanel : undefined}`. `PatchReviewTray` (main's, at ~14512) kept with `host={pluginRuntime.runtime.host}`.

## Port list as executed

1. **Stable-registry substrate — adopted.** `coreCommandRegistrar` + bindings-map pattern arrived with main's MainWindow untouched. `createPluginRuntime` gained `commandRegistry?`/`createStorage?`/`onProposedPatchesChanged?` (and `getSelection` became optional, matching the host and main's callers); `usePluginRuntime` passes them through, read once at creation. **`isPluginCommand` fixed for R3**: `host.commands.get(id)?.pluginId !== undefined`, pinned by tests at three levels (registry semantics in `pluginRuntime.test.ts`, hook behavior in new `usePluginRuntime.dom.test.ts`, dispatch composition via the existing MainWindow dom tests).
2. **Toolset stage — ported into `createPluginRuntime` itself** (provenance maps, `host.requirePermission(id,"ui.toolbar")`, duplicate-toolset rejection, whole-plugin rollback, `listPluginToolsets`/`pluginIdForToolset`/`onDidChange`). Beyond the study's sketch, **every desktop registration path was re-routed through `runtime.registerPlugin`/`unregisterPlugin`** — `applyEnabledPlugins` (2 sites), installer rollback, `registerReplacing`, uninstall-restore — so a future toolset-contributing *installed* plugin gets the same gate and rollback. Main's `pluginRuntime.ts` wrapper deleted; its 6 tests live on as `toolsetContributions.test.ts`; `App.test.ts`'s fixture helper repointed (2-line change).
3. **Disk-backed storage — wired.** `createPersistentPluginStorage` flows MainWindow → hook → host `createStorage`; the Rust `plugin_storage_read/write` commands, size cap, and path guard arrived on main's side of lib.rs with no adaptation.
4. **PatchReviewTray — kept live** with adapted host reference; accept flows through `commitDocumentChange` (document history), queue-version bump via the new passthrough.
- **DEV fixture kept as-is**; in dev builds it will appear in the manager's plugin list (R8 — chose "show", zero code; flagged for the owner).

**Rust re-target (the one structural edit, slightly bigger than sketched).** Main's `set_toolbars_menu` held no state — JS pushed entries per call — so `sync_plugin_menu_items` had nothing to rebuild the Toolbars submenu or View checkmarks from. Added a `ToolbarsMenuModel` managed state (last-pushed rows + view state): `set_toolbars_menu` stores it and now passes plugin items into the rebuild; `reinstall_app_menu` (ours, re-targeted) rebuilds from both stored states; `create_app_menu` passes stored plugin items at startup; `create_app_menu_for_toolsets` is now `(app, &entries, view_state, &plugin_items)` with ours' `build_analyze_submenu` + Plugins submenu. Ours' base-era `ToolsetManifest` structs and `schedule_customized_toolset_menu` dropped (main deleted that architecture). `cargo check` clean; `cargo test --lib` **45 passed** (main's suite + our `installed_plugins` 5 + storage-id guards).

## Unified panels — Option C shipped (no fallback)

- **Renderer swap:** `PluginPanelWindow`'s private 4-kind switch replaced by `PluginReportRenderer` — `linkedFigure` renders in the floating window (test asserts `.lf-root` and the shared `.plugin-report` chrome; main's old switch would have silently dropped the whole section).
- **Bridge messages:** payload gains `commandId?`; new `chemdraft://plugin-panel-staleness` (revision-keyed so a late verdict can never mark a newer report), `…-rerun` (window→main; **main resolves the command from its live detached entry** and dispatches through `invokeCommandRef` — ADR-0010 surfacing applies; the message's id is not trusted), `…-closed` (window→main), plus `hidePluginPanelWindow` mirroring Rust's label scheme.
- **ADR-0012:** dismissing a window notifies panel-closed before hiding; MainWindow's listener calls `closeDetachedPanel`, which fires `host.notifyPanelClosed` — pinned by a window test (event emitted) and a controller test (host call).
- **Policy (ADR-0030 §4):** the controller gained a **detached per-panelId set** — `detachPanel` moves the open panel out *without* a close notification (surface change, not a close), reports for detached panels update in place without touching the in-app slot, replacement-close applies only in-app, several windows may float at once. Disable/uninstall now close detached panels too, and a reconcile effect hides orphaned windows. "Open as window" is surface chrome shown only when the desktop passes the handler — the browser build never renders it. Report payloads stay cached for the window request/re-serve path (main's semantics).
- **Tests added (12):** 6 window (renderer swap, revision guard, rerun relay, no-command hides the button, revision-keyed staleness, close cancellation), 3 controller (detach without notification + slot freeing, detached report routing, detached close = ADR-0012), 1 surface (Open-as-window chrome), 1 runtime (shared-registry ownership + single dispatch + scoped unregister), 1 hook (R3 ownership probe).
- **Not verified live:** actual native window behavior (float/hide-on-deactivate, exports/clipboard inside the window, real pop-out composition) — reading-only limits the study itself stated; all on the GUI list.

## Scoring the study's predictions (§4/§8/§9)

**Right, and load-bearing:** the 17-file list was exact (nothing missing, nothing extra); every §4 classification held; §4.7's class-disjointness and §4.5's "nothing ours needs was among main's deletions" were both confirmed by clean auto-merges; the three seams of §1.2/§2 existed exactly as cited and the registry port **was** a simplification; R3 was called precisely, including the suggested fix; §7's ground truth (renderer purity, linked-figure self-containment, the silent `default: return null` drop) all proved out in working tests; §6.3's disable→catalog chain held; the §4.6 re-target location was right.

**Wrong or missed (for calibration):**
1. **Hunk 3 was a no-op** — main independently built the identical MainWindow title effect. The study's own surprise #3 ("same five files") undercounted: MainWindow is a sixth instance. Ten hunks were really nine.
2. **§6.8's "main's runtime test 5 still passes (it fakes its own provider)" was false at the type level** — our `PluginSelectedMolecule.sourceFingerprint` is *required*, so the fake needed a one-line fix, and the `showPanelReport`-spy assertion had to be adapted to the controller-wired union runtime.
3. **§4.6 under-specified the Rust edit:** "thread plugin items into main's rebuild" was necessary but not sufficient — main's menu model was stateless per push, so re-targeting `sync_plugin_menu_items` required inventing the `ToolbarsMenuModel` stored model. Small, but real design work the outline didn't predict.
4. §5 described `docs/plugin-development/README.md` as main's two-paragraph stub without noting ours had rewritten the same path (M12) — it auto-merged to ours; no conflict, but the context was one-sided.
5. §9.2's package names (`packages/plugin-nmr-predictor` etc.) — actual paths are `examples/plugins/{nmr-predictor,mass-fragment-demo}`; the one-sided claim itself was right.
6. The suite-size prediction ("≈1,590 + main's suites") was directionally right: union at the merge commit was 1,795, i.e. main contributed +205 net after the renamed overlap; no double count materialized.

## Verification (all actually run by the agent, in the union worktree)

- `pnpm install` — lockfile regenerated first (no drift).
- `pnpm lint` — exit 0, clean.
- `pnpm test` — exit 0: **1,807 passed | 10 skipped (1,817), 132 files + 3 skipped (135)**. Baselines: **ours 1,590 | 9 (1,599)** (report 0031); **main 1,410 | 9 (1,419), 94 files — measured on pristine `a3c77356` before merging**. At the merge commit itself: 1,795 | 10; +12 new union tests = 1,807.
- **Named guard suites, one invocation — 295 passed | 1 skipped:** `App.test.ts` **177**, `coreCommandRegistrar.test.ts` **5**, `toolsetContributions.test.ts` **6**, `MainWindow.plugins.dom.test.ts` **4**, `PluginPanelSurface.dom.test.ts` **15**, `PluginPanelController.test.ts` **7**, `PluginPanelWindow.dom.test.ts` **6**, `installPluginPackage.test.ts` **24**, `pluginPackageArchive.test.ts` **17|1 skipped**, `pluginWorkerBridge.test.ts` **8**, `appMenu.test.ts` **10** (the native-menu drift guard), `usePluginRuntime.dom.test.ts` **1**, `pluginRuntime.test.ts` **9**, `packagedPluginLoad.test.ts` **7**.
- `pnpm build` — **exit 0, the full tauri build**: vite emitted `nmrPredictorPluginWorker` 1,184.38 kB / `massFragmentPluginWorker` 1,162.85 kB / nested `nmrWorker` **7,556.09 kB** with the `new Worker(new URL("/assets/nmrWorker-…"))` reference intact; Rust release compiled; `ChemDraft.app` + `ChemDraft_0.0.0_aarch64.dmg` bundled.
- `cargo test --lib` — **45 passed**.
- Not run: the app was not launched or GUI-driven.

## Unresolved risks vs R1–R12

R1 **open until this branch lands** (anything on main past `a3c77356` needs a trivial re-merge). R2 **closed** (guards + full suite + build). R3 **closed** (fix + 3 tests). R4 **partially closed** (drift test + cargo green; native menu behavior → GUI). R5 **partially closed** (union reviewed; export/clipboard inside `plugin-panel-*` windows unexercised → GUI). R6 **closed**. R7 **closed** (middleware verified present). R8 **open-cosmetic** (dev fixture appears in the manager; chose "show"). R9 **obsolete** (unify-now — window code is live). R10 **open by design** (D-14 untouched). R11 **open** (M36's GUI click-through gap persists, now also covering pop-out). R12 **closed** (in-app D-09 kept verbatim + new revision-keyed window push, both tested). **New:** N1 pop-out windows open at main's default 380×520 — likely small for a linked figure (request supports width/height; one-liner if the owner wants it); N2 report payloads for closed panels stay cached for re-serve (main's semantics, bounded); N3 "reopening" a dismissed window happens via pop-out or a fresh report — no standing "open panel windows" menu; N4 the JS window-label transform mirrors Rust's (dots→dashes) and must move with it.

## Owner's manual GUI pass must cover

Study §9.7: **fixture palette** (dev build: fixture toolset renders as a floating palette; its ping command routes); **NMR panel** (Analyze ▸ ¹³C on a drawn molecule → in-app panel, linked figure interactive); **manager enable/disable** (fixture palette disappears/returns; disabling NMR closes its panel); **install/uninstall clicks** (the standing M36 gap: Add plugin from package… → picker → review → Install → Analyze runs from the installed copy → uninstall restores bundled); **patch tray** with a synthetic proposal (accept lands in document history). **Merge additions:** "Open as window" on an NMR panel → floating window shows the full linked figure (hover cross-highlight, zoom); Run again from that window recomputes and updates it; edit the molecule → stale banner appears in the window; dismiss the window → in-flight NMR work cancels; pop out NMR then run mass-fragment in-app (multi-surface concurrency); native Analyze shows plugin items after startup *and* after a toolbars push (the re-targeted rebuild + checkmark preservation); native Plugins ▸ Add or Remove Plugins…; export/copy from inside a panel window (R5); confirm the title-bar label and stamp `7.16.17.45-fable`.

## Next steps (named, not implemented)

PLAN-plugin-separation **Phase 2+**: publish the SDK (`@chemdraft/plugin-api` as a real package), **Phase 3** strip bundled NMR from the desktop (the suite that just served as this merge's safety net), **Phase 4** the from-zero install test (fresh app + `nmr-predictor-0.0.0.zip` → prediction). Queued owner items: D-14 (installed-shadows-bundled semantics), R8 (fixture visibility in the manager), N1 (pop-out window sizing).

---

## Addendum 2026-07-17 — the manual GUI pass was performed (screen-driven by the assistant, user-approved)

Driven by hand in the running union release build (`ChemDraft.app` from `chemdraw-plugin-union`; status
bar read on-screen: **Build 7.16.17.45-fable · chemdraw-plugin-union [merge/plugin-union] · 2026-07-16
18:06:13 2d9bdef1**). Verified live:

1. **Native Analyze menu** lists all plugin items at startup *and re-lists them after an install replaces
   the NMR plugin* (the re-targeted Rust rebuild — closes the behavioral half of R4).
2. **¹³C prediction in-app**: benzene → one resonance at **128.10 ppm**, Engine `chemdraft.ocl-hose` /
   `nmrshiftdb2.nmredata.sd` shown in the panel; equivalent-nuclei honesty caption present.
3. **Panel UX**: drag; **Expand** full-size modal; hover on the peak cross-highlights the ring carbons.
4. **"Open as window"**: the detached floating window renders the FULL report incl. the linked figure
   (the section main's old window dropped), with Run again present.
5. **Staleness across the window bridge, both directions**: deleting the molecule pushed the "result may
   be out of date" banner into the floating window; undo cleared it.
6. **Install click-through (closes R11 / the M36 acceptance gap):** Plugins ▸ Add or Remove Plugins ▸
   Add plugin from package… ▸ `nmr-predictor-0.0.0.zip` → review displayed the permission chips
   (`selection.read analysis.write ui.menu ui.panel`), **17.01 MB unpacked · checksum verified**,
   provenance **`125aebeb` (clean) · SDK 0.1.0**, full SHA-256 `2661fff7…699e` (matching the MIT-rebuilt
   zip) → Install → **[Installed] badge + Uninstall button** (D-14 shadowing UI) → **a prediction ran
   from the installed copy**.
7. **Uninstall**: bundled copy restored (badge gone, still Enabled), Analyze menu intact, prediction
   works; **disk verified clean** — `installed-plugins/` empty, record `{"version":1,"plugins":[]}`.
8. **Corrected NMR description** (M35 labeling fix) confirmed as the text the manager displays.

**New findings from the pass:**
- **TCC prompt on first install (new N5):** the file picker's first reach into `~/Documents` triggered a
  macOS permission dialog (system-owned; the user approved it). One-time per machine; worth a line in the
  install docs.
- **N1 confirmed in practice:** the default 380×520 pop-out clips the linked figure; hover inside the
  window couldn't be meaningfully exercised at that size. The sizing one-liner is worth doing.
- The out-of-process file picker (macOS `openAndSavePanelService`) is invisible to screen tooling that
  filters by app — automation-relevant only.

**Still not covered by hand:** ¹H command, a mass-fragment run, multi-panel concurrency, export/copy from
inside a panel window (R5's remainder), install persistence across an app restart via GUI (proven at the
filesystem level in report 0031), dev-only fixture palette, patch tray (needs a proposal-generating
flow). All are secondary to the program's acceptance criteria, which are now met end-to-end.
