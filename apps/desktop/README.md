# ChemDraft Desktop

Conditions use **Top / inside** and **Bottom / outside**. On a curved arrow, Top faces the
inside of the curve and Bottom the outside. On a straight arrow, Top is the upper page side
regardless of drawing direction (left for an exactly vertical shaft). Moving or resizing arrows
retains the curve side; manually positioned labels keep their authored positions until the side is changed.

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

Right-click an arrow for **Attach offshoot**, with **Top / outside**, **Bottom / inside** and
**Full curve — top / inside** and **Full curve — bottom / outside** choices, or **Reaction conditions…**.
A half offshoot leaves the shaft's midpoint tangentially and follows its
parent when moved, bent or rotated. Drag its bend or endpoint to reshape it. Full curve extends on
both sides of the attachment as a smooth U, initially tangent to
the parent at its midpoint. Drag the diamond tether along the parent shaft to change its attachment
point. Drag the tail or head independently; hold Shift while dragging either to align both ends
with equal reach and rise in the tether frame. Holding Shift over a selected full curve also shows
a third green handle above its frame; drag it to adjust both endpoints equally. The curve passes through that exact tether with a
smooth forward tangent. Endpoints stop before crossing the tether in its forward direction, avoiding
loops. Top remains visually above a newly drawn straight arrow regardless of arrow direction;
curved parents retain the existing outside/inside geometry.
The existing half-curve side choices keep their geometry. Every offshoot's head size follows
the parent; resize the parent head to change both. Conditions use normal/subscript/superscript spans,
a formatted preview and a top/inside or bottom/outside position. They are native text: drag to
adjust spacing, double-click to reopen the editor, or clear the text to remove it. Save is one Undo
entry; Cancel is unchanged. The movable native editor stays tied to its originating tab. If that
drawing changes while it is open, close/reopen before Save. Selection alone does not invalidate it.
Resizing an arrow or its group scales attached offshoots too, retaining their proportions and head
separation. Conditions are fitted to their formatted lines and placed clear of nearby drawing ink.
If no clear position exists on the chosen side, Save explains how to make room. Dragging a label
keeps that manual position through later movement and editing. Arrangement connections trim to a
tight molecule outline built from the rendered bonds, stereo marks and labels, allowing longer,
more balanced arrows beside diagonal molecules.

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
Three indented options are independently opt-in and require that parent setting:
**Arrangement Arrows** enables one Arrange with options window with layout, connecting arrows
and spacing controls;
**Offshoot Arrows** enables Attach offshoot; **Formatted Reaction Conditions** enables the
conditions editor. All three start off, including for existing profiles. Turning the parent off
retains the child choices for later. Saved arrows and labels still render and follow their parents
with these authoring options off. Basic layouts and standalone Adjust spacing need only the parent setting.
With Arrangement Arrows enabled, the separate Adjust spacing menu entry is folded into Arrange
with options. Saved shortcuts still open that same window without resetting its draft. The spacing
slider changes the chosen layout at 25–150%, rerouting arrows while retaining molecule sizes.
Invalid overlap or page overflow disables Save. Layout, arrows and spacing save as one Undo entry.
Select two or more compounds or groups, then use Arrange Selection in Main, Art or Layout;
long-press or press Arrow Down for Circle, Oval, Grid left/center/right, Row or Column.
Row and Column automatically tighten their default gaps when needed to fit the page,
keeping at least 12 document pixels between visible compound bounds and preserving molecule sizes.
Standalone Adjust spacing opens a movable native window on desktop when Arrangement Arrows is off,
previewing distances while retaining molecule sizes. Save is one Undo step;
Cancel/Escape makes no change. Toolbar/context items are hidden and direct commands refuse
while the setting is off. Existing drawing/export behavior is unchanged by enabling the setting.

**Arrange with options…** in the same submenu opens a preview before changing the drawing.
**Add connecting arrows** starts off for a new selection. Reopening an existing connected
arrangement restores its saved options and shows the checkbox checked. Unchecking removes only
that selection's generated connections and their offshoots/conditions when saved; Cancel changes
nothing. Matching connections retain their IDs and styles when edited. **Arrow length** previews
30–100% of the clear route, shortening both ends without moving or resizing molecules. At 100%,
unchanged existing arrow geometry is preserved. Selecting several complete arrangements applies a
common length to each connection while keeping their compound positions, individual layouts and
directions. Changing the topology controls applies that layout to the whole selection. Adding/removing selected
compounds rebuilds the selected neighbor graph. Circle/Oval offer clockwise or counterclockwise arcs
and an optional closed loop; Row/Column connect neighbors in either direction. Grid explicitly chooses
separate rows or a snake sequence. Arrows reserve space around compound and grouped-caption bounds;
an obstructed or off-page route is refused with the drawing unchanged. Save moves the compounds and
adds the editable arrows in one Undo step. These arrows support offshoots and reaction conditions.
They remain editable after Save; moving a compound normally does not reroute them. Explicit layout
commands (including direct Circle/Grid/Row/Column choices) update selected generated connections
along with the compounds, retaining matching arrow IDs, styles and attachments. **Adjust spacing**
reroutes newly generated connections between their original compounds, retaining arrow styles,
offshoots and conditions in one Undo step. Older connections without endpoint metadata remain
independent; recreate those connections to enable spacing updates. The arrow-enabled default gap is
64 document pixels. Color Controls also colors arrow strokes in a mixed compound/arrow selection;
coloring a parent carries its branch subtree, while selecting a branch styles only that subtree.

Formatted conditions, including normal spans with font-size overrides, use explicit run baselines and reserve each line's ascent/descent,
so a subscript on one line cannot collide with a superscript on the next. The dialog preview,
canvas, SVG and PDF share those metrics; ordinary unformatted text and atom labels retain their
existing layout.
