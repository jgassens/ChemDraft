ChemDraft 1.1 is a fix release. It adds picture paste and editable tables, makes typing labels and hotkeys behave the way chemists expect, and fixes a long list of paste, undo and export problems.

**New**

- **Paste pictures.** Copy an image in another app (PNG, TIFF, BMP or SVG) and paste it onto the page at its true printed size. Pictures move, resize and rotate like other objects, take one undo step, are saved in the document, and appear in SVG, PDF and image exports (PNG, JPEG, BMP, GIF, TIFF) and Copy as PNG. CDXML export warns that pictures are not saved there. Chemistry on the clipboard still wins: a copied structure, SMILES or molfile pastes as chemistry, not as a picture.
- **Tables.** Insert an editable table, type and format text in its cells, and copy it into Word, Excel or PowerPoint as a real table. Tables export to SVG and PDF. A newly inserted table's empty columns stay wide enough to click into while you fill them in.
- **Structure templates for large hosts.** A template picker with 36 large and supramolecular molecules: crown ethers, cryptands, cyclodextrins, cucurbiturils, calixarenes, pillararenes and more. Name to Structure also finds them by name.
- **Name from Structure.** Get a checked IUPAC name for a drawn structure from a local naming engine, installed on request.
- **Compound layouts (optional).** Turn on Settings ▸ Compound layout tools to arrange selected compounds in a circle, oval, grid, row or column, with a spacing dialog. Off by default. Contributed by Emily Osborn.
- **E/Z unspecified double bonds.** A double bond can be marked "either" (E/Z unknown). The mark is kept when the drawing is saved, copied and pasted, or spun in 3D.
- **Plugin updates are checked once a day,** so a plugin no longer sits on an old version until you check by hand.
- **NMR panel.** Copy puts the spectrum on the clipboard as a picture at its real printed size, never as a block of SVG code. Export offers PNG, SVG and PDF beside JCAMP-DX. The panel window resizes from any edge or corner, remembers its size and place, opens scrolled to the top, and has a Full size button. Peak labels, the axis title and the structure's shift labels no longer overlap.
- **Pasting SVG code gives a picture.** SVG copied from another app pastes as a picture, not as a text box full of code.

**Drawing and labels**

- **Typing a label keeps the atom.** Typing PPh2 on a phosphorus, or SH on a sulfur, changes that atom instead of adding a second one. Abbreviations such as OMe still attach as groups. An atom with an isotope refuses a label that would lose it, and says why.
- **Keys act on the atom under the pointer.** After labelling one atom by hovering and typing, the next key goes to whatever the pointer is over now, so "o" then "o" on ethane gives HO–OH, and "o" then "5" over the new bond fuses a ring.
- **Bond angles.** Ring hotkeys on a bonded atom use the widest open angle (toluene drawn by hotkey gets 120°), bonds from a triple bond or an allene carbon grow straight at 180°, wedges reverse correctly, and hydrogens on left-side labels sit on the left.
- **Rings stay on the page.** A ring attached at a bonded atom near the page edge is kept inside the page.
- **More hotkeys.** Hover an atom or bond and press g (cyclopropyl, or a fused cyclopropane over a bond), u (cyclobutyl), z (an alkyne, or a fused cyclopentadiene over a bond), Shift+G (cyclopentadienyl), Shift+J (phenyl), 2 over S or P (add =O) or 9 over a full carbon (isopropyl). They work in both key presets.
- **3- to 8-membered rings.** Ring tools are grouped under the benzene button, with rings from 3 to 8 atoms. Ring grouping and the 7- and 8-membered rings contributed by Neelima Koti.
- **Tooltips stay out of the way.** A toolbar tooltip no longer draws over or under an open flyout or colour picker.
- **Settings…** is in the ChemDraft menu (⌘,).
- **Clean Up and paste never overlap atoms.** Clean Up Structure 2D and paste lay out fused rings and cages without atoms on top of each other, and large macrocycle pastes no longer freeze the app.
- **Molecules insert at the drawing size.** Inserted and pasted molecules use the same bond length as hand-drawn ones.
- **Ring fills reach the bonds.** A coloured ring fill covers the whole ring, and ring-atom labels sit on top of it.
- **Orbitals.** Orbital tools stay active for repeated placement, lobes snap to existing orbitals and point into free space, and a selected orbital shows its rotation handle. Contributed by Neelima Koti.
- **Double and triple bond tools.** Available from Customize Main Toolbar. Drawing or raising a bond past an atom's valence is refused with a message that says why. Contributed by Neelima Koti.

**Text, undo and keyboard**

- **Undo after editing text.** Editing an existing text box is one undo step. Before, one Undo could remove a different text box.
- **Text editing.** While you edit a text box only the live text shows (no overlapping copy), and font, size, bold, italic, underline and sub/superscript apply to every selected text box at once. Contributed by Ziqi Wang.
- **Text boxes fit their text.** While you edit a text box its last letter no longer wraps onto a new line, at any zoom and after an undo. New text boxes are measured with real letter widths, so text no longer runs past the edge of its box in exports.
- **Text copied and pasted within ChemDraft keeps its formatting** and does not stay in edit mode. (Rich text pasted from other apps still arrives as plain text.)
- **Keyboard and focus.** Fields in tool palettes take typing without the keys reaching the drawing, the keyboard reaches canvas context-menu items, a click on the canvas takes focus back, and the click that ends text editing only finishes the text.
- **Start with a fresh document (optional).** Settings ▸ Startup ▸ Start with a fresh document opens one clean drawing instead of restoring the last session. Off by default. Contributed by Nithish Agamendran.
- **The document window reopens where you left it.**

**Exports and chemistry**

- **Rotated objects stay whole** in Copy As (PNG, SVG) and the Export window's Content crop. Before, rotated pictures, text and molecules could be cut off.
- **TIFF exports carry their real resolution** (for example 96 dpi at 1×, 288 dpi at 3×), so Word and other apps place them at the right size.
- **PDF sub- and superscripts** are drawn at a real size.
- **Reaction conditions** are laid out above and below the arrow, with formula subscripts.
- **Isotopes are kept** when molecules are pasted, imported or inserted, and **radicals** are kept in SMILES and SDF export, or the export says it cannot keep them. Contributed in part by Fairuz Tahia.
- **Molfiles** with large atom or bond counts are read correctly.
- **Plugin downloads on company networks** explain what blocked them (proxy, firewall or certificate) instead of showing a raw error, and use the system's trusted certificates. Uninstalling a plugin clears its stored settings; updating keeps them.

**For plugin authors**

- Plugin API 0.1.15 adds 3D building, relaxing and flattening of multi-molecule complexes (a host with its guest, say) without the molecules passing through each other. 0.1.18 adds tables, 0.1.19 a snapshot of a panel's report, and 0.1.20 `tableStyle.autoColumnMinEm`, a minimum width for automatic table columns. All additions are backward compatible.

**Known limitations**

- Pictures inside masks, filters, blend modes or patterns are not drawn in image exports (SVG and PDF include them), and the export says so.
- An arrow or bracket that is both tilted and rotated can still be cropped slightly short by Copy As.
- CDXML does not store pictures; the export warns.
- The NMR panel's Save dialog does not remember the last folder you used.
- Esc does not close a toolbar flyout that was opened with the mouse.
- Sulfonyl and tert-butyl groups have no hover key: press 2 twice over an S, or type the tBu label.
- A rotated table saved by an earlier version with an empty column can shift by a few pixels the first time it is edited.
- Text in a text box can move by a pixel or two when editing starts or ends.
- Applying superscript or subscript to a whole text box can remove bold from part of its text; Undo restores it.
- On macOS the NMR panel resizes only from a thin band at its edge.
- On Macs running macOS 15 or earlier, Spin 3D may not start; a fix is planned for 1.1.1.

Automatic updates are delivered via Sparkle (File ▸ Check for Updates…).
