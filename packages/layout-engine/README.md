# @chemdraft/layout-engine

`nativeTextObjectLineMetrics` and `nativeTextSpanMetrics` define formatted native text baselines,
script offsets and per-line vertical extents. SVG rendering, formatted object sizing and the
conditions preview consume them. Scripted or size-overridden SVG lines use explicit y anchors and their runs use
measured offset deltas, preventing baseline drift across lines while preserving natural horizontal
glyph advance. Unformatted text keeps its existing SVG.

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

`DocumentStylePreset` and `DocumentTextStyle` are native style data in `@chemdraft/chem-core`.
`DocumentStyleScale` and point conversion stay here in `src/documentStyle.ts`. Native coordinates
use 22 units per bond; the physical scale is 14.4/22 pt per unit. Canvas plans and exporters use those same dimensions,
including the explicit bold/wedge width; export-engine wraps cropped SVG content in one scale
transform and writes its root dimensions and viewBox in points. CLI fitting remains the default. Labels and text use the Arial, Helvetica, sans-serif font stack.
`scalePageGeometry` scales every object frame, atom, arrow endpoint/control point, graphic geometry,
text position and explicit text size, and page dimensions together. Molecule colours, appearance
toggles remain unchanged; pixel-valued molecule styles, per-atom/per-bond maps and visual-effect
dimensions scale with the page.

`arrowAttachments.ts` resolves an arrow's midpoint and local frame, including semantic arrows with
page anchors, then places attached art arrows and condition text. Local offsets persist through
parent movement, bends and rotation; simultaneous group movement does not apply a second delta.
Path sampling and the tangential offshoot's geometry belong to art-engine.
Full-curve offshoots additionally resolve a stored tail offset while anchoring their on-curve middle
at a normalized parent-shaft fraction (default midpoint); half curves retain their anchored tail.
The tether handle projects onto actual rotated shaft samples. Full curves use two native segments
sharing the tether and a forward tangent; visible stroke sampling includes that junction exactly.
Creation records the straight-shaft normal polarity, so RTL Top starts above while later transforms
remain stable; curved outside geometry is unchanged. Both carry their offsets through
nonuniform scaling, with editable geometry and inherited head size.
Condition text remains upright, with its chosen outside/inside side and manual offset. Native save/reopen retains attachments;
SVG/PDF/raster output uses the same resolved page geometry as the canvas.
Resizing a parent carries its attachment tree and scales the offshoot's local geometry in both
axes, including manual bend edits. A second normalization does not apply the scale again.
Conditions use formatted text dimensions and seek clear positions on their chosen side, checking
actual arrow ink, heads, branches, molecule outlines and other text. Dragging a label marks its
position as manual so subsequent movement and editing preserve the chosen offset.

## Selection arrangement

`planObjectArrangement` plans translation-only Circle, Oval, Grid, Row and Column layouts.
Grid supports left, centered and right alignment of incomplete rows. Visible label bounds and
ring-system anchors reserve space for asymmetric molecules without altering molecular geometry.
It accepts an optional page frame and refuses layouts that cannot fit without scaling.
With a page frame, default Row/Column gaps tighten from 48 to no less than 12 document pixels
when necessary to fit. Explicit `gap` values remain fixed; molecule dimensions never change.
`textVisualBoundsForArrangement` measures rotated caption frames around the same pivot as SVG
text rendering, so grouped captions participate in layout clearance and page-fit checks.

`planArrangementConnections` optionally routes between the resulting placements: curved cycle arcs,
linear neighbors, independent grid rows or a snake sequence. Direction and closing a cycle are explicit.
Each route includes endpoint IDs and its untrimmed midpoint bend, allowing the spacing workflow to
reroute the same editable arrows after translating compounds. Arrow geometry remains in art-engine.
Routes also retain their arrangement settings and ordered item IDs so reopening edits the same
connections. Optional `arrowLength` (30–100, default 100) symmetrically trims the clear parameter
interval; it changes neither layout placements nor molecular geometry.
`arrangementConnectionPairs` shares directed-neighbor validation with the document workflow, so
changed selection membership or missing edges cannot silently preserve an incomplete arrangement.
It uses art-engine's trimmed quadratic routes to leave 12 px around visible item outlines and refuses
blocked or too-short shafts. It assigns no reaction roles and does not alter molecules.
`moleculeOutlineForArrangement` builds a tight convex ink envelope from the existing bond/stereo
renderer and atom-label plans. Routing avoids rectangular frame corners without passing through
ring interiors. Groups retain separate outlines for molecules and caption frames. The layout's
page-fit and packing frames stay conservative; the tighter outlines control arrow trimming.

Arrow context targeting uses `nearestArrowObjectAtPoint` to resolve actual shaft ink when sibling
or parent frames overlap. `reactionConditionsFrame` independently orients condition labels into the curve for Top/inside
and out of the curve for Bottom/outside. Straight shafts use page top/bottom regardless of LTR/RTL
(left/right for exactly vertical shafts). Branch geometry keeps its original attachment frame,
and saved manual labels stay put when their normal is corrected.
Attachment resolution uses the same resolved ancestor snapshot for condition frames and clearance,
including nested branches, so repeated normalization and export cannot flip their outside normal.
Inside offshoots mirror the established outside tip across the
parent's curved shaft; manual conditions positions bypass automatic clearance clamping.
