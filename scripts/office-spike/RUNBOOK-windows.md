# Office Phase 0: Windows runbook (≈45 min)

This runbook measures whether Word and PowerPoint **for Windows** keep the hidden ChemDraft drawing that a
pasted picture carries. It is the Windows twin of the macOS run recorded in
[`docs/architecture/office-round-trip.md`](../../docs/architecture/office-round-trip.md). The tools are
described in [README.md](README.md).

**Prerequisites**
- Run in the built-in Windows PowerShell 5.1 or in PowerShell 7 on Windows.
- Word and PowerPoint for Windows (desktop apps), installed and signed in, on the machine that runs this.
- Node 22.2 or newer (`node --version`); `blank-docs.mjs` needs `zlib.crc32`.
- A ChemDraft checkout at `C:\dev\check` whose `origin` is the GitHub repository.

**How it works (same as the macOS run):** each trial copies a ready-made blank file, opens it, pastes,
saves **in place** with **Ctrl+S** (the file already exists, so no Save As dialog), closes with **Ctrl+W**,
and reopens it. Selecting the picture uses keys only.

**Rules**
- **If a Save As dialog or any folder chooser appears, press nothing.** Screenshot it, stop, and report.
- An ordinary "Do you want to save changes?" box for a file that **already exists** may be answered
  **Save**. That saves in place, which is harmless.
- **Protected View** (a yellow bar saying the file came from the internet) means the file was copied from
  elsewhere instead of being made on this machine. Stop and report; Ctrl+S won't save in place in Protected
  View.
- Nothing may touch the clipboard between a `-Write` and its Ctrl+V, or between a Ctrl+C and its `-Dump`.
- Copy every command exactly. Run them all in **one PowerShell window**, left open (Step 0 sets the
  execution policy for that window only).

---

## Step 0: setup (3 min)

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
git -C C:\dev\check fetch origin claude/office-spike
git -C C:\dev\check worktree add --detach C:\dev\office-spike origin/claude/office-spike
cd C:\dev\office-spike
git log --oneline -1
node scripts\office-spike\blank-docs.mjs C:\dev\office-phase0\files\_blank
New-Item -ItemType Directory -Force C:\dev\office-phase0\dumps | Out-Null
"SETUP-OK"
```

Expect the commit line, two paths (`blank.docx`, `blank.pptx`), then `SETUP-OK`. If `C:\dev\office-spike`
already exists from an earlier try, skip the `worktree add` line and run
`git -C C:\dev\office-spike switch --detach origin/claude/office-spike` instead.

Record: Windows version (`winver`), and Word's and PowerPoint's version from **File ▸ Account ▸ About**.

**Preflight** (proves the tools work before Office time is spent):
```powershell
.\scripts\office-spike\win-clipboard.ps1 -Write @('PNG=packages\fixtures\office\carriers\png-ztxt.png','image/png=packages\fixtures\office\carriers\png-ztxt.png','CF_DIBV5=packages\fixtures\office\carriers\png-ztxt.png','image/svg+xml=packages\fixtures\office\carriers\svg-metadata.svg','application/pdf=packages\fixtures\office\carriers\pdf-embedded.pdf','application/x-chemdraft-selection+json=packages\fixtures\office\sample-envelope.json'); "WRITE-OK"
.\scripts\office-spike\win-clipboard.ps1 -Dump C:\dev\office-phase0\dumps\00-preflight; "DUMP-OK"
node scripts\office-spike\inspect.mjs C:\dev\office-phase0\dumps\00-preflight --expect 44b8cd5066b705b079a87503c8e5f61042ba03c1927fd9a02e90bd20d10d73dc
```
Expect `png zTXt: valid`, `pdf embedded file: valid`, `svg metadata: valid` and `private JSON: valid`
(the DIB has no carrier by design). **If WRITE or DUMP fails, stop** and record the error.

That six-format write is **COMBINED-WIN**: what ChemDraft's Windows writer puts on the clipboard, plus a PDF
to see whether Windows Office will use one.

## W1: Word, COMBINED-WIN, full cycle (≈6 min)

1. ```powershell
   Copy-Item C:\dev\office-phase0\files\_blank\blank.docx C:\dev\office-phase0\files\W1.docx -Force; Start-Process winword -ArgumentList '"C:\dev\office-phase0\files\W1.docx"'; "OPEN-OK"
   ```
   Wait for Word with **W1** in the title. Screenshot. Note any bar or dialog.
2. Run the COMBINED-WIN `-Write` line from the preflight.
3. Click Word's title bar (not the page), then **Ctrl+V**. Screenshot. Record what appeared and how sharp it is.
4. **Ctrl+S**, wait 2 s, screenshot (no dialog), then **Ctrl+W**.
5. ```powershell
   node scripts\office-spike\inspect.mjs C:\dev\office-phase0\files\W1.docx --expect 44b8cd5066b705b079a87503c8e5f61042ba03c1927fd9a02e90bd20d10d73dc --out C:\dev\office-phase0\inspect-W1-saved.tsv; "INSPECT-OK exit=$LASTEXITCODE"
   ```
6. `Start-Process winword -ArgumentList '"C:\dev\office-phase0\files\W1.docx"'`. Screenshot: same picture?
7. **Ctrl+Home**, then **Shift+Right** (selects the inline picture). Screenshot: selection frame. **Ctrl+C**.
8. ```powershell
   .\scripts\office-spike\win-clipboard.ps1 -Dump C:\dev\office-phase0\dumps\W1-reopened; "DUMP-OK"; node scripts\office-spike\inspect.mjs C:\dev\office-phase0\dumps\W1-reopened --expect 44b8cd5066b705b079a87503c8e5f61042ba03c1927fd9a02e90bd20d10d73dc --out C:\dev\office-phase0\inspect-W1-copyback.tsv; "INSPECT-OK exit=$LASTEXITCODE"
   ```
9. **Ctrl+W**.

## P1: PowerPoint, COMBINED-WIN, full cycle (≈6 min)

Same as W1, except:
1. `Copy-Item C:\dev\office-phase0\files\_blank\blank.pptx C:\dev\office-phase0\files\P1.pptx -Force; Start-Process powerpnt -ArgumentList '"C:\dev\office-phase0\files\P1.pptx"'; "OPEN-OK"`.
   Expect one empty white slide; note any repair prompt.
3. Click an **empty** area of the big slide, then **Ctrl+V**.
5. Inspect, using `P1.pptx` → `inspect-P1-saved.tsv`.
6. `Start-Process powerpnt -ArgumentList '"C:\dev\office-phase0\files\P1.pptx"'`
7. Click an empty area of the slide, then **Ctrl+A** (selects the picture), then **Ctrl+C**.
8. Dump to `P1-reopened` and inspect to `inspect-P1-copyback.tsv`.

## Singles: one format at a time (≈1½ min each; Word, then PowerPoint)

For each row do W1 steps 1–5 with the row's file name and this write command (from `C:\dev\office-spike`):
`.\scripts\office-spike\win-clipboard.ps1 -Write @('<the row's spec>'); "WRITE-OK"`.
For PowerPoint use `blank.pptx`, `powerpnt`, and a `P-` file name.

| Trial | Word / PowerPoint file | Spec | Why |
|---|---|---|---|
| S1 | `W-S1.docx` / `P-S1.pptx` | `PNG=packages\fixtures\office\carriers\png-ztxt.png` | the registered "PNG" format Office reads |
| S2 | `W-S2.docx` / `P-S2.pptx` | `image/png=packages\fixtures\office\carriers\png-ztxt.png` | the web-style PNG name |
| S3 | `W-S3.docx` / `P-S3.pptx` | `CF_DIBV5=packages\fixtures\office\carriers\png-ztxt.png` | control: a raw bitmap, no carrier expected |
| S4 | `W-S4.docx` / `P-S4.pptx` | `image/svg+xml=packages\fixtures\office\carriers\svg-metadata.svg` | does Windows Office take SVG? |
| S5 | `W-S5.docx` / `P-S5.pptx` | `application/pdf=packages\fixtures\office\carriers\pdf-embedded.pdf` | probe: expected to paste nothing |
| S6 | `W-S6.docx` / `P-S6.pptx` | `PNG=packages\fixtures\office\carriers\png-ztxt-384dpi.png` | resolution honoured? |
| S7 | `W-S7.docx` / `P-S7.pptx` | `PNG=packages\fixtures\office\carriers\png-itxt.png` | iTXt variant |

Inspect each into `inspect-<file without extension>-saved.tsv`. If a format pastes **nothing**, record
that, Ctrl+W, and go on.

**Copy-back of a PNG-pasted picture** (also unmeasured on macOS): after W-S1 and P-S1, reopen the file,
select the picture as in W1/P1 step 7, Ctrl+C, then dump to `W-S1-reopened` / `P-S1-reopened` and inspect
into `inspect-W-S1-copyback.tsv` / `inspect-P-S1-copyback.tsv`.

## Replace test: paste over a selected picture (≈5 min, only if time)

**Word (WB):** `Copy-Item C:\dev\office-phase0\files\W1.docx C:\dev\office-phase0\files\WB.docx -Force`, open
it, **Ctrl+Home**, **Shift+Right**, write S1 (PNG only), **Ctrl+V**. Screenshot: one picture or two?
**Ctrl+Z** (screenshot), **Ctrl+Y**, **Ctrl+S**, **Ctrl+W**, inspect into `inspect-WB-saved.tsv`.
**PowerPoint (PB):** the same from `P1.pptx` → `PB.pptx`, selecting with a click on an empty area then Ctrl+A.

## Record

Write `C:\dev\office-phase0\RESULTS.md`: the Windows and Office versions, then one row per trial (OPEN-OK,
any bar or dialog, what Ctrl+V showed, Ctrl+S without a dialog, INSPECT exit code, and for W1/P1/S1 whether
the reopened picture looked the same and DUMP-OK). Don't copy the inspect tables; they are in the `.tsv`
files. Keep the **whole `C:\dev\office-phase0` folder**: the saved files and dumps are what the analysis
reads, so send it back the way the person coordinating the run asks.

**Not covered here, on purpose:** an EMF carrier. The spike has no EMF producer yet; build one only if
Windows Office keeps neither the PNG nor the SVG carrier.
