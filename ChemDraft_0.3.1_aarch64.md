Fixes a stereochemistry-affecting import bug, plus a batch of toolbar and rendering fixes.

- **Chirality fix:** importing a real ChemDraw CDXML file could mirror wedge/hash stereochemistry, so an R stereocenter could render as S. Coordinate reading and writing now follow the CDXML spec order; ChemDraft-authored files still open exactly as before.
- **Main toolbar style widget:** adapts to the current selection (text, molecule, arrow, shape) with compact controls and a "More…" escape hatch to the full inspector.
- **Arrow transform box:** Shift-hover an arrow for rotate and 3D-tilt handles; resizing scales head, stroke, and shaft gap together as one undo.
- **Rendering:** eliminated stale "ghost" chrome pixels left behind by rotate/tilt handles and path-edit cages.
- **Palettes:** toolbars recover from off-screen positions, tooltips clamp to the correct monitor, and popovers no longer misplace on first open.
- **Persistence:** sessions, saved layouts, and arrow style defaults no longer get lost across restarts.
- A wide range of additional correctness and stability fixes from two independent code reviews, including formula/valence correctness, plugin storage reliability, and CDXML round-tripping.

Automatic updates are delivered via Sparkle (File ▸ Check for Updates…).
