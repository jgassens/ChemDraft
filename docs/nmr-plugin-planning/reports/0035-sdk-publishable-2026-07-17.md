# Report 0035 — M40: the SDK is publishable (two self-contained bundled packages)

- **Assignment:** `prompts/09-sdk-publishable.md`; Phase 2 of `PLAN-plugin-separation.md`; **ADR-0031**
- **Worktree:** `~/Documents/programming/chemdraw-plugin-union`, branch **`sdk-publish`** off `main` @ `1a0467b5`; **commit `60856d4b`** (12 files, +492/−23). **Not pushed.** Build stamp `7.17.15.40-opus`.
- **Execution note:** the dispatched agent authored the config + build script but stalled repeatedly on an environmental storm (iCloud sync on `~/Documents` timing out reads; `pnpm install` not finishing). The **control room drove the build, pack, external-consumer gate, regression, and commit directly** once the filesystem calmed — so everything below was run and verified firsthand, not relayed.

## Outcome headline

`@chemdraft/plugin-api` and `@chemdraft/plugin-host` are now **self-contained, publishable npm packages**
(chem-core bundled into each, not published — preserving the ADR-0028 boundary), **proven installable
outside the monorepo**: an external project installing only the two packed tarballs (no `@chemdraft/chem-core`
present) typechecks a `PluginManifest`, a `PluginHost`, and an SDK-typed `ChemDraftDocument` with
`skipLibCheck: false`. The monorepo stayed green (lint clean; **1,641 tests | 9 skipped**, = the core-only
baseline). **No `npm publish` was run — that remains the owner's action.**

## The build (scripts/build-sdk.mjs)

tsup was the assignment's first choice but its `.d.ts` layer **crashes on Node v26.3.0**
(`renderChunk` TypeError) — isolated to the dts phase; esbuild bundles the JS fine on this Node. So the
build was split across the two tools the repo already trusts:
- **esbuild** bundles the runtime JS.
- **rollup + rollup-plugin-dts** bundle the `.d.ts`, inlining chem-core's types.

| Package | JS externals | chem-core handling | Built JS imports | Built `.d.ts` |
|---|---|---|---|---|
| `plugin-api` | `zod` | type-only → esbuild erases it; dts inlines `ChemDraftDocument`/`DocumentPatch` | **`zod` only** | self-contained (660 KB — the full inlined document type surface) |
| `plugin-host` | `@chemdraft/plugin-api`, `zod` | runtime (`applyPatch`) bundled via esbuild alias to source; canonical `ChemDraftDocument` **taken from `@chemdraft/plugin-api`** (source edit) | **`@chemdraft/plugin-api` + `zod`** | self-contained; document type comes from the SDK peer |

**Proof the dist carries no chem-core:** `grep -rE "(import|require|from).*@chemdraft/chem-core"` over
both `dist/` = **zero**. The only `chem-core` strings in `plugin-host/dist/index.js` are esbuild's inert
source-path comments (`// packages/chem-core/src/schemas.ts`); both `.d.ts` files have **0** chem-core
references.

**Build entry point:** root **`pnpm build:sdk`** (`node scripts/build-sdk.mjs plugin-api && … plugin-host`)
— verified working end-to-end. Caveat (Node 26): the per-package `pnpm --filter <pkg> build` crashes with
`ERR_INVALID_PACKAGE_CONFIG` when the script is invoked from the package directory; **build from root.**

## Publishable manifests (packed, resolved)

`pnpm pack` output — the tarball `package.json` as it would publish:

- **`@chemdraft/plugin-api@0.1.0`** — `dependencies: {"zod":"^3.25.76"}`; `files:["dist","LICENSE"]`;
  `main/types → ./dist/index.js / ./dist/index.d.ts`; MIT; `private` removed; `publishConfig.access public`.
- **`@chemdraft/plugin-host@0.1.0`** — `dependencies: {"zod":"^3.25.76","@chemdraft/plugin-api":"^0.1.0"}`
  (the `workspace:^` correctly rewritten to `^0.1.0` by pnpm; **no `@chemdraft/chem-core`**); same file/exports
  shape; MIT. Version bumped 0.0.0 → 0.1.0 to match `PluginApiVersion`.

## The gate — installability proven WITHOUT publishing

In a fresh dir **outside the repo** (`scratchpad/sdk-consumer-test`), `package.json` depending on both via
`file:` tarballs + `typescript`:

- `npm install` → **`added 4 packages`**; `node_modules/@chemdraft/` contains **only `plugin-api` and
  `plugin-host`** — no chem-core, nothing else fetched.
- `tsc --noEmit` (`strict`, `moduleResolution: bundler`, `lib: es2022`, **`skipLibCheck: false`** so both
  shipped `.d.ts` are fully checked) on a file that: imports `{ validatePluginManifest, PluginManifest,
  ChemDraftDocument }` from `@chemdraft/plugin-api`, constructs a `PluginHost` from `@chemdraft/plugin-host`,
  reads `doc.pages.length` off an SDK-typed `ChemDraftDocument`, and validates a full `PluginManifest` →
  **PASSED, 0 errors.** (An earlier run surfaced `Property 'entry' is missing` — the manifest type correctly
  rejecting an incomplete object, i.e. the type is real and enforced.)

## Internal resolution preserved (the load-bearing regression)

Repointing `exports` → `dist` affects only external consumers; the monorepo continues to resolve both
packages to `src`:
- `tsconfig.base.json` **already** has `paths` for `@chemdraft/plugin-api|plugin-host` → `src/index.ts`;
- `vitest.config.ts` aliases them to `src`;
- desktop `vite.config.ts` gained matching `src` aliases (added for M40, commented to ADR-0031).
- **Proof it's dist-independent:** temporarily hiding both `dist/` dirs, **`pnpm lint` still passed** →
  tsc resolves to `src`, not the built output.

## Regression

- `pnpm lint` → clean (tsc, ~9s), including with dist absent.
- `pnpm test` → **1,641 passed | 9 skipped (1,650)** — identical to the core-only baseline; the plugin-host
  source edit (ChemDraftDocument from plugin-api) is behaviorally transparent.
- `pnpm build` (full tauri) → **exit 0**, `ChemDraft.app` + `ChemDraft_0.0.0_aarch64.dmg` bundled
  (confirmed after report drafting). Full regression green.

## What the OWNER runs to publish (documented, NOT executed)

Prerequisites the owner owns: an npm account with rights to the **`@chemdraft`** scope, `npm login`, and the
decision to publish publicly. Then, from the worktree root:

```
pnpm build:sdk
cd packages/plugin-api  && npm publish --access public
cd ../plugin-host       && npm publish --access public   # after plugin-api is live (host depends on ^0.1.0)
```

**Still the owner's decision (D-15 distribution follow-up):** whether the standalone plugin repo consumes
the SDK from **public npm** (the above) or from a **git/tarball dependency** (no npm org, nothing made
public). The readiness work is identical either way; only this final wiring differs. Recommendation deferred
to a short decision once Phases 6–7 begin.

## Deviations

1. **tsup → esbuild + rollup-plugin-dts** (Node-26 crash) — the assignment allowed this ("a working
   self-contained build is the goal, not tsup").
2. **Added a root `build:sdk` script** because `pnpm --filter build` crashes on Node 26; the per-package
   `build` scripts remain but are documented as root-invoked.
3. **The agent stalled on the environment; the control room finished execution directly** — the deliverable
   and every check are firsthand-verified.

## Risks / open items

- **R-fs:** the `~/Documents` iCloud sync intermittently stalls git/pnpm; retry-on-timeout is the standing
  workaround. Not a code issue.
- **R-build:** the full tauri regression build was in progress at report time — confirm green before
  promoting `sdk-publish`.
- The 660 KB `plugin-api` `.d.ts` is large (the whole inlined document type surface). Correct, but heavy;
  acceptable for a types-only artifact.
- Per-package `pnpm --filter build` is broken on Node 26 (root `build:sdk` is the supported path).

## Next

Phases 6–7 of `PLAN-plugin-separation`: create the standalone plugin repo (`git subtree split` from
`codex/nmr-plugin` for full history), wire it to the SDK (npm or git/tarball per the D-15 follow-up), and
ship its first release zip. Before that: the owner's `npm publish` (if the npm route is chosen) and the
`sdk-publish` → `main` promotion once the tauri build confirms green.
