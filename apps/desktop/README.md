# ChemDraft Desktop

Preferences includes “Ask to save unsaved changes before quitting”, off by default.
When enabled, quitting with dirty tabs offers Save / Don't Save / Cancel in a native message
box, with an accessible in-window fallback if the native box cannot open. Save writes every
dirty tab; a cancelled or failed save keeps the app open. Discard retains the existing
session-recovery behavior. Without a response from the document window, quitting retains
the bounded native grace period; it pauses only once the save dialog is actually showing.
Save and Discard re-arm that grace before flushing the session. Prompt controls are restricted
to the document window. On macOS, Dock Quit also checks the preference and reveals hidden
documents for the prompt; system logout, restart, and shutdown remain non-blocking.

Tauri v2, Vite, React, and TypeScript desktop shell for ChemDraft.

File > Export includes a preview of the actual exported SVG, PDF, or native raster bytes,
linked or independent pixel and physical dimensions, DPI, page/content cropping, background controls,
numeric JPEG quality, renderer warnings, and slide/poster/publication presets. Cropping uses
the existing padded content framing and does not edit the document. PNG embeds density;
SVG and PDF use the requested physical size. Other raster formats display a DPI-derived size.
Presets fit the longer frame side, including portrait drawings. PDF pages exceeding
14400 points (200 inches) on either side are refused with instructions to reduce
the pixel dimensions or increase DPI.
Preview updates are debounced and render at most 800 px on the longest side; only
the final export renders at the requested size. Enter in a valid filename/size field
exports. Changing the filename or format requires a new destination grant; write errors
appear in the dialog. Manual size edits select Custom, and keyboard preset navigation
applies on Enter or leaving the preset field.
Desktop Export uses the shared `dialogs/ExportForm.tsx` in its movable native window; the
document window renders previews and writes final exports. Editing the source drawing refreshes
its preview without resetting the dialog's options. BMP, GIF and TIFF previews use PNG rendering
for webview compatibility.

`pnpm dev` launches the Tauri desktop app. `pnpm dev:web` remains available as a secondary browser preview for React shell work.

This shell is intentionally compact and document-centered: native app menu, dense quick-action toolbar, page workspace, native floating icon-first palette, hidden-by-default utility panels, and status bar. It now includes a narrow lazy Ketcher host for active selected-molecule editing, but it does not include native file dialogs, native clipboard handling, full RDKit, CDXML/CDX, or MolScribe OCSR inference yet.

Packaged macOS builds also start Sparkle 2. Automatic checks offer signed app updates through
Sparkle's native UI, and File > Check for Updates… forces a visible check. The updater replaces the
app bundle only; installed plugin packages stay in Application Support. See
`../../docs/releasing/macos-updates.md` for the signing, appcast, and end-to-end verification flow.

The desktop palette is a separate Tauri window behind `src/window-manager`. Palette buttons route command IDs back to the main document window, where the existing command registry invokes them. `pnpm dev:web` keeps an in-window docked palette only as a browser-preview fallback.

Compound layouts are opt-in: enable **Compound layout tools** in Settings/Preferences.
Select two or more compounds or groups, then use Arrange Selection in Main, Art or Layout;
long-press or press Arrow Down for Circle, Oval, Grid left/center/right, Row or Column.
Row and Column automatically tighten their default gaps when needed to fit the page,
keeping at least 12 document pixels between visible compound bounds and preserving molecule sizes.
Adjust spacing opens a movable native window on desktop, previewing distances while retaining molecule sizes. Save is one Undo step;
Cancel/Escape makes no change. Toolbar/context items are hidden and direct commands refuse
while the setting is off. Existing drawing/export behavior is unchanged by enabling the setting.
