Structure recognition from images (experimental), floating report windows, and correct counting of aromatic rings.

- **Recognize a structure from an image (experimental).** Install the official MolScribe OCSR plugin from the Plugin Manager in one click; ChemDraft sets up its local recognition engine for you. Choose an image file or drag out a region of the screen, watch progress in a card you can cancel, and review the proposed structure before it is inserted. Nothing is added to your drawing until you accept it. Recognition runs on your Mac; Apple silicon only.
- **Analysis and plugin reports open in their own windows.** Reports float beside your drawing, stay inside the visible screen area, and can be moved, copied, exported and closed with ⌘W.
- **Aromatic rings count correctly.** Structures pasted with aromatic bonds (MOL files with aromatic bond types, or CDXML) now give the right formula (benzene is C6H6, not C6H12), draw pyrrole-type nitrogens as NH, and export readable molfiles. Where a file does not say which nitrogen carries a hydrogen, ChemDraft makes its best reading and marks the atom so you can check it; hover the mark for the reason. Hydrogen counts stated in CDXML are kept.
- **3D rotation reports what it changed.** Rotating a 3D model now tells you when committing the rotation had to simplify part of the structure.

Documents saved with this version that keep a CDXML hydrogen count open in 0.3.6 or later.

Automatic updates are delivered via Sparkle (File ▸ Check for Updates…).
