# BioArt

This pack contains 159 original ChemDraft subjects in two SVG styles. The artwork is licensed CC BY 4.0, separately from the Apache-2.0 code. See NOTICE.txt.

Generate it with `pnpm art:pack <source-directory>`. The build replaces the generated art tree
and writes `pack.json` and `SANITIZATION.txt`. The report lists the sanitized files and their
checksums. The build prints the counts of source changes and removals.

Run `pnpm art:pack --check` to verify the file inventory, manifest, sanitized SVGs and report
using the generated pack alone.
