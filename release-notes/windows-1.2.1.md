# ChemDraft 1.2.1

ChemDraft 1.2.1 improves drawing, file exchange and dialogs, and fixes problems found after 1.2.

## What's new

### Drawing

- **Lone pairs.** A new lone pair goes into the largest free space around its atom; press and drag to place it. Near the page edge it moves to the next free space.
- **Electron marks.** Drag a selected charge, radical or lone pair from its center to move it; corner handles resize it. Dragging a mark away from its atom detaches it and updates the atom's chemistry; Undo restores it.
- **Plain bonds.** Press 1 over a wedge, hashed or wavy bond, or click it with the Single Bond tool, to make it a plain single bond.
- **Selection and paste.** A Shift or Alt marquee or lasso adds to the selection without dropping selected atoms. Pasting a copy still in place offsets it; repeated SMILES and text pastes are offset too.
- **Repeat units.** Mark a repeat unit from selected atoms. A selected bracket shows its edited label immediately.
- **Rotation.** Rotation handles follow the angle swept by the pointer, with Shift snapping to 15-degree increments.
- **Inspector.** The Molecular Inspector analyzes the structure when opened and refreshes as the selection changes. Mixed electron-mark sizes and strokes are shown as mixed.

### Chemistry and files

- **Rectangles.** Filled rectangles with rounded corners or a shadow keep their fill in CDX and CDXML; shaded rectangles keep their gloss fill. See the color limitation below.
- **Polymer brackets.** When a CDX or CDXML file leaves a bracket group's type unspecified and its two brackets specify different types, ChemDraft keeps the type unspecified and warns on import and export, instead of changing it on a round trip.
- **Reaction arrows.** Reaction arrows keep their direction in CDX and CDXML. One-headed equilibrium arrows and older hollow arrows open unchanged.
- **MOL and SDF.** Export uses standard MDL coordinate units. If scaling would change the structure, ChemDraft refuses the export and explains why; if it cannot check stereochemistry after scaling, it keeps your drawing's coordinates and shows a warning.
- **Opening files.** Choosing several files opens each one, and a file that fails to open is named in the message.
- **Charged atoms.** Opening a file or restoring a session no longer removes a charge whose + mark sits away from its atom.
- **File warnings.** File warnings appear in their own window above floating toolbars. Out-of-range numeric CDX data is kept as text with a warning, and page-specific data stays on its page.

### Windows and dialogs

- **Right-click menus.** Canvas right-click menus use system menus. Floating toolbars, dialogs and panels no longer offer a Reload command that could discard the document.
- **Dialogs and panels.** Insert Table, Reaction Conditions and Export fit their contents, and invalid fields are marked. Dialogs, palettes and panels reopen where they were left, with their title bars reachable.
- **Toolbars.** Add command… is available on every toolbar, and toolbars are sized to their contents.
- **Inserts.** Structures from a picker, Name to Structure or image recognition are placed outside dialogs covering the page.

### Plugins and the assistant

- Plugins receive a clear reason when their chemistry input is invalid.

## Fixes

- Quitting keeps unsaved edits in open table cells, captions, footnotes, repeat-unit labels, text boxes and atom labels, and restores them in the next session.
- Deleting, cutting or erasing the last contents of a repeat unit also removes its empty brackets and label in the same Undo step.
- Charges, radicals and lone pairs follow their atoms through Arrange, Spacing and Align; a mark moved on its own stays put.
- The Molecular Inspector reanalyzes after an edit that changes chemistry, such as making a bond dashed; color-only edits do not trigger a new analysis.
- Condensing a reaction label keeps the structure's stored chemistry up to date for later edits and exports.
- Clean Up explains when a selection has only unconnected atoms and keeps ring double-bond strokes inside the ring.
- Typing a monovalent label on a ring carbon replaces that vertex. The phenyl shortcut preserves existing bond orders, and the terminal alkyne shortcut grows straight.
- Center- and right-aligned text boxes keep their anchor while typing. The bold shortcut works in the text editor.
- The status line describes mixed selections and counts only objects that moved. Undo and Redo work while an atom-problem badge has focus, and Ignore closes its window.
- Export closes after a clean export and retains its preview and format choices. Reaction-condition frames follow tilted arrows in exports, tilted repeat-unit labels are not clipped, and PDF export warns when bold or italic cannot be retained.
- Name to Structure places results on the visible page and shows failures in the status line.
- Spin 3D refuses to flatten a structure when doing so would change stereochemistry, a coordination bond or a polymer repeat unit. For axial stereochemistry (allenes and atropisomers), flattening commits with a warning: this stereo is kept only in the 3D model and is lost on export or a later structural edit.
- The menu bar stays responsive during long sessions.

## Known limitations

- Embedded objects in CDX and CDXML files, such as pictures, and spectra are not imported. ChemDraft shows a warning when you open such a file.
- Documents imported from CDX/CDXML and saved in 1.2 or later need ChemDraft 1.2 or later to reopen. If you delete a member atom from an imported repeat unit, the saved document requires ChemDraft 1.2.1 or later to reopen.
- In a document with a non-black foreground color, uncolored text reopens as black rather than the default text color from a CDX saved without embedded ChemDraft data. Saving with the embedded data keeps it exactly.
- CDX and CDXML keep one color per rectangle. When fill and outline differ, ChemDraft keeps the fill unless it is white or the page color, in which case it keeps the outline. A warning appears when a color cannot be saved.
- If you open a file while ChemDraft is asking whether to save before quitting and then choose Don't Save, that file may not open. Open it again after relaunching.
- An equilibrium arrow you edited to a single open head can reopen as a retrosynthesis arrow from a CDX or CDXML file saved without embedded ChemDraft data if you changed the Creation program field in the Export dialog.

## Windows

Download the Windows x64 installer and run it to install or update ChemDraft. Open CDX and CDXML files from within the app; the installer does not take over their file associations.

When you sign out of Windows or shut down, ChemDraft tries to save your session. Save your documents first to be sure. Keyboard input reaches an open, visible toolbar flyout and does not activate a hidden flyout.
