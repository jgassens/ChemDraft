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

### Picker

Insert > Templates… opens the desktop's modeless, document-owned picker (the browser preview has
an in-page fallback). It is also available in Customize Main Toolbar, with an original ring/grid
glyph, and is not on the default toolbar. Search matches normalized substrings of names and
synonyms, including Greek or spelled-out `beta`, `β-CD`, `crown`, `cucurbit[7]` and `pillar`.
Families follow this package's order; pillararenes sit beside their matching dimethoxy variants.
Tiles show shared-renderer SVG drawings, with synonyms/formula in their accessible description.
Arrow keys navigate; click, Enter or Space inserts and keeps the picker open. Escape closes it.

`template.insertDialog` opens or focuses the picker; `template.insert.<id>` inserts one template
into the source drawing, selected and centred in its visible view, at the default bond length,
as one labelled Undo entry. The dialog has no document capability and loads no chemistry engine.

### Data and layouts

`structureTemplates` holds named whole molecules, separate from the atom-label abbreviations above.
Each `StructureTemplate` has a stable kebab-case `id`, display `name`, `synonyms`, `family`, category
`"supramolecular"`, vetted isomeric `smiles`, Hill `formula`, net `charge`, a PubChem CID in `source`,
and a `layout` of atoms and bonds. `structureTemplateById(id)` performs exact ID lookup.
`structureTemplateFamilyOrder` and `structureTemplateFamilyNames` provide the seven picker families
in a stable order, including the currently empty families. This package provides data, without a
name matcher, UI, or chemistry engine.

An optional `note` explains non-obvious identity choices or the chosen PubChem record. When no clean
PubChem record exists, `source.cid` is `null` and `note` is required (also checked by the generator).
Cryptand notes specify that [a.b.c] counts ether oxygen atoms per nitrogen-to-nitrogen bridge.

The coordinate frame uses **bond lengths, y up**, with the bounding box centred on the origin. Flat
templates normalize the mean bond to 1; templates marked `projection: "perspective"` normalize the
longest non-stretched bond to 1 before rounding coordinates to four decimals. Atom hydrogens are
implicit under standard valence; formal charges are explicit when nonzero. Bonds are zero-based
`[from, to, order, display?]` tuples with Kekulé orders 1–3; `"wedge"` or `"hash"` points from its first
atom, the stereocentre. `"bold"` is cosmetic line weight, never stereo. An optional `allowedCrossings` count defaults to zero and must be justified
in the generator only when a family's 2D projection requires crossings.

**Coordinates are original ChemDraft designs constructed from geometry.** PubChem CIDs identify the
molecules; no database or depiction program supplies their coordinates. The first family contains
five donor-organized crown ethers (12-, 15-, 18-, 21-, and 24-membered rings), benzo-15-crown-5 and two
dibenzo crowns with outward regular fused hexagons, and three cryptands drawn with left/right
bridgehead nitrogens and three distinct zigzag bridges (upper, central and lower).

### Depiction conventions

Crown ethers are organized around their oxygen donors: four donors form a square, five a pentagon,
six a hexagon, and seven or eight a rounded polygonal outline. The default orientations have a
vertical mirror axis. Each neighboring donor pair is joined by an outward-bowed O–CH2–CH2–O span
with three equal bonds and two explicit skeletal carbon corners at 120 degrees. The oxygen labels
occupy inward notches, leaving a clear central opening and a countable polyether repeat.

Benzo crowns place regular benzene hexagons outside the opening. Their adjacent aryloxy bonds
continue the macrocycle at normal trigonal angles; the flexible ethylene bridges bend outward
around the donor stations. A single benzo panel sits on the left, while dibenzo panels face one
another across the opening, with balanced upper and lower chains.

Cryptands place neutral tertiary nitrogen bridgeheads at left and right, joined by three separated
zigzag paths. The outer paths bow around the cavity, and the central path has enough amplitude to
show every carbon corner and ether oxygen. The shorter bridge is central in [2.2.1]; [2.1.1] also
has a shorter lower path. All bonds have the same length before coordinate rounding. These are
connectivity projections in the classical crown-ether and cryptand drawing tradition, not claims
of a particular solution conformation; plain bonds add no stereochemical assignments.

The seven calixarenes are the **depth-by-line-weight pilot**. The supplied parameterized cone
mock-up is the starting construction: regular benzene panels on a regular n-gon, unit 3D bonds,
lower-ortho CH2 links and an upper para rim. `projectOrthographic`, `cueBondDepth` and
`orderBondsByDepth` in `geometry.mjs` are reusable for later host families. A bond whose original
3D midpoint lies more than **0.15 bond units toward the viewer** is `"bold"`; the back half and
middle-plane dead zone keep normal weight. Directed wedges/hashes always take priority. Bonds
are emitted back to front because the native renderer resolves crossings by bond-array order.
There are no generated crossing overrides, opacity changes or stereo flags for depth.

Calix[4] looks along one ring: **one bold face-on front panel**, a thin face-on back panel offset
to its left, and two thin near-edge-on end panels at equal depth. Both CH2 links from the front
panel are bold; the links to the back panel are thin. The camera centre lies 0.85 bonds toward the
viewer from the cone axis, so the end panels' nearer edges also stay behind its middle plane.
The original 3D midpoint rule and 0.15 dead zone are unchanged; no ring's depth assignment is forced.
Calix[8] retains its 9° inclination so the front and back panels remain distinguishable.

The tetramer's generator offers two comparison geometries through `coneParametersFor(n, variant)`:
**A** retains the round-3 end yaw of ∓9.5°.
**B** (the default) opens the ends with ∓22° yaw to about **40.27% of face-on width**. Its projected CH2 junctions start at
the lower intersections of equal-radius endpoint circles (radius 1.2 original bond units), then
receive small corrections that clear the back oxygen. End tBu fan half-widths remain 0.6 bonds in A
and 0.64 in B. Both geometries remain wider than tall.
Every C–O bond in **all seven calixarenes**, including both tetramer geometries and bold foreground
bonds, points exactly down: each oxygen has its own phenolic carbon's x coordinate. For n = 4
(A and B) and n = 5, its length increases smoothly with the original ring's nearness to the viewer,
averaged over its six aromatic carbons **before** screen adjustments. Equal depths give equal lengths, within four-decimal
serialization. With `t = (depth − farthest) / (nearest − farthest)`, the length in nominal bonds is:

- n = 4 (A and B): `0.78 + 1.21 t`.
- n = 5: `0.79 + 1.20 (1 − exp(−8t)) / (1 − exp(−8))`, a saturating curve.

The nearest stem is 1.99 nominal bonds; the farthest is 0.78 (0.79 for n = 5). The camera and
automatic label orientation are unchanged. Every C–O remains a declared stretch, excluded from
normalization and checked against the unchanged 0.35–2.0 window.
For n = 6 and n = 8, the OH labels instead retain two heights: foreground above, rear below,
chosen by the sign of the original ring depth. The upper row is 0.65 nominal bonds below the
lowest phenolic carbon for n = 6, or 0.60 for n = 8; the lower row is another 1.09 bonds below it.
Their complete parsed entries, including all ring and CH2 coordinates, match `2f042f96`.
The n = 4 (A and B) and n = 5 entries retain the depth-length layouts from `802cdc2d`.
The source 3D cone retains unit bonds and
rotationally identical complete aryl/OH/tBu/CH2 repeats. Depth styling and stacking precede these
screen adjustments. Insertion assigns perspective templates with bold bonds a molecule-level
`style.bondBoldWidthPx` of **0.136 × the final insertion bond length** (2.992 px at 22 px),
unless the caller explicitly overrides it. This lets the molecule inspector change Bold width;
no per-bond width map is written. Flat templates retain their ordinary style, and normal bonds
still use the normal stroke width. Presets and the shared renderer are unchanged, including their crossing gaps.

Use `node tools/template-layouts/build.mjs --calix4-variant A` to generate A; omit the option (or
pass B) to restore B. `render-check.mjs` and `inspect-calixarenes.mjs` accept the same option.
Rendering inserts through `structureTemplateMolecule` and exports the native document; it records
the inserted widths and confirms they occur in the exported SVG before rasterizing. The usual
800 px raster width, 24-unit crop padding and contact-sheet framing apply to both variants.
Use `render-check.mjs --ids <id,id,...>` to render a subset with the same insertion and framing.

This is a textbook schematic, not an energy-minimized conformer. After projection, whole negative-y
units retain their sideways displacement for n = 6 and 8 (0.59 and 0.55 source bonds). A and the
pentamer retain their carbon placements. B retains its depth-length whole-unit translations and
CH2-junction corrections. Both hexamers and both octamers retain their earlier two-height
placement parameters, with no additional ring or CH2 moves. These separate labels under the unchanged
clearance gates.
These translations include the aryl ring and its substituents; no ring vertices are sheared or
individually moved. The hexamer retains its original panel orientations, without panel yaws or
station levelling. The octamer retains its original orientations and 20% station levelling.
The complete placement parameters are in `coneParametersFor`; junctions first follow the linked
units, then receive the declared corrections. All cameras, the ideal unit-bond 3D construction,
and the original depth styling/stacking remain unchanged. Rear C–O bonds do not cross a front ring.
No coordinates come from a reference picture. The remaining seven entries retain their flat layouts.

Angles are degrees. Inclination describes the screen plane; the oriented camera normal is
`(0, -cos(inclination), -sin(inclination))`, facing the broad foreground panels. The lower
inclinations for n = 4, 6 and 8 retain the familiar shallow view.

| n | Ring tilt | Inclination | Azimuth | CH2 angle | CH2 pitch | tBu fan |
|---|---:|---:|---:|---:|---:|---:|
| 4 | 3 | 6.5 | 0 | 132 | -100 | 45 |
| 5 | 33.5 | 21.5 | 54 | 121 | 70 | 50 |
| 6 | 24 | 7 | 30 | 123 | 45 | 66 |
| 8 | 11 | 9 | 22.5 | 125 | 65 | 57.5 |

`inspect-calixarenes.mjs` reports rounded-coordinate gate values, margins, every stretched bond and
every bold bond. Crossings count nonincident bond centrelines, not the inner aromatic strokes.
The native renderer retains its existing crossing-gap convention. At the default 22 px nominal
length, perspective templates must leave at least **0.15 nominal bond lengths** between every
pair of padded rendered atom-label boxes (3.3 px at 22 px). The gate also runs at 30 px, using
the same shared-renderer boxes as the existing nonincident-bond checks; those checks remain unchanged.

### Projection policy

`projection?: "perspective"` is a general template contract, including future cages such as C60;
the host and gates check the field, not a list of template IDs. Insertion makes the **longest
non-stretched bond equal the document bond length** (or the caller's explicit style length), within
`1e-9`, retaining foreshortening. Flat templates continue to scale by their mean. Both retain the
document's drawing style, including its normal stroke width and label size.

Projection templates are exempt from the per-template ±5% bond-equality check, the flat 0.85–1.15
bond window, the zero/declared-crossing count check, and the nonincident bond-to-bond 0.35 clearance
check. Instead, each ordinary projected bond must be **0.35–1.0 of the reference bond**.
`layout.stretchedBonds` declares exceptional endpoint pairs; each must name an existing unique
bond in a perspective template. These bonds are excluded from both longest-bond scaling and the
ordinary ratio window; they may be **0.35–2.0 of the reference**. They participate in every atom,
label and crossing check. The nominal reference is the longest bond outside that declaration.

Every template must preserve canonical isomeric SMILES through RDKit, Hill formula, charge and graph
counts. Non-neighbour atoms in projections must remain at least **0.30** (flat layouts retain **0.6**),
labelled atom/non-neighbour pairs at least **0.95**, and labels at least **0.75** from every
nonincident bond, all in nominal-reference units. These numerical checks do not replace inspecting
actual text and strokes at normal document style. A further gate uses the shared renderer's padded
upright label boxes: boxes must not overlap one another or touch nonincident bond strokes. Both
label-distance thresholds and rendered-box assertions are unchanged. Crossings are reported;
template code does not add special crossing overrides.

The inserted molecule stores `style.projection = "perspective"` and the full document bond length
in `style.bondLengthPx`. Ordinary new single bonds, attached rings (`nativeTemplateBondLength`),
and resizing (`representativeNativeMoleculeBondLength`) use that nominal length for marked
projections. Unmarked molecules retain their measured-median sizing. Desktop tests exercise actual
bond growth and ring attachment at both 22 px and 30 px; ring coordinates retain the tool's existing
0.001 px rounding. Shared-core tests cover projection resizing and unchanged ordinary sizing.

**Inspector follow-up outside this slice's owned files:** `representativeMoleculeBondLengthPx`
in `apps/desktop/src/moleculeInspectorModel.ts` still measures the median. It feeds the displayed
value and `MainWindow.tsx`'s exported molecule-inspector style settings, so applying those exported
settings can propagate the foreshortened length. Direct attachment and target-length resizing are
fixed independently.

Clean Up Structure re-lays a projected template out flat and removes the projection marker as
**one undo step**. Desktop tests use the actual command and chemistry engines to verify unchanged
canonical isomeric identity, formula, charge, atom and bond counts. Undo restores the entire inserted
molecule, including its perspective coordinates, exactly; redo restores the recorded flat result.

Existing regression expectations changed in this revision:

- Perspective nonbonded clearance is 0.30 reference bonds, from the prior policy's 0.60 flat limit.
  Flat clearance and both label-distance thresholds are unchanged.
- Insertion, explicit size overrides, resizing and desktop growth measure the longest
  **non-stretched** bond so the declared OH stems cannot shrink the framework. Bond ratios and label
  distances use the same reference. The declared bonds get their separate 0.35–2.0 length window.
- Ordinary-style equality separates and checks the projection marker. Every actual drawing-style
  field must still equal the ordinary molecule's style. The projection default test no longer
  requires every bond display to be unset: a separate test requires exactly the generator's bold
  marks and verifies the inserted canonical isomeric identity, formula and charge.
- Calixarenes leave the flat five-percent/absolute bond windows and nonincident bond-clearance/
  crossing gates. Their actual 3D models still have unit bonds and
  rotationally identical complete units; the editorial screen shifts are checked separately.
- Attached-ring lengths use 0.002 px tolerance for the existing 0.001 px coordinate rounding.
  Single-bond and insertion tolerances stay `1e-9`. Ordinary unmarked sizing is unchanged.

New assertions also cover signed midpoint depth, the dead zone, stereo priority, back-to-front
ordering, n = 4/5 monotonic C–O depth lengths and equal-depth ties, n = 6/8 two-height OH rows,
cosmetic bold/plain chemistry and stereo equality through real CDXML export/import,
rear C–O routing, declared stretch validity, inserted/cleaned markers,
actual projection resizing, and unmarked-molecule sizing.


### Generating and checking layouts

All seven family files in `src/structureTemplates/` are generated. Their identity metadata and
layout construction live in the corresponding Node ESM script under `tools/template-layouts/`.
To add a family, fill its existing generator input and construct its original layout with
`geometry.mjs` (polygons, rigid transforms, benzene fusion, projection, depth and normalization).
Keep the stable IDs, preserve vetted isomeric identity and document any unavoidable crossing. The
registry already imports every family, so it needs no edit. Do not hand-edit the generated files.

Regenerate all families with `pnpm templates:layouts` or `node tools/template-layouts/build.mjs`;
append `--check` to the Node command to check for stale output without writing. Each family script
also runs independently, with optional `--check`. Scripts work from any directory on macOS and
Windows, using Node's path APIs and no additional dependencies.

`packages/document-workflow-core/tests/structureTemplates.test.ts` automatically checks every entry:
RDKit's canonical isomeric identity from coordinates/wedges against the stored SMILES, Hill formula,
charge, bond lengths, atom separation and bond crossings, plus unique IDs and normalized
names/synonyms across templates. The shared matcher in `document-workflow-core` uses Unicode NFKC,
lowercase, Greek alpha/beta/gamma/delta expansion and removal of whitespace, Unicode dashes, brackets,
commas, apostrophes and primes; digits retain their order and periods remain significant. Alternate
spellings may share a key within one template. Template-library's own tests
run the generator check so committed layouts cannot drift from their source.

Generated atoms and bonds each occupy one line for review. Run `pnpm templates:check-images`
(or `node tools/template-layouts/render-check.mjs --out <directory>`) to render every template at
document style through the shared native document exporter, cropping and PNG rasterization used by
`chemdraft render-document`. The default `tools/template-layouts/.check/` contains one PNG per stable
template ID and `contact-sheet.png` with names below each structure; these artifacts are ignored.
Use `--family calixarenes-pillararenes` to render the seven depth-cued cones alongside all seven unchanged
flat family entries, including both pillar sizes and both dimethoxy derivatives. The additional
`contact-sheet-true-scale.png` shows the default document size without enlarging small structures.
`label-clearance.json` records the rendered label-box measurements and any collisions.
`compare-reference.mjs --ours <PNG> --reference <PNG> --out <PNG>` writes a picture-only side-by-side
comparison; it never extracts template coordinates from either image.
