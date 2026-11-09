# @chemdraft/cdx-compat

Owns CDXML/CDX import, export, intermediate models, unknown-object preservation, and compatibility warnings.

This package must not become the native document model and must not depend on GPL or AGPL code without an explicit project decision.

Synthetic-fixture-covered `<scheme>/<step>` import uses native `reaction` objects, one per step in
source order. `components` holds reactant/product/agent roles; `conditionsTextObjectIds` links text
above or below the arrow; optional `arrowObjectIds` and `plusObjectIds` link shared drawables.
Groups resolve to their members, and an intermediate used by two steps remains one molecule.
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
