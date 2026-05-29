# ChemDraft Desktop

Tauri v2, Vite, React, and TypeScript desktop shell for ChemDraft.

`pnpm dev` launches the Tauri desktop app. `pnpm dev:web` remains available as a secondary browser preview for React shell work.

This shell is intentionally compact and document-centered: menu region, dense quick-action toolbar, page workspace, icon-first palette, hidden-by-default utility panels, and status bar. It does not include real chemistry drawing, native file dialogs, native clipboard handling, Ketcher, RDKit, CDXML/CDX, or MolScribe OCSR inference yet.

Future native floating palettes should live behind a desktop window-manager boundary and route actions through command IDs.
