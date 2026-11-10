# @chemdraft/chem-core

Owns the native document model, schema versions, migrations, validation, serialization, patch application, and native style presets (including `DocumentStylePreset`).

This package must not import UI, Tauri, Ketcher, RDKit, plugin loading, or filesystem APIs.

## Native drawing presets

All four presets use Arial, Helvetica, sans-serif labels at regular weight 400. Physical point
values use **22 native units per 14.4 pt**, independently of image pixel density.

| Name | ID | Bond length | Line / bold width | Double-bond gap | Hash spacing | Label margin | Label size | Source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ChemDraft Synthetic | `chemdraft.synthetic` | 22 units | 2 / 4.8 units | 4.8 units (absolute) | 9 units | 6 units | 15 units | Original native hand-drawing defaults in `src/styles.ts` |
| Document style | `chemdraft.document` | 14.4 pt (22 units) | 1.134 / 2.268 pt | 18% of bond length | 2.5 pt | 1.6 pt | 10 pt | Native fixed physical-document contract in `src/styles.ts` and layout-engine's `documentStyle.ts` |
| ACS 1996-style | `chemdraft.acs1996` | 14.4 pt (0.2 in; 22 units) | 0.6 / 2.0 pt | 18% of bond length | 2.5 pt | 1.6 pt | 10 pt | [ACS Chemical Reviews author guidelines](https://researcher-resources.acs.org/publish/author_guidelines?coden=chreay), ACS journals' published structure-drawing settings |
| RSC journal-style | `chemdraft.rscjournal` | 12.2 pt | 0.5 / 1.6 pt | 20% of bond length | 1.8 pt | 1.6 pt (Document style fallback) | 7 pt | [RSC Advances author guidelines](https://www.rsc.org/publishing/publish-with-us/publish-a-journal-article/rsc-advances), Chemical structures; values also published for Analytical Methods |

For the two publisher-based presets, values transcribed from the publisher's public author
guidelines; not an endorsement or compliance certificate. Unspecified settings retain Document
style values; RSC does not specify a margin in the values transcribed by PR #191.
The public sources and units are recorded beside each preset in `src/styles.ts`.

`NativeStylePresets` is the shared list. `applyNativeStylePreset` in document-workflow-core plans
one atomic edit of selected molecules/text, or the whole document plus insertion defaults.
Molecule coordinates scale uniformly about each molecule's centre; chemical identity and object
IDs remain unchanged. `setDrawingDefaults` is the typed patch for document drawing/text defaults.

Native files use feature-based minimum app versions. `readSerializedDocument(contents)` and
`readDocument(candidate)` return `{ document, warnings, formatVersion, minAppVersion }`; use these
when the host needs to present compatibility warnings. `deserializeDocument` remains the
document-only convenience API. Legacy visual classifiers degrade with named warnings in every file,
including unversioned files, and preserve their original values for re-save. Main's legacy chemistry
classifiers (bond order, structure/expansion encoding, reaction mapping, mechanism-arrow kind and
electron-mark kind) likewise open as `unknown`, with `NATIVE_CHEMISTRY_ENUM_FALLBACK` naming the
original value/path; saves restore the original string. Newer files also
preserve unknown visual JSON fields. Unknown fields on chemistry objects require an explicit matching
`ignorableFields` header pattern; unlisted chemistry fields, other unknown chemistry values and malformed
known input fail. Known chemistry fields cannot be declared ignorable.
`serializeDocument` reconstructs preserved data and omits the new top-level version fields for
documents using only 1.1.1 features, so the released strict reader still accepts plain files.
`parseDocument`, validation and patches remain strict. Feature additions must update
`NativeDocumentFeatureVersions` in `documentFeatures.ts`; the frozen-schema inventory test guards
missing field/enum entries and their required `ignorable` safety declarations. The writer derives
`ignorableFields` from used display-only field entries and retained future fields; all version and
ignorable headers are omitted for plain 1.1.1 documents. See
[the native compatibility contract](../../docs/architecture/native-document-compatibility.md).

Preservation follows unique IDs. Identity-free arrays restore only while their known content is
unchanged. Edits drop their future data with logged `NATIVE_EXTENSION_DATA_DROPPED` warnings;
`serializeDocumentWithWarnings` returns `{ contents, warnings }`, and the validated container API
`prepareNativeDocumentForSerializationWithWarnings` returns `{ value, warnings }`.

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

Native conditions labels carry an optional strict conditions-only attachment:
{ kind: "conditions", parentObjectId, side: "above" | "below", frame: { origin, tangent, normal,
length? }, offset, placement?: "auto" | "manual" }. Frame axes are perpendicular unit vectors;
offset is the label centre in that frame. Native serialization retains the attachment without
a schema-version migration.

Wavy art paths optionally store `waveSmoothness` (0–100%), `waveHeight` (peak-to-trough, 0–48 px)
and `waveWidth` (wavelength, 4–120 px). Omitted settings preserve legacy rendering until edited.
