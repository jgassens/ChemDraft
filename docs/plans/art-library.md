# ChemDraft 2.0: Library window with drag-and-drop art

## Context

ChemDraft 1.2.3 can take a dropped SVG file and place it as a picture, and it has a small
structure-template picker (36 templates, Insert > Templates…, click to insert). There is no
art collection, no drag from a panel, no user-added items, and a placed SVG cannot be taken
apart.

For 2.0 the owner supplied `ChemDraft-BioArt-Refined-Expansion-v3.1.zip` (159 subjects, each in
two styles, 318 SVGs, 3.5 MB) and wants it as a feature: an extended templates panel that is
organized, searchable, drag-and-droppable, and easy to add new SVGs to.

Owner decisions (2026-11-25):

- The art is the owner's own and ships freely, bundled in every installer.
- One **Library** window replaces the template picker: structures and art together, one search.
- Each subject is one entry; a style switch picks the variant.
- New art comes in three ways: drop files on the panel, shareable pack files, watched folders.
- Tiles drag as real files, so they also drop into Finder, PowerPoint, and other apps.
- A placed SVG can be converted into editable ChemDraft shapes in this same slice.

## What exists and is reused

| Need | Existing code |
|---|---|
| Floating, remembered, modeless window | Dialog host: `apps/desktop/src/dialogs/DialogCoordinator.ts`, `DialogWindow.tsx`, `dialogProtocol.ts`, `src-tauri/src/dialog_windows.rs`; "Adding a later kind" in `docs/architecture/native-dialog-host.md` |
| Picker UI (search box, sections, grid, keyboard, lazy thumbnails) | `dialogs/StructureTemplatePicker.tsx`, `structureTemplatePickerModel.ts`, `structureTemplateThumbnail.ts` |
| Search normalizing (NFKC, Greek letters, punctuation) | `normalizeStructureTemplateName` in `packages/document-workflow-core/src/structureTemplates.ts` |
| File → sanitized picture → placed, one undo entry | `imageDrop/prepareDroppedImage.ts`, `insertDroppedImages.ts`, `dropHandler.ts`; `createImageGraphicObject` in `packages/chem-core/src/image.ts` |
| SVG sanitizer, usable from Node with jsdom | `sanitizeSvgPicture` in `packages/export-engine/src/svgSafety/svgSanitizer.ts` |
| Drop onto the document window | `tauri://drag-drop` listener, `MainWindow.tsx` ~11341; `imageDrop/dropPosition.ts` |
| Click-insert placement clear of floating windows | `insertTemplateToTab`, `placeInsertedObjectsInFreeSpace`, `commitInsertionToTabWithPageFit` |
| Native shapes that can hold converted art | `graphicKind` `path` (`data.pathD`), `rect`, `ellipse`, `line`; linear and radial gradient fills (`chem-core/src/schemas.ts` ~102–136) |
| Fail-closed package install (checksums, path-traversal guards in TS and Rust) | `installed_plugins.rs`, plugin install gates |
| Bundled data with its own notice | `data/names/` + `NOTICE` "Data under separate terms" + `docs/architecture/dependency-inventory.md` |
| Generated data with a `--check` mode | `tools/template-layouts/build.mjs` (`pnpm templates:layouts`) |

## Design

### 1. Data: packs

A **pack** is a folder: `pack.json` plus `art/**/*.svg`.

- `pack.json`: `id`, `name`, `version`, `license` (required), `attribution`, and `items[]`. Each
  item has `id`, `name`, `description`, `category`, `subcategory`, `keywords[]`,
  `variants { <variantId>: { file, sha256, width, height } }`, and `convertible` (see §5).
- New package **`packages/art-library`** (pure, no UI, no Tauri): Zod schema for `pack.json`,
  the merged catalog type, category tree, search, variant naming (`name--variant.svg`), and pack
  validation limits. Structure templates are adapted into the same catalog shape as a built-in
  "Structures" collection; `template-library` itself is unchanged.
- **Built-in BioArt pack** at `data/art/bioart/`. A Node script `tools/art-pack/build.mjs`
  (`pnpm art:pack`, with `--check` for CI) converts the supplied `manifest.json` into `pack.json`,
  runs every SVG through `sanitizeSvgPicture`, and records hashes. Only `assets/` is taken from
  the zip; previews, QC sources, HTML viewers and Python scripts stay out of the repo.
- It ships as a Tauri resource (`resources/art/`), because an operating-system file drag needs
  real files on disk. The web build serves the same folder as static assets.
- `NOTICE` gets a "Data under separate terms" entry and `dependency-inventory.md` a row for the
  artwork under the art licence the owner picks (it is separate from the Apache-2.0 code).
- The second set in Downloads (`ChemDraft-Lymphatic-System-Vector`) is **not** bundled. It is the
  owner's example of what a user drops on the panel, and the acceptance case for §4.

**User data** lives under `$APPDATA/art-library/` (dev and stable builds already have separate
app-data folders):

- `user/`: files dropped on the panel, stored sanitized, with an index (`library.json`).
- `packs/<packId>/`: imported packs.
- `settings.json`: watched-folder paths, chosen style, last category.

### 2. The Library window

- New dialog-host kind `library` (modeless, floats, remembers its place), opened by a new command
  `library.open` (Insert > Library…, and in the Customize gallery). `template.insertDialog` is
  retired and the menu item renamed; `template.insert.<id>` commands stay.
- The 64-ID snapshot allowlist cannot carry a catalog this size or user items. The window loads
  the catalog itself through new Rust commands (`art_library_catalog`, `art_library_read_item`)
  in a new `src-tauri/src/art_library.rs`. The main window still validates every insert request
  against the catalog before acting.
- Layout: category sidebar (Structures, the BioArt categories, My Art, each imported pack, each
  watched folder), a search box, a style switch, and a thumbnail grid with names.
- Search: every typed word must match, across name, keywords, description and category path.
  Ranking: name starts-with, then name contains, then keywords, then description. Greek letters
  and punctuation are normalized with the existing normalizer.
- Thumbnails load lazily per visible tile as sanitized-SVG data URLs, cached.
- Insert without dragging: click, or Enter on a focused tile, places the item at the centre of
  the view and nudges it clear of floating windows, as templates do today.
- Art insert commands are value-encoded (`art.insert.<pack>.<item>.<variant>`) and registered
  when the catalog loads, so no generic command with hidden parameters.

### 3. Drag and drop

- A tile drag starts a real operating-system file drag (the `drag` crate / `tauri-plugin-drag`,
  MIT/Apache; new dependency, recorded in the inventory). The dragged file is the item's SVG.
- Dropped on a ChemDraft document, it arrives through the existing `tauri://drag-drop` path and
  the existing sanitize-and-place code. The drop handler recognizes a library path and labels the
  undo entry with the item's name ("Insert Antibody").
- Dropped on Finder, Explorer or another app, it is an ordinary SVG file.
- Structure tiles are not files: for them the drag uses a small `.chemdraft` fragment so the same
  drop path inserts a real molecule. If that proves awkward they stay click-to-insert.
- **This is the one unproven part.** The first task is a spike that proves a drag started in one
  of our windows fires `tauri://drag-drop` in the document window on both macOS and Windows. If it
  fails on either, the fallback is an in-app drag that tracks the pointer between our windows
  (the `chemdraft://palette-pointer` polling is the building block), and drag-out to other apps is
  dropped on that platform.

### 4. Adding art

**Drop on the panel: one path for files, folders and zips.** The owner's example
(`ChemDraft-Lymphatic-System-Vector`, dropped as a folder or as a zip) sets the bar. That folder
holds 71 SVGs, but only the 20 in `assets/` are the art: 10 subjects in two styles. The rest are
review copies under `evidence/` and `proofs/`, one full plate, 166 PNGs and 99 JSON files, and its
`manifest.json` has a different shape from BioArt's. The import must get this right without the
user sorting anything.

- The Library window accepts any mix of SVG files, folders and `.zip` files, by drop or through
  an "Add Art…" button. A zip is unpacked by Rust into a staging folder under app data with
  zip-slip, size and count guards; only `.svg` and manifest `.json` files are ever read, and
  nothing is executed.
- **Working out what the art is**, in this order:
  1. Our own `pack.json` if present: used exactly.
  2. Otherwise any JSON manifest that lists SVG paths with names. A tolerant reader takes names,
     descriptions, categories and style labels from it. Both supplied shapes are covered
     (`subjects[].variants{}` and `assets[].path` + `display_name` + `style`), and unknown shapes
     fall through to step 3 instead of failing.
  3. Otherwise the files themselves: names from file names ("lymph-node" → "Lymph node"),
     categories from subfolders, exact duplicates removed by content hash.
- Files named `x--<variant>.svg` pair up as one entry with variants, so the lymphatic set arrives
  as 10 entries that follow the style switch, not 20.
- **One review step, then one click.** A sheet in the Library window shows thumbnails of what was
  found, with the collection name prefilled (manifest title, else folder name), and one line
  saying what was left out and why ("51 other SVGs not added: review copies and proofs", with a
  "Show" link to tick any of them, such as the full plate). The primary button reads
  "Add 10 Items". Names and categories can be edited in place before or after adding.
- Each SVG is sanitized and validated in TypeScript, then written to `user/` by Rust (which
  re-checks name, size and path). A progress bar covers large sets and the window stays usable.
- Afterwards the new collection is selected in the sidebar with its items in view. "Remove
  Collection" undoes the whole import.
- Dropping the same set again adds nothing and says so; changed files are offered as an update.
- A file that fails names itself and the reason ("spleen.svg: not added, the file is not valid
  SVG"); the rest still import.
- A licence is not demanded on import (the entry shows "No licence stated"); it is required when
  a collection is exported as a pack.
- **Watched folders.** "Add Folder…" stores a path. Subfolders become categories. The folder is
  rescanned when the Library window gains focus and by a Refresh button (no file-watcher
  dependency). Files are sanitized when thumbnailed and again when inserted; originals are never
  modified.
- **Pack files.** Any collection exports as a zip (`.chemdraftart`) containing `pack.json` and the
  SVGs, with `license` required at export. It imports through the same drop path above (step 1),
  with the same guards: size and count limits, path-traversal checks in TypeScript and Rust, SVG
  only, every file sanitized. A pack carries no code.
  The extension is not registered with the operating system (Windows keeps `.chemdraft` only).
- User items can be renamed, recategorized and removed from the panel. Built-in items cannot.

### 5. Convert to Shapes

- New command `picture.convertToShapes` on a selected SVG picture. It replaces the picture with a
  group of native shapes in the same place and size, as one undo entry, left selected.
- Converter: a new pure module `packages/art-engine/src/svgImport/` (DOM parser injected, as the
  sanitizer does). It runs on the already-sanitized SVG.
- Mapping, measured against the BioArt set (about 33,000 elements):
  - `path`, `ellipse`, `circle`, `rect`, `line` → native shapes, transforms baked in.
  - `g` → native groups; `data-component` and `title` become group names.
  - `use` → resolved to a copy. Fill, stroke, width, opacity, caps, joins, fill rule carried over.
  - `linearGradient`, `radialGradient` → native gradient fills.
  - `text` (64 uses) → native text objects.
  - `clipPath` (29 uses) → geometric clip through the existing boolean ops where the clip is a
    simple shape; otherwise reported.
  - `pattern` (4 uses), masks, filters, embedded bitmaps → cannot be kept.
- Anything that cannot be kept is never dropped silently. The command lists what would change
  and asks Convert Anyway or Cancel. A picture that converts exactly asks nothing.
- `tools/art-pack/build.mjs` runs the converter on every built-in item and writes
  `convertible: exact | approximate` into `pack.json`; a render-comparison test (picture versus
  converted shapes, within a pixel tolerance) guards the exact ones.
- Canvas, SVG/PDF export and the CLI already draw native shapes, so converted art needs no new
  rendering. A size guard refuses conversion beyond a set object count (one BioArt file is
  636 KB) with a specific message.

### 6. Agents and documents

- `insertDroppedImages` / `placeDroppedImages` move into `document-workflow-core` so the app, CLI
  and MCP share one picture-insert function (§5 rule: one implementation).
- CLI `chemdraft art list|search`, an art reference in document jobs, the matching MCP tool, the
  README entries and the `skills/chemdraft` entry ship as the last phase.
- The picture object gains one optional field, `data.image.source { name, pack?, item?, license?,
  attribution? }`, registered in the document feature registry. It needs no migration and lets a
  document say where its art came from.
- The plugin API is not changed in this slice (`PluginApiVersion` stays `0.1.27`).

### Out of scope, stated so nobody assumes otherwise

- Recolor controls for art still placed as a picture (after conversion, shapes recolor normally).
- Sharing one copy of an SVG between repeated instances in a document; each instance still
  embeds its own source. Typical items are about 10 KB, so this waits.
- Vector SVG pictures in PDF export (pictures are rasterized at 300 dpi today; converted shapes
  are vector).
- CDXML still does not write pictures (existing warning); converted shapes export as far as
  CDXML supports them.
- Plugins contributing packs.

## Phases

Work is on `feat/2.0-art-library`, branched from `release/1.2.3` (which holds the picture code and merges to `main` at release), one pull request per phase, and the
slice is entered in `docs/plans/PLANS.md` first. Each phase is reviewed before it lands.

| # | Phase | Main paths |
|---|---|---|
| 0 | Drag spike on macOS and Windows; pick the drag path | `src-tauri/src/art_library.rs`, a throwaway test window |
| 1 | `art-library` package, pack schema, search, `tools/art-pack`, BioArt pack, NOTICE and inventory | `packages/art-library/**`, `tools/art-pack/**`, `data/art/**` |
| 2 | Library window: dialog kind, Rust catalog commands, grid, search, style switch, click-insert, retire old picker | `apps/desktop/src/dialogs/**`, `dialog_windows.rs`, `art_library.rs`, `commands.ts`, `appMenu.ts` |
| 3 | Drag out of tiles; library-aware drop labels | `art_library.rs`, `imageDrop/**` |
| 4 | Adding art: panel drop, watched folders, pack import/export | `art_library.rs`, `packages/art-library/**`, Library window |
| 5 | Convert to Shapes | `packages/art-engine/src/svgImport/**`, `documentWorkflow`, command wiring |
| 6 | Shared insert in `document-workflow-core`, CLI, MCP, skill | `packages/document-workflow-core/**`, `packages/chemdraft-cli/**`, `packages/chemdraft-mcp/**`, `skills/chemdraft/**` |
| 7 | Closeout: build stamp, stress checklist additions, architecture doc, `docs/shipped` | docs, `MainWindow.tsx` stamp |

Phases 1 and 5 do not depend on the window and can run beside phase 2. Phases 3 and 4 follow 2.

## Verification

- **Unit tests** with each phase: pack schema and limits; search ranking and normalizing;
  category tree; variant pairing; an import fixture laid out like the lymphatic folder (art in
  `assets/`, duplicate review copies, a foreign manifest, PNG and JSON noise), as a folder and as
  a zip, that must yield exactly the paired entries; pack import refusals (traversal, non-SVG, oversize, missing
  licence, unsafe SVG); Rust path guards; watched-folder scan; converter mapping per element
  type, the "cannot be kept" report, and exact-render comparison; the dialog protocol in both
  TypeScript and Rust; platform branches tested from one host by passing the platform in.
- **`pnpm art:pack --check`** in CI on all three hosts, proving the committed pack matches its
  sources and every SVG is already sanitized.
- **The gauntlet** (AGENTS.md §14): `pnpm lint`, `pnpm vitest run`, `pnpm build`,
  `git diff --check`, `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`, plus the
  DOM, agent-bridge and drawing-tool suites because this touches pointer and drop handling, and
  `pnpm smoke:windows-menu-churn` because it adds a window and a menu item.
- **Hands-on, on macOS and Windows both** (`./run-app`, and the CI-built Windows installer):
  open Library; search "antibody", "CD28", "β"; switch style; click-insert; drag a tile to the
  canvas at a chosen point; drag a tile to the desktop and into a slide; drop three SVGs on the
  panel and find them under My Art after a restart; drop the real
  `ChemDraft-Lymphatic-System-Vector` folder, then its zip, and get 10 two-style entries in one
  click with the second drop reporting nothing new; add a watched folder, add a file to it,
  refresh; export a pack and import it on the other platform; Convert to Shapes on an exact item
  and on one that reports losses; undo and redo each step; save, reopen, export SVG and PDF.
  These steps are added to `docs/manual-stress-checklist.md`.
- Any platform not run is reported as unverified, with what remains to check there.
