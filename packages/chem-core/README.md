# @chemdraft/chem-core

Owns the native document model, schema versions, migrations, validation, serialization, patch application, and native style presets (including `DocumentStylePreset`).

Scheme-created NaOH label atoms carry optional `schemeAbbreviation: "NaOH"` chemistry metadata
(requires 1.2 support; never ignorable). Typed labels do not set it and retain their earlier meaning.

This package must not import UI, Tauri, Ketcher, RDKit, plugin loading, or filesystem APIs.

## Native drawing presets

The four presets other than Sketch use Arial, Helvetica, sans-serif labels at regular weight 400.
Sketch uses `'Patrick Hand', Arial, Helvetica, sans-serif` labels and the sketch effect at roughness 1.25. Physical point
values use **22 native units per 14.4 pt**, independently of image pixel density.

| Name | ID | Bond length | Line / bold width | Double-bond gap | Hash spacing | Label margin | Label size | Source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ChemDraft Synthetic | `chemdraft.synthetic` | 22 units | 2 / 4.8 units | 4.8 units (absolute) | 9 units | 6 units | 15 units | Original native hand-drawing defaults in `src/styles.ts` |
| Document style | `chemdraft.document` | 14.4 pt (22 units) | 1.134 / 2.268 pt | 18% of bond length | 2.5 pt | 1.6 pt | 10 pt | Native fixed physical-document contract in `src/styles.ts` and layout-engine's `documentStyle.ts` |
| ACS 1996-style | `chemdraft.acs1996` | 14.4 pt (0.2 in; 22 units) | 0.6 / 2.0 pt | 18% of bond length | 2.5 pt | 1.6 pt | 10 pt | [ACS Chemical Reviews author guidelines](https://researcher-resources.acs.org/publish/author_guidelines?coden=chreay), ACS journals' published structure-drawing settings |
| RSC journal-style | `chemdraft.rscjournal` | 12.2 pt | 0.5 / 1.6 pt | 20% of bond length | 1.8 pt | 1.6 pt (Document style fallback) | 7 pt | [RSC Advances author guidelines](https://www.rsc.org/publishing/publish-with-us/publish-a-journal-article/rsc-advances), Chemical structures; values also published for Analytical Methods |
| Sketch | `chemdraft.sketch` | 22 units | 2 / 4.8 units | 4.8 units (absolute) | 9 units | 6 units | 15 units | Original native hand-drawing defaults with Patrick Hand labels and sketch effect (roughness 1.25) in `src/styles.ts` |

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

`DocumentPage` optionally carries `compatibility` using the same metadata schema as document objects.
CDXML/CDX import uses it to retain source page and print settings, including page counts that have
no native layout field. Native `width`/`height`, `margin`, and `layout` continue to describe one
physical paper size in CSS pixels; separate entries in `pages` are separate logical pages. The
optional metadata is additive to v1 and needs no migration or backfill.

`MoleculeObject.superatoms` retains an abbreviation's `label`, `attachmentPoints` and optional
`expandedStructure`/`expandedStructureFormat`. Additive optional `atomIds` identifies the expanded
atoms already present in that molecule's live graph. Those atoms and bonds remain authoritative
for chemistry; the superatom is grouping metadata and never an additional atom or formula term.
Attachment anchors refer to the group's real atom in the owning molecule. The stored expansion
is a snapshot of the isolated body; external valence comes from the live crossing bonds. Writers
use current graph membership rather than the snapshot after edits. Unexpanded typed labels still
use `MoleculeAtom.element` with `labelLiteral`; expanded group labels do not replace a real element.
The optional field needs no migration or backfill; older native documents remain valid under v1.

Bond displays are `bold`, `wedge`, `hashed`, `dashed`, and `wavy`. Optional
`MoleculeBond.display.bondStyle: "wavy"` is valid only with `order: "single"` (schema rejection
otherwise) and means explicitly unknown stereo at `fromAtomId`. It follows additive v1 conventions:
no migration or backfill. MOL V2000 writes single-bond stereo 4; V3000 writes CFG=2.

Native `reaction` objects reference participants through `components` (`reactant`, `product`,
`agent`) and text through `conditionsTextObjectIds`. Optional `arrowObjectIds` and `plusObjectIds`
link the step's existing drawable objects. Multiple steps may reference the same molecule, including
an intermediate used as one step's product and the next step's reactant. These additive optional
fields follow the existing v1 convention; older reaction documents load without a migration.

Each `BracketObject` is one glyph. Optional `side` (`open`/`close`), `pairId`, and `repeatUnit`
fields extend the existing v1 schema additively, like image payloads. Old documents need no
migration: an absent side keeps the original opening glyph, and no repeat label is added.
Pairs share an opaque `pairId`; the closing member's existing `label` field carries the repeat
subscript. Drawing and label placement belong to layout-engine.

Optional `bracketUsage` is `sru`, `multiple`, `generic`, or `unknown`; unrecognised stored strings
load as `unknown`. Legacy `repeatUnit: true` without a usage still means an SRU. `repeatCount` is an
optional safe positive integer (meaningful for a multiple group); `label` remains free text, including
`n` or `x-y`. `crossingBondIds` optionally lists molecule-scoped `BondRef` values
(`{ objectId, bondId }`), since bond ids are local to each molecule. No migration or backfill is
needed. Pair cleanup removes all multiplier and crossing metadata from an orphan, and patches
prune references to deleted bonds or molecules. Copies carry references only to copied objects.

`bracketChemistryWarnings` reads live document membership, preserved atom membership, crossing
references, and geometric enclosure. Cached formula and mass metadata carry
`chemistry.bracket_multiplier` warnings after loading or patching; values describe one drawn copy,
never an expanded polymer or multiplier. `moleculeBracketWarningMessages` lets graph consumers keep
that context when only a molecule is available. The MOL writers return those warnings too; callers
can pass `document` for live context. Plain generic pairs stay quiet.

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

Document exporters can pass `repeatUnitGroups` to both MOL writers. Each group carries its
source bracket id, repeat label and complete atom membership; crossing bonds are derived from
that membership. V2000 writes SRU STY/SAL/SBL/SMT/SCN records, and V3000 writes an SRU SGroup.
Connectivity defaults to EU (unspecified/either), with explicit HT/HH supported by the writer.
Invalid membership or an unrepresentable label produces a warning naming the source bracket.

Numbered native R-group labels (`R1`–`R99`) write as dummy atoms with their drawn number in the
atom-map field in both MOL formats. `rGroupNumberFromLabel` reads only that label, never an id or
attachment anchor; `R`, `R'`, and `R''` remain unnumbered. In `abbreviations: "rgroup"` mode,
numbered labels keep their numbers and other placeholders receive unused numbers for ranking.
The native schema is unchanged: the atom's `element` and `RGroupDisplay.label` retain the text.

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
