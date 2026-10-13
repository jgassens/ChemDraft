# PDF formula font measurements (2026-10-13)

No replacement has been selected or vendored. None of the measured local fonts
meets both the complete coverage requirement and the requested script placement.
In particular, checking only H₂O would miss the missing or insufficiently lowered
subscript signs. The runtime, existing font assets, licences, NOTICE, dependency
inventory and build stamp are unchanged.

## Method

The dependency-free Node scratch script `measure-fonts.mjs` decodes the SFNT table
directory, Windows Unicode BMP `cmap` format 4, `head.unitsPerEm`, `loca`, `glyf`
glyph headers, `hhea.numberOfHMetrics` and `hmtx`. Each Unicode character is mapped
to its actual glyph ID; glyph names such as `uni2082` are not assumed. Bounds and
advance widths are divided by unitsPerEm. Negative y is below the baseline.
Composite glyphs use their stored `glyf` bounding boxes. Bounds below are
`yMin … yMax` in em, rounded to three decimals; “missing” means cmap has no glyph.

The coverage check is the current test's printable ASCII, Greek U+0391–U+03CE
(excluding unassigned U+03A2), every assigned character in U+2070–U+209F, and
`μµ→←↔⇌⇋Δ±×°−∞≠≤≥•⊕⊖`. U+2072, U+2073, U+208F and U+209D–U+209F are excluded
as unassigned. Latin-1 superscripts ¹²³ are also included in the placement checks.

Scratch files are in
`/Users/jeremiahgassensmith/.agentctl/runs/pdf2-20261013/tasks/pdf-subscript-font/tmp/`.
They add no repository dependency. The exact vendored DejaVu 2.35 bytes were
decoded from the current base64 module, rather than substituting a newer system
version.

## Candidate bounds

These rows describe the regular face, except the explicitly labelled Roboto bold
face. Face-specific checks for the strongest candidates follow below.

| Candidate/version | ₂ U+2082 | ₄ U+2084 | ² U+00B2 | ⁴ U+2074 | ⁻ U+207B | O |
| --- | --- | --- | --- | --- | --- | --- |
| DejaVu Sans 2.35 (currently vendored) | 0.000 … 0.416 | 0.000 … 0.408 | 0.326 … 0.742 | 0.326 … 0.734 | 0.479 … 0.525 | −0.014 … 0.742 |
| Noto Sans 2.015 | −0.130 … 0.307 | −0.130 … 0.301 | 0.416 … 0.853 | 0.416 … 0.847 | 0.569 … 0.621 | −0.010 … 0.725 |
| Carlito 1.103 | −0.106 … 0.241 | −0.106 … 0.237 | 0.424 … 0.771 | 0.424 … 0.768 | 0.566 … 0.612 | −0.007 … 0.649 |
| Liberation Sans 2.1.5 | −0.085 … 0.317 | −0.085 … 0.311 | 0.275 … 0.694 | 0.256 … 0.653 | missing | −0.010 … 0.698 |
| Rubik 1.100 | −0.170 … 0.185 | −0.170 … 0.180 | 0.350 … 0.705 | 0.350 … 0.700 | missing | −0.010 … 0.710 |
| Linux Biolinum G 1.1.0 | −0.114 … 0.213 | −0.102 … 0.221 | 0.362 … 0.689 | 0.374 … 0.697 | 0.488 … 0.527 | −0.010 … 0.658 |
| Source Code Pro 2.038 | −0.177 … 0.225 | −0.177 … 0.225 | 0.395 … 0.797 | 0.395 … 0.797 | missing | −0.012 … 0.668 |
| Ubuntu 0.83 | 0.001 … 0.395 | 0.001 … 0.387 | 0.315 … 0.709 | 0.315 … 0.701 | missing | −0.015 … 0.709 |
| Inconsolata 3.000 | −0.007 … 0.383 | −0.006 … 0.381 | 0.246 … 0.636 | 0.246 … 0.633 | 0.291 … 0.352 | −0.011 … 0.627 |
| Lato 1.104 (Western+Polish) | missing | missing | 0.450 … 0.819 | missing | missing | −0.008 … 0.725 |
| Roboto 2.000980, **bold** | missing | missing | 0.326 … 0.716 | 0.326 … 0.711 | missing | −0.010 … 0.721 |
| Source Sans 3 | unavailable; not measured | unavailable | unavailable | unavailable | unavailable | unavailable |

Source Sans 3 was not found in the checked local font directories, application
bundles, runtime caches or Homebrew assets. Direct retrieval failed with
`Could not resolve host: raw.githubusercontent.com`; the available GitHub read
connector returned `USER_NOT_LOGGED_IN`. No measurements or coverage claims are
inferred for Source Sans 3 from another member of the Source family.

Local Source Sans **Pro** 2.010 is an older, distinct candidate. Its regular OTF
is 234,960 bytes, OFL 1.1, and has **CFF outlines, not glyf**. An independent
fontTools BoundsPen inspection using the already installed scratch-only tooling
gave ₂ −0.177 … 0.225, ₄ −0.177 … 0.213, ² 0.395 … 0.797, ⁴ 0.395 … 0.785,
O −0.012 … 0.668; ⁻ is missing. It also lacks ⁺⁼₊₋₌, subscript letters
U+2090–U+2093 and U+2095–U+209C, ↔⇌⇋⊕⊖. These are CFF ink bounds, **not a glyf
measurement**. It is not a direct replacement for jsPDF's TrueType writer.

## Coverage, licence and size

Sizes are decoded, unsubsetted regular TTF bytes (Roboto: bold). No candidate
files have been added to the repository or redistributed by this investigation.

| Candidate | Licence recorded in local assets | Bytes | Coverage gaps in the required set |
| --- | --- | ---: | --- |
| DejaVu Sans 2.35 | Bitstream Vera / Arev; DejaVu changes public domain | 756,072 | None; fails subscript placement |
| Noto Sans 2.015 | SIL OFL 1.1 | 825,628 | →←↔⇌⇋∞≠≤≥⊕⊖ |
| Carlito 1.103 | SIL OFL 1.1 | 635,996 | U+2095–U+209C, ⇌⇋⊕⊖ |
| Liberation Sans 2.1.5 | SIL OFL 1.1 | 410,712 | ⁰ⁱ⁺⁻⁼⁽⁾₊₋₌₍₎, U+2095–U+209C, ⇌⇋⊕⊖ |
| Rubik 1.100 | SIL OFL 1.1 | 136,624 | Entire tested Greek range; ⁱ⁺⁻⁼ⁿ₊₋₌; U+2090–U+209C; →←↔⇌⇋⊕⊖ |
| Linux Biolinum G 1.1.0 | GPL with font exception and alternative SIL OFL **1.0**, per bundled terms | 1,937,644 | Regular: none. Bold/italic: U+2095–U+2097 and U+209A–U+209C |
| Source Code Pro 2.038 | SIL OFL 1.1; reserved font name “Source” | 138,680 | ⁺⁻⁼₊₋₌, U+2090–U+2093 and U+2095–U+209C, ⇌⇋⊕⊖; also monospaced |
| Ubuntu 0.83 | Ubuntu Font Licence 1.0 | 353,824 | ⁱ⁺⁻⁼⁽⁾ⁿ₊₋₌₍₎, U+2090–U+209C, →←↔⇌⇋⊕⊖ |
| Inconsolata 3.000 | SIL OFL 1.1 | 108,684 | Entire tested Greek range; ⁱ⁺⁼⁽⁾₊₋₌₍₎; U+2090–U+209C; ⇌⇋⊖; also monospaced |
| Lato 1.104 | SIL OFL 1.1; reserved font name “Lato” | 75,152 | Greek except μ; every assigned U+2070–U+209F character; →←↔⇌⇋⊕⊖ |
| Roboto 2.000980, bold | Apache-2.0 | 127,744 | Every assigned U+2070–U+209F character except ⁴ and ⁿ; →←↔⇌⇋⊕⊖ |
| Source Sans 3 | Upstream family is OFL 1.1; no local artifact verified | unavailable | Unmeasured |

Noto, Carlito, Liberation, Rubik and Linux Biolinum came from the locally bundled
LibreOffice fonts. Source Code Pro, Ubuntu and Inconsolata came from the local
Poppler runtime's fonts. Lato came from the Box app; Roboto from Notability's
GoogleSignIn bundle. Licence claims above use the fonts' name tables; Linux
Biolinum's licence version additionally uses LibreOffice's bundled LICENSE.
OFL 1.0 and Ubuntu Font Licence are identified explicitly, not relabelled OFL 1.1.

### Real faces checked

| Family/face | Bytes | Digit subscript yMin range | Maximum digit subscript yMax | Digit superscript yMin range |
| --- | ---: | --- | --- | --- |
| Noto Sans regular | 825,628 | −0.139 … −0.130 | 0.308 | 0.407 … 0.416 |
| Noto Sans bold | 838,072 | −0.140 … −0.130 | 0.308 | 0.406 … 0.416 |
| Noto Sans italic | 845,312 | −0.138 … −0.129 | 0.311 | 0.408 … 0.417 |
| Noto Sans bold-italic | 853,344 | −0.141 … −0.131 | 0.307 | 0.405 … 0.415 |
| Rubik regular | 136,624 | −0.175 … −0.170 | 0.185 | 0.345 … 0.351 |
| Rubik bold | 140,396 | −0.175 … −0.170 | 0.185 | 0.345 … 0.350 |
| Rubik italic | 143,392 | −0.175 … −0.170 | 0.185 | 0.345 … 0.351 |
| Rubik bold-italic | 146,128 | −0.175 … −0.170 | 0.185 | 0.345 … 0.350 |
| Linux Biolinum G regular | 1,937,644 | −0.118 … −0.102 | 0.224 | 0.358 … 0.374 |
| Linux Biolinum G bold | 1,988,092 | −0.171 … −0.165 | 0.192 | 0.357 … 0.364 |
| Linux Biolinum G italic | 2,001,216 | −0.118 … −0.111 | 0.218 | 0.358 … 0.365 |

All ten digit subscripts and all ten digit superscripts were checked in each
listed face. Noto's eleven symbol gaps and Rubik's gaps are shared by all four
faces. Linux Biolinum has only these three faces locally; no real bold-italic
face was available. Its regular face's full coverage cannot be claimed for bold
or italic.

### The subscript signs prevent a simple substitution

| Regular face | ₊ U+208A | ₋ U+208B |
| --- | --- | --- |
| DejaVu Sans 2.35 | 0.000 … 0.351 | 0.152 … 0.199 |
| Noto Sans 2.015 | −0.074 … 0.200 | 0.037 … 0.089 |
| Carlito 1.103 | −0.062 … 0.177 | 0.035 … 0.081 |
| Linux Biolinum G 1.1.0 | −0.095 … 0.157 | 0.011 … 0.050 |
| Rubik / Source Code Pro / Liberation / Ubuntu / Inconsolata / Lato / Roboto | missing | missing |

## Choice and proposed combination

**No runtime font change:** DejaVu fails the target, but replacing it with Noto
alone would introduce missing arrows, and selecting a font solely for its ₂ and
₄ would leave the script-sign requirement unsatisfied. No target assertion has
been weakened to make an available candidate pass.

The strongest measured combination to evaluate is **Rubik's four real faces for
script digits**, **Noto Sans's four faces for ordinary Latin/Greek and script
letters**, and **Linux Biolinum G for the missing arrows/symbols**. Their combined
cmap covers the required set; Rubik's numeral bounds meet the specified targets.
However, the available subscript-minus glyphs still have positive y bounds, so
this combination does **not** satisfy the complete request as stated. Biolinum
also adds large assets and an OFL 1.0 licence, and its fallback face choice would
need to account for missing bold/italic subscript letters and absent bold-italic.

jsPDF can select a family and face per text run, and svg2pdf supports styled
tspans; the existing mixed-style PDF round-trip test exercises separate embedded
faces. That capability alone does not resolve the measured sign placement.
An explicit baseline adjustment or a renamed font derivative would be additional
design work, not an unmodified-font substitution, and has not been slipped into
this change.

**Recommended next task:** stage Source Sans 3 TrueType faces and an OFL 1.1 symbol
fallback in the worker's readable filesystem, then measure them before selecting
a replacement. Source Sans Pro and Source Code Pro must not stand in for a
measurement of Source Sans 3. If they still lack suitable script signs, resolve
the font-derivative or explicit-baseline-adjustment approach with the owner.

## Validation

- `pnpm lint`: passed after reusing the authorized checkout's node_modules,
  including its example-plugin node_modules needed by the root typecheck.
- The exact requested Vitest command could not start: bundling its config tried
  to write `.vite-temp` inside the shared, read-only node_modules symlink.
- With `--configLoader runner`, the reused installation was also missing a
  template-library workspace link and resolved the bare RDKit package to the
  source checkout while its aliased subpaths resolved to this worktree.
- A scratch-only config added the missing template-library alias and made the
  bare RDKit import resolve to this worktree. With that environment adaptation,
  **all 152 tests in all 10 requested suites passed**. No repository test/config
  file was edited to achieve this result.
- macOS Node validation only. Windows and hands-on app/PDF visual checks were
  not run. Passing tests verify the existing implementation, not completion of
  the requested font replacement.
