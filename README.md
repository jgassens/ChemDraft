# ChemDraft

ChemDraft is a lightweight, local-file-first chemical drawing application under early development. The current milestone has a clean monorepo foundation, strict package boundaries, a native document model scaffold, plugin API/host foundations, page-layout infrastructure, a narrow active Ketcher molecule-editor host, and an optional fixture-backed MolScribe OCSR plugin scaffold.

This repository intentionally does not include full chemistry drawing beyond the first native single-bond and connected carbon-chain slices plus selected-molecule Ketcher editing, full RDKit integration, CDXML/CDX parsing, native clipboard handling, plugin sandboxing, real MolScribe OCSR inference, or proprietary assets yet.

## Current Status

- `apps/desktop` contains a Tauri v2, Vite, React, and TypeScript desktop shell with native floating toolset windows for desktop builds and command-backed File > Page Setup controls.
- Packaged macOS builds use Sparkle 2 to check for signed app updates automatically and expose File > Check for Updates…; installed plugins remain in Application Support across app replacement.
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

The first native build downloads the pinned Sparkle framework from its official release and verifies
its SHA-256 before use. Release/appcast instructions are in
`docs/releasing/macos-updates.md`; Sparkle update checks run only from a packaged macOS app, not the
browser-only preview.

The `./run-app` helper builds and launches the generated macOS `ChemDraft.app` bundle using the same `org.chemdraft.desktop` app identity as dev mode. Use `./run-app --dev` only when you explicitly want Tauri dev mode with Vite/HMR. Tauri requires Rust/Cargo to be installed and available on `PATH`.

## Windows

The same commands work on Windows 10/11 (x64). `pnpm dev` and the desktop `build`/`tauri` scripts run
through Node launchers (`scripts/dev.mjs`, `scripts/desktop-tauri.mjs`) that keep macOS on its exact
existing path and skip the macOS-only steps (Sparkle, signing) elsewhere.

Prerequisites: Node 24 + pnpm 10.12.1, Rust via rustup (the pinned toolchain installs itself), Visual
Studio 2022 Build Tools with the C++ workload, and WebView2 (preinstalled on Windows 11). For the
optional pieces: a JDK for the OPSIN runtime, CMake for the Engine 3D sidecar.

```bash
pnpm install
pnpm dev
node scripts/build-opsin-runtime.mjs
pnpm --filter @chemdraft/desktop build --bundles nsis
```

- The build produces `apps/desktop/src-tauri/target/release/bundle/nsis/ChemDraft_<version>_x64-setup.exe`,
  a per-user installer (no admin); it is unsigned, so SmartScreen will ask once.
- The Windows sidecar binary is committed; rebuild it with
  `cmake --preset windows-msvc && cmake --build --preset windows-msvc` in `native/avogadro3d-sidecar`
  after fetching `_deps` as its README describes.
- Keep the checkout outside OneDrive. Syncing `node_modules` and `target/` makes builds and the test
  suite several times slower.
- Debug builds are large (~9 GB of `target/debug` with full debuginfo); on a small disk set
  `CARGO_PROFILE_DEV_DEBUG=0`.

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
