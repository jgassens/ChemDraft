# Office cross-platform test: Mac files on Windows

Run on 2026-10-30 by the Windows test session, on `review/office-crossplatform-mac-files` 014b653d (worktree
`C:\dev\office-spike`, detached). Windows 11 26300.9711; Word and PowerPoint 16.0.20527.20088 (Microsoft 365,
x64); Node v24.19.0. Every inspect used `--expect 44b8cd5066b705b079a87503c8e5f61042ba03c1927fd9a02e90bd20d10d73dc`.

Question: does a Mac-made ChemDraft picture (an EMF wrapping the PDF carrier) stay recoverable on Windows when
the document is opened, copied from, edited and saved?

**Answer: yes, in the saved file and in the Art::GVML copy-back.** Word and PowerPoint for Windows keep the Mac
EMF byte for byte (1,948,032 bytes) through an edit and save, and its `EMF multiformat[0] (PDF)` carrier stays
valid. On copy-back, both pass the original EMF through inside `Art::GVML ClipFormat`, where the carrier is
valid. No top-level clipboard format (EMF, PNG, SVG, GIF, JPEG) carries it.

## Steps

| Step | What showed | Bar / dialog | DUMP-OK | Inspect exit | Entries with expect=true |
|---|---|---|---|---|---|
| W0 setup | HEAD 014b653d; the two Mac files copied. Neither copy had a Zone.Identifier, so `Unblock-File` changed nothing. | none | n/a | 0 (`inspect-before.tsv`) | XW-mac.docx and XP-mac.pptx: `…image1.emf > EMF multiformat[0] (PDF)` |
| XW 1 open | Caffeine and the ethanol → acetaldehyde reaction, small on the page, clean at screen resolution | none | n/a | n/a | n/a |
| XW 2–3 copy-back | Ctrl+Home, Shift+Right selected the picture (Picture Format tab) | none | yes | 0 (`inspect-XW-copyback.tsv`) | `clipboard/media/image1.emf > EMF multiformat[0] (PDF)` only. The top-level EMF is a Word re-render (an EMF+ image of a 40 KB PNG) with no carrier; the PNG (975×1262), SVG, GIF and JPEG have none. |
| XW 4 edit + save | Ctrl+End, Enter, "x" (1 word), Ctrl+S saved in place | none | n/a | n/a | n/a |
| XW 5 saved | n/a | n/a | n/a | 0 (`inspect-XW-saved.tsv`) | `word/media/image1.emf > EMF multiformat[0] (PDF)`; the EMF is unchanged at 1,948,032 bytes |
| XP 1 open | The same structure, clean at 133% zoom | none | n/a | n/a | n/a |
| XP 2–3 copy-back | A click on an empty slide corner, then Ctrl+A, selected the picture (Picture Format) | none | yes | 0 (`inspect-XP-copyback.tsv`) | `clipboard/media/image1.emf > EMF multiformat[0] (PDF)` only. The top-level EMF wraps a re-encoded 1,939,168-byte EMF with no carrier. |
| XP 4 edit + save | Ctrl+M added slide 2; Ctrl+S saved in place | none | n/a | n/a | n/a |
| XP 5 saved | n/a | n/a | n/a | 0 (`inspect-XP-saved.tsv`) | `ppt/media/image1.emf > EMF multiformat[0] (PDF)`; the EMF is unchanged at 1,948,032 bytes |

## Notes

- **PowerPoint renders the Mac EMF to a blank raster on copy-back.** Its top-level `PNG` is 870×1125 but only 278
  bytes, a single colour. Its `image/svg+xml` (792 bytes) wraps a one-colour PNG. Pasting that copy into an app
  that prefers PNG or SVG would show an empty picture. Word's copy-back renders are normal (PNG 26 KB, SVG 17 KB).
- Word's paste-tip callout did not appear in this run. Key-only selection worked after one click on an empty area.
- Writes and dumps ran in an STA Windows PowerShell 5.1 with `-ExecutionPolicy Bypass` for that process only.
  Nothing touched the clipboard between each Ctrl+C and its dump.
- A hidden `microsoft.aad.brokerplugin.exe` window was present during the run. It was not touched.
