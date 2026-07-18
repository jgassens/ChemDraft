# Report 0027 — M33: plugin extraction architecture (boundary guard + zip + core-enablement patch)

**Date:** 2026-07-12
**Worktree:** `~/Documents/programming/chemdraw-nmr` @ `codex/nmr-plugin`
**Decision:** [ADR-0028](../decisions/0028-plugin-extraction-architecture.md)

## Milestone completed

M33 makes the NMR plugin genuinely separable. It delivers the machine-enforced plugin↔core boundary,
a tool that extracts a plugin into a standalone source-distribution zip, and the documented minimal
set of ChemDraft-core changes a host must merge to run it. This is the "extract the plugin + merge
ONLY the updated core parts" deliverable, scoped as the extraction model (not a runtime installer).

## Boundary audit (what made this cheap)

- The NMR plugin's runtime source imports **only `@chemdraft/plugin-api`** (11 sites; the lone
  `@chemdraft/plugin-host` reference is a test, and the `@chemdraft/plugin-nmr-predictor` hit was a
  doc comment, not an import). The mass-fragment plugin is equally clean.
- `plugin-api` pulls just two **type-only** interfaces from `chem-core` (`ChemDraftDocument`,
  `DocumentPatch`); `plugin-host → chem-core + plugin-api`. No plugin touches the other ~20 core
  packages.
- molscribe-ocsr is the one pre-SDK canary — it imports a chem-core type directly and is explicitly
  excluded from the extractable set.

## What shipped

- **SDK boundary tightened** — `@chemdraft/plugin-api` now re-exports `ChemDraftDocument` /
  `DocumentPatch`, so a plugin (and a host merging only the SDK) names them without importing
  chem-core. Compile-time guard test added.
- **Boundary guard** — `tools/plugin-extract/checkBoundary.ts` + `boundary.test.ts`: scans a plugin's
  runtime source (tests excluded), flags any `@chemdraft/*` import other than the SDK; asserts the
  extractable plugins are clean, is proven non-vacuous, and records the molscribe exception.
- **Extraction tool** — `tools/plugin-extract/extract.ts` (run via `npx tsx`): gates on the boundary,
  pins the SDK dep to `^PluginApiVersion`, drops other `@chemdraft/*` deps, keeps externals, copies
  runtime `src/` (no tests) + docs, writes `EXTRACTED.md` provenance, and zips. Refuses non-clean
  plugins.
- **Core-enablement patch** — `docs/plugin-architecture/CORE-ENABLEMENT.md`: the exact SDK packages,
  desktop host-wiring files, menu + Rust bridge, and MainWindow call sites a host must merge, with the
  single integration point (`registerBundledPlugins`) called out.
- **Author guide** — `docs/plugin-architecture/AUTHORING.md`: the one import rule, package shape,
  manifest/registration, command handler + panel report kinds, and the extract command.

## Verification actually run

- `pnpm exec vitest run tools/plugin-extract/boundary.test.ts packages/plugin-api/src/index.test.ts` — **20 passed**.
- Real extraction: `npx tsx tools/plugin-extract/extract.ts examples/plugins/nmr-predictor` → produced
  `dist/plugins/nmr-predictor-0.0.0.zip` (sha256 recorded), boundary reported clean, SDK pinned `^0.1.0`,
  source commit stamped. Zip contents verified: runtime `src/` + README + THIRD_PARTY_NOTICES +
  EXTRACTED.md + rewritten package.json (only `@chemdraft/plugin-api`, `openchemlib`, `zod`); **zero
  test files**.
- Gate proof: `extract.ts examples/plugins/molscribe-ocsr` **refused** with `src/index.ts imports
  @chemdraft/chem-core`, exit 1.
- `pnpm lint` clean; `pnpm test` **1,497 passed, 9 skipped** (+6 guard tests); desktop `vite build`
  green.

## Deliberately not done

- **No runtime dynamic loader.** The M32 "Add plugin from package…" control stays deferred; runtime
  loading of third-party code is a separate, larger (security-bearing) decision.
- **SDK not published.** The extracted package pins `^0.1.0`; a host supplies the SDK via the
  core-enablement merge. Publishing `plugin-api`/`plugin-host` to a registry is the follow-up if
  third-party distribution is pursued.
- The `dist/plugins/*.zip` artifact is generated on demand and gitignored — not committed.

## Next milestone

None queued. Natural follow-ups: publish the SDK packages (enables real external installs), or take on
the runtime dynamic loader if plugins should install without a host rebuild.

## Addendum (2026-07-15) — M33 hardening, worktree commit `420f438a`

A continuation pass (build stamp `7.13.09.27-codex`) closed three real gaps the original regex-based
boundary guard had, and made the extraction tool fail closed instead of best-effort:

- **`checkBoundary.ts` now parses real TS/TSX syntax** (`ts.createSourceFile` + AST visitor) instead
  of regex-matching quoted strings. This closes three holes the original guard missed entirely:
  (1) **`@chemdraft/*` subpaths** — `"@chemdraft/plugin-api/internal"` didn't match the old regex's
  `[a-z0-9-]+` boundary at all, so a plugin could reach non-public internals through a subpath and the
  guard would report it clean; (2) **computed/dynamic imports** — `import(someVariable)` or
  string-built specifiers were invisible to regex entirely; now any non-literal dynamic
  `import()`/`require()` argument is treated as unprovable and rejected outright; (3) **relative-path
  escapes** — a plugin could `import "../../packages/plugin-host/src/index"` and the old guard, which
  only looked for `@chemdraft/` tokens, would never see it. All three are now rejected, verified by
  `boundary.test.ts` with real fixtures for each (including `require()`, `import X = require()`, and
  export-from forms).
- **`extract.ts` refactored into a tested library** (`extractPlugin`/`parseCliArgs`) with a thin CLI
  entry that only runs on direct invocation, and now fails closed on: a dirty/untracked plugin git
  tree (so `sourceCommit` provenance is never misleading), a missing `LICENSE`/`LICENSE.md`, and an
  output path that would collide with the plugin directory. It also writes a `.zip.sha256` checksum
  sidecar file (not just a printed digest) and correctly strips `@chemdraft/*` from
  `optionalDependencies`, not just `dependencies`.
- **`extract.test.ts` (new)** adds real integration coverage: isolated temp git repos, actual
  `unzip -Z1`/`unzip -t` verification of archive contents and integrity, and a negative test per
  fail-closed path.
- **License status corrected.** `examples/plugins/nmr-predictor/README.md`/`THIRD_PARTY_NOTICES.md`
  previously stated "the plugin code is MIT/open-source" — but MIT was never actually applied to the
  repository. A new `LICENSE` file states plainly that code-redistribution terms are not yet
  finalized; the extraction tool now requires this file to exist (any statement) before it will
  produce an archive, so the zip is honest about its own terms rather than silently implying an
  unapplied license. **This is now tracked as STATUS D-11 — an open decision for the project owner.**
  Third-party dependency licenses and the NMRShiftDB2 data license (ADR-0014) are unaffected.
- `plugin-api` version bumped `0.0.0` → `0.1.0` to match the already-advertised `PluginApiVersion`
  constant, pinned together by a new test.

**Verified independently** (not just re-running the prior claims): full lint/test/cargo/build all
green (**1,509 tests**, +12 from this pass); ran the real extraction via the new `pnpm plugin:extract`
command against the actual `nmr-predictor` plugin at commit `420f438a` (not a fixture) — produced a
zip whose sha256 sidecar verifies via `shasum -a 256 -c`, contains the `LICENSE` file, and whose
`chemdraftPlugin.sourceTree` correctly reads `"clean"`.

**Still open:** D-11 (license choice) is the one item that needs the project owner rather than an
agent. No other milestone is queued.
