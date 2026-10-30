# Office Phase 0: Windows results

Run on 2026-10-30 by the Windows test session, following `scripts/office-spike/RUNBOOK-windows.md` at
`claude/office-spike` 37a4ab2e (worktree `C:\dev\office-spike`, matching origin).

| | Version |
|---|---|
| Windows | 11, build 26300.9711 |
| Word | Microsoft 365, 16.0.20527.20088 (x64) |
| PowerPoint | Microsoft 365, 16.0.20527.20088 (x64) |
| Node | v24.19.0 |

Both apps were signed in. No licensing, Protected View, repair, Save As or folder-chooser dialog appeared in any
trial. Every save was Ctrl+S in place. The only Office prompts were "Pasting is getting smarter" / "Pasting
just got easier" and "Make your documents more accessible" tips, which were left alone.

## Findings

1. **Given a choice, Word and PowerPoint both take the SVG, and the SVG loses the carrier.** With
   COMBINED-WIN (W1, P1), both pasted a vector graphic and saved a rewritten 5,889-byte SVG (the source was
   61,453 bytes) with no metadata. Word adds a re-encoded PNG fallback (664×744 at 192 DPI); PowerPoint
   stores the SVG only.
2. **With PNG only, both keep the PNG byte-for-byte, carrier included** (S1 zTXt, S6 zTXt at 384 DPI, S7
   iTXt). Both apps honour the PNG's DPI: the 384-DPI file pasted at a quarter of the size.
3. **Copy-back from a PNG-pasted picture** (W-S1, P-S1): the top-level `PNG` format is re-rendered
   (938×1048 / 150 DPI) with no carrier. The original PNG, with a valid zTXt, is inside the
   **`Art::GVML ClipFormat`** ZIP (`clipboard/media/image1.png`). PowerPoint's `CF_ENHMETAFILE` also embeds
   the original PNG (see the inspector note).
4. `image/png` alone (S2) and `application/pdf` alone (S5) paste nothing in either app. `CF_DIBV5` alone
   (S3) pastes a re-encoded PNG with no carrier, as expected for the control.
5. **Pasting over a selected picture adds a second picture** in both apps (WB, PB). Ctrl+Z removed the new
   picture and Ctrl+Y restored it.

## Trials

"Saved" carriers come from `inspect-<trial>-saved.tsv`. Copy-back carriers come from
`inspect-<trial>-copyback.tsv`.

| Trial | OPEN-OK | Bar / dialog | Ctrl+V showed | Ctrl+S, no dialog | INSPECT exit | Saved carrier | Reopened same / DUMP-OK | Copy-back carrier |
|---|---|---|---|---|---|---|---|---|
| Preflight | n/a | n/a | n/a | n/a | 0 | PNG, SVG, PDF and JSON valid | DUMP-OK | n/a |
| W1 COMBINED | yes | paste tip | sharp vector graphic (Graphics Format) | yes | 0 | none (PNG re-encoded, SVG rewritten) | same / yes | none |
| W-S1 PNG | yes | paste tip | picture, 600×671 at 96 DPI | yes | 0 | zTXt valid | same / yes | zTXt valid in Art::GVML only |
| W-S2 image/png | yes | none | nothing | not saved | n/a | n/a | n/a | n/a |
| W-S3 CF_DIBV5 | yes | none | picture | yes | 0 | none (control) | n/a | n/a |
| W-S4 SVG | yes | none | vector graphic | yes | 0 | none (SVG rewritten + PNG fallback) | n/a | n/a |
| W-S5 PDF | yes | none | nothing | not saved | n/a | n/a | n/a | n/a |
| W-S6 PNG 384 DPI | yes | none | picture at ¼ size | yes | 0 | zTXt valid, 384 DPI kept | n/a | n/a |
| W-S7 PNG iTXt | yes | none | picture | yes | 0 | iTXt valid | n/a | n/a |
| WB replace | yes | none | a second picture; the old one moved to page 2 | yes | 0 | new PNG zTXt valid; old PNG + SVG kept | n/a | n/a |
| P1 COMBINED | yes | accessibility tip | vector graphic (Graphics Format) | yes | 0 | none (SVG rewritten, no PNG) | same / yes | none |
| P-S1 PNG | yes | none | picture | yes | 0 | zTXt valid | same / yes | zTXt valid in Art::GVML; EMF holds the original PNG; inspect exit 1 (false positive, below) |
| P-S2 image/png | yes | none | nothing | not saved | n/a | n/a | n/a | n/a |
| P-S3 CF_DIBV5 | yes | none | picture | yes | 0 | none (control) | n/a | n/a |
| P-S4 SVG | yes | none | vector graphic | yes | 0 | none (SVG rewritten) | n/a | n/a |
| P-S5 PDF | yes | none | nothing | not saved | n/a | n/a | n/a | n/a |
| P-S6 PNG 384 DPI | yes | none | picture at ¼ size | yes | 0 | zTXt valid, 384 DPI kept | n/a | n/a |
| P-S7 PNG iTXt | yes | none | picture | yes | 0 | iTXt valid | n/a | n/a |
| PB replace | yes | none | larger PNG on top; the slide holds two `<p:pic>` | yes | 0 | new PNG zTXt valid; old SVG kept | n/a | n/a |

The S2 and S5 files are unmodified copies of the blanks, because nothing pasted.

## Inspector false positive: P-S1 copy-back EMF

`inspect.mjs` exited 1 on `dumps\P-S1-reopened`, with this row:

```
14-CF_ENHMETAFILE.bin  emf  emf GDI comment: Expected property name or '}' in JSON at position 1 (line 1 column 2); expect=false
```

`emf.mjs` scans every GDI comment for `/chemdraft\0|chemdraft:|chemdraft-spike/`. PowerPoint's EMF+ records
embed the pasted PNG, whose zTXt keyword `chemdraft\0` matches, so the scanner JSON-parses compressed bytes.
This is not a broken carrier. The PNG at byte offset 640 of the EMF is the original fixture byte for byte:
19,783 bytes, SHA-256 `6f1bb356d480f559f966227d8e92b8dd19e81c239a28b8ede265015ced85198e` (the same as
`png-ztxt.png`), and `inspect.mjs` reports `png zTXt: valid; expect=true` for it. It is saved as
`evidence\P-S1-reopened-emf-offset640.png`. The inspector was not patched here; the fix is tracked separately.

## Run notes

- **Helper-script quoting incident.** The runbook commands were run through small helper scripts from a
  bash shell.
  - In one helper, `\$` inside bash double quotes became a literal `$`. So the first W-S1 copy step wrote
    `files\blank.docx`, and Word reported "couldn't find … files$name.doc"; its only button, OK, was pressed.
    The stray `blank.docx` was byte-identical to `_blank\blank.docx` and was deleted. The opener was then
    rewritten as a PowerShell script with parameters, and W-S1 was redone from a fresh copy.
  - The same problem made the inspect helper write every TSV to one file, `C:\dev\office-phase0$2`, each run
    overwriting the last. That file was deleted. Every TSV was then regenerated from the saved files and
    dumps; inspection is deterministic.
  - The exit codes in the table come from the regenerated runs.
- `win-clipboard.ps1 -Write` appends to whatever is already on the clipboard, so the clipboard was cleared
  first (`[System.Windows.Forms.Clipboard]::Clear()`) before every write. Writes and dumps ran in an STA
  Windows PowerShell 5.1 with `-ExecutionPolicy Bypass` for that process only.
- The runbook assumes a ChemDraft checkout at `C:\dev\check`. On this machine that folder is a build-output
  folder, so the existing worktree `C:\dev\office-spike` was used, as the runbook's "already exists" note
  allows.
- After W1 was reopened, the first Ctrl+Home / Shift+Right did not reach the document while Word's paste tip
  was showing. One click on an empty area of the page fixed it. Selection then used keys only.
- A hidden `microsoft.aad.brokerplugin.exe` window was present during the run. It was not touched.
