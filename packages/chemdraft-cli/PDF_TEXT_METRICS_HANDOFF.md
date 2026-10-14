# Headless PDF text metrics handoff

The CLI now measures each tspan with the font svg2pdf will draw, while retaining the
plain-text fixes for kerning, unsupported numeric weights, and family-only changes.
Only `packages/chemdraft-cli` changed. `CURRENT_BUILD_STAMP` is unchanged.

## svg2pdf 2.7.0 call-site audit

References below are to the installed **unminified** `dist/svg2pdf.es.js`. This is the
same 2.7.0 pipeline shipped in its CommonJS distribution. The module exports only
`svg2pdf`; `TextMeasure`, `parseAttributes`, `applyAttributes`,
`findFirstAvailableFontFamily`, and `combineFontStyleAndFontWeight` are private.
The shim reuses svg2pdf's actual `font-family-papandreou` dependency and mirrors the
private font rules, with source-line citations in the implementation.

Let **E** mean the effective PDF font applied to the enclosing `<text>`, including
any jsPDF fallback. `RenderedNode.render` clones/parses its context at 1955–1957,
then applies it at **1978**, before entering `renderCore` at **1979**.

All DOM measurements converge on **4027**, the single `textNode.getBBox().width`
inside `TextMeasure.svgTextMeasure`. That node is detached from the original SVG's
ancestry: it is a reusable `<text>` inside a hidden SVG under `document.body`.
Lines **4021–4024** put the supplied context's resolved family, size, style, and
weight on it. Those are logical SVG attributes, not the effective jsPDF font.

| Measurement origin | Route to `getBBox` | Active PDF font at 4027 | Attributes on the hidden node |
| --- | --- | --- | --- |
| Plain-text anchor offset, 2872 | `getTextOffset` → 3978 → 3990–3996 → 4018–4027 | **E**; the text's attributes were already applied at 1978 | Enclosing text context |
| Plain-text `textLength`, 2874 | `measureTextWidth` → 3990–3996 → 4018–4027 | **E**; before `pdf.text` at 2884 | Enclosing text context |
| Plain-text bounding box, 2893 | `measureTextWidth` → 3990–3996 → 4018–4027 | **E**; `pdf.text` has emitted the text without changing its selected font | Enclosing text context |
| Tspan `textLength` premeasurement, 2917 → **2691** | `TextChunk.measureText` → 3990–3996 → 4018–4027 | **E**; no run font has been applied yet | Run context accumulated through every ancestor tspan |
| Ordinary tspan placement, **2706** | `TextChunk.put`'s first loop → 3990–3996 → 4018–4027 | **E**; measurement precedes the second/drawing loop | Run context accumulated through every ancestor tspan |
| First-use family calibration, **4040** | `getMeasureFunction` → `svgTextMeasure` → 4027 | The caller's active font, **E**, in every route above | Requested family, but probe size 16px, style normal, weight normal |

`processTSpans` clones the inherited SVG context and parses each tspan at
**2845–2847**, without changing the PDF font. Nested tspans therefore accumulate
logical context only. `TextChunk.put` first computes all positions, then saves
PDF state at **2751**, calls `applyAttributes(runContext, enclosingTextContext, run)`
at **2752**, draws at **2755**, and restores state at **2761**. Every run and every
subsequent chunk starts from **E**. The `textLength` path caches its widths before
`put`, so it does not use the ordinary-path measurement at 2706.

## Implementation

The scoped SVG `getAttribute` shim observes `TextNode.renderCore`'s read of
`textLength` at **2865**, which occurs for every text, including those without a
`textLength` attribute. At that point it captures the enclosing text's logical
font state and `pdf.getFont()` (**E**), after application and before measurement.

For the hidden measuring node, use svg2pdf's already-flattened run attributes;
they already incorporate the measured tspan and its ancestor tspans. Compare that
state **directly with the enclosing text**, as svg2pdf does at 2752. Applying PDF
font transitions one ancestor tspan at a time would be wrong: outer style changes
can be cancelled by an inner tspan before any PDF font is applied.

The rules match svg2pdf's helpers at **960–1006**, attribute parsing at
**1673–1685**, and font application at **1786–1817**:

- Resolve registered family/style pairs before aliases; aliases win even when a
  requested style is absent. Preserve quoted registered names containing commas.
- Preserve literal combined style strings such as `500normal` and `800normal`.
- A family-only change keeps **E**'s effective style, including a prior fallback.
  A weight/style change requests the combined SVG style; jsPDF supplies its own
  registered-style lookup and Times fallback.
- Font lookup and width calculation do not mutate PDF font or size. Widths use
  `doKerning: false` and zero character spacing, matching emitted glyph advances.
- Direct DOM measurements use the same family/style rules and flatten nested
  tspan state before applying it relative to the text.

`withPdfDom` supplies its own JSDOM SVG prototype. Teardown restores the previous
`getAttribute` descriptor (or deletes the temporary own method), removes the
jsPDF initialized listener, and retains the existing restoration of all other DOM
shims and globals. Failure restoration and concurrent export tests pass.

## Independent measurements

The test reader decodes actual PDF content streams, resolves emitted font
resources, and sums their glyph width tables directly. It does not use this
helper, `getStringUnitWidth`, or another kerning/string-width routine.
All widths and x coordinates below are in SVG/page pixels.

| Case | Emitted font | Glyph width | PDF start x | Resulting center x |
| --- | --- | ---: | ---: | ---: |
| Arial 24px `ToToTo`, weight 400 | Helvetica | 83.52 | 58.24 | 100 |
| Arial 24px `MMMM`, weight 500 | Times-Roman fallback | 85.44 | 57.28 | 100 |
| Arial 24px `MMMM`, weight 800 | Times-Roman fallback | 85.44 | 57.28 | 100 |
| `<g font-weight="500"><text font-family="monospace">MMMM` | Courier | 57.6 | 71.2 | 100 |
| Inherited serif weight 700, text family-only monospace | Courier-Bold | 57.6 | 71.2 | 100 |
| Inherited monospace weight 500, text family-only Arial | Helvetica | 79.68 | 60.16 | 100 |
| Serif text → monospace tspan, ordinary path | Courier | 57.6 | 71.2 | 100 |
| Serif text → monospace tspan, `textLength` path | Courier | 57.6 | 71.2 | 100 |
| Registered `500normal`, plain text and tspan | Helvetica-Bold registration | 79.68 | 60.16 | 100 |
| Registered `800normal`, plain text and tspan | Helvetica-Bold registration | 79.68 | 60.16 | 100 |

The kerning-enabled jsPDF `ToToTo` width would be **74.88**, whereas the PDF emits
**83.52** in glyph advances. The test checks the emitted advances.

The following nested cases pass on **both** ordinary and `textLength` paths:

| Nested case (Arial enclosing text, 24px) | Run fonts | Run widths | Run start x values | Total width / center |
| --- | --- | --- | --- | --- |
| Outer weight 500 `M`, inner weight 700 `MM`, outer `M` | Times-Roman / Helvetica-Bold / Times-Roman | 21.36 / 39.84 / 21.36 | 58.72 / 80.08 / 119.92 | 82.56 / 100 |
| Enclosing weight 500; outer monospace `M`, inner weight 700 `MM`, outer `M` | Courier / Courier-Bold / Courier | 14.4 / 28.8 / 14.4 | 71.2 / 85.6 / 114.4 | 57.6 / 100 |
| Enclosing weight 500; outer weight 700; inner monospace weight 500 `MMMM` | Courier | 57.6 | 71.2 | 57.6 / 100 |
| Outer monospace weight 500 `M`, inner weight 700 `MM`, outer `M` | Times-Roman / Courier-Bold / Times-Roman | 21.36 / 28.8 / 21.36 | 64.24 / 85.6 / 114.4 | 71.52 / 100 |

The `textLength` fixtures request the natural total glyph width. This exercises
premeasurement and cached widths without adding letter spacing; fixing svg2pdf's
separate character-spacing/anchor behavior is outside this change.

Sodium benzoate is unchanged in **both `export` and `render-document`**. All runs
emit Helvetica; both background-stroke and fill copies are checked:

| Label | Width | PDF start x | PDF center or charge start x | SVG target |
| --- | ---: | ---: | ---: | ---: |
| Na | 19.05 | 360.142 | 369.667 (center) | 369.667 |
| + | 7.656 | 380.167 | 380.167 (start) | 380.167 |
| Charged O | 11.7 | 391.818 | 397.668 (center) | 397.668 |
| − (PDF ASCII `-`) | 4.356 | 403.518 | 403.518 (start) | 403.518 |
| Carbonyl O | 11.7 | 440.315 | 446.165 (center) | 446.165 |

Maximum observed x/baseline discrepancy is below **1e-12 px**. Native centered
`Yield` text also passes: Helvetica 18px width **39.6**, x **180.2**;
Times-BoldItalic 24px width **50.64**, x **174.68**; Courier-Bold 12px width **36**,
x **182**. All three centers are **200**.

## Verification and environment

- `pnpm lint`: **passed**.
- CLI Vitest suite: **19 files passed; 250 tests passed, 4 skipped**. The 26 PDF
  positioning tests all passed. Skips are existing real OPSIN tests because this
  worktree has no bundled runtime; their fake-process protocol tests pass.
- `git diff --check`: **passed**.

Missing `node_modules` directories were symlinked from
`/Users/jeremiahgassensmith/programming/chemdraw`; no install was run. The existing
example plugin's dependency directory also needed its source symlink for root
lint. Default Vite configuration bundling attempted to write inside the shared
root `node_modules` symlink and was rejected by the filesystem sandbox. The source
dependency tree also lacks the cdx-compat → template-library workspace link.
Tests therefore used a **temporary, untracked configuration outside the repo**
that retains the root test configuration, supplies its existing tsconfig package
paths as absolute aliases (subpaths first), and places the cache in writable tmp.

Exact passing suite command:

```text
TMPDIR=/Users/jeremiahgassensmith/.agentctl/runs/labelsfix3-20261013/tasks/labels-fix3/tmp pnpm vitest run packages/chemdraft-cli --configLoader runner --config /Users/jeremiahgassensmith/.agentctl/runs/labelsfix3-20261013/tasks/labels-fix3/tmp/pdf-vitest.config.mts
```

macOS: CLI tests and root typecheck verified here. Windows: **unverified**; run the
same CLI suite and typecheck during integration. This is shared Node/TypeScript
code with no platform branches. No desktop build or launch was requested.

The shim intentionally depends on svg2pdf 2.7.0's private ordering and attribute
rules. Re-audit the cited pipeline and run these tests when upgrading svg2pdf.
Recommended integration check: the same suite on Windows CI.
