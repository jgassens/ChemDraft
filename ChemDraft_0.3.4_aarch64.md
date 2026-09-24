ChemDraw-style keyboard shortcuts, dative bonds for coordination chemistry, and SMILES export that keeps aromatic and ring bonds intact.

- **ChemDraw keybinding scheme:** an optional ChemDraw-compatible shortcut set with hover hotkeys (rings 3–0, wedge/hash sprouts, carbonyl, gem-dimethyl) and nickname labels (for example `e` over an atom applies Et). Switching schemes updates the main window, detached palettes, and menu accelerators live.
- **Dative bonds:** dashed bonds are now coordination (metal–ligand) bonds. They round-trip through MOL V3000, warn when saved as V2000, merge across molecules, and clean up through the layout engine.
- **Atom labels:** literal labels and naked typed atoms; Delete strips a label back to carbon before deleting the atom, and typed element symbols become real atoms whenever editing ends.
- **Charge marks** stack up to ±9, and Clear/Restore Warnings works on the current selection.
- **SMILES export fixes:** aromatic rings are kekulized instead of being written as saturated rings (benzene no longer exports as cyclohexane), a single ring keeps its ring-closure bond order (Kekulé benzene no longer exports as a cyclohexadiene), and bonds of unknown order are written with a warning.
- **Structure-list export** to SDF and SMILES in reading order.

Automatic updates are delivered via Sparkle (File ▸ Check for Updates…).
