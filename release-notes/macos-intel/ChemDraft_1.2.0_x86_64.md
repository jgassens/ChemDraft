# ChemDraft 1.2

ChemDraft 1.2 adds new drawing controls, more ways to exchange chemical files, and an Intel Mac download. It also fixes problems with editing, exported drawings and Windows controls.

## What's new

### Drawing

- **Unknown stereochemistry.** Use the new wavy single bond to show that a stereocenter is unknown. Spin 3D will ask you to reorient the molecule if flattening would lose or reverse that mark.
- **Brackets and repeat units.** Draw matching round or square brackets in one action and add an editable repeat-unit label.
- **Reaction conditions.** Add formatted, multiline conditions to a reaction arrow in a movable editor; the labels follow the arrow as you move or transform it. To use this desktop feature, turn on Compound layout tools and then Formatted Reaction Conditions in Preferences. Thanks to Emily Osborn for this work.
- **Electron marks.** Adjust the size and thickness of charges, radicals and lone pairs. An optional preference adds direct resize and rotation handles; moving a charge or radical to another atom also moves its chemistry, with the change shown in the status bar. Thanks to Emily Osborn.
- **Wavy art lines.** Adjust the smoothness, height and width of a wavy line in the inspector. Thanks to Emily Osborn.
- **Drawing preferences and shortcuts.** Choose offset or centered lines for newly drawn double bonds. Nudge a selection with the arrow keys, or hold Shift for a larger move; hover over a bond and press W or Shift+W for a wedge or hashed wedge.
- **Custom colors.** Add your own color swatches to the main toolbar with Customize Main Toolbar ▸ Custom Color Swatch. Enter colors as hex, RGB or CMYK; they apply to bonds, atoms, text, arrows and shapes and are remembered between sessions.
- **Journal styles.** Apply ACS 1996-style or RSC journal-style drawing presets to a selection or the whole document. Thanks to Fairuz Tahia for the sourced journal values and contribution.
- **Page size.** When an insertion or automatic layout would extend beyond the page, choose whether to enlarge the page or keep its current size.

### Chemistry and files

- **CDX files.** Open, save and export binary CDX as well as CDXML. Save As keeps ChemDraft's drawing information for reopening; Export creates a plain CDX file. Some objects or formatting may be approximated or cannot be represented, with warnings where applicable.
- **Name to Structure.** If a name is not recognized by OPSIN, an offline dictionary can also find common names, trade names and CAS registry numbers.
- **Search by structure.** Search a selected structure in PubChem or Reaxys from the Tools menu. The first search on each site explains that the structure is included in the web address and browser history; online structure search can be turned off in Preferences.
- **Unusual valence.** Drawing an unusual valence no longer blocks the edit. A clickable (!) badge explains the problem and offers fixes; exports warn about invalid structures.
- **Newer documents.** ChemDraft can preserve supported unknown content from newer versions and warns when it must approximate a visual feature. It refuses changes it cannot safely interpret as chemistry. A bond whose order it does not recognize is drawn dotted and kept as it was saved.
- **More abbreviations.** TBDPS, TIPS, TES, PMB, MOM and SEM, including their recognized oxygen-prefixed forms, are available as protecting-group labels.

### Windows and dialogs

- **Better-fitting dialogs.** Dialogs open sized to their contents, grow when their content changes, stay within the screen and keep action buttons visible. Preferences remembers where it was left, including when it is closed with the window's close button, and Escape closes a toolbar flyout opened with the mouse.

### Plugins and the assistant

- Plugins can use the same chemical properties shown in ChemDraft's analysis and can offer additional tools to an assistant session, subject to their permissions.
- For plugin authors: a plugin may change only the objects that were selected when its command started, plus objects it inserts. ChemDraft now refuses a plugin change that would touch anything else, including indirect effects such as moving a molecule out of an unselected repeat-unit bracket, and the message names the object. When inserted objects reuse existing IDs, ChemDraft renumbers them together with everything that refers to them (bracket pairs, crossing bonds, reaction-condition attachments).

## Fixes

- Export removes a known extension before adding the right one, gives unsaved documents a sensible name, and hides formats that are not yet available.
- Structure search sends only the selected structure and refuses selections that touch a polymer repeat unit.
- Bracket labels, including edits in progress, are saved.
- Preferences opens correctly when the document window is minimized.
- Checking for updates in a development build now explains that updates are turned off.
- Structures inserted from names are placed in free space when available.
- The text-box status message clears when editing ends.
- The interface now uses American spelling.
- The rebuilt chemical-name dictionary compares full chemical identifiers so names resolve more consistently.
- Exporting a reaction scheme with a condensed NaOH label to CDX or CDXML now places the Na⁺ and OH⁻ ions beside their label instead of farther out.
- Structure search no longer refuses a structure because an empty polymer bracket was left behind after a delete, and it still refuses a structure that an unresolved bracket crosses into.
- Plugins can no longer change structures outside what was selected when their command started; such a change is refused, and the document is left as it was.
- A charge dropped near an atom without attaching to it now stays floating through later edits and saves, and on a rotated molecule a dropped charge attaches to the atom under the pointer.
- Arrow keys now nudge selected objects on every page, not just the first, and the message for a file from a newer version of ChemDraft names that version.
- A polymer repeat-unit bracket that surrounds only part of a molecule keeps exactly that part through export, property analysis and structure search.
- A reaction's conditions label is no longer blocked by the reaction itself when ChemDraft places it.
- If you go back from 1.2 to 1.1.1, the earlier version still reads the dialog positions that 1.2 saved; dialog sizes are now kept in a separate file.
- **CDX and CDXML chemistry.** Crossed double bonds stay stereochemically unknown, wavy single bonds retain their unknown-stereo mark, and unrecognized bond orders are preserved instead of becoming single bonds. Isotope mass numbers in CDXML labels are written as superscripts; MOL export no longer writes single-bond wedge flags on double bonds.
- **CDX and CDXML drawings.** Curved arrows import as editable paths, though they do not follow atoms or bonds. Supported abbreviations such as Ph and Boc stay abbreviations, supported reaction steps keep their arrows (ChemDraft warns when it cannot link one), numbered R-groups keep their numbers, and aromatic ring circles are kept. CDX 3D points are read in the correct order. Text and groups inside molecule fragments are imported, and an atom labeled with no element, such as X, keeps that label instead of becoming carbon.
- **CDX text formatting.** Saving as binary CDX without the embedded ChemDraft data no longer changes text formatting silently: superscript and subscript, mixed bold and italic in one text, per-character colors, and black characters inside colored text come back exactly as they were. A file's foreground text color is honored, so uncolored text in a file whose foreground is red opens red, as the file specifies. The warning about formatting kept only in the embedded ChemDraft data now says exactly what the visible CDX or CDXML keeps (per-character colors, bold and italic, subscript and superscript) and what it doesn't (formatting applied to a whole text box).
- **Text and tables.** Text stays in place when editing starts or ends. Escape finishes a text box without converting it to an atom; clicking away converts an element symbol only when its capitalization matches. Pasted table cells retain bold, italic, subscript and superscript, and rows grow to fit larger text.
- **Atom editing.** Quitting with an unsaved atom-label edit now asks to save. Canceling a later label edit no longer undoes a previously committed label, and repeated hover shortcuts target the object currently under the pointer.
- **Pictures and shapes.** Picture opacity is respected on the canvas and in exports and copies. Tilted or rotated ellipses no longer get clipped or excessive margins in content exports and copies.
- **Export and templates.** Export keeps the chosen folder when changing the name or format. Template search finds family names, and the font list hides internal system fonts. CDXML export warns when visible text formatting cannot be retained.
- **NMR figures.** Carbon-13 annotation lines route around bonds and labels where possible, and spectrum export starts in the last successful export folder.
- **Neutral names.** The classic keyboard-shortcut scheme is now called Classic desktop-compatible; a saved choice still selects it.
- **Licenses.** The app now includes its license notices and font licenses in the installed distribution.
- Duplicate, copy and delete preserve retained source chemistry, and Copy As refuses formats that cannot preserve it.
- Formal charges survive drag previews, moves, copies, align and distribute.
- Imported radicals are retained, and CDX arrows keep their direction.

## Known limitations

- Embedded objects in CDX and CDXML files, such as pictures, are not imported, and neither are spectra. ChemDraft shows a warning when you open such a file; nothing is dropped silently.
- Documents imported from CDX/CDXML and saved in 1.2 need ChemDraft 1.2 or later to reopen. ChemDraft 1.1.1 shows 'Open failed' for these files; update to 1.2 to open them.
- In a document with a non-black foreground color, uncolored text reopens as black rather than the default text color from a CDX saved without the embedded ChemDraft data. Saving with the embedded data keeps it exactly.
- When you save a CDX or CDXML file, a filled rectangle with rounded corners or a shadow loses its fill, so it is empty when you reopen the file. A fix is planned for 1.2.1.

## macOS

The Vibe Code guide and Insert Table dialog now fit their contents on every Mac, so the guide's safety note is visible. The first click on a dialog that is not in front now reaches its button.

When **Ask to save unsaved changes before quitting** is off, quitting ChemDraft from the Dock, from a script, or to install an update now saves your open session first, and ChemDraft no longer holds up logging out or shutting down.

Dialogs such as Export, Structure Templates and Custom Color now open even when the document window is minimized; ChemDraft restores the window first.

### Intel

The new Intel download is for Macs with an Intel processor. Use Apple menu ▸ About This Mac if you are unsure which processor your Mac has.
