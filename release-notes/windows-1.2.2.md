# ChemDraft 1.2.2

ChemDraft 1.2.2 adds a Keyboard preferences page, a short guided tour and an About window, makes charge marks more reliable, and tightens the checks that keep what a plugin or the assistant writes consistent with what is drawn. It also gives plugin authors request-bound tools (plugin API 0.1.26).

## What's new

- **Keyboard preferences.** Preferences now has a searchable Keyboard page. You can assign your own shortcuts to menu commands, drawing tools and hover keys, separately for each shortcut scheme, and clear or reset one item or reset all of them. If a shortcut is already taken, you choose whether to replace it.
- **Guided tour.** A short tour opens the first time you start ChemDraft, waits for any recovery prompt or file open to finish, and can be skipped at any step. Reopen it any time from Help > Take the Tour. The second step lets you pick a shortcut set and opens Keyboard preferences; the drawing, Name to Structure and analysis steps have Try it buttons that work in a separate practice tab named Tour, so your own drawing is not touched.
- **About ChemDraft.** A new About window shows the version and build, with Copy Version, and credits contributors, bug reporters and testers, and the license holders of the open-source components ChemDraft ships. On macOS it is the first item in the ChemDraft menu; on Windows it is under Help.
- **Charge-mark behavior.** Charge and radical marks anchored to a bond or object now keep counting toward their atom through unrelated edits, rotation and save and reopen. Moving several marks in one step is checked once per atom, so moving both a + and a − off a neutral nitrogen is no longer wrongly refused. Undo names charge changes (for example "Move and Remove Charge"), and the status line names a selected charge, radical or lone-pair mark.
- **Duplicate and Paste keep charge marks.** Duplicating, copying or pasting a molecule now keeps its charge and radical marks; before, Duplicate dropped them and silently changed the copy's charge. A loose charge or radical mark copied on its own, or with molecules it doesn't belong to, stays loose until you drag it onto an atom; it no longer attaches to whatever atom it lands near. Actions that aren't chemistry edits (Duplicate, paste, moving, aligning, nudging, style changes, Clean Up, 2D relayout, Spin 3D, bond-length scaling) are refused with a message naming the molecule if they would change the charge or radicals of a molecule already on the page, and nothing is added to Undo. Drawing a bond, chain, ring or template next to a loose mark is refused if it would take that mark away from another molecule. A refused paste now says why on the status line.

### Linux

Linux is still a community-tested beta, now on the same 1.2.2 as Mac and Windows. It won't update itself yet, so grab new versions from this page.

What's new for Linux since beta 4:

- You can type into the number fields in floating toolbars on KDE Plasma with Wayland. @iacchi, thanks for sticking with this one. Beta 4 was supposed to fix it and didn't on newer KDE. My automatic tests now type into one of those fields on KDE 6.8 for every build.
- Clicking a toolbar field never pulls focus away from another app you've switched to. That matches Mac and Windows.
- Floating toolbars show their normal panel color from the moment they appear, instead of flashing blank.

If a toolbar field still won't take typing, start ChemDraft from a terminal with `CHEMDRAFT_PALETTE_FOCUS_LOG=1`, click the field once, and paste the line that starts with `[palette-focus]` into your report. Please also say which distribution and desktop you use, and whether it's X11 or Wayland.

Thanks again to @Kohulan for the Linux port.

## Fixes

- **Lone pairs.** Lone pairs are now placed using the atom as it is drawn, including on rotated structures, for both manual placement and automatic gap selection.
- **Plugin edits that change a structure.** When a plugin changes a molecule's atoms or bonds, the stored structure, SMILES and formula now follow the drawing instead of describing the old molecule. A change that can't be stored faithfully is refused instead of being saved out of step.
- **Plugin changes and accepted recognition are verified.** Changes that touch only a molecule's stored structure, and structures accepted from recognition, are now checked against the drawn atoms and refused if they disagree. Refusals now say so in a plain sentence, such as "Recognition not inserted: its stereo annotations can't be matched to the drawn structure." or "Plugin change not applied: ...", instead of showing internal text. Moving or rotating a whole molecule is still allowed.
- **Plugin or assistant edits on the wrong page.** If the same object appears on two pages, an edit aimed at the object selected on one page can no longer change the copy on the other page. Such an edit is refused with an explanation: make the change by hand, or copy the object and paste it as a new object.
- **Assistant requests and replaced drawings.** A pending assistant request is now canceled when its drawing is replaced ("Assistant request canceled: the drawing it was working on was replaced."), so it can't insert into a drawing you opened afterward.
- **Repeat units.** Assistant and plugin edits that would change a repeat unit's connectivity or stored members are refused, with no Undo entry. Ordinary square brackets are not affected.
- **Moving stored-only molecules.** A molecule kept only as a SMILES or molfile can be moved by a request write; any change to its structure, charge, isotope or stereo is still refused.
- **Arranging figures.** Both brackets of a pair now move together when a figure is arranged in a row or grid, and a multi-step reaction plan no longer fails when the optional rows setting is missing. A condensed insertion such as NaOH gets a correctly sized frame.
- **Window title after Save As.** After Save As to a new name, or the first Save of an untitled document, the window title kept saying "Untitled.chemdraft". It now shows the file's name.
- **Clicks on the tab strip.** With more tabs than fit, closing a tab while another ChemDraft window was in front could leave every tab click landing one tab to the left of the tab you saw, so a click could even close the tab next to it. Clicks now always land on the tab drawn under the pointer. When the tabs overflow, a slim scrollbar appears under them, and the mouse wheel or trackpad scrolls the strip.

## For plugin authors

- **Plugin API 0.1.26: request-bound tools.** A plugin can now serve its own tools for a single user request. The host pins the document, page and selection when the request starts, so reads stay on that document even if the user switches tabs; offers a verified write path with one labeled Undo entry per request; and provides data-only chemistry inspection and depiction helpers (inspect structure, rings, measure, render region, style and layout planning). A request may reference existing objects only if they were selected when it started or were inserted during that request; otherwise the whole write is refused with no history entry. The host verifies chemistry on every write and refuses loss of stereo, radicals, isotopes, charges or repeat-unit membership. A new notification reports active-document changes; it grants no authority.
- Plugins built against the older API (for example ^0.1.25) still install and run their existing commands; request-tool calls and document-change notifications simply report as unsupported.
- Two example plugins are included in the repository for testing: Request Tools Probe and a legacy-SDK fixture.
- Known issue: a plugin's read of the current selection can still find an object with the same internal ID on another page. This predates 1.2.2 and is being fixed separately.

## Known limitations

- Embedded objects in CDX and CDXML files, such as pictures, and spectra are not imported. ChemDraft shows a warning when you open such a file.
- Documents imported from CDX/CDXML and saved in 1.2 or later need ChemDraft 1.2 or later to reopen. If you delete a member atom from an imported repeat unit, the saved document requires ChemDraft 1.2.1 or later to reopen.
- In a document with a non-black foreground color, uncolored text reopens as black rather than the default text color from a CDX saved without embedded ChemDraft data. Saving with the embedded data keeps it exactly.
- CDX and CDXML keep one color per rectangle. When fill and outline differ, ChemDraft keeps the fill unless it is white or the page color, in which case it keeps the outline. A warning appears when a color cannot be saved.
- If you open a file while ChemDraft is asking whether to save before quitting and then choose Don't Save, that file may not open. Open it again after relaunching.
- An equilibrium arrow you edited to a single open head can reopen as a retrosynthesis arrow from a CDX or CDXML file saved without embedded ChemDraft data if you changed the Creation program field in the Export dialog.

## Windows

Everything above applies. About ChemDraft is under Help, and it has no separate taskbar entry.

Keyboard preferences are in Preferences (File menu, Ctrl+,); the guided tour is under the Help menu.

Tool palettes no longer flash black or blank for a moment when ChemDraft starts; each palette appears once it has drawn.

Download the Windows x64 installer and run it to install or update ChemDraft.
