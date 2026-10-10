# @chemdraft/template-library

Owns original fragments, abbreviations, superatoms, templates, and style presets.

Do not copy proprietary template libraries, sample files, or style sheets.

## Abbreviations (`src/abbreviations.ts`)

The groups a chemist writes as an atom label — OMe, Ph, Boc — each with the structure it stands for:
its SMILES (the definition), Hill formula, free valence, and atoms (element, stated hydrogens, charge)
and bonds, with a 2D layout. The table is original to ChemDraft: every entry was written here from the
group's own chemistry, and no other program's nickname list was copied (AGENTS.md §12).

- **Case-sensitive.** "OMe" is methoxy; "Ome", "OME" and "ome" are not groups.
  `abbreviationSpellingSuggestion` offers the intended spelling for a message, never as a match.
- **Right-to-left spellings are aliases** of the same group ("MeO", "EtO2C"), since that is how a group
  on the left of a structure is written.
- **Elements win, except on a bond.** A label that is an element symbol is the element, so no label
  or alias may spell one (document-workflow-core's tests enforce this against the element table).
  The exceptions are the `bondedSpellings` chemists write on bonds: on an atom with bonds, "Ac" is
  acetyl, "Pr" n-propyl and "Ts" tosyl; unbonded, they are actinium, praseodymium and tennessine.
  The parser applies the same rule to "Ar" (aryl, a placeholder). "CN" is cyano: case folding leaves
  it as typed (layout-engine's `nativeFormulaTwoLetterLabels`), and only the exact "Cn" is copernicium.
  There is no "NC" alias, and in a composite "CN" is read only last, after its head ("SCN", "CH2CN"),
  because its meaning depends on which side of the bond it is written. For the same reason "OCN" and
  "SCN" written for a bond on their right (isocyanate, isothiocyanate) are still read as cyanato and
  thiocyanato: a known limitation.
- **Layouts** were computed from each SMILES with RDKit and normalized: the attachment atom at (0, 0),
  the atom the group bonds to at (−1, 0), bond length 1, y up. No group carries stereochemistry.

To add a group: write its SMILES with `*` as the attachment, generate a layout the same way, state each
atom's hydrogens, and run the tests. They check the formula string against the atoms, the geometry,
that every spelling is unique and not an element, that each atom's stated hydrogens are the valence
model's, and that the atoms and hydrogens are what RDKit reads from the entry's SMILES.

The chemistry these groups take part in (reading a label, free valence, validation) lives in
`@chemdraft/document-workflow-core`; this package holds data only.

## Generic labels (`src/genericLabels.ts`)

Placeholders drawn on purpose — R, R′, R1–R99, X, A, Q, M, Nu, E, LG, PG, ?, and the dummy atom `*` —
which are never structure and never a mistake. Case-sensitive; "Z" is left out because it is also the old
peptide abbreviation for Cbz.
