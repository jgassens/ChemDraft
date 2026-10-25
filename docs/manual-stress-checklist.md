# Manual stress checklist

The standing hands-on checklist for interactive surfaces. It moved here from `AGENTS.md` §20 when that
file was consolidated (2026-10-04); `AGENTS.md` §14 still requires it. Run every item on **macOS and
Windows** unless the item names one platform. `docs/windows-port-stress-test.md` records the Windows
port's own hands-on pass.

Manual stress must cover tab initialization, user tab persistence, mixed states, multi-molecule
scaling, sparse override precedence, terminal carbon labels, hidden implicit hydrogens, explicit
hydrogens, fonts, save/reopen, undo/redo, Spin 3D, atom-label editor placement, SVG export, and ring
selection after tab switching/closing.

Ring-fill labels: fill every ring of pyridinium, CBPQT4+ and 1,3,5-oxathiazinane with light blue
(25%), solid blue and a vivid alternating palette (90%). Check N+, NH, O and S: each fill reaches
every bond, without a missing box or white glyph outline. At shared-ring nitrogens each part of the
halo must match the fill beneath it. Repeat with linear/radial gradients, shadow/glow/sketch, explicit
label background colours and transparent backgrounds. Compare canvas, PNG, SVG and PDF on both hosts.

Document window placement (macOS and Windows): move/resize, quit, and relaunch; the window must
reopen where it was left, without flashing at the OS cascade position. With no saved frame it
centres. Record a normal frame, maximize, quit while maximized, then relaunch: it must come back
maximized, and un-maximizing must return to the recorded pre-maximize frame. Repeat with the saved
normal frame on a disconnected display: relaunch must centre then maximize, without a cascade flash.
On Windows repeat with top/left taskbars and different display scales. On macOS also repeat fullscreen
and Dock reopen. Cold-open a file from Finder/Explorer, relaunch after an update, and open another
file/launch again while running: the main window must appear, preserving its live frame and maximized
state when already visible. Repeat with session recovery and crash-report consent pending.

Nested plugin workers (packaged macOS and Windows builds): install the NMR Shift Predictor package,
select a molecule, and invoke prediction from real menu input. On Windows/WebView2, confirm the
entry bootstrap loads with the unchanged installed-plugin CSP, the nested module imports from its
real `http://tauri.localhost/installed-plugins/…` URL, its reference JSON resolves relative to that
module, and prediction answers without `ERR_ABORTED` or `NMR_PROVIDER_FAILURE`. Repeat after
disable/re-enable and uninstall/reinstall. Exercise nested worker `postMessage`, replies, name,
credentials, error listeners, and termination; confirm blob URLs are released after module startup
and on load failure. Probe external fetch/module imports: the installed worker and its blob child
must still be blocked by CSP without host permission. On macOS, confirm the entry and nested
worker still load directly from `tauri://localhost` with working prediction. In a Windows web
preview, confirm construction remains native; classic and cross-origin calls must remain unchanged.

Plugin panel focus (both macOS and Windows): open/re-show a panel from Analyze or a plugin command;
click a panel button, heading, chart, empty area and title/drag area, hover its controls and scroll.
Buttons must run exactly once and hover feedback must work; after each ordinary click the drawing
must have keyboard focus. On Windows at 200%, repeat with the Mass Analysis heading, table cell,
value text, empty content, and title bar (press/release without moving, then drag). Use a 15 ms
GetForegroundWindow logger alongside a Main toolbar button as the control: a transient panel
foreground interval is allowed, but it must hand back to the document promptly after release,
without a document click. Press a drawing-tool shortcut immediately after each click; foreground
ownership alone is insufficient if keyboard focus remains in the panel's WebView2 child.
Click a panel text/number field, textarea, select or
editable text, type/change its value, then press Escape: the panel stays open and a drawing-tool
shortcut works again. Single-line Enter commits and returns focus; multiline Enter stays in the
field. Tab between inputs, then Tab out of the last (and Shift+Tab out of the first), and click back
on the document while editing: keyboard focus returns to the drawing. Move/resize and close a panel
(including the native close shortcut): ownership, shadow, no taskbar entry and plugin close notification
remain intact. On Windows 10 and 11 at 100%, 150%, and 200%, resize from every edge and corner,
also on a second monitor at a different scale. Measure the top target against
`GetSystemMetricsForDpi(SM_CYSIZEFRAME, GetDpiForWindow(panel))` plus
`GetSystemMetricsForDpi(SM_CXPADDEDBORDER, GetDpiForWindow(panel))`: the entire physical-pixel
band from the outer window top must resize, including its last row and both top corners,
with no gap where Tauri's original SM_CYFRAME overlay ended. Check the appropriate vertical
or diagonal resize cursor. Immediately below that band, in the client title strip (including
below the wider corner targets), title text must receive its trusted DOM pointerdown and
move the window rather than resize it; the native left/right border still resizes sideways.
Windows 10 must never show a native caption above the DOM title.
The panel must
have a single frame like the toolbars, content reaching its edge, and no white inset or black
left/right/bottom bands during or after resizing. Repeat after hide/show, live resize, and moving between
100%, 150% and 200% DPI monitors (including monitors above/left of the primary). Confirm WebView2
still paints beneath the enlarged top input band without a blank margin. Re-measure the top
target and check the first draggable row after each DPI transition; if maximized, no edge
may resize, and restoring must recover the current-DPI band. Confirm WebView2
buttons still receive exactly one trusted pointerdown/click and return keyboard focus, and
text/content is not clipped. Repeat ordinary content clicks after ending an input
lease; test right/middle presses too. Hover and wheel alone must not trigger a focus hand-back.
On Windows, rapidly click ordinary content then an input while the first hand-back IPC is delayed:
typing must stay in the input after the old request completes. Repeat with report-text selection.
Activate a panel button with Enter/Space (no pointerdown): its action runs once without queuing
a pointer hand-back or ending an existing text-selection lease.
During an input/text-selection lease, press a resize border without moving: drawing shortcuts resume.
In both inline and Full size spectra, change frequency/comparison selects, then Escape/Enter/Tab out;
replace the report while a select is focused and confirm drawing shortcuts work again. Without making
the panel key, hover peaks/atoms to check linked highlighting and pan across peak hit areas (and out
of the spectrum while captured): panning must continue until release. Programmatic `input.focus()`
and dispatched pointer events must not start a keyboard lease. In Full size, focus a select and
press Escape: the first closes only the overlay, preserving the report window. Drag-select report
text and double/triple click a word/paragraph, then Cmd/Ctrl+C: paste into another app and confirm
the report selection was copied. On Windows at 200%, log window blur/focus around pointerup
and double-click: the activation's transient blur/focus must not clear the selected range,
including when native acquisition replies before or after the blur and WebView2 focus recovery
takes more than 32 ms (repeat with 100 ms and 1 s delays). Repeat for input typing and a select;
then click the document or another app while acquisition is pending and after it settles.
Log the generation-tagged native chemdraft://plugin-panel-focus events: a genuine native
deactivation must end the lease even if a delayed success reply or DOM focus arrives afterward.
The selection must clear immediately on that event; it must survive DOM blur alone.
While the first input acquisition is delayed, click that input again and then click the document.
The first native deactivation (or failed acquisition) must cancel the queued retry, with no focus
stolen back. Repeat with the retry already pending when the first generation's loss arrives.
After drag-selecting report text and copying it, press Right or Down, then M: the selection
must clear and drawing shortcuts must resume even on WebView2, without scrolling the report.
Repeat with Home/End/PageUp/PageDown, letters, digits, Tab, Enter and Space as the release key.
Cmd/Ctrl+C, Cmd/Ctrl+A, Shift+arrow/Home/End and bare modifier keys must keep the selection lease;
arrows in an editable input must keep its input lease. Check on macOS and Windows.
Moving the range outside report text must also end the lease.
Reload a panel webview using developer tools after several input leases; a fresh input click must
still acquire focus. Repeat with an old acquisition pending at reload. Inject a native resize-hook
installation failure: opening must report the error and leave no live panel window.
A plain text click keeps drawing shortcuts active. With text
selected, Escape or a click elsewhere in the panel/document clears selection and returns drawing
shortcuts; report replacement must also end the lease. Script-created ranges and synthetic drags
must not start a lease. On both platforms, with another app frontmost, click an exposed panel input
or select text, and also switch apps before a delayed focus request executes: ChemDraft must never
activate or come to the front. On Windows repeat with a non-client edge/corner press/resize while
the other app is foreground; it must stay foreground and receive no phantom Alt keystroke.
Also repeat ordinary content/title clicks and switch apps between pointer release and IPC delivery;
the guarded hand-back must not raise ChemDraft. With two panels open, a delayed hand-back from
one must not interrupt an input lease in the other.
After a background request returns false, the input/selection lease must end immediately even
without any DOM blur. Close the foreground application so Windows activates the idle panel:
drawing shortcuts must work, with no stale lease suppressing hand-back. Then activate the document
and click the same input again: typing works. Repeat while rapidly ending one lease and acquiring
another: an ended lease's deactivation must never clear an independent new input/selection lease.
An obsolete generation must likewise not clear a newer acquisition that has already settled.
On Windows, put File Explorer (then another application) in front and close it without clicking
ChemDraft. If Windows activates an idle panel, the document must promptly receive keyboard focus
and the next drawing shortcut. Repeat with two panels; another panel's input lease must not be
interrupted. Repeat with delayed activation notification/hand-back while clicking an input or
selecting text: an active or pending lease must supersede that hand-back. Switching to a third
application before delivery must not bring ChemDraft forward.

Drawing-tool surfaces added since: each reaction-arrow kind by click and by drag (heads render per
kind, resize handles work, rotate and flip move the arrow itself and not just its frame), both
bracket kinds placed and resized, dagger and submenu symbol stamps, atom labels through `tool.atom`,
chains dragged off an existing atom (a ring atom and a chain's end atom, with the chain growing
along the whole drag, not stopping at the one carbon placed on press) and off empty canvas
including against a page edge, reaction and art arrows drawn starting on top of a molecule
(the arrow stretches with the drag rather than landing at its default length), a long chain
(about 200 carbons) dragged on empty canvas and off an aromatic ring that stays responsive for the
whole drag and has its SMILES after release, through undo/redo and save/reopen, formula text
applied to a typed formula, one undo entry per gesture, and SVG export parity with the canvas for
arrows, brackets, and orbitals.

Toolbar and arrow surfaces added since: the curated arrow flyout (bold, dashed, curved 90/180, both
fishhooks, no-reaction) opened cold, warm, and after a long idle — the first press of a session must
place the popout under its button, not offset from the screen origin; the selection-aware Main style
widget in all four variants (text, molecule, arrow, shape) including its no-reaction ✗-size select,
with a gesture cancelled mid-press (the layout must not freeze on the previous selection); Shift-hover
transform boxes on arrows — the box latches to the first arrow for the whole hold, its rotate, 3D
rotate, and resize handles all work under the arrow tools, and dismissal leaves no ghost pixels;
arrowhead resizing on a scaled equilibrium (the head must land at the pointer, and an untouched shaft
handle must not move the shaft); "Set as Default Arrow Style" captured from a dashed arrow made solid;
tooltips on a palette dragged to a second monitor; and toolbars restored after being left off-screen
or on a since-detached display.

Keybinding and molecule-editing surfaces added since: the Chain tools flyout (Chain / Flexible
Chain) opened cold and warm, with a flexible-chain drag that turns corners both free and
atom-anchored while a straight drag still reproduces the straight planner exactly; the numeric
hover hotkeys in both keybinding schemes (rings 3–0 attach/fuse over atoms and bonds, wedge/hash
sprouts 4/5, carbonyl 2, gem-dimethyl 9, the 0-key cyclic bond closing a ring), with tool keys
following the selected scheme — `e` over an atom applies the Et nickname in the ChemDraw scheme,
while ChemDraft's `e` arms the eraser; charge stacking
by hotkey and by the charge tool up to ±9 and back down to mark removal; the Clear/Restore
Warnings context menu under whole-molecule and partial selections; element-symbol text converting
to a naked atom on every edit-ending gesture (Escape, click-away, tool switch), and Delete
stripping a labeled atom back to skeleton carbon before the second press deletes it; a bond
dragged onto another molecule object's atom merging the two objects into one; magnetic
canonical-geometry snap during atom drags, partial-selection drags, and fragment rotations — a
release outside the capture window must land exactly at the pointer; junction-pivot rotation
holding the junction and attachment bond fixed; and switching the keybinding scheme live with the
main window, detached palettes, and the native menu accelerators all following.

File open: with ChemDraft quit, double-click a `.chemdraft` in Finder (macOS) / Explorer (Windows); the app opens with that document and does not crash.

Windows surfaces added since (the port on `windows-port`; `pnpm smoke:windows-menu-churn` automates
the crash part): a second launch and a double-clicked `.chemdraft` file handed to the running app by
single-instance, which then opens and can save that file; closing the document window (title-bar ✕,
File > Exit, Alt+F4) quits the app after flushing the session, so a drawing made seconds earlier
survives relaunch; F5 and Ctrl+R never reload the webview (a reload discards the document) while a
Ctrl+R the app binds still runs; Ctrl+Y redo; the color picker's HEX field — six digits apply live,
shorthand applies on Enter or blur, Escape abandons a half-typed value — and RGB/CMYK fields that
settle a typed value once, on blur or Enter; palette, popover, and tooltip windows staying off the
taskbar and never stealing focus from the document; palette toggles that bring a palette hidden
behind the document to the front instead of hiding it; popovers and tooltips landing under their
button across two monitors at different scale factors; a maximized window restored maximized; and
the clipboard round trips (text, ChemDraft selection, SVG, PNG, and CDX/MDL paste from ChemDraw); and the app
updater — an older signed build offered the newer one by the launch check and by File ▸ Check for
Updates…, the document saved before the passive installer runs and restored after it relaunches, and
a branch build or `pnpm dev` session never checking (`docs/releasing/windows-updates.md`); an update
accepted while autosave is off (the last session unreadable) refusing to install over unsaved work; and
opening from Explorer a `.cdx` (the app says it is a ChemDraw binary, including at a cold start that
then restores the last session), a UTF-16 `.cdxml`, and a CDXML file whose molecules sit inside `<group>`
elements (they open grouped).

Undo/redo surfaces added since: Edit ▸ Undo/Redo from the menu and ⌘Z/⇧⌘Z — one press is one undo
on the canvas, and the same shortcut inside a focused text-entry field (the atom-label box, a
palette search box, a text object) undoes that field's own text instead; and typing half an atom
label, clicking a palette, clicking back into the label box, and finishing the label leaves it
intact rather than reverting or duplicating characters.

Aromatic surfaces added since: paste benzene, pyrrole, indole and porphine as type-4 MOL and as
CDXML `Order="1.5"` — formulas right, pyrrole-type N drawn NH, the tautomer badge shown only where an
N–H was inferred, and its reason in the status bar on hover; ring picking and atom clicks still work
over a badge; a CDXML pyrrole with `NumHydrogens` N-methylated leaves no stale badge; Copy As MOL and
CDXML of a pasted aromatic reopen with the same tautomer; and Spin 3D on a pasted aromatic.

Abbreviation surfaces added since: every table abbreviation (`packages/template-library/README.md`)
placed by hotkey and by typing on a chain end, where it is valid, and on a ring carbon, where it is
badged (hover the badge for its reason); Ome, OME and ome badged as unrecognized text with the "did
you mean OMe?" hint; a lone typed OMe badged, then given its one bond by the bond tool, which refuses a
second; OMe with a − charge (methoxide) unbadged; R, X, ? and a bonded Ar never badged; Ph–OMe showing
C7H8O; Copy As SMILES, MOL V2000 and V3000 of Ph–OMe pasted into another program as anisole; save and
reopen, CDXML export and reopen, and undo/redo of a relabel, all keeping the label "OMe".

Label anchoring surfaces added since: OMe typed on the left and right ends of a horizontal bond and
on a ring carbon, with the bond meeting the O each time and the label drawn "MeO" with its bond on the
right; the same for CO2Me (MeO2C), NHBoc (BocHN), and for Ph and TMS (the letter nearest the bond on
the atom), with the bond going up and down as well; SCN never drawn "CNS"; a label moved, rotated or
flipped redrawing the right way round while its formula and Copy As SMILES stay the same; Spin 3D on
a chain of three or more atoms ending in OMe, the label reading toward its bond as the overlay draws
it and turning as the bond swings to its other side (the overlay opens on the conformer's own view,
not the drawing's layout); SVG and PDF export matching the canvas; the label editor still opening
centred on the atom.

## External tools (macOS and Windows)

Install Claude Code and Codex from the dialog: confirm download progress, cancel part way through,
then retry successfully. Confirm the consent dialog names Anthropic or OpenAI and says the page
leaves the computer. Probe must find Homebrew, npm, WinGet, and `~/.local/bin` installs, while never
running a `.cmd` shim. Start sign-in: it opens Terminal on macOS / a new console on Windows, then
refresh status until it flips. Quit during a run and confirm no `claude`, `codex`, or `node` process
remains. On Windows, confirm no console flash and that the Job Object kills child processes.

## ChemDraft Assistant tools (macOS and Windows)

- Insert two macrocycles in one assistant request, then anchor one through the other with auto
  crossings. Confirm both remain separate molecules, each passes over and under its partner, and
  both are selected. One Undo removes the complete request; Redo restores geometry and crossings.
- Place an anchored figure past the right/bottom edge. Enlarge Page must grow the page and place
  the figure in one undo entry; Cancel/Escape must preserve the page and skip geometry, stacking
  and crossings with the explicit declined result. Repeat for an anchored move. Left/top overflow
  must refuse with an offset hint rather than moving a read-only anchor.
- Select only one existing crossing partner at Send: auto/explicit crossing writes must refuse
  the entire operation, name the other object, and leave chemistry and geometry unchanged.

On both platforms, stress the assistant's one-box controls:

- Upgrade from a Codex installed by an older ChemDraft: Setup offers Update; it installs and works.
- With the Main palette docked at the drawing-area top, drag the chat's top edge and its whole
  header upward to the limit: the header stays at least 72 px below the drawing-area top. Shrink
  the window, quit/relaunch, and verify the saved height fits the current cap. Drag down to shrink;
  double-click the header to restore the 280 px default height, showing about three transcript lines
  above the composer (or the available height in a small window).
- Type or paste 4,256 characters. The full draft remains, the counter reads “4,256 / 4,000”, and
  Enter and Send show “Your request is 4,256 characters; the limit is 4,000. Shorten it to send.”
  without starting a request. Shorten to 4,000 and send; the complete shortened draft is submitted.
  Check the same behavior in a plugin panel prompt.
- During a slow request, type another draft and try Enter and Send. Both show “Wait for the current
  request to finish, or press Stop.” The draft stays editable and no request runs automatically
  after the first finishes. The refusal hint clears when the request ends, when the plugin re-enables
  Send, when the draft changes, and when the document changes. Stop stays available; after completion,
  explicitly Send the kept draft.
- Relaunch, then expand the assistant icon before using its menu or Send. Its saved AI heading and
  status (or setup content on first use) appear immediately. Collapse/re-expand without resetting
  setup or conversation; initialization runs again only if plugin content is absent.
- Click Finish setup, New conversation, Stop, and other assistant action buttons, wait for completion,
  then type “draw aspirin”: typing goes into the prompt and the drawing tool does not change, even
  when the activated button disappeared. Click the drawing or Tab to another control before an action
  completes and verify completion leaves focus there. Tab to a still-mounted action without activating
  it and verify a content update keeps focus on that button.
- With an API 0.1.14 plugin, decline provider consent before a request is sent: the submitted text
  returns to the empty prompt without sending. Repeat while typing a new draft during the pending
  consent: restoration must preserve the new draft, including whitespace. Clear the draft afterward;
  unrelated status/transcript updates must not replay the restoration. A new `setContent` restoration
  can restore the same text once again. Immediately follow that restoration with `setContent` without
  `restoreDraft`: an empty prompt must still receive the text, without sending. While Send is settling,
  type and erase a new draft before the pending restoration applies: the prompt must stay empty.
- The collapsed icon is half opaque until hovered or focused. Drag it, relaunch, and check that
  its position remains remembered and its hover/focus feedback still works.

Exercise this section once the Assistant plugin is installed. Submit an insertion request and verify
that its objects land directly on the page (no approval window) and finish selected. One Undo removes
the entire request; Redo restores exactly those objects and selection without starting the AI or
making another provider/tool call. Select one existing object, then ask to edit, restyle, move, and
delete it: each is allowed; a request targeting an unselected object is refused. Repeat with nothing
selected: insertions work, while edits, restyles, moves, and deletes are refused.

Ask to draw a methyl group (`CH3`), `Ph`, `Boc`, and `OTs`: each is one editable native molecule
label, not a caption or placeholder. Compare rendering, formula and valence warnings with typing
the same isolated atom label on the canvas. Unknown labels are refused with accepted examples.
Mix groups, molecules and captions; check placement, selection, Undo/Redo, and the growth question
when the page is full. An isolated `Ac` is an element in the native grammar and must be refused as
a group rather than changed to acetyl.

On both platforms, insert an oversized labelled molecule, a tall text block, a reaction, and a set
that wraps past the bottom: one document-owned native box names the item and new page size;
Verify exactly two buttons on each platform: **Enlarge Page** and **Cancel**. Enlarge Page preserves
molecule size and grows the page, with one Undo/Redo restoring page and objects together. Cancel
omits non-fitting items and their captions but keeps fitting ones; the assistant reports the refusal.
Fitting calls never prompt. Esc or Cancel declines; Enlarge Page (Return where the platform makes
it the default) enlarges, and one Undo reverses it. Closing the box must also decline; if the platform
offers no close button, verify Esc instead. The native box is modal by design: its overlay Stop button cannot be clicked until
the box closes. Cancel is the stop for that item. Immediately after answering, verify Stop can again
cancel the remaining request and typing returns to the prompt.

While an Assistant MCP session is open, use `lsof -iTCP -sTCP:LISTEN` on macOS or `netstat -ano` on
Windows to confirm the listener is on `127.0.0.1` only, never a LAN address. Quit during a running
request: no Claude/Codex CLI process remains and the listener closes. Confirm web search works; its
consent text must say that it does and that page content can leave the computer.

## Plugin panel input and canvas overlay (macOS and Windows)

With an API 0.1.12 overlay-only plugin, use its Plugins menu command to expand and focus the
prompt; repeat `open` without `focus: true` while drawing and verify focus stays on the drawing.
Show setup text, key/value rows, buttons and an image above the transcript. Content should grow
the box only as needed, up to about 70% of the drawing area, with scrolling for overflow; clearing
it restores the user's remembered height. Repeat after resizing and moving the collapsed icon beside a ruler
and after changing display scale. Drafts and focus survive updates. Disable/remove a button while
clicking it: the stale control must not run. A plugin with no panel never shows an "Open …" link
or opens a native panel on menu commands, prompt submissions, setup actions, or re-expansion.
For a plugin that also has a panel, `showPanelLink: false` hides only the overlay's shortcut.

With an API 0.1.11 chat plugin, verify the compact overlay shows the latest reply and distinguishes
user, assistant, tool, notice, and error entries. Scroll back while replies arrive: the reader stays
put; returning to the bottom resumes following replies. Drag the top edge up and down: the bottom
edge stays fixed and the box cannot cross rulers, scrollbars, or the status row. Shrink the document
window and check the box fits again. Resize, Escape, expand, then reopen the document window:
height is remembered separately from icon/box positions. A second document window has its own size.
Enter still sends, Shift+Enter adds a newline, and transcript updates never steal input focus.

In a DEV build, open the `panel.fixture.chat` fixture panel (Fixture Plugin → Chat). Type a message
and verify Enter sends it while Shift+Enter inserts a newline. Repeat while composing with an IME:
the composition must not submit early. Force a host refusal (for example by making the panel stale
or disconnecting it) and confirm the inline host refusal keeps the draft; after host acceptance, the draft
clears. Confirm a panel report containing a prompt hides Run again. A refusal or failure from the plugin's
own command appears in that plugin's transcript or overlay status, while command failures also reach the
document status line. While the transcript grows, scroll
away from its bottom and submit or receive another report: it must not pull the reader down; submit
from the prompt and it may follow the new output. Keep typing while a report refreshes: focus and the
draft must stay in the textarea. Also invoke a plugin contribution at location `plugins` and confirm
its item appears and works in the native Plugins menu.

Exercise an installed or DEV canvas-overlay fixture: expand and collapse its icon, type and submit a
prompt, and check the status line. Drag it toward every viewport edge and resize the viewport; its
frame must remain clamped inside. Quit/reopen or hide/re-show the window and confirm its position is
remembered. Begin a drawing gesture and start an export: the overlay must be hidden in both cases
(and absent from exported output). Press Esc from the expanded overlay: it collapses and returns
keyboard focus to the drawing. It takes focus only when clicked or explicitly opened with
`focus: true`, never merely when content changes. Drag the collapsed icon more than four pixels: it must move without opening; a click
or slight pointer jitter must still expand it. Resize the box upward, then collapse: the icon returns
to its own position. Restart and verify both positions persist independently. Shrink the drawing area
while either mode is visible; neither mode may overlap rulers, scrollbars, or the status strip when
next shown, and the box must fit even when the drawing area is narrower than 300 px.

For a plugin that contributes both surfaces (including older Assistant packages), use its overlay's
"Open …" button and panel menu command. Each must show a titled report in a detached window.
Close/reopen it and repeat after restarting the app; the initial report broadcast may precede the
new webview, so the authenticated snapshot replay must also work. With the overlay-only Assistant,
Plugins → ChemDraft Assistant… instead expands the one box; setup and conversation stay there.

On Windows specifically, confirm the detached panel has no taskbar entry, actions and report updates
do not steal focus from the document or an actively typed prompt, and normal panel/overlay use does
not cause a foreground flash. Repeat the focus checks on macOS and Windows with the panel and drawing
window on separate monitors.

This list is repo-wide and cumulative. Add to it when a slice ships a new interactive surface; do not
replace it with a slice-scoped list, or the standing checklist is lost when that slice ends.

User-feedback surfaces added since: rotation snap on molecule, group, and art-object rotation —
magnetic absolute 15° multiples for whole objects, exact absolute multiples when Shift is held
mid-drag, and 15° increments for groups; held-mouse placement of bonds (including wedge, hashed,
dashed, and bold), rings, and templates snapping to absolute 15° multiples, with Alt/Option for
free aiming on both macOS and Windows. Drag a bond from an atom and empty space toward 23°:
the preview and released bond should both aim at 30°, or exactly 23° with Alt/Option held, at
standard length for short drags. From an atom, drag past about 1.4 bond lengths (including a 240 px
drag): check that the custom length and Å readout remain, with the angle still snapped unless
Alt/Option is held. Drag back below breakaway and check custom length stays unlocked. Aim near
the page edge: the endpoint should shorten to the edge while retaining its angle.
Toggle Alt/Option mid-drag, check the status hint (⌥ on macOS, Alt on Windows),
and verify release matches the preview, click geometry stays unchanged, and one Undo removes
the placement. Check straight chains' first bond snapping; flexible chains should follow a long curved
trace without rotating the path or showing a snap hint. Check a one-click ring placement,
a short toolbar press selecting the tool, a long press opening its flyout, and a ring clicked on a full atom
placing separately with an accurate status message; OMe, CF3, and NO2 typed over a hovered atom
building the label without activating the Eraser, including with an IME active; a text-box editor
surviving focus moving to a palette flyout or popover and back; an orbital lobe placed on an atom
putting its tip on the atom and rotating about that tip; a Text-tool click on an atom opening its
label editor and Convert Text to Atom Label working on a selected text box; centred double-bond
position from the inspector for a whole molecule and Shift-clicked bonds, by dragging the second line
onto the bond axis at 50%, 100%, and 200% zoom, and through Spin 3D and flatten; centred defaults
for acyclic C=X double bonds; status-line modifier hints on interaction start/end, tool changes,
and modifier presses/releases, including Shift toggled mid-rotation, Alt selection/eyedropper,
arrowhead sizing, stretching, measurement angles, and wheel zoom, with result messages retained,
held keys cleared on window blur, no focus stealing, hints hidden during inline text/label edits,
and macOS glyphs versus Windows key names (check all of these on both platforms); and sketch-style
hashed, dashed, and wedge bonds showing no line through the hashes.

On macOS and Windows, type OMe on all six atoms of benzene/cyclohexane, exercise nickname hotkeys and text conversion, then Enter/Tab/click-away/tool-change/Escape and Undo/Redo: check restored ring carbons, preview/commit placement, new-atom selection, valence guards, and specific status messages.
Save with an OMe draft open (the saved file has the attachment; the editor stays open), retype a ring SCN to its starting text (no split or Undo entry), place Text during an open OMe edit (Undo removes text, then the attachment), and Escape after another atom was recoloured (the recolour remains).

Cold launch on Windows: launch and quit ChemDraft ten times in a row, with its palettes open (on a busy
machine as well as an idle one); no "ChemDraft ran into an error" dialog appears at launch, and tool
shortcuts, palette commands, popovers and tooltips all respond afterwards.

Quit and close timing: on Windows, launch and close the document window (title-bar ✕) 2, 4, 6 and 20 s after
launch, and right after drawing, a hover-typed label and an undo; once the session is saved each exit follows
within about 2 s, even on a busy machine and while the palettes are still building their popovers and
tooltip, and the next launch starts a fresh process rather than handing off to a dying one. A preference
changed just before the close (Preferences, a keybinding) is still set on relaunch. Double-clicking a `.chemdraft`
while the app is exiting is ignored rather than shown in the dying window; once it has exited, the same
double-click opens a fresh app with that document. On macOS, ⌘Q
and the application menu's Quit the same way, with a palette open.

Ring placement valence: with the cyclohexane, benzene, and chair tools, hover and click a bond of
neopentane (a four-bond carbon): the ghost and the result are a separate ring, the molecule is
unchanged, and the status says an atom on that bond has no free valence; press 6 over the same bond
and check it refuses with the same reason; benzene and cyclohexane on a benzene or cyclohexane bond
still make naphthalene and decalin (both platforms). Label an atom OMe with one bond (the Atom Label
tool on a chain end, type OMe), then click a bond to it with the cyclohexane tool: the ring is placed
separately, the OMe and its bond are unchanged, and the status says an atom on that bond has no free
valence.

Open warnings list: open `packages/fixtures/cdxml/ten-metals.cdxml` (11 warnings) and
`invalid-element.cdxml` (3 warnings); the status line keeps "N warnings" (and says "1 warning" for a
one-warning file) after its text moves on; clicking it lists every warning with its message, what it
names (Whole file, a molecule by its CDXML fragment, or "Atom * in …"), and its code; Show selects that
molecule or atom with the Select tool; tool shortcuts work straight after any click there; Esc closes
the list without cancelling a drag or leaving the eyedropper, and with the list closed does what it
always did; File ▸ New or a cleanly opening file removes the count; and on Windows the list fits and
scrolls in a small window at 125% and 150% display scale.

Status row: at the 900×640 minimum window, open a file with warnings under a long name; the status text ends
in an ellipsis, "N warnings" stays whole and clickable, and the build stamp at the right never overlaps either,
in a branch build (long stamp with the worktree label) and in a stable build (short stamp), on both platforms.

1. **Document tabs, on macOS and Windows:** start with one document and confirm the tab strip is visible.
   File ▸ New and the + button after the last tab add and activate an Untitled tab inside the same
   document window. Tab to + and activate it with Enter and Space; confirm its "New tab" accessible
   name and tooltip. With many tabs, scroll the tabs and confirm + stays visible. The strip stays
   below the toolbar and above the canvas rulers, clear of the status row at minimum window
   size and 125%/150% display scale. Open, file drop and OS open-with reuse a never-edited,
   never-saved Untitled; otherwise they add a tab, and reopening a file activates its existing tab
   without replacing edits. Give three tabs different drawings, selections (including atom/bond
   fragments), undo/redo histories, warnings, zoom and scroll; switch by click and Ctrl+Tab /
   Ctrl+Shift+Tab and verify every state follows its tab. Check inspector/style controls, native
   palettes, Copy/Paste, Save/Save As, Export and Print against the active drawing. Close dirty tabs
   by their button and CmdOrCtrl+W: the native Save/Don’t Save/Cancel prompt blocks document actions and stays above floating native palettes.
   Cancel keeps the drawing, a cancelled or failed Save keeps the tab, and successful Save closes it. Close an
   inactive tab too; a clean tab's × closes without prompting. Close the only tab by ×, both clean
   and dirty: Cancel keeps a dirty drawing, Save closes only on success, and closing leaves one fresh
   pristine Untitled with no undo history. With one tab, CmdOrCtrl+W and the window close still close
   the window without prompting and keep the work in the session; with multiple tabs CmdOrCtrl+W
   closes the active tab with the dirty prompt. On macOS, the native menu reads Close Window for one
   tab and Close Tab for multiple tabs. Relaunch with only a pristine blank Untitled: the strip is
   visible with one fresh tab, and no restored-session announcement appears.
   Quit immediately after an edit with three tabs (one untitled and dirty, one pristine Untitled),
   then relaunch: all tabs, file associations, dirty states and the active tab return without a quit
   prompt. Repeat using a pre-tabs session file. Invoke a plugin and inspect the agent snapshot after
   switching tabs; both must use the active document. Keep the worktree label visible throughout.
   On **macOS and Windows**, open a named `.chemdraft` (also a `.cdxml`) from outside the default
   filesystem scopes, via a launch path argument / Open With. Edit it, close the window, and relaunch
   with no arguments. Verify the restored tab is dirty and Cmd+S / Ctrl+S writes those edits to its
   original path without a picker; reopen the file to confirm the bytes changed. Repeat via the
   dirty-tab close prompt's Save. Then quit dirty again, move/delete the original file before
   relaunch, and Save: a clear restored-file message and Save As picker appear, cancel keeps the
   drawing dirty with its content, and choosing a new location saves it. Check the same fallback
   for a restored path replaced by a directory or symbolic link; no linked target should be written.
   Queue a recognition proposal, switch tabs (also during recognition), and check its document name
   in review; Accept must activate and edit only its source tab with one undo entry. Close that tab:
   Accept must explain that its document was closed and keep the proposal pending; Reject must work
   from any tab.


Kept drawings at launch — run on **macOS and Windows**: with ChemDraft quit, back up the dev
build's `document-session.json`, then change one saved tab's document schema in its `contents`
to `chemdraft.document.v999` (leave the session envelope version unchanged). For a CDXML native
payload, change the Value of the `org.chemdraft/schema-version` objecttag; for legacy JSON,
change `schema`.
Relaunch: readable tabs open and one native summary box says “1 drawing didn't open”, explains
why the drawing is kept, and lists its name. Repeat with several tabs: one summary box lists all
names and offers exactly Save Drawing…, Delete and Cancel. Its message says “Cancel keeps the
drawings for the next launch.” Cancel, Escape (including macOS) and closing the box keep all
drawings; relaunch asks again and retries their contents. Save Drawing… opens a native save panel
for each drawing, suggesting its name and extension, and writes its exact saved text to the path
chosen. A successful save removes only that drawing. Canceling a panel returns to the summary
box, keeping that drawing and all unattempted ones; a failed write shows its reason in the next
box without losing the drawing. Delete opens a second native confirmation saying “Delete the
kept drawing? This cannot be undone.” Cancel occupies the ok/default slot; Delete occupies the cancel slot.
Escape declines except for the known Windows issue below. Cancel returns to the summary; Delete removes
the kept drawings. Floating toolbars stay
hidden through the entire sequence, including save panels, failed saves and both confirmation
boxes, then return once it ends. Check there is no in-app dialog and no recovery File menu item.
Restore a kept drawing's supported schema and relaunch: it opens normally without a prompt.

Native simple prompts — run every item on **macOS and Windows** with the floating Drawing, Rings,
and Art toolbars open, including at 125%/150% display scale:

- For every prompt below, confirm the message box uses the OS appearance, stays above the floating
  toolbars, and belongs to the document window. Every prompt with a choice shows a button labelled
  exactly Cancel, and Escape (on macOS too) and closing the box choose it, except for the known Windows
  issue below; a notice has one OK
  button that Return dismisses. No button appears twice. A destructive single-action confirmation (Delete,
  Clear Overrides, Remove Engine) puts Cancel in the ok/default slot and the action in the cancel slot.
  A non-destructive single action (Enlarge Page) occupies the ok/default slot, with Cancel in the cancel slot.
  Known pre-existing Windows issue (tracked for a separate fix): Esc on a destructive single-action confirmation currently returns the action; expect and report it.
  Repeat in the web preview with `?agentBridge=1`: the retained in-app dialog renders and its buttons
  and Escape produce the expected outcomes without the native Windows issue.
- With Main, Art, Drawing and Rings toolbars visible, open a native box. All floating toolbars,
  open flyouts/popovers, tooltips and visible plugin panels disappear. Click where a toolbar was:
  nothing happens and the active drawing tool stays unchanged. Close the box: exactly the previously
  visible windows return at their original positions; hidden or minimized windows stay that way.
  Repeat with overlapping prompts: windows return only after the last box closes. Inspect
  `toolbar-state.json` during the box: temporary hides and frames must not be saved. Disconnect the
  monitor holding a toolbar while the box is open: closing it recovers that toolbar onto a visible
  monitor. Quit while a box is open: dismissing it must not resurrect floating windows.
  Open/save panels (including Save As, exports, template, image and plugin pickers) keep toolbars,
  popovers, the tooltip and plugin panels hidden until the last box/panel closes. A close prompt →
  Save panel → canceled-save re-ask keeps them hidden throughout, then restores them on every ending.
- Close a dirty foreground or background tab: Save / Don’t Save / Cancel. Cancel retains drawing,
  selection, dirty state, and history; Don’t Save removes only that tab (or leaves a fresh Untitled
  when it was the last one). Save closes only after success. Cancel the save picker, simulate a write
  failure, and edit during a slow save: the tab remains open and the next prompt includes the reason.
  Queue an OS open-with while prompted: it waits, and Save still writes the prompted drawing.
- Import oversized CDXML or paste oversized content: "Change the page to … to fit the imported
  content?" Use the recommended page (e.g. Use A3 Page) / Cancel. Escape keeps the original page and overflow; resize remains one undoable layout operation and
  preserves chemical identity and editable objects.
- Apply a whole-molecule appearance change to a molecule with per-ring attributes:
  Keep Overrides / Clear Overrides / Cancel. Cancel changes nothing; Keep retains ring attributes;
  Clear removes them for the selected molecule with the existing labelled undo entry. Undo restores
  the attributes. Enter must not choose Clear Overrides.
- Request the local recognition engine: Install / Cancel (or Install engine again / Cancel).
  Escape declines without installing; Install starts only on that choice. The progress dialog stays
  in-app, keeps byte/phase feedback, and Cancel still stops only an install owned by that request.
  An unsupported-computer notice has only OK and never installs anything.
- Uninstall the recognition plugin, then answer "Also remove the recognition engine?" with
  Keep Engine / Remove Engine / Cancel. Keep Engine is the default; it, Cancel and Escape leave the
  engine on disk; Remove Engine deletes only the engine and reports the same result.
- Open an image request with no available source: OK acknowledges the specific reason and
  cancels that request; no image acquisition or recognition runs.
- Open a file whose visible CDXML disagrees with its embedded document: Import Visible CDXML /
  Restore Embedded / Cancel chooses the same document as before; Cancel and Escape restore the
  embedded document. Open the same file again while its choice is still showing (wait more than
  two seconds): after answering, there is one tab for the file, never two.
  If no visible subset can be read: Restore Embedded / Cancel, and Escape cancels the open.
- Crash-report consent: Email Report / Cancel. Escape creates no email draft; Email Report opens
  the same reviewable draft. On Windows, check app-update consent (Install and Restart / Cancel) and
  informational result boxes (OK): cancellation does not install; accepting keeps the existing download/install/session-flush flow.
- Windows document-window close still flushes the session and quits (without a new dirty-tab
  prompt); relaunch restores every retained dirty tab. Check the same session retention on macOS.
- On both platforms, leave “Ask to save unsaved changes before quitting” off and verify the
  existing quit/session-recovery flow. Turn it on: clean tabs quit without a prompt, and a dirty
  foreground or background tab opens a native Save / Don't Save / Cancel message box with
  floating palettes hidden. If the native box cannot open, check the accessible in-window
  fallback instead; it must expose the same choices and keep palettes hidden.
  Cancel and Escape keep the app open; Save writes all dirty tabs before quitting. Cancel a save
  picker or fail a write: the app stays open. Discard quits with existing session recovery.
  Leave the prompt open beyond three seconds, then cancel and quit again. A document window
  that never answers the quit event must still quit after the native grace period.
- Keep dirty tabs A and B open, request closing B, then Quit before answering its close prompt:
  Save must write both documents to their own paths. Repeat with untitled tabs and cancel each
  Save As picker. Delay a Cancel reply and request Quit again: the newer prompt must remain.
  Stall the session flush after Save and after Discard: quit must still use the bounded grace
  and Windows exit watchdog. Toolbar/Preferences/debugger calls to prompt-control commands
  must be refused. On macOS, hide the dirty document with the red button and use app-menu or
  Dock Quit: the window must reappear with a visible prompt. Repeat minimized, with the
  preference off, and during system logout/restart/shutdown (which must not wait for a prompt).
  If an OS tab-close alert is already visible, answer it first; only afterward should the quit
  modal appear. While cancelling or saving, native Undo and queued OS opens must not mutate
  the documents. Hide/minimize after the quit modal appears and request Quit again: the prompt
  must be raised again. Cancel must balance suspension even when its acquisition is still pending.

## Compound layout tools (opt-in)

On macOS and Windows, verify that a fresh Settings/Preferences has Compound layout tools off and
no layout button/flyout/context/gallery entry is visible. Enable it with a native palette open;
Main, Art and Layout should update live. Select unequal-size compounds, optionally grouped captions,
and open Arrange › in the selection context menu. Try Circle, Oval, all three Grid justifications,
Row and Column; check click, hover and keyboard access to the submenu. Confirm unchanged bond lengths,
labels and stereo, selected compounds retained, one Undo/Redo step, and no generated arrows.
Switch Circle/Oval/Grid to Row and Column on a page too small for their usual gaps but large enough
for the compounds: gaps tighten evenly, molecule sizes stay fixed, and one Undo restores the former
layout. If even 12 document pixels between compounds will not fit, the drawing stays unchanged.
Group a molecule with a wide caption rotated 90°, then arrange it with other compounds in each
layout and adjust spacing. Keep the rotated caption inside the page and clear of other items,
retaining its angle, size, text and offset from the molecule. A caption taller than the page
after rotation must cause a fit refusal with no document change.
Open Adjust spacing on macOS and Windows: it must be a movable, resizable native window,
centred over the document on first open, with the originating drawing in its title, no utility menu,
and no Windows taskbar entry. Move it to another monitor, close, and reopen; retain position.
Reopen while still open: retain slider draft and focus the existing window. Check Escape,
Cmd/Ctrl+W, title-bar close, Tab, Enter, IME composition, and reload prevention.
On page two, preview Adjust spacing: only that page appears and Save changes only that selection.
Check the full white page and outlined boundary against its gray surround. Move the slider:
the page framing and molecule sizes stay fixed. Spreading stops at the page edge or 150%.
Try initially overlapping compounds with space to expand: a feasible expansion must be reachable
even if 150% exceeds the page. Intermediate overlap values show an error and disable Save.
Align a row or column with a page edge using decimal coordinates, then reopen Adjust spacing:
valid expansion/compaction remains reachable; rounding alone must not pin the slider to 100%.
Place a sticky charge label near a neighboring atom, then arrange, adjust spacing,
Undo/Redo and save/reopen. Layouts and spacing keep the charge on its original atom.
Switch tabs before Save: change only the original tab, keep it selected there, and Undo once there.
Change the source drawing while its preview is open: stale Save must fail without an undo entry.
Close/replace its drawing or quit during startup: no orphan or late mutation. Rapidly drag the slider:
Save stays disabled until the latest complete preview arrives and double Save commits at most once.
Native creation failure must report an error, never show an in-page desktop fallback. Check the
browser-only shared form separately. Check native prompt hide/restore and Cmd-Tab/Alt-Tab behavior.
Cancel/Escape makes no change. Check close/far/page limits and native save/reopen. Disable the setting
with a preview/flyout open: it closes, controls disappear and direct commands report why unavailable.

- Export preview and presets (macOS and Windows): with a fresh profile, verify Preferences >
  Export preview and size presets is unchecked. Export must show the original Scale/Max dimension
  controls and JPEG quality slider, prefill the last destination, and let Choose work with an empty
  filename. Confirm no preview requests, frame computations, native rasterizations or preview IPC.
  Toggle the preference on with Export already open: the preview and presets must appear live.
  Toggle off while rendering and while Choose is open: legacy controls return and stale previews
  must not appear. Reopen Export and restart to verify persistence. Compare saved files with equal
  options in both modes (fix PDF time/ID when comparing bytes). With the preference on, export molecules, text, arrows, and an
  object crossing the page edge. Compare preview with saved SVG, PDF, and PNG; check clipping
  warnings. Switch slide/poster/publication presets and edit linked pixel/physical dimensions.
  The 7200 px poster preset must keep preview rendering at most 800 px on its longest side;
  only the saved export uses the requested size. Choose content crop and transparent PNG,
  verify JPEG numeric quality changes the preview, and check PNG density/PDF physical dimensions.
  The PNG density hint must be absent until explicit sizing is set. Type an atom label without
  committing it and verify the preview matches the pending edit and the final export.
  Close during rendering and switch formats rapidly: stale previews must never replace the
  current format, and updates remain debounced. Repeat each preset with an empty portrait
  Letter page and a tall drawing; submit after editing pixels and physical dimensions.
  Verify saved SVG millimeter dimensions and PDF drawing bounds match the displayed physical
  size. Request 8190 x 4095 px at 36 DPI in PDF: a specific 14400-point limit message must
  prevent export without clipping. Typing a filename must not rerun the content crop.
  Verify Enter submits a valid export, unlink/relink dimensions, clear and retype numeric
  values, and check manual edits select Custom. Navigate presets with arrow keys: dimensions
  change only on Enter or leaving the field. Choose a file, change format/name, then cancel
  and retry the new location picker; only explicitly chosen paths may be written, and
  failures must show inside the dialog. Check rounded SVG units. With a ring and arrow, PDF
  must show both in the image labelled “Preview of the PDF page layout”, with no embedded
  PDF viewer or extra tab stop. Toggle PDF page guides and compare with the exported PDF.
  Repeat previews for BMP, GIF and TIFF. Keep Export open while editing its source drawing,
  including edits that preserve its bounds: the preview must refresh and keep the filename and
  size settings. Repeat while another drawing is active and while Choose is pending, then cancel
  Choose. The refreshed preview and final file must describe the originating drawing.

## Name from Structure (Orthonym) (macOS and Windows)

- Structure ▸ Convert Structure to Name inserts the verified name below the structure; Structure ▸ Convert Name to Structure… opens the OPSIN prompt; both items appear only when their plugin is installed (macOS app menu and Windows document-window menu).

- Install the Orthonym plugin from a package. Run Name from Structure with the engine absent: the movable
  “Naming needs a local engine” dialog opens owned by the document window, centred the first time (no
  Windows taskbar entry), and the floating toolbars stay usable beside it. Move it, close it, reopen
  it: it returns where it was left.
- Start the install and cancel partway: no `naming-engine.partial` remains and no python or java
  process is left running (Activity Monitor / Task Manager). Then run the full install to completion.
- Name each of these and read the result: ethanol (a PIN), aspirin, L-alanine (the stereo warning is
  shown), a sodium salt, TEMPO (a radical). Isotope-labelled structures cannot yet be drawn; their
  exact-match handling is covered by the real-RDKit test (`pluginStructureNaming.rdkit.test.ts`).
  Glycine zwitterion is declined with no name;
  `[Fe]` is declined as an unsupported element. A declined structure never shows a guessed name.
- Select several molecules: one row each, capped at 10. Copy puts exactly the name on the clipboard
  and nothing else. Insert Name as Text adds one text object below the molecule with one undo entry;
  undo removes it, redo restores it.
- Quit with the sidecar running: no python or java process remains afterwards. Use Remove engine and
  confirm the engine folder is gone and Name from Structure offers the install dialog again.
- Intel Mac: Name from Structure reports the engine unsupported rather than offering an install.

## Native Custom Page Size (macOS and Windows)

- From this worktree's labelled build, open Custom Page Size. Verify the first opening is centred
  over the document with a movable native title bar, and the title/form name the originating drawing.
  On Windows verify no separate taskbar entry; on macOS verify a floating-level focusable document child,
  not a sheet. Confirm no utility-window menu is attached.
- Drag the dialog over a floating toolbar and plugin panel, then click the dialog: it must come
  in front. Click the toolbar: it must remain usable, including flyouts and tooltips above it.
  Reopen the retained dialog: it must come forward. Repeat on macOS and Windows; neither platform
  should gain global always-on-top behavior. With the dialog in front of a toolbar, open and dismiss
  a native box: preserve that dialog-above-toolbar order.
- On macOS, move an open dialog, then Cmd-Tab to another application: the dialog and toolbars
  must hide. Cmd-Tab back: preserve the dialog's position and sibling stacking; reopen it and
  click its fields to confirm focus still works. Repeat with a native confirmation box open:
  the suspended dialog must stay hidden when returning, then restore in place only after the
  box closes. Also dismiss the box while inactive and return: restoration must wait for activation.
  Quit with the box open: no dialog may reappear during teardown. On Windows, verify the existing
  document-owned dialog behavior with Alt-Tab and a native box remains unchanged.
- Leave it open and draw, use shortcuts and floating toolbars, then switch tabs. Apply to the
  original drawing while another tab is active; the visible drawing must stay unchanged. Return
  to the original drawing and Undo once: restore its former page size and margins. Close that tab
  while the dialog is open: its dialog must close too.
- On a pristine Untitled tab, open Page Size, then open a saved file into that same tab. The old
  dialog must settle without changing the file. Repeat with a tab closed immediately after choosing
  Custom Page Size, while the dialog is still starting: no late window may appear.
- Choose Custom Page Size twice for the same tab after moving it and editing a draft. The existing
  window must come forward with field focus, its draft and its position intact. Double-click Apply
  or press Enter repeatedly: one change and one Undo entry; Apply stays disabled through closure.
- Move it beyond the document bounds and onto another monitor (including mixed DPI), close and
  reopen: remember its position without recentering. Remove that monitor and reopen: recover onto
  the document monitor with the whole title bar reachable. Verify the dialog's minimize control is
  disabled/absent on both platforms. Minimize/restore the owner and repeat; choose Custom Page Size
  again and verify the retained dialog is visible and focused, never stranded minimized.
- Windows mixed-DPI pass: use 100% and 150%/200% monitors, including a negative-coordinate display
  and a taskbar-reduced work area. Keep the owner on the 100% monitor, save the dialog near the
  bottom-right of the high-DPI display, close, and reopen. Verify its client is about 420 × 300
  logical pixels (not scaled twice), the full measured frame stays inside the work area, and the
  title bar remains reachable. Repeat in the opposite direction with the owner on high DPI. Drag
  rapidly across displays, close immediately, and reopen: retain the final genuine position.
  Disconnect the remembered monitor and reopen: recover within the owner's work area. Repeat
  after owner minimize/restore and after native-box suspension; no restore movement is saved.
- Open a native message box and a file picker with Page Size open, including nested boxes. Verify
  it hides with the toolbars and returns in the preserved #140 stacking order, without changing
  remembered toolbar visibility or frames. Close the dialog during suspension: it must stay closed.
- Check first-field focus, invalid dimensions, valid Enter, IME composition Enter, Escape,
  title-bar close, Cmd/Ctrl+W, field-local Undo/Redo, and reload prevention. Test screen-reader labels.
- With a dialog width/height field focused on macOS, use Cmd+A and Edit > Select All. Only that
  field's contents are selected; the drawing selection stays unchanged. Repeat with no field focused.
- Quit while it is open and while it is still starting: quit promptly after session flush, with
  no dialog restored during teardown. On macOS document Close must dismiss it before hiding the
  document; reopening the document must not resurrect the dismissed dialog.
- In the browser preview, check the same form/validation in the documented in-page fallback.
  Force native creation failure on desktop: show an error and never display the browser overlay.

## Native Export (macOS and Windows)

- Launch this worktree's labelled build. Choose Export and verify a movable native window centred
  over the originating drawing on first opening, about 520 × 620 logical pixels. Resize to its
  420 × 360 minimum: all controls and messages remain reachable by scrolling. There is no minimize
  control and no utility-window menu; Windows has no separate taskbar entry. On macOS measure its
  floating level and confirm it is unparented, matching Page Size.
- Leave Export open and draw, use the floating toolbars and shortcuts, switch tabs, and export.
  The file must contain the originating drawing as it was at the press, including edits made after
  opening. Verify a live atom-label/text edit is included. The other tab must stay active and
  unchanged. Close the originating tab, or open a saved file into its pristine tab: Export closes.
  Repeat during startup, rendering, and a picker round trip; no stale write or late dialog appears.
- Check filename, format, destination, SVG warnings/page guides, PDF compression/page guides,
  raster scale/background/size/JPEG quality, CDXML creation program, and unavailable formats against
  the existing export behavior. Compare files with the same options against main (PDF comparisons
  must hold metadata date/ID constant); raster output must use the same SVG and raster options.
- Move Export off the document and onto a second monitor. Reinvoke Export with a draft: focus the
  same window without moving or resetting it. Close/reopen and verify its saved position. Repeat
  across Windows 100% ↔ 150%/200% DPI, negative-coordinate monitors, work-area edges, monitor removal,
  and owner minimize/restore. Page Size's saved position must be independent.
- From Export itself choose a location. While the native save panel is open, Export and utilities
  hide. Accept, cancel, then repeat with a panel failure: live Export returns at the same position,
  in the preserved stacking order, and its fields/buttons work. Repeat after changing apps while
  the panel is open. The hidden toolbar stays hidden; dialog moves never move toolbars. Close the
  source document or quit during suspension: no closed Export window returns.
- Choose a path, then change the filename or format. Export must ask for a new grant, and write
  exactly the newly chosen path. Repeat with a path without an extension and with a different
  extension: no silent `forbidden path` error or additional file. Check ordinary accepted grants
  are used directly when options are unchanged.
- Double-click Export, press Enter repeatedly, and simulate delayed rendering/writing: one press
  writes at most one file. Success and warnings remain in Export, with Export disabled and Close
  available. Force a denied/unwritable destination or full-disk error: the failure is visible
  inside Export and an explicit retry works. Cancel a save panel: Export remains usable.
- Verify filename focus on opening; valid Enter submits, invalid values and IME composition Enter
  do not. Tab/Shift+Tab remain inside the native window. Escape, title-bar close and Cmd/Ctrl+W
  cancel; field Undo/Redo and Select All stay local. F5 and Cmd/Ctrl+R must not reload the webview.
- Overlap Export with toolbars/panels, click each, and use toolbar flyouts/tooltips. Reopen Export,
  then open/dismiss a native message box or save panel: preserve the prior relative stacking.
  Cmd-Tab on macOS hides Export with the utilities; switching back restores it without AppKit
  attachment or a level change. Repeat Windows Alt-Tab and owner close/quit.
- In the browser preview, verify the shared in-page Export form and validation; raster formats
  remain desktop-only and supported exports download. On desktop force native creation failure:
  report the error without an in-page fallback.

### Export dialog regression checks (macOS and Windows)

- At default size and minimum size, with PDF options and long warnings, scroll the body and verify
  Cancel/Close and Export stay visible; repeat in the browser build.
- With focus on a field and then on the page body, try Escape and Cmd/Ctrl+W before export, while
  busy, after an error and after success. Each closes Export; success first focuses Close.
- Open Choose from Export and both Save and Cancel the native picker. Export becomes key/active
  again. Repeat an Export that needs a picker. Close the source tab while the picker is open and
  confirm no closed or newly reopened Export receives focus. Switch to another app before the
  picker completes and confirm ChemDraft does not take foreground.
