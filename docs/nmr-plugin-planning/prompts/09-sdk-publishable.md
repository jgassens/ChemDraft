# Assignment 09: Make the SDK publishable — two self-contained bundled packages

- **Status:** ready to issue
- **Milestones:** M40 (STATUS.md → "Milestones"); Phase 2 of `PLAN-plugin-separation.md`
- **Depends on:** ADR-0031 (two bundled packages, chem-core not published); ADR-0028 (SDK boundary); D-15 (SDK is MIT)
- **Next:** Phases 6–7 (the standalone plugin repo via subtree split) — do not start.

## Where you work

Worktree `~/Documents/programming/chemdraw-plugin-union`, currently on branch **`sdk-publish`** @
`1a0467b5` (= `origin/main`; verify). Commit on `sdk-publish` (no pushes). Do not touch `main`,
`core-only`, `merge/plugin-union`, or `codex/nmr-plugin`. Scratch consumer project goes in your
scratchpad, NOT in the repo.

## The goal

`@chemdraft/plugin-api` and `@chemdraft/plugin-host` become **publishable, self-contained npm packages**
(chem-core bundled in, per ADR-0031), **proven installable via `npm pack` into a project outside the
monorepo** — while the monorepo's own tests and desktop build stay green. **Do NOT run `npm publish`**
(that is the owner's action). Do NOT publish chem-core.

## Verified starting state (re-verify)

- `packages/plugin-api/package.json`: `private:true`, `version 0.1.0`, dep `@chemdraft/chem-core: workspace:*` + `zod`, `exports` → `./src/index.ts`.
- `packages/plugin-host/package.json`: `private:true`, **`version 0.0.0`**, deps `@chemdraft/chem-core` + `@chemdraft/plugin-api` (both `workspace:*`), `exports` → `./src/index.ts`.
- **plugin-api → chem-core is type-only** (`index.ts:1` `import type`, `:8` `export type` of `ChemDraftDocument`/`DocumentPatch`).
- **plugin-host → chem-core is runtime** (`index.ts:2` `import { applyPatch }`) plus type-only `ChemDraftDocument`/`ApplyPatchOptions`.
- `chem-core` = 12 non-test files, dep `zod` only.
- **No build tooling exists** (root devDeps: only `typescript`). No package has a `build` script.
- **Internal resolution is via `src` aliases** in `vitest.config.ts` (`workspacePackage("./packages/<pkg>/src/index.ts")`) — confirm the desktop `apps/desktop/vite.config.ts` aliases the same way. This is why repointing `exports` at `dist` can be safe. **Verify before relying on it**; if any internal consumer resolves `@chemdraft/plugin-api|host` through `exports` rather than an alias, add the alias or a source export condition so internal builds keep using `src`.
- Confirm `PluginApiVersion` in `packages/plugin-api/src/index.ts` — the published versions must match it (expected `0.1.0`).

## Required implementation

### 1. A bundling build for each package (M40)
Add a bundler (tsup recommended — ESM + `dts`; `noExternal`/bundle to inline chem-core) as a root
devDependency, and a `build` script per package. Match repo conventions if a different bundler is
already idiomatic.
- **plugin-api**: emit `dist/index.js` (ESM) + `dist/index.d.ts`. chem-core is type-only, so the `.d.ts`
  must inline `ChemDraftDocument`/`DocumentPatch` and the built JS must contain **no** `@chemdraft/*`
  import. Only external runtime dep: `zod`.
- **plugin-host**: bundle the chem-core **runtime** it calls; import the shared **types** from
  `@chemdraft/plugin-api` (single canonical `ChemDraftDocument`, not a second copy). Built output must
  import **only** `@chemdraft/plugin-api` and `zod` — no `@chemdraft/chem-core`.

### 2. Make both manifests publishable (M40)
Per ADR-0031: remove `"private"`; add MIT `LICENSE` file + `"license":"MIT"`; **plugin-host version →
`0.1.0`**; add `description`, `repository`, `files:["dist","LICENSE"]`, `publishConfig:{"access":"public"}`;
point `main`/`module`/`types`/`exports` at `dist`. Drop `@chemdraft/chem-core` from `dependencies`
(it's bundled). Keep `@chemdraft/plugin-api` as plugin-host's dependency using the workspace protocol
(`workspace:^` or `workspace:*`) so **pnpm rewrites it to `^0.1.0` on pack/publish** — do not hand-pin.

### 3. Keep internal consumption on source (M40)
The monorepo must still resolve these to `src` internally. If `exports`→`dist` would make any internal
tool load `dist`, prevent it (aliases already do this for vitest; ensure the desktop build too — add a
`development`/source export condition or an alias as needed). The 1,641-test suite and `tauri build`
must stay green.

### 4. Prove publishability without publishing (M40 — the gate)
- `pnpm --filter @chemdraft/plugin-api build` and `... plugin-host build` succeed.
- `pnpm pack` (or `npm pack`) each package → tarballs with `workspace:*` resolved to `^0.1.0` (inspect
  the packed `package.json` to confirm no `workspace:` and no `@chemdraft/chem-core` remain).
- In a **fresh scratch dir outside the repo** (your scratchpad): `npm init -y`, install BOTH tarballs,
  add `typescript`, and typecheck (`tsc --noEmit`) a file that does
  `import { PluginManifest, validatePluginManifest } from "@chemdraft/plugin-api"` and constructs a
  `PluginHost` from `@chemdraft/plugin-host`, using a value typed as the re-exported `ChemDraftDocument`
  across both. **No other `@chemdraft/*` package installed.** It must typecheck and resolve the inlined
  chem-core types. Record the exact commands + output.
- **Do NOT `npm publish`, `npm login`, or hit the network to publish.** `npm pack`/`tsc` are offline.

### 5. Regression (M40)
`pnpm lint`, `pnpm test`, `pnpm build` (full tauri) green on the monorepo after all changes. Report the
count vs the 1,641 baseline (it should be unchanged, or +N for any new build-smoke tests you add).

## Constraints
- Do NOT publish anything, or create/modify npm auth. Do NOT publish chem-core.
- Update the build stamp in `AGENTS.md` + `MainWindow.tsx`.
- Commit on `sdk-publish`; no pushes.

## Final report (archived verbatim as `reports/0035-sdk-publishable-*.md`)
Include: what changed per package (with the final published `package.json` shape and the packed
`package.json` proving `workspace:*`→`^0.1.0` and no chem-core); the bundler + config chosen and why;
proof the built JS/`.d.ts` carry no `@chemdraft/chem-core` (grep the dist); the **scratch-consumer gate**
transcript (commands + typecheck result); how internal `src` resolution was preserved and the evidence
the monorepo stayed green (lint/test/build with counts); the exact one-command `npm publish` steps the
owner will run (documented, not executed), and a note that the public-npm-vs-git/tarball distribution
choice remains the owner's (D-15 follow-up); deviations; risks; commits with hashes. Stop after M40.
