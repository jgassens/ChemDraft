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
reported in `unresolvedAtomIds`, which the valence check turns into a badge.

`src/testing.ts` (`@chemdraft/layout-engine/testing`) carries the aromatic fixtures of record —
benzene through quinolin-2(1H)-one, each written both with aromatic bonds and as a Kekulé structure.

Layout must not change chemical identity.
