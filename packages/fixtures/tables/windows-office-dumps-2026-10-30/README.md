# Windows Office table clipboard dumps (2026-10-30)

Raw clipboard dumps of one solvents table copied from Excel and Word for Windows, for the table header-row work.
Each folder holds one `<format-id>-<name>.bin` per clipboard format plus `index.json` (id, name, size, SHA-256).
They were made with `scripts/office-spike/win-clipboard.ps1 -Dump` from `claude/office-spike` 91261035. Nothing
touched the clipboard between each Ctrl+C and its dump.

Environment: Windows 11 26300.9711; Excel and Word 16.0.20527.20088 (Microsoft 365, x64).

The table:

| Row | Content |
|---|---|
| 1 | Caption `Table 1. Solvent properties`, merged across all three columns |
| 2 | Header: `Solvent` / `bp (°C)` / `Density (g/mL)` |
| 3–6 | CH2Cl2 39.6 1.33; Ethanol 78.37 0.7914; Mercury 356.7 13.546; Water 100 1.0 |
| 7 | Footnote `a Densities at 20 °C.`, merged across all three columns |

| Folder | How it was copied |
|---|---|
| `excel-copy` | Excel: A1:C7 selected (7 rows, since there are 4 data rows), Ctrl+C. The caption (A1:C1) and footnote (A7:C7) are merged. Density (C3:C6) is in Number format with 2 decimals, and the column is narrowed until Excel shows `##`, so the HTML carries `##` as those cells' display text. |
| `word-copy-plain` | Word: a native Word table made by pasting the Excel range at full width. Table Layout ▸ Select ▸ Select Table, Ctrl+C. Repeat Header Rows is off. |
| `word-copy-repeat` | The same Word table with Repeat Header Rows on for rows 1–2 (caption and header; Word only lets header rows start at the top row). The HTML has `<thead>`; the RTF has `\trhdr` on those rows. |

**Redaction:** each `49330-HTML_Format.bin` referenced Office's temporary image folder under the user profile
(`file:///C:/Users/<name>/AppData/Local/Temp/msohtmlclip1/…`). The profile name was replaced with the same-length
placeholder `user_`, so every byte offset (StartHTML, EndHTML, StartFragment, EndFragment) is still valid. The
`index.json` entry for those three files has the new SHA-256 and a `note` saying so. No other file was changed.
