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

Plugin catalog and local engine downloads use reqwest 0.12 with both Mozilla and OS certificate
roots, so macOS and Windows enterprise trust stores can participate without disabling certificate
verification. Transport failures name the host and cause; diagnostics and logs remove URL credentials,
queries and fragments. The catalog retains its existing HTTP allowlist, redirect validation and
checksum/size gates. Its main-window-only `diagnose_download_host` command can only HEAD the fixed
catalog/asset hosts, with no redirects and bounded connect/total timeouts. A successful probe means
only that the host was reachable on retry, not that the original transfer succeeded.
System proxies remain enabled (environment and static OS settings); reqwest does not evaluate
PAC/WPAD scripts. Windows app updates retain their separate reqwest 0.13 OS verifier and proxy path.
Proxy exclusions apply separately to each redirect destination: excluding `github.com` does not
exclude `release-assets.githubusercontent.com` or `objects.githubusercontent.com`. The engine
downloader observes redirects while delegating every redirect decision to reqwest's default policy.
This corrects reqwest 0.12.28's original-URL fallback on redirected transport failures, so a failed
asset connection names the asset host. Other error URLs and HTTP status diagnostics retain their
request/response host. Both engine install dialogs show redacted native network diagnostics, with
generic download guidance when no recognised diagnostic is available.

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

## Paired bracket tools

Select a pair to show its lower-right **label, repeat count, or range** field. Enter text such as
`n`, `12`, or `5–10`, then press Enter or click away to keep it. Escape discards the current edit;
clear the field to remove the label. Each completed edit is one Undo step. The text belongs to
the pair and follows its movement and resizing. Native saves and SVG/PDF preserve the label;
the empty editor placeholder is never exported. This is a drawing annotation, not polymer chemistry.

Main and Art offer separate **Paired Square Brackets** and **Paired Curly Brackets** tools beside
the original single-bracket tools. Drag across a region to draw both facing sides, or click to
place a default-size pair. The pair is one object: select it to move or resize both sides together.
Escape or pointer cancellation discards the preview, and insertion is one Undo step.
Drawing brackets does not change the enclosed molecule. Native saves preserve the pair and SVG/PDF
render both sides. Existing CDXML bracket-placeholder warnings still apply; this adds no polymer
semantics or visible-CDXML bracket compatibility.
