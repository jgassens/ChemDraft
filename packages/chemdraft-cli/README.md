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

Planned. This subcommand currently prints `not implemented yet` to stderr and exits 2.
