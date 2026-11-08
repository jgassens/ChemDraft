ChemDraft 1.1.1 fixes a few problems found after 1.1 and adds a guide for building your own plugins.

**New**

- **Vibe Code Your Own Plugin.** Plugins ▸ Vibe Code Your Own Plugin… opens a short step-by-step guide and saves a starter file you hand to a coding assistant (Codex, Claude Code or similar). The file explains the plugin interface, lists this computer's app and plugin folders, and walks the assistant through building, packaging and testing the plugin, ready to install with Plugins ▸ Add or Remove Plugins… ▸ Add plugin from package…. Only install plugins that you or your assistant wrote and that you trust.

**Fixes**

- **Typing after a save is no longer lost.** If you saved while still typing in a text box, more typing is now marked as unsaved, so closing the document asks to save it.
- **Save shortcuts work while typing.** ⌘S and ⇧⌘S save from inside a text box or table cell, and your typing is kept.
- **Bold and italic survive subscript and superscript.** Making a whole text box subscript, superscript or normal no longer removes bold or italic from part of its text.
- **Copy after undoing an E/Z change** copies the whole molecule.
- **Pressing 2 over sulfur or phosphorus** adds =O to a plain S or P atom, not only to a labelled SH or PH2.
- **Toolbar tooltips** appear for every button as you slide across them.
- **Spin 3D starts on macOS 11 to 15.**

**Known limitations**

- Esc does not close a toolbar flyout that was opened with the mouse.
- Text in a text box can move by a pixel or two when editing starts or ends.
- Dropdown lists inside plugin panels are not yet restyled and may open dark.
