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

Native multi-atom labels are encoded as standard `GenericNickname` nodes with label text on the
existing atom; its bond endpoints stay unchanged. Import also accepts unexpanded nickname, formula,
fragment and monomer text nodes, including a `GenericNickname` property without a text object.
`cdx.atom_label_unexpanded` names each label exported without an expanded atom graph: the text and
drawn attachments are preserved, but the file does not supply an explicit chemical expansion to
other readers. A nameless unexpanded node imports as an unknown atom with a warning, never carbon.
Synthetic coverage includes chain formulas, a ring NMe, a repeated-formula linker, a metal fragment,
peptide labels, and nested fragment connection points; it is not a claim of general peptide or
multi-attachment fragment expansion.

Save As uses `{ embedNativePayload: true }`. User-defined property `0x4344` contains a namespaced
`org.chemdraft/cdx-envelope.v1` envelope with the existing CDXML payload tags. Its visible hash covers
the actual binary-normalized CDXML, and a second hash covers every raw file byte except the envelope
property itself, including both legacy and UTF-8 text copies. Unchanged files restore the exact native
document; external edits to either copy use the existing conflict path. Both the binary hash and the
stored visible XML hash must match. Every new CDXML envelope has root attribute
`attrib4345="|x|32"`: the opaque binary-property notation for user-defined CDX property `0x4345`,
whose UTF-8 value is the hash-semantics version `"2"`. Save As CDX preserves that property beside
`0x4344` and also records `visibleHashVersion: "2"` in the envelope JSON; both copies must agree.
An absent version selects only the frozen released canonicalization, which left numeric references
literal and used the old whitespace escaping. Version `"2"` selects only current canonicalization;
unknown versions require conflict review. No file is checked against both semantics.

Known, accepted legacy limitation: the frozen canonicalization aliases a line break encoded as
`&#10;` with the literal text `&#10;` encoded as `&amp;#10;` (and similarly for other numeric
references). This cosmetic substitution never changes chemistry. Unversioned files whose legacy
hash matches restore silently, including unchanged text with line breaks; no new prompt or conflict
is introduced. CDX still requires its binary integrity hash to match, so this substitution alone
does not bypass that check. Saving a legacy document again writes version `"2"`, whose current
canonicalization distinguishes the two forms and rejects cross-semantics substitutions.

The root version attribute is included in the visible XML hash, and binary property `0x4345` is
included in the raw binary hash. Removing, adding or changing it therefore changes the hash, even
when text edits collide across the two canonicalizations. Recomputing the binary hash cannot bypass
the independently stored XML hash. The envelope JSON alone is outside the binary hash, so its version
must agree with the hashed property. Interchange CDX Export omits both native properties.
Older readers preserve unknown root attributes and raw binary properties in their visible hashes
and ignore unknown envelope JSON fields. The existing tag names, envelope format, native document
and its hash remain unchanged, so old readers retain their existing hash behavior (including their
existing numeric-reference limitations); no new native tag trips their CDX tag whitelist.
Native-payload, schema and codec checks still apply. Older envelopes
without the binary hash also require conflict review. This property is ChemDraft-specific; other readers
can consume the standard visible objects without interpreting it.

CDXML text and attributes decode decimal and hexadecimal numeric character references and the five
XML entities once. Named HTML entities remain literal. Text CR and attribute CR/TAB/LF export as
numeric references so XML whitespace normalization cannot change them on reopen.

The binary codec accepts either byte order, fixed-point coordinates and legacy/UTF-8 text copies.
Limits are 64 MB, 64 nested child-object levels, one million objects and one million properties.
Diagnostics retain at most 1000 warnings plus one summary counting omitted warnings. A malformed typed
property is skipped with a warning; unsupported binary properties retain their raw bytes where possible.
Point3D bytes follow the public specification's z/y/x order. Legacy text uses the declared font charset;
zero-style strings use ISO Latin-1. Unrepresentable characters produce specific encoding warnings.
Compatibility remains fixture-driven, with the same visible-subset limits as CDXML. Doublet and
triplet atom radicals round-trip; electron states the native model cannot express are refused with
a warning rather than converted to a different radical.

Synthetic-fixture-covered `<scheme>/<step>` import uses native `reaction` objects, one per step in
source order. `components` holds reactant/product/agent roles; `conditionsTextObjectIds` links text
above or below the arrow; optional `arrowObjectIds` and `plusObjectIds` link shared drawables.
Groups resolve to their members, and an intermediate used by two steps remains one molecule.
Explicit reactant/product text labels remain participants; decorative group members do not acquire
chemical roles and produce a named warning while retaining their source references. Multiline
conditions retain their exact text through visible CDXML and CDX export; XML indentation is added
only before serialized objects, never inside their text.
Unresolved participant ids produce `cdxml.reaction_reference_unresolved` and are ignored.

Visible export writes schemes for native reaction objects. Compatibility metadata retains source
scheme membership, step order, above/below placement and source attributes; unchanged valid source
object ids and step lists round-trip, including group references. Edited native roles regenerate
the affected lists. New reactions use their native links and place agents/conditions above or below
according to their positions relative to the arrow. This does not infer a reaction from loose
drawings: the CLI's current visual layout builder still produces loose drawing objects.
Atom maps and other unmapped `ReactionStep*` attributes are retained opaquely with a named warning;
they do not become native atom mapping. The embedded native payload round-trips the full document.
This fixture coverage does not claim general CDXML reaction compatibility or exact arrowhead sizing.

CDXML double bonds with `Order="2" Display="Wavy"` import as native `stereo: "either"` and export
with the same attributes, preserving unknown E/Z even when the coordinates suggest an isomer.
`DoublePosition` controls line placement and does not assign stereo. Ordinary double bonds retain
their coordinate-derived E/Z. Unmapped double-bond `Display2` and `BS` attributes produce warnings
naming the attribute and value. If an either bond also has a native bond style, visible export uses
`Wavy` and warns that the additional style remains only in the native payload.

CDXML `Order="1.5"` stays native `aromatic` and exports as `1.5`, including on open chains and
exocyclic bonds. This preserves the stated delocalised order without inferring ring aromaticity or
choosing a Kekulé structure. Unsupported order values stay native `unknown`; their original strings
are kept per bond in `compatibility.unknown.cdxmlUnknownBondOrdersByBondId` and restored on CDXML
export while the bond remains unknown. A native unknown bond without a preserved source value
exports as `Order="any"`. Both cases warn; neither is exported as a single bond.

CDXML `<curve>` arrows import as editable native art-arrow graphics (`graphicKind: "path"`,
`data.artPathKind: "bezier"`, `data.pathNodes`, `markerStart` and `markerEnd`). Full, angle and
half heads retain their endpoint; a half head remains a fishhook. Cubic chains and incoming/knot/
outgoing spline triples retain every segment and control point; a quadratic is elevated exactly
to cubic. Unheaded curves use the same native path without arrow markers. Source curves return as
`<curve>`, while existing `<arrow>` objects keep their export form. Curves carry explicit line
widths and custom colors through the visible CDXML, including when the native payload is removed.

`compatibility.unknown.cdxmlCurveAttributes` retains the source attributes, including the original
`CurvePoints` text, head sizing, `LineType` and `Z`. Unchanged geometry and head attributes export
verbatim; edited Bezier nodes export their current controls. Native head dimensions, half-head
handedness and hollow-head appearance can differ from the source: named import warnings describe
these approximations, and export restores the original source attributes. Unsupported line types
also warn and remain in the source attributes. Invalid or unsupported point layouts stay as unknown
compatibility objects with `cdxml.curve_points_preserved` and export their source curve. Rotation,
tilt, or edited head dimensions that standard export cannot express warn and remain in the native
payload. This checkout rejects binary CDX input; it has no binary-to-CDXML conversion path.

Edited closed Beziers export incoming/knot/outgoing triples, including the first incoming and last
outgoing controls that define the closing segment. CDXML's per-end heads specify `Full`, `HalfLeft`
or `HalfRight`; `Solid`, `Hollow` and `Angle` belong to the shared `ArrowheadType` (see the
[CDXML enum mappings](https://github.com/epam/Indigo/blob/master/core/indigo-core/molecule/CDXCommons.h#L109-L114)).
An edited curve with mixed filled/open ends therefore exports using the end head's type and emits
`cdxml.arrow_marker_payload_only`, naming the start (tail) style that is approximated. The native
payload retains both original marker styles. Curve-specific `Half`/`Angle` aliases do not affect
standalone `<arrow>` import: its legacy full-head fallback and resulting `Full`/`Solid` export for
`ArrowheadHead="Half"`, `ArrowheadType="Half"` or `ArrowheadHead="Angle"` remain unchanged.

Untilted, unrotated square and round brackets write real `graphic` bracket elements and
`bracketedgroup`/`bracketattachment` pair membership. Synthetic fixtures cover those paths.
Repeat pairs write `BracketUsage="SRU"` and visible label text. Repeat-label association and polymer
crossing-bond connectivity remain preserve-and-warn cases; exact native labels survive the document
envelope. External SRU text stays independent, without inventing a label association. Unknown
bracket usage, atom membership and crossing attachments retain their original compatibility data.
Foreign groups with unsupported usage, membership, crossing attachments or extra group data remain
unknown compatibility objects, with specific warnings; they never create native pairs. Re-export
retains the original group in the embedded payload, without emitting a simplified visible group.

Bracket orientation is **UNVERIFIED against an independent reader**. Closing glyphs currently use
reversed `BoundingBox` x coordinates. No repo schema or specification was found documenting that
rule or an alternative orientation attribute. The fixtures are synthetic and confirm internal
consistency only.
See [the bracket handoff](../../docs/architecture/brackets-repeat-units.md) for the remaining work.
