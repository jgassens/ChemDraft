# Native tables

A table is a visual page object for arranging text in rows and columns. Cell contents, captions and
footnotes are rich text; they are never chemistry and a table never computes values. Formula-like
cell text remains text (see the chemistry invariants in `AGENTS.md` §7).

## Model and compatibility

`TableObjectSchema` in `packages/chem-core/src/schemas.ts` defines a version 1 object. It uses the
common page-object frame and style, plus `columns`, `rows`, `headerRowCount`, optional `caption`,
`footnotes` and `tableStyle`. Columns have stable IDs, alignment (`left`, `center`, `right` or
`decimal`), automatic or fixed width, and an automatic/off formula-formatting rule. Rows have stable
IDs and exactly one cell per column. Cells and notes contain text and rich-text spans. Table styling
selects `three-line` or `grid`, rule widths, optional bold headers, and cell padding.

The schema caps a table at 64 columns, 500 rows, 2,000 characters per cell/caption/footnote, 200
rich-text spans per cell, 200 characters for the font family, font sizes from 1 to 400 px, 200,000
characters across the table, and 50 footnotes. Fixed widths are positive and at most 4,000 px; rule
widths are 0–6 pt; padding is 0–48 px. IDs must be unique within their row or column collection,
and the header count cannot exceed the row count. `tableVersion` is the hook for future shape
migrations. The current `migrateLegacyTableObjects` hook is a no-op because there is no earlier table
shape to migrate. An unknown table version fails document validation with an unsupported/invalid
document error that identifies a file saved by a newer ChemDraft version. Released builds predating
native tables cannot open a file containing one.

## Layout and drawing

`planTableLayout` in `packages/layout-engine` is the DOM-free source of cell, caption, footnote,
column, row and rule geometry. It uses generated Core 14 Helvetica regular/bold and Symbol Greek and
arrow advance metrics. Auto columns size to their content; fixed columns retain their specified width
and may overflow. Cells do not wrap. Decimal body values split at the decimal point into two text
pieces meeting at a shared anchor; the column's decimal block is centred under its header when it
fits, and starts at the inner left edge when it does not. The layout becomes one shared page SVG
fragment for canvas, SVG and PDF, keeping the drawing geometry in step across those surfaces. Layout,
SVG fragments and bounds are cached by table object identity. Undo history keeps each prior object's
cached layout alive until that history step is discarded. This has a known memory cost for very large
tables retained in history.

## Formula subscripts

`formulaSpansForMixedText` in `document-workflow-core` recognizes formula-like portions in mixed cell
text and adds subscript spans while preserving existing styled spans. Formatting is an explicit
table-cell command with its own undo entry. Undoing it removes the formatting only; it does not undo
the cell text edit that preceded it.

## Editing

`Insert > Table…` opens the shared native Insert Table dialog; it sets row, column and header-row
counts. The floating Table inspector controls table style, applicable rule widths, header bolding and
header-row count, font family and size, the active column's alignment and formula rule, caption
on/off, adding or removing a footnote, and formatting the active cell as formula or plain text. Row
and column insertion/deletion commands are in the canvas context menu and Customize, not the
inspector; column width is adjusted by dragging or auto-fit. Caption and footnote text is edited in
place by double-clicking it. Cell text is edited in place. Tab and Shift+Tab move between cells,
arrow keys move through cells when the caret is at a text edge, Enter and Shift+Enter move between
rows, and Escape ends cell editing. Column boundaries can be dragged to resize; double-clicking a
boundary auto-fits it. Scaling a selection moves a table with the selection but preserves the table's
size. Table rotation is not offered in the UI.

## Clipboard

The shared table clipboard writer produces four interoperable flavors: editable HTML, RTF, TSV/plain
text, and ChemDraft's internal selection representation. The native writer places these through the
same per-platform clipboard path used for other rich clipboard data. HTML and RTF use explicit cell
borders only where the table has rules, no shading, zero paragraph margins, and fixed column widths.
Decimal alignment follows the shared layout rule. HTML declares Excel number formats for canonical
numbers and assigns number-like text a text number format so Excel preserves it as text. RTF omits
per-cell left and top padding because Word interprets `\clpadl` as top padding; the layout inset is
instead carried in the decimal tab stop. Paste recognizes tables in HTML and spreadsheet text,
preserving text, basic emphasis, subscripts/superscripts, alignment and widths where provided. Excel
fragment markers inside a `<table>` are handled by finding the containing table. A 1×1 HTML table is
treated as text rather than pasted as a table. When more than one source flavor is present, structured
ChemDraft selection takes precedence, then HTML table data, then tabular plain text; ordinary drawing
selection copy remains a drawing even when it contains a table.

Paste fixtures are synthetic stand-ins for Excel, Word and Google Docs clipboard payloads. They test
known HTML/CF_HTML and quoted TSV shapes, but are not captures from those applications.

## CDXML

CDXML export approximates a table as grouped text objects and lines. It emits the
`cdxml.table_approximated` warning because the result is not an editable table in the destination;
rotation is also omitted and separately warned. A native CDXML table mapping awaits a real fixture
that establishes the format's representation.

## Agent insertion

Plugin API 0.1.16 adds command-scoped `documents.insertTable(spec)` for plugins with `document.write`.
The assistant exposes the corresponding `insert_table` tool. Both accept validated table content and
insert through the document patch path, leaving the inserted table selected.

## Known limits

Tables do not support merged cells or text wrapping within cells. Not verified yet: Word, Excel,
PowerPoint, Pages and Google Docs pastes by hand.
