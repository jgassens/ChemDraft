# Stress grader (SCORING_VERSION 1)

Run from any directory with Node and an existing ChemDraft checkout's dependencies:

```sh
node tools/agent-skill/stress/grader/grade.mjs --cases cases.json --runs runs --checkout .
node tools/agent-skill/stress/grader/grade.mjs --cases cases.json --runs runs --ids S01 S02
node tools/agent-skill/stress/grader/report.mjs --cases cases.json --runs runs --visual visual.json
pnpm vitest run tools/agent-skill/stress/grader
```

`--checkout` defaults to this repository. `--ids` accepts space-separated or comma-separated ids.
Grade writes individual `grade/<id>.auto.json` files and `grade/auto.json`, whose `cases` array
contains the selected cases. Each entry has A1–A8 `{applies, pass, detail}`, `drawn` with source
locations, and `auto: "PASS" | "FAIL"`. Harness entries have `status: "harness"` and `auto: null`.
Both automatic output and the visual-pack manifest record each run's `meta.json` agent. Reports state
that agent and reject a selection that mixes agents.
Each invocation replaces the aggregate with its selected cases; old individual files are not
included in it. A report treats cases absent from the aggregate as unscored harness entries.

The grader installs the repository's existing tsx loaders and loads ChemDraft modules in-process.
It registers the Node RDKit adapter once, then keeps its engine cached throughout the grade.
Canonical SMILES use the CLI's `canonicalSmiles` helper; stereo uses the exact shared RDKit
depiction and stereo-perception/counting functions used by `stereo`. Analysis runs only requested
method ids and uses the CLI's summary conventions. Short case ids `logp` and `tpsa` map to
`rdkit.crippen-logp` and `rdkit.tpsa`.

Native documents are recovered from their live atom/bond graph using the shared strict
`moleculeSmiles` path, never a stale stored SMILES. Expired `render_document` paths can use the
tool result's reported canonical molecule identities. Horizontal native reaction schemes and
native reaction membership are supported; unsupported layouts cannot satisfy A5 automatically.
References are canonicalised through RDKit, including after tetrahedral inversion for relative
stereo; E/Z is retained. Constitution comparison removes stereo while retaining charge/isotopes.
Drawn occurrences retain multiplicity: repeated actual calls count repeatedly for `set_match`.
A3 compares each drawing's separate unspecified-centre and unspecified-double-bond counts with its
reference counts, using `tools/agent-skill/stress/references.lock.json` when present or the same
ChemDraft stereo path otherwise.
A builder's saved native output is not counted a second time merely because it is in `work/`.

Only retained run artifacts are read for document/batch paths. The grader never executes agent
shell text. Missing or ambiguous retained inputs, malformed run files, and grader errors are
harness failures. Failed tool calls and malformed agent inputs are ignored for
structure extraction and recorded in `extractionDetails` and check details, so
a corrected later call can pass. Engine crashes remain harness failures.

SVG measurements use ChemDraft's `data-bond-id` primary lines and straight paths, inherited stroke width,
and uniform transforms; they exclude arrows, text, effect copies, and hit targets. When the exporter
marks atom centers (including labeled-atom transforms), bond length is the median primary-bond
distance between those centers: visible ink is deliberately shortened at labels and for secondary
double-bond lines. Each molecule has its own median measurement, including inside grids. The largest-to-smallest ratio must be
at most 1.05 for both median bond length and stroke width. A PNG without a retained SVG sharing
its tool call index (from `assets.json`) or original basename is marked
unmeasurable (A6 fails, with a separate diagnostic). Matching retained basenames
remain supported for older runs. Curved bond paths,
non-uniform transforms, and drawings without measurable bond segments also fail as unmeasurable.

`visual-pack` contains prompts, named references (or source CID/notes when names were not supplied),
numbered rubrics, drawing kinds, all retained images, PNG previews made by the CLI's rasteriser,
and final messages verbatim. No automatic scores are supplied to the reviewer. A preview failure
is noted alongside the original SVG. Review the entire pack independently using `INSTRUCTIONS.md`.

`report.mjs` validates the review array and merges it with automatic results. Every category/split
has its own denominators and Wilson 95% intervals; harness cases are excluded, and no totals are
pooled. Non-passes retain one primary reviewer cause. Without `--visual`, counts are explicitly
provisional automatic-only, V is pending (n=0), and causes are provisional `agent-error` labels.
Wrong-and-confident and honest-decline classifications require independent visual judgment.
`report.md` includes only aggregate scores for held-out cases; their failure
details go to `report-heldout.md`, for the final adjudicator only. The complete
`report.json` has the same access restriction as the held-out detail report.

The tests generate synthetic runner-shaped folders with Claude and Codex runner shapes. Codex calls
come exclusively from `tool-calls.json`; its JSON event transcript is not Claude stream-json.
They also include a retained exact-stereo fixture. `fixtures/real-render.svg` was generated by
`pnpm -s chemdraft render --smiles CCC --out real-render.svg`; the alanine fixture used
`C[C@@H](N)C(=O)O`. In the restricted test host these commands ran equivalently through
`node --import tsx packages/chemdraft-cli/src/cli.ts render ...`, avoiding the tsx CLI's IPC socket.
