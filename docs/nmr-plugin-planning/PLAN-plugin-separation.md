# PLAN — Separate the NMR plugin into its own project

**Status:** approved by owner 2026-07-16 (D-15 MIT per-package, D-16 keep mass-fragment, D-17 publish the
packaging CLI) — **but Phase 1 is ON HOLD as written.** Pre-flight for the merge discovered that
ChemDraft main **independently built its own plugin runtime** (`e04734ea` "Phase 2: real plugin runtime,
toolbar catalog, and fixture plugin"; `611f63f8` "Phase 3: wire selection, storage, panels, and patch
review") in the same `apps/desktop/src/plugins/` directory ours lives in — same `DesktopPluginRuntime`
name, same `PluginHost` underneath, different panel model (separate native window vs our in-app surface).
`plugin-api`/`plugin-host` are untouched on main, so the shared contracts held. The study is **complete
and verified** (reports/0032), and the owner decided both open questions (ADR-0030): **trunk = main,
plugin architecture = ours** (main's four plugin pieces port onto our runtime), and **panels unify NOW**
(one renderer serving the in-app surface and main's floating windows — the owner chose the study's
Option C at merge time, over its A-then-C recommendation). **Phase 1 is now executing as M38** in
worktree `chemdraw-plugin-union`, branch `merge/plugin-union` (prompts/07); NMR stays bundled through
this merge as the safety net. Phases 2–7 unchanged and follow it.
**Date:** 2026-07-16
**Owner decisions required:** D-15 ✅ (MIT the SDK packages), D-16 ✅ (keep mass-fragment), D-17 ✅
(publish the packaging CLI), panel model ✅ (unify now), merge base ✅ (main trunk / our plugins).

---

## 1. The goal, in your words

> The NMR plugin needs to live in its own repo, its own directory, have its own git. A standalone
> project. That project releases a zip; source lives on its `main`. It has a branch holding a cloned
> ChemDraft with the plugin installed and functional — re-cloned whenever ChemDraft's main updates, and
> where refinement and testing happen. Merges from that branch carry **only** the plugin's changes.

Plus the test you described: a ChemDraft that has never heard of the NMR plugin installs it from a zip,
every NMR function works exactly as it does on `codex/nmr-plugin`, then uninstalls cleanly.

## 2. End state

**Repo A — ChemDraft** (`github.com/jgassens/ChemDraft`, existing)

- `main` gains the **plugin system**: the worker boundary (M34), the built-package loader (M35), the
  installer UI + Rust serving hook (M36), on top of the existing manager (M32).
- `main` does **not** bundle the NMR plugin. It has no knowledge of it at build time or runtime.
- `packages/plugin-api` (and `plugin-host`) are **published** so anything outside the monorepo can build
  against them.

**Repo B — the NMR plugin** (new; name your call, e.g. `chemdraft-nmr-plugin`)

- `main` = the plugin **source**, standalone: `src/`, the reference database, `scripts/build-database.ts`,
  `README`, `LICENSE` (MIT), `THIRD_PARTY_NOTICES.md`, `NMRSHIFTDB2_LICENSE.md`. Depends on the
  **published** `@chemdraft/plugin-api`, not a workspace link.
- **Releases** = `nmr-predictor-<version>.zip` + `.sha256` on GitHub Releases.
- `host` branch = a clone of ChemDraft's main with the plugin mounted at
  `examples/plugins/nmr-predictor/`. Where you develop and test. Refreshed when ChemDraft main moves.
- Plugin changes flow `host` → `main` via **`git subtree split`**, which carries only the plugin's paths
  and history. See §6.

## 3. Three things must become true first

Your model is sound, but it rests on three things that are not true today.

### 3.1 The SDK is not published — this is the keystone

The plugin's only ChemDraft dependency is `@chemdraft/plugin-api` (ADR-0028's single-package boundary).
That package exists **only inside the monorepo** as `workspace:*`. A standalone repo has nothing to
compile against. This is the real reason a "branch with a clone of the master program" felt necessary —
the host clone is what supplies the SDK.

Publishing it inverts that: `main` builds on its own, and the `host` branch becomes a *testing
convenience* rather than a *build requirement*.

**But publishing requires licensing it — and that is a new decision (D-15).** `packages/plugin-api`
currently falls under the root, which is `UNLICENSED` / "not finalized". You cannot meaningfully publish
an SDK nobody is licensed to use.

Note the plugin's tests import `@chemdraft/plugin-host` too (`manifest.test.ts` constructs a real
`PluginHost`), so **both** packages need publishing: `plugin-api` as a dependency, `plugin-host` as a
dev-dependency.

### 3.2 ChemDraft's main cannot install anything yet

The entire plugin system is still on `codex/nmr-plugin`. Until it lands in main, there is no host for
your zip. This is **core** work, not plugin work, and it is a separate workstream from Repo B.

### 3.3 The zip builder lives in the monorepo

`pnpm plugin:package` is `tools/plugin-package/` inside ChemDraft. A standalone plugin repo has no way to
build its own release. That's **D-17**.

## 4. Sequence

Each phase has a gate. Nothing proceeds past a red gate.

### Phase 0 — Decide (you)

**D-15** (blocking), **D-16**, **D-17**. See §7.

### Phase 1 — Reconcile the drift, *while NMR still exists to catch a bad merge*

ChemDraft main is **78 commits ahead** of where we branched (`64cf513e` → `a3c77356`); we are **42
commits ahead** on our side. That divergence has to be resolved regardless of everything else.

Merge `origin/main` into `codex/nmr-plugin`. Get all **1,590 tests green**.

> **Why this order matters:** doing the reconciliation *before* stripping NMR means the NMR test suite is
> still there to prove the merge didn't break the predictor. Reconcile on a branch with no NMR and you've
> deleted your own safety net. Expect the pain in `MainWindow.tsx` (~23,500 lines, 78 commits of drift).

**Gate:** 1,590 tests green, lint + `tauri build` clean, an NMR prediction still runs.

### Phase 2 — Publish the SDK

Version `@chemdraft/plugin-api` and `@chemdraft/plugin-host` at **0.1.0** (matching the existing
`PluginApiVersion`), add per-package `LICENSE` + `license` fields per D-15, publish.

**Gate:** a scratch project outside the monorepo can `npm install @chemdraft/plugin-api` and typecheck an
import of `PluginManifest`.

### Phase 3 — Build the core-only ChemDraft (your "TestBranch")

From the reconciled branch, remove the NMR plugin: its package, its registration in
`registerBundledPlugins.ts`, the desktop's workspace dependency, its static worker entry, its tests.

**Prove the removal rather than assume it** — the test is worthless if a trace remains:
- `registerBundledPlugins.ts` contains no NMR reference;
- no `@chemdraft/plugin-nmr-predictor` in any `package.json`;
- the **built bundle** contains no `nmrWorker-*` / `OclHosePredictor-*` chunk and no 6 MB database;
- the app builds, runs, and its Analyze menu has no NMR entries.

**Gate:** a ChemDraft that demonstrably knows nothing about NMR, and still builds and runs.

### Phase 4 — THE TEST (your acceptance criterion)

Build the app from Phase 3. Then, **by hand, in the running app**:

1. Plugins ▸ Add or Remove Plugins ▸ **Add plugin from package…** → pick `nmr-predictor-0.0.0.zip`.
2. Confirm the review step shows the real name, version, description, and declared permissions.
3. Install. The Analyze menu gains **Predict ¹³C** and **Predict ¹H (experimental)**.
4. **Every NMR function works exactly as on `codex/nmr-plugin`:** ¹³C and ¹H prediction; the
   stick-spectrum + linked figure; hover cross-highlight; confidence tiers; the increment second opinion;
   Run again; the field selector; Copy PNG/SVG; Export JCAMP-DX; the staleness banner; panel-close
   cancellation.
5. **Uninstall.** Menu entries vanish; the staged directory is deleted; the install record is gone;
   nothing lingers; the app still works normally; a restart is still clean.

This also closes the **one open gap from M36** — the end-to-end GUI click-through nobody has driven
(computer-use access was denied twice). If you'd rather not grant screen access, this is the run to do by
hand; it's the same clicks either way.

**Gate:** all of step 4 behaves identically to this branch, and step 5 leaves no trace.

### Phase 5 — Merge core-only → ChemDraft `main`

Main now ships the plugin system and no NMR.

### Phase 6 — Create the plugin repo

**Seed `main` with real history, not a file copy:**

```
git subtree split --prefix=examples/plugins/nmr-predictor -b nmr-standalone   # on codex/nmr-plugin
```

That produces a branch with the plugin's files **at the root**, carrying only the plugin's own commits
(M6 → M35). Push it as the new repo's `main`. You keep the entire development history instead of a
"initial commit" that throws it away.

Then adapt `main` to standalone: `workspace:*` → `^0.1.0` published SDK; add the release build (D-17).

**Create the `host` branch:** clone ChemDraft main, `git subtree add --prefix=examples/plugins/nmr-predictor`
the plugin. Develop there; `git subtree split` + merge sends **only plugin changes** back to `main` — this
is the mechanism that makes your "merge ONLY the plugin's changes" rule actually work in git, rather than
fighting a plain merge that sees every ChemDraft file as an addition.

**Refresh procedure when ChemDraft main moves:** re-create `host` from the new ChemDraft main and re-add
the subtree. That's your "re-cloned whenever the primary program updates".

### Phase 7 — First release

Build the zip **from the plugin repo** (D-17), verify its `sourceCommit` provenance now points at the
plugin repo, and publish it to GitHub Releases with its `.sha256`. Re-run Phase 4's test against *that*
zip — the one built from the monorepo proved the mechanism; this proves the actual shipping artifact.

## 5. What ChemDraft main gains and loses

**Gains:** a real plugin system — install/uninstall from a zip, permissive (no consent gate, no signing),
with clean teardown.

**Loses:** bundled NMR. Users get it by installing the zip. That is your explicit intent, but state it
deliberately: anyone building ChemDraft from main gets no NMR until they install it.

## 6. The mechanism that makes your rule work

Plain `git merge` between `main` (plugin at root) and `host` (ChemDraft + plugin nested) never lines up —
the trees are disjoint, so git sees thousands of additions. **`git subtree split`** is the tool designed
for exactly this: it rewrites the nested subdirectory's history into a root-level branch. That branch
merges into `main` carrying only the plugin.

*A simpler alternative, if the `host` branch ever becomes a burden:* keep the plugin repo standalone and
keep an ordinary ChemDraft checkout beside it, linking the plugin in via pnpm during development. Same
result, no vendored host, nothing to re-clone. Once the SDK is published (Phase 2) this becomes viable —
but it's not what you asked for, so the plan above builds what you asked for.

## 7. Decisions required from you

| ID | Decision | Recommendation |
|----|----------|----------------|
| **D-15** | **License for `@chemdraft/plugin-api` + `@chemdraft/plugin-host`.** Publishing requires it, and the root repo is `UNLICENSED`. **Blocks the entire standalone plan.** | **MIT, per-package** — a `LICENSE` + `license` field in each of the two packages, leaving the root app `UNLICENSED`. Per-package licensing in a monorepo is normal. An SDK exists to be depended on; an unlicensed one is unusable. This does **not** commit the core app to anything. |
| **D-16** | Does ChemDraft main keep **mass-fragment** bundled? | **Yes.** It's the M19a proof the infrastructure is domain-agnostic, it gives the manager a non-empty list, and it keeps the bundled path exercised. Only NMR is under test. |
| **D-17** | How does the standalone plugin repo **build its zip**? `plugin:package` lives in the monorepo. | **Publish it as a small CLI** (e.g. `@chemdraft/plugin-tools`) — it already exists with 10 gate tests, and copying it into the plugin repo guarantees drift. Alternative: build releases from the `host` branch, which has the tool — cheaper now, but contradicts "main releases the zip". |

## 8. Risks and real costs

- **The 78/42-commit divergence is the biggest practical risk.** `MainWindow.tsx` is ~23,500 lines and
  main has had 78 commits of activity. Phase 1 is where this plan is most likely to hurt.
- **Publishing is close to irreversible.** npm unpublish is restricted after 72 hours. Get the name,
  version, and license right the first time.
- **Version discipline becomes real.** Today the API and its consumer are one tree, so a breaking change
  is free. Once `plugin-api@0.1.0` is published and the plugin pins `^0.1.0`, every breaking change needs
  a version bump and a coordinated release. This is the standing tax of separation — worth it, but real.
- **The reference database is ~6.4 MB of JSON** in the plugin repo. Fine, but it will dominate the repo
  and every clone. Consider git-lfs if it becomes annoying.
- **Provenance moves.** The zip's `sourceCommit` will point at the plugin repo, not ChemDraft. Correct,
  but the packaging tool's git-clean gate now applies to the plugin repo — commit before releasing.
- **The `host` branch has no automatic relationship to ChemDraft's history.** Re-cloning is manual, and
  the subtree boundary is a convention nothing enforces.
- **Still open, unrelated but adjacent:** the root repo is `UNLICENSED` while the app bundles the
  nmrshiftdb2-derived database, whose license (per the repo's own summary) requires prediction software
  to be OSI-licensed. Phase 3 *reduces* this exposure — main stops shipping the database entirely — which
  is a quiet side benefit worth noticing. It does not resolve the question for the plugin's own users.

## 9. What is NOT in this plan

- No change to the permissive posture (ADR-0029/D-12): no signing, no consent gate.
- No web install (D-13, dropped).
- No resolution of the root app's license.
- No relitigating D-14 (installed packages shadow bundled ids) — moot in Phase 4, since a core-only
  ChemDraft has no bundled NMR to shadow. It stays relevant only on `codex/nmr-plugin`.
