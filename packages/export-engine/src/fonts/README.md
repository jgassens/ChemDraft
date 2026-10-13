# PDF font assets

DejaVu Sans 2.35, upstream https://dejavu-fonts.github.io/ (release 2.35).
These files were sourced from the unmodified TrueType assets redistributed in
Matplotlib's `mpl-data/fonts/ttf` directory; version 2.35 is recorded in their name
tables. Each `.ts` module contains the exact TTF bytes encoded as base64, with no
font modifications or pre-subsetting. This representation works with Node ESM and
Vite's dynamic chunks without different platform loaders or runtime file paths.

The Bitstream Vera and Arev font licences permit use, embedding and redistribution
with the Apache-2.0 application. DejaVu changes are public domain. Their notices and
full terms are preserved in [LICENSE_DEJAVU.txt](LICENSE_DEJAVU.txt), and the font
name tables retained by jsPDF also carry the upstream copyright and licence text.
These assets must accompany their licence; they must not be sold as standalone
typefaces. No fonts are distributed under the reserved Bitstream Vera or Arev names.

SHA-256 values refer to decoded TTF bytes:

| File | Bytes | SHA-256 |
| --- | --- | --- |
| DejaVuSans.ttf | 756072 | `3fdf69cabf06049ea70a00b5919340e2ce1e6d02b0cc3c4b44fb6801bd1e0d22` |
| DejaVuSans-Bold.ttf | 704128 | `b184b89e3c1075f22f6b71575b6fc20d4972b3cfd3b23322ca6fd596dcaef167` |
| DejaVuSans-Oblique.ttf | 633840 | `ccdf74b350f11fd3dd5774de50e5e6346a1a5da1f5b7d5fb83590665e97a5213` |
| DejaVuSans-BoldOblique.ttf | 641720 | `6edf0283160186af451cbee71e7b845f2e4cabf264bb992ce668c83c25465e6f` |

All four cmap tables cover the chemistry acceptance strings, printable ASCII,
Greek letters, and the assigned characters of U+2070–U+209F. U+2072, U+2073,
U+208F and U+209D–U+209F are unassigned and excluded from that claim. The tested
arrow/symbol set is `μµ→←↔⇌⇋Δ±×°−∞≠≤≥•⊕⊖`. See `../pdfFonts.test.ts` for the
independent cmap check and `../pdf.test.ts` for PDF extraction and subset checks.
