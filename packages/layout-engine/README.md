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
typed literal label, a charge, a dative bond to a metal (that N is the bare one). What nothing
decides is chosen by Hückel's rule for the whole ring system, then local aromaticity of the small
rings, then the fewest N–H; when more than one arrangement remains, one is picked deterministically
and its atoms are reported in `guessedHydrogenAtomIds`, which the valence check badges as
`chemistry.aromatic_tautomer_guessed` (owner decision 2026-09-27: never place or drop an N–H
silently). Every question is a perfect-matching test (Edmonds' blossom algorithm), and the
arrangements are compared exhaustively only for up to ten open nitrogens per ring system, so the
search stays polynomial; `kekuleSearchWorkForTesting` counts its work for the cost tests.

`src/testing.ts` (`@chemdraft/layout-engine/testing`) carries the aromatic fixtures of record —
benzene through quinolin-2(1H)-one, each written both with aromatic bonds and as a Kekulé structure —
plus `testMoleculeFromSmiles` (a test-only reader whose bare lowercase `n` states no hydrogen, as a
type-4 bond does not), and `porphyrinoid` / `fusedPyrroleLadder` builders.

Layout must not change chemical identity.
