# ADR-0015: Core-owned interactive panel sections (`linkedFigure`)

- **Status:** accepted (2026-07-09) — user directed building ChemDraw-style spectrum/structure UX into the panel
- **Builds on:** [[0008-extend-existing-selection-api]] permission model; the M9 static stick-spectrum SVG

## Context

Panel reports render SVG through an inert `<img>` data URL (no script execution, no
page-theme bleed). That safety choice also makes the figure **non-interactive**: the
predicted spectrum can't be zoomed, and there is no way to cross-highlight a peak against
the atoms it came from. Compared with ChemDraw's ChemNMR output (large zoomable spectrum,
structure annotated with a shift next to each atom, and mouse-over linkage between the
two), our panel's spectrum is tiny and static. The user directed bringing that UX in.

Two ways to add interactivity:
- (a) Let plugins ship interactive/scripted SVG or framework components — breaks the
  declarative, script-inert plugin contract and reopens the theming/security holes the
  `<img>` boundary closed.
- (b) Keep plugins **declarative (data only)** and let the **trusted core** render the
  interactivity.

## Decision

Add a new declarative panel section `kind: "linkedFigure"`. The plugin supplies
**serializable data only**:
- `spectrum`: `{ nucleus, domain{min,max}, reversed?, peaks[] }`, where each peak is
  `{ id, ppm, intensity, label?, atomIndices[] }`.
- `structure?` (optional): chemistry-agnostic 2D geometry — `atoms[{ index, x, y, element }]`
  and `bonds[{ from, to, order }]`.

The desktop renders an interactive React figure: a **zoom/pan** spectrum plus an
**annotated structure** (per-atom shift labels joined from `peaks.atomIndices`) that
**cross-highlight on hover**, both directions (peak→atoms, atom→peak). No plugin-supplied
script, event handlers, SVG-with-handlers, or components — the plugin never ships code.

Design constraints that keep it honest:
- **Domain-neutral geometry.** The section carries points/lines/labels, not molecules, so
  any future plugin can emit a linked figure; it is not NMR-specific.
- **Structure is optional.** Geometry-less backends (the synthetic fixture) still render a
  spectrum; only the OCL predictor ships structure geometry.
- **Strict schema, size caps.** `.strict()` objects and array `.max()` bounds keep the
  section data-only and bound render cost.

### Data flow / index alignment

Geometry is produced where the molecule already lives — the **OCL predictor worker** — and
travels on `NmrPredictionResult.depiction`; the composer reshapes it into the section. The
atom `index` values are the predictor's own atom indices, so `peaks.atomIndices` (from
`resonance.atomRefs.sourceAtomIndex`) line up with `structure.atoms` with no re-derivation
and no second molecule build. This keeps OpenChemLib **off the desktop main thread**,
preserving the M10 bundling goal ([[0014-nmrshiftdb2-data-source]] ships the DB in the
worker only).

## Consequences

The plugin API gains its first **interactive-but-safe** surface, and the pattern
generalizes beyond NMR. The cost is that the core now owns a real interactive component
(viewport/zoom math, atom hit-testing, shared highlight state) and its tests. The
declarative, inert-by-default contract is preserved: interactivity is a **core capability
the plugin feeds with data, never code**.

Rejected alternatives: plugin-shipped interactive SVG / iframe (security + theming
regressions); a bespoke NMR-only viewer (not reusable, pushes chemistry into the generic
renderer).
