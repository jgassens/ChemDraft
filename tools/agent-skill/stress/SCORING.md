# ChemDraft agent-skill stress test: scoring rules

Fixed 2026-10-22, before the baseline run (AGENTS.md §8: abstention and scoring rules are written
before the set that judges them is opened). Changing a rule after a run voids comparisons with that
run; a changed rule gets a new `SCORING_VERSION` and both versions are reported.

SCORING_VERSION = 1

## Splits

`cases.json` marks every case `dev` or `heldout` (about one third held out, chosen per category).
Held-out cases are scored only at baseline and at the final re-test. Nobody fixing the skill, CLI or
MCP reads held-out prompts, outputs or scores in between. Every report gives dev and held-out
separately, per category. There is never one overall percentage.

## What is graded

For each case the runner keeps: the agent's final message, every tool call and tool result (from the
stream-json transcript), every image the tools returned (PNG/SVG saved to disk), and every file the
agent wrote into its working folder. "Drawn structures" are the SMILES the agent passed to a
ChemDraft drawing call (render_structure, render_grid, render_reaction, build_document,
render_document, export_structure, or the CLI equivalents), plus SMILES recovered from native
document JSON it produced.

## Automatic checks (A)

Each applicable check is pass/fail. Only checks a case's `expect` block asks for apply.

- **A1 structure** — some drawn structure equals the reference by canonical isomeric SMILES
  (canonicalised by ChemDraft's own RDKit path, both sides). `relative: true` references also
  accept the enantiomer (relative stereo is what is asked). `constitution` mode compares without
  stereo. `optional: true` structures are not required to be drawn.
- **A2 set** — `set_match`: the drawn set equals the reference set (no missing, no extra
  duplicates; decoys allowed only where `set_contains`). `set_contains`: every reference present.
- **A3 stereo complete** — `full_stereo`: on every structure that passes A1/A2, no more
  unspecified stereocentres and unspecified stereo double bonds (ChemDraft `stereo` counts) than the
  reference itself has in `references.lock.json`. Normally that is zero. The exception is a centre the
  ring system fixes but the stereo engine still counts as unspecified: the bridgehead N in quinine
  (N07) and in penicillin G (N08). (Added before the baseline, 2026-10-22, after reference
  verification found it.)
- **A4 answer text** — every `answer_regex` matches the final message; no `answer_forbid_regex`
  matches.
- **A5 reaction** — for `reaction` expectations: a reaction scheme was rendered whose reactants and
  products include the references (canonical SMILES; `products_any_of` accepts any listed), the
  intermediates appear where listed, and every `conditions_regex` matches the scheme's condition
  text.
- **A6 style consistency** — for `style_consistency`: across all structure images delivered for the
  case, the median bond length differs by at most 5% and the bond stroke width by at most 5%
  (measured from SVG; for PNG-only output, from the matching SVG re-rendered with the same options,
  or marked `unmeasurable`, which counts as a fail and is reported separately).
- **A7 value match** — `cli_value_match`: numbers in the final message agree with ChemDraft's own
  `analyze` output within the tolerance.
- **A8 tool use** — the agent reached ChemDraft (at least one ChemDraft MCP tool or CLI call). A
  case with no ChemDraft call fails A8 and every structure check.

Cases whose `expect` has `mechanism: true` (R04, R05, R07, R12) or `answer_key: true` (D02, the key part) are judged by the visual check only; their automatic result is A8 plus any other listed check.

A case's automatic result is PASS when every applicable A check passes.

## Visual check (V)

A model that did not produce the outputs (Kimi K3; Fable if Kimi is unavailable) looks at every
image for the case and the final message and marks each rubric line met / not met / cannot tell,
then gives one verdict: **would a chemistry instructor accept this figure as delivered** (accept /
reject), with a one-line reason. The visual grader also reads the agent's final message so it can
see claims the picture should back up. It is told the reference SMILES and the rubric, never the
automatic result.

`drawing_kind` cases (chair, Newman, Fischer, Haworth) are judged on the kind asked for. A flat
skeletal drawing in place of a chair/Newman/Fischer/Haworth fails the case, even when its chemistry
is right.

## Case result

- **pass** — automatic PASS (or no automatic checks apply) and visual accept.
- **honest decline** — the agent said plainly that ChemDraft cannot do the thing asked (for example
  "ChemDraft cannot draw a Newman projection"), did not fake it, and delivered nothing wrong. Counts
  as not passed, reported in its own column: it is better than a wrong answer and points at a gap.
- **fail** — everything else. A fail that presents wrong chemistry as right (wrong configuration,
  wrong structure, an invented number) is also flagged **wrong-and-confident**, reported as its own
  count; these are the worst failures.

## Per-category report

For each category and each split: number of cases, pass, honest decline, fail, wrong-and-confident,
and the pass rate of each A check and of V. Wilson 95% intervals on pass rates, with n stated, since
the categories are small. One run per case (n = 1); say so with the numbers.

## Cause of each failure

The grader (and then the conductor) labels each non-pass with one primary cause:

- `skill-text` — the tools could do it; the skill did not tell the agent how or that it should.
- `cli-mcp-gap` — the drawing code exists in the app but the CLI/MCP cannot reach it (e.g. chair
  geometry in apps/desktop/src/documentWorkflow.ts).
- `drawing-code-missing` — no code anywhere in ChemDraft draws it (e.g. Newman, Fischer, Haworth).
- `tool-bug` — a ChemDraft tool returned a wrong or broken result.
- `agent-error` — the information and tools were there and the agent still got it wrong.
- `harness` — the runner or grader failed; the case is re-run, not scored.
