# Open-source molecule growth corpus

Inspected: 2026-06-01

This is a clean-room research index for Phase 7 drawing productivity. Use these projects to understand interaction patterns, component boundaries, and acceptance scenarios for growing molecules one click at a time. Do not copy code, icons, toolbar art, templates, fixtures, menu/help text, or proprietary-looking trade dress from these projects.

Local inspection clones used during this pass lived under `/private/tmp/chemdraft-example-corpus/repos`; they are not dependencies and should not be committed.

## Clean-room boundary

- Treat copyleft projects as behavioral references only unless a separate license review says otherwise.
- Extract independent ChemDraft specs and tests, not source code.
- Do not vendor upstream CML/SVG/icon/template assets.
- Translate useful behavior into command-backed ChemDraft operations, pure layout helpers, and patch-based document mutation.
- Keep heavy cleanup engines, if any, behind adapters or optional plugin/service boundaries.

## Source index

| Project | Public source | License posture from inspected files | Main growth/layout components |
| --- | --- | --- | --- |
| ChemCanvas | [github.com/ksharindam/chemcanvas](https://github.com/ksharindam/chemcanvas) | GPL-3.0 in `LICENSE.txt` | `chemcanvas/tools.py`, `chemcanvas/molecule.py`, `chemcanvas/coords_generator.py`, `chemcanvas/tool_helpers.py` |
| XDrawChem / WinDrawChem | [github.com/bryanherger/xdrawchem](https://github.com/bryanherger/xdrawchem), with source distribution also on [SourceForge](https://sourceforge.net/projects/xdrawchem/) | GPL-2.0 in `GPL.txt` | `xdrawchem/render2d_event.cpp`, `xdrawchem/chemdata_event.cpp`, `xdrawchem/molecule.cpp`, `xdrawchem/application_ring.cpp`, `xdrawchem/sdg.h` |
| JChemPaint | [github.com/JChemPaint/jchempaint](https://github.com/JChemPaint/jchempaint) | LGPL-2.1-or-later in core source headers | `controller/*Module.java`, `ControllerHub.java`, `SwingMouseEventRelay.java` |
| Molsketch | [github.com/hvennekate/Molsketch](https://github.com/hvennekate/Molsketch) | GPL-2.0 in `COPYING` and source headers | `libmolsketch/actions/drawaction.cpp`, `libmolsketch/actions/ringaction.cpp`, `libmolsketch/molscene.cpp`, `libmolsketch/molecule.cpp`, `molsketch/optimizestructureaction.cpp` |
| Butlerov | [github.com/eizemazal/butlerov](https://github.com/eizemazal/butlerov), found from [DrawChemistry](https://drawchemistry.io/) | MIT in `LICENSE` | `packages/core/src/controller/MoleculeEditor.ts`, `packages/core/src/action/GraphActions.ts`, `packages/core/src/drawables/Graph.ts`, `packages/core/tests/*` |

WinDrawChem appears to be the Windows name/build lineage for XDrawChem rather than a separate maintained repository found in this pass. Use the XDrawChem source family for the interaction corpus.

## ChemCanvas

Useful files:

- `chemcanvas/tools.py:889-924`: `StructureTool` dispatches to atom, chain, ring, template, and other structure tools from a single high-level drawing mode.
- `chemcanvas/tools.py:948-1239`: `AtomTool` owns hover preview, empty-canvas atom creation, drag-to-bond, click-to-extend, touched-atom merge, and bond click cycling.
- `chemcanvas/molecule.py:172-207`: `Molecule.find_place` is the main "next atom" placement heuristic. It uses existing neighbors, bond order, transoid placement, sign flipping, and least-crowded placement.
- `chemcanvas/tools.py:1253-1302`: `TemplateTool` attaches templates to atoms or bonds, transforms them, then merges overlap.
- `chemcanvas/tools.py:1324-1510`: `ChainTool` and `RingTool` build transient previews and commit real atom/bond objects on release.
- `chemcanvas/coords_generator.py:22-75` plus `chemcanvas/tool_helpers.py:195-217`: whole-molecule coordinate generation and final placement are separate from one-click growth.

Patterns worth translating:

- Hovering a compatible atom shows a dashed future bond without mutating the molecule.
- Clicking a terminal atom extends from the previous preview coordinate.
- Dragging creates or moves the tentative atom, snaps angle unless a modifier requests free movement, and merges onto an existing atom on release.
- A bond click cycles or changes bond type; double-bond redraw is refreshed around affected atoms.
- Chain and ring tools render a count/preview first, then instantiate actual native objects.

ChemDraft extraction:

- Put next-atom placement in a pure layout helper, not in React.
- Store hover/drag previews as transient canvas state, not document state.
- Commit through command-backed patch operations such as add bonded atom, set bond type, merge touched atom, add chain, and add ring.

## XDrawChem / WinDrawChem

Useful files:

- `xdrawchem/render2d_event.cpp:216-633`: large pointer-event state machine with grid locking and mode transitions.
- `xdrawchem/render2d_event.cpp:780-886`: release handling commits drawn lines and aliphatic chains by emitting `XDC_Event` objects.
- `xdrawchem/render2d_event.cpp:1030-1195`: symbol and ring placement, including smart placement onto highlighted points.
- `xdrawchem/render2d_event.cpp:1518-1725`: hover highlighting, snap-to-existing-point behavior, temporary line previews, and zig-zag chain preview geometry.
- `xdrawchem/chemdata_event.cpp:24-40`: event handler maps add-bond event variants to `addBond`.
- `xdrawchem/molecule.cpp:627-675`: `Molecule::addBond` creates bonds and upgrades an existing matching bond instead of duplicating it.
- `xdrawchem/application_ring.cpp:244-335`: ring/template menu choices map to CML template files.
- `xdrawchem/sdg.h:113-170` and related methods: the structure diagram generator handles whole-graph coordinate generation, rings, rotations, and angle selection.

Patterns worth translating:

- Rendering/input creates intent events; the chemistry data layer applies them.
- Snap-to-existing-point behavior is independent of final mutation.
- Chain drawing is previewed with fixed bond length and alternating angles, then committed as repeated add-bond events.
- Existing bonds are detected and upgraded rather than duplicated.
- Ring and template placement are mostly library/template operations, not core atom-placement logic.

ChemDraft extraction:

- Keep pointer intent, command routing, and document mutation separate.
- Model chain preview as derived geometry from page coordinates, active bond length, and active angle settings.
- Treat rings/templates as native template-library objects or clean-room generated fixtures, never copied upstream assets.

## JChemPaint

Useful files:

- `controller/SwingMouseEventRelay.java:56-96`: Swing mouse events are converted into hub calls.
- `controller/ControllerHub.java:304-410`: the hub relays click, drag, and move events to general modules and the active drawing module.
- `controller/AddBondDragModule.java:101-278`: active bond tool previews a phantom bond, rounds drag angle to 15-degree increments, adds a bonded atom on click, merges with nearby atoms, and cycles existing bonds.
- `controller/AddAtomModule.java:74-220`: atom tool changes atom labels or creates atoms/bonds depending on click/drag context.
- `controller/ChainModule.java:68-207`: chain module creates a phantom zig-zag chain, displays the atom count, and commits a fragment on release.
- `controller/AddRingModule.java:68-189`: ring module previews rings on empty space, atoms, or bonds and commits through the hub.
- `controller/ControllerHub.java:676-790`: `addAtomWithoutUndo` uses CDK `AtomPlacer` and neighbor-count geometry for the next atom.
- `controller/ControllerHub.java:1873-1901`: whole-molecule coordinate generation uses CDK `StructureDiagramGenerator`; ring placement uses CDK `RingPlacer`.

Patterns worth translating:

- A controller hub owns event routing and mutation helpers; tools are modules.
- "Phantoms" are first-class preview structures and are cleared before commit.
- Undoable edits bundle added atoms/bonds as a fragment.
- The next-atom heuristic belongs near graph/layout code and knows about bond length, neighbor count, cyclic mode, and collision nudging.
- Cleanup/coordinate generation is a separate explicit operation.

ChemDraft extraction:

- Mirror the hub/module split with command registry plus active tool state.
- Add tests for preview not mutating document state.
- Use a pure placement helper with an adapter seam for future chemistry-aware coordinate generation.

## Molsketch

Useful files:

- `libmolsketch/actions/drawaction.cpp:62-201`: draw action builds hint points from bond length and angle, snaps to grid/hint/nearby atom, creates atoms, bonds, or molecule merges through undo commands.
- `libmolsketch/actions/drawaction.cpp:238-376`: press/move/release manage hint line previews; double-click on an atom grows a new bond using neighbor-count geometry.
- `libmolsketch/actions/ringaction.cpp:57-132`: ring preview generation and alignment to atoms or bonds.
- `libmolsketch/actions/ringaction.cpp:171-285`: ring hover alignment, grid snapping, merge with existing molecules, and final ring commit.
- `libmolsketch/molscene.cpp:408-416` and `550-651`: scene-level grid snap, atom-near, atom-at, bond-at, and mouse routing helpers.
- `libmolsketch/molecule.cpp:258-296`: molecule-level add atom/add bond methods, including duplicate-bond avoidance.
- `molsketch/optimizestructureaction.cpp:37-55`: optional OpenBabel-backed coordinate optimization action.

Patterns worth translating:

- "Magnetic" atoms and hint points make constrained drawing feel responsive without committing state.
- Release chooses atom action versus diatomic bond action based on whether snapped endpoints differ.
- Double-click growth uses local neighbor geometry to choose the new atom location.
- Ring placement aligns preview geometry before creating real atoms and bonds.
- OpenBabel cleanup is an explicit optional action, not part of basic click growth.

ChemDraft extraction:

- Put grid/hit-testing/snap behavior behind viewport and layout helpers.
- Keep hint points derived from active style settings and document bond length.
- Keep any external optimizer behind `chemistry-adapter` or a plugin boundary.

## Butlerov

Useful files:

- `packages/core/src/controller/MoleculeEditor.ts:1001-1098`: edge click cycles bond order, vertex click grows a bonded atom, vertex mouseup binds two atoms, and background click creates a default fragment.
- `packages/core/src/controller/MoleculeEditor.ts:855-890`: menu actions attach/fuse rings or add named chain lengths through graph actions.
- `packages/core/src/action/GraphActions.ts:277-456`: undoable actions wrap add-bound-vertex, default fragment, single vertex, bind vertices, and chain growth.
- `packages/core/src/drawables/Graph.ts:540-727`: graph-level crowding potential, least-crowded point, `add_bound_vertex_to`, default fragment creation, and chain growth.
- `packages/core/src/drawables/Graph.ts:820-843`: ring attachment uses least-crowded geometry and then fuses the ring.
- `packages/core/tests/basic_drawing.ts`, `edge.ts`, and `symmetrize.ts`: browser-style tests simulate clicks, mousemove, key events, undo, redo, and graph assertions.

Patterns worth translating:

- The TypeScript separation between controller events, undoable actions, and graph mutation is close to ChemDraft's desired command architecture.
- `add_bound_vertex_to` is the clearest modern example of one-click growth: it uses active bond length, neighbor count, least-crowded choice, largest angular gap, limited movement of terminal neighbors, and special handling for linear multiple bonds.
- Background click can create a default two-atom fragment; modified click can create a single atom.
- Tests assert graph counts and properties directly after simulated interactions.

ChemDraft extraction:

- Use this as the best architectural reference, while re-implementing independently against `chem-core` and `layout-engine`.
- Prefer action objects or command payloads with commit/rollback semantics for Phase 7 tools.
- Port the test style: user event sequence in, native document graph assertions out.

## Cross-cutting behaviors to spec for ChemDraft

1. Empty page click creates a small default molecule or a single atom depending on the active command/modifier.
2. Hovering an eligible atom produces a preview bond and atom location without document mutation.
3. Clicking an atom grows a bonded atom at a chemically sensible default angle.
4. Dragging from an atom creates a constrained bond preview; modifier keys allow free angle or alternate side.
5. Releasing near an existing atom merges or binds instead of creating a duplicate atom.
6. Clicking an existing bond cycles bond order or applies the active bond display, with undo.
7. Chain drag previews a zig-zag chain and count, then commits a fragment.
8. Ring tools attach to atoms or fuse onto bonds with preview alignment and explicit merge handling.
9. Whole-molecule cleanup/layout is explicit and separate from one-click growth.
10. Tests should assert native atom/bond counts, coordinates, selection, undo/redo, and zero mutation from pure previews.

## ChemDraft implementation targets

- `packages/layout-engine`: pure next-atom, chain, ring, snap, and least-crowded placement helpers.
- `packages/chem-core`: patch operations and invariants for add atom, add bond, set bond display/order, merge atoms, add fragment, and preserve chemical identity.
- `packages/shortcut-engine`: command-bound active tool and modifier behavior.
- `apps/desktop`: pointer pipeline, transient previews, and command dispatch only.
- `packages/template-library`: clean-room common rings/templates generated from our own metadata and tests.
