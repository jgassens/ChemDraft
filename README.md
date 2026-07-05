# ChemDraft

ChemDraft is a lightweight, local-file-first chemical drawing application under early development. The current milestone has a clean monorepo foundation, strict package boundaries, a native document model scaffold, plugin API/host foundations, page-layout infrastructure, a narrow active Ketcher molecule-editor host, and an optional fixture-backed MolScribe OCSR plugin scaffold.

This repository intentionally does not include full chemistry drawing beyond the first native single-bond and connected carbon-chain slices plus selected-molecule Ketcher editing, full RDKit integration, CDXML/CDX parsing, native clipboard handling, plugin sandboxing, real MolScribe OCSR inference, or proprietary assets yet.

## Current Status

- `apps/desktop` contains a Tauri v2, Vite, React, and TypeScript desktop shell with native floating toolset windows for desktop builds and command-backed File > Page Setup controls.
- Phase 7 has started with command-backed active drawing tools, keyboard shortcut routing, a minimal document-backed native single-bond insertion path, selected carbon-chain extension through native atom/bond payloads, and a lazy Ketcher host for active selected-molecule editing.
- `packages/chem-core` owns the first native document model, schemas, patches, serialization, history helpers, page layout state, and paper-size presets.
- `packages/ketcher-adapter` provides a host adapter boundary with capability reporting and molecule load/save contracts. Ketcher is embedded only through a narrow desktop active molecule-editor host; `chem-core` remains the document/page source of truth.
- `packages/plugin-api` defines manifest schemas, permission names, command contributions, plugin context types, and recognition-result types.
- `packages/plugin-host` contains command registration, permission checks, plugin storage scoping, and proposed-patch handling.
- `packages/viewport-engine` owns viewport state, coordinate conversion, zoom math, and ruler render state; rulers and crosshairs consume document page layout.
- `apps/desktop/src/surfaces` contains a tiny metadata-only UX surface scaffold. Rendered UI is not yet driven from it.
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

`pnpm dev` launches the ChemDraft Tauri desktop app through `./run-app --dev`, so normal dev launches clear stale ChemDraft instances and use the same app identity as packaged runs. In the desktop app, drawing toolsets are separate native windows that route command IDs back to the main document window, with visibility and placement persisted by the desktop shell. Use `pnpm dev:web` only as a secondary browser preview while working on the React surface; the browser preview uses in-window floating palette overlays, not palettes embedded in the document canvas.

The `./run-app` helper builds and launches the generated macOS `ChemDraft.app` bundle using the same `org.chemdraft.desktop` app identity as dev mode. Use `./run-app --dev` only when you explicitly want Tauri dev mode with Vite/HMR. Tauri requires Rust/Cargo to be installed and available on `PATH`.

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
