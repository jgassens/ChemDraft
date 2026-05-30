# ChemDraft

ChemDraft is a lightweight, local-file-first chemical drawing application under early development. The current milestone has a clean monorepo foundation, strict package boundaries, a native document model scaffold, plugin API/host foundations, and an optional fixture-backed MolScribe OCSR plugin scaffold.

This repository intentionally does not include real chemistry drawing, Ketcher, RDKit, CDXML/CDX parsing, native clipboard handling, plugin sandboxing, real MolScribe OCSR inference, or proprietary assets yet.

## Current Status

- `apps/desktop` contains a Tauri v2, Vite, React, and TypeScript desktop shell with native floating toolset windows for desktop builds.
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
pnpm dev:web
```

`pnpm dev` launches the ChemDraft Tauri desktop app. In the desktop app, drawing toolsets are separate native windows that route command IDs back to the main document window, with visibility and placement persisted by the desktop shell. Use `pnpm dev:web` only as a secondary browser preview while working on the React surface; the browser preview uses in-window floating palette overlays, not palettes embedded in the document canvas.

The `./run-app` helper builds and launches the generated macOS app bundle as `ChemDraft Run App`, which keeps local testing tied to the same inspectable application path. Use `./run-app --dev` only when you explicitly want Tauri dev mode with Vite/HMR. Tauri requires Rust/Cargo to be installed and available on `PATH`.

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
