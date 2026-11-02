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

Ring templates are grouped under the benzene button in Main and Structure. Long-press or
press Arrow Down for saturated 3–8-membered rings, benzene and the two chair cyclohexanes.

Both keyboard presets use these case-sensitive drawing keys while hovering a structure:

| Key | Over an atom | Over a bond |
| --- | --- | --- |
| `g` | Cyclopropyl substituent | Fuse a 3-membered ring |
| `u` | Cyclobutyl substituent | — |
| `z` | Alkyne, –C≡CH | Fuse cyclopentadiene |
| `Shift+G` | Cyclopentadienyl substituent | — |
| `Shift+J` | Phenyl substituent | — |

Each substituent attaches through one new bond and is one Undo step. Keys `k` and `K` over an
atom add a carbonyl or oxo group where the current valence gate permits it in the default ChemDraft
preset; `k` and `K` do nothing in the compatibility preset.
Key `2` adds =O directly to S or P where the current valence gate permits it; carbon keeps its
carbonyl behavior. Key `9` adds two methyl groups when carbon has room for both, otherwise
attaches isopropyl through one new bond (subject to the same gate). Preferences uses ⌘, on
macOS and Ctrl+, on Windows.

## Editing text

While editing an existing text box, only the live formatted preview is shown. The saved drawing
returns with the updated content when editing ends; other labels remain visible throughout.

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

## Format selected text boxes

Select several text boxes, then choose a font or size to apply it to all selected boxes in one
Undo step. Unselected labels and non-text objects keep their formatting. When editing inside
a text box with characters highlighted, formatting applies only to those characters.

Orbital tools remain active after placement. Click a lobe tip or p-orbital centre to join
new orbital art at that node; repeated clicks choose an unused direction. Drag from the
node to choose an arbitrary angle, holding Shift for 15-degree steps. Escape returns
to Selection. Selected orbitals show a rotation handle immediately; double-click the
handle for numeric entry, or use Direct Edit to change path nodes. Orbital joins are
visual alignment and do not create or alter chemical bonds.

## Startup preference

Preferences > Startup offers **Start with a fresh document**, off by default. It opens one
clean Untitled drawing on the next application launch instead of restoring the previous tabs.
Changing it leaves the current drawings and their undo histories intact. Explicit startup files
and later OS file-open requests still use the normal Open flow; an untouched blank is replaced.

The saved session is read and validated even when restoration is skipped. A corrupt outer session
continues to block autosave, and retained unrestored tabs remain available through the existing
recovery controls. An untouched startup blank (including viewport or selection changes) does not
replace the previous session, even on quit. Editing, explicitly saving, opening a file, creating
additional tabs, or explicitly saving/discarding retained recovery tabs allows the normal autosave
and quit flush to replace it. Once replaced, later blank documents follow normal session rules.
Turning the option off cannot recover an older session after new work has replaced it.

The preference uses the same localStorage mechanism as other boolean preferences. It is captured
synchronously once by the document window before its asynchronous session read; no live document
broadcast is needed for a next-launch-only option. No native command or session migration is added.
