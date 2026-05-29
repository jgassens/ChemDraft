# ChemDraft

ChemDraft is a lightweight, local-file-first chemical drawing application under early development. The current milestone has a clean monorepo foundation, strict package boundaries, a native document model scaffold, plugin API/host foundations, and an optional fixture-backed MolScribe OCSR plugin scaffold.

This repository intentionally does not include real chemistry drawing, Ketcher, RDKit, CDXML/CDX parsing, native clipboard handling, plugin sandboxing, real MolScribe OCSR inference, or proprietary assets yet.

## Current Status

- `apps/desktop` contains a Vite, React, and TypeScript app shell.
- `packages/chem-core` owns the first native document model, schemas, patches, serialization, and history helpers.
- `packages/plugin-api` defines manifest schemas, permission names, command contributions, plugin context types, and recognition-result types.
- `packages/plugin-host` contains command registration, permission checks, plugin storage scoping, and proposed-patch handling.
- Other packages are boundary placeholders for future work.
- `examples/plugins/molscribe-ocsr` provides an optional fixture-backed MolScribe OCSR scaffold without adding ML dependencies.

## Commands

```bash
pnpm install
pnpm lint
pnpm test
pnpm build
pnpm dev
```

`pnpm dev` starts the Vite desktop-shell preview. Tauri is intentionally not scaffolded yet; add it once the frontend and package boundaries are stable.

## Architecture Rules

Read `PLAN.md` and `AGENTS.md` before making changes. In short:

- Chemical identity must not be silently changed.
- CDXML/CDX compatibility must not become the native document model.
- External engines must stay behind adapter packages.
- Plugins must request document changes through controlled APIs.
- Migration-critical drawing and clipboard workflows are first-release concerns.
- Do not copy proprietary icons, templates, documentation, sample files, or visual assets.
- Do not use MolScribe as the app name; reserve it for the optional OCSR plugin integration.

## Dependency Notes

The initial dependency inventory is recorded in `docs/architecture/dependency-inventory.md`.
