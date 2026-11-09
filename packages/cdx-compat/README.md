# @chemdraft/cdx-compat

Owns CDXML/CDX import, export, intermediate models, unknown-object preservation, and compatibility warnings.

This package must not become the native document model and must not depend on GPL or AGPL code without an explicit project decision.

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
