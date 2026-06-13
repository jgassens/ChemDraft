# ChemDraft Export Engines Build Plan

Repository blueprint: this is the durable export-engines implementation blueprint for ChemDraft. Future export-engine work should use this document as the planning source before changing dependencies, export contracts, or format support.

Status: planning document for a Codex implementation project. This file is written so it can be dropped into the repository and followed as an implementation guide. It does not require proprietary assets, proprietary sample files, or external commercial documentation.

## 0. Purpose

Build ChemDraft export engines for the requested ChemDraw-style export wishlist while keeping the core app legally clean, chemically honest, and aligned with the existing package boundaries.

The first useful product should export:

```text
SVG, PDF, PNG, JPEG, BMP, GIF, TIFF
MOL / MDL Molfile V2000
SDF / MDL SDfile V2000
RXN / Reaction Molfile V2000
CML
CDXML
```

Other wishlist formats should be represented in the export registry with explicit unavailable/deferred status until there is a clean implementation path:

```text
CDX / ChemDraw binary
ChemDraw Stationery
ChemDraw 3.x
TGF
ISIS/Sketch SKC
MDL RDfile / RDfile V2000
MSI ChemNote
SMD 4.2
EPS
3MF display
3MF printing
```

EPS and 3MF are not chemistry interchange formats. They should be treated as page/graphics export formats and implemented only after the SVG/PDF/raster paths are stable.

## 1. Non-negotiable project rules

Before editing code, Codex must read:

```text
AGENTS.md
PLAN.md
README.md
package.json
pnpm-workspace.yaml
docs/architecture/dependency-inventory.md
packages/export-engine/package.json
packages/export-engine/src/index.ts
packages/chem-core/src/schemas.ts
packages/cdx-compat/src/index.ts
packages/chemistry-adapter/src/index.ts
packages/rdkit-adapter/src/index.ts
apps/desktop/package.json
apps/desktop/src/commands.ts
apps/desktop/src/MainWindow.tsx
apps/desktop/src/documentWorkflow.ts
apps/desktop/src-tauri/Cargo.toml
apps/desktop/src-tauri/src/lib.rs
```

Follow these rules throughout the work:

1. Do not copy ChemDraw, ChemOffice, CambridgeSoft, PerkinElmer, Revvity, ISIS/Draw, Symyx, MDL, or other proprietary icons, templates, toolbar files, help text, screenshots, sample files, menu files, or branded assets.
2. Do not make CDXML/CDX the native document model. `chem-core` remains the source of truth for native documents.
3. Keep CDXML/CDX work inside `packages/cdx-compat`.
4. Keep export orchestration inside `packages/export-engine`.
5. Keep external chemistry engines behind adapter boundaries. Do not import Ketcher, RDKit, Indigo, Open Babel, or format-converter libraries directly into arbitrary React files.
6. Do not add GPL or AGPL dependencies to core packages. GPL/AGPL tools may only be optional external converters/plugins with clear license notices and separate execution boundaries.
7. Do not silently change chemical identity. Every lossy or unsupported export path must return warnings or errors.
8. Do not silently merge separate molecules, split molecules, drop charges, drop radicals, drop isotopes, drop stereochemistry, drop reaction mapping, flatten superatoms/R-groups to plain text, or export mechanism annotations as chemistry.
9. Keep plugins and external services from mutating the document directly.
10. When dependencies are added, update `docs/architecture/dependency-inventory.md` in the same implementation slice.
11. When code changes are made, update the build stamp in `AGENTS.md` and the matching build string in `apps/desktop/src/MainWindow.tsx`.
12. Use synthetic fixtures created for ChemDraft. Do not commit proprietary files gathered from commercial software.

## 2. Current implementation assumptions to verify before editing

Codex should verify these against the current repository before making changes:

- `packages/export-engine` currently exports SVG and has a format union that already mentions several future formats.
- `packages/cdx-compat` already owns CDXML envelope import/export and uses `fast-xml-parser`.
- The desktop app already depends on Ketcher packages through the narrow active editor host.
- `apps/desktop/src/commands.ts` currently exposes `export.svg` and `export.png` commands only.
- `apps/desktop/src-tauri/src/lib.rs` currently hardcodes File menu entries for `export.svg` and `export.png`.
- The Rust Tauri backend currently has no rasterization command.
- `packages/chemistry-adapter` currently supports validation/analysis concepts, not general format conversion.
- `packages/rdkit-adapter` is currently a placeholder, not a real RDKit integration.
- `chem-core` already has native molecule atoms, bonds, charges on atoms, superatom metadata, R-group display metadata, reaction objects, arrows, text, graphics, and compatibility warnings.

If the repository has changed, adapt the implementation steps while preserving the architectural rules above.

## 3. Export target model

Export formats must be grouped by target scope.

### 3.1 Page/document graphics formats

These export the visible page or selected visible objects. They are not chemistry interchange formats.

```text
SVG
PDF
PNG
JPEG
BMP
GIF
TIFF
EPS
3MF display
3MF printing
```

For these formats:

- Export from `ChemDraftDocument` / active page.
- Use the existing page layout and 96 CSS px per inch convention.
- Respect page size and orientation.
- Default to exporting the active page.
- Do not depend on selected molecule state unless the UI explicitly offers “selected objects only” later.
- Include warnings for unsupported visual objects, rasterization limits, missing fonts, unsupported SVG features, or lossy conversion.

### 3.2 Chemistry structure/reaction formats

These export selected molecule or reaction chemistry, not the whole visible page.

```text
MOL / MDL Molfile
MOL V2000 / MDL Molfile V2000
SDF / MDL SDfile
SDF V2000 / MDL SDfile V2000
RXN / Reaction Molfile
RXN V2000 / Reaction Molfile V2000
CML
Connection Table
RDfile
RDfile V2000
SMILES if kept in the existing export union
```

For these formats:

- Resolve a chemistry export target before writing.
- If exactly one molecule is selected, export that molecule.
- If multiple molecules are selected and the target format supports multi-record output, allow it only for SDF/RDF-style formats and produce one record per molecule.
- If no molecule is selected and the page has exactly one molecule, export it.
- If a selected `ReactionObject` exists, export that reaction for RXN/RDF.
- If no `ReactionObject` exists but exactly one reaction arrow and obvious left/right molecule groups exist, a best-effort RXN export may be implemented with warnings.
- If the target is ambiguous, return an error telling the user to select a molecule or reaction.
- Never silently combine all page molecules into one molecule.
- Never export mechanism arrows, plus signs, text, or reaction conditions as chemical bonds/atoms.

### 3.3 Compatibility formats

These are compatibility formats, not native storage.

```text
CDXML / ChemDraw XML
CDX / ChemDraw binary
ChemDraw 3.x
ChemDraw Stationery
TGF
ISIS/Sketch SKC
MSI ChemNote
SMD 4.2
```

For these formats:

- CDXML belongs in `packages/cdx-compat`.
- CDX read/paste should precede full CDX write.
- Long-tail legacy formats should start as research docs and disabled registry descriptors, not as enabled export code.
- Avoid broad converter grab-bags with incompatible licenses.
- Every legacy format must have clean-room fixtures and warning behavior before it becomes an enabled export option.

## 4. Dependency policy

Allowed in core packages after verification:

```text
MIT
BSD-2-Clause
BSD-3-Clause
Apache-2.0
Apache-2.0 OR MIT
MIT OR Apache-2.0
Zlib
```

Needs specific review before core use:

```text
MPL-2.0
LGPL
custom licenses
packages with unclear generated-code or model/data licensing
```

Not allowed in core packages:

```text
GPL
AGPL
commercial SDKs
dependencies requiring proprietary redistribution
dependencies that fetch hidden network assets or models at runtime
```

Dependency review checklist for every added package or Rust crate:

```text
Package/crate name:
Version:
Source repository:
License:
Transitive license check:
Runtime or development dependency:
Bundle size / native size impact:
Native build complexity:
Platforms tested:
Why this dependency is needed:
Why a smaller local implementation is not sufficient:
Security or file-parsing concerns:
Where it is isolated:
Inventory row added to docs/architecture/dependency-inventory.md:
```

## 5. Dependency candidates and initial use

### 5.1 PDF

Primary candidate:

```text
svg2pdf.js + jspdf
License: MIT + MIT
Purpose: vector PDF from the existing SVG exporter.
Initial location: preferably packages/export-engine if it can run cleanly in the desktop/browser test environment; otherwise a desktop export adapter under apps/desktop/src/export.
```

Alternative candidate:

```text
pdf-lib
License: MIT
Purpose: PDF assembly, metadata, embedded images, attachments.
Use only if svg2pdf.js/jsPDF cannot cover the needed vector page export or if later export features require PDF assembly beyond SVG conversion.
```

Expected outcome:

- `export.pdf` writes a vector PDF for the active page.
- The implementation starts from `exportDocumentToSvg(document)`.
- Unsupported SVG features return warnings.

Alternative result:

- If vector PDF conversion is unreliable in Tauri/WebView, implement a raster PDF fallback only with an explicit warning that the PDF contains an embedded raster page image.

### 5.2 Raster graphics

Primary candidates:

```text
Rust resvg crate
License: Apache-2.0 OR MIT
Purpose: SVG -> RGBA pixels.

Rust image crate
License: MIT OR Apache-2.0
Purpose: encode RGBA/pixel buffers as PNG, JPEG, BMP, GIF, TIFF.
```

Initial location:

```text
apps/desktop/src-tauri/Cargo.toml
apps/desktop/src-tauri/src/lib.rs or a new apps/desktop/src-tauri/src/export.rs module
apps/desktop/src/export/raster.ts for the frontend wrapper
```

Use `image` with the narrowest practical feature set. Prefer disabling default features if the chosen version supports this cleanly.

Expected outcome:

- `export.png`, `export.jpeg`, `export.bmp`, `export.gif`, and `export.tiff` can rasterize the active page SVG and save encoded files.
- PNG preserves transparency only if the UI/export option asks for transparent background. Default page export uses a white background.
- JPEG always uses a white background because JPEG has no alpha channel.
- BMP/GIF/TIFF use a white background initially unless alpha support is explicitly implemented and tested.

Alternative result:

- If GIF or TIFF encoding is poor or unexpectedly lossy, leave those formats disabled with an explicit registry reason and implement PNG/JPEG/BMP first.

### 5.3 Chemistry conversion

Initial path:

```text
Use native serializers for the minimum supported ChemDraft molecule/reaction model.
Use existing Ketcher/Indigo capability only behind adapter boundaries where it is already present.
Do not add RDKit as a core dependency until a real conversion API is designed and npm/package stewardship is verified.
```

Potential later candidates:

```text
RDKit / rdkit-js
License: BSD-3-Clause
Use: validation, conversion, CML/RXN/MOL helpers, chemistry checking.
Caveat: verify current maintenance and packaging status before making it a runtime dependency.

Indigo / Ketcher stack
License: Apache-2.0
Use: already-adjacent through Ketcher; evaluate for conversion only behind a formal adapter.
```

Expected outcome:

- V2000 MOL/SDF/RXN exports work from native ChemDraft molecule/reaction objects without depending on a hidden editor session.
- Any engine-backed conversion is isolated and testable.

Alternative result:

- If native CTAB serialization reveals model gaps, keep chemical exports limited to formats that preserve current ChemDraft identity and return warnings for everything else.

### 5.4 CDXML/CDX

Initial path:

```text
Use packages/cdx-compat for CDXML.
Do not let CDXML/CDX become chem-core state.
Treat CDX writing as later work. Treat CDX read/paste as higher priority than broad CDX write.
```

Expected outcome:

- `export.cdxml` maps to the current `exportDocumentToCdxml` path.
- CDXML appears in the export registry as "ChemDraw XML (CDXML)".
- Binary CDX appears as disabled or experimental until a tested writer exists.

### 5.5 EPS

Initial path:

```text
No Ghostscript.
No pstoedit.
No GPL/AGPL converter.
Write a focused EPS exporter directly from ChemDraft page/SVG primitives when needed.
```

Expected outcome:

- EPS writer handles simple ChemDraft-owned primitives: lines, paths, text, fills, strokes, page bounding box.
- Unsupported SVG fragments return warnings.

Alternative result:

- Leave EPS disabled until the native drawing primitives are broad enough to make EPS worthwhile.

### 5.6 3MF

Initial path:

```text
Do not prioritize 3MF until ChemDraft has a meaningful 3D or printable geometry pipeline.
Represent 3MF display and 3MF printing as disabled descriptors in the registry.
```

Potential later candidates:

```text
Custom ZIP/XML writer using fflate.
JSCAD 3MF serializer if ChemDraft later has 3D mesh objects.
lib3mf only if a native validation/writing requirement justifies heavier native integration.
```

Expected outcome:

- No first-pass 3MF export unless a later explicit task defines the mesh/solid semantics.

Alternative result:

- A proof export may create a flat plane/embossed 3MF only if the product requirement is explicitly accepted and tests prove the output opens in common 3MF readers.

## 6. Format registry

Create a first-class export format registry before adding more engines.

Suggested file:

```text
packages/export-engine/src/formats.ts
```

Suggested types:

```ts
export type ExportFormatId =
  | "svg"
  | "pdf"
  | "png"
  | "jpeg"
  | "bmp"
  | "gif"
  | "tiff"
  | "eps"
  | "mol"
  | "mol-v2000"
  | "sdf"
  | "sdf-v2000"
  | "rxn"
  | "rxn-v2000"
  | "cml"
  | "connection-table"
  | "rdf"
  | "rdf-v2000"
  | "cdxml"
  | "cdx"
  | "chemdraw-stationery"
  | "chemdraw-3x"
  | "tgf"
  | "isis-skc"
  | "msi-chemnote"
  | "smd-42"
  | "3mf-display"
  | "3mf-printing";

export type ExportFormatGroup =
  | "graphics"
  | "chemistry"
  | "compatibility"
  | "legacy"
  | "model3d";

export type ExportImplementationStatus =
  | "implemented"
  | "planned"
  | "deferred"
  | "unsupported";

export interface ExportFormatDescriptor {
  id: ExportFormatId;
  label: string;
  menuLabel: string;
  group: ExportFormatGroup;
  extensions: readonly string[];
  mimeType: string;
  status: ExportImplementationStatus;
  targetScope: "page" | "selection" | "molecule" | "reaction" | "multiRecord" | "model3d";
  textOrBinary: "text" | "binary";
  chemicallyMeaningful: boolean;
  warningSummary?: string;
  dependency?: string;
}
```

Expected behavior:

- The registry includes every wishlist item.
- Only implemented formats are enabled in menus/dialogs.
- Deferred formats show a clear reason in the registry and any export dialog.
- Tests assert that every descriptor has an extension, group, label, status, scope, and MIME type.
- Tests assert that current enabled formats correspond to actual exporter functions.
- Tests assert that legacy formats are not accidentally enabled.

## 7. Export result and warning model

Unify the export result shape so the desktop app can handle all formats consistently.

Suggested types:

```ts
export type ExportWarningSeverity = "info" | "warning" | "error";

export interface ExportWarning {
  code: string;
  message: string;
  severity?: ExportWarningSeverity;
  objectId?: string;
}

export interface TextExportResult {
  format: ExportFormatId;
  kind: "text";
  contents: string;
  mimeType: string;
  extension: string;
  warnings: ExportWarning[];
}

export interface BinaryExportResult {
  format: ExportFormatId;
  kind: "binary";
  bytes: Uint8Array;
  mimeType: string;
  extension: string;
  warnings: ExportWarning[];
}

export type ExportResult = TextExportResult | BinaryExportResult;
```

Standard warning codes:

```text
export.unsupported_format
export.deferred_format
export.unsupported_object
export.unsupported_svg_feature
export.missing_export_target
export.ambiguous_export_target
export.chemistry_lossy_superatom
export.chemistry_lossy_rgroup
export.chemistry_lossy_stereochemistry
export.chemistry_lossy_charge
export.chemistry_lossy_radical
export.chemistry_lossy_isotope
export.chemistry_v2000_limit
export.reaction_inferred_components
export.reaction_ambiguous_components
export.raster_dimension_limit
export.raster_font_substitution
export.pdf_raster_fallback
export.eps_unsupported_fragment
```

All exporter functions must return warnings rather than writing to the UI status bar directly.

## 8. Phase 1: registry, contracts, and no-op disabled formats

Files likely touched:

```text
packages/export-engine/src/index.ts
packages/export-engine/src/formats.ts
packages/export-engine/src/results.ts
packages/export-engine/src/*.test.ts
docs/architecture/dependency-inventory.md only if dependencies are added
```

Tasks:

1. Move current `ExportFormat` union toward `ExportFormatId`.
2. Add descriptor registry with all wishlist items.
3. Keep existing SVG export behavior intact.
4. Expose helpers:
   - `listExportFormats()`
   - `getExportFormatDescriptor(id)`
   - `listImplementedExportFormats()`
   - `isExportFormatImplemented(id)`
5. Add tests for the registry.
6. Do not enable any new UI command yet.

Expected outcome:

- `pnpm test` passes.
- The export-engine package has a complete typed map of wishlist formats.
- Deferred formats are visible as metadata, not active features.

Alternative result:

- If changing the existing `ExportFormat` type would ripple too far, keep it as a compatibility alias and add the new descriptor registry alongside it.

## 9. Phase 2: SVG hardening

Files likely touched:

```text
packages/export-engine/src/index.ts
packages/export-engine/src/svg.ts
packages/export-engine/src/xml.ts
packages/export-engine/src/svg.test.ts
```

Tasks:

1. Keep `exportDocumentToSvg(document, options)` as the stable public API.
2. Split SVG serialization helpers into dedicated modules if it improves testability.
3. Ensure interactive-only fragments continue to be omitted from export.
4. Ensure XML escaping is tested for text and attributes.
5. Ensure page layout physical sizing remains correct:
   - inch source units use inch width/height metadata where supported.
   - metric source units use millimeter width/height metadata where supported.
   - viewBox remains in ChemDraft internal CSS-px coordinates.
6. Ensure export warns for objects that are intentionally approximated or omitted.
7. Add synthetic fixture documents for:
   - blank page
   - one molecule
   - text with special characters
   - page margin rectangle
   - selected/hover state that must not export interactive hit targets

Expected outcome:

- Existing SVG export still works.
- SVG output is stable enough to feed PDF and raster engines.

Alternative result:

- If the current serializer already passes these checks, keep it small and only add missing tests.

## 10. Phase 3: PDF vector export

Files likely touched:

```text
packages/export-engine/package.json OR apps/desktop/package.json
packages/export-engine/src/pdf.ts OR apps/desktop/src/export/pdf.ts
packages/export-engine/src/pdf.test.ts OR apps/desktop/src/export/pdf.test.ts
apps/desktop/src/commands.ts
apps/desktop/src/MainWindow.tsx
apps/desktop/src-tauri/src/lib.rs
pnpm-lock.yaml
docs/architecture/dependency-inventory.md
```

Dependency candidate:

```text
svg2pdf.js
jspdf
```

Tasks:

1. Verify current package licenses and transitive licenses before adding dependencies.
2. Add dependencies to the narrowest package that needs them.
3. Use `exportDocumentToSvg(document)` as the PDF source.
4. Convert SVG into a PDF with a page size matching the ChemDraft page layout.
5. Preserve vector output as much as the SVG-to-PDF engine allows.
6. Add `export.pdf` to:
   - export registry as implemented.
   - desktop command specs.
   - native File menu only when the command has a real handler.
7. Add a test that generated PDF bytes start with the PDF header.
8. Add a test that a simple page exports without throwing.
9. Add warning behavior for unsupported SVG features or fallback rendering.
10. Update dependency inventory.

Expected outcome:

- File > Export PDF writes a valid PDF for the active page.
- SVG export remains the single source of visible page geometry.
- Unsupported conversion features are reported in warnings.

Alternative result:

- If vector conversion fails in Tauri/WebView or tests are not stable, keep the PDF descriptor planned and implement raster PDF fallback only with `export.pdf_raster_fallback` warning.

## 11. Phase 4: desktop raster export through Rust

Files likely touched:

```text
apps/desktop/src-tauri/Cargo.toml
apps/desktop/src-tauri/src/lib.rs
apps/desktop/src-tauri/src/export.rs
apps/desktop/src/export/raster.ts
apps/desktop/src/export/files.ts
apps/desktop/src/commands.ts
apps/desktop/src/MainWindow.tsx
docs/architecture/dependency-inventory.md
Cargo.lock
```

Dependency candidates:

```text
resvg
image
```

Prefer `image` features equivalent to:

```toml
image = { version = "...", default-features = false, features = ["png", "jpeg", "bmp", "gif", "tiff"] }
```

The exact feature list must be verified against the chosen crate version.

Tauri command design:

```rust
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RasterExportRequest {
    svg: String,
    format: RasterExportFormat,
    scale: Option<f64>,
    background: Option<String>,
    jpeg_quality: Option<u8>,
    max_dimension_px: Option<u32>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RasterExportResponse {
    bytes_base64: String,
    width: u32,
    height: u32,
    warnings: Vec<RasterExportWarning>,
}
```

A byte array response is also acceptable if it is simpler and performs well enough, but base64 is usually easier to move across Tauri safely.

Tasks:

1. Add an `export.rs` Rust module rather than further expanding `lib.rs`, unless the file layout argues otherwise.
2. Register the Tauri command in `generate_handler!`.
3. Rasterize SVG with `resvg`.
4. Encode output with `image`.
5. Enforce dimension and memory limits.
6. Apply white background by default.
7. Keep PNG alpha support optional and explicit.
8. Blend alpha onto white for JPEG/BMP/GIF unless a format-specific transparent mode is implemented and tested.
9. Add frontend wrapper to call the command and decode bytes.
10. Add `export.png`, `export.jpeg`, `export.bmp`, `export.gif`, and `export.tiff` handlers.
11. Add native menu items and command specs only for implemented formats.
12. Update dependency inventory.

Rust tests:

Use a minimal synthetic SVG fixture with a rectangle. Avoid text in raster tests because fonts make cross-platform output less deterministic.

Check magic bytes:

```text
PNG  89 50 4E 47
JPEG FF D8
BMP  42 4D
GIF  47 49 46 38
TIFF 49 49 2A 00 or 4D 4D 00 2A
```

Expected outcome:

- Active page can export to PNG/JPEG/BMP/GIF/TIFF from the same SVG geometry.
- The implementation is deterministic enough for smoke tests.
- Large raster requests fail with a clear warning/error rather than exhausting memory.

Alternative result:

- If GIF or TIFF encoding does not meet quality expectations, keep PNG/JPEG/BMP enabled and leave GIF/TIFF as planned with an implementation note.

## 12. Phase 5: export UI and file writing

Files likely touched:

```text
apps/desktop/src/commands.ts
apps/desktop/src/MainWindow.tsx
apps/desktop/src/export/*.ts
apps/desktop/src-tauri/src/lib.rs
apps/desktop/src/window-manager.ts if native command routing needs a shared helper
```

Tasks:

1. Prefer a single `export.openDialog` command for the full export picker.
2. Keep direct commands such as `export.svg`, `export.pdf`, `export.png` only for common or already existing menu items.
3. Native File menu should not become a long unstructured list. Use either:
   - File > Export... as primary action.
   - File > Export As submenu for the most common stable formats.
4. The export dialog should list:
   - implemented formats enabled.
   - planned/deferred formats disabled with short reason text.
5. The export dialog should show warnings after export if any warning severity is warning/error.
6. File writing should use existing Tauri dialog/fs patterns.
7. Use correct extension and MIME metadata from the registry.
8. Avoid writing empty/corrupt files when exporter returns an error.
9. Keep command handlers out of button-local logic.

Expected outcome:

- A user can choose an implemented format from a consistent export UI.
- Deferred wishlist items are visible enough for roadmap clarity but not presented as working.

Alternative result:

- If a full export dialog is too much for this slice, add only the specific new menu commands and leave the dialog for a later slice. Do not enable deferred formats.

## 13. Phase 6: chemistry export target resolution

Files likely touched:

```text
packages/export-engine/src/chemistry-target.ts
packages/export-engine/src/chemistry-target.test.ts
packages/export-engine/src/results.ts
packages/chem-core/src/index.ts only if helper exports are needed
```

Tasks:

1. Implement a pure target resolver that takes `ChemDraftDocument` and an export format.
2. Return one of:
   - molecule target
   - multi-molecule target
   - reaction target
   - error with warnings
3. Selection rules:
   - Selected molecule wins for molecule formats.
   - Multiple selected molecules are allowed only for multi-record formats such as SDF/RDF.
   - Selected reaction wins for reaction formats.
   - If no selection and exactly one molecule exists, allow molecule export.
   - If no selection and exactly one reaction object exists, allow reaction export.
   - Ambiguous page state returns `export.ambiguous_export_target`.
4. Add tests for:
   - one selected molecule
   - one page molecule
   - two page molecules with no selection
   - multi-selected molecules for SDF
   - selected reaction object
   - reaction arrow inference candidate
   - empty document

Expected outcome:

- All chemistry export paths start from a clear target decision.
- Ambiguous exports do not produce misleading files.

Alternative result:

- If current selection state cannot express needed molecule-part selections cleanly, support whole selected molecule objects first and document part-selection export as later work.

## 14. Phase 7: native V2000 Molfile / CTAB writer

Files likely touched:

```text
packages/export-engine/src/ctab-v2000.ts
packages/export-engine/src/ctab-v2000.test.ts
packages/export-engine/src/chemistry-export.ts
packages/fixtures if shared synthetic molecules are appropriate
```

Scope for first implementation:

```text
Atoms:
- element symbol
- x/y coordinates
- formal charge where represented on the atom
- isotope only if currently represented in chem-core; otherwise warn if encountered through compatibility metadata

Bonds:
- single
- double
- triple
- aromatic as V2000 aromatic bond type if accepted by tests, otherwise warn
- wedge/hash display where supported
```

Coordinate rules:

- Use ChemDraft atom coordinates, not rendered label positions.
- Preserve relative geometry.
- Convert y-axis consistently for molfile conventions.
- Use z = 0.
- Use a consistent scale. A reasonable first mapping is to derive scale from the existing native bond length so normal ChemDraft bonds export near standard chemical drawing lengths.
- Do not mutate the document during export.

V2000 limits and warnings:

```text
Atoms > 999 -> export.chemistry_v2000_limit
Bonds > 999 -> export.chemistry_v2000_limit
unknown bond order -> warning or error depending on severity
superatoms present -> warning unless encoded as supported alias/SGroup
R-groups present -> warning unless encoded as supported query/R-group notation
charge electron marks not associated to atoms -> warning
stereochemistry not representable -> warning
```

Tasks:

1. Implement `exportMoleculeToMolfileV2000(molecule, options)`.
2. Implement `exportDocumentToMolfileV2000(document, options)` using the target resolver.
3. Treat `connection-table` as an internal alias or descriptor for CTAB, not necessarily a separate user-facing file if it would duplicate Molfile.
4. Add tests that:
   - methane/ethane/simple chain exports.
   - double/triple bonds export.
   - formal charge exports.
   - wedge/hash warnings or codes are correct.
   - V2000 count line has valid counts.
   - output ends with `M  END`.
5. If clipboard-adapter already has a Molfile parser, round-trip generated MOL through that parser and compare atom/bond counts.

Expected outcome:

- `mol-v2000` works for simple native molecules and warns on unsupported features.
- `mol` can initially alias `mol-v2000` with a warning if auto V3000 selection is not implemented.

Alternative result:

- If native writer scope expands too much, keep first implementation to simple atoms/bonds and return errors for unsupported advanced features rather than approximating them.

## 15. Phase 8: SDF V2000

Files likely touched:

```text
packages/export-engine/src/sdf.ts
packages/export-engine/src/sdf.test.ts
packages/export-engine/src/chemistry-export.ts
```

Tasks:

1. Build SDF from one or more V2000 molfile records.
2. For a single selected molecule, write one record.
3. For multiple selected molecules, write one record per molecule.
4. Preserve simple metadata fields only if they already exist safely in `chem-core`; otherwise emit no data fields.
5. End every record with `$$$$`.
6. Add tests:
   - single molecule SDF.
   - multiple selected molecules.
   - warning propagation from underlying molfile writer.

Expected outcome:

- `sdf-v2000` exports selected molecule(s) as records.
- `sdf` initially aliases `sdf-v2000` unless V3000/auto is added later.

Alternative result:

- If multiple selection semantics are not ready, support one selected molecule first and return a clear error for multiple selected molecules.

## 16. Phase 9: RXN V2000

Files likely touched:

```text
packages/export-engine/src/rxn-v2000.ts
packages/export-engine/src/rxn-v2000.test.ts
packages/export-engine/src/chemistry-target.ts
packages/export-engine/src/chemistry-export.ts
```

Target resolution options:

1. Preferred: selected `ReactionObject`.
2. Next: exactly one reaction object on the page.
3. Later: inferred reaction from one forward reaction arrow and molecule positions.

Initial RXN writer:

- Use V2000 molfile blocks for reactants and products.
- Agents/reagents may be omitted or represented only if the format path is explicit and tested.
- Conditions text should not become molecules.
- Plus signs should not become molecules.
- Mechanism arrows should not become reaction arrows.

Tests:

- one reactant, one product.
- two reactants, one product.
- selected reaction object with known components.
- ambiguous reaction returns error.
- inferred reaction produces `export.reaction_inferred_components` warning if implemented.

Expected outcome:

- `rxn-v2000` works for explicit native reaction objects.
- `rxn` aliases `rxn-v2000` until V3000/auto is added.

Alternative result:

- If reaction objects are not created by the current drawing workflow yet, keep RXN export disabled or support only a synthetic fixture-backed reaction object in tests until the workflow exists.

## 17. Phase 10: CML

Files likely touched:

```text
packages/export-engine/src/cml.ts
packages/export-engine/src/cml.test.ts
```

Initial implementation options:

1. Write a small native CML serializer for simple molecule atoms/bonds.
2. Use an adapter-backed conversion only if it is already available through a controlled interface.

Recommended first implementation:

- Native minimal CML for simple molecules.
- XML escape locally.
- Include atoms and bonds with IDs, elements, formal charges where supported, and 2D coordinates if the target convention is selected.
- Warn for superatoms, R-groups, unsupported stereo, unknown bonds, reaction exports, and compatibility-only objects.

Tests:

- simple molecule CML.
- formal charge CML.
- XML escaping.
- unsupported features produce warnings.

Expected outcome:

- `cml` works for simple selected molecules and is honest about limitations.

Alternative result:

- If CML scope is larger than expected, leave it planned and rely on adapter-backed CML only after a real chemistry conversion adapter exists.

## 18. Phase 11: RDfile / RDF

Files likely touched later:

```text
packages/export-engine/src/rdf.ts
packages/export-engine/src/rdf.test.ts
```

Do not start here. RDfile/RDF should follow after Molfile, SDF, and RXN are stable because it builds on those records.

Expected later behavior:

- `rdf-v2000` writes reaction data records when explicit reaction objects exist.
- `rdf` aliases `rdf-v2000` until a V3000/auto path exists.
- Unsupported metadata returns warnings.

Alternative result:

- Leave RDfile/RDF as planned/deferred if user demand is low.

## 19. Phase 12: CDXML and CDX wiring

Files likely touched:

```text
packages/export-engine/src/cdxml.ts
packages/export-engine/src/index.ts
packages/cdx-compat/src/index.ts only if missing API surface is needed
apps/desktop/src/export/*.ts
```

Tasks:

1. Add `cdxml` descriptor as implemented when it is wired to the existing `exportDocumentToCdxml`.
2. Label as `ChemDraw XML (CDXML)` in UI.
3. Return text result with `.cdxml` extension and `chemical/x-cdxml` or verified equivalent MIME.
4. Preserve existing native-payload envelope behavior.
5. Keep binary CDX descriptor disabled unless a tested writer exists.
6. Label binary CDX as `ChemDraw (CDX)` or equivalent, not as a generic native format.
7. Add tests that export path delegates to `cdx-compat` and propagates warnings.

Expected outcome:

- CDXML is a first-class export option.
- CDX remains honest if not implemented.

Alternative result:

- If CDXML current export behavior is intended only as native save envelope, expose it carefully as compatibility export with warning text explaining supported subset.

## 20. Phase 13: optional chemistry engine conversion adapter

Do this only after native Molfile/SDF/RXN/CML basics exist or after a specific need is documented.

Files likely touched:

```text
packages/chemistry-adapter/src/index.ts
packages/rdkit-adapter/src/index.ts
packages/export-engine/src/chemistry-export.ts
apps/desktop/package.json if runtime dependency lives there
docs/architecture/dependency-inventory.md
```

Potential API extension:

```ts
export type ChemistryConversionFormat =
  | "smiles"
  | "molfile-v2000"
  | "molfile-v3000"
  | "rxnfile-v2000"
  | "rxnfile-v3000"
  | "sdf-v2000"
  | "sdf-v3000"
  | "cml";

export interface ChemistryConversionResult {
  output: ChemistryStructureInput;
  warnings: ChemistryWarning[];
}

export interface ChemistryConversionAdapter extends ChemistryAdapter {
  convertStructure?(
    input: ChemistryStructureInput,
    outputFormat: ChemistryConversionFormat
  ): Promise<ChemistryConversionResult>;
}
```

Rules:

- Do not replace native ChemDraft export with a black-box converter.
- Use engine conversion for validation and hard conversions only when source/target chemistry semantics are clear.
- Lazy-load heavy engines.
- Include dependency size and maintenance assessment.
- Keep adapter tests fixture-based and deterministic.

Expected outcome:

- Engine-backed conversion can improve CML, V3000, SMILES, InChI, or validation without spreading engine imports through the UI.

Alternative result:

- Keep RDKit/Indigo as future work if licensing is fine but packaging/maintenance/bundle size is not acceptable.

## 21. Phase 14: EPS

Files likely touched later:

```text
packages/export-engine/src/eps.ts
packages/export-engine/src/eps.test.ts
```

Rules:

- Do not use Ghostscript/pstoedit-style converters in core.
- Start from ChemDraft page render plan or normalized SVG fragments.
- Implement only primitives that ChemDraft emits.
- Use a proper EPS header and bounding box.
- Map common fonts conservatively.
- Escape PostScript strings.
- Return warnings for unsupported paths, fills, images, gradients, opacity, unknown fonts, and text styling not representable.

Expected outcome:

- Simple line/text/molecule pages export as EPS.
- Unsupported visual features are warning-bearing, not silently dropped.

Alternative result:

- Leave EPS as planned if current SVG primitives are not stable enough.

## 22. Phase 15: 3MF research and placeholder descriptors

Files likely touched:

```text
packages/export-engine/src/formats.ts
docs/file-formats/3mf-export-research.md
```

Tasks:

1. Keep `3mf-display` and `3mf-printing` descriptors disabled initially.
2. Add a research doc if user demand persists.
3. Decide whether ChemDraft actually has 3D geometry to export.
4. If implementing later, choose between:
   - custom ZIP/XML writer for a minimal 3MF package.
   - JSCAD 3MF serializer if the app has mesh objects.
   - lib3mf only if native validation/writing matters enough to justify heavier integration.
5. Do not export a 2D page as fake 3D manufacturing data without explicit product intent and warnings.

Expected outcome:

- The UI does not pretend 3MF is supported.
- Future 3MF work starts from a clear semantic requirement.

Alternative result:

- A later proof implementation may export a flat plate or embossed molecule only if it is clearly labeled as a 3D model export, not chemical interchange.

## 23. Phase 16: legacy format research

Create a research document before implementing any of these:

```text
ChemDraw Stationery
ChemDraw 3.x
TGF
ISIS/Sketch SKC
MSI ChemNote
SMD 4.2
```

Suggested file:

```text
docs/file-formats/legacy-export-research.md
```

Research doc structure:

```text
Format:
Known extension(s):
Known vendor/origin:
Public specification available:
Permissive dependency found:
License concerns:
Read support feasibility:
Write support feasibility:
Clean-room fixture strategy:
ChemDraft model requirements:
Recommended status:
```

Rules:

- Do not use proprietary files as committed fixtures.
- Do not implement write support from reverse-engineered proprietary examples without a clean-room plan.
- Prefer import/read research before write/export for migration formats.
- Keep registry descriptors disabled until there is a tested writer.

Expected outcome:

- Long-tail wishlist items are tracked honestly without risking the core app.

Alternative result:

- If a permissive, well-maintained dependency is found later, add it only behind a compatibility package and update dependency inventory.

## 24. Desktop command and menu plan

Current command/menu shape should move toward:

```text
File
  Export...
  Export As
    SVG
    PDF
    PNG
    JPEG
    CDXML
```

Avoid adding every wishlist item directly to the top-level File menu.

Command IDs:

```text
export.openDialog
export.svg
export.pdf
export.png
export.jpeg
export.bmp
export.gif
export.tiff
export.cdxml
export.mol
export.sdf
export.rxn
export.cml
```

Only implemented commands should be enabled.

If a command exists for a planned/deferred format, it must return a structured unavailable result rather than writing an empty file.

## 25. File writing behavior

Implement a shared file export helper in the desktop app.

Suggested behavior:

1. Resolve descriptor by format ID.
2. Call exporter.
3. If exporter returns errors, do not write file.
4. If exporter returns warnings but no errors, write file and show warning summary.
5. Use save dialog default extension from descriptor.
6. Preserve user filename.
7. Ensure text exports use UTF-8.
8. Ensure binary exports write bytes exactly.
9. Show status message after successful export.
10. Keep warnings accessible enough for the user to know when chemistry or graphics were approximated.

## 26. Testing plan

Minimum tests by package:

```text
packages/export-engine
- registry descriptor tests
- SVG serializer tests
- PDF smoke tests if implemented in this package
- CTAB/Molfile tests
- SDF tests
- RXN tests
- CML tests
- target resolver tests
- warning behavior tests

apps/desktop
- export command handler tests where existing test patterns allow
- mocked Tauri save path tests
- PDF/raster wrapper tests where feasible

apps/desktop/src-tauri
- raster command unit tests
- format magic-byte tests
- dimension-limit tests
```

Synthetic fixtures:

```text
simple methane
ethane
ethanol-like chain
charged ammonium-like atom
double bond
triple bond
wedge/dash if model supports it
two separate molecules
simple reaction object
simple text object with XML-sensitive characters
page with margin and line objects
```

Run at relevant points:

```bash
pnpm lint
pnpm test
pnpm build
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

If the repository does not currently support a cargo command in that form, use the nearest equivalent Tauri/Rust command and record it in the final implementation notes.

## 27. Documentation updates

Update these when relevant:

```text
docs/architecture/dependency-inventory.md
README.md if user-facing export formats change
PLAN.md if roadmap status changes
docs/file-formats/* for new format-specific research
AGENTS.md build stamp after code changes
apps/desktop/src/MainWindow.tsx build string after code changes
```

Dependency inventory rows should include:

```text
Package/crate
Purpose
License
Core or optional
Distribution impact
```

## 28. Implementation order summary

Recommended order:

```text
1. Registry and result contracts.
2. SVG hardening.
3. PDF export from SVG.
4. Rust raster pipeline for PNG/JPEG/BMP, then GIF/TIFF if quality is acceptable.
5. Export UI/file writing cleanup.
6. Chemistry target resolver.
7. Native Molfile V2000 / CTAB.
8. SDF V2000.
9. RXN V2000.
10. CML.
11. CDXML UI wiring through cdx-compat.
12. RDfile research/implementation if still needed.
13. EPS if demanded.
14. 3MF research if demanded.
15. Legacy format research docs.
```

Do not start with long-tail legacy formats. They create the most legal and correctness risk and provide the least immediate value.

## 29. Expected first working export set

The first useful export build should aim to enable:

```text
SVG
PDF
PNG
JPEG
BMP
CDXML
MOL V2000
SDF V2000
```

The next export build should add, if tests support them:

```text
GIF
TIFF
RXN V2000
CML
```

Everything else should remain visible as planned/deferred metadata until a clean implementation path exists.

## 30. Final implementation report template

When Codex completes a slice, it should report:

```text
Summary:
Files changed:
Dependencies added:
Dependency inventory updated:
Export formats implemented:
Export formats left planned/deferred:
Warnings added:
Tests added:
Commands run:
Known limitations:
Follow-up tasks:
Build stamp updated:
```

## 31. Safety checklist before enabling any export format

Before a format is marked implemented:

```text
The format has a registry descriptor.
The format has a real exporter function.
The exporter returns structured warnings.
The exporter has synthetic fixture tests.
The desktop command cannot write empty files on errors.
The UI does not present unsupported features as working.
Chemical formats have target-resolution tests.
Chemical formats do not silently drop charges/stereo/isotopes/radicals/superatoms/R-groups.
Graphics formats preserve active page geometry.
Dependency inventory is updated if dependencies were added.
AGENTS.md and MainWindow build strings are updated if code changed.
```
