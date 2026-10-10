# ChemDraft Desktop

Tauri v2, Vite, React, and TypeScript desktop shell for ChemDraft.

File > New (Ctrl+N on Windows, Cmd+N on macOS) adds a canvas tab. File > Open opens a file
in a new tab. The tab strip switches between drawings, retaining each document's undo history,
file association, selection, and viewport. File > New Window (Ctrl+Shift+N / Cmd+Shift+N)
opens another document window with its own tabs. File > Close Canvas Tab closes the active tab;
unsaved changes offer Save, Discard, or Cancel. Closing a window checks every dirty tab, and
quitting checks all document windows. Native menus and shared floating palettes follow the
active document window. Working-session snapshots include all tabs and are stored separately
per document window; startup still opens a fresh workspace.

File > Export includes a preview of the actual exported SVG, PDF, or native raster bytes,
linked width and height, DPI and physical width, page/content cropping, background controls,
numeric JPEG quality, renderer warnings, and slide/poster/publication presets. Cropping uses
the existing padded content framing and does not edit the document. PNG embeds density;
PDF uses the requested physical size. Other raster formats display a DPI-derived size.

`pnpm dev` launches the Tauri desktop app. `pnpm dev:web` remains available as a secondary browser preview for React shell work.

This shell is intentionally compact and document-centered: native app menu, dense quick-action toolbar, page workspace, native floating icon-first palette, hidden-by-default utility panels, and status bar. It now includes a narrow lazy Ketcher host for active selected-molecule editing, but it does not include native file dialogs, native clipboard handling, full RDKit, CDXML/CDX, or MolScribe OCSR inference yet.

Packaged macOS builds also start Sparkle 2. Automatic checks offer signed app updates through
Sparkle's native UI, and File > Check for Updates… forces a visible check. The updater replaces the
app bundle only; installed plugin packages stay in Application Support. See
`../../docs/releasing/macos-updates.md` for the signing, appcast, and end-to-end verification flow.

The desktop palette is a separate Tauri window behind `src/window-manager`. Palette buttons route command IDs back to the main document window, where the existing command registry invokes them. `pnpm dev:web` keeps an in-window docked palette only as a browser-preview fallback.
