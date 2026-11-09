# @chemdraft/layout-engine

Owns page and object layout operations such as align, distribute, group, rotate, flip, z-order, guides, and page sizing.

It also owns pure molecule-growth geometry helpers used by drawing tools, such as planning the next bonded atom position from an existing native molecule graph. The desktop app may consume these plans, but document mutation remains in `chem-core` patches and app workflow code.

`src/labelGrammar.ts` is the one atom-label grammar: what a label's text means (an element, one heavy
atom spelled with its hydrogens, a template-library abbreviation or an element carrying them, a
placeholder, a bare formula, or unrecognized text), which atom of a group its bonds reach, and the
valence tables the reading needs. It is pure text in, reading out, so the drawn label can place a
group by the same reading the chemistry uses. `@chemdraft/document-workflow-core` re-exports it and
keeps what is built on it (valence verdicts, validation, expansion); it must not carry a copy.

A group label is drawn the way round its bond reads, with the atom it bonds to on the atom
(`nativeGroupLabelDisplay`, `atomDisplayLabelPlacement`): "OMe" with its O on the atom, drawn "MeO"
with its bond on the right, but only when the turned text reads as the same group. `AtomLabelPlan`
carries the anchor, and bond clipping, the CLI's bounds and SVG/PDF export lay the label out from it;
the Spin 3D overlay applies the same rule each frame to its projected bonds
(`nonElementAtomLabelPlacement`). Display only; under an explicit label alignment the old centred
layout stays.

`src/valence.ts` is the one implementation of how many bonds an atom uses: the element table,
`nativeAtomValenceForCharge`, and `nativeBondOrderResolution`, which replaces each aromatic bond
(MOL type 4, CDXML Order=1.5) with its Kekulé order once per molecule. The drawn atom label, the
stored formula, the valence badge, the growth hotkeys and the native SMILES writer all count through
it, so a label and the formula beside it cannot disagree. `@chemdraft/document-workflow-core`
re-exports these functions; it must not carry a copy (AGENTS.md §5.26). An aromatic ring with no
Kekulé pattern is counted as single bonds — what the SMILES writer writes — and its atoms are
reported in `unresolvedAtomIds`, which the valence check turns into a badge. So is an aromatic bond
in a ring that is otherwise saturated: it is not aromatic, and is never promoted to a double bond.

Aromatic bonds do not say whether a ring N is pyridine-type (no H) or pyrrole-type (N–H). Whatever
the source states decides it — an explicit H atom, a stated `hydrogenCount` (CDXML NumHydrogens), a
typed literal label, a charge, or a dative bond to a metal. Import hints expire when that atom's
bonds, element or charge are edited. With those constraints, the resolver first computes the
maximum-matching neutral closed-shell reading's total H count.

Owner rule (2026-09-27): on each nitrogen with no stated H or role information, extra N–H may be
inferred only in a **five-membered ring** needing its lone pair for aromaticity. Stated information
constrains only its own atom: a carbon's stated H, another nitrogen's charge or literal label, or an
explicit H elsewhere in the ring system never disables inference or badges on unstated N. Among closed-shell
assignments restricted to those sites, prefer a 4n+2 conjugated system, then aromatic five-rings,
then fewer H. The system criterion gives porphine C20H14N4 and phthalocyanine C32H18N8 (two inner
N–H), rather than hydrogenating all four inner nitrogens. No six- or larger-ring N can acquire H
from this preference; diazapyrene and the diaza-dibenzocyclooctene sweep retain minimum-H matching.
The whole-system 4n+2 preference is retained for porphine. Its known cost, measured in review, is
dipyrrolo-biphenylene (`c1c5cncc5c2c3cc5cncc5cc3c2c1`): it reads **C16H8N2**, badged, even though
C16H10N2 is closed-shell. The preference declines both five-ring N–H on that 4n core.
A second cost is the fused imidazolone-pyrrole `O=c1nc2ccnc2n1`: it reads **C5H5N3O** (three ring
N–H) although the minimum-H reading C5H3N3O is equally closed-shell. Whenever the 4n+2 criterion
chooses between closed-shell readings with different H counts, the nitrogens those readings disagree
on (here the two imidazolone N) are reported as **guessed**, not uniquely inferred, so they stay
badged and Spin 3D prefetch does not treat the choice as certain.

If the rule conflicts with closure, the closed-shell reading wins and is badged. Unhinted guanine
and xanthine read **two H short** of the natural products: C5H3N5O / C5H2N4O2, both badged, versus
C5H5N5O / C5H4N4O2. Their additional six-ring amide N–H cannot be inferred under the owner's rule;
stating those H restores their formulas. Declined five-ring N–H sites are badged consistently in
guanine, hypoxanthine and xanthine, including when the resolver takes a closed-shell fallback.
Xanthine does retain one six-ring N–H: the nitrogen between its two carbonyl carbons cannot take a
double bond, so closure requires that H. It is badged as the explicit closed-shell exception.

Among placements at that fixed count, local circuits and ring membership rank the candidates.
Every inferred or declined N–H is reported in `inferredHydrogenAtomIds`, even if uniquely placed.
`guessedHydrogenAtomIds` is its uncertain subset: differing atoms in tied arrangements, declined
five-ring H, nitrogens whose H the 4n+2 preference decided against a closed-shell reading with a
different H count, and bounded-search fallbacks. A unique inferred placement keeps its canvas badge but
permits Spin 3D prefetch and adds no guessed-H Spin status. All inferred sites use
`chemistry.aromatic_tautomer_guessed`: the existing badge
already describes an uncertain per-atom H count, including choosing between zero and one H;
its explanation does not claim that the molecular H count was supplied. Every feasibility question is a perfect-matching
test (Edmonds' blossom algorithm); exhaustive comparison is capped at ten open nitrogens per ring
system. Independent local constraints can settle larger systems exactly. Other large systems use
an explicitly badged maximum-matching fallback, and above forty flexible N
the baseline matching is used directly. `kekuleSearchWorkForTesting` counts matching work.
Stated counts that conflict with resolved valence produce a warning naming the atom and count.

MOL serialization takes the resolved order map as a required argument. Unlike formula/SMILES
fallback counting, a MOL bond left unresolved stays type 4 (aromatic), with one returned warning per
ring system; it must never silently become single.

`nativeBondOrderResolution` also indexes bond usage, incident bonds and atoms. Label planning and
metadata/validation batches pass this single snapshot through each atom, avoiding per-atom full
graph scans and cache validation. Work-count tests include those reads, not just matching work.

`src/testing.ts` (`@chemdraft/layout-engine/testing`) carries the aromatic fixtures of record —
benzene through quinolin-2(1H)-one, each written both with aromatic bonds and as a Kekulé structure —
plus `testMoleculeFromSmiles` (a test-only reader whose bare lowercase `n` does not state its hydrogen count, as a
type-4 bond does not), and `porphyrinoid` / `fusedPyrroleLadder` builders.

Layout must not change chemical identity.

Wavy single bonds use a tapered sinusoidal cubic path, with amplitude and wavelength tied to the
stroke width and bond length. The shared SVG plan owns label trimming and crossing gaps, including
effect/sketch paths; canvas, SVG, PDF and resvg PNG all consume that geometry.

`DocumentStylePreset` and `DocumentTextStyle` are native style data in `@chemdraft/chem-core`.
`DocumentStyleScale` and point conversion stay here in `src/documentStyle.ts`. Native coordinates
use 22 units per bond; the physical scale is 14.4/22 pt per unit. Canvas plans and exporters use those same dimensions,
including the explicit bold/wedge width; export-engine wraps cropped SVG content in one scale
transform and writes its root dimensions and viewBox in points. CLI fitting remains the default. Labels and text use the Arial, Helvetica, sans-serif font stack.
`scalePageGeometry` scales every object frame, atom, arrow endpoint/control point, graphic geometry,
text position and explicit text size, and page dimensions together. Molecule colours, appearance
toggles remain unchanged; pixel-valued molecule styles, per-atom/per-bond maps and visual-effect
dimensions scale with the page.

## Selection arrangement

`planObjectArrangement` plans translation-only Circle, Oval, Grid, Row and Column layouts.
Grid supports left, centered and right alignment of incomplete rows. Visible label bounds and
ring-system anchors reserve space for asymmetric molecules without altering molecular geometry.
It accepts an optional page frame and refuses layouts that cannot fit without scaling.
With a page frame, default Row/Column gaps tighten from 48 to no less than 12 document pixels
when necessary to fit. Explicit `gap` values remain fixed; molecule dimensions never change.
`textVisualBoundsForArrangement` measures rotated caption frames around the same pivot as SVG
text rendering, so grouped captions participate in layout clearance and page-fit checks.

## Tables

`planTableLayout` measures native tables without a DOM, including rich-text scripts, decimal tabs,
captions, footnotes and horizontal or grid rules. Cells do not wrap; fixed columns allow overflow.
`planTableObjectSvg` feeds the shared page SVG plan, and `tableVisualBoundsForArrangement` includes
the notes, overflow and rotation around the same stored-frame pivot as SVG rendering.
Interaction, selection and arrangement use these visual bounds. Layout, SVG and bounds are cached
by immutable table object identity; SVG roots also key on layer index and share their cell fragments.
Replace the table object when editing it. `tableCellElementId` supplies the shared canvas/SVG cell ID.

`textMetrics.generated.ts` contains only derived Helvetica regular/bold, Times regular/bold/italic/bold italic, Courier and Symbol Greek/arrow
advance widths. Regenerate it with
`node packages/layout-engine/scripts/generate-text-metrics.mjs <Adobe Core 14 AFM directory>`
from the repository root. The generator verifies the oblique widths, retains Adobe's notices and
permission paragraph verbatim, and records the modification. Do not add the source AFM files.


Native text sizing uses `measureNativeTextSpanLineWidth`: the larger of the previous whole-line
character-factor estimate and the corrected Core14 advance width, with per-span bold/italic,
font sizes, letter spacing and the renderer's parent-size script scale. Letter spacing is counted
after **every character, including the last** (also across spans); the last character contributes
`max(0, spacing)` so negative tracking cannot narrow the previous metric estimate. Both automatic box sizing in document-workflow-core and the transient editor frame use
this result. Stored document frames are never remeasured merely by loading, normalizing or reopening.

### Font advance ceilings

The shipped commands in `apps/desktop/src/commands.ts` offer Arial/Helvetica/sans-serif,
Times New Roman/Times/serif, Courier New/Courier/monospace and Georgia/serif. The fallback menus in
`systemFonts.ts` and `ToolPalette.tsx` offer the same aliases; the native menu additionally lists
arbitrary installed families. Core14 is only an approximation for these real fonts: even Arial's
C is 1479/2048 = **0.72216796875 em**, slightly above Helvetica AFM's 0.722 em.

`nativeFontCeilings.generated.ts` is a **per-glyph conservative mapping**, not a scale inferred
from a sample word. For every covered code point and each of regular/bold/italic/bold italic,
take the maximum of its Core14 advance and the real family's `hmtx` advance divided by `head.unitsPerEm`.
Arial/Helvetica, Times New Roman/Times and Courier New/Courier each also take the maximum of the
two real families. When a real advance exceeds Core14, round it **up to the next 0.001 em**.
This covers punctuation, Latin accents, Greek and arrows as well as letters. For example, a
scale based only on Georgia H/Times H = 0.81494140625/0.722 ≈ 1.129 misses Georgia's `|`,
which is 0.375 em versus Times AFM's 0.2 em (ratio **1.875**).

| Families | Core14 base | Real source files, under `/System/Library/Fonts/` | Example real → reserved em |
| --- | --- | --- | --- |
| Arial, Helvetica | Helvetica regular/bold | `Supplemental/Arial{, Bold, Italic, Bold Italic}.ttf` (head revisions 5.01/5.00); named Helvetica regular/bold/oblique/bold oblique faces of `Helvetica.ttc` | C 0.72216796875 → 0.723; bold A 0.72216796875 → 0.723 |
| Times New Roman, Times | Corresponding Times face | `Supplemental/Times New Roman{, Bold, Italic, Bold Italic}.ttf` (5.01/5.00); named Times Roman/bold/italic/bold italic faces of `Times.ttc` | macron 0.5 → 0.5, versus AFM 0.333 |
| Courier New, Courier | Courier | `Supplemental/Courier New{, Bold, Italic, Bold Italic}.ttf` (5.00); named Courier regular/bold/oblique/bold oblique faces of `Courier.ttc` | Latin cell 0.60009765625 → 0.601; individual Greek advances can be wider |
| Georgia | Corresponding Times face plus Georgia ceiling | `Supplemental/Georgia{, Bold, Italic, Bold Italic}.ttf` (5.00) | H regular/italic 1669/2048 = 0.81494140625 → 0.815; bold/bold italic 1870/2048 = 0.9130859375 → 0.914; bold macron 0.703125 → 0.704 |
| Other installed families, including Helvetica Neue, Menlo, Monaco, Consolas; all generic CSS families | Maximum of the four corrected family groups, **per character and style** | The same sources above; no assumed generic face | Regular C .723, i .601, H .815, W .976 em; bold W 1.127 em |
| Otherwise uncovered code points | Chemistry table below, then **1.0 em** | Same offline sources when a glyph exists; 1 em is a sizing policy, not a measured bound | Test-tube emoji 1 em |

Sources were audited on the macOS authoring host on 2026-11-01. These are Microsoft-supplied font
metrics for the named Windows families plus Apple's bundled Helvetica/Times/Courier; Windows font
versions and real WebView2 layout still need hands-on verification. The OpenType definitions of
[`hmtx`](https://learn.microsoft.com/en-us/typography/opentype/spec/hmtx),
[`head`](https://learn.microsoft.com/en-us/typography/opentype/spec/head) and
[`cmap`](https://learn.microsoft.com/en-us/typography/opentype/spec/cmap) specify the source fields;
[`name`](https://learn.microsoft.com/en-us/typography/opentype/spec/name) defines face identification.
Reproduce the covered-glyph mappings with
`node packages/layout-engine/scripts/generate-native-font-ceilings.mjs /System/Library/Fonts`.
The generator selects every TTF/TTC face by OpenType PostScript name (name ID 6), rejecting missing
or duplicate matches; it never assumes collection order. Corrections cover the union of **every**
tabulated Core14 face's characters, not just Helvetica's character set.
The generator reads files **offline only**; application and headless callers import numbers and
never read host font files. No font files/outlines are redistributed. The Core14 source and notice
remain in `textMetrics.generated.ts`.

An unknown first family in a CSS stack is never skipped: it may actually be installed. Its per-character
maximum is at least the corrected Helvetica width without a flat reservation for ordinary text.
Generic `sans-serif`, `serif`, `monospace` and other generic families follow this rule because their
resolved face is not fixed. This is not an absolute bound for arbitrary installed fonts or shaping
(a custom font can have any advance). This deterministic measurement is
not a shaping engine. Missing-glyph substitution and browser rasterization require real-app checks.

`chemistryAdvanceCeilings` records a small fallback table in the same generated file, with separate
regular/bold/italic/bold italic maps. For each character it takes the largest available `hmtx` advance
across Arial, Helvetica, Times New Roman, Times, Courier New, Courier and Georgia in that style,
plus the existing Core14 advance where present, rounded upward to 0.001 em. It covers
`→ ← ↔ ≡ ≈ ± × · ′ ″ ° ⁺ ⁻ ⁰ ¹ ² ³ ⁴ ⁵ ⁶ ⁷ ⁸ ⁹ ₀ ₁ ₂ ₃ ₄ ₅ ₆ ₇ ₈ ₉`,
Greek α–ω (including final sigma) and Α–Ω, `µ Å ‰`. For example, regular ≈ reserves .644 em,
≡/prime/superscript charges/subscript digits .601 em, and ‰ 1.206 em (bold italic 1.317 em).
The source files contain **no glyph for ⇌ or ⇄ in any of these faces**: the generator reports that
absence and those two characters explicitly use the **1.0 em uncovered-character policy**; no
measured advance is claimed for them. A named face uses its own covered advances first, then this
chemistry table, then 1 em. The unknown-family maximum uses the same fallback for uncovered characters.
These numeric tables are shared by desktop, CLI and MCP sizing, with no load/reopen remeasurement.

### Editor allowance and alignment

Automatic editor chrome uses `max(stored width × scale, (measured content + 0.5) × scale + 4)` CSS px.
The 0.5 page-unit margin covers small metric/layout differences and scales with the text;
the 4 CSS px cover two 1 px borders, one caret pixel and one pixel for browser layout rounding.
Fixed-width/fixed-size boxes retain their authored editor width. Growing chrome preserves the
left/centre/right alignment anchor: move its left edge by 0/half/all of the growth and move the
rotation origin inside the frame by the same amount. The original rotation pivot therefore stays
fixed in page space, including on rotated old boxes. The document frame is untouched.
