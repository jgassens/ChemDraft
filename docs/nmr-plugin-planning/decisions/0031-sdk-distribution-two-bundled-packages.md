# ADR-0031: The SDK ships as two self-contained bundled packages; chem-core is not published

- **Status:** accepted (2026-07-17)
- **Source:** Phase 2 of `PLAN-plugin-separation.md` (owner-approved), executed after `core-only` was promoted to `main`.
- **Builds on / preserves:** ADR-0028 (single-package SDK boundary — a plugin imports only `@chemdraft/plugin-api`), D-15 (the SDK packages are MIT).

## Context

For a standalone plugin repository to build outside the monorepo, the SDK it compiles against must be
installable outside the monorepo. Today `@chemdraft/plugin-api` and `@chemdraft/plugin-host` are
`"private": true`, export raw `./src/index.ts` (no build), and depend on a third internal package,
`@chemdraft/chem-core`, via `workspace:*`. An external `npm install` would therefore demand an
unpublished dependency and there is nothing compiled to consume.

Investigation of the coupling (2026-07-17):

- **`plugin-api` → chem-core is type-only** — `import type` / `export type` of `ChemDraftDocument` and
  `DocumentPatch` (the document types its own signatures reference). Its runtime JS carries no chem-core.
- **`plugin-host` → chem-core is runtime** — it calls `applyPatch()` to commit an accepted proposed
  patch, plus type-only `ChemDraftDocument` / `ApplyPatchOptions`.
- `chem-core` is small (12 non-test files; only dependency is `zod`).
- The monorepo resolves every `@chemdraft/*` specifier through **explicit `src` aliases** in
  `vitest.config.ts` and the desktop `vite.config.ts`, **not** through the packages' `exports` field.

Two distribution shapes were live: **(A) publish three packages** (api, host, core), or **(B) publish
two self-contained packages** with chem-core bundled into each.

## Decision

1. **The published SDK is exactly two packages: `@chemdraft/plugin-api` and `@chemdraft/plugin-host`.
   `@chemdraft/chem-core` is NOT published.** Publishing chem-core would expose internal API surface and
   invite plugins to import it directly, breaking the ADR-0028 boundary that a plugin imports only
   `@chemdraft/plugin-api`. Bundling keeps the published surface to exactly the SDK.
2. **Each package gets a bundling build** (ESM JS + bundled `.d.ts`) that inlines chem-core:
   - `plugin-api`: type-only use → the built `.d.ts` inlines `ChemDraftDocument` / `DocumentPatch`; the
     built JS has no chem-core reference. Its only external runtime dependency is `zod`.
   - `plugin-host`: bundles the chem-core **runtime** it calls (`applyPatch` et al.); takes the shared
     **types** from its `@chemdraft/plugin-api` dependency (the single canonical `ChemDraftDocument`), so
     a consumer using both packages sees one document type, not two structurally-identical copies. Its
     external dependencies are `@chemdraft/plugin-api` (`^0.1.0`) and `zod`.
3. **Internal consumption stays on source.** The monorepo continues to resolve these packages to
   `src/index.ts` via the existing aliases; only *external* consumers get `dist`. Repointing `exports`
   at `dist` must keep the full internal suite and the desktop build green — the aliases make this
   possible.
4. **Both versioned at `0.1.0`** (matching `PluginApiVersion`), MIT-licensed (LICENSE + `license`
   field, D-15), `"private"` removed, `publishConfig.access = "public"`.
5. **Readiness is proven with `npm pack`, not `npm publish`.** The gate is: a scratch project outside
   the monorepo installs the packed tarballs (with `workspace:*` resolved by pnpm) and typechecks
   `import { PluginManifest } from "@chemdraft/plugin-api"` + a `PluginHost` construction, with no other
   `@chemdraft/*` present. **The actual publish is the owner's action** (it needs their npm org and a
   make-public decision) — exactly as the license choice and the promote-to-main were.

## Consequences

- A standalone plugin repo can depend on `@chemdraft/plugin-api@^0.1.0` (+ host as a dev-dependency for
  manifest tests) and build with no monorepo.
- The ADR-0028 boundary is preserved and now enforced by distribution: chem-core is simply not available
  to install.
- A build step and a bundler devDependency enter the repo for the first time; the alias-based internal
  resolution means the 1,641-test suite and desktop build are unaffected — but that is the load-bearing
  thing to verify, not assume.
- Publishing to public npm remains an optional owner action. **The D-15 distribution follow-up is
  RESOLVED (owner, 2026-07-17): the standalone plugin repo consumes the SDK via *vendored tarballs*
  (`file:` deps), not public npm** — self-contained, no npm org, nothing made public; a one-line swap to
  `^0.1.0` if the SDK is ever published. This decouples the standalone repo (Phases 6–7, prompts/10)
  from any publish step.
- If chem-core's own API is ever wanted publicly on its own merits, this ADR is revisited — but not to
  serve the plugin SDK.
