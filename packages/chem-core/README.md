# @chemdraft/chem-core

Owns the native document model, schema versions, migrations, validation, serialization, patch application, and native style presets (including `DocumentStylePreset`).

This package must not import UI, Tauri, Ketcher, RDKit, plugin loading, or filesystem APIs.

Pictures are `graphicKind: "image"` graphics with an embedded `data.image` payload (PNG or SVG,
base64, positive integer pixel dimensions, optional pixels-per-meter density). The decoded payload
limit is `MAX_IMAGE_OBJECT_BYTES` (25 MiB). Their frame uses the same top-level `x`, `y`, `width`,
`height`, and `rotation` as rectangle graphics; the payload is preserved by native serialization.
This optional field follows existing additive v1 conventions and needs no document migration.

`createImageGraphicObject` centers the frame at the requested point, reads missing PNG metadata
through `readPngInfo`, and converts physical points with `DOCUMENT_STYLE_UNITS_PER_PT`. Without
density, each image pixel is one point (72 dpi on every platform). `readSvgInfo` reads root dimensions
or the viewBox, keeps absolute SVG units at their stated physical size, and defaults to 300 × 150.
These metadata readers do not decode pixels or sanitize SVG; import/render boundaries handle those.

The MOL writers require an explicit `kekuleBondOrders` map and return `{ contents, warnings }`.
Callers resolve orders through layout-engine; this package cannot depend on it. An empty or partial
map preserves unmapped aromatic bonds as type 4 and returns one warning per ring system, naming its
atoms. Every consumer must surface those warnings through its operation's warning path.

Unknown bond orders write as CTfile type 8 (any) in both formats, with one warning naming all
affected bond ids. This preserves the native unknown order on reimport, but readers treat it as a
query bond with no chemical order. Chemistry and 3D engine callers pass `unknownBondOrders: "refuse"`; this
throws the exported `UnknownBondOrderError` with `bondIds` before any output or warnings are emitted.
