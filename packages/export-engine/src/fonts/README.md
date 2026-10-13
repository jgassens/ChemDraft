# PDF font assets

Noto Sans 2.015 is the primary embedded font, with real regular, bold, italic
and bold-italic faces. The unmodified TTFs come from the local LibreOffice bundle:
`/Users/jeremiahgassensmith/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/libreoffice-headless/libreoffice/LibreOfficeDev.app/Contents/Resources/fonts/truetype/`.
The measured files were staged at
`/Users/jeremiahgassensmith/programming/chemdraw-wt/_master-scratch/fonts-noto/`.
Upstream: https://github.com/notofonts/latin-greek-cyrillic.

Copyright from each font's name table: Copyright 2022 The Noto Project Authors
(https://github.com/notofonts/latin-greek-cyrillic). Noto is licensed under SIL
Open Font License 1.1; its full text is in [LICENSE_NOTO.txt](LICENSE_NOTO.txt).
The licence body was copied **verbatim** from the local RDKit distribution's
`/Users/jeremiahgassensmith/.cache/uv/archive-v0/XIEkJn9ePnlaxRwnK2Tcb/rdkit/Data/Fonts/OFL.txt`,
starting at the licence heading (the preceding Comic Neue copyright is not Noto's).
The fonts remain under OFL; documents produced with them do not acquire that licence.

DejaVu Sans 2.35 is the fallback, upstream https://dejavu-fonts.github.io/ (release 2.35).
These files were sourced from the unmodified TrueType assets redistributed in
Matplotlib's `mpl-data/fonts/ttf` directory; version 2.35 is recorded in their name
tables. Each `.ts` module contains the exact TTF bytes encoded as base64, with no
font modifications or pre-subsetting, for both families. This representation works with Node ESM and
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
| NotoSans-Regular.ttf | 825628 | `f5f552c8c5edb61fe6efb824baf4d4de47b1a8689ab4925ff43f7bd6a4ebece5` |
| NotoSans-Bold.ttf | 838072 | `3a08a47daa00cade516425c15c57615aef2fd418ec9811a7b9f465088f92cc05` |
| NotoSans-Italic.ttf | 845312 | `126522ae1bb9cd92120287fc47dfc74ef981e73931d93e52c565fb7e09b2d74a` |
| NotoSans-BoldItalic.ttf | 853344 | `2e34b41a4b9c234b1be7dff6d06cba18811ecb694b41350873edf0ec16a0f0fa` |
| DejaVuSans.ttf | 756072 | `3fdf69cabf06049ea70a00b5919340e2ce1e6d02b0cc3c4b44fb6801bd1e0d22` |
| DejaVuSans-Bold.ttf | 704128 | `b184b89e3c1075f22f6b71575b6fc20d4972b3cfd3b23322ca6fd596dcaef167` |
| DejaVuSans-Oblique.ttf | 633840 | `ccdf74b350f11fd3dd5774de50e5e6346a1a5da1f5b7d5fb83590665e97a5213` |
| DejaVuSans-BoldOblique.ttf | 641720 | `6edf0283160186af451cbee71e7b845f2e4cabf264bb992ce668c83c25465e6f` |

All four DejaVu cmap tables cover the chemistry acceptance strings, printable ASCII,
Greek letters, and the assigned characters of U+2070–U+209F. U+2072, U+2073,
U+208F and U+209D–U+209F are unassigned and excluded from that claim. The tested
arrow/symbol set is `μµ→←↔⇌⇋Δ±×°−∞≠≤≥•⊕⊖`. See `../pdfFonts.test.ts` for the
independent cmap check and `../pdf.test.ts` for PDF extraction and subset checks.

For embedded text, each character uses Noto when its style's cmap has a glyph,
otherwise the matching DejaVu face. Noto's gaps in the tested chemistry set are
`→←↔⇌⇋∞≠≤≥⊕⊖`; other cmap gaps follow the same rule. Only used faces are registered
and subset. A character absent from both families fails with its code point.

Measurements on 2026-10-13 read each cmap's actual glyph IDs, `head.unitsPerEm`,
`loca` and `glyf` ink bounds (including composite glyph headers). Across all four
Noto faces, subscript digit yMin is −0.141…−0.129 em and maximum yMax is 0.311 em;
superscript digit yMin is 0.405…0.417 em. Regular ₂ is −0.130…0.307 em and ² is
0.416…0.853 em. DejaVu's regular ₂ is 0.000…0.416 em, motivating Noto as primary.
Regular Noto ₋ is 0.037…0.089 em, correctly centred near the subscript digits'
middle (about 0.09 em); a subscript sign need not lie below the baseline.
Tests lock all ten subscript and superscript digits in every Noto face from the
vendored bytes. These notes replace the exploratory `CANDIDATES.md` report.
