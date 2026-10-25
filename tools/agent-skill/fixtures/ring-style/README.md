`paclitaxel-filled.svg` is a real `render-document` output of `paclitaxel-doc.json`
from the full ring polygon renderer. It replaces the old before/after notch fixtures.

`golden-14459a46/identity.json` retains the original CLI molecule identity capture
from the pre-grouping recipe-11 code at 14459a46. Its chemistry expectations are unchanged.
The six artwork SVGs were regenerated on 2026-10-24 from this branch: call the current
`style(doc, build.molecules[0])` with default options for cholesterol, morphine and
strychnine, then render both returned variants through the real CLI (default 24 px
padding, white background). This updates the artwork for full polygon fills and the
ring-label luminance rule. The folder name records the original identity provenance.

Only repeated `data-structure` CTAB attributes are stripped from captured SVGs.
Tests compare all artwork attributes except molecule-specific decoration IDs, and
rasterize the captures using the current host fonts for a portable SVG/PNG comparison.
The original chemistry results are checked separately and must not be regenerated
when updating visual fixtures.
