# ChemDraft roadmap

ChemDraft is free, open source, and runs on macOS and Windows. This page shows what is coming next. Dates are targets, not promises. Ideas and votes are welcome in [GitHub Issues](https://github.com/jgassens/ChemDraft/issues).

## 1.1.1 — early November 2026 (fixes)
- Typing in a text box after saving is no longer lost when you close the document.
- Save shortcuts work while you are typing in a text box or table cell.
- Copying right after undoing an E/Z change copies the whole molecule.
- Pressing 2 over sulfur or phosphorus adds =O correctly.
- Toolbar tooltips show for every button when you slide across them.
- Spin 3D starts on macOS 11–15; the Windows installer quotes its file-open command.
- **New:** Plugins ▸ Vibe Code Your Own Plugin… — a step-by-step guide and a starter file you hand to a coding assistant to build your own plugin.

## 1.2 — late November 2026
**Files and data**
- Open and save CDX files (the older binary format), alongside CDXML.
- Search PubChem or Reaxys for the selected structure.
- Name to Structure can find more common names, trade names and CAS registry numbers offline.
- Preserve supported unknown content from newer documents, with warnings where needed.

**Drawing**
- W and Shift+W draw wedge and hashed bonds; a wavy single bond marks unknown stereochemistry.
- More abbreviations: OTBDPS, TBDPS, TIPS, TES, PMB, MOM and SEM.
- Round brackets, bracket pairs and polymer repeat units with an editable "n".
- Arrow keys move the selection.
- Choose whether new double bonds are drawn offset or centered.
- An explanatory badge, instead of a refusal, when a bond would exceed normal valence.
- ACS 1996-style and RSC journal-style drawing presets.
- Formatted reaction conditions, adjustable electron marks and adjustable wavy lines (community contributions).
- Asks before enlarging the page when a structure doesn't fit.

**Windows and Mac**
- Mac: a version for Intel Macs.
- Dialogs fit their contents; Preferences reopens where you left it; Esc closes toolbar flyouts.
- Name from Structure on Intel Macs is planned for an update.

**Plugins and assistant**
- Plugins can use chemical properties and offer assistant tools, subject to their permissions.

## 1.2.1
- A Windows installer that installs for all users (Program Files, all-users Start Menu, silent install), deferred from 1.2.
- MOL/SDF coordinates are written in standard units.
- A native right-click menu.
- The warnings window stays above floating palettes.
- Structures inserted from pickers are placed outside open pickers.
- Repeated pastes no longer stack on top of each other.

## 1.3
- Several document windows at once.
- Optional resizable floating toolbars.

## 1.4
- Linux is on the roadmap for the 1.x series, aimed at 1.4, which will most likely land early 2027. It needs its own builds, testing and update system first, because every release must work the same on every supported platform.

## Later in 1.x
- Your own keyboard shortcuts.
- A biology clip-art plugin (antibodies, proteins, membranes).
- Avogadro integration.
- Industry-standard keyboard shortcuts as the default.
- Short typed shortcuts for common groups (for example c1 methyl, ph phenyl, cn nitrile), shared with Avogadro.
- A Windows offline installer.
- Windows code signing, as soon as the signing service approves the project.

## 2.0 — early 2027
- A design refresh across the whole app.
- Docked toolbars in a ribbon at the top of the window, as an option to floating toolbars.
- Edit ChemDraft structures directly inside Word and PowerPoint.
