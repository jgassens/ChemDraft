# @chemdraft/cdx-compat

Owns CDXML/CDX import, export, intermediate models, unknown-object preservation, and compatibility warnings.

This package must not become the native document model and must not depend on GPL or AGPL code without an explicit project decision.

`importCdx(bytes)` decodes binary CDX into CDXML and calls `openChemDraftPayload`, returning the same
document, warnings, source and optional native-payload conflict. Pass a `Uint8Array`, including for
clipboard data; decoding binary CDX as text first corrupts it. Malformed files return a
`cdx.invalid_binary` warning with the property/object and reason when available.

`exportDocumentToCdx(document, { embedNativePayload: false })` returns `{ bytes, warnings }`, using
`exportDocumentToCdxml` for the visible document. Unsupported CDXML attributes, elements or values
produce compatibility warnings. Export defaults to omitting native metadata.

Save As uses `{ embedNativePayload: true }`. User-defined property `0x4344` contains a namespaced
`org.chemdraft/cdx-envelope.v1` envelope with the existing CDXML payload tags. Its visible hash covers
the actual binary-normalized CDXML, and a second hash covers every raw file byte except the envelope
property itself, including both legacy and UTF-8 text copies. Unchanged files restore the exact native
document; external edits to either copy use the existing conflict path. Older envelopes without the
binary hash also require conflict review. This property is ChemDraft-specific; other readers
can consume the standard visible objects without interpreting it.

The binary codec accepts either byte order, fixed-point coordinates and legacy/UTF-8 text copies.
Limits are 64 MB, 64 nested child-object levels, one million objects and one million properties.
Diagnostics retain at most 1000 warnings plus one summary counting omitted warnings. A malformed typed
property is skipped with a warning; unsupported binary properties retain their raw bytes where possible.
Point3D bytes follow the public specification's z/y/x order. Legacy text uses the declared font charset;
zero-style strings use ISO Latin-1. Unrepresentable characters produce specific encoding warnings.
Compatibility remains fixture-driven, with the same visible-subset limits as CDXML. Doublet and
triplet atom radicals round-trip; electron states the native model cannot express are refused with
a warning rather than converted to a different radical.
