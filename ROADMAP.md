# ChemDraft roadmap

ChemDraft is free, open source, and runs on macOS and Windows. This page shows what is coming next. Dates are targets, not promises. Ideas and votes are welcome in [GitHub Issues](https://github.com/jgassens/ChemDraft/issues).

## 1.1.1 — November 2026 (fixes)
- Typing in a text box after saving is no longer lost when you close the document.
- Save shortcuts work while you are typing in a text box or table cell.
- Copying right after undoing an E/Z change copies the whole molecule.
- Pressing 2 over sulfur or phosphorus adds =O correctly.
- Toolbar tooltips show for every button when you slide across them.
- Bold and italic letters stay bold and italic when a whole text box is made subscript or superscript.
- Spin 3D starts on macOS 11–15; the Windows installer quotes its file-open command.
- **New:** Plugins ▸ Vibe Code Your Own Plugin… — a step-by-step guide and a starter file you hand to a coding assistant to build your own plugin.

## 1.2 — late November 2026
**Files and data**
- Open and save CDX files (the older binary format), alongside CDXML.
- Search PubChem or Reaxys for the selected structure.
- Better name-to-structure with a larger name dictionary.
- Plugins can ask for a structure's formula, mass and charge, and can add their own tools to the AI assistant.

**Drawing**
- The familiar industry-standard keyboard shortcuts become the default, including W and Shift+W for wedge and hashed bonds.
- More abbreviations: OTBDPS, TBDPS, TIPS, TES, PMB, MOM, SEM and others.
- Round brackets, bracket pairs and polymer repeat units with an editable "n".
- Arrow keys move the selection.
- Choose whether new double bonds are drawn offset or centred.
- A warning, instead of a refusal, when a bond would exceed normal valence.
- More drawing style presets alongside "Tot. Syn. blog", including a journal-style preset.
- Formatted reaction conditions, movable electron-pushing marks and adjustable wavy lines (community contributions).
- Asks before enlarging the page when a structure doesn't fit.

**Windows and Mac**
- Windows: an offline installer that needs no internet, and installing for all users.
- Mac: a version for Intel Macs.
- Preferences reopens where you left it; Esc closes pop-out menus.
- Windows code signing, as soon as the signing service approves the project.

**Fixes**
- Export suggests the document's own name and keeps the folder you chose; template search finds families; tables, pictures, text editing and the NMR panel get a round of fixes.

## 1.3
- The main toolbar in groups that fold into a single icon each when the window is narrow; plugins choose which group their buttons join.
- Floating toolbars resize along their length, with an overflow button for buttons that don't fit.
- Your own keyboard shortcuts for the keys you press over the drawing.
- Short typed shortcuts for common groups (for example c1 methyl, ph phenyl, cn nitrile), shared with Avogadro.

## Later in 1.x
- A biology clip-art plugin (antibodies, proteins, membranes).
- Linux.
- Avogadro integration.
- Several document windows at once.

## 2.0 — early 2027
- A design refresh across the whole app.
- Docked toolbars in a ribbon at the top of the window, as an option to floating toolbars.
- Edit ChemDraft structures directly inside Word and PowerPoint.
- Launches together with the full in-app AI assistant plugin, and works with it from day one.
