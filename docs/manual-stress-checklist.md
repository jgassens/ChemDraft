# Manual stress checklist

The standing hands-on checklist for interactive surfaces. It moved here from `AGENTS.md` §20 when that
file was consolidated (2026-10-04); `AGENTS.md` §14 still requires it. Run every item on **macOS and
Windows** unless the item names one platform. `docs/windows-port-stress-test.md` records the Windows
port's own hands-on pass.

Manual stress must cover tab initialization, user tab persistence, mixed states, multi-molecule
scaling, sparse override precedence, terminal carbon labels, hidden implicit hydrogens, explicit
hydrogens, fonts, save/reopen, undo/redo, Spin 3D, atom-label editor placement, SVG export, and ring
selection after tab switching/closing.

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
kept drawing? This cannot be undone.” Its default button and Escape are Cancel. Cancel returns
to the summary; only an explicit Delete there removes the kept drawings. Floating toolbars stay
hidden through the entire sequence, including save panels, failed saves and both confirmation
boxes, then return once it ends. Check there is no in-app dialog and no recovery File menu item.
Restore a kept drawing's supported schema and relaunch: it opens normally without a prompt.

Native simple prompts — run every item on **macOS and Windows** with the floating Drawing, Rings,
and Art toolbars open, including at 125%/150% display scale:

- For every prompt below, confirm the message box uses the OS appearance, stays above the floating
  toolbars, and belongs to the document window. Every prompt with a choice shows a button labelled
  exactly Cancel, and Escape (on macOS too) and closing the box choose it; a notice has one OK
  button that Return dismisses. No button appears twice. Enter must never choose a destructive
  action. Repeat in the web preview with `?agentBridge=1`:
  the retained in-app dialog renders and its buttons and Escape produce the same outcomes.
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
