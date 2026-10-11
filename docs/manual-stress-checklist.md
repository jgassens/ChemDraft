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
