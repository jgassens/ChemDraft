# @chemdraft/render-cli

Headless SMILES-to-SVG/PNG rendering for scripts and document-generation tools. The renderer uses
the desktop SMILES insertion workflow and the shared SVG export/layout engines, so its chemistry and
drawing conventions stay aligned with a structure pasted into ChemDraft.

Run it from the workspace root with `pnpm render --help`.

Each successful JSON result reports `stereoCenters` as the number of specified tetrahedral centers
and `unspecifiedStereoCenters` as the number of constitutional centers with no specified descriptor.
