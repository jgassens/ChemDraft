# Report 0036 — M41+M42: the standalone NMR-plugin repo (delivered, self-building)

- **Assignment:** `prompts/10-standalone-plugin-repo.md`; Phases 6–7 of `PLAN-plugin-separation.md`
- **Repo:** `~/programming/chemdraft-nmr-plugin` (deliberately OFF the iCloud-synced `~/Documents`), initial commit **`38262c2`**. Not pushed.
- **Method note:** the history-preserving `git subtree split` stayed **FS-blocked** (iCloud disrupts git's pack mmap → SIGBUS on `~/Documents` repos), so the repo was **seeded clean-init from the current plugin source** (copied out of `codex/nmr-plugin` @ `125aebeb`). Full development history remains safe on `origin/codex/nmr-plugin` and can be grafted in later via subtree split once the source repo is off iCloud. All build work happened in `~/programming` (off iCloud), so the storm never touched it.

> **Control-room verification (independent, 2026-07-17):** confirmed directly — one clean commit
> `38262c2`, tree clean; `nmr-predictor-0.1.0.zip` present (3.6 MB) and its `.sha256` verifies `OK` via
> `shasum -c`; `package.json` deps are `@chemdraft/plugin-api: file:./vendor/…api-0.1.0.tgz` +
> `@chemdraft/plugin-host` (dev) `file:./vendor/…host-0.1.0.tgz`; the zip's `manifest.json` has the
> corrected M35 labeling (`NMRShiftDB2` present, **zero** "fixture/synthetic"), `sdkVersion 0.1.0`, and
> `sourceCommit 38262c2` = **the standalone repo's own commit** (the release is built from the plugin
> repo, not the monorepo); `node_modules/@chemdraft/` contains **only `plugin-api` + `plugin-host`** —
> no chem-core. The full install→build→package loop works with zero monorepo dependency.

## Outcome

Full success, self-build path achieved (the packaging-tool fallback was not needed — Vite bundled
cleanly). The repo installs from the two vendored SDK tarballs, **builds its own release zip** with the
vendored packaging tool, and is one clean commit.

## Layout (70 tracked files)

```
.gitignore  LICENSE  README.md  THIRD_PARTY_NOTICES.md  package.json  package-lock.json
src/ …  (application, domain, providers/{fixture,ocl}, report, worker, tests, manifest.ts,
         workerEntry.ts, index.ts, register.ts;  providers/ocl/NMRSHIFTDB2_LICENSE.md ✓ present;
         providers/ocl/nmrshiftdb2.database.json  6.4 MB)
scripts/ (build-database.ts, run-benchmark.ts)
tools/plugin-package/package.ts            (vendored + adapted packaging tool)
tools/plugin-extract/{gates.ts,checkBoundary.ts}   (vendored + adapted gates)
vendor/chemdraft-plugin-api-0.1.0.tgz      (self-contained; deps {zod})
vendor/chemdraft-plugin-host-0.1.0.tgz     (self-contained; deps {zod, @chemdraft/plugin-api ^0.1.0})
```
`node_modules/` and `dist/` git-ignored.

## package.json changes

`version 0.0.0 → 0.1.0`; dropped `"private": true` and the workspace `exports` src-pointer;
`@chemdraft/plugin-api` `workspace:*` → `file:./vendor/chemdraft-plugin-api-0.1.0.tgz`;
`@chemdraft/plugin-host` (dev) `workspace:*` → `file:./vendor/chemdraft-plugin-host-0.1.0.tgz`; kept
`openchemlib ^9.22.1`, `zod ^3.25.76`; added devDeps `tsx`, `typescript`, `vite ^7`, `vitest`; scripts
`"package": "tsx tools/plugin-package/package.ts -- . --name nmr-predictor"` and `"test": "vitest run"`.
`src/manifest.ts` version also bumped to `0.1.0`.

## Packaging tool — vendored + adapted

Copied `package.ts`, `gates.ts`, `checkBoundary.ts` (single-file reads; no git ops on iCloud;
`committedCopy.ts` not needed). Adaptations, all confined to former workspace-internal resolution:
1. SDK imports (`createPackagedPluginManifestDocument`, `PACKAGED_PLUGIN_MANIFEST_FILE`,
   `PluginManifestSchema`, `PluginManifest`) repointed from `../../packages/plugin-api/src/index` → the
   installed vendored `@chemdraft/plugin-api`.
2. `gates.ts` reads `PluginApiVersion` from `@chemdraft/plugin-api` (= 0.1.0) instead of regexing
   monorepo source.
3. `loadVite` resolves `vite` from this repo's own `package.json`.
4. Added an optional `--name` flag so the release keeps the `nmr-predictor` basename (repo dir is
   `chemdraft-nmr-plugin`).
5. `assertSafePackagePaths`: kept the load-bearing guard (staging must not equal/contain the plugin
   root) but dropped the two now-incorrect "output must be outside the plugin dir" checks, since
   standalone the git-ignored `dist/plugin-packages` legitimately lives inside the repo root.
The three fail-closed gates (SDK boundary clean, git tree clean+committed, LICENSE present) all passed.

## First release

- `dist/plugin-packages/nmr-predictor-0.1.0.zip` — 3.46 MB compressed / 17.03 MB unpacked, 8 entries;
  `.sha256` = `5d76bba3…f79a3`, verified `OK`.
- Co-located, relocatable (relative-base): `entry.js` (1.14 MB) · `OclHosePredictor-*.js` (6.09 MB,
  **NMRShiftDB2 DB inlined** into this chunk via `import … .json`, correct for this import style) ·
  `assets/nmrWorker-*.js` (7.22 MB nested OCL worker) · two `resources-*.json` (OCL data, co-located
  for entry + nested worker) · `manifest.json` · `LICENSE`.
- Manifest labeling: PASS (HOSE/NMRShiftDB2; no fixture/synthetic); provenance `sourceTree: clean`.

## Deviation (necessary)

The git-clean gate needs a committed clean tree, so order was `npm install` → **commit** → `npm run
package` (instruction listed build before commit). `dist/` is git-ignored, so building after the commit
leaves the tree clean at exactly one commit; the recorded `sourceCommit` correctly identifies the
shipped bytes.

## What the owner does next

1. Create an empty GitHub repo and `git remote add origin <url> && git push -u origin main`.
2. (Optional) graft full history from `codex/nmr-plugin` via `git subtree split` once that repo is off
   iCloud.
3. Ship `dist/plugin-packages/nmr-predictor-0.1.0.zip` + `.sha256` as the release artifact.

## Risks / notes

- **esbuild allow-scripts:** `npm install` blocked esbuild's postinstall by policy; harmless here (the
  `@esbuild/darwin-arm64` prebuilt binary shipped; Vite bundled fine). On a machine relying on the
  postinstall, run `npm approve-scripts esbuild` first.
- `npm install` pulls `openchemlib/zod/vite/tsx/typescript/vitest` from the public registry; the SDK is
  fully offline via `vendor/`.
