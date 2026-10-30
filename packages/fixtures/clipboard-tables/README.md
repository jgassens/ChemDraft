# Clipboard table fixtures

Most files are **synthetic stand-ins**, hand-written to follow the documented clipboard structures.
The six `windows-real-*` files are real captures, described below.

A passing synthetic-fixture test proves the parser reads that structure, not that a given application
produces it on macOS or Windows. Real-capture coverage applies only to the recorded source and content.

The synthetic table content is the Sharpless reagent table in `../tables/sharpless-reagent-table.json`.

`windows-word.html` and `windows-excel.html` model Windows Office 16 CF_HTML fragments,
with our own Sharpless content. Word uses Calibri paragraphs and positional `mso-yfti` markers
without semantic header cells. Excel uses class-based bold/border styles, with fragment markers
inside the table. Tests wrap these hand-written documents in a CF_HTML envelope; neither is a capture.

`excel-markers-inside-table.html` is a second synthetic Excel fixture. It models Excel's fragment
marker placement inside `<table>`, after the `<col>` elements and before the first `<tr>`, without
a CF_HTML envelope. It is still hand-written, not a capture from Excel.

| File | Models |
|---|---|
| `excel-like.html` | Office HTML: `<col>` widths, `x:num`, `mso-number-format`, class-based styles, no `<thead>`, two Density values displayed as `#######` |
| `excel-like.tsv` | Matching synthetic plain-text grid with the formatted Density values, including those hidden by overflow in HTML |
| `word-like.html` | `MsoTableGrid`, mso borders, `<p class=MsoNormal>` in cells, `<o:p>`, `<sub>`, a `vertical-align:super` span |
| `word-like.cfhtml.txt` | The Word fixture inside a Windows `HTML Format` (CF_HTML) envelope with real offsets |
| `word-like-notes.html` | One table among a caption paragraph and two footnote paragraphs, with formatted text and an Office wrapper |
| `word-like-notes.tsv` | Matching rectangular tab-separated block surrounded by caption and footnote lines without tabs |
| `word-office-notes.html` | Handwritten 6×7 Sharpless table with `<thead>`, `MsoNormalTable`, conditional comments, fragment markers, paragraph cells and formatted surrounding notes |
| `word-office-notes.tsv` | Matching plain text with incidental SMILES candidates (`MW`, `(+)-DET`, `CH2Cl2`), a caption and a footnote; tests the app's paste decision as well as parsing |
| `excel-overflow-notes.html` | Handwritten 6×7 Sharpless grid between single-label caption/footnote rows, `colspan=6` / `colspan=2` with `mso-ignore:colspan`, fragment markers inside the table and two `#######` Density cells; no `x:num` attributes |
| `excel-overflow-notes.tsv` | Matching full eight-row grid with six trailing tabs on the caption/footnote rows, CR-only record separators and real Density values for same-grid recovery |
| `google-docs-like.html` | `<meta charset>`, the `docs-internal-guid` `<b>` wrapper, `<colgroup>`, inline styles, a merged cell |
| `google-sheets-like.html` | `<google-sheets-html-origin>` wrapper, `data-sheets-*` attributes, right-aligned numbers |
| `excel-quoted.tsv` | Excel plain text with quoted fields holding a tab, a newline and doubled quotes |

The Office notes pairs use our own caption and footnote wording and the existing synthetic Sharpless
data. They reproduce structural features investigated in local clipboard captures; no capture bytes
are included. Tests retain refusals for limits and ambiguous inputs, and only recover overflow values
when the entire HTML/TSV grid, including the padded note rows, matches.

## Real Windows Office captures

Source: Office 16 (Excel and Word 16.0.20527.20088, Microsoft 365 x64), Windows 11
26300.9711, captured **2026-10-30**, commit `83602068`, under
`packages/fixtures/tables/windows-office-dumps-2026-10-30/`. Only the two formats used
by table parsing are included here, as UTF-8 text; no binary, RTF, CSV, or workbook
files are copied.

| Fixture pair | Source folder | Structure |
|---|---|---|
| `windows-real-excel.html` / `.txt` | `excel-copy/` | Excel A1:C7; merged caption and footnote; four Density cells displayed as `##` in HTML |
| `windows-real-word-plain.html` / `.txt` | `word-copy-plain/` | Word table with positional `mso-yfti-firstrow`, no `thead` or repeat-header marker |
| `windows-real-word-repeat.html` / `.txt` | `word-copy-repeat/` | Word repeat headers; `thead` contains both the merged caption and the column headings |

The HTML is exactly `49330-HTML_Format.bin` sliced by its `StartHTML` and `EndHTML`
byte offsets, matching `windows_clipboard.rs` / `parse_cf_html`: the CF_HTML
`Version`/offset header is removed, while the full document and fragment comments
are retained. Existing `file:///C:/Users/user_/…` paths remain redacted as supplied;
no paths have been added. The `.txt` files are `13-CF_UNICODETEXT.bin` decoded as
UTF-16LE up to the first NUL and saved as UTF-8, retaining CRLF and tabs.
The native payload names are `text/html` and `text/plain`. `Csv` may appear in
`types`, but the Windows reader does not fetch it into `textItems`.

The actual captures contain **the solvent table**, not the synthetic reagent table:
caption `Table 1. Solvent properties`; headings `Solvent`, `bp (°C)`, `Density (g/mL)`;
four data rows (CH2Cl2, Ethanol, Mercury, Water); footnote `a Densities at 20 °C.`.
They contain no subscript/superscript markup. Excel's CF_UNICODETEXT supplies
Density as **1.33, 0.79, 13.55, 1.00** (formatted numbers, not the hidden HTML `##`
or full-precision workbook values). Word supplies **1.33, 0.7914, 13.546, 1**.
All three already produce one header, the caption, four data rows × three columns,
one footnote, and no warnings with the parser at the parent commit; no parser
change is needed for these captures.

The hand-written `windows-word.html` and `windows-excel.html` fixtures are retained:
they cover the seven-column reagent table, and the other synthetic Word fixtures
continue to cover subscript/superscript text absent from these captures.
