# @chemdraft/export-engine

Coordinates export formats and warning reporting.

Format-specific work should go through the correct adapters and compatibility packages.

## Table clipboard payloads

`exportTableClipboardPayloads(table, options?)` produces editable HTML, ASCII-safe RTF, and plain
TSV strings, plus warnings for rotation and fixed columns narrower than their natural layout.
The individual writers are `exportTableToHtml`, `exportTableToRtf`, and `exportTableToTsv`.
HTML includes the fragment markers required by the native clipboard writer; TSV contains only rows.
All dimensions come from `planTableLayout`, with explicit rules and no shading.
Decimal blocks are centred in the column's inner width, or start at the inner left if too wide.
Decimal body columns whose non-empty cells are all numbers with equal precision use right alignment
with the layout's right inset added to the cell padding. Other decimal body columns use left
alignment with the left inset added to the padding and a decimal tab at the block's pre-point width
from the text start. Text without a point ends at that tab, including integers and dashes.
HTML declares the decimal tab without inserting a tab character; RTF prefixes the text with one tab.
Decimal headers stay centred with normal padding. HTML also declares each plain number's displayed
precision for Excel. Adjacent runs with matching formatting are merged, plain text has no run
wrappers, and unset or default text colours are omitted so the destination keeps automatic colour.
The default font mode is `document`; `{ font: "inherit" }` omits font families and sizes so the
destination chooses them. These pure writers do not access the native clipboard.

PDF export uses jsPDF 4.2.1 and svg2pdf.js 2.7.0 over the same SVG geometry as the
canvas. The app, CLI and MCP use `exportDocumentToPdf` from this package.

Filled-ring label halos use the shared SVG composite paint (paper plus clipped ring fills).
PDF converts that paint to a tiling pattern and applies it through a glyph soft mask, preserving
gradients and opacity without a white outline. These documents use PDF 1.4 transparency; unfilled
documents retain their existing path. See [the rendering contract](../../docs/architecture/ring-fill-label-halos.md).

SVG text elements containing only Latin-1 (U+0000–U+00FF) and the 27 additional
WinAnsi characters retain the existing standard-font path, including bold/italic
and font-family selection. jsPDF 4.2.1 maps `ŒœŠšŸŽžƒˆ˜–—‘’‚“”„†‡•…‰‹›€™` to
the correct WinAnsi bytes; tests decode the declared PDF encoding and verify text
round-trips. Thus °, ±, ×, µ (U+00B5), é, dashes, quotes, euro and trademark do
not require embedding. If a text element contains any other character (such as
μ U+03BC), its text runs use embedded Noto Sans 2.015, with DejaVu Sans 2.35 for
characters absent from the matching Noto face's cmap. Adjacent tspans let one text
element mix the families without changing text order, authored positioning or style.
Regular, bold, italic and bold-italic are real faces; no style is synthesized
(DejaVu's italic faces are named oblique). Weights below 600 use regular/italic,
and weights at least 600 use bold/bold-italic.

Noto supplies Latin/Greek, Unicode subscript/superscript digits and signs; its
subscript digits extend below the baseline (about −0.13…0.31 em) and superscript
digits sit above it (about 0.41…0.85 em). DejaVu covers Noto's missing chemistry
symbols `→←↔⇌⇋∞≠≤≥⊕⊖` and any other cmap gap. Coverage uses compact per-face ranges
generated from the vendored cmaps, with tests checking every face against its bytes.
Regenerate after a font swap with `node packages/export-engine/scripts/generate-font-coverage.mjs`.
The canvas defaults to Arial / Helvetica,
so embedded Unicode text may differ in spacing. Other user-selected fonts also
use this Noto/DejaVu combination outside the standard-font character set. Unsupported glyphs and non-BMP
characters fail explicitly instead of disappearing during PDF serialization.

Arabic and right-to-left scripts are not supported in PDF export yet: jsPDF's
Arabic shaping changes the Unicode written into ToUnicode, and its bidi processing
reorders mixed LTR/RTL text. Turning shaping off would render unjoined Arabic
letters. Export therefore refuses Arabic in U+0600–U+06FF, U+0750–U+077F,
U+08A0–U+08FF, U+FB50–U+FDFF and U+FE70–U+FEFF, plus RTL text in U+0590–U+05FF,
U+0700–U+074F, U+0780–U+089F, U+FB1D–U+FB4F and the U+200F direction mark.
The error names the character's Unicode code point and the text preservation
limitation. The literal sequence `\s+` is also refused (including in ASCII text),
because jsPDF's unconditional Arabic hook replaces it with a space. Chemistry
characters, Greek letters and arrows retain their original Unicode.

The lossless base64 font modules load dynamically only during a PDF export that
needs them, one face per required family/style. Run segmentation reads only coverage
metadata: fallback-only text never loads primary font data, and only used faces
are loaded and registered. jsPDF's Identity-H TrueType writer embeds
only used glyph outlines and writes a ToUnicode CMap for copying and searching.
In browsers, temporary FontFace registrations let svg2pdf measure with the same
font; these registrations are removed after conversion, including on failure.
Node uses the same embedded data without filesystem, network or OS-font access.
The existing headless DOM measurement shim still approximates text positions.

Small drawing measurements (one text box, default letter page, headless DOM):

| Text | Compressed | Uncompressed |
| --- | --- | --- |
| `H2O + NaCl` (standard fonts, unchanged) | 3,193 bytes | 3,325 bytes |
| `μmol H₂O SO₄²⁻ Na⁺` (Noto) | 47,512 bytes | 113,092 bytes |
| `K ⇌ 10⁻³, SO₄²⁻ μmol H₂O` (Noto + DejaVu) | 95,292 bytes | 248,685 bytes |

jsPDF retains metadata tables but subsets glyph outlines; the regression fixture
with a text box and `μ₆⁻` atom label stays below 60 KB compressed / 150 KB
uncompressed, and its embedded `glyf` table stays below 10 KB. The original Noto regular
TTF is 825,628 bytes. Mixed-family fixtures stay below 120 KB compressed / 300 KB
uncompressed, with each subset's `glyf` table below 10 KB. Tests decode both compressed and uncompressed content streams
and ToUnicode maps and compare the extracted text with its original input.

Font terms, source and hashes are in [src/fonts/README.md](src/fonts/README.md).
For a hands-on pass on macOS and Windows, export the Unicode fixture and a normal
ASCII molecule from the app and CLI/MCP. Inspect μ, ₆, ⁻, Greek letters and arrows,
all four font styles, label halos, centered labels and mixed styled spans. Select
and copy text into a plain text editor, and search the PDF for the original Unicode
string. Compare label alignment with the canvas, especially at small sizes.
