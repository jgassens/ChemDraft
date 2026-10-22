# ChemDraft Desktop

## Main toolbar zoom

The Main toolbar's **Document Zoom** control has Zoom Out/Zoom In icons and a dropdown with
25%, 50%, 75%, 100%, 200% and 400% presets. Its value follows wheel/pinch gestures and keyboard
shortcuts too, showing an intermediate percentage when appropriate. Each document tab retains
its own view. Zoom affects the view only: it does not resize molecules, change exported page
dimensions, mark the drawing dirty or create Undo entries. The default zoom range is 25%–850%.
Toolbar icons and presets zoom about the visible drawing area's center, including after scrolling.
Wheel/pinch gestures keep the pointer as their anchor. At scroll boundaries, the browser may clamp
the position when a smaller page fits into the workspace.

The control is available as **Document Zoom** in Customize Main Toolbar. If a saved custom layout
does not include it, add the widget from the gallery or restore toolbar defaults. Detached palettes
receive small validated zoom updates from the document window; they do not own a separate zoom.

The buttons and their zoom shortcuts use fixed stops: 25%, 50%, 75%, 100%, 125%, 150%, 200%,
300%, 400%, 600%, 850%. From an intermediate wheel-zoom value, they choose the next stop in the
requested direction. Wheel/pinch stays smooth; the dropdown keeps its six presets.

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
