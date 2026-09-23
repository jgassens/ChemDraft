# @chemdraft/chemdraft-cli

`chemdraft` is the shared command-line entry point for headless ChemDraft workflows. Run
`pnpm -s chemdraft --help` from the workspace root to list its subcommands. `-s` suppresses pnpm's
script banner so stdout remains JSON Lines. The package is private and
its source modules are intended for workspace tools that need the same document and rendering path.

## Common contract

Commands write machine-readable JSON lines to stdout and human-readable progress to stderr. A
successful line has `ok: true`, a `name`, command inputs, command outputs, and `warnings: []`; a
failed line has `ok: false`, its identifying inputs, and an `error` string. Commands exit 0 when all
jobs succeed, 1 when any attempted job fails, and 2 when arguments or batch input are invalid.

Batch files are JSON arrays of named jobs. Names are trimmed. Blank names, duplicate names, names
beginning with `.`, and names containing `/` or `\` are rejected before work starts. Each subcommand
documents the additional fields its jobs require.

## render

Render one SMILES string or a JSON batch to cropped SVG, PNG, or both. This is the implementation
behind the backwards-compatible `pnpm -s render` script.

```bash
pnpm -s chemdraft render --smiles 'CCO' --out ethanol.svg
pnpm -s render --batch jobs.json --out-dir rendered --format both
```

Batch jobs have the shape `{"name":"aspirin","smiles":"CC(=O)Oc1ccccc1C(=O)O"}`. Successful
results report output `files`, the depiction `engine`, specified and unspecified stereocenter counts,
and warnings. Radical or isotope labels that the native document cannot preserve are refused rather
than silently removed. Run `pnpm -s render --help` for every rendering option.

## grid

Render a named SMILES batch as one multiple-choice PNG or SVG grid. Every entry is validated before
the image is written, so one bad structure fails the whole grid.

```bash
pnpm -s chemdraft grid --batch jobs.json --out questions.svg --columns 2 --labels letters
```

`--columns` defaults automatically; `--labels` is `none`, `letters`, or `names`; `--width` controls
PNG width (600 by default); `--gutter` defaults to 32 px; `--padding` defaults to 24 px and accepts
zero; and `--background` is `white` (the default) or `transparent`. The single JSON result reports
the row/column position and displayed label for every cell.

## reaction

Render a reaction scheme as PNG or SVG. Reaction SMILES keeps its conventional `.` splitting:

```bash
pnpm -s chemdraft reaction --rxn 'CC(=O)O.OCC>OS(=O)(=O)O>CC(=O)OCC' --out ester.png
```

For salts or complexes that must remain one molecule object, use repeated role flags instead. A
`.` inside one repeated value is preserved:

```bash
pnpm -s chemdraft reaction \
  --reactant '[Na+].[O-]C(=O)C' --agent 'OS(=O)(=O)O' --product 'CC(=O)O' \
  --out scheme.svg
```

Batch jobs contain either `rxn` or `reactants`/`agents`/`products` arrays and may override `out`,
`format`, `conditions`, `arrow`, `width`, and `background`. Agents are shown as composition-derived
formula text (for example `H2SO4`); JSON records the text, its original SMILES, the strict Hill
formula, and whether formula or SMILES fallback was used. `--arrow` accepts `forward`,
`equilibrium`, `resonance`, or `retrosynthesis`; PNG width defaults to 1000; background defaults to
white.

## analyze

Run the RDKit-backed property and prediction suite for one SMILES or a named batch.

```bash
pnpm -s chemdraft analyze --smiles 'CC(=O)Oc1ccccc1C(=O)O'
pnpm -s chemdraft analyze --batch jobs.json --methods rdkit.composition,rdkit.crippen-logp
```

`--methods` selects comma-separated contract ids; `--format` is `json` (default), `md`, or `text`;
and a single job may use `--out`. Every compact summary field is `{value,status}` plus a reason when
a method declined or failed. `not-requested` is distinct from analysis statuses such as
`unsupported`. pKa sites retain null values and reasons, use 0-based `atomIndex`, and separately
report `siteType`, transition, acid charge, basis, and interval.

## name

Convert a chemical name with the bundled OPSIN runtime, optionally rendering the result.

```bash
pnpm -s chemdraft name --name '2-acetoxybenzoic acid' --render aspirin.png
pnpm -s chemdraft name --batch names.json
```

Batch jobs are `{"name":"aspirin","query":"2-acetoxybenzoic acid"}`. Names containing control
characters, tabs, or newlines are rejected. `--render` is single-mode only and must name a PNG.
Missing runtimes, parse failures, non-zero engine exits, timeouts, and depiction failures are
reported distinctly.

## stereo

Inspect tetrahedral R/S centres and double-bond E/Z geometry.

```bash
pnpm -s chemdraft stereo --smiles 'C/C=C/C'
pnpm -s chemdraft stereo --batch jobs.json
```

`stereoCenters` uses 0-based atom indices; `doubleBonds` uses 0-based bond indices. Constitutionally
stereogenic centres or double bonds with no descriptor are `unspecified`, increment
`unspecifiedCount`, and emit a warning. Axial stereo that the flat document cannot represent is
reported separately.

## nmr

Predict ¹H/¹³C shifts using a separately checked-out ChemDraft NMR predictor plugin. Set
`CHEMDRAFT_NMR_PLUGIN_DIR` when it is not at `~/programming/chemdraft-nmr-plugin`.

```bash
pnpm -s chemdraft nmr --smiles 'CCO' --nuclei 1H,13C --spectrum ethanol.svg
pnpm -s chemdraft nmr --batch jobs.json --spectrum-dir spectra --spectrum-format png
```

Options include `--name` in single mode, `--statistic median|mean`, `--ignore-labile`, and PNG
`--width` (1280 by default). A multi-nucleus spectrum writes one suffixed file per nucleus.

What the numbers are:

- Shifts are predictions from HOSE-fragment lookup over statistics derived from NMRShiftDB2
  experimental assignments. `hose-fragment` is a database match; `rule-estimated` is a disclosed
  additive-rule estimate and carries `NMR_RULE_ESTIMATED`.
- ¹H multiplicity and J are first-order topology estimates, marked `estimated: true`, not measured
  values.
- `nEquivalent` and spectrum stick height are predicted equivalent nuclei, not integration.
- An unmatched environment gets no invented shift; warnings identify no-match and partial results.
- No confidence percentages are reported; thin matches carry warnings instead.
- The reference database is a derivative database under the nmrshiftdb2 Database License
  (ODbL-derived attribution/share-alike), separate from the code license.

`atomIndices` are 0-based indices into the depicted molfile; an explicit warning says when plugin
atom order differs.

## export

Export one SMILES string or a JSON batch to CDXML, PDF, SDF, MOL, or SMILES.

```bash
pnpm -s chemdraft export --smiles 'CC(=O)Oc1ccccc1C(=O)O' --out aspirin.cdxml
pnpm -s chemdraft export --batch jobs.json --out-dir mols --format mol
pnpm -s chemdraft export --batch jobs.json --out combined.sdf --format sdf
```

Batch jobs have the shape `{"name":"aspirin","smiles":"CC(=O)Oc1ccccc1C(=O)O"}`. In single-structure
mode the format is normally inferred from `--out`'s extension (`.cdxml`, `.pdf`, `.sdf`, `.mol`,
`.smi`); `--format` overrides or disambiguates it. Batch mode always requires `--format`.

CDXML, PDF, and MOL are one structure per file: batch mode writes each job's file into `--out-dir`,
named `<job name>.<extension>`. SDF and SMILES are combined formats: batch mode writes every
structure into a single file at `--out` instead, with one JSON result line per input job all
naming that same combined file. Run `pnpm -s chemdraft export --help` for every option.
