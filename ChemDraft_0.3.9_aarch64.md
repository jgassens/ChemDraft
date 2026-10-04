ChemDraft now explains analyses that can't run, and is stricter about chemistry it can't read faithfully.

- **Analyzer notices.** When an analysis can't run (for example Analyze ▸ Analyze Mass / m/z with no molecule, or two, selected), a notice at the bottom left now says why. It stays up while you point at it, and closes on its own or with ×.
- **Clearer SMILES paste errors.** When pasted SMILES can't be drawn, ChemDraft pastes it as text and the status line says why.
- **No invented radicals.** If RDKit is unavailable and ChemDraft reads SMILES with OpenChemLib instead, an aromatic ring that can't be drawn as written (for example n1cccc1, which needs [nH]) is refused with an explanation instead of being drawn with an unpaired electron.
- **Unknown bonds are not exported as single bonds.** A bond whose order ChemDraft doesn't know (for example from an imported file) now stops SMILES export for that structure and names the bond. Structure-list exports report it and continue with the rest.
- **Less work at startup with OpenChemLib.** If Spin 3D is set to OpenChemLib, ChemDraft no longer loads RDKit in the background after launch.

Automatic updates are delivered via Sparkle (File ▸ Check for Updates…).
