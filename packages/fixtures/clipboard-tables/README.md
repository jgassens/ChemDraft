# Clipboard table fixtures

These files are **synthetic stand-ins**. They are hand-written to follow the documented structure of what
each application puts on the clipboard when a table is copied; none of them is a real capture.

Every fixture in this directory must stay synthetic; never add a file saved or captured from another
program here. A passing test proves the parser reads that structure, not that a given application
produces it on macOS or Windows.

The table content is the Sharpless reagent table in `../tables/sharpless-reagent-table.json`.

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
