# @chemdraft/cdx-compat

Owns CDXML/CDX import, export, intermediate models, unknown-object preservation, and compatibility warnings.

This package must not become the native document model and must not depend on GPL or AGPL code without an explicit project decision.

CDXML double bonds with `Order="2" Display="Wavy"` import as native `stereo: "either"` and export
with the same attributes, preserving unknown E/Z even when the coordinates suggest an isomer.
`DoublePosition` controls line placement and does not assign stereo. Ordinary double bonds retain
their coordinate-derived E/Z. Unmapped double-bond `Display2` and `BS` attributes produce warnings
naming the attribute and value. If an either bond also has a native bond style, visible export uses
`Wavy` and warns that the additional style remains only in the native payload.
