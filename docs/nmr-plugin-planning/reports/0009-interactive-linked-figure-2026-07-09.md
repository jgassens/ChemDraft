# Report 0009 — M13: Interactive linked figure (ChemNMR-style) + panel-visibility fix

**Date:** 2026-07-09
**Worktree:** `~/Documents/programming/chemdraw-nmr` @ `codex/nmr-plugin`
**Decision:** [ADR-0015](../decisions/0015-core-owned-interactive-panel-sections.md)

## Context

User tested the NMR panel in the native window and compared it to ChemDraw's ChemNMR
output: our spectrum was tiny and static and the structure was not annotated. Ask:
a **large, zoomable spectrum**, a **shift next to each atom**, and **mouse-over linkage**
between a peak and the atoms it came from. Chosen scope (user): the full interactive figure.

## Precursor bug fixed: the panel was invisible

The panel had rendered correctly all along — the command succeeded (`ok:true`) and
`PluginPanelSurface` mounted it — but **there was no CSS at all** for `.plugin-surface` /
`.plugin-panel`. Unstyled, the surface had no position/z-index and was painted behind the
full-bleed canvas. jsdom tests only asserted `data-testid` presence, never visibility, so
every milestone missed it. Fixed by adding the panel stylesheet (`App.css`); verified by
rendering the exact markup over a mock canvas.

## What shipped (M13)

- **ADR-0015 — core-owned interactive panel sections.** Plugins stay declarative (data
  only); the trusted core renders interactivity. Chemistry-agnostic geometry keeps the
  section reusable by any plugin.
- **`plugin-api`:** new `linkedFigure` panel section (zod + inferred types + convenience
  type exports). Spectrum `{nucleus, domain, reversed, peaks[{id, ppm, intensity, label?,
  atomIndices[]}]}` + optional `structure {atoms[{index,x,y,element}], bonds[{from,to,order}]}`.
  `.strict()` + array size caps keep it data-only.
- **Predictor:** `NmrPredictionResult.depiction` (contracts + schema). The **OCL predictor
  (worker)** invents 2D coordinates and emits atom points + bonds, indices aligned to
  `resonance.atomRefs` — so OpenChemLib stays off the desktop main thread (M10 goal held).
  Fixture backend omits geometry.
- **Composer:** `composePredictionReport` emits the `linkedFigure` section (peaks from
  resonances, structure from `depiction`), keeping the shift table + provenance. Replaces
  the static `<img>` stick spectrum.
- **Core `LinkedFigureView`:** inline-SVG spectrum with **wheel-zoom + drag-pan + Reset/±**,
  an **annotated structure** (per-atom δ labels, heteroatom labels, single/double/triple
  bonds), and **hover cross-highlighting both ways** (peak→atoms, atom→peak). Wired into
  `PluginReportRenderer`; styled in `App.css` with design tokens.
- **Panel UX:** widened the surface (430px) and added an **Expand** toggle that grows it to
  a large side-docked view (spectrum + structure side by side).
- **Reverted the dev-only in-window menu-bar toggle** (`showAppMenuBar || import.meta.env.DEV`).
  It tripped `App.test.ts` (native shell must not show the in-window bar; `DEV` is true under
  vitest). Native testing of plugin Analyze items belongs in the deferred native-menu work,
  not a dev hack.

## Files

- `packages/plugin-api/src/index.ts` (+ `index.test.ts`)
- `examples/plugins/nmr-predictor/src/domain/{contracts,schemas}.ts`
- `examples/plugins/nmr-predictor/src/providers/ocl/{structureDepiction.ts (new), OclHosePredictor.ts}`
- `examples/plugins/nmr-predictor/src/report/composePredictionReport.ts`
- `examples/plugins/nmr-predictor/src/tests/{oclHosePredictor,composePredictionReport}.test.ts`
- `apps/desktop/src/plugins/{LinkedFigureView.tsx (new), LinkedFigureView.dom.test.ts (new), PluginReportRenderer.tsx, PluginPanelSurface.tsx (+ .dom.test.ts)}`
- `apps/desktop/src/App.css`, `apps/desktop/src/MainWindow.tsx` (toggle revert)

## Verification

- `pnpm lint` (tsc) clean. `pnpm test` → **1326 passed / 9 skipped**. New coverage: schema (4),
  predictor geometry alignment (1), composer figure + depiction (2), `LinkedFigureView` render +
  cross-highlight both directions (4), panel surface figure/Expand (1).
- Desktop web build OK; the ~800 KB reference DB + OpenChemLib remain out of the main chunk
  (depiction builder is reachable only via `OclHosePredictor` → worker / lazy fallback).

## Follow-ups (not in scope)

- **Native menu integration** so plugin Analyze items are testable in the native window
  without the reverted dev toggle.
- Preserve molfile 2D coordinates when present (currently always `inventCoordinates`).
- Latent robustness (spotted earlier): NMR worker client has no timeout; `predictSelectedStructure`
  does not guard an undefined `panels` capability.
