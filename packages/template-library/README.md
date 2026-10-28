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
  The exceptions are the `bondedSpellings` chemists write on bonds: typed as a label on an atom with
  bonds, "Ac" is acetyl, "Pr" n-propyl and "Ts" tosyl; unbonded, or read from a structure file, they
  are actinium, praseodymium and tennessine. The parser applies the same rule to "Ar" (aryl, a
  placeholder). "CN" is cyano: case folding leaves it as typed (layout-engine's
  `nativeFormulaTwoLetterLabels`), and only the exact "Cn" is copernicium. Its meaning depends on
  which end faces the bond, so there is no "NC" alias, a composite reads "CN" only last, after its
  head ("SCN", "CH2CN"), and the label parser reads "CN", "SCN" and "OCN" as cyano groups unless the
  bond comes from the label's right. There a chemist means isocyano, an isothiocyanate or an
  isocyanate, which the table lacks, so the label stays a bare formula.
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

## Structure templates

`structureTemplates` holds named whole molecules, separate from the atom-label abbreviations above.
Each `StructureTemplate` has a stable kebab-case `id`, display `name`, `synonyms`, `family`, category
`"supramolecular"`, vetted isomeric `smiles`, Hill `formula`, net `charge`, a PubChem CID in `source`,
and a `layout` of atoms and bonds. `structureTemplateById(id)` performs exact ID lookup.
`structureTemplateFamilyOrder` and `structureTemplateFamilyNames` provide the seven picker families
in a stable order, including the currently empty families. This package provides data, without a
name matcher, UI, or chemistry engine.

The coordinate frame uses **bond lengths, y up**, with the bounding box centred on the origin. Mean
bond length is normalized to 1 before rounding coordinates to four decimals. Atom hydrogens are
implicit under standard valence; formal charges are explicit when nonzero. Bonds are zero-based
`[from, to, order, display?]` tuples with Kekulé orders 1–3; `"wedge"` or `"hash"` points from its first
atom, the stereocentre. An optional `allowedCrossings` count defaults to zero and must be justified
in the generator only when a family's 2D projection requires crossings.

**Coordinates are original ChemDraft designs constructed from geometry.** PubChem CIDs identify the
molecules; no database or depiction program supplies their coordinates. The first family contains
five polygonal crown ethers (12-, 15-, 18-, 21-, and 24-membered rings), benzo-15-crown-5 and two
dibenzo crowns with outward regular fused hexagons, and three cryptands drawn with left/right
bridgehead nitrogens and three distinct bridges (upper arc, central zigzag, lower arc).

All seven family files in `src/structureTemplates/` are generated. Their identity metadata and
layout construction live in the corresponding Node ESM script under `tools/template-layouts/`.
To add a family, fill its existing generator input and construct its original layout with
`geometry.mjs` (polygons, equal-bond arcs, rigid transforms, benzene fusion and normalization).
Keep the stable IDs, preserve vetted isomeric identity and document any unavoidable crossing. The
registry already imports every family, so it needs no edit. Do not hand-edit the generated files.

Regenerate all families with `pnpm templates:layouts` or `node tools/template-layouts/build.mjs`;
append `--check` to the Node command to check for stale output without writing. Each family script
also runs independently, with optional `--check`. Scripts work from any directory on macOS and
Windows, using Node's path APIs and no additional dependencies.

`packages/document-workflow-core/tests/structureTemplates.test.ts` automatically checks every entry:
RDKit's canonical isomeric identity from coordinates/wedges against the stored SMILES, Hill formula,
charge, bond lengths, atom separation and bond crossings, plus unique IDs, names and normalized
synonyms (Unicode NFKC, case folding, trimmed/collapsed whitespace). Template-library's own tests
run the generator check so committed layouts cannot drift from their source.
