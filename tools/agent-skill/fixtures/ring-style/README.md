These are render-document outputs of `paclitaxel-doc.json`, before and after the ring-fill notch, with the embedded `data-structure` payload removed to keep the fixtures small.

`golden-14459a46/` contains real SVG output from the pre-grouping recipe-11
code, plus the CLI's molecule identity results in `identity.json`. The capture
used `git show 14459a46:skills/chemdraft/scripts/ring-style.mjs` as a temporary
module, called its `style(doc, build.molecules[0])` with default options on the
cholesterol, morphine and strychnine fixtures, and rendered both returned
variants with `render-document --format svg` (default 24 px padding and white
background). Rendering code was unchanged since that commit; the new bounds
fix only skips groups, which these old documents do not contain.

Only repeated `data-structure` CTAB attributes were removed from the captured
SVGs to keep them small. Tests compare all SVG artwork attributes except
decoration object IDs, which now include the molecule ID. They rasterize these
captured SVGs with the current host's fonts and compare with the current CLI's
600 px PNG output, so the comparison works on macOS and Windows without
requiring identical system fonts. Chemistry is compared separately against the
captured identity results. Never regenerate these goldens from current styling
code or from a grouped document with its wrappers stripped.
