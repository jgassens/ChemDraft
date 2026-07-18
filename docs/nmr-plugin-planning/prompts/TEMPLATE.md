# Assignment NN: <imperative title>

- **Status:** draft | ready to issue | issued | done
- **Milestones:** M_–M_ (canonical numbering in `PLANS.md` → "Implementation sequence")
- **Depends on:** report from assignment NN-1 (`reports/NNNN-*.md`)
- **Next assignment:** `prompts/NN+1-*.md`

Work in the ChemDraft repository worktree for this feature.

Read `AGENTS.md` and `PLANS.md` in full before editing. Follow them as
repository instructions.

Implement **Milestones M_–M_ only**:

1. <milestone summary>
2. <milestone summary>

Do **not** implement <the tempting adjacent work this assignment must not
touch — name it explicitly; agents expand scope toward whatever is named
vaguely>.

## Objective

Prove this path in the running desktop and in tests:

```text
<input>
  -> <mechanism>
  -> <observable outcome>
```

## Verified repository state (re-verify cheaply; `main` may have moved)

<List every repository fact this assignment relies on, with file:line
evidence and the date/commit it was verified. Pull rows from STATUS.md's
assumption ledger; add new ones discovered while drafting. The agent
re-verifies each and reports drift.>

- <fact — evidence>

When an assumption is wrong, adapt to the actual repository and document the
discrepancy in the final report. Do not silently change the architecture.

## Required implementation

### 1. <step> (M_)

<Concrete, bounded instructions. Reference PLANS.md sections by heading
rather than restating them, except where the prompt must be self-contained.>

## Architectural constraints

- <boundary rules that apply to this assignment — copy the relevant subset
  from AGENTS.md so the prompt stands alone>
- Update the build stamp in `AGENTS.md` and `MainWindow.tsx` per repository convention.
- Do not commit or push unless explicitly instructed.

## Acceptance criteria

<Numbered, each independently checkable, each phrased as an observable
behavior — not "code exists" but "doing X produces Y". Include the relevant
acceptance-test numbers from PLANS.md.>

1. <criterion>

## Validation

Run the most targeted tests during development. Before reporting completion:

```bash
pnpm lint
pnpm test
pnpm build
```

Do not claim that a command passed unless it was actually run. Report
unavailable toolchains explicitly.

## Final report

Structure the report for verbatim archiving (it will be filed under
`reports/` in the planning workspace). Include:

- milestones completed;
- **assumption discrepancies**: verdict table for the "Verified repository
  state" items above (include even if empty);
- files changed;
- <assignment-specific report items>;
- tests and builds actually run, with outcomes;
- deviations from `PLANS.md` and why;
- unresolved risks;
- the next milestone, without implementing it.

Stop after Milestone M_. Do not begin the next assignment's work in the same
change set.
