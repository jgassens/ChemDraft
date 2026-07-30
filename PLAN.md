# ChemDraft Project Plan

> **What this file is (2026-07-30).** The product charter: what ChemDraft is for, what it refuses to
> become, and what "done" means. It is **not** the engineering reference and is deliberately not
> required reading before editing code — **AGENTS.md** is the authority on how to write code here,
> and it is enforced. This file is the authority on *whether a thing should be built at all*.
>
> Read it when scoping a feature (§3, §4, §5, §19, §21), deciding core versus plugin (§5, §21),
> adding a dependency or touching licensing (§15), or changing a user-facing surface (§6.15).
>
> Rules that AGENTS.md enforces — package boundaries, plugin permissions, chemistry invariants,
> CDXML tiers, required tests — used to be duplicated here and were cut on 2026-07-30. Duplicated
> rules drift, and when they drift an agent gets two answers with no way to tell which one binds.
> Sections §8, §11.3, §13, and §16 now point at AGENTS.md instead. Do not re-inline them.

Working project name: **ChemDraft**.

The earlier working name **MolScribe** should not be used for the app unless the naming decision is intentionally reopened. An established MIT-licensed project named **MolScribe** already exists for image-to-graph molecular structure recognition. ChemDraft should treat that project as an optional first plugin target, not as the app identity.

The repository should avoid names, icons, trade dress, sample files, templates, documentation, or marketing language that imply affiliation with ChemDraw, ChemOffice, CambridgeSoft, PerkinElmer, Revvity, or any other proprietary chemistry drawing product.

## 1. Project summary

ChemDraft is a lightweight, free, open-source chemical drawing application. The first product is a drawing tool, not a full cheminformatics platform. It should open quickly, draw molecules/reactions/mechanisms quickly, export publication-quality figures, and interoperate with common chemistry formats.

Primary goal:

```text
Make drawing and exporting chemical structures fast, reliable, familiar, and free.
```

Secondary goal:

```text
Create a plugin architecture that lets users add analysis, prediction, import/export, visualization, and workflow tools without turning the core application into a bloated suite.
```

## 1.1 Roadmap synchronization note

**Last synchronized: 2026-07-30.**

Keep this section dated, and re-date it whenever you reconcile it. It exists so a reader can tell how
far the implementation has moved past the phase list in §17. A stale sync note is worse than no sync
note, because it reads as current: this one sat unchanged from late May through 2026-07-29 while the
entire plugin program, the toolbar honesty slice, Spin 3D refinement, and three releases shipped
past it.

The active slice is never described here — it lives in `PLANS.md`. Completed slices and the
reasoning behind them live in `docs/shipped/README.md`.

### Shipped and stable

- Tauri desktop as the default launch target, plus a browser-only shell through `pnpm dev:web`.
  There is still no separate `apps/web` package.
- Native floating toolset windows, declarative command-backed toolsets, `packages/toolset-registry`,
  built-in/plugin-contributed/user-created toolsets, and versioned user layout state persisted
  without mutating source manifests.
- Toolbar customization UI is **delivered** — the Customize Toolbars dialog and the in-place
  Main-toolbar editor. The four standalone `view.toolset.*` commands were retired into those
  editors.
- Every button in a shipped toolset performs its action. `TRANSITIONAL_STUB_COMMAND_IDS` is empty
  and a policy test keeps it empty (§6.11).
- `packages/viewport-engine`, rulers through `@scena/react-ruler` with ChemDraft viewport state as
  the source of truth, native page layout and paper sizes, File > Page Setup.
- Drawing tools: bonds, chains, atom labels, rings, brackets, orbitals, glyph stamps, formula text,
  and the full arrow family as editable art objects that round-trip CDXML.
- `packages/art-engine` and the art inspector, which styles graphics and molecules.
- Spin 3D with selectable refinement modes, a Preferences window, and `packages/engine3d-api` as the
  versioned protocol to a 3D sidecar.
- `KetcherAdapter` as a host adapter boundary; a narrow lazy Ketcher host edits a selected
  `MoleculeObject` only. ChemDraft still owns the composited page/document state.
- The plugin program end to end: one persistent runtime, per-plugin Web Workers, declarative panel
  reports through a single renderer, packaged installs, a Plugin Manager, and host-managed updates.
  See AGENTS.md §8a.
- macOS release path: Sparkle auto-update against a signed appcast, notarization, v0.3.0 published.

### Not shipped, whatever §17's phase list may imply

Verified against the code on 2026-07-30. §17 marks these phases with the same detail.

- **Chemistry-format export.** MOL, SDF, RXN, SMILES, and CML are `status: "planned"` in
  `packages/export-engine/src/formats.ts`. Only SVG, PDF, PNG, JPEG, BMP, GIF, TIFF, and CDXML are
  `"implemented"`.
- **Most clipboard paste.** Molfile and SMILES paste work. CDXML, CDX, and RXN paste each return an
  explicit "not implemented yet" message instead of parsing — honest, but not delivered.
- **Office-friendly image copy.** The Rust side exposes `write_clipboard_text_items` only; there is
  no image write.
- **CDX binary read or write** (`status: "deferred"`).
- **Mechanism annotations as semantic objects.** `packages/mechanism-tools` is a type stub and
  `tool.mechanismArrow` is retired. The curved and fishhook arrows in the arrow flyout are art arcs
  with markers — no atom or bond anchoring, no semantic mechanism model.
- **Templates.** `packages/template-library` is empty; `tool.templateGrid` is retired pending a
  template corpus and grid-picker UI.
- **User-facing documentation.** `docs/migration/`, `docs/compatibility/`, and `docs/file-formats/`
  READMEs are five-line stubs, so Phase 11's ChemDraw migration guide and known-limitations page are
  not started.

The UX surface scaffold in `apps/desktop/src/surfaces` remains metadata-only. Rendered UI is not
driven by it, and it should not be treated as a full UX registry package, plugin surface renderer,
customization UI, or add-page implementation.

## 2. Target users

Primary users:

- Synthetic chemists
- Medicinal chemists
- Organic chemistry instructors
- Chemical biology researchers
- Materials chemists
- Graduate students and postdocs
- Anyone who currently uses ChemDraw mostly for drawing structures, reactions, mechanisms, and figures

Secondary users:

- Developers building chemistry plugins
- Open-source cheminformatics contributors
- Labs that want a lightweight local drawing tool
- Educators who need a free drawing tool for students

## 3. Product positioning

ChemDraft should not try to replace every feature of ChemDraw immediately. The useful first product is:

```text
A lightweight desktop chemical drawing app with familiar drawing workflows, clean export, migration-grade file and clipboard compatibility, and a serious plugin system.
```

Use two release bars.

Drawing MVP:

```text
A chemist can draw molecules and reactions, save native documents, export clean figures, and use basic chemistry formats.
```

ChemDraw migration MVP:

```text
A ChemDraw user can move ordinary drawing work over without losing the daily workflows that make them productive: CDXML, best-effort CDX read/paste, RXN, Office-friendly copy/paste, stereochemistry, abbreviations/superatoms, R-group display, templates/styles, mechanism annotations, hotkeys, and page/layout tools.
```

The core should stay small, but migration-critical drawing productivity is not bloat. Office-friendly clipboard behavior, mechanism drawing, abbreviations/superatoms, basic R-group display, templates/styles, layout operations, RXN support, hotkeys, and reliable stereochemical CDXML handling belong in the core release target. NMR, MS fragmentation, pKa/logP/logS, retrosynthesis, full ELN workflows, cloud collaboration, structure-to-name, and image-to-structure recognition can remain plugins or later milestones.

## 4. First public release success criteria

The first public release is useful when a chemist can:

- Open the app quickly.
- Draw a molecule using standard bond, atom, ring, chain, wedge, dash, wavy-bond, and selection tools.
- Draw a simple reaction scheme.
- Draw basic mechanism annotations, including curved electron-pushing arrows, lone-pair marks, radical-electron marks, and first-class charge/radical placement.
- Add reaction arrows, equilibrium arrows, retrosynthesis arrows, plus signs, text, brackets, and reaction conditions.
- Use basic page/layout tools: group/ungroup, align/distribute, rotate/flip, z-order, page size, margins, scaling, snap/smart guides, and bond-length normalization.
- Use original built-in templates and style presets for common rings, common scaffolds, amino acids, sugars, brackets, arrows, and publication-ready drawing styles.
- Import ChemDraw `.cds` style sheet files as compatibility inputs, convert supported settings into native ChemDraft style presets, and optionally set an imported preset as the default drawing style for new documents.
- Use abbreviations/superatoms such as Ph, Boc, Ts, OMe, TBS, and related common groups as chemically meaningful editable objects, not merely plain text.
- Display basic R-groups/generic atoms for SAR figures, even if full query semantics come later.
- Save and reopen the native document.
- Export clean SVG, PNG, PDF, MOL, SDF, SMILES, and RXN.
- Import common small-molecule and reaction formats.
- Export and import a reliable CDXML subset that preserves atom identity, bond order, charge, isotopes, radicals, coordinates, wedge/dash stereochemistry, E/Z alkene geometry where represented, abbreviations/superatoms, simple R-group display, text labels, simple arrows, plus signs, brackets, and basic reaction schemes.
- Read or paste a best-effort CDX subset early, even if CDX writing remains limited.
- Copy drawings into Word, PowerPoint, Keynote, Google Slides, and similar tools as clean SVG/PNG, with chemical payload where the platform allows it.
- Paste from ChemDraw-style sources through CDXML/CDX/MOL/RXN/SMILES where supported, with clear fallbacks and warnings.
- Use deliberate keyboard shortcuts and type-to-build behavior for common drawing operations.
- Use a plugin command from the Analyze or Tools menu.
- See formula and mass for a selected molecule.
- See explicit warnings when import, export, cleanup, recognition, or clipboard transfer approximates unsupported chemistry or graphics.
- Trust that import/export does not silently alter chemical identity.

## 5. Non-goals and known gaps for the first release

Do not build these into the core first:

- Full NMR prediction
- Full mass-spec fragmentation prediction
- Retrosynthesis
- Cloud sync
- Lab notebook features
- Multi-user collaboration
- Full CDX binary writing for every legacy edge case
- Full CDXML compatibility for every ChemDraw graphical object
- Full PowerPoint or Word add-ins, OLE servers, or edit-in-place Office object integration
- Full biopolymer support
- Full HELM support
- 3D molecular visualization
- Full name generation
- Full SAR table or stoichiometry-grid system
- Full journal-style database
- EPS/TIFF export unless demanded by early adopters
- AI image-to-structure recognition inside the core app

Clarifications:

- Basic Office-friendly copy/paste is a first-release requirement. Full Office add-ins and embedded-object editing are not.
- OLE or double-click-to-edit Office embedding is out of scope for v1, but the migration guide must state this plainly and explain the substitute workflow: copy/paste as SVG/PNG plus chemical payload where available, or reopen/edit from the saved native file.
- Name-to-structure and structure-to-name are migration pressure points, not solved core features. A limited OPSIN-style name-to-structure plugin is plausible. Reliable open structure-to-name is harder and should be presented honestly as a known migration blocker until a dependable implementation exists.
- CDXML export/import should precede broad CDX writing, but best-effort CDX read and CDX clipboard paste should come early because a migrant's back-catalog and clipboard payloads may be CDX.
- Image-to-structure recognition is not a core feature, but it is a strong plugin target because it tests image input, optional native-service execution, large model dependencies, confidence reporting, and review-before-insert document patches. The preferred candidate is an optional **MolScribe OCSR** plugin based on the external MolScribe image-to-graph project. It is no longer the *first* such target — the NMR predictor took that role and exercised the same infrastructure; see §14.

## 6. Core design principles

### 6.1 Drawing first

The core product must be excellent at drawing structures, reactions, mechanisms, and publication figures. Everything else is secondary.

### 6.2 Native file first, compatibility second

The app should have its own versioned native file format. CDXML and CDX are compatibility formats, not the internal source of truth.

Use:

```text
Native save:        .chemdraft or equivalent
Compatibility:      .cdxml, .cdx, .mol, .sdf, .smiles, .rxn
Style sheets:       .cds import -> native ChemDraft style preset
Publication export: .svg, .png, .pdf
Clipboard:          CDXML/CDX where supported, SVG, PNG, SMILES/RXN text fallbacks
```

ChemDraw `.cds` files are style-sheet compatibility inputs. They must not become the native style model and must not be treated as molecule, reaction, or document imports.

### 6.3 Plugins for growth

The app should not absorb every requested feature into the core. Advanced or heavy features should be implemented as plugins whenever possible.

Examples of plugin features:

- MolScribe OCSR image-to-structure recognition
- OPSIN-style name-to-structure
- InChI/InChIKey
- NMR prediction
- Mass-spec fragmentation prediction
- pKa/logP/logS estimates
- Retrosynthesis helpers
- Advanced journal template packs
- Advanced CDXML/CDX utilities
- Teaching tools beyond core mechanism drawing
- Batch export
- ELN integrations
- Structure-to-name experiments only if a reliable, licensed implementation exists

### 6.4 Stable core, replaceable engines

The app must not depend directly on one drawing, chemistry, or recognition library throughout the codebase. External engines must be wrapped behind adapters or plugin service boundaries.

Required boundaries:

```text
Ketcher or other drawing engine       -> EditorAdapter
RDKit or other chemistry engine       -> ChemistryAdapter
CDXML/CDX implementation              -> CdxCompat package
External style sheets such as .cds    -> StyleCompat or documented style compatibility boundary
Native desktop shell                  -> DesktopBridge
Clipboard access                      -> ClipboardAdapter
Plugin loading                        -> PluginHost
Toolbars/toolsets                     -> ToolsetRegistry
Viewport, zoom, ruler state           -> ViewportEngine
Image-to-structure recognition        -> Recognizer plugin or NativeServicePlugin
```

### 6.5 Chemistry correctness over UI cleverness

A beautiful drawing app that changes chemical identity during import/export is useless. Every import/export/conversion path needs tests.

The enforceable invariant list lives in **AGENTS.md §10** — what every conversion path must preserve,
and what tests should compare. It is not repeated here; two copies of a rule drift, and the copy in
AGENTS.md is the one agents are required to read.

### 6.6 Original UI assets only

The app can use familiar workflows, but must not copy proprietary icons, brand names, layouts pixel-for-pixel, help text, templates, sample files, or visual assets from commercial software.

### 6.7 One document canvas, not isolated molecule islands

ChemDraw-style work is a single page where molecules, arrows, mechanisms, text, plus signs, brackets, and layout objects interact. Ketcher may own the active structure-editing session, but the native document model must own the page. Do not build the product as isolated molecule editors that cannot handle page-level reaction arrows, mechanism arrows, and publication layout.

### 6.8 Keep heavy recognition optional

MolScribe OCSR, PyTorch, OpenCV, model checkpoints, and any Python sidecars must not load at app startup. They belong in optional plugins or explicit native-service integrations with permissions, attribution, and user approval.

### 6.9 UI direction: compact desktop drawing workspace

ChemDraft must look and behave like compact desktop drawing software, not a generic web dashboard.

The default UI direction is:

- The document/page workspace dominates the window.
- Use a native or native-feeling menu bar.
- Use a dense quick-action toolbar for common document, edit, style, export, and view commands.
- Use a compact floating or dockable tool palette for drawing tools.
- Tool buttons are icon-first, using original glyphs with tooltips, accessible labels, and keyboard shortcuts.
- Inspector and plugin panels are hidden by default and opened only when needed.
- Rulers, page boundaries, margin guides, snap guides, and grids are acceptable visual scaffolding.
- The empty editor state should be an honest blank document or an "EditorAdapter not connected" development state.

Do not show fake molecule, reaction-arrow, product, mechanism, or placeholder chemistry objects in the document workspace.

### 6.9.1 Design language: restrained technical minimalism

ChemDraft's desktop UI should follow:

```text
Restrained technical minimalism: Metro-like canvas minimalism with Material-like interaction clarity.
```

The canvas should feel like a precision scientific drawing surface: flat, quiet, typographic, low-chrome, and content-first. Controls around it should use consistent spacing, predictable component states, and clear hover, active, focus, selected, and disabled feedback.

For the current desktop shell, `apps/desktop/src/App.css` is the canonical design-token layer. Use CSS variables for app, canvas, panel, page, text, border, spacing, radius, control-size, accent, focus, hover, active, selected, disabled, and semantic danger states. Do not create a separate `ui-kit` token system unless another package actually consumes it and the canonical layer is documented.

Use `#1d7f68` as the restrained accent, with derived shades allowed for readable active, selected, hover, and focus states. Red remains semantic for invalid, delete, and warning states. Style only ChemDraft-owned Ketcher host and wrapper chrome; do not patch vendored Ketcher internals or change Ketcher behavior.

Design-language cleanups must remain visual-only unless explicitly scoped otherwise. Do not change molecule drawing behavior, bond creation behavior, selection logic, file formats, chemistry model logic, renderer math, command IDs, keyboard shortcuts, or tool behavior as part of a visual cleanup.

### 6.10 UI non-goals

Do not use these as product direction:

- SaaS-style dashboard layout.
- Large text-labeled chemistry toolbar buttons.
- Permanent right-side inspector or plugin panel by default.
- Rounded card-based dashboard sections.
- Fake central molecule/reaction/product placeholder objects.
- Plugin demo buttons in random panels.
- Copied proprietary icons, toolbar art, templates, sample files, help text, menu text, trade dress, or brand identity.

Functional familiarity with classic chemistry drawing tools is acceptable. Direct visual copying is not.

### 6.11 Command-backed surfaces

Menu items, quick-action toolbar buttons, floating/dockable palette tools, keyboard shortcuts, command-palette actions, and plugin contributions should all be backed by command definitions where practical.

Do not hard-code important actions only inside button click handlers. Disabled command definitions must carry a reason and reflect transient, state-dependent unavailability only; tools whose features are unimplemented are removed from shipped toolsets until their slice lands — no decorative disabled placeholder buttons.

### 6.12 Floating toolset architecture

ChemDraft has toolsets, not just one tool palette. Toolsets can be built-in, plugin-contributed, or user-created. The desktop app should support native floating utility windows, with docked or in-window toolsets as fallback or optional modes.

- Native floating toolsets should be managed through a desktop window-manager boundary, initially in `apps/desktop/src/window-manager` unless a shared `packages/window-manager` becomes justified.
- Floating toolset windows should be associated with the active document window when possible.
- Avoid global always-on-top behavior unless the user deliberately enables it.
- Browser or web builds may use in-window floating toolsets as the fallback.
- Toolset buttons invoke command IDs. They do not own chemistry behavior, document mutation, Ketcher calls, or RDKit calls.
- View > Toolbars should be generated from the registry plus user layout state.
- Toolset visibility, position, layout, mode, and size should be persisted without mutating source manifests.
- Startup should apply persisted user toolbar layout state before constructing registry, menu, and window state.

### 6.13 Toolbar/toolset customization

Toolbar customization UI is delivered: the Customize Toolbars dialog and the in-place Main-toolbar editor modify versioned user layout state. The customization architecture is part of core UI infrastructure.

Rules:

- User customization edits versioned user layout state.
- Built-in toolset manifests remain stable.
- Plugin toolset manifests remain stable.
- User toolsets reference command IDs.
- Customization must not duplicate command implementations.
- Customization must not grant plugin permissions.
- Customization must not bypass command registration.
- Future drag-and-drop editors should modify the same state model.
- `view.customizeToolbars` and `view.customizeMainToolbar` are the customization entry points, delivered by the Customize Toolbars dialog and the in-place Main-toolbar editor.
- Reset, reset-all, create-user-toolset, and clone actions live inside those editors (backed by `layoutStateEdits.ts`); the former standalone `view.toolset.*` command IDs are retired per the Toolbar Wiring and Honesty slice (`docs/shipped/README.md`).

### 6.14 ChemDraw toolbar XML boundary

ChemDraw toolbar XML/customization files demonstrate that toolbar layout can be declarative data. ChemDraft should use its own typed manifest and customization model.

Do not copy ChemDraw XML schema, command names, icon names, image assets, menu files, command definition files, file paths, templates, or trade dress. Do not treat uploaded ChemDraw toolbar XML as a ChemDraft runtime input.

Any future external toolbar import must be a compatibility/import layer that maps supported external actions into ChemDraft command IDs and warns for unmapped commands.

### 6.15 UX flexibility and owner whimsy

ChemDraft's user-facing surfaces are expected to evolve. Avoid baking user-facing layout decisions into React components or native menu code as permanent architecture. Prefer command-backed, manifest-driven surface definitions where practical.

Stable contracts should stay stable:

- `chem-core` document model
- Document patches
- Command IDs
- Plugin permissions
- Adapter interfaces
- Viewport coordinate model
- Import/export invariants
- Chemical identity invariants

Volatile or configurable surfaces may change repeatedly:

- Menu placement
- Toolbar and toolset grouping
- Floating palette visibility
- Panel layout
- Inspector visibility
- Status-bar items
- Canvas controls such as add-page buttons
- Labels, tooltips, and microcopy
- Icon selection
- Theme tokens
- Keyboard shortcut maps
- Default visible toolsets
- Default page and style preferences

The app should support these as separate concepts:

- Owner defaults: project-level default layout and style choices that may change as product direction changes.
- User preferences: installed-user changes such as toolbar visibility, panel state, and shortcut overrides.
- Document state: file-traveling data such as pages, page sizes, objects, and styles used by the document.

Do not mix owner defaults, user preferences, and document state without an explicit reason.

New user-facing controls should move toward a UX surface model with fields like:

```text
id
kind
commandId
slot
label
icon
defaultVisible
source: core | plugin | user | owner
order
featureFlag or experiment ID where useful
```

A tiny local version of this model exists in `apps/desktop/src/surfaces`. It is metadata-only and does not yet drive rendered UI. Promote it to `packages/ux-registry` only when cross-package use justifies the boundary.

Examples:

- A future circular add-page button should be a `canvas-control` surface invoking `document.addPageAfter`, not an untracked hard-coded button.
- `surface.canvas.addPageAfter` may exist only as disabled metadata until `document.addPageAfter` is implemented and wired.
- Toolbars are already manifest-driven through `toolset-registry`.
- Menus and panels should move toward the same command-backed surface pattern.
- Empty states and status-bar items should also be surface/slot driven where practical.

This direction does not implement rendered surface wiring, a full UX editor, drag/drop customization, theme editor, plugin marketplace, page thumbnails, add-page behavior, or real drawing tools.

## 7. Recommended technical architecture

### 7.1 Desktop shell

Use Tauri for the desktop shell.

Rationale:

- Smaller runtime footprint than a Chromium-bundling desktop stack.
- Cross-platform desktop distribution.
- Rust backend for native operations.
- Web frontend for fast UI development.
- Natural fit for a TypeScript plugin API and chemistry editor frontend.

### 7.2 Frontend

Use:

```text
React
TypeScript
Vite
pnpm workspaces
Zod for runtime schema validation
Vitest for tests
Playwright for integration tests when needed
```

### 7.3 Backend

Use Tauri/Rust for:

- Native file dialogs
- File read/write
- Clipboard interoperability
- Platform-specific clipboard flavors
- Native plugin execution controls
- Sparkle-powered app updates on macOS
- Signing/distribution later
- Secure access to local resources

Keep most chemistry workflow logic in TypeScript packages until there is a strong reason to move it.

### 7.4 Monorepo layout

Repository layout as it stands (2026-07-30). `apps/web/` is the one entry below that does not exist
yet — the browser shell runs the desktop app through `pnpm dev:web`.

```text
chemdraft/
  apps/
    desktop/                  Tauri desktop app
    web/                      Optional browser version later — NOT YET CREATED

  packages/
    chem-core/                Native document model, schemas, patches, migrations
    editor-shell/             Shell region/panel types (dormant — no consumers)
    editor-adapter/           Abstract drawing editor interface
    ketcher-adapter/          Ketcher implementation of EditorAdapter
    chemistry-adapter/        Abstract chemistry computation interface
    ocl-adapter/              OpenChemLib implementation — the shipped chemistry engine
    rdkit-adapter/            RDKit implementation — currently a declared placeholder
    engine3d-api/             Versioned wire protocol for the 3D sidecar
    art-engine/               Native art geometry: paths, paint, markers, arrow geometry
    cdx-compat/               CDXML/CDX compatibility layer and the native save envelope
    style-compat/             External style-sheet compatibility such as .cds import
    clipboard-adapter/        Platform clipboard formats and Office-friendly copy/paste
    export-engine/            SVG, PNG, PDF, MOL, SDF, RXN, SMILES export orchestration
    layout-engine/            Align, distribute, group, rotate, flip, page, and guide logic
    shortcut-engine/          Command-bound keyboard shortcuts and type-to-build behavior
    mechanism-tools/          Curved arrows, electron marks, lone pairs, radical glyphs (stub)
    template-library/         Original built-in fragments, superatoms, templates, presets (stub)
    toolset-registry/         Typed toolset manifests, customization state, menu models
    viewport-engine/          Viewport state, coordinate conversion, zoom, ruler state
    plugin-api/               Public plugin API types
    plugin-host/              Plugin loading, permissions, command registry
    ui-kit/                   Original app UI components and icons
    fixtures/                 Shared chemistry, clipboard, recognition, and compatibility fixtures
    test-utils/               Shared test utilities (dormant — no consumers)

  examples/
    plugins/
      mass-fragment-demo/     Working non-NMR analyzer; proves the plugin API is domain-agnostic
      molscribe-ocsr/         Optional image-to-structure plugin scaffold
      opsin-name-to-structure/  README-only placeholder
      advanced-style-pack/      README-only placeholder
      journal-style-pack/       README-only placeholder

  docs/
    architecture/
    benchmarks/
    compatibility/
    file-formats/
    migration/
    nmr-plugin-planning/
    plugin-architecture/
    plugin-development/
    releasing/
    shipped/                  Completed slices and the decisions behind them

  tools/
    codex-prompts/
    plugin-extract/
    plugin-package/
    rdkit-oracle/
    scripts/

  PLAN.md
  PLANS.md
  AGENTS.md
  README.md
  LICENSE
```

## 8. Package boundaries

Per-package rules — what each package may and may not contain — live in **AGENTS.md §6**, which
covers all 24 packages and is the list agents are required to read. `§7.4` above gives the one-line
role of each. This section used to restate both and has been cut back to the seams that are easy to
get wrong and are recorded nowhere else.

### 8.1 Seams to watch

**Ketcher (`ketcher-adapter`).** Anything Ketcher can represent that `chem-core` cannot is a risk of
silent loss. Anything ChemDraw migrants need that Ketcher does not provide — mechanism-specific
annotations above all — must be implemented by ChemDraft or explicitly scoped as a limitation. The
adapter must not leak Ketcher types outside the package or own the native document model.

**Chemistry engines (`chemistry-adapter` / `ocl-adapter` / `rdkit-adapter`).** The contract is
engine-neutral and dependency-free; OpenChemLib is the shipped implementation and RDKit is a declared
placeholder. Code that reaches past the contract to an engine is the failure mode here.

**Compatibility formats (`cdx-compat`, `style-compat`).** Neither may become a source of truth.
CDXML is both an interop format and ChemDraft's own save envelope, which makes it tempting to treat
the compatibility model as the document model — do not. `.cds` is a style-sheet input only, never a
molecule, reaction, or document import.

**Rendering math (`layout-engine`, `art-engine`).** One home per formula. App code imports; it never
keeps a private copy. See AGENTS.md §5.26 for why this rule exists.

## 9. Native document model and patches

The native format should be versioned JSON at first. It can later be packaged as compressed JSON plus assets if needed.

Core object types:

```text
molecule
reaction
reaction-arrow
mechanism-arrow
electron-mark
text
bracket
graphic
plus
group
annotation
unknown-compatibility-object
```

Molecule objects should preserve:

- Stable object ID
- Structure format and payload
- Bounds and coordinates
- Style
- Stereochemistry metadata where applicable
- Charge/radical/isotope information
- Superatom/abbreviation metadata where represented
- Basic R-group/generic-atom display metadata
- Optional rendered cache
- Optional compatibility metadata

Native style presets should preserve, where supported:

- Preset ID
- Display name
- Source metadata, including imported `.cds` source metadata when applicable
- Bond length
- Bond line width
- Bond spacing
- Hash/wedge style
- Atom label font family and size
- Text font family and size
- Caption and reaction-condition font settings
- Page size
- Margins
- Grid and ruler preferences
- Color table
- Default object styles for molecules, arrows, brackets, plus signs, text, mechanism annotations, and reaction conditions

The default drawing style for new documents should come from the selected native style preset. Native documents should preserve their selected style preset when saved and reopened.

### 9.1 Page layout and paper size

Page size lives in the native document page model, not in React canvas constants.

Rules:

- `page.layout` is the source of truth for paper preset, orientation, internal CSS-pixel size, margins, and source physical units.
- `page.width` and `page.height` may remain as denormalized compatibility fields, but they must match `page.layout.widthPx` and `page.layout.heightPx`.
- Schema validation, parsing, migration, and patch tests must enforce the geometry invariant.
- Legacy Phase 4 pages without `page.layout` must migrate to US Letter portrait while preserving objects, selection, and chemistry payloads.
- Use the existing coordinate convention: `96 CSS px = 1 inch`.
- Keep conversion helpers in `chem-core`: inches to CSS px and millimeters to CSS px.
- Required first presets are US Letter, US Legal, and popular ISO A sizes, with Tabloid/Ledger, ISO A0-A10, and Custom represented in preset data where practical.
- Page-size commands should expose US Letter, US Legal, popular ISO A sizes, portrait, and landscape in the first minimal File > Page Setup UI.
- Page-size changes must not scale, move, or chemically alter document objects.
- Full Page Setup, custom-size editing, printing, and saved page-size favorites remain deferred.

Viewport, rulers, crosshairs, object positioning, and export consume document page layout. `MainWindow` constants must not be the geometry source of truth.
Ruler, grid, and crosshair tick units follow the active page family: inches for US paper presets and centimeters for ISO A presets.

SVG export should preserve physical export intent when page layout source units are available:

```text
US Letter/Legal and other inch presets -> SVG width/height in inches
ISO A presets                          -> SVG width/height in millimeters
viewBox                                -> ChemDraft internal CSS-px coordinates
PNG export                             -> pixel-based
```

Use patches for all document mutation.

Example patch types:

```ts
export type DocumentPatch =
  | { op: "addObject"; pageId: string; object: DocumentObject }
  | { op: "removeObject"; objectId: string }
  | { op: "updateObject"; objectId: string; changes: Partial<DocumentObject> }
  | { op: "updatePageLayout"; pageId: string; layout: PageLayout }
  | { op: "moveObject"; objectId: string; x: number; y: number }
  | { op: "addAnnotation"; annotation: ObjectAnnotation }
  | { op: "removeAnnotation"; annotationId: string };
```

Reasons:

- Undo/redo becomes manageable.
- Plugin changes are controlled.
- AI/recognition plugins can propose edits without directly mutating documents.
- Tests become easier.
- External tools do not mutate live state directly.

## 10. Core drawing workflow

### 10.1 Initial tools

Core tools:

```text
select
lasso
single bond
double bond
triple bond
aromatic bond
solid wedge
dashed wedge
wavy bond
chain
atom label
abbreviation/superatom
basic R-group/generic atom display
ring templates
reaction arrow
equilibrium arrow
retrosynthesis arrow
curved mechanism arrow
lone-pair mark
radical-electron mark
plus sign
bracket
text
eraser
clean structure
```

### 10.2 Keyboard shortcuts

Support deliberate keyboard-driven drawing:

```text
C, N, O, S, P, F, I atom labels
Cl, Br through typed labels
Ph, Boc, Ts, OMe, TBS and similar abbreviations where configured
number keys for common rings where appropriate
bond cycling shortcuts
selection movement
copy/paste
undo/redo
export shortcuts
command palette later
```

Do not copy proprietary shortcut documentation verbatim. The goal is familiar speed, not copied documentation.

### 10.3 Mechanism drawing

Mechanism annotations belong in core because they are daily work for organic chemistry instructors and students.

Required semantics:

- Curved two-electron arrows
- Curved one-electron fishhook arrows where feasible
- Lone-pair marks
- Radical-electron dots
- Editable arrow control points
- Attachment/reference points to atoms or bonds where possible
- Export to SVG/PDF/PNG without becoming uneditable in the native file

### 10.4 Templates, abbreviations, and R-groups

The core template system should include original templates for common rings, amino acids, sugars, brackets, arrows, and style presets.

Abbreviations/superatoms are not cosmetic text. They should be first-class enough to preserve label, expansion metadata, attachment point, compatibility metadata, and warnings when import/export cannot preserve full semantics.

Basic R-group/generic-atom display should arrive early. Full query semantics and SAR tables can come later.

### 10.5 Layout and page editing

Core page tools:

- Group/ungroup
- Align/distribute
- Rotate/flip
- Z-order
- Page size/margins
- Scaling
- Snap/smart guides
- Bond-length normalization
- Text alignment and basic subscript/superscript support

These are drawing-productivity features, not advanced chemistry features.

### 10.6 Style presets and `.cds` style sheets

Native ChemDraft style presets are the source of truth for drawing appearance. ChemDraw `.cds` files are compatibility inputs only.

Required style behavior:

- Provide a sensible built-in default style preset.
- Import `.cds` files through the Molecule Inspector's style import, which reads them through the style compatibility boundary. (A separate `style.importStyleSheet` command was retired as redundant; see "Command retirements" in `docs/shipped/README.md`. If a File > Import Style Sheet menu entry is wanted later, it should route to the same import path rather than reintroduce a parallel command.)
- Convert supported bond, text, page, grid, ruler, color, and object appearance settings into native style presets.
- Allow the user to set an imported native preset as the default for new documents through `style.setDefaultPreset`.
- Preserve the selected native style preset when a ChemDraft document is saved and reopened.
- Apply style changes through explicit, command-backed, undoable operations where practical.
- Warn when unsupported `.cds` settings are ignored, approximated, or cannot be represented.
- Never change chemical identity when applying a style preset.

`Tot_Syn_Style.cds` may be used as a private local reference for the desired default drawing style only if the user supplies it. Do not commit that file or derived proprietary fixtures unless redistribution rights are clear. Public tests should use synthetic or generated `.cds`-style fixtures.

### 10.7 Drawing command surfaces

The menu bar, quick-action toolbar, floating or docked tool palette, keyboard shortcuts, command palette, and plugin contributions should consume the same command definitions.

Placeholder drawing tools may appear only as disabled commands or explicit unavailable states. They must not show fake molecule, reaction, product, mechanism, or analysis content.

## 11. Import/export, CDXML/CDX, and clipboard

### 11.1 Initial import

Support:

```text
native document
MOL
SDF
SMILES
RXN
CDXML reliable subset
best-effort CDX read/paste subset
`.cds` style sheet import into native style presets
```

`.cds` import is not a molecule, reaction, page, or document import path. It belongs to style compatibility and converts into native ChemDraft style presets with warnings.

### 11.2 Initial export

Support:

```text
native document
SVG
PNG
PDF
MOL
SDF
SMILES
RXN
CDXML reliable subset
```

CDX writing can be later than CDX reading.

### 11.3 CDXML/CDX support tiers

The Tier A / Tier B / Tier C object lists live in **AGENTS.md §11**, together with the unknown-object preservation rule and the "never claim full compatibility without fixture coverage" rule. Tier A is what must round-trip reliably; Tier B waits for fixtures; Tier C is preserve-or-approximate and must never be described as supported.

### 11.4 Clipboard plan

Copy should attempt:

```text
CDXML where supported
CDX where supported
SVG
PNG fallback
text/plain SMILES or RXN fallback
```

Paste should attempt:

```text
CDX
CDXML
MOL/RXN
SMILES
SVG or PNG fallback when useful
plain text fallback
```

Clipboard handling must live behind a platform adapter because Windows, macOS, and Linux differ.

### 11.5 Style-sheet compatibility

External style sheets such as ChemDraw `.cds` should be parsed through `packages/style-compat` or a documented temporary compatibility boundary under `template-library` or `cdx-compat` if the package is not created yet.

The style compatibility boundary should:

- Convert supported settings into native ChemDraft style preset objects.
- Preserve source metadata and unknown fields where practical.
- Return warnings for unsupported, lossy, or malformed input.
- Fail safely on malformed `.cds` files.
- Use synthetic/legal fixtures unless redistribution rights for user-provided `.cds` files are clear.

CDXML/CDX basic style round-tripping belongs in `cdx-compat`. `.cds` style-sheet import should not be routed through normal molecule or document import code.

## 12. Chemistry core

Initial chemistry features:

- Validate selected structure.
- Canonical SMILES where available.
- Molecular formula.
- Average molecular mass.
- Exact mass where available.
- Charge display.
- Radical display where available.
- Stereochemistry warnings where available.
- Basic automatic R/S and E/Z descriptor display where the chemistry adapter supports it.
- Reaction component-role awareness for simple schemes.
- RXN parsing/validation where available.

Later chemistry plugins or optional services:

- OPSIN name-to-structure
- Structure-to-name exploration if a reliable option exists
- InChI/InChIKey
- NMR prediction
- MS fragmentation
- pKa/logP/logS
- Tautomer generation
- Salt stripping
- Standardization
- Reaction mapping

Do not claim robust structure-to-name support unless the implementation can be tested against a serious fixture set and produces acceptable warnings for unsupported structures.

## 13. Plugin system

The plugin system should be implemented early, before advanced features are added.

Plugin categories:

```text
analyzer      Molecule/reaction/document in, analysis result out
recognizer    Image/diagram/screenshot in, proposed molecule/reaction objects out
transformer   Structure/document in, proposed patch out
importer      File/string in, document object out
exporter      Document object in, file/string/blob out
ui            Panels, inspectors, toolbar buttons, menu items
template      Fragments, rings, reactions, style presets
service       Optional native/WASM/backend computational tools
```

The permission vocabulary and the dangerous-permission list live in **AGENTS.md §7**. They are not
repeated here — they are enforced by `plugin-host`, and a second copy would drift.

Default safe permissions for most analysis plugins:

```text
document.read
selection.read
analysis.write
ui.panel
plugin.storage
```

Prefer `document.proposePatch` over `document.write` for generated chemistry, recognizer plugins, and transformer plugins.

Plugin execution modes:

```text
frontend-js       JavaScript/TypeScript plugin, isolated where possible
worker-js         Web worker plugin for computation
wasm              WebAssembly plugin for heavier computation
native-service    Rust/Python/binary sidecar with explicit permissions
```

Native-service plugins must never run silently.

## 14. MolScribe OCSR as a plugin target

**Superseded as "first" (2026-07-30).** This section was written when no serious plugin existed. The
first one turned out to be the NMR predictor, which exercised the same infrastructure this section
was meant to stress — plugin permissions, worker isolation, heavy reference data, confidence
reporting, and review-before-insert — and then moved to its own repository. The plugin runtime,
packaging, installer, and update path are all shipped (AGENTS.md §8a).

MolScribe OCSR remains a scaffold and a legitimate future target. Everything below still applies if
it is picked up; only its "first" status has lapsed.

An optical chemical-structure recognition plugin based on the existing **MolScribe** image-to-graph
model.

Facts to account for:

- The upstream project is named `thomas0809/MolScribe` and describes itself as an image-to-graph model that translates molecular images to chemical structures.
- The upstream repository is MIT-licensed.
- The Python package exposes prediction methods that can return SMILES, molfile, confidence, atoms, and bonds.
- The upstream dependency shape is heavy: Python, PyTorch, OpenCV, transformers-like ML dependencies, RDKit, and model checkpoints.
- The Hugging Face model page lists the model license as MIT.

Suggested plugin identity:

```json
{
  "id": "org.chemdraft.ocsr.molscribe",
  "name": "MolScribe OCSR",
  "version": "0.1.0",
  "apiVersion": "^1.0.0",
  "description": "Recognize molecular structures from images using the external MolScribe image-to-graph model.",
  "license": "MIT",
  "entry": "dist/plugin.js",
  "permissions": [
    "image.read",
    "document.proposePatch",
    "analysis.write",
    "ui.panel",
    "chemistry.compute",
    "plugin.storage"
  ]
}
```

Real local inference may also require:

```text
native.execute
model.load
model.download
filesystem.read
network.fetch only if remote download or hosted inference is explicitly enabled
```

Expected workflow:

```text
1. User imports, pastes, or selects a molecular structure image.
2. User runs Recognize Structure from Image.
3. Plugin returns SMILES, molfile, confidence, atom/bond coordinates, and warnings where available.
4. App validates the proposed SMILES/Molfile through the chemistry adapter.
5. User reviews the recognized structure and optional overlay.
6. User chooses Insert as Editable Molecule or Replace Image with Molecule.
```

Rules:

- Do not bundle the upstream MolScribe code, PyTorch, OpenCV, Hugging Face downloads, or model checkpoints into the core app.
- Do not download model weights without explicit user action.
- Do not run Python/native services silently.
- Do not upload images or screenshots to remote inference without explicit `network.fetch` permission and user consent.
- Do not insert recognized structures directly into documents. Return a proposed patch and require user acceptance.
- Preserve source-image context where feasible.
- Store model/checkpoint/source/confidence metadata with the plugin result.
- Include citation and license notices for the upstream MolScribe project and checkpoint.

First implementation should be a scaffold with mocked output. Real ML inference should wait until native-service permissions, model-checkpoint handling, and dependency documentation exist.

## 15. Security, dependency, and licensing policy

Recommended default:

```text
Core app: Apache-2.0
Documentation: CC-BY-4.0 or Apache-2.0
Original UI assets/icons: Apache-2.0 or CC-BY-4.0
Example plugins: Apache-2.0 or MIT
```

Rules:

- Do not copy proprietary UI assets.
- Do not copy proprietary documentation.
- Do not copy ChemDraw templates.
- Do not include GPL/AGPL code in permissive core packages without explicit project approval.
- Isolate optional GPL/AGPL integrations as external tools if needed.
- Record licenses in dependency metadata.
- Review every dependency license before adding it.
- Avoid heavy ML dependencies in the core app.
- Keep MolScribe OCSR as an optional plugin/native-service integration with explicit license and citation notices.

## 16. Testing strategy

The required test types, listed by area, live in **AGENTS.md §13** — that is the list an agent is
obliged to satisfy for a change, so it is not duplicated here.

What this section owns is the **fixture corpus**: the specific molecules and documents that
compatibility work must be proven against. A test list says what kind of test to write; this says
what to write it about.

Compatibility fixtures should include:

```text
benzene
aspirin
chiral lactic acid
E alkene
Z alkene
quaternary ammonium
nitrobenzene
salt pair
reaction arrow with conditions
equilibrium arrow
retrosynthesis arrow
polymer SRU bracket
R-group display
alias/superatom
text fonts/colors
style preset import warnings
.cds synthetic style sheet
multicomponent reaction
unknown object preservation
image-to-structure mock fixture
```

Every fixture should track expected canonical SMILES where applicable, formula, total charge, atom count, bond count, stereochemistry notes, round-trip expectations, and known limitations.

## 17. Development roadmap

**How to read this roadmap (reconciled 2026-07-30).**

The phases below are kept in their original order for traceability, not as a work queue. Work has not
proceeded phase-by-phase for some time: the plugin program (Phase 12 territory) shipped in full while
Phases 8 and 9 remain partial, and release engineering (Phase 11) shipped ahead of the documentation
in the same phase. Each phase now carries a status line; trust the status lines and §1.1 over the
phase ordering.

The original "stage correction" note is preserved because its warning still holds: the first
scaffold's dashboard-like UI was never product direction, and nothing should go back to polishing it.

There is no single "current lane". The active slice lives in `PLANS.md`.

### Phase 0: Repository foundation

Expected outcome:

```text
A clean monorepo that builds, tests, and gives future agents a stable structure.
```

Deliverables:

- pnpm workspace
- Tauri + React + TypeScript app skeleton or Vite shell if Tauri setup is delayed
- Shared TypeScript config
- Linting and formatting where practical
- Vitest
- README
- PLAN.md
- AGENTS.md
- Package skeletons
- `examples/plugins/molscribe-ocsr` README and manifest stub only
- Basic CI config if practical

### Phase 1: Native document model

Deliverables:

- `packages/chem-core`
- Zod schemas
- TypeScript types
- Document creation helpers
- Patch application
- Undo/redo foundation
- Serialization and validation tests
- Object placeholders for molecules, reactions, arrows, mechanism annotations, text, brackets, graphics, groups, superatoms, R-group display, and unknown compatibility objects

### Phase 2: Command registry and plugin API

Deliverables:

- `packages/plugin-api`
- `packages/plugin-host`
- Manifest schema
- Permission declarations
- Command registry
- `RecognizedStructureResult` type
- Proposed-patch workflow
- Plugin storage interface
- Tests for permission enforcement

### Phase 3: MolScribe OCSR plugin scaffold

Deliverables:

- Manifest
- README with license/citation/dependency notes
- Command stub
- Panel stub
- Mock recognition output
- Confidence/warning display
- Source-image preservation
- Proposed-patch acceptance flow
- Tests

No PyTorch, OpenCV, model checkpoint, Python sidecar, or network download in this phase.

### Phase 4: First drawing workflow closeout

Phase 4 is complete only when the first drawing workflow is real, not visual scaffolding.

Completion requires:

- A real blank document flow.
- An active editor path behind `EditorAdapter`, or an explicit adapter-backed fallback state.
- Molecule/editor state inserted into the native document model, or explicitly stored through the adapter fallback with clear limitations.
- Native save/open for the Phase 4 document subset.
- SVG and PNG export for the Phase 4 subset.
- Page rendering backed by `chem-core` objects or clearly marked adapter-backed state.
- Status bar data reporting real document/editor state.
- Tests covering the implemented flow.

Do not mark Phase 4 complete if the implementation only displays fake UI elements, fake molecule/reaction/product placeholders, or disabled controls without the documented fallback behavior.

### Phase 4.5: Toolset and viewport infrastructure closeout

This interlude reflects the implemented desktop workspace corrections and should stay narrow.

Deliverables:

- Wire persisted user toolbar layout state into desktop startup.
- Apply user layout state before constructing toolset registry, menu, and window state.
- Keep Rust/Tauri menu generation aligned with the TypeScript registry model.
- Persist visibility, position, layout, mode, and size without mutating source manifests.
- Add tests for built-in, plugin, and user toolset menu generation.
- Add tests for user layout state applied to the startup registry.
- Keep drag-and-drop customization UI deferred.
- Keep chemistry implementation out of this task.

### Phase 5: Chemistry validation and basic properties

Status: completed for the current placeholder-backed validation slice. Keep this lane for traceability and do not treat it as the current next phase unless repairing a regression.

Deliverables:

- `chemistry-adapter` interface for validation and basic properties.
- `rdkit-adapter` implementation or honest placeholder with capability reporting.
- Selected-structure validation.
- Molecular formula.
- Average mass.
- Exact mass where available.
- Total charge.
- Basic stereochemistry warnings where available.
- Fixture tests for supported structures and warnings.

Do not let Phase 5 become broad UI polish, a new toolbar concept, CDXML/CDX compatibility, clipboard compatibility, NMR/MS/pKa/logP plugins, or image-to-structure recognition unless explicitly requested.

### Phase 6: Editor engine hardening

Status: conditionally complete as an adapter-boundary closeout. Phase 7.1 has added a narrow real Ketcher host for active selected-molecule editing; it is not the whole ChemDraft canvas.

Deliverables:

- `KetcherAdapter` or other selected editor adapter implementation.
- Narrow desktop Ketcher host for a selected `MoleculeObject`.
- Capability report.
- Basic molecule load/save through adapter.
- Documented gaps around mechanism annotations, page layout, and other non-editor objects.
- Continued preservation of the composited `chem-core` page as the document source of truth.

Closeout evidence:

- `packages/ketcher-adapter` exposes a host adapter boundary and the desktop Ketcher host is the only intended direct Ketcher UI import boundary.
- Capability reporting distinguishes disconnected and connected host states.
- Molecule load/save contracts cover supported molecule formats and reject unsupported objects or formats.
- Page-level gaps remain explicit: reactions, mechanism annotations, page layout, superatoms, and R-group metadata are outside the adapter boundary.
- `chem-core` remains the composited page source of truth.

### Phase 6.5: Canvas page-size infrastructure

Status: closed out and verified. Treat this as the page-layout baseline for later drawing, export, and layout work.

This narrow interlude prepared the document canvas for real page/layout work before broader drawing productivity.

Deliverables:

- Native page layout state with paper preset, orientation, source physical units, CSS-pixel dimensions, and margins.
- Geometry invariant enforcement between `page.layout.widthPx`/`heightPx` and any denormalized `page.width`/`height`.
- Legacy Phase 4 document migration to US Letter portrait without changing objects, selection, or chemistry payloads.
- Command-backed minimal page-size surface under File > Page Setup for US Letter, US Legal, popular ISO A sizes, portrait, and landscape.
- Viewport, rulers, crosshairs, page rendering, object positioning, and export driven by native page layout.
- SVG physical width/height units for inch and ISO millimeter presets, with CSS-pixel `viewBox`.
- PNG export kept pixel-based without hard-coded Letter fallback.
- Inch rulers/grid/crosshair ticks for US presets and centimeter rulers/grid/crosshair ticks for ISO A presets.

Required tests:

- US Letter, US Legal, and popular ISO A-size conversion and orientation.
- Page geometry invariant validation.
- Legacy document migration.
- Save/open preservation.
- SVG physical units plus `viewBox`.
- PNG export avoiding hard-coded Letter fallback.
- Ruler/grid/crosshair unit switching between US and ISO presets.
- Page-size commands preserving molecule payloads and selection.

Do not add a full Page Setup dialog, custom-size editor, printing, new dependencies, Ketcher, RDKit, CDXML/CDX, clipboard compatibility, or toolbar customization work in this interlude.

Closeout evidence:

- Page layout state, physical paper presets, orientation, geometry invariants, and legacy migration live in `chem-core`.
- Page-size and orientation changes are command-backed through File > Page Setup.
- Viewport, rulers, crosshairs, page rendering, PNG fallback dimensions, and SVG physical size export consume native document page layout.
- US presets use inch rulers/grid/crosshair spacing; ISO A presets use centimeter rulers/grid/crosshair spacing.
- Regression tests cover conversion, orientation, migration, save/open preservation, SVG units and `viewBox`, PNG fallback, ruler-unit switching, and molecule payload preservation.
- Live app stress on the `./run-app` bundle covered A0, A4, US Legal, US Letter, portrait/landscape switching, ruler/crosshair toggles, scroll/ruler sync, and single-app-process verification.

Future work should preserve this behavior rather than reimplementing page geometry in React constants or renderer-local state.

### Phase 7: Core drawing productivity

Status: **substantially delivered, two deliverables outstanding.** Command-backed tool state,
shortcut routing, bonds, atom labels, rings, chains, wedge/dash, charge/radical placement, reaction
arrows, brackets, text with subscript/superscript, group/ungroup, align/distribute, rotate/flip,
z-order, style presets with `.cds`-derived application, and the keyboard shortcut registry are all
in place, along with the art inspector and the Customize Toolbars UI. Still outstanding from the
deliverable list below:

- **Mechanism annotations.** `packages/mechanism-tools` is a type stub, `tool.mechanismArrow` is
  retired, and the flyout's curved and fishhook arrows are art arcs with markers — no atom or bond
  anchoring, no semantic mechanism model.
- **Abbreviations/superatoms and R-group display.** `chem-core` represents both (`superatom` object
  type, `SuperatomMetadataSchema`, `RGroupDisplaySchema`, `RGroupLabelObjectSchema`), but no drawing
  tool or command authors them — the model is ready and the authoring surface is missing.
  `packages/template-library` is still an 8-line stub, so ring templates come from elsewhere and
  `tool.templateGrid` stays retired.

First slice:

- Real active-tool state model.
- Command-backed bond, atom, ring, text, and arrow tool definitions.
- Tool activation through the command/state architecture, not button-local chemistry behavior.
- Unsupported tools remain disabled or report explicit unavailable state.
- No fake molecule, reaction, arrow, product, or mechanism output.
- No direct Ketcher or RDKit imports in random UI code; the narrow desktop Ketcher host is the only current direct Ketcher import boundary.
- Editor-adapter-mediated molecule edits where available.
- `chem-core` document objects remain the source of truth for page content.

Do not start Phase 7 with CDXML/CDX, clipboard, `.cds`, OCSR, NMR/MS/pKa/logP, full drag-and-drop toolbar customization, full Page Setup, multi-page add-page UI, or broad visual redesign.

Deliverables:

- Bond tools
- Atom label shortcuts
- Abbreviations/superatoms
- Basic R-group/generic-atom display
- Ring templates
- Chain tool
- Wedge/dash tools
- Charge/radical placement
- Reaction arrows
- Mechanism annotations
- Text labels with basic subscript/superscript
- Brackets
- Group/ungroup
- Align/distribute
- Rotate/flip
- Z-order
- Native style preset controls, default style selection, and `.cds`-derived preset application
- Keyboard shortcut registry

#### Native Art Inspector / Baby Illustrator Controls

Status: planned follow-up after the native art-engine extraction. This is a product-surface and style-model lane, not a replacement for the document canvas.

Design statement:

```text
ChemDraft should grow a small native vector-art inspector: a baby Illustrator for scientific figures, backed by ChemDraft's own GraphicObject model and art-engine render plans.
```

Keep the ownership split explicit:

```text
@chemdraft/art-engine = geometry, canonical path planning, projection, bounds, paint resolution, gloss-gradient planning, and export fragments
apps/desktop toolbar/inspector = fill/stroke target state, swatches, opacity sliders, gradient editor UI, presets, and toolbar behavior
```

Rules:

- Keep `GraphicObject` as the persisted document boundary for art primitives.
- Do not persist dependency-native objects, CSS `url(...)`, raw `rgba(...)` strings, DOM state, React state, canvas objects, Fabric/Konva/Excalidraw/tldraw objects, or editor-only selection state.
- Store native JSON style data and let `@chemdraft/art-engine` serialize it for editor rendering, SVG export, PDF/raster export, and later compatibility formats.
- Preserve legacy fields such as `fillColor`, `strokeColor`, `strokeWidth`, `strokeDasharray`, `fillMode`, and `effect`.
- Resolve paint backward-compatibly: if `fillPaint`/`strokePaint` exists, use it; otherwise synthesize paint from the legacy fields.
- Browser rendering and SVG export must consume the same art-engine paint plan.
- In editor mode, `GraphicObject` instances remain filtered out of `PageSvgSurface` and render only through the overlay; do not reintroduce duplicate or frozen graphic rendering.
- Gradient coordinates, gloss highlights, and gradient transforms must follow object Z rotation and X/Y tilt so exported output and editor output match the visible object.
- Live style edits may preview continuously, but history should commit one undo entry on change end.

Style schema direction:

- `fillPaint?: GraphicPaint`
- `strokePaint?: GraphicPaint`
- `fillOpacity?: number`
- `strokeOpacity?: number`
- `opacity?: number`
- `strokeLineCap?: "butt" | "round" | "square"`
- `strokeLineJoin?: "miter" | "round" | "bevel"`
- `strokeMiterLimit?: number`
- Optional later: `blendMode?: "normal" | "multiply" | "screen" | "overlay"`

`GraphicPaint` should be native JSON:

- `none`
- solid color plus opacity, using canonical `#RRGGBB`
- linear gradient with object-local endpoints and stops
- radial gradient with object-local center, radius, optional focus point, and stops

Inspector controls, first slice:

- Fill/stroke target toggle.
- Fill swatch and stroke swatch.
- None button.
- Swap fill/stroke.
- Object opacity, fill opacity, and stroke opacity.
- Stroke width.
- Dash pattern.
- Solid fill/stroke only at first.

Direct shape editing, current hardening slice:

- Circular arcs use semantic `GraphicObject.data.arcCenter`, `arcRadiusX`, `arcRadiusY`, `arcStartRadians`, and `arcSweepRadians` once edited. Existing arcs without semantic center/radii synthesize them from bounds for rendering and handles, but do not persist the synthesized values until a user edits the arc.
- Arc start/end handles change start/sweep only. The arc middle handle changes midpoint angle and radius while preserving sweep, then object bounds are recomputed from sampled arc points plus stroke padding.
- Rectangle corner radius is edited directly on the selected rectangle with a small projected handle, not through a generic "Corners" dropdown.
- Corner-radius editing stays native to `GraphicObject.data.cornerRadiusPx`, clamps to `0..min(width,height)/2`, preserves `graphicKind: "rect"`, and uses art-engine projection/unprojection helpers for rotated or tilted shapes.
- Line-end/corner join commands can remain tested command behavior, but the main art toolbar should hide those controls until an advanced inspector surface makes their applicability clear.

Gradient controls, second slice:

- Fill type: none, solid, linear gradient, radial gradient, gloss preset.
- Stop list.
- Draggable stop rail.
- Selected stop color and opacity.
- Reverse gradient.
- Rotate gradient.
- Duplicate stop.
- Delete stop.

Dependency policy:

- Use `react-colorful` for color picker UI if a picker dependency is needed.
- Use `culori` only if real gradient interpolation or color math requires it.
- Do not add a gradient-picker package initially.
- Treat Grapick as a spike candidate only; do not add it by default.
- Do not add Fabric, Konva, Excalidraw, tldraw, or any second drawing app.

Expected interaction behavior:

- Selecting an art object shows existing transform handles and art-inspector controls.
- Fill swatch changes apply to fill only.
- Stroke swatch changes apply to stroke only.
- Multi-select shows mixed state when selected graphics disagree.
- Applying a style change to a mixed selection updates all selected graphics for that property.
- Dragging a color or opacity control previews through the current document and commits a single undo step on pointer up or `onChangeEnd`.
- Escape cancels the live edit and restores the start document.
- Enter or clicking outside commits the live edit.
- Selected fill-vs-stroke target is desktop UI state, not document state.

Tests:

- Style schema accepts new opacity and paint fields while preserving legacy fields.
- Legacy `fillColor`/`strokeColor` still render and export.
- Fill/stroke target commands only change the selected target.
- Alpha renders in editor and SVG export.
- Multi-select mixed state is represented without mutating documents.
- Gradient stops render identically in editor and export.
- Gradient transforms follow object Z rotation and X/Y tilt.
- Undo/redo produces one history entry per completed style edit.
- No forbidden bundled drawing-app dependency enters the graph.

Suggested product sequence:

1. Art-engine path, bounds, projection, and export parity.
2. Solid paint inspector: fill/stroke target, color picker, opacity, stroke width, and dash.
3. Stroke polish: cap, join, miter limit, and presets.
4. Gradient paint model and export.
5. Gradient editor UI.
6. Appearance presets and copy/paste appearance.
7. Optional advanced features: eyedropper, style library, freehand, arrowheads, and blend modes.

Future arrowhead direction:

- Add native `markerStart` and `markerEnd` metadata under `GraphicObject.data`; do not overload stroke line caps.
- Marker kinds should start with `none`, `open-arrow`, `filled-arrow`, `bar`, and `dot`, with explicit size and angle/spread fields.
- Marker endpoints should be editable through overlay handles owned by the native art editing path.
- SVG export should emit real marker definitions from the art-engine plan.
- Keep this as a follow-up; do not implement arrowheads as part of the corner-radius/popover hardening slice.

### Phase 8: Import/export and Office-friendly clipboard MVP

Status: **partial — the image half shipped, the chemistry half did not.** SVG, PDF, PNG, JPEG, BMP,
GIF, and TIFF export are `"implemented"` in `packages/export-engine/src/formats.ts`. MOL, SDF, RXN,
SMILES, and CML are still `"planned"`. The clipboard adapter detects every payload kind and molfile
and SMILES paste work, but CDXML, CDX, and RXN paste return explicit "not implemented yet" messages.
Clipboard writing is text-only (`write_clipboard_text_items`), so Office-friendly *image* copy is
not delivered.

Deliverables:

- MOL/SDF/SMILES/RXN import/export
- SVG/PNG/PDF export
- Clipboard adapter
- Copy as SVG/PNG/SMILES/RXN where supported
- Paste MOL/RXN/SMILES/plain text where supported
- Office-friendly copy tests where practical
- Export and clipboard warnings

### Phase 9: CDXML compatibility and best-effort CDX read/paste

Status: **CDXML delivered; CDX not started.** `packages/cdx-compat` owns both the CDXML writer/parser
and the native save envelope (`openChemDraftPayload`, `CdxmlEnvelopeCodecVersion`), so CDXML is
simultaneously ChemDraft's own container and its interop format; foreign CDXML imports through the
same path. CDX binary is `"deferred"` for export and its clipboard paste is unimplemented, so the
"best-effort CDX read/paste early" intent of §5 has not been met.

Deliverables:

- `packages/cdx-compat`
- CDXML intermediate model
- CDXML writer/parser
- Native-to-CDXML conversion
- CDXML-to-native conversion
- CDXML clipboard copy/paste where supported
- Best-effort CDX reader/paste path
- Tier A fixtures including stereochemistry and superatoms
- Basic style round-trip fixtures
- `.cds` kept in `style-compat` or the documented style compatibility boundary, not treated as a normal molecule/document import
- Warning UI/report

### Phase 10: First real MolScribe OCSR local-service spike

Status: **not started, and overtaken.** The first serious plugin was the NMR predictor, not MolScribe
— see §14. `examples/plugins/molscribe-ocsr` remains a scaffold.

Deliverables:

- Optional local native-service or Python sidecar contract
- User-configured checkpoint path
- Dependency documentation
- License/citation display
- Predicted SMILES/Molfile return type
- Confidence/warning display
- Chemistry validation before proposed patch
- Review-before-insert flow

If native-service or PyTorch packaging is not ready, keep mocked inference and do not pull heavy dependencies into the core app.

### Phase 11: Beta hardening

Status: **release engineering shipped well ahead of the documentation.** Installer builds, signed
releases, notarization, and Sparkle auto-update against a signed appcast are all live, with v0.3.0
published (`docs/releasing/macos-updates.md`). The documentation deliverables are untouched:
`docs/migration/`, `docs/compatibility/`, and `docs/file-formats/` are five-line stubs, so the
ChemDraw migration guide and the known-limitations page do not exist. Given how much of §5's
non-goal list is still non-goal, the known-limitations page is the higher-value of the two.

Deliverables:

- Better error messages
- Compatibility report UI
- More fixtures
- Visual regression tests
- Installer builds
- Signed releases if practical
- Documentation
- Example workflows
- Migration guide for ChemDraw users
- Known limitations page, including structure-to-name, full CDX write, full Office embedded-object editing, image-recognition limitations, and complex CDXML graphics

### Phase 12: Advanced features through plugins

Status: **the plugin infrastructure shipped, out of phase order, and two plugins with it.** The whole
runtime — persistent host, per-plugin Web Workers, declarative panel reports, packaged installs,
Plugin Manager, host-managed updates — is delivered (AGENTS.md §8a). NMR prediction shipped as the
first serious plugin and has since moved to its own repository; the mass/`m/z` analyzer ships as
`examples/plugins/mass-fragment-demo`. The rest of the list below remains candidate work.

Candidate plugins:

- MolScribe OCSR image-to-structure
- RxnScribe-style reaction-image parsing, if license and service shape are acceptable
- OPSIN name-to-structure
- InChI/InChIKey
- ~~NMR prediction~~ — shipped, now a standalone repository
- ~~Mass-spec fragmentation~~ — shipped as `examples/plugins/mass-fragment-demo`
- pKa/logP/logS
- Reaction mapping
- Advanced journal style packs
- Teaching mode beyond core mechanism drawing
- Batch export
- ELN integrations
- Structure-to-name exploration only if a reliable option exists

## 18. Suggested Codex sequence

**Historical (reviewed 2026-07-30).** Tasks 1–11 are done, and the sequence stopped being followed
well before that — the plugin program ran to completion out of order. Kept for traceability and
because the *shape* of the guidance still holds: small, sequential, bounded tasks. Do not read it as
a queue; take the next piece of work from `PLANS.md` or from the outstanding items flagged in §1.1
and §17.

Remaining unstarted: Task 12 (MOL/SDF/SMILES/RXN import/export), Task 15 (best-effort CDX
read/paste), and Task 16 (MolScribe OCSR local-service spike). Tasks 13 and 14 (CDXML export and
import) are delivered.

Use small, sequential tasks.

Task 1:

```text
Create the monorepo, app skeleton, package skeletons, docs, and basic tests. Include a placeholder `examples/plugins/molscribe-ocsr` folder with a manifest stub and README, but do not implement image recognition yet.
```

Task 2:

```text
Implement the native document model in `chem-core`, including molecule, reaction, text, arrow, mechanism annotation, group, superatom, R-group display, and unknown compatibility object placeholders.
```

Task 3:

```text
Implement the command registry, plugin manifest validation, permission declarations, and typed result scaffolds, including `RecognizedStructureResult` for image-to-structure plugins.
```

Task 4:

```text
Create the first real plugin scaffold for MolScribe OCSR: manifest, README, command stub, service-contract types, fixture-backed fake recognizer, confidence/warning display, source-image preservation, and tests. Do not add PyTorch, OpenCV, Python sidecars, model checkpoints, or network downloads yet.
```

Task 5:

```text
Close out Phase 4 first drawing workflow: real blank document flow, active EditorAdapter path or explicit adapter-backed fallback, insert/update path into the native document model or documented fallback state, native save/open for the Phase 4 subset, SVG/PNG export for the Phase 4 subset, real status reporting, and tests. Do not use fake chemistry placeholders or continue polishing dashboard scaffolding.
```

Task 6:

```text
Wire persisted user toolbar layout state into the desktop registry startup path. Use `applyToolsetLayoutState`, load persisted layout state, apply it to the desktop toolset registry/menu/window model, ensure user-created toolsets can appear in View > Toolbars, ensure hidden/reordered tools affect rendered toolsets, preserve command-driven behavior, and add tests. Do not implement drag/drop customization UI. Do not implement chemistry drawing.
```

Task 7:

```text
Begin Phase 5 chemistry validation and basic properties: chemistry-adapter contract, RDKit adapter or honest placeholder, selected-structure validation, formula, average mass, exact mass where available, total charge, stereochemistry warnings where available, and fixture tests. Do not turn this into broad UI redesign.
```

Task 8:

```text
Phase 6 editor engine hardening is conditionally complete as an adapter-boundary closeout. Preserve the KetcherAdapter host boundary, capability reporting, molecule load/save contract, narrow desktop Ketcher host, documented page-level gaps, and `chem-core` as the composited page source of truth. Do not treat the Ketcher host as ownership of the whole ChemDraft canvas.
```

Task 9:

```text
Phase 6.5 canvas page-size infrastructure is complete. Do not rerun this as the next implementation task unless repairing a regression. Preserve native page layout state in `chem-core`, File > Page Setup commands, document-backed viewport/ruler/crosshair/export geometry, inch units for US presets, centimeter units for ISO A presets, physical SVG size units with CSS-pixel `viewBox`, PNG pixel fallback behavior, and tests that page-size commands preserve molecule payloads.
```

Task 10:

```text
Implement native style preset schema and default-style preservation in documents, including tests that save/reopen the selected preset.
```

Task 10a:

```text
Implement `.cds` style-sheet import through the style compatibility boundary, converting supported settings into native ChemDraft style presets with warnings and synthetic/legal fixtures.
```

Task 11:

```text
Continue Phase 7 with narrow command-backed drawing-productivity slices. Preserve real tool activation/state architecture, command-backed bond/atom/ring/text/arrow tool definitions, disabled/unavailable states for unsupported tools, the narrow active Ketcher molecule editor host, and tests for command routing. Do not create fake chemistry output, spread Ketcher/RDKit imports outside adapter/host boundaries, or start CDXML/CDX, clipboard, `.cds`, OCSR, full Page Setup, add-page UI, drag/drop toolbar customization, or broad visual redesign work.
```

Task 12:

```text
Implement MOL/SDF/SMILES/RXN import/export plus SVG/PNG/PDF export with warnings and fixtures.
```

Task 13:

```text
Implement basic CDXML export with stereochemistry and superatom fixtures.
```

Task 14:

```text
Implement CDXML import fixture-by-fixture and add CDXML clipboard support where supported.
```

Task 15:

```text
Implement CDX best-effort read/paste support before CDX writing, with compatibility warnings and fixtures.
```

Task 16:

```text
Upgrade the MolScribe OCSR plugin from scaffold to optional local-service spike. Keep it out of the core app dependency graph.
```

## 19. Release readiness checklist

Note (2026-07-30): macOS builds are already published (v0.3.0) under the release path in
`docs/releasing/macos-updates.md`. This checklist describes the bar for a *public, promoted* release
rather than for shipping a build at all, and several lines below are not yet met — MOL/SDF/SMILES/RXN
export, CDX read/paste, Office-friendly image copy, mechanisms, abbreviations/superatoms, R-group
display, and the user documentation. See §1.1.

Before public release:

- Native documents save and reopen reliably.
- Common molecules can be drawn and exported.
- Simple reactions can be drawn and exported.
- Basic mechanisms can be drawn and exported.
- Abbreviations/superatoms work as first-class drawing objects.
- Basic R-group/generic-atom display works.
- Hotkeys and type-to-build behavior are implemented for common workflows.
- Native style presets work, the selected preset survives save/reopen, and imported `.cds`-derived presets can be set as the default for new documents.
- SVG, PNG, PDF export work or PDF is clearly marked experimental.
- MOL/SDF/SMILES/RXN import/export works for fixture set.
- CDXML export/import works for Tier A fixture set.
- Best-effort CDX read/paste is documented with warnings.
- Office-friendly SVG/PNG copy works on primary OS targets.
- Plugin manifest validation works.
- Plugin permission enforcement works.
- MolScribe OCSR scaffold or spike is clearly documented as optional and does not add heavy dependencies to core startup.
- Chemistry round-trip tests pass.
- Visual regression tests are acceptable.
- No proprietary assets are included.
- Dependency licenses are reviewed.
- App does not crash on malformed import files in test fixtures.
- `.cds` style-sheet import uses synthetic/legal public fixtures and warns on unsupported settings.
- Documentation exists for users, migrating ChemDraw users, and plugin developers.
- Known limitations are documented plainly.

## 20. Open questions

Reviewed 2026-07-30. Re-review when a slice settles one of these; a question the code has already
answered is worse than no list, because it invites re-litigating a shipped decision.

### Still open

- Final project name, with ChemDraft preferred for now to avoid collision with the external MolScribe OCSR package.
- Final native file extension. (The *container* is settled — CDXML with ChemDraft object tags, per `packages/cdx-compat` — but the extension is not.)
- Final license for the repository root. `package.json` still says `UNLICENSED`. The example plugins are settled at MIT (2026-07-16), with the bundled NMR reference database carved out under the nmrshiftdb2 Database License; see AGENTS.md §8a.
- How strict the first CDXML compatibility target should be.
- Whether Ketcher is the long-term editor engine or just the first adapter.
- How the page/editor architecture keeps one composited page while using an active structure editor.
- Which platform clipboard formats are supported on Windows, macOS, and Linux for the first release.
- Which built-in templates and style presets are included without turning the app into a template-heavy suite.
- Which `.cds` settings are in the first supported style-sheet import subset.
- Whether a user-supplied `Tot_Syn_Style.cds` can remain local-only as a private reference or has clear redistribution rights for fixtures.
- How much name-to-structure can be offered through an optional plugin.
- Whether any reliable structure-to-name implementation exists that fits the license and quality requirements.
- Whether the MolScribe OCSR plugin runs local-only by default or supports an explicitly configured remote inference service.
- How the MolScribe OCSR plugin distributes or locates model checkpoints.
- Whether the MolScribe OCSR plugin should use a local Python sidecar, ONNX/WASM later, or another service path.
- How native plugins are signed and approved. (Package *integrity* is enforced by SHA-256 with a published sidecar; publisher *identity* is not, and the UI must not conflate the two.)

### Answered by shipped work

- ~~Whether the app supports a browser version initially.~~ Yes, as a shell: `pnpm dev:web` runs the desktop app in the browser. There is still no separate `apps/web` package.
- ~~Whether plugins are distributed through a registry later.~~ Not a registry — a host-owned catalog allowlisted by plugin id, with the app owning source, download, verification, handshake, replacement, and rollback. An installed plugin cannot choose its own download URL.
- ~~Whether RDKit loads in the frontend, backend, or both.~~ Moot for now: OpenChemLib is the shipped engine and `rdkit-adapter` is a declared placeholder (AGENTS.md §6.18-6.19). The question returns if real RDKit wiring lands.
- ~~Which mechanism arrows are chemically semantic versus graphical annotations.~~ Currently all graphical. The four reaction-arrow families and the curved/fishhook electron-pushing arrows are art objects; no arrow carries atom or bond anchoring. A semantic mechanism model remains unbuilt (Phase 7).
- ~~What installer/distribution system is preferred for each OS.~~ Settled for macOS: signed and notarized bundle, Sparkle auto-update against a signed appcast (`docs/releasing/macos-updates.md`). Windows and Linux remain open.

## 21. Guiding rule

When a requested feature is essential to drawing, saving, exporting, importing, clipboard migration, style migration, or plugin infrastructure, consider it for core.

When a requested feature is specialized analysis, prediction, cloud workflow, ELN workflow, advanced database behavior, field-specific template expansion, or heavy AI/ML inference, implement it as a plugin or postpone it.

The core app should stay boring, reliable, and fast. The plugin system is where specialized ambition belongs.
