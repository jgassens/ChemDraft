ChemDraft 1.0 is the first official release. It brings document tabs, dialogs in their own movable windows, abbreviation labels that count as real chemistry, and a long list of drawing fixes.

- **Document tabs.** Several drawings open as tabs in one document window. Tabs that could not be restored after a restart can be retried, saved or discarded, and a restored tab saves back to its own file.
- **Dialogs are movable windows.** Export and Custom Page Size open in their own windows that you can move anywhere, including another monitor. They reopen where you left them, and the floating toolbars stay usable beside them. Simple questions use the system's own message boxes.
- **Export preview and size presets (optional).** Turn on Settings ▸ Export preview and size presets to see a live preview in the Export window, with size presets, width and height in pixels or millimetres, and DPI. Off by default; exported files are the same either way.
- **Save before quitting (optional).** Settings ▸ Ask to save unsaved changes before quitting.
- **Abbreviation labels are chemistry.** Labels such as OMe count toward the formula and mass and export correctly, and a label typed on a ring atom becomes a substituent.
- **Labels behave.** Typing NH no longer turns into nihonium, OMe is no longer cropped while you type it, Escape cancels a whole typed label, and group labels meet their bond at the atom they bond to.
- **Drawing fixes.** Chain and arrow drags that start on an object follow the pointer, the eraser removes only what it touches, Escape cancels a drag in progress, ring placement never leaves an over-valent atom, and pages with many overlapping rings no longer freeze the app.
- **Canvas matches export.** Objects are painted in document order, as in exported files, and ring fills are notched around ring-atom labels.
- **Floating toolbars and panels.** They keep their stacking order after a system dialog, show an edge where they overlap, and plugin panels take keyboard focus only on their own inputs. Dragging a toolbar or panel by its title follows the pointer exactly.
- **Export.** PDF export embeds open-licence fonts for symbols the standard fonts can't show, raster export runs off the main thread and refuses drawings too large to render, and CDXML import reads every element by atomic number.
- **macOS.** Quit and Cmd+Q save the session before the app exits, and opening a document while ChemDraft is closed no longer crashes it.

Automatic updates are delivered via Sparkle (File ▸ Check for Updates…).
