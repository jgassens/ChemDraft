# @chemdraft/export-engine

Coordinates export formats and warning reporting.

Format-specific work should go through the correct adapters and compatibility packages.

PDF export uses jsPDF 4.2.1 and svg2pdf.js 2.7.0 over the same SVG geometry as the
canvas. The app, CLI and MCP use `exportDocumentToPdf` from this package.

ASCII-only SVG text elements retain the existing standard-font path, including
bold/italic and font-family selection. If a text element contains non-ASCII text,
the element and its spans use embedded DejaVu Sans 2.35 instead. This avoids mixing
font metrics inside one text element and preserves plain ASCII drawings' output.
Regular, bold, oblique and bold-oblique are real faces; no style is synthesized.
Weights below 600 use regular/oblique, and weights at least 600 use bold/bold-oblique.

DejaVu Sans covers the required chemistry characters, Greek letters, every assigned
character in U+2070–U+209F, and arrows such as →, ↔ and ⇌. Coverage is checked from
each face's cmap, not inferred from a family name. The canvas defaults to Arial /
Helvetica; DejaVu Sans is wider, so Unicode text may differ in spacing. The locally
available Liberation Sans 1.07.4 candidate was closer in metrics but lacked all
subscript digits, superscript signs and equilibrium arrows. Other user-selected
fonts also use DejaVu Sans for non-ASCII text. Unsupported glyphs and non-BMP
characters fail explicitly instead of disappearing during PDF serialization.

The lossless base64 font modules load dynamically only during a PDF export that
needs them, one face per required style. jsPDF's Identity-H TrueType writer embeds
only used glyph outlines and writes a ToUnicode CMap for copying and searching.
In browsers, temporary FontFace registrations let svg2pdf measure with the same
font; these registrations are removed after conversion, including on failure.
Node uses the same embedded data without filesystem, network or OS-font access.
The existing headless DOM measurement shim still approximates text positions.

Small drawing measurements (one text box, default letter page):

| Text | Compressed before / after | Uncompressed before / after |
| --- | --- | --- |
| `H2O + NaCl` | 3,193 / 3,193 bytes | 3,325 / 3,325 bytes |
| `μmol H₂O SO₄²⁻ Na⁺` | 3,220 / 52,071 bytes | 3,351 / 140,786 bytes |

jsPDF retains metadata tables but subsets glyph outlines; the regression fixture
with a text box and `μ₆⁻` atom label stays below 60 KB compressed / 150 KB
uncompressed, and its embedded `glyf` table stays below 10 KB. The original regular
TTF is 756,072 bytes. Tests decode both compressed and uncompressed content streams
and ToUnicode maps and compare the extracted text with its original input.

Font terms, source and hashes are in [src/fonts/README.md](src/fonts/README.md).
For a hands-on pass on macOS and Windows, export the Unicode fixture and a normal
ASCII molecule from the app and CLI/MCP. Inspect μ, ₆, ⁻, Greek letters and arrows,
all four font styles, label halos, centered labels and mixed styled spans. Select
and copy text into a plain text editor, and search the PDF for the original Unicode
string. Compare label alignment with the canvas, especially at small sizes.
