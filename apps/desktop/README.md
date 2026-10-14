# ChemDraft Desktop

Preferences includes “Ask to save unsaved changes before quitting”, off by default.
When enabled, quitting with dirty tabs offers Save / Discard / Cancel. Save writes every
dirty tab; a cancelled or failed save keeps the app open. Discard retains the existing
session-recovery behavior. Without a response from the document window, quitting retains
the bounded native grace period; it pauses only once the save dialog is actually showing.
Save and Discard re-arm that grace before flushing the session. Prompt controls are restricted
to the document window. On macOS, Dock Quit also checks the preference and reveals hidden
documents for the prompt; system logout, restart, and shutdown remain non-blocking.

Tauri v2, Vite, React, and TypeScript desktop shell for ChemDraft.

`pnpm dev` launches the Tauri desktop app. `pnpm dev:web` remains available as a secondary browser preview for React shell work.

This shell is intentionally compact and document-centered: native app menu, dense quick-action toolbar, page workspace, native floating icon-first palette, hidden-by-default utility panels, and status bar. It now includes a narrow lazy Ketcher host for active selected-molecule editing, but it does not include native file dialogs, native clipboard handling, full RDKit, CDXML/CDX, or MolScribe OCSR inference yet.

Packaged macOS builds also start Sparkle 2. Automatic checks offer signed app updates through
Sparkle's native UI, and File > Check for Updates… forces a visible check. The updater replaces the
app bundle only; installed plugin packages stay in Application Support. See
`../../docs/releasing/macos-updates.md` for the signing, appcast, and end-to-end verification flow.

The desktop palette is a separate Tauri window behind `src/window-manager`. Palette buttons route command IDs back to the main document window, where the existing command registry invokes them. `pnpm dev:web` keeps an in-window docked palette only as a browser-preview fallback.
