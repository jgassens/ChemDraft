# Agent Instructions for ChemDraft Structure Inspector Branch

**Current Build**: 7.5.18.24-fable

> [!IMPORTANT]
> When implementation work starts or a significant slice is finished, update this build stamp and the corresponding `Build` string in `apps/desktop/src/MainWindow.tsx`. Use `[month].[day].[hour].[minute]-[agent_name]`.

This branch is for the active Structure Inspector worktree: a dedicated Rings toolbar plus Molecule Inspector tabs for Structure, Atom Labels, and Templates.

- Worktree: `/Users/jeremiahgassensmith/Documents/programming/chemdraw-structure inspector`
- Branch: `codex/structure-inspector`
- Planning source: `PLANS.md`
- Current state: active implementation. The user has explicitly requested implementation of the Molecule Inspector tabs plan.

## Required Reading Before Coding

Before editing implementation files, read:

```text
PLAN.md
PLANS.md
AGENTS.md
README.md
package.json
pnpm-workspace.yaml
```

If the work touches a package, also read that package's README or local documentation before editing.

When `PLANS.md` exists, treat it as the active scoped implementation plan unless the user gives
newer instructions. Keep edits focused on the files, behaviors, and verification listed there;
do not broaden the slice into adjacent chemistry, rendering, UI polish, or format work.

Notary and app-signing instructions live at `/Users/jeremiahgassensmith/Documents/programming/.notary`.
Read that directory before signing, notarizing, packaging, or changing release automation.

## 2. Core priorities

Ship the compact hidden-by-default inspector palettes with:

- `core.ringInspector`: a Rings toolbar preserving existing ring identity, per-ring fill/effect rendering, ring interior hit-testing, and ring appearance controls.
- `core.moleculeInspector`: a Molecule Inspector with `Structure`, `Atom Labels`, and `Templates` tabs.
- `Structure`: molecule bond drawing controls for selected molecule targets. If one or more bonds or atoms are selected, Structure controls apply only to those parts through sparse per-bond / per-atom overrides, mirroring the Atom Labels behavior below.
- `Atom Labels`: base molecule atom-label typography, display policy, and font-family/face controls. If one or more atom labels are selected, Atom Labels controls must apply only to those labels through sparse per-atom overrides.
- `Templates`: import ChemDraw `.cds` style-sheet inputs through `packages/style-compat`, apply supported Molecule Inspector settings to selected molecule targets, and export ChemDraft Molecule Inspector presets as `.template` files.

Structure drawing controls (stroke and bold width, spacing, line caps, margins, hashing, overlap, chain angle, and indicator toggles) apply per bond and per atom via sparse maps when specific bonds/atoms are selected, and to the whole molecule otherwise.

Outside this slice:

- Per-bond fill opacity and per-bond visual effects (opacity and effects stay whole-molecule / ring-level through the Rings and Art inspectors).
- Atom-label underline, outline, and shadow.
- Font embedding, a font-management preference screen, general CDXML/CDX document import, clipboard, OCSR, or broad toolbar customization.

Do not add `NativeMoleculeDrawingSettings`, `NativeAtomLabelSettings`, or `NativeMoleculeIndicatorSettings`.

## Reuse Existing Systems

Verify existing code before adding new code.

- Whole-molecule fill/stroke color, paint type, opacity, none, and visual effects already apply to molecule objects through `documentWorkflow.ts` and `artInspectorModel.ts`. Reuse those paths where applicable.
- Per-bond color already exists through `applyColorToNativeMoleculePart`, writing `style.bondColors` and `style.atomLabelColors`.
- Per-bond style identity already lives on `bond.display.bondStyle`. Do not add a duplicate `style.bondStyles` map.
- The live inspector pattern already exists in `ArtToolbarStyleControls`. Mirror its model, payload, controls, and preview/commit/cancel behavior.
- Commands use value-encoded IDs and factory helpers. Do not introduce generic `*.set` commands with hidden value parameters.
- `exportDocumentToSvg` already reuses `planPageSvgRender`; per-ring render-plan paths should flow to export through that existing route.
- Use `MoleculeObject.style` and `nativeDrawingStyleFromObjectStyle()` for Structure and Atom Labels. Do not introduce a parallel molecule-style object.
- Keep Structure and Atom Labels state on the shared `NativeDrawingStyle` (never a parallel molecule-style object). Beyond reusing existing bond/label fields, this slice adds base bond-drawing fields (`chainAngleDegrees`, `bondBoldWidthPx`, `bondSpacingMode`, `bondSpacingPercent`, `bondMarginWidthPx`, `bondHashSpacingPx`), the atom/bond structure-indicator toggles (`atomIndicatorShow*`, `bondIndicatorShow*`), and the atom-label fields (`atomLabelFontStyle`, `atomLabelAlignment`, `atomLabelPlacement`, `atomLabelShowTerminalCarbons`, `atomLabelHideImplicitHydrogens`). Each is sparse-overridable per bond/atom via the `documentWorkflow.ts` maps and round-trips through templates/imports.
- The native system-font database already used by raster export must be shared with the Molecule Inspector font catalog; do not scan system fonts twice.

## Hard Boundaries

- Do not change the main checkout. Work only in this worktree for this branch.
- Do not copy proprietary assets, icons, dialog art, help text, sample files, command IDs, trade dress, or branded UI.
- Keep chemical identity stable. Ring styling must not mutate atoms, bonds, bond order, charges, stereochemistry, reactions, or molecule metadata.
- Ring geometry and key logic must live in `packages/layout-engine`; app code imports helpers and does not duplicate ring math.
- Ring appearance storage remains `style.ringStyles`, keyed by topology-derived ring keys.
- Ring keys must derive from sorted bond IDs, never coordinates.
- The Rings toolbar and Molecule Inspector must be hidden by default, compact, dense, and floating. Do not create a permanent right inspector or card/dashboard UI.
- Keep `core.ringInspector` / `view.toggleRingInspector` for ring appearance and `core.moleculeInspector` / `view.toggleMoleculeInspector` for Structure, Atom Labels, and Templates. Be aware that `view.toggleInspector` and disabled `tool.settings` already exist; do not add additional inspector concepts.
- Ring interiors are selectable only while the Rings toolbar is open.
- Keep chemical identity stable. Structure and Atom Label styling must not mutate atom elements, formal charges, bond orders, stereochemistry, atom IDs, bond IDs, or molecule identity.
- Sparse overrides must remain sparse and visually effective. Base style edits must not clear `style.ringStyles`, `style.bondColors`, `style.atomLabelColors`, sparse per-atom label style maps, or the sparse per-bond/per-atom Structure and indicator style maps.
- Target bond length must visibly scale selected molecule atom coordinates about each molecule's own center and update `style.bondLengthPx` in one undoable operation, or it must be removed from this slice.
- Structure indicators must be honest render overlays: atom numbers from atom order; atom/bond stereo from native wedge/hash/dashed display or imported stereo metadata; query indicators only from unknown/query atom or bond metadata; reaction indicators only from reaction/RXN metadata. Do not invent query or reaction chemistry for ordinary SMILES.

## Verification

Run focused suites for touched files, including:

```bash
pnpm vitest run packages/chem-core/src/styles.test.ts packages/layout-engine/src/index.test.ts packages/export-engine/src/svg.test.ts apps/desktop/src/moleculeInspectorModel.test.ts apps/desktop/src/commands.test.ts apps/desktop/src/documentWorkflow.test.ts apps/desktop/src/window-manager/index.test.ts apps/desktop/src/App.test.ts
pnpm lint
cargo test agent_bridge
git diff --check
```

### 5.26 Do not duplicate layout-engine rendering math

Native-molecule rendering math — bond line/segment geometry, double/triple-bond gap and
inset conventions, wedge/hash geometry, atom-label content (`atomDisplayLabel`) and layout
(`atomLabelLayout`, `labelEndpointClearance`), stroke widths, and the perspective depth
cues (`depthCuedBondStrokeWidth`, `depthCuedBondColor`) — lives ONLY in
`packages/layout-engine`. App code (including the 3D spin overlay in `MainWindow.tsx`)
must import these helpers; it must NEVER carry its own copy, even temporarily.

This rule exists because two agents working the same branch in parallel each edited a
different copy of the same formula, and the live spin overlay silently diverged from the
committed drawing. If a helper you need is package-internal, add an `export` keyword in
layout-engine rather than copying the function. If the app needs *different* behavior
(e.g. the toolbar wants base colors without the depth tint), give the app-side function a
distinct name that states the difference (`nativeMoleculeBaseBondColor`) — never reuse a
layout-engine name for different behavior.

### 5.27 Spin 3D rotation parity is scoped to `ScreenPlacement`

For the current Spin 3D rotation-parity work, follow `PLANS.md`. The shared visual contract is
`ScreenPlacement`: live overlay, flatten/release, reopen, modeled X/Y drag, modeled typed X/Y,
drag Z, and typed Z must all preserve one placement contract for modeled molecules.

`flattenSpunMolecule(..., { placement })` must match `projectSpin` for the same conformer,
orientation, and placement. Keep projection and scale helpers in `apps/desktop/src/interaction/`
and keep flattening in `documentWorkflow`; do not add duplicate projectors or one-off rendering
math in `MainWindow.tsx`.

This fix must not change chemical identity, stereo validation, wedge/hash assignment, crossing
behavior, depth cues, molfile rewrite behavior, CDXML/CDX behavior, legacy non-modeled X/Y tilt,
or art-object tilt. If a change touches those surfaces, prove it with the focused tests in
`PLANS.md` or narrow the edit back to the placement/parity path.

## 6. Package-specific rules

### 6.1 `chem-core`

Allowed:

- TypeScript types
- Zod schemas
- Document creation helpers
- Patch application
- Serialization
- Migrations
- Validation
- Native object definitions for molecules, reactions, mechanism annotations, text, arrows, brackets, groups, graphics, superatoms/abbreviations, basic R-group display, and unknown compatibility objects
- Native page layout, paper-size presets, orientation, margins, and page-size migrations
- Native style preset definitions and selected document style preset references

Not allowed:

- UI rendering
- Ketcher imports
- Tauri imports
- Direct filesystem access
- Plugin loading
- MolScribe OCSR imports

### 6.2 `editor-adapter`

Allowed:

- Abstract editor interfaces
- Editor event types
- Editor capability types
- Molecule/reaction editor load/save methods

Not allowed:

- Concrete editor implementation
- Native document mutation
- App UI layout
- Page-level document ownership

### 6.3 `ketcher-adapter`

Allowed:

- Ketcher loading
- Ketcher call wrappers
- Ketcher-specific error handling
- Feature detection
- Wrapping a real Ketcher runtime object behind `EditorAdapter`

Not allowed:

- Exporting Ketcher internals as public app API
- Owning document state
- Owning plugin state
- Pretending Ketcher can represent unsupported ChemDraft objects

### 6.4 `plugin-api`

Allowed:

- Public plugin types
- Manifest types
- Permission names
- Context interfaces
- Command/result types
- Recognized-structure result types

Not allowed:

- App-specific implementation code
- Direct document mutation
- Concrete UI framework dependencies unless unavoidable

### 6.5 `plugin-host`

Allowed:

- Manifest validation
- Permission enforcement
- Command registration
- Local plugin loading
- Plugin storage scoping
- Plugin lifecycle
- Proposed-patch review and application

Not allowed:

- Granting undeclared permissions
- Running native plugins without explicit approval
- Allowing plugins to mutate live document objects
- Downloading models or running native services silently

### 6.6 `cdx-compat`

Allowed:

- CDXML parser/writer
- Best-effort CDX reader/paste support
- CDX binary writer later
- CDXML/CDX intermediate model
- Unknown object preservation
- Compatibility warnings
- Compatibility fixture tests

Not allowed:

- Becoming the native document model
- Depending on GPL code
- Pretending compatibility is perfect when unsupported objects are approximated

### 6.7 `clipboard-adapter`

Allowed:

- Platform clipboard format detection
- CDXML/CDX/MOL/RXN/SMILES/SVG/PNG/plain-text clipboard handling
- Warnings for lossy paste/copy behavior

Not allowed:

- Silent lossy conversion
- Platform-specific behavior hidden from tests/docs

### 6.8 `layout-engine`

Allowed:

- Group/ungroup
- Align/distribute
- Rotate/flip
- Z-order
- Page size/margins
- Snap/guides
- Bond-length normalization

Not allowed:

- Changing chemical identity during cleanup or layout

### 6.9 `shortcut-engine`

Allowed:

- Command-bound shortcut registry
- Type-to-build behavior
- Shortcut conflict detection

Not allowed:

- Hard-coding important drawing actions only inside button click handlers
- Copying proprietary shortcut documentation verbatim

### 6.10 `mechanism-tools`

Allowed:

- Curved arrows
- Half-headed arrows
- Lone-pair marks
- Radical-electron marks
- Editable mechanism annotation geometry

Not allowed:

- Storing editable mechanism annotations only as opaque SVG

### 6.11 `template-library`

Allowed:

- Original templates
- Common rings
- Common abbreviations/superatoms
- Original amino acid and sugar templates
- Basic R-group/generic-atom display helpers
- Style presets
- Template metadata tests

Not allowed:

- Copying proprietary templates or sample files
- Treating abbreviations/superatoms as plain labels when chemical metadata exists

### 6.12 `style-compat`

Allowed:

- External style-sheet parsing/import, including ChemDraw `.cds`
- Conversion of supported style settings into native ChemDraft style presets
- Source metadata and unknown-field preservation where practical
- Warning generation for unsupported or lossy settings
- Synthetic/legal fixture tests

Not allowed:

- Becoming the native style source of truth
- Treating `.cds` as molecule, reaction, page, or document import
- Parsing `.cds` ad hoc inside random UI components
- Committing user-provided `.cds` files or derived proprietary fixtures without clear redistribution rights
- Pretending a failed or partial import fully succeeded

### 6.13 `examples/plugins/molscribe-ocsr`

Allowed:

- Plugin manifest and README scaffold
- Image-to-structure command stub
- Recognized-structure result type usage
- Fake recognition output for UI and permission testing
- Source-image preservation
- Proposed-patch acceptance flow
- Clear instructions for later local-service integration
- License and citation notice for external MolScribe when real integration is added

Not allowed:

- Installing PyTorch, OpenCV, transformers, Hugging Face tooling, or model checkpoints in foundation tasks
- Running native code without explicit `native.execute` permission
- Downloading model weights without explicit user action
- Silently inserting recognized structures without user review
- Deleting or replacing the source image without user action

### 6.14 `ui-kit`

Allowed:

- Original icons
- Buttons
- Panels
- Menus
- Dialogs
- Theme tokens

Not allowed:

- Proprietary icon copies
- Proprietary UI assets
- Chemistry logic

### 6.15 `toolset-registry`

Allowed:

- Manifest schemas
- Layout/customization schemas
- User toolsets
- User overrides
- Menu model generation
- Toggle command generation
- Command-ID validation

Not allowed:

- Chemistry behavior
- Plugin permission grants
- Direct Tauri window creation
- Direct React rendering
- Copying ChemDraw toolbar XML, schema, or assets

### 6.16 `viewport-engine`

Allowed:

- Scale/origin state
- Coordinate conversion
- Focal zoom math
- Ruler render state
- Pan/pinch helper math

Not allowed:

- Document mutation
- Chemistry object ownership
- Direct renderer ownership
- Dependency-specific black-box state

## 7. Plugin API rules

Plugins must declare a manifest.

Required manifest fields:

```text
id
name
version
apiVersion
entry
permissions
```

Plugins may contribute:

```text
commands
menus
panels
toolbar buttons
inspectors
templates
importers
exporters
analyzers
transformers
recognizers
```

Plugins must not receive capabilities they did not declare.

Plugin permissions include:

```text
document.read
document.write
document.proposePatch
selection.read
selection.write
analysis.write
ui.panel
ui.toolbar
ui.menu
chemistry.compute
clipboard.read
clipboard.write
image.read
ml.inference
model.load
model.download
filesystem.read
filesystem.write
network.fetch
native.execute
plugin.storage
```

Dangerous permissions:

```text
filesystem.write
network.fetch
native.execute
model.load
model.download
clipboard.read
document.write
image.read when not limited to a user-selected image/crop
```

Image-to-structure recognizer plugins should return typed recognition results, not mutate the document directly. The result should include, where available:

```text
source image reference
proposed SMILES
proposed molfile
overall confidence
atom-level confidence
bond-level confidence
recognition warnings
proposed insertion patch
```

The user must approve insertion. The plugin host applies accepted patches through the normal document patch API.

## 8. MolScribe OCSR plugin rules

The MolScribe OCSR plugin is the preferred first serious plugin after the command registry, plugin API, permission system, and proposed-patch workflow exist.

Required behavior:

```text
input: selected image, pasted image, or image file chosen by the user
output: recognition result containing SMILES, MOL block, confidence, atom/bond candidates, and warnings
mutation: proposed patch only; user must accept before insertion
validation: run through available chemistry adapters before insertion where possible
retention: source image remains available unless user explicitly deletes or replaces it
```

Required warnings:

```text
low confidence
missing confidence data
stereochemistry uncertainty
charge/radical uncertainty
abbreviation/superatom uncertainty
invalid or unsanitized SMILES/MOL
network inference used
local model/checkpoint missing
```

Allowed implementation path:

```text
Phase A: plugin scaffold with mocked fixture output
Phase B: native-service/Python sidecar contract
Phase C: local model inference with user-supplied checkpoint
Phase D: optional checkpoint download with explicit approval
Phase E: confidence overlay and fixture-based accuracy tests
```

Do not vendor large checkpoints into the repository. Do not present recognized structures as guaranteed correct.

## 9. Command registry rules

Built-in tools and plugin tools should use the same command system whenever practical.

Visible menu, quick-action toolbar, floating/dockable palette, keyboard shortcut, command-palette, and plugin menu/toolbar/panel actions must be backed by command definitions where practical.

Do not wire major behavior only through button-local handlers. Placeholder tools may exist as disabled command definitions, but they must not pretend to perform chemistry.

Examples of commands:

```text
document.new
document.open
document.save
export.svg
export.png
export.pdf
export.rxn
clipboard.copy
clipboard.paste
style.importStyleSheet
style.applyPreset
style.setDefaultPreset
style.managePresets
chemistry.validateSelection
chemistry.calculateFormula
chemistry.calculateMass
chemistry.showCharge
structure.clean
structure.calculateMass
mechanism.curvedArrow
mechanism.lonePair
mechanism.radicalDot
layout.group
layout.ungroup
layout.align
layout.distribute
layout.rotate
layout.flip
template.insert
plugin.massspec.predictFragments
plugin.molscribeOcsr.recognizeImage
```

A command should be invokable from menu, quick-action toolbar, floating/dockable tool palette, keyboard shortcut, command palette later, and plugin call where appropriate.

Do not hard-code important actions only inside button click handlers.

## 10. Chemistry invariants

Every chemistry conversion path should preserve these unless explicitly warned:

```text
atom identity
bond order
formal charge
isotope labels
radicals
stereochemistry
abbreviations/superatoms where represented
basic R-group/generic-atom display where represented
reaction roles
reaction components
coordinates where applicable
mechanism annotations where applicable
```

Style preset import or application must not change chemical identity. If geometry or appearance changes in a way that could affect interpretation, it must be explicit, warning-producing when needed, and undoable where practical.

Tests should compare, when possible:

```text
canonical SMILES
formula
total charge
stereochemistry annotations
atom count
bond count
reaction component count
coordinates within tolerance
recognition result warnings
```

## 11. CDXML/CDX compatibility rules

Compatibility support should be fixture-driven.

Tier A supported objects:

```text
atoms
bonds
fragments
coordinates
charges
isotopes
radicals
wedge/dash stereochemistry
E/Z geometry where represented
abbreviations/superatoms
basic R-group/generic-atom display
text
simple arrows
plus signs
basic brackets
basic styles
```

Unknown CDXML/CDX objects should be preserved where practical. If they cannot be preserved, produce a warning.

Never claim full compatibility unless fixture coverage supports it.

Prioritize CDXML writing/import and best-effort CDX reading/paste before broad CDX writing.

## 12. UI rules

The UI should feel familiar to chemistry drawing users but use original assets and implementation. Functional familiarity is acceptable. Do not copy proprietary visual assets, proprietary templates, proprietary menu/help text, or proprietary trade dress.

Default layout:

```text
Top:      native or native-feeling menu plus dense quick-action toolbar
Center:   dominant document/page workspace with optional rulers, guides, and grid
Palette:  compact icon-first floating or dockable drawing tools
Panels:   inspector and plugin panels hidden by default, opened only when needed
Bottom:   compact status bar
```

Tool buttons should be icon-first with original SVG/icon glyphs, tooltips, accessible labels, and shortcut support. Text labels may appear in tooltips, menus, command palettes, and accessibility labels; they should not become a large text-button chemistry toolbar.

Native floating utility palettes are allowed in the desktop app. They should be associated with the active document window where possible, avoid global always-on-top by default, and route every action through command IDs. Browser/web builds may use in-window floating palettes as a fallback.

Do not show fake chemistry placeholders. Molecule, reaction, arrow, product, mechanism, and similar objects shown in the workspace must be real `chem-core` document objects, or explicitly disabled development placeholders. Prefer an honest "EditorAdapter not connected" state over fake chemistry.

Do not copy proprietary UI artwork.

## 13. Testing requirements

For every meaningful change, add or update tests.

Required test types by area:

```text
chem-core:        schema, patch, serialization, migration tests
plugin-api:       manifest schema, permission, result type tests
plugin-host:      permission, command, lifecycle, proposed-patch tests
chemistry:        validation, formula, mass, charge, and stereochemistry-warning fixture tests
cdx-compat:       parser, writer, best-effort CDX read, round-trip fixture tests
style-compat:     synthetic/legal .cds import, unsupported-field warnings, malformed-input failures
clipboard:        format detection and lossy/warning behavior where testable
export-engine:    export output and warning tests
adapters:         adapter contract tests
ui:               command wiring, floating/docked palette routing, and smoke tests
toolsets:         customization state, persisted layout application, plugin/user toolsets, unregistered command rejection, native menu/window alignment where practical
viewport:         coordinate conversion, focal-point zoom, ruler/zoom sync, gesture/pinch behavior where practical
recognizers:      mocked output, confidence/warning display, source-image preservation, proposed patch flow
```

If a test cannot be written yet, explain why in the final agent report and add a specific TODO only if it is actionable.

Bad TODO:

```text
TODO: fix later
```

Good TODO:

```text
TODO(cdx-compat): preserve CDXML graphic object rotation once GraphicObject.rotation is added to chem-core.
```

## 14. Error handling rules

Errors should be explicit.

Bad:

```text
Import failed.
```

Better:

```text
CDXML import failed: unsupported bond display type "WedgeHashBegin" in object b42.
```

For user-facing messages, keep them concise. For logs, include technical details.

Recognition-specific errors should report missing model, missing checkpoint, low confidence, invalid predicted structure, unavailable local service, or unauthorized network/native execution distinctly.

## 15. Performance rules

Do not load heavy chemistry or recognition engines at startup unless required.

Prefer:

- Lazy loading RDKit/WASM.
- Lazy loading plugin panels.
- Lazy loading optional import/export tools.
- Lazy loading MolScribe OCSR only when the plugin command is invoked.
- Small package boundaries.
- Avoiding heavy dependencies for trivial operations.

## 16. Security rules

Do not implement features that allow arbitrary code execution without explicit plugin permissions.

Do not allow plugins to:

- Access arbitrary files unless granted.
- Write arbitrary files unless granted.
- Access the network unless granted.
- Run native code unless granted.
- Download model weights unless granted and user-initiated.
- Send images to remote recognition services unless `network.fetch` is granted and clearly disclosed.
- Read clipboard unless granted.
- Mutate documents except through patch/proposed-patch APIs.

Sanitize imported files. Malformed imports should fail safely.

## 17. Codex working style

When using Codex or another coding agent:

1. Keep the task narrow.
2. Modify the smallest reasonable set of files.
3. Preserve package boundaries.
4. Add tests.
5. Run relevant tests.
6. Report changed files.
7. Report commands run.
8. Report failures honestly.
9. Do not hide uncertainty.
10. Do not invent dependency capabilities.

## 18. Expected agent report format

At the end of a coding task, report:

```text
Summary:
- What changed

Files changed:
- path/to/file

Tests run:
- command

Results:
- pass/fail details

Known limitations:
- Specific limitations, if any

Recommended next task:
- One concrete next step
```

## 19. Initial commands

Use the actual repository scripts once they exist. Initial expected commands:

```bash
pnpm install
pnpm lint
pnpm test
pnpm build
git diff --check
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

If hit-testing, pointer behavior, or the agent bridge changes, also run the relevant DOM/agent bridge/drawing-tool suites.

Manual stress must cover tab initialization, user tab persistence, mixed states, multi-molecule scaling, sparse override precedence, terminal carbon labels, hidden implicit hydrogens, explicit hydrogens, fonts, save/reopen, undo/redo, Spin 3D, atom-label editor placement, SVG export, and ring selection after tab switching/closing.

## Closeout Requirements

At implementation closeout:

- Update the build stamp in this file.
- Update the `Build` string in `apps/desktop/src/MainWindow.tsx`.
- Report tests run and any skipped verification.
- Keep the final answer focused on the branch and the specific slice completed.
