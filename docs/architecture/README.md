# Architecture

The architecture follows the package boundaries in `AGENTS.md`.

The native document model belongs in `packages/chem-core`. Compatibility formats belong in `packages/cdx-compat`. Drawing engines, chemistry engines, native clipboard APIs, layout logic, shortcut routing, mechanism annotations, templates, plugins, and export orchestration each have separate package homes.

Tauri is planned for the desktop shell, but this foundation starts with a Vite shell to avoid brittle native setup before the frontend and package contracts settle.
