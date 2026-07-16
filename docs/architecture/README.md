# Architecture

The architecture follows the package boundaries in `AGENTS.md`.

The native document model belongs in `packages/chem-core`. Compatibility formats belong in `packages/cdx-compat`. Drawing engines, chemistry engines, native clipboard APIs, layout logic, shortcut routing, mechanism annotations, templates, plugins, and export orchestration each have separate package homes.

Key architecture notes:

- `composited-page-editor-model.md`
- `over-under-crossing-model.md`
- `export-engines-build-plan.md`
- `save-open-and-file-format.md`
- `design-language.md`
- `editor-adapter-hardening.md`
- `grouped-object-transform-entry.md`
- `native-art-toolbar-chrome-plan.md`
- `pointer-picking-hardening.md`
- `spin3d-performance-handoff.md`
- `toolbars-and-toolsets.md`
- `viewport-and-rulers.md`
