# @chemdraft/chemdraft-cli

`chemdraft` is the shared command-line entry point for headless ChemDraft workflows. Run
`pnpm chemdraft --help` from the workspace root to list its subcommands. The package is private and
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
behind the backwards-compatible `pnpm render` script.

```bash
pnpm chemdraft render --smiles 'CCO' --out ethanol.svg
pnpm render --batch jobs.json --out-dir rendered --format both
```

Batch jobs have the shape `{"name":"aspirin","smiles":"CC(=O)Oc1ccccc1C(=O)O"}`. Successful
results report output `files`, the depiction `engine`, specified and unspecified stereocenter counts,
and warnings. Radical or isotope labels that the native document cannot preserve are refused rather
than silently removed. Run `pnpm render --help` for every rendering option.

## grid

Planned. This subcommand currently prints `not implemented yet` to stderr and exits 2.

## reaction

Planned. This subcommand currently prints `not implemented yet` to stderr and exits 2.

## analyze

Planned. This subcommand currently prints `not implemented yet` to stderr and exits 2.

## name

Planned. This subcommand currently prints `not implemented yet` to stderr and exits 2.

## stereo

Planned. This subcommand currently prints `not implemented yet` to stderr and exits 2.

## nmr

Planned. This subcommand currently prints `not implemented yet` to stderr and exits 2.

## export

Export one SMILES string or a JSON batch to CDXML, PDF, SDF, MOL, or SMILES.

```bash
pnpm chemdraft export --smiles 'CC(=O)Oc1ccccc1C(=O)O' --out aspirin.cdxml
pnpm chemdraft export --batch jobs.json --out-dir mols --format mol
pnpm chemdraft export --batch jobs.json --out combined.sdf --format sdf
```

Batch jobs have the shape `{"name":"aspirin","smiles":"CC(=O)Oc1ccccc1C(=O)O"}`. In single-structure
mode the format is normally inferred from `--out`'s extension (`.cdxml`, `.pdf`, `.sdf`, `.mol`,
`.smi`); `--format` overrides or disambiguates it. Batch mode always requires `--format`.

CDXML, PDF, and MOL are one structure per file: batch mode writes each job's file into `--out-dir`,
named `<job name>.<extension>`. SDF and SMILES are combined formats: batch mode writes every
structure into a single file at `--out` instead, with one JSON result line per input job all
naming that same combined file. Run `pnpm chemdraft export --help` for every option.
