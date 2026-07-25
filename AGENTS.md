# Agent Instructions for ChemDraft

This file governs how AI coding agents, Codex, and human contributors work in this repository. It
describes the repo as a whole and is **not** scoped to any one branch or worktree — whatever branch
you are on, these rules apply. Branch-specific scope belongs in `PLANS.md`, not here. (This file has
historically been rewritten to describe whichever branch was active, which left `main` carrying a
header for a worktree that no longer existed; keep it general.)

ChemDraft is a lightweight, open-source chemical drawing application with a plugin architecture. The
core app must stay small, stable, testable, legally clean, and focused on drawing workflows.

Do not use **MolScribe** as the app name. MolScribe refers to the external image-to-graph molecular
recognition project and, in this repository, only to the optional **MolScribe OCSR** plugin or
integration.

Bump the build stamp (`CURRENT_BUILD_STAMP` in `apps/desktop/src/MainWindow.tsx`) when you finish a
slice of work, so a stale build is obvious on sight. Its suffix names the agent that authored the
work (`-opus`, `-codex`, `-fable`, …), never the branch.

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
newer instructions. Keep edits focused on the files, behaviors, and verification listed there; do
not broaden the slice into adjacent chemistry, rendering, UI polish, or format work.

Notary and app-signing instructions live at `/Users/jeremiahgassensmith/programming/.notary`.
Read that directory before signing, notarizing, packaging, or changing release automation.

## Toolbar Button Contract

The schema-backed toolbar button rules that must keep holding:

- inline schema submenu commands must invoke exactly once from click;
- disabled submenu commands must not invoke;
- items with disabled primary commands but enabled submenu commands must still open the submenu;
- items with no enabled primary command and no enabled submenu commands must be disabled;
- inline schema submenus need owner/menu/menuitem ARIA coverage;
- native palette flyout transport must remain unchanged;
- generated toolbar command specs must not invent generic tooltip descriptions;
- shipped toolsets must not contain permanently disabled placeholder buttons: a visible button is
  either backed by live behavior or removed from the manifest until its feature slice lands;
- `disabledReason` is reserved for transient, state-dependent unavailability (selection-dependent
  commands and similar), and such commands must always carry a reason;
- the customize gallery must exclude permanently stubbed commands.

Do not change command IDs, chemistry behavior, inspector behavior, package dependencies, or app
build identity unless a test or build process forces a narrow, explained fix, or the active
PLANS.md slice explicitly documents the command's retirement or introduction.

## Reuse Existing Systems

Verify existing code before adding new code.

- `packages/toolset-registry` owns manifest schemas, normalization, command enumeration, and layout/customization validation.
- `apps/desktop/src/toolsets.ts` maps normalized registry items into desktop palette item models and command specs.
- `apps/desktop/src/ToolPalette.tsx` renders the inline web fallback and hands native flyout requests to the window transport.
- `apps/desktop/src/PalettePopoverWindow.tsx` renders native flyout snapshots. Preserve this transport unless a focused test proves a bug in that path.
- Commands use value-encoded IDs and factory helpers. Do not introduce generic `*.set` commands with hidden value parameters.

## Hard Boundaries

- Work only in the worktree checked out for the branch you are on; never edit another worktree's files.
- Do not copy proprietary assets, icons, dialog art, help text, sample files, command IDs, trade dress, or branded UI.
- Keep chemical identity stable. Toolbar, inspector, and UI work must not mutate atoms, bonds, bond order, charges, stereochemistry, reactions, or molecule metadata.
- Native flyouts must keep using the existing request/snapshot/window-manager path.
- Inline submenu ARIA must describe real inline DOM menus only; native flyout owner buttons may advertise `aria-haspopup="menu"` but must not point `aria-controls` at nonexistent DOM.
- Generated toolbar commands may preserve explicit tooltip descriptions and command overrides, but must not synthesize filler text such as `toolset action`.

## Verification

Run focused suites for touched files, including:

```bash
pnpm vitest run packages/toolset-registry/src/index.test.ts apps/desktop/src/toolsets.test.ts apps/desktop/src/ToolPalette.test.ts apps/desktop/src/ToolPalette.dom.test.ts apps/desktop/src/App.test.ts
pnpm lint
pnpm test
pnpm build
git diff --check
```

Also smoke `./run-app --dev` long enough to confirm startup, then stop the dev server.

## Launch Verification

Every newly built or freshly verified ChemDraft app must be launched from this worktree with
one of the repository launchers:

```bash
./run-app
./run-app --dev
```

Use `./run-app` for packaged-app verification and `./run-app --dev` for Tauri/Vite HMR
verification. Do not treat an already-open ChemDraft window, a sibling worktree's app,
`cargo run`, a direct `tauri dev`, or a browser tab on an old Vite port as proof that the
current branch was launched. When reporting launch verification, include the exact command
and the observable success signal, such as the app bundle path for `./run-app` or the
selected Vite port plus `target/debug/chemdraft` launch for `./run-app --dev`.

Before launching a fresh build, close or stop other running ChemDraft instances that come
from this checkout or the same build history. Use process working directories, target paths,
Vite ports, and bundle paths to distinguish same-history instances from unrelated sibling
worktrees. If a stale instance from the same branch/build lineage is still running, stop it
before treating the new launch as verified.

If the app feels like the wrong build, check active Vite ports and process working directories
before editing source. A different checkout listening on `5173` while this worktree uses
`5174` is a stale-session problem, not proof that this branch failed to build.

### Every build is labeled by its worktree (do not remove)

Several ChemDraft worktrees are checked out at once, and every one builds an app literally named
"ChemDraft" — so nothing on screen tells them apart unless we label it. Every build therefore
carries its worktree/branch label in three places, all driven by `CHEMDRAFT_WORKTREE_LABEL`
(exported automatically by `run-app` as `<dir> [<branch>]`):

- the **window title** — `ChemDraft — <dir> [<branch>]`. `index.html` ships
  `<title>ChemDraft</title>`, while MainWindow sets the labeled web-document title from the
  `__WORKTREE_LABEL__` vite define. Rust applies the same label with `main_window_title()` via
  `option_env!` (`build.rs` re-emits the env as `rustc-env`) during startup and again from the Tauri
  page-load hook, after WKWebView has applied the initial HTML title; this second native write is what
  keeps the actual macOS title bar labeled;
- the **on-screen build stamp** — the worktree label leads the stamp (vite.config.ts `buildStamp()`
  reads the env, or derives it from git as a fallback);
- a **launch banner** printed by `run-app` at every `./run-app` / `./run-app --dev`.

This is automatic — there is nothing to remember and nothing to type. Do NOT strip the label out of
`run-app`, `vite.config.ts`, `apps/desktop/src-tauri/src/lib.rs` (`main_window_title`), or
`build.rs`; it is the thing that stops "wrong build launched" confusion. When you report launch
verification, state the label you saw (title bar or build stamp) and confirm it matches this
worktree. If a worktree's build still shows a bare "ChemDraft" with no label, that mechanism is
missing there and must be ported in from the branch that has it.

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

## 8a. Plugin runtime, packaging, and NMR rules (merged from `codex/nmr-plugin`, 2026-07-16)

These are shipped repo truths from the plugin program (M1–M36 + the runtime union merge), not
branch-scoped guidance. The decision record and milestone reports live in the planning workspace
(`~/Documents/programming/Chemdraw-NMRplugin`); developer docs live in `docs/plugin-architecture/`.

**Runtime.** There is ONE persistent desktop plugin runtime (`apps/desktop/src/plugins/createPluginRuntime.ts`,
owned by `usePluginRuntime`). It is created exactly once; document/selection reach it through provider
callbacks/refs. Never recreate it because the document, selection, page, viewport, or undo state
changed. Plugin commands register into the SAME stable `CommandRegistry` as core commands
(`commands/coreCommandRegistrar.ts`); a command is plugin-owned iff its registered definition carries a
`pluginId`. All desktop registration paths (bundled, installed, fixture) go through the runtime's
`registerPlugin`/`unregisterPlugin` — never the bare host — so toolset contributions are staged with
their `ui.toolbar` gate and whole-plugin rollback, and provenance maps stay accurate.

**Panels are declarative and rendered by ONE renderer.** Plugins push `PluginPanelReport` data (text,
keyValue, table, svg, linkedFigure sections); `PluginReportRenderer` is the single renderer for every
surface — the in-app panel surface AND the floating `PluginPanelWindow` (ADR-0030). Never reintroduce a
window-private section switch: an unknown section kind must never be silently dropped. The in-app
surface keeps single-panel semantics with replacement-close (ADR-0012); popped-out windows are
per-panelId (several may float); dismissing a window is a real panel close and must notify the plugin.
Staleness (D-09) and Run again travel with the report over the panel bridge.

**Isolation and installs.** Bundled analyzer plugins execute in per-plugin module Workers
(`PluginWorkerBridge`, ADR-0029/M34); capability requests are serviced by the permission-gated host
context, and `terminate()` is total teardown. Installed packages (M35/M36) are staged under
`$APPDATA/installed-plugins/` and served same-origin: the app pre-empts its own `tauri://` scheme
(`installed_plugins.rs`; `register_uri_scheme_protocol("tauri", …)` in lib.rs) and the Vite dev server
carries the mirroring `/installed-plugins/` middleware. Do NOT remove either serving hook, add a new
URI scheme for plugins (a new scheme is a new origin and the packages stop loading), or bypass the
fail-closed install gates (checksum/CRC, manifest validation, apiVersion + worker handshake, path
traversal guards in TS and Rust). `worker.format: "es"` in vite.config.ts is load-bearing.

**Naming conventions (schema-enforced where noted).** Command ids `plugin.<pluginName>.<action>`
(toolset contribution ids are schema-enforced to start with `plugin.`); menu ids
`menu.<pluginName>.<action>`; panel ids `panel.<pluginName>.<name>`; analyzer ids
`analyzer.<pluginName>.<name>`; manifest `apiVersion` `"^0.1.0"` (caret). Register manifests through
the runtime so schema and permission validation run.

**NMR scientific-claim rules (absolute).** The shipped backend is the OCL-native provider:
HOSE-fragment lookup over statistics derived from NMRShiftDB2 experimental assignments. The shipped
path must never be described as fixture-backed or synthetic (fixtures survive only in tests/fallbacks
and must be labeled synthetic wherever used). Accuracy figures shown to a user must stay
checksum-gated to the benchmarked corpus (M31) and drop for any other database build. ¹H multiplicity
and J are first-order topology estimates, labeled as estimated — never presented as measured. Stick
height is predicted equivalent nuclei, not integration; lineshape and spectrometer field are
simulation parameters. Never fabricate a shift for an unmatched environment — partial results carry
warnings. No calibrated confidence percentages; honest tiers only (ADR-0020).

**Licensing.** The example plugins' original code is MIT (finalized 2026-07-16 by the project owner) —
chosen because the nmrshiftdb2 Database License requires prediction software relying on the database to
be OSI-approved. MIT does NOT cover the bundled reference database: it is a derivative database under
the nmrshiftdb2 Database License (ODbL-derived) with share-alike and attribution obligations that
travel with any redistribution, including a packaged plugin zip. Never describe a packaged plugin as
"MIT" without that carve-out. The root repository `LICENSE` remains unfinalized (`UNLICENSED` in
package.json) — the project owner's call; do not change it.

## 9. Command registry rules

Built-in tools and plugin tools should use the same command system whenever practical.

Visible menu, quick-action toolbar, floating/dockable palette, keyboard shortcut, command-palette, and plugin menu/toolbar/panel actions must be backed by command definitions where practical.

Do not wire major behavior only through button-local handlers. Disabled command definitions exist only for transient, state-dependent unavailability and must carry a reason; tools whose features are unimplemented are removed from shipped toolsets and the command catalog until their slice lands (see the Toolbar Button Contract).

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

Manual stress for the active toolbar-wiring slice must cover: drawing each reaction-arrow kind by
click and by drag (heads render per kind, resize handles work), placing and resizing both bracket
kinds, stamping dagger and submenu symbols, editing an atom label through tool.atom, dragging a
chain off an existing atom and off empty canvas, applying formula text to a typed formula,
undo/redo one entry per gesture, save/reopen, and SVG export parity with the canvas for arrows,
brackets, and orbitals.

## Closeout Requirements

At implementation closeout:

- Update the build stamp (`CURRENT_BUILD_STAMP`) in `apps/desktop/src/MainWindow.tsx`.
- Launch the new build through `./run-app` or `./run-app --dev` from this worktree before claiming live verification.
- Close or stop other running ChemDraft instances from this checkout or the same build history before launch verification.
- Report tests run and any skipped verification.
- Keep the final answer focused on the branch and the specific slice completed.

## Label every build by its worktree (do not remove)

Several ChemDraft worktrees are checked out at once, and every one builds an app literally named
"ChemDraft" — so nothing on screen tells them apart unless we label it, which has repeatedly caused
"wrong build launched" confusion. Every build must therefore carry its worktree/branch label, driven
by `CHEMDRAFT_WORKTREE_LABEL` (exported automatically by `run-app` as `<dir> [<branch>]`), in three
places:

- the **window title** — `ChemDraft — <dir> [<branch>]` (Rust `main_window_title()` reads it via
  `option_env!`; `build.rs` re-emits it as `cargo:rustc-env` so cargo actually recompiles the title
  when it changes — a bare env var is NOT a tracked compile input);
- the **on-screen build stamp** — the label leads the stamp (`vite.config.ts` `buildStamp()`);
- a **launch banner** printed by `run-app` at every `./run-app` / `./run-app --dev`.

This is automatic — nothing to remember, nothing to type. Do NOT strip the label out of `run-app`,
`vite.config.ts`, `apps/desktop/src-tauri/src/lib.rs` (`main_window_title`), or `build.rs`. When you
report launch verification, state the label you saw (title bar or build stamp) and confirm it matches
this worktree.

If a worktree's build still shows a bare "ChemDraft" with no label, the mechanism has not landed on
that branch yet — pick it up by merging from `main`, which carries all four files above.
