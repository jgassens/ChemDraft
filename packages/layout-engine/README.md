# @chemdraft/layout-engine

Owns page and object layout operations such as align, distribute, group, rotate, flip, z-order, guides, and page sizing.

It also owns pure molecule-growth geometry helpers used by drawing tools, such as planning the next bonded atom position from an existing native molecule graph. The desktop app may consume these plans, but document mutation remains in `chem-core` patches and app workflow code.

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
five-ring H, and bounded-search fallbacks. A unique inferred placement keeps its canvas badge but
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
