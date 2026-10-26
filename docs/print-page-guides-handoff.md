# Printed page outlines

Requested 2026-10-24. Worktree `ChemDraft-page-guides`, branch `codex/print-page-guides`, based
straight on upstream `jgassens/ChemDraft` main `f9f1a3d`. No reaction-arrow branch changes are included.
This branch contains only the printed-page-guide feature.

Custom Page Size now offers an off-by-default checkbox and the existing minimal paper-size list:
US Letter, US Legal, A4, A3, A2, A1, A0 and A5. The independent paper choice draws tiles matching the page orientation
from the art-space top-left, with partial last tiles. Guide thickness/dots compensate for zoom.
A single SVG pattern bounds DOM size for huge art spaces. The pointer-transparent overlay lives
outside the artwork plan; exports and print markup never include it. This does not implement
printer pagination or automatic tiled print jobs.

Optional native `PageLayout.printGuides` saves the enabled flag and preset. The strict TS and Rust
native-dialog contracts accept that optional data and reject malformed fields. Apply uses the
existing page-size command/patch/Undo path, including originating inactive tabs. Later custom,
preset and orientation changes retain the choice. Old drawings remain guide-free.

Source stamp: `10.24.12.41-codex`.

Validation: 237 distinct focused tests passed across the guide, Page Size form, dialog protocol,
native dialog DOM and tab suites (the new dialog replay fixture was corrected and rerun).
The five additional zoom cases and final root TypeScript check passed. Whitespace passed. Guide grid was rasterized and inspected.
The full JavaScript run was stopped after the owner requested a smaller usage footprint; do not
report it as a completed pass. Rust fmt passed. Rust Clippy initially could not resolve uncached
upstream `httpdate` offline; dependencies were then fetched, but native compilation/tests and
packaging were not run. Native computer-use service startup failed. Native macOS hands-on/launch
and Windows execution remain unverified. The shared manual checklist includes this surface.

Owner preference: keep work proportional to a small feature; use focused checks, avoid broad
validation or unrelated checkout work unless needed or requested.

Preview from the VS Code integrated terminal:

```sh
cd "/Users/emily/ChemDraft Repository/ChemDraft-page-guides"
./run-app
```

Expected label: `ChemDraft-page-guides [codex/print-page-guides]`, with the stamp above.
The stable application must remain untouched. User-run launch remains unverified until confirmed.

Owner follow-up: outlines now follow `page.layout.orientation` through the shared paper-layout helper.
The owner will perform visual testing; no broad checks or new build were run for this follow-up.
