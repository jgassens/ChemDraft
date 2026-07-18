# Assignment 07: Execute the runtime union merge (main trunk × our plugin architecture, unified panels)

- **Status:** ready to issue
- **Milestones:** M38 (STATUS.md → "Milestones"); revised Phase 1 of `PLAN-plugin-separation.md`
- **Depends on:** report 0032 (the reconciliation study — **this assignment's execution spec**);
  ADR-0030 (the owner's union decisions); reports 0029–0031 (what our runtime does and why)
- **Next assignment:** Phase 2+ of PLAN-plugin-separation (publish SDK, strip NMR, from-zero install
  test) — do **not** start any of it here

## Where you work

Create a **new worktree** (repo convention: one worktree per feature) from the existing clone:

```
git -C ~/Documents/programming/chemdraw-nmr worktree add \
    ~/Documents/programming/chemdraw-plugin-union -b merge/plugin-union origin/main
```

Work ONLY in `~/Documents/programming/chemdraw-plugin-union`. Do not switch branches in, edit, or
otherwise disturb `~/Documents/programming/chemdraw-nmr` (it stays on `codex/nmr-plugin` at `125aebeb`
as your read-only reference for "ours"). Never modify the planning workspace.

## The task

`git merge codex/nmr-plugin` into `merge/plugin-union`, then resolve to the union ADR-0030 specifies:

1. **Trunk = main; plugin architecture = ours.** One-sided resolutions per report 0032 §9.2 — packages
   (`plugin-api`, `plugin-host`, the plugin packages, tools) are **ours**; toolbars/toolsets/palette
   windows/window-manager/App.tsx are **main's**; `apps/desktop/src/plugins/` is the union of both file
   sets. Verify each "one-sided" claim cheaply (`git diff --stat` from the base) before trusting it.
2. **The 17 both-touched files** resolve per report 0032 §4's classifications. The two hard ones:
   `MainWindow.tsx` — take main's side wholesale, then re-apply our ten enumerated hunks (§2/§9.4) with
   the three fusions (`plugins.manage` into `coreCommandBindings`; our `usePluginRuntime` block replacing
   main's runtime memo, with main's stable `registry` passed into `createPluginRuntime`; dispatch =
   main's single `host.invokeCommand` fallthrough wrapped in our ADR-0010 `pluginCommandFailure`
   surfacing + diagnostics toggle). `lib.rs` — main's side + our `installed_plugins` module +
   `register_uri_scheme_protocol("tauri", …)` + `sync_plugin_menu_items`, with plugin menu items
   re-targeted into main's JS-pushed menu rebuild (the one structural Rust edit; main's
   `create_app_menu_for_toolsets` is now `(app, &entries, view_state)`).
3. **Port main's four plugin pieces onto our runtime** (§8 port list): adopt the stable-registry
   substrate (add `commandRegistry?`/`createStorage?`/`onProposedPatchesChanged?` passthroughs to
   `createPluginRuntime` — the host options already exist); port the toolset stage with provenance maps,
   `ui.toolbar` enforcement, duplicate-toolset rejection, and **whole-plugin rollback** (+ its 3 tests,
   renamed `toolsetContributions.test.ts`); wire `createPersistentPluginStorage` + main's Rust storage
   commands; port `PatchReviewTray` + accept/reject callbacks + the queue-version bump. Keep the DEV
   fixture as-is. Fix `isPluginCommand` for the shared registry (pluginId-ownership check — R3).
4. **Unified panels (ADR-0030 §3–4, the owner chose unify-NOW):** replace `PluginPanelWindow`'s private
   section switch with our `PluginReportRenderer` (the `linkedFigure` must render in the floating
   window); extend panelBridge with a **Run again** invoke message (`rerunCommandId` executed in the main
   window) and a **staleness** push (D-09 recomputed against the live document); dismissing a window
   notifies panel-closed (ADR-0012 cancellation); the in-app surface keeps single-panel semantics and
   gains "Open as window" chrome (desktop only; browser build stays in-app). Add tests for the renderer
   swap, both bridge messages, and window-close cancellation.
   **Sanctioned fallback (ADR-0030):** if the unified window hits a genuine capability/lifecycle wall,
   ship Option A (in-app only), keep main's window code dormant, and say so prominently in the report.

## Non-goals

No NMR stripping (the bundled NMR suite is this merge's safety net), no SDK publishing, no plugin-repo
creation, no changes to the permissive posture (ADR-0029/D-12), no relitigating D-14, no new features
beyond the union. Do not "clean up" main's toolbars code or our plugin code in passing.

## Verification (mandatory before reporting)

```
pnpm lint
pnpm test          # the union suite: expect ≈ ours (1,590) + main's suites, minus the renamed overlap
pnpm build         # full tauri build
```

Also run main's guard tests explicitly (`App.test.ts`, `coreCommandRegistrar` tests, the renamed toolset
tests) and our guards (`MainWindow.plugins.dom.test.ts`, panel surface/controller, installer, worker
bridge, `appMenu.test.ts` native-menu drift). Do not claim a command passed unless you ran it. The
manual GUI pass (report 0032 §9.7) stays open for the owner — list what it must cover.

## Git rules

Commit on `merge/plugin-union` (a real merge commit preserving both parents, then fix-up commits as
needed). Do **NOT** push. Do not touch `main` or `codex/nmr-plugin`.

## Final report (archived verbatim as `reports/0033-runtime-union-merge-*.md`)

Include: what merged one-sided vs. hand-fused (per file for the 17); the ten MainWindow hunks'
disposition; the port list executed (with what changed adapting each piece); the unified-panel outcome —
or the sanctioned fallback with evidence; every deviation from report 0032's outline and why (the study
predicted this merge — score its predictions honestly, including anything it got wrong); test/build
results with final counts vs. both sides' baselines; unresolved risks against 0032's R1–R12; what the
owner's manual GUI pass must cover; next steps (Phase 2+), not implemented.
