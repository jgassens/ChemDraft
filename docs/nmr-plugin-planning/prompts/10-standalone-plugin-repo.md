# Assignment 10: Extract the NMR plugin into its own standalone repo (Phases 6–7)

- **Status:** ready to issue **once the filesystem blocker is cleared** (see Prerequisite)
- **Milestones:** M41 (Phase 6, repo + history) + M42 (Phase 7, first release); `PLAN-plugin-separation.md`
- **Depends on:** M40 / reports/0035 (the SDK is packable — the two tarballs exist); ADR-0031; ADR-0028 (single-SDK boundary); the SDK-distribution decision below.
- **Decision baked in (owner, 2026-07-17):** the standalone repo consumes the SDK via **vendored tarballs** (`file:` deps), NOT public npm. It is fully self-contained; no npm publish, nothing made public. A later swap to `^0.1.0` is a one-line change if the SDK is ever published.

## PREREQUISITE — do not start until this is true

Heavy git history operations currently **SIGBUS** (`signal 10`) because `~/Documents/programming/` is on an **iCloud-synced volume** disrupting git's pack files. `git subtree split`, `clone`, and `rev-list` all fail; forcing them risks a corrupt rewrite. Before running this assignment, the repos must be on a non-synced disk — either the owner moved `~/Documents/programming` off iCloud (e.g. to `~/programming`) or paused Desktop & Documents syncing. **Verify first:** `git -C <chemdraw-nmr> rev-list --count HEAD -- examples/plugins/nmr-predictor` must return a number, not exit 138. If it SIGBUSes, STOP and report — the environment is not ready.

## Where the pieces are

- Source of history: the `codex/nmr-plugin` branch (plugin lives at `examples/plugins/nmr-predictor/`, full M6→M36 history), currently checked out at worktree `~/Documents/programming/chemdraw-nmr` (path may change if moved off iCloud).
- The SDK tarballs (from M40): `chemdraft-plugin-api-0.1.0.tgz` and `chemdraft-plugin-host-0.1.0.tgz`, in the session scratchpad (`/private/tmp/.../scratchpad/`). If gone, rebuild: on branch `sdk-publish`, `pnpm build:sdk` then `pnpm pack` each package.
- The packaging tool to vendor: `tools/plugin-package/` (+ `tools/plugin-extract/gates.ts`, `checkBoundary.ts`) and `scripts/build-sdk.mjs` pattern — the standalone repo must be able to cut its own release zip without the monorepo.

## M41 — the repo with real history

1. **Extract:** on `codex/nmr-plugin`, `git subtree split --prefix=examples/plugins/nmr-predictor -b nmr-plugin-standalone`. This can be slow (walks history) — allow generous time, but it must complete without SIGBUS. Verify the branch: plugin files at **root** (`src/`, `README.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, `NMRSHIFTDB2_LICENSE.md`, `package.json`, `scripts/`), **no ChemDraft files**, and real multi-commit history (`git log --oneline nmr-plugin-standalone | wc -l` » 1).
2. **New repo** at a **non-iCloud** path (e.g. `~/programming/chemdraft-nmr-plugin`): `git init`, then pull the extracted branch as `main` (`git pull <source> nmr-plugin-standalone` or fetch+reset). Confirm history is preserved.
3. **Adapt `package.json` for standalone/vendored SDK:** `name` `@chemdraft/plugin-nmr-predictor`, keep MIT; replace `@chemdraft/plugin-api: "workspace:*"` → `"file:./vendor/chemdraft-plugin-api-0.1.0.tgz"`; add `@chemdraft/plugin-host` as a **devDependency** `"file:./vendor/chemdraft-plugin-host-0.1.0.tgz"` (its manifest tests need it); keep `openchemlib`/`zod`. Vendor the two tarballs into `vendor/`.
4. **Vendor the packaging capability** so the repo can build its own release zip: copy the `plugin:package` tool (`tools/plugin-package/package.ts` + the shared `gates.ts`/`checkBoundary.ts` it needs) into the standalone repo's `tools/`, adjust its imports to the standalone layout (the plugin is now at repo root, not `examples/plugins/nmr-predictor`), and add a `package` npm script. Drop anything that assumes the monorepo.
5. **README + `.gitignore`** for a standalone project (build outputs, node_modules, vendored-note). A short "built from the ChemDraft monorepo; SDK vendored per ADR-0031" provenance line.

## M42 — first release

6. `npm install` in the standalone repo (resolves the vendored SDK from `file:`), then build and run the vendored `package` tool to produce **`nmr-predictor-<version>.zip` + `.sha256`**. Verify: the zip's `manifest.json` matches the corrected labeling (M35), the boundary check passes, and the provenance `sourceCommit` now points at the **standalone repo's** commit (not the monorepo).
7. **Prove it loads:** the produced zip is the same shape M36 installs; if feasible, sanity-check it unzips to the expected file set with a valid checksum. (Full in-app install was already proven in Phase 4; this step confirms the *standalone-built* artifact is equivalent.)

## Non-goals (owner actions — do NOT do these)
- **No GitHub repo creation or push** — the owner creates the remote and pushes.
- **No `npm publish`** — vendored tarballs mean none is needed.
- Do not modify the monorepo (`codex/nmr-plugin`, `main`, etc.) beyond creating the local `nmr-plugin-standalone` branch via subtree split.

## Final report (archived as `reports/0036-standalone-plugin-repo-*.md`)
Include: the extracted history proof (commit count, root file list, no-ChemDraft-files check); the standalone repo path + layout; the vendored-SDK `package.json` diff; how the packaging tool was vendored + adjusted; the first-release zip details (size, sha256, provenance commit, manifest labeling); what the owner must do to finish (create GitHub repo, push `main`, optionally publish SDK later to swap `file:` → `^0.1.0`); deviations; risks. Stop after M42.
