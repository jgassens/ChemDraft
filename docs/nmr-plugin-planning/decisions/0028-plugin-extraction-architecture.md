# ADR-0028: Plugin extraction architecture — single-package SDK boundary, source-distribution zips, core-enablement patch

- **Status:** accepted (2026-07-12)
- **Source:** user-directed — "extract the plugin as a zip and merge ONLY the ChemDraft parts updated to enable it"
- **Builds on:** M32 (the plugin manager UI), ADR-0016 (native-menu bridge), ADR-0019 (lossless molfile boundary)

## Context

ChemDraft's plugins live in the monorepo and are compiled into the desktop bundle. The stated goal is
to make a plugin genuinely separable: ship it as a standalone artifact, and merge back into a host
only the minimal ChemDraft-core changes that enable it. A boundary audit found this is already very
close to true — the NMR plugin's runtime source imports **only `@chemdraft/plugin-api`** (the mass
plugin too); `plugin-api` pulls just two type-only interfaces from `chem-core`.

Two extraction models were possible: a runtime dynamic loader (install a plugin package at runtime)
or a source-distribution + build-time composition model. A runtime loader is a large, security-heavy
lift (loading third-party code into the webview, shipping the ~7.5 MB OCL worker as an external
asset, load-time permission enforcement) and was explicitly deferred by M32's honest stub. The user
chose the extraction model.

## Decision

1. **The plugin SDK is exactly one package: `@chemdraft/plugin-api`.** An extractable plugin's runtime
   source may import only the SDK plus ordinary npm packages — never any other `@chemdraft/*`. The SDK
   re-exports the chem-core document types its own signatures reference (`ChemDraftDocument`,
   `DocumentPatch`) so a plugin never reaches into core to name them.
2. **The boundary is machine-enforced.** `tools/plugin-extract/checkBoundary.ts` scans a plugin's
   runtime source (tests excluded) for `@chemdraft/*` specifiers; `boundary.test.ts` asserts the
   extractable plugins (`nmr-predictor`, `mass-fragment-demo`) are clean and is proven non-vacuous.
   The extraction tool refuses to package a plugin that violates it.
3. **Extraction is a source-distribution zip**, not a prebuilt bundle — because ChemDraft consumes
   plugins as TypeScript (the host's bundler transpiles them). The zip carries the plugin's runtime
   `src/`, a package.json whose only `@chemdraft/*` dependency is the pinned SDK (`^PluginApiVersion`),
   its docs, and an `EXTRACTED.md` recording source commit + SDK version.
4. **The core-enablement surface is documented, not guessed** (`docs/plugin-architecture/CORE-ENABLEMENT.md`):
   the exact packages (`plugin-api`, `plugin-host`, the two chem-core types) and desktop host-wiring
   files a host must merge, plus the single integration point (`registerBundledPlugins`) a host edits
   to add a plugin. None of the other ~20 core packages are on the plugin path.
5. **molscribe-ocsr is an explicit non-extractable exception.** It predates the SDK and imports a
   chem-core type directly; the guard documents this and trips if it changes.

## Consequences

- The NMR plugin can be handed off as `nmr-predictor-<version>.zip` today, and a host knows precisely
  what to merge to run it.
- The boundary can never silently rot: adding a stray core import to an extractable plugin fails CI.
- This is not a runtime installer. The M32 "Add plugin from package…" control stays deferred; runtime
  dynamic loading remains a separate, larger decision if ever wanted.
- The SDK is not yet published to a public registry; the extracted package pins `^0.1.0` and a host
  supplies the SDK via the core-enablement merge. Publishing `plugin-api`/`plugin-host` is the natural
  follow-up if third-party distribution is pursued.
