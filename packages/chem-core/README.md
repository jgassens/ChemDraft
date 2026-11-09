# @chemdraft/chem-core

Owns the native document model, schema versions, migrations, validation, serialization, patch application, and native style presets (including `DocumentStylePreset`).

This package must not import UI, Tauri, Ketcher, RDKit, plugin loading, or filesystem APIs.

Bond displays are `bold`, `wedge`, `hashed`, `dashed`, and `wavy`. Optional
`MoleculeBond.display.bondStyle: "wavy"` is valid only with `order: "single"` (schema rejection
otherwise) and means explicitly unknown stereo at `fromAtomId`. It follows additive v1 conventions:
no migration or backfill. MOL V2000 writes single-bond stereo 4; V3000 writes CFG=2.

Native `reaction` objects reference participants through `components` (`reactant`, `product`,
`agent`) and text through `conditionsTextObjectIds`. Optional `arrowObjectIds` and `plusObjectIds`
link the step's existing drawable objects. Multiple steps may reference the same molecule, including
an intermediate used as one step's product and the next step's reactant. These additive optional
fields follow the existing v1 convention; older reaction documents load without a migration.

Pictures are `graphicKind: "image"` graphics with an embedded `data.image` payload (PNG or SVG,
base64, positive integer pixel dimensions, optional pixels-per-meter density). The decoded payload
limit is `MAX_IMAGE_OBJECT_BYTES` (25 MiB). Their frame uses the same top-level `x`, `y`, `width`,
`height`, and `rotation` as rectangle graphics; the payload is preserved by native serialization.
This optional field follows existing additive v1 conventions and needs no document migration.

`createImageGraphicObject` centers the frame at the requested point, reads missing PNG metadata
through `readPngInfo`, and converts physical sizes at 96 page units per inch, independently of
molecule bond lengths and drawing styles. Without density, each image pixel is one page unit
(a CSS pixel, 96 dpi on every platform). `readSvgInfo` reads root dimensions
or the viewBox, keeps absolute SVG units at their stated physical size, and defaults to 300 × 150.
Its `physicalSize` keeps fractional page dimensions separate from integer pixel metadata, so small
SVGs retain their original aspect ratio when pasted.
These metadata readers do not decode pixels or sanitize SVG; import/render boundaries handle those.
Native document loading enforces the same PNG chunk structure and pixel limits as picture creation;
SVG loading checks only base64 validity and the payload byte cap. SVG completeness and pixel limits
are checked at paste time, including namespace-prefixed SVG roots. PNG allocation padding after IEND is accepted. Legacy imageHref-only
and picture-less image graphics remain loadable.

The MOL writers require an explicit `kekuleBondOrders` map and return `{ contents, warnings }`.
Callers resolve orders through layout-engine; this package cannot depend on it. An empty or partial
map preserves unmapped aromatic bonds as type 4 and returns one warning per ring system, naming its
atoms. Every consumer must surface those warnings through its operation's warning path.

Unknown bond orders write as CTfile type 8 (any) in both formats, with one warning naming all
affected bond ids. This preserves the native unknown order on reimport, but readers treat it as a
query bond with no chemical order. Chemistry and 3D engine callers pass `unknownBondOrders: "refuse"`; this
throws the exported `UnknownBondOrderError` with `bondIds` before any output or warnings are emitted.
