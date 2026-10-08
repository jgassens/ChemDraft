# Structure images, grids and reaction schemes

Contents: common inputs; render options; grid options; reaction options;
image/stereo checks; desktop-only drawing.

Use the `checkout` and external `scratch` variables established in
[recipes](recipes.md). Commands below work in POSIX shells and PowerShell.
SMILES encodes chemical identity; a dot separates disconnected components.
Rendering uses the shared document/rendering code, not an independent sketch.

## Render

Choose exactly one of `--smiles` and `--batch`. A batch is a JSON array:

```json
[{"name":"ethanol","smiles":"CCO"},{"name":"acetone","smiles":"CC(=O)C"}]
```

Every render flag, with its default or requirement:

| Flag | Meaning / default |
|---|---|
| `--smiles` | One SMILES; no default |
| `--batch` | File containing named SMILES jobs; no default |
| `--out` | Required in single mode; image filename or base for `both` |
| `--out-dir` | Required in batch mode; incompatible with single mode |
| `--format` | `png`, `svg`, `both`; infer single `.png`/`.svg`, batch defaults to `png` |
| `--width` | PNG width, default 600 px; 16–4000 |
| `--background` | `white` (default) or `transparent` |
| `--bond-length` | Depicted bond length, default 28 px; positive |
| `--padding` | Crop margin, default 24 px; nonnegative |
| `--help` | Print help and exit |

```sh
pnpm -s --dir "$checkout" chemdraft render --smiles 'CCO' --out "$scratch/ethanol" --format both
pnpm -s --dir "$checkout" chemdraft render --batch "$scratch/choices.json" --out-dir "$scratch/choices" --format both --width 600
```

SVG is vector artwork for rescaling; PNG is a raster image useful for
inspection and document software. `--width` sets raster resolution, not
the molecule's chemical geometry. Keep the same width across separate
choices in one question; a grid also keeps a common bond-length scale.
Use `--background transparent` for slide backgrounds; view on the actual
slide background to check contrast. `both` writes `.svg` and `.png`.
Check label masks too: a transparent canvas does not ensure that atom-label
backgrounds blend with a coloured slide.
Render results include specified and unspecified stereo counts and warnings.

## Grid

`grid` requires a named SMILES batch. It validates every entry before
writing one image; any invalid SMILES fails the whole grid. Input order
determines choice labels. Automatic columns fit the widest measured cell
and gutter within the default page width; specify `--columns` for an exam layout.

| Flag | Meaning / default |
|---|---|
| `--batch` | Required JSON file, same shape as render |
| `--out` | Required `.png` or `.svg`; extension selects format |
| `--columns` | Positive integer; default automatic |
| `--labels` | `none`, `letters` (default), `names` |
| `--width` | PNG width, default 600 px; ignored for SVG |
| `--gutter` | Space between cells, default 32 px; nonnegative |
| `--padding` | Margin around content, default 24 px; nonnegative |
| `--background` | `white` (default) or `transparent` |
| `--help` | Print help and exit |

```sh
pnpm -s --dir "$checkout" chemdraft grid --batch "$scratch/choices.json" --out "$scratch/question.png" --columns 2 --labels letters --width 1000
```

Keep an answer key tied to that input order. Do not replace failed choices
with guessed drawings. MCP `render_grid` takes the array as `items` rather
than a batch filename and selects `format` separately.

## Reaction

Provide one input mode: `--rxn`, repeated role flags, or `--batch`.
Reaction SMILES has exactly two `>` separators: reactants, agents, products.
`--rxn` splits each role on dots. To keep a salt as one molecule object,
use repeated `--reactant`, `--agent`, `--product`; each flag value stays
whole. MCP `render_reaction` has equivalent `reactants`, `agents`,
`products` arrays; do not mix them with `reactionSmiles`.

```sh
pnpm -s --dir "$checkout" chemdraft reaction --reactant '[Na+].[O-]C(=O)C' --agent 'Cl' --product 'CC(=O)O' --conditions 'aqueous acid workup' --out "$scratch/salt.svg"
```

Agents are validated and shown as composition formulas above the arrow;
`--conditions` appends text. Carbon-free formulas use conventional order
(such as HCl); ionic charges are superscripts, and hydroxide displays OH⁻.
`agentTexts[].hillFormula` retains the exact Hill formula (carbon, hydrogen,
then other elements alphabetically). Current source **fails** an agent
whose composition cannot be computed; do not promise a SMILES fallback.
The scheme arranges supplied species; it does not predict products, infer
reaction feasibility, or balance the equation.

| Flag | Meaning / default |
|---|---|
| `--rxn` | One reaction SMILES; no default |
| `--reactant` | Repeat for each reactant; at least one in role mode |
| `--agent` | Repeat for optional agents |
| `--product` | Repeat for products; at least one in role mode |
| `--out` | Required single-mode `.png`/`.svg`; extension selects format |
| `--batch` | Named reaction jobs file |
| `--conditions` | Additional text; default empty |
| `--arrow` | `forward` (default), `equilibrium`, `resonance`, `retrosynthesis` |
| `--width` | PNG width, default 1000 px; 16–4000 |
| `--background` | `white` (default) or `transparent` |
| `--out-dir` | Batch directory; needed for jobs without `out` |
| `--format` | Batch `png` (default) or `svg` when jobs omit `out` |
| `--help` | Print help and exit |

Retrosynthesis puts products (the target) on the left and reactants
(precursors) on the right: target ⇒ precursors. Other kinds use reactants
left and products right. Species, plus signs and arrows use 24 px gutters.

Reaction batch shape:

```json
[
  {"name":"ester","rxn":"CC(=O)O.CCO>OS(=O)(=O)O>CC(=O)OCC","conditions":"reflux"},
  {"name":"workup","reactants":["[Na+].[O-]C(=O)C"],"agents":["Cl"],"products":["CC(=O)O"]}
]
```

Each job may override `out`, `format`, `conditions`, `arrow`, `width`,
`background`. An explicit `out` extension selects that job's format.
Role arrays preserve dot-joined salts. Use one scheme per step for a
multi-step synthesis, then place the verified steps in order in the document.

## Check images and stereochemistry

View once at the intended placement size. Check labels, charges, atom and
bond counts, stereo wedges/hashes, clipping, conditions, choice labels and
reaction roles. Preserve the SMILES/options with the figure.
`stereoCenters` counts specified centers; `unspecifiedStereoCenters` counts
constitutional centers lacking a descriptor; `unspecifiedDoubleBonds`
counts unknown E/Z double bonds. For an asserted fully specified
stereoisomer, both unspecified counts must be zero. Do not silently add
stereochemistry to make that true.

```sh
pnpm -s --dir "$checkout" chemdraft stereo --smiles 'C[C@H](O)C(=O)O'
pnpm -s --dir "$checkout" chemdraft stereo --smiles 'C/C=C/C'
```

Use the returned R/S and E/Z assignments. Indices are 0-based molfile
order. `stereo` reports `stereoCenters` and `doubleBonds` arrays, with
`specifiedCount` and `unspecifiedCount` across both kinds; those differ
from a render's numeric `stereoCenters` field. SMILES `@`/`@@` is
ordering-dependent and must not be read as R/S.

## Desktop-only drawing

The eight headless commands have no input for arbitrary annotations,
curved electron-pushing mechanism arrows or fishhooks. Reaction arrows
are the four kinds above, not mechanism arrows. Those drawings need the
desktop app and real editable document objects. Hand a human CDXML via
[files](files.md); do not invent a canvas API or edit through the test bridge.
