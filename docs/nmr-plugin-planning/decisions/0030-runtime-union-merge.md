# ADR-0030: Runtime union — main as git trunk, our plugin architecture, unified panel renderer

- **Status:** accepted (2026-07-16)
- **Source:** owner decisions on report 0032 (the runtime reconciliation study), which mapped the
  collision between `origin/main`'s independently-built plugin runtime (commits `caa182fc`, `e04734ea`,
  `611f63f8`) and `codex/nmr-plugin`'s (M1–M36).
- **Builds on:** ADR-0027 (manager), ADR-0028 (SDK boundary), ADR-0029 (permissive installer);
  PLAN-plugin-separation.md (this merge is its revised Phase 1).

## Context

Report 0032 established: the two sides share unchanged contracts (`plugin-api`/`plugin-host` have zero
diff base→main; our extensions are additive and signature-compatible with every call main makes); the
genuine collision is confined to the runtime wrapper, command dispatch, panels, and `MainWindow.tsx`;
main's Phase-1 stable-`CommandRegistry` refactor retires the constraint (A2/A3) our runtime was designed
around; main's panel window renders reports in a separate floating native window but silently drops
section kinds it doesn't know (including `linkedFigure`); our renderer is a pure function of the same
report schema and can render anywhere; the largest inherited mass is main's toolbars subsystem, which
never touches plugin code.

## Decision (owner, 2026-07-16)

1. **Git trunk: `main`.** The union branch is cut from `origin/main` and `codex/nmr-plugin` merges into
   it. Rebasing 78 reviewed commits onto a feature branch is not sane.
2. **Plugin architecture: ours.** Where the two runtimes overlap, ours wins (36 milestones, ~198 plugin
   tests, worker isolation + installer + manager + menus). Main's four unique plugin pieces port onto our
   runtime: the **stable-registry substrate** (adopted, not ported — our host already accepts an injected
   `commandRegistry`), the **toolset-contribution stage** with its `ui.toolbar` gate + whole-plugin
   rollback, the **disk-backed plugin storage** (JS + Rust commands), and the **patch-review tray**.
3. **Panels: unify now (study's Option C, chosen over its A-then-C recommendation).** One renderer —
   our `PluginReportRenderer` — serves both surfaces: the in-app panel (unchanged) and main's floating
   `PluginPanelWindow` (its private 4-kind section switch is replaced by our renderer, so `linkedFigure`
   and every future section kind work in both). The panelBridge gains what a detached window needs:
   an invoke path for **Run again** (`rerunCommandId`) and a **staleness** push.
4. **Unified-panel policy** (the semantics Option C forces):
   - The in-app surface keeps **single-panel** semantics and ADR-0012 replacement-close.
   - Popped-out windows are **per-panelId** (main's model, multiple allowed). Dismissing one notifies
     panel-closed (ADR-0012 cancellation applies); reopening re-serves the stored report, and staleness
     is recomputed against the live document (D-09 travels with the report).
   - "Open as window" is panel chrome on the in-app surface; the browser build keeps in-app only.
5. **Bundled NMR stays in the union branch.** This merge is the revised Phase 1 of
   PLAN-plugin-separation: the full NMR test suite is the safety net proving the merge broke nothing.
   Stripping NMR (Phase 3) and the from-zero install test (Phase 4) come after.

## Consequences

- The union inherits main's toolbars/palettes/autosave wholesale and our plugin program wholesale; the
  hand-fused surface is `MainWindow.tsx` (ten enumerated hunks re-applied over main's side) plus one
  structural Rust edit (plugin menu items re-targeted into main's JS-pushed menu rebuild).
- Plugins gain, for free: persistent disk storage, toolbar/palette contributions, a patch-review UI, and
  a simpler dispatch path on the stable registry (`isPluginCommand` must become a `pluginId`-ownership
  check — R3 of report 0032).
- Main's `pluginRuntime.test.ts` (6 tests) survives renamed (`toolsetContributions.test.ts`) against the
  union runtime; ours keeps its name. Main's `App.test.ts` fixture path must stay green.
- Risk R1 (main keeps moving) starts burning the moment this is accepted — execute promptly.
- Supersession trigger: if the unified window renderer proves unshippable (capability or lifecycle
  surprises in `plugin-panel-*` windows), fall back to Option A (in-app only at merge) and re-queue the
  window as a follow-up — that fallback is explicitly sanctioned and cheap.
