# Agent Instructions for ChemDraft

**Current Build**: 6.19.19.39-codex

> [!IMPORTANT]
> **Agent Instruction:** Every time you finish a slice of work or make significant changes, you MUST update the `**Current Build**` stamp above AND the corresponding `Build` string in `apps/desktop/src/MainWindow.tsx` (in the viewport's bottom right corner).
> The version format is `[month].[day].[hour].[minute]-[agent_name]` (e.g. `6.6.7.42-antigravity`). This helps the user track if their local build is stale.

This file governs how AI coding agents, Codex, and human contributors should work in this repository.

ChemDraft is a lightweight, open-source chemical drawing application with a plugin architecture. The core app must stay small, stable, testable, legally clean, and focused on drawing workflows.

Do not use **MolScribe** as the app name. MolScribe refers to the external image-to-graph molecular recognition project and, in this repository, only to the optional **MolScribe OCSR** plugin or integration.

## 1. Read before coding

Before making changes, read:

```text
PLAN.md
AGENTS.md
README.md
package.json
pnpm-workspace.yaml
```

If the task touches a package, read that package's README or local documentation before editing.

## 2. Core priorities

The priorities are, in order:

1. Chemical identity must not be silently changed.
2. The core drawing workflow must be fast and reliable.
3. Migration-critical workflows must not be treated as optional bloat: Office-friendly copy/paste, CDXML with stereochemistry, best-effort CDX read/paste, RXN, mechanism annotations, abbreviations/superatoms, basic R-group display, templates/styles, layout tools, and hotkeys are core release concerns.
4. The native document model must remain stable and versioned.
5. Advanced and heavy features should use plugins when possible.
6. External engines must be isolated behind adapters or plugin service boundaries.
7. Compatibility formats must not become the internal source of truth.
8. The codebase must avoid proprietary assets and visual cloning.
9. Tests must cover chemistry, compatibility, clipboard behavior, layout, mechanism annotations, plugin boundaries, and recognition-plugin proposed patches.

## 3. What this app is

The app is:

- A lightweight chemical drawing application.
- A local-file-first desktop app.
- A familiar structure, reaction, and mechanism drawing workflow.
- A manuscript and slide figure-preparation tool.
- A plugin-capable chemistry tool.
- An open-source project.

The app is not:

- A direct ChemDraw clone.
- A full ELN.
- A cloud chemistry suite.
- A proprietary-format-only editor.
- A dumping ground for every chemistry feature request.
- A full chemistry prediction or naming platform in the core.
- An AI image-recognition app in the core.

## 4. Architecture boundaries

Respect these boundaries.

```text
chem-core          Owns native document model, schemas, patches, migrations
editor-adapter     Defines abstract drawing editor interface
ketcher-adapter    Wraps Ketcher only through EditorAdapter
chemistry-adapter  Defines abstract chemistry computation interface
rdkit-adapter      Wraps RDKit or RDKit-like functionality
cdx-compat         Owns CDXML/CDX import/export compatibility
clipboard-adapter  Owns native clipboard formats and Office-friendly copy/paste
style-compat       Owns external style-sheet compatibility such as `.cds` import
layout-engine      Owns page/object layout operations
shortcut-engine    Owns command-bound shortcuts and type-to-build behavior
mechanism-tools    Owns mechanism annotation primitives and rendering hooks
template-library   Owns original templates, abbreviations/superatoms, and style presets
toolset-registry   Owns typed toolset manifests, built-in/plugin/user toolset models, customization state, menu models, and command-ID validation
viewport-engine    Owns viewport state, coordinate conversion, zoom math, and ruler render state
apps/desktop/src/surfaces  Local UX surface metadata scaffold for menu/status/canvas-control/panel chrome; metadata only
plugin-api         Defines public plugin API types
plugin-host        Loads plugins, validates manifests, enforces permissions
export-engine      Coordinates export formats
ui-kit             Owns original UI components and icons
window-manager     Owns native floating utility palette/window coordination if shared; otherwise keep it app-specific
examples/plugins/molscribe-ocsr  Optional MolScribe OCSR plugin scaffold; never a core dependency
apps/desktop       Wires packages into the Tauri desktop app
```

Do not create cross-package shortcuts that violate these responsibilities.

## 5. Hard rules

### 5.1 Do not copy proprietary assets

Do not copy ChemDraw icons, toolbar art, templates, help text, menu text verbatim, sample files, proprietary splash screens, fonts, or branded assets.

Functional familiarity is allowed. Direct visual copying is not.

### 5.2 Do not make CDXML/CDX the native document model

The native document model lives in `chem-core`. CDXML/CDX support lives in `cdx-compat`.

Correct direction:

```text
native document -> cdx-compat -> CDXML/CDX
CDXML/CDX -> cdx-compat -> native document
```

Incorrect direction:

```text
entire app state == CDXML/CDX
```

### 5.3 Do not let plugins mutate documents directly

Plugins may request changes only through proposed patches or controlled document APIs.

Forbidden pattern:

```ts
document.pages[0].objects.push(object);
```

Allowed pattern:

```ts
await ctx.documents.proposePatch({
  op: "addObject",
  pageId,
  object,
  reason: "recognized-structure"
});
```

The host applies accepted patches.

### 5.4 Do not bypass adapters

Do not import Ketcher, RDKit, MolScribe OCSR, Open Babel, or other external engines throughout the app.

Use adapter packages or plugin service boundaries.

Forbidden pattern:

```ts
import { something } from "ketcher";
```

inside random UI packages.

Allowed pattern:

```ts
import type { EditorAdapter } from "@chemdraft/editor-adapter";
```

The current exception is the narrow desktop Ketcher host component that lazy-loads `ketcher-react` and `ketcher-standalone` to create an `EditorAdapter` host. Do not copy that import pattern into other UI files.

### 5.5 Do not add unreviewed dependencies

Before adding a dependency, check license, size, maintenance status, actual need, native build complexity, and compatibility with the intended project license.

Avoid dependencies for simple utilities.

### 5.6 Do not add GPL/AGPL code to permissive core packages by accident

GPL or AGPL tools may be useful, but they must not be embedded into the core unless the project explicitly accepts the license implications.

Safer pattern:

```text
optional external converter
separate plugin
separate process
clear license notice
```

### 5.7 Do not silently degrade chemistry

If an operation cannot preserve chemical meaning, return a warning or error.

Examples:

- Lost stereochemistry
- Lost charge
- Lost radical state
- Unsupported isotope
- Unsupported polymer bracket
- Unsupported atom list
- Unsupported reaction mapping
- Approximated arrow type
- Abbreviation/superatom downgraded to plain text
- R-group display lost
- Mechanism annotation exported only as a graphic
- AI-recognized structure inserted without validation or user approval

### 5.8 Do not defer basic Office-friendly clipboard behavior

For migration work, basic copy/paste is a core user workflow.

Required minimum:

```text
copy to SVG/PNG for Office-style apps
copy chemical payload where supported
paste CDXML/CDX/MOL/RXN/SMILES where supported
warn when paste/import becomes image-only or lossy
```

Full Office add-ins, OLE servers, and edit-in-place Office integration are not required for the first release.

### 5.9 Do not make the page a set of isolated molecule islands

The native document is a composited page containing molecules, reactions, arrows, mechanism annotations, text, brackets, and graphics. Ketcher or another editor may own the active structure-editing session, but it must not become the whole document model.

Cross-object reaction arrows, mechanism arrows, reaction conditions, layout, and export must work at page level.

### 5.10 Do not store editable mechanism annotations as opaque SVG only

Curved arrows, half-headed arrows, lone-pair marks, and radical-electron marks must be represented as native editable objects when they are part of the document.

SVG-only export is fine. SVG-only storage is not fine for editable core annotations.

### 5.11 Do not treat naming as solved without proof

Name-to-structure and structure-to-name are migration pressure points. Do not claim robust support unless the implementation is present, licensed appropriately, tested, and documented with limitations.

OPSIN-style name-to-structure may be an optional plugin. It must be labeled as name-to-structure only. Do not imply structure-to-name support from OPSIN or from any placeholder.

### 5.12 Do not treat abbreviations/superatoms as cosmetic text

Abbreviations/superatoms are a core migration workflow. They should preserve collapsed labels, expansion metadata, attachment points, and compatibility warnings where feasible.

Do not silently convert a chemically meaningful abbreviation into plain text.

### 5.13 Do not treat hotkeys as polish

Keyboard shortcuts and type-to-build behavior are part of the product, not decoration. Important drawing actions must be command-bound and testable through `shortcut-engine` or equivalent command-routing code.

Do not copy proprietary shortcut documentation verbatim.

### 5.14 Prioritize CDX read before CDX write for migration

Migrants need to open old files and paste from existing tools before they need perfect CDX writing. When implementing CDX, prefer a tested best-effort read/paste path before broad write support.

### 5.15 Keep OCSR and other AI recognition optional and reviewable

Image-to-structure recognition, including integrations based on the external MolScribe OCSR project, belongs in optional plugins or services. It must not become core startup code.

Recognizer plugins must:

- Require explicit user action on a selected/imported image or crop.
- Return proposed molecule/reaction objects or proposed patches, not direct document mutation.
- Show confidence and validation warnings.
- Require user acceptance before inserting generated chemistry.
- Preserve source-image context where feasible.
- Avoid hidden model downloads, hidden network calls, or silent native execution.
- Keep PyTorch, OpenCV, model checkpoints, and other heavy recognition dependencies out of core packages.

For MolScribe OCSR or similar plugins:

- Do not vendor external code into the core app.
- Do not add PyTorch, OpenCV, Hugging Face download logic, model checkpoint loading, or Python service startup to the core app.
- Use a local-service/native-service plugin boundary with explicit permissions when real inference is implemented.
- Document license notices, model-checkpoint source, citation expectations, and dependency licenses.

### 5.16 Do not build dashboard UI

Do not build ChemDraft like a generic web dashboard. The default UI must be a compact desktop drawing workspace: dense, functional, icon-first, and document-centered.

Forbidden UI patterns:

- Large text-labeled vertical tool buttons as the main chemistry toolbar.
- Permanent right inspector in the default view.
- Fake dashed molecule, reaction-arrow, product, or mechanism placeholders.
- Fake mechanism, product, analysis, or reaction placeholders.
- Plugin demo buttons hard-coded into the inspector.
- Rounded card-based dashboard layout.
- SaaS navigation rails.
- Decorative UI that reduces drawing workspace density.
- Copied proprietary icons, toolbar art, templates, help text, menu text, trade dress, or brand identity.

Required UI patterns:

- Native or native-feeling menu bar.
- Dense quick-action toolbar.
- Dominant document/page workspace.
- Compact icon-first floating or dockable tool palette.
- Optional inspector and plugin panels hidden by default.
- Original SVG/icon glyphs.
- Tooltips, accessible labels, and shortcut support.

Do not show molecule, reaction, arrow, product, or mechanism placeholders unless they are backed by real `chem-core` document objects or explicitly marked as disabled development placeholders. Prefer an honest "EditorAdapter not connected" placeholder over fake chemistry.

Do not show molecule, reaction, mechanism, arrow, product, or analysis objects unless they are backed by `chem-core` document objects, produced by the active editor adapter and explicitly represented as adapter-backed temporary state, or clearly marked as disabled/unavailable development placeholders. Prefer "EditorAdapter not connected" or "No selected structure" over fake chemistry content.

### 5.16.1 Design language rules

Use this design-language phrase in documentation when describing the direction:

```text
Restrained technical minimalism: Metro-like canvas minimalism with Material-like interaction clarity.
```

ChemDraft should feel like a precision scientific drawing tool, not a consumer note-taking app. The canvas should be flat, quiet, typographic, low-chrome, and content-first. Surrounding controls should have consistent spacing, predictable component states, and clear hover, active, focus, selected, and disabled feedback.

For the current desktop shell, `apps/desktop/src/App.css` is the canonical design-token layer. Do not create separate `App.css` and `ui-kit` token systems that can drift. Export or expand `ui-kit` design tokens only when another package actually needs them, and document which layer is canonical.

Use `#1d7f68` as the restrained accent, with derived shades allowed when contrast requires readable active, selected, hover, or focus states. Red remains semantic for invalid, delete, and warning states.

Style only ChemDraft-owned Ketcher host and wrapper chrome. Do not patch vendored Ketcher internals or change Ketcher behavior as part of visual cleanup.

Design-language cleanup work must not change molecule drawing behavior, bond creation behavior, selection logic, file formats, chemistry model logic, renderer math, command IDs, keyboard shortcuts, or tool behavior except for visual state styling such as selected, hover, focus, disabled, and active affordances.

Tests for design-language work should be focused and non-brittle: token-shape checks, render smoke tests, and existing layout or behavior tests. Do not add pixel-perfect tests unless the repo already has that convention.

### 5.17 Phase closeout and current boundary

Do not consider Phase 4 complete if it only displays visual placeholders.

Phase 4 completion requires real implemented behavior or clearly labeled adapter-backed fallback behavior for:

- Document creation.
- Editor adapter path.
- Save/open.
- Insert/update document object or explicit adapter-backed state.
- SVG/PNG export.
- Status reporting.
- Tests.

The Phase 4.5 toolset/viewport interlude should wire persisted user toolbar layout state into desktop startup/menu/window generation and keep Rust/Tauri menu behavior aligned with the TypeScript registry model.

Phase 5 should focus on `chemistry-adapter`, `rdkit-adapter` or an honest placeholder, selected-structure validation, formula, average mass, exact mass where available, total charge, basic stereochemistry warnings where available, and fixture tests.

Phase 5 should not add broad UI polish, new toolbar concepts, CDXML/CDX compatibility, clipboard compatibility, NMR/MS/pKa/logP plugins, or image-to-structure recognition unless explicitly requested.

Phase 6 editor engine hardening is conditionally complete as an adapter boundary. `KetcherAdapter` exists with capability reporting and molecule load/save contracts. Phase 7.1 adds a narrow lazy desktop Ketcher host for active selected-molecule editing only; this does not mean Ketcher owns the ChemDraft document canvas. Keep page-level gaps explicit and keep `chem-core` as the composited page source of truth.

Phase 6.5 canvas page-size infrastructure is closed out and should be treated as the baseline for later drawing, export, and layout work. Preserve native page layout state, geometry invariants, legacy migration, command-backed US Letter, US Legal, popular ISO A-size, portrait, and landscape controls under File > Page Setup, document-backed viewport/ruler/crosshair/object/export geometry, and tests.

The current next implementation lane is Phase 7: core drawing productivity. Do not restart Phase 6.5 unless fixing a regression.

Phase 7 rules:

- Keep tools command-backed.
- Tool buttons may activate tools only through command/state architecture.
- Do not wire chemistry behavior only into button-local handlers.
- Do not show fake molecule, reaction, mechanism, arrow, product, or analysis output.
- Unsupported tools must remain disabled or report explicit unavailable state.
- Do not import Ketcher or RDKit directly into random UI code. Direct Ketcher imports are allowed only in the narrow desktop Ketcher host boundary, or a named successor host boundary, and must not spread.
- Use `editor-adapter`, `chem-core`, and command-registry boundaries.
- Do not turn Phase 7 into CDXML/CDX, clipboard, OCSR, `.cds` style import, NMR/MS/pKa/logP, full Page Setup, add-page UI, drag/drop toolbar customization, or broad UI-polish work.

### 5.18 Floating palette rules

Floating tool palettes may be native desktop windows in the Tauri app. In-window floating palettes are acceptable fallback or secondary behavior, especially for browser/web builds.

Rules:

- Palette windows route actions through command IDs.
- Palette windows do not import Ketcher or RDKit directly.
- Palette windows do not mutate `chem-core` state directly.
- Palette windows do not own chemistry behavior.
- Do not use global always-on-top by default.
- Do not turn the tool palette into a permanent SaaS-style sidebar.
- Native floating palette behavior should live behind a desktop window-manager boundary, not random UI code.

### 5.19 Toolset customization rules

Toolbars/toolsets are declarative command-backed data.

Rules:

- Toolbar buttons invoke command IDs; they do not own chemistry behavior.
- Built-in toolsets come from ChemDraft manifests.
- Plugin toolsets come from plugin contributions.
- User toolsets and user customizations come from versioned user layout state.
- User customization must not mutate built-in manifests.
- User customization must not mutate plugin manifests.
- User customization must not grant plugin permissions.
- User customization must not bypass command registration.
- User customization must not duplicate command implementations.
- Persisted user layout state must be applied before menu/window models are finalized.
- If a user customization references an unregistered command ID, reject it or disable it with a clear warning.

When changing desktop toolbar/menu/window startup behavior, keep these in sync:

- TypeScript toolset registry.
- Persisted user layout state.
- Native Tauri View > Toolbars menu.
- Native toolset windows.
- Web fallback toolsets.
- Command registry.

Do not let Rust menu generation and TypeScript registry behavior drift apart. If Rust must parse shared JSON, tests or fixtures must cover alignment.

Full drag-and-drop toolbar customization UI is deferred until the state model is wired and tested. Do not add a drag-and-drop dependency until implementing the real customization editor. Prefer `dnd-kit` for that future editor. Do not use `react-beautiful-dnd`.

### 5.20 ChemDraw toolbar XML boundary

Do not copy ChemDraw toolbar XML, schemas, command IDs, icon names, images, menu files, command definition files, file paths, or toolbar art.

Uploaded ChemDraw custom toolbar files may be used only as conceptual evidence that toolbar layout can be declarative. They are not ChemDraft runtime fixtures and should not be committed or imported unless an explicit clean-room compatibility task is created.

### 5.21 Viewport and ruler ownership

`viewport-engine` is the source of truth for viewport state.

Rules:

- Ruler renderers consume viewport state; they do not own geometry.
- Zoom, pinch, and pan behavior must preserve coordinate conversion correctness.
- Do not hide scale/origin math inside React components.
- Do not add another viewport dependency without updating dependency inventory and tests.
- Any pointer or hit-testing work must use viewport conversion helpers.

### 5.22 Page layout and canvas geometry

Page size lives in native page layout state. Do not let React canvas constants, CSS literals, ruler renderers, or export helpers become the geometry source of truth.

Rules:

- `chem-core` owns page layout state: paper preset, orientation, internal CSS-pixel size, margins, and source physical units.
- If both `page.width`/`page.height` and `page.layout.widthPx`/`page.layout.heightPx` exist, they must match. Treat top-level width/height as denormalized compatibility fields, not a second source of truth.
- Legacy pages without layout metadata must migrate cleanly to US Letter portrait without changing objects, selection, molecule payloads, or chemistry metadata.
- `MainWindow` must not define hard-coded Letter dimensions as the canvas geometry source of truth.
- Viewport, rulers, crosshairs, object positioning, hit testing, and export must consume document page layout.
- Page-size changes must be command-backed and patch-based.
- Page-size changes must not scale, move, reorder, select, deselect, or chemically alter page objects.
- SVG export should use physical `width`/`height` units from page layout when available while keeping `viewBox` in ChemDraft CSS-pixel coordinates. PNG export remains pixel-based.
- Rulers, grid, and crosshair tick spacing should follow the active page family: inches for US paper presets and centimeters for ISO A presets.
- The first page-size UI should stay command-backed and minimal under File > Page Setup: US Letter, US Legal, popular ISO A sizes, portrait, and landscape.
- Full Page Setup UI, custom-size editing, printing, favorites, and broad layout tooling remain deferred until explicitly scoped.

Required page-size tests:

- US Letter, US Legal, popular ISO A-size conversion and orientation.
- Invariant enforcement between layout dimensions and denormalized page dimensions.
- Legacy Phase 4 document migration.
- Save/open preservation.
- SVG physical units plus CSS-pixel `viewBox`.
- PNG export avoiding hard-coded Letter fallback.
- Ruler/grid/crosshair unit switching between US and ISO page families.
- Page-size commands preserving object coordinates, selection, and molecule payloads.

### 5.23 Style sheets and default styles

ChemDraw `.cds` files are compatibility inputs to native ChemDraft style presets. They are not molecule, reaction, page, document, or native style model formats.

Rules:

- Native style presets in `chem-core`, `template-library`, or a dedicated style package are the source of truth.
- `.cds` parsing/import belongs in `style-compat` or a documented temporary style compatibility boundary.
- Import style sheets through command-backed actions such as `style.importStyleSheet`.
- Apply presets, set default presets, and manage presets through command definitions.
- Do not fake successful `.cds` import. Report unsupported settings, malformed input, and lossy conversions.
- Do not commit user-provided `.cds` files such as `Tot_Syn_Style.cds` or derived fixtures unless redistribution rights are clear.
- Public tests should use synthetic or generated style fixtures.
- Applying a style preset must not change chemical identity and should be explicit and undoable where practical.

### 5.24 UX surface flexibility

Do not bake user-facing controls into permanent architecture. Chemistry behavior, document state, command IDs, plugin permissions, adapter boundaries, and viewport coordinate math are stable contracts. Menu placement, toolbar grouping, panel layout, labels, icons, status items, canvas controls, shortcut maps, and default visibility are volatile surfaces and should be configurable where practical.

For every new user-facing control:

- Use a command ID if it performs an action.
- Use a surface ID if it appears somewhere.
- Include slot or placement metadata where relevant.
- Include `source`: `core`, `plugin`, `user`, or `owner`.
- Add test or smoke coverage for command routing where practical.

Keep owner defaults, user preferences, and document state separate:

- Owner defaults are project-level layout/style choices and may change as product direction changes.
- User preferences are local app configuration such as toolbar visibility, panel state, and shortcut overrides.
- Document state travels with `.chemdraft` files, including pages, page sizes, objects, and document-used styles.

Do not store owner defaults or installed-user preferences in the native document unless the value truly belongs to the file. Do not treat document state as a convenient place to remember local UI layout.

Plugin-contributed panels, menus, toolbar buttons, and future canvas controls should use the same command/surface contribution system where practical. Plugins must not directly mutate core UI layout without declared contributions and permissions.

If a control is hard-coded temporarily:

- Name the command it should eventually invoke.
- Explain why hard-coding is temporary.
- Keep the hard-coded placement local instead of spreading it across multiple files.

UX surface tests should focus on command routing, surface registration, owner/user/document state separation, no document mutation from pure UX changes, and no chemistry mutation from layout changes.

The local `apps/desktop/src/surfaces` module may describe menu, status, canvas-control, panel-trigger, and empty-state metadata. It must not own chemistry behavior, document mutation, plugin permissions, command implementation, or rendering side effects. Surface metadata may reference command IDs, but command implementation stays in the command registry or the relevant owning package.

Disabled future surfaces, including `surface.canvas.addPageAfter`, must not be rendered as active controls until the referenced command exists and is wired. Phase 6.5 page-size infrastructure is closed out; the next implementation lane is Phase 7 core drawing productivity, not a full UX registry package, add-page button, plugin surface renderer, or customization UI.

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
pnpm --filter desktop tauri dev
```

If scripts are missing, add them or explain why they cannot be added yet.

## 20. Dependency policy

Before adding a dependency, document:

```text
package name
purpose
license
why it is needed
whether it is core or optional
whether it affects distribution
```

Prefer dependencies that are maintained, small, permissively licensed, well documented, and easy to replace.

Avoid dependencies that are unmaintained, huge for trivial functionality, GPL/AGPL in permissive core packages, native-heavy without a clear reason, or security-sensitive without strong maintenance.

For heavy recognition plugins such as MolScribe OCSR, keep Python, PyTorch, OpenCV, model checkpoints, and Hugging Face download logic out of core packages. They may live in an optional plugin or native-service wrapper with explicit permissions, user approval, and license notices.

## 21. Naming policy

Avoid names that imply affiliation with proprietary chemistry products.

Avoid:

```text
ChemDrawFree
OpenChemDraw
ChemDrawLite
CDraw
ChemOfficeOpen
MolScribeApp
```

Acceptable working names:

```text
ChemDraft
MolCanvas
OpenStructure
MolDraft
```

Do not use MolScribe as the app name unless the project intentionally accepts collision with the established external OCSR project. Use `MolScribe OCSR` only for the plugin/integration that wraps `thomas0809/MolScribe`.

## 22. First milestone focus

The first milestone should establish the foundation, not the full chemistry feature set.

Implement first:

```text
monorepo
desktop shell skeleton
package skeletons
native document schema
plugin API schema
command registry
example plugin command through the command/plugin contribution system
MolScribe OCSR placeholder plugin manifest and README only
tests
```

Do not start with:

```text
real MolScribe OCSR inference
PyTorch/OpenCV/model checkpoints
NMR prediction
mass-spec prediction
full CDX binary writer
cloud sync
ELN features
full structure-to-name
```

## 23. Guiding rule for feature requests

When a new feature request arrives, classify it:

```text
Core drawing workflow
Core document/import/export workflow
Core clipboard/migration workflow
Plugin infrastructure
Plugin feature
Deferred feature
```

Treat these as core drawing or migration workflow unless there is a strong reason not to:

```text
Office-friendly copy/paste
CDXML import/export with stereochemistry
best-effort CDX read/paste
RXN import/export
mechanism arrows and electron/lone-pair/radical glyphs
abbreviations/superatoms
basic R-group display
basic templates and style presets
native default style presets
ChemDraw .cds style-sheet import into native style presets
layout and page editing
hotkeys and type-to-build behavior
```

Treat these as plugin or deferred features:

```text
MolScribe OCSR image-to-structure recognition
NMR prediction
MS fragmentation
pKa/logP/logS
retrosynthesis
ELN/cloud integrations
full structure-to-name
advanced SAR tables
stoichiometry grids
```
