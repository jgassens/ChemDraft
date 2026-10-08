---
name: chemdraft
description: Use ChemDraft to draw or show molecules; make structure images for documents, exams, slides and handouts, multiple-choice structure grids and reaction schemes; convert chemical names to structures; answer R/S and E/Z questions; compute molecular properties including formula, exact and average mass, m/z, isotope patterns, logP, TPSA, pKa and the property suite; predict NMR shifts; export CDXML, SDF, MOL, PDF and SMILES; and work with ChemDraft plugins. Never draw molecules by hand or quote chemistry numbers from memory.
---

# ChemDraft

## Two non-negotiables

1. Never hand-draw a molecule: no ASCII structure, hand-written SVG, HTML
   canvas, matplotlib, or ad-hoc RDKit/Python drawing script. Use ChemDraft's
   shared depiction and export path.
2. Never quote a chemistry number from memory when ChemDraft computes it.
   Obtain its result and report the method, units, interpretation and limits.

If ChemDraft is unreachable, say so and stop the chemistry drawing or
calculation. Do not replace it with a guessed structure or number.

## Reach ChemDraft

Use these routes in order.

### 1. MCP

Use tools from the `chemdraft` MCP server when present. MCP (Model Context
Protocol) lets the assistant call a local program through typed tools.
The registered names are:

- `render_structure`
- `render_grid`
- `render_reaction`
- `analyze_structure`
- `name_to_structure`
- `check_stereo`
- `predict_nmr`
- `export_structure`

Use the server's supplied input schemas. The result's first text block is
the JSON result; PNG images, SVG text and export resources follow it.
Check `isError` and the JSON `ok` field before using an output.
Each call gets a fresh output directory. Any returned payload is limited
to 5 MB; reduce image width if a visual payload is too large.
These tools create headless outputs; they do not edit the user's open canvas.

### 2. CLI

If MCP is absent and a local shell is available, locate the checkout from
this skill directory. A normal installation is a symlink from
`<checkout>/skills/chemdraft`. Resolve the directory's real path, then go
two levels up. Do not infer the checkout from the current working directory.

POSIX shell (macOS; select the installed Claude Code or Codex skill path):

```sh
skillDir="$HOME/.claude/skills/chemdraft"
checkout=$(node -p "require('node:path').resolve(require('node:fs').realpathSync(process.argv[1]), '..', '..')" "$skillDir")
[ -n "$checkout" ] || { echo "No ChemDraft checkout found from $skillDir" >&2; exit 1; }
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft --help
```

For Codex, set `skillDir="$HOME/.codex/skills/chemdraft"` instead.
If the assistant already knows the loaded skill's directory, use that path.

PowerShell (Windows; a directory junction also resolves to its target):

```powershell
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$skillDir = Join-Path $HOME '.codex/skills/chemdraft'
$checkout = node -p "require('node:path').resolve(require('node:fs').realpathSync(process.argv[1]), '..', '..')" $skillDir
if (-not $checkout) { throw "No ChemDraft checkout found from $skillDir" }
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft --help
```

For Claude Code, use `.claude/skills/chemdraft` in the first line.
If installed as a copy, the resolved directory is not the checkout. Use the
user's checkout path and confirm it with the same help command.

The check passes only if help lists all eight ChemDraft subcommands: render,
grid, reaction, analyze, name, stereo, nmr and export. pnpm's own help means
the checkout path is wrong. Shell state may reset between tool calls; set
variables and console encoding again in each call, or use literal paths.

The command form is `pnpm -s --config.shell-emulator=true --dir <checkout> chemdraft <subcommand>`.
Without this flag, pnpm on Windows doubles backslashes
in arguments, changing SMILES bond-direction marks and paths. Use the flag
on both platforms.
Replace placeholders with actual paths and quote paths containing spaces.
`-s` is mandatory: a pnpm script banner on stdout corrupts JSON Lines
and, when launching `chemdraft-mcp`, stdio MCP framing.
Run from either platform without requiring bash on Windows.

### 3. Neither route is available

Point the user to [setup](references/setup.md) and stop. Local setup and
MCP registration belong on the computer that will run ChemDraft.
Do not simulate a successful ChemDraft response.

## Choose the operation

| Need | CLI subcommand | MCP tool |
|---|---|---|
| One molecule image | `render` | `render_structure` |
| Multiple-choice structure grid | `grid` | `render_grid` |
| Reaction scheme | `reaction` | `render_reaction` |
| Properties, masses, pKa, isotope envelope | `analyze` | `analyze_structure` |
| Chemical name to structure | `name` | `name_to_structure` |
| R/S and E/Z assignments | `stereo` | `check_stereo` |
| Predicted ¹H/¹³C NMR shifts and spectra | `nmr` | `predict_nmr` |
| CDXML, PDF, SDF, MOL, SMILES files | `export` | `export_structure` |

## Core workflow

1. Decide what chemistry the user intends: compounds, charges, isotopes,
   stereochemistry and, for reactions, component roles. Preserve salts and
   counterions. A drawing instruction does not authorize changing chemistry.
2. Then obtain the SMILES, a text encoding of atoms and bonds. If only a
   chemical name is known, use `name` or `name_to_structure`. If conversion
   fails or is ambiguous, explain the failure and obtain a clearer name;
   never guess a replacement structure.
3. Read only the reference for the operation you need. Choose output paths
   outside the repository, in a scratch or user-chosen output directory.
   Run the command or tool with the confirmed input.
4. Read each JSON line. Require `ok: true`; examine `warnings` even on
   success. A batch can contain successful and failed jobs together.
   For depictions, inspect `stereoCenters`, `unspecifiedStereoCenters` and
   `unspecifiedDoubleBonds` wherever the result provides them.
5. Look at the rendered image at least once before placing it. Check atom
   labels, charges, bonds, wedge/hash bonds, clipping, grid labels and
   reaction roles. If the image viewer cannot display SVG, request PNG
   from ChemDraft for inspection.
6. Place the verified figure in the requested document. Keep its SMILES,
   relevant options and warnings alongside the document so it can be
   regenerated. Retain the answer key separately from student-facing art.

`@` and `@@` in SMILES depend on atom order; they are not literal R/S
labels. Use `stereo` to state R/S. For a question asserting a fully
specified stereoisomer, both unspecified counts must be zero. An exercise
explicitly asking about unspecified stereochemistry can retain it and
must say so. E/Z geometry is also checked through `stereo`.

## Report honestly

- Quote a number with the method, units and interval the result gives.
  Retain its interpretation label when it describes a derived structure.
  Read method metadata and conventions in `run.results` and engine versions
  in `run.engines`, not only `summary`; see [analysis](references/analysis.md).
- Report a declined value as **not computed**, with its reason. Never
  fill it from memory, another species, or a fallback calculation.
  Distinguish declined results from `not-requested` methods.
- Keep estimates labelled estimates, including NMR multiplicities and J
  couplings. Predicted shifts are predictions, not measurements.
- Refused radicals or isotopes remain refusals. Do not remove their SMILES
  notation to make a command succeed.
- The m/z table is exact-mass arithmetic, not fragmentation prediction;
  it gives no claim about observed ion intensity or whether a loss occurs.
- Isotope-envelope numbers need the IsoSpec abundance disclosure in
  [analysis](references/analysis.md) beside the numbers they qualify.

## Output contract

Normal CLI jobs emit JSON Lines on stdout: one complete JSON object per
line. Progress goes to stderr. Help output is human-readable, not JSON.
Do not combine stderr into a JSON parser's input.

Exit codes are 0 for all jobs successful, 1 for any attempted job failed,
and 2 for invalid arguments or batch input. `ok: true` for an analysis job
does not mean every method computed a value; inspect method statuses.

Keep chemical input within 5000 characters and 500 heavy atoms (atoms
other than hydrogen), and batches within 500 jobs. PNG widths must be
16–4000 pixels. Apply these limits yourself even where a particular
command path does not enforce every one of them.

Batch files are JSON arrays. Most jobs have `name` and `smiles`; name
conversion uses `name` and `query`, and reactions have role-specific
shapes. Names are trimmed and must match
`^[A-Za-z0-9][A-Za-z0-9 _-]{0,99}$`. They must be unique ignoring case.
No path separators, leading dot, blank name or unsafe output name is
allowed. See the relevant reference for combined versus per-job files.

## Read next

- [Setup](references/setup.md): installation, both platforms, skill and MCP registration, plugin trust.
- [Drawing](references/drawing.md): render/grid/reaction options, salts and stereo image checks.
- [Analysis](references/analysis.md): method IDs, statuses, interpretations, intervals and mass conventions.
- [NMR](references/nmr.md): predictor setup, spectra, omitted environments and experimental comparisons.
- [Files](references/files.md): OPSIN names, export formats and the human CDXML editing loop.
- [Plugins](references/plugins.md): official catalog, headless reach, permissions and plugin authoring.
- [Recipes](references/recipes.md): worked commands for exams, figures, properties and datasets.
