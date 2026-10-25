# Architecture

The architecture follows the package boundaries in `AGENTS.md`.

The native document model belongs in `packages/chem-core`. Compatibility formats belong in `packages/cdx-compat`. Drawing engines, chemistry engines, native clipboard APIs, layout logic, shortcut routing, mechanism annotations, templates, plugins, and export orchestration each have separate package homes.

Key architecture notes:

- [perf-probe.md](perf-probe.md) — Bridge-gated timing logs for comparable macOS and Windows speed runs.
- `3d-spin-flatten.md` — Spin 3D flattening and placement architecture.
- `composited-page-editor-model.md`
- `dependency-inventory.md` — Dependency and vendored-binary inventory.
- `external-tools.md` — Host-owned Claude Code/Codex discovery, consent, and execution.
- `assistant-tools.md` — Document-aware Assistant tools, write scope, and local MCP transport.
- `over-under-crossing-model.md`
- `export-engines-build-plan.md`
- `save-open-and-file-format.md`
- `design-language.md`
- `editor-adapter-hardening.md`
- `grouped-object-transform-entry.md`
- `molecule-growth-corpus.md` — Clean-room drawing-productivity research index.
- `native-art-toolbar-chrome-plan.md`
- `ocsr-engine.md` — Local structure-recognition engine boundary.
- `pointer-picking-hardening.md`
- `plugin-package-reading.md` — Reading a picked plugin ZIP and its checksum natively; threat model.
- `plugin-runtime.md` — Plugin host, panels, and worker lifecycle.
- `toolbar-command-map.md` — Custom toolbar asset-to-command mapping.
- `toolbars-and-toolsets.md`
- `ux-surfaces.md` — Metadata-only UX surface scaffold.
- `viewport-and-rulers.md`
- `image-acquisition.md`
