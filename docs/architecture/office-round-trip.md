# Office picture round trip: Phase 0

## Purpose

ChemDraft wants a structure pasted into Microsoft Word or PowerPoint to stay editable. Every picture
ChemDraft puts on the clipboard carries the ChemDraft drawing hidden inside the picture file; this
hidden copy is called a **carrier**. Phase 0 measured whether Office keeps it before product code
depends on it.

## Method

The tools in `scripts/office-spike/` write, recover and check the carriers. `mac-pasteboard.js`
writes and dumps clipboard formats on macOS; `win-clipboard.ps1` does the same on Windows.
`blank-docs.mjs` makes blank `.docx` and `.pptx` files that can be saved in place with Cmd/Ctrl+S.
`inspect.mjs` reports carriers in files and clipboard dumps, including inside EMF multi-format
comments and RTF picture data; `--expect <sha256>` checks that the recovered drawing is exactly
the one written. EMF is a Windows vector picture format, and RTF is a formatted text format.

Each trial wrote the chosen formats to the clipboard, pasted into a blank document, saved in place,
reopened it, selected and copied the picture, dumped the clipboard, and inspected both the saved
file and the dump. The carriers were PNG with a zTXt or iTXt text chunk, including at 384 dpi;
PDF with the drawing as an embedded file or as a catalog key; and SVG with a metadata element.
COMBINED means PNG, PDF, SVG and ChemDraft's private JSON together, as ChemDraft's Copy will
write them.

## Environment

The macOS measurements were made on 2026-10-29 with macOS 26.7.1 (25G241), Microsoft Word 16.114.2 (build 16.114.26102345) and PowerPoint 16.114.1 (build 16.114.26102031). The versions were read from the installed app bundles (`CFBundleShortVersionString` and `CFBundleVersion`), not from the apps' About boxes. Windows is **not yet measured**: the test machine has no Word or
PowerPoint installed, and the owner is deciding how to get them.

## Results

On macOS, both apps kept the tested PNG and PDF carriers in saved files; neither pasted SVG alone.
All results were verified with `inspect.mjs --expect`; “kept” means the recovered drawing was
byte-identical to the one pasted.

| Case | macOS: Word and PowerPoint | Windows: Word and PowerPoint |
| --- | --- | --- |
| COMBINED | Both pasted the PDF as a crisp vector picture. Each saved file held one 1,948,032-byte EMF, at `word/media/image1.emf` or `ppt/media/image1.emf`. Its `EMR_COMMENT` `GDIC` multi-format record (`MS-EMF EMR_COMMENT_MULTIFORMATS`) contained the original PDF byte-identical; a GDIC record is a standard EMF comment that can carry the same picture in other formats, here a PDF; carrier kept. | Not yet measured |
| PNG alone: zTXt, iTXt, 384 dpi | Saved as the same PNG byte-identical; carrier kept. The 384 dpi PNG pasted physically smaller: Office honours its resolution. | Not yet measured |
| PDF alone: embedded file and catalog key | Saved as an EMF wrapping the original PDF byte-identical; both carriers kept. | Not yet measured |
| SVG alone | Nothing pasted. | Not yet measured |
| Copy back selected picture after save and reopen | Original PDF and carrier recovered; see below. | Not yet measured |
| Copy back whole Word document, unsaved | PDF rendered again without the carrier; RTF contained the original PDF in EMF pictures; see below. | Not yet measured |
| Paste over a selected picture | Added a second picture in both apps; see below. | Not yet measured |
| Prompts with blank files | No save dialogs, repair prompts or Protected View prompts appeared. | Not yet measured |

After save and reopen, selecting the picture and copying it back used Cmd+Home, Shift+Right,
Cmd+C in Word; in PowerPoint it used Cmd+A on the slide, then Cmd+C. The clipboard's
`com.adobe.pdf` was the original PDF byte-identical, with a valid carrier.
`com.microsoft.Art--GVML-ClipFormat` was a GVML zip (Office's own zip-based clipboard format for
drawings) whose `clipboard/media/image1.emf` wrapped the same PDF. `public.png`, `public.tiff` and
`public.jpeg` were fresh renders without carriers. Word also advertised
`com.microsoft.image-svg-xml` but supplied no data. Word's copy-back had `public.png`, `public.tiff` and `public.jpeg`; PowerPoint's had only `public.tiff`. None carried the hidden drawing.

Copying a whole unsaved Word document with Cmd+A, Cmd+C gave a re-rendered `com.adobe.pdf` without
a carrier. Its `public.rtf` (7.9 MB) held `\emfblip` and `\wmetafile8` picture groups, each
containing the same EMF and therefore the original PDF byte-identical.

Pasting over a selected picture added a second picture: Word added a second page, while PowerPoint
added a second `<p:pic>` on top, making it look like a replacement on screen. Undo and redo behaved
normally.

Word and PowerPoint for Mac write EMF files with a final `EMR_EOF` record of 16 bytes, although
MS-EMF specifies 20 bytes. Readers must accept that.

## Decisions supported on macOS

These decisions apply to **macOS only** until Windows is measured.

1. Rely on PDF with the drawing as an embedded file for Word and PowerPoint. Keep the PNG carrier,
   which also survives, and keep writing SVG for other apps.
2. For paste-back, check each source in this order: `com.adobe.pdf`, then GVML zip media, then RTF picture data, then PNG. Validate the carrier found, and fall through to the next source when a carrier is missing or fails validation.
3. Use the planned Office add-in to replace a picture with an edited version; paste-over adds a picture
   in both apps.

## Not yet measured

The following remain unmeasured:

- Windows Word and PowerPoint.
- Compress Pictures and Paste Special.
- Cropped, rotated or grouped pictures.
- Copy-back of a picture pasted as PNG.
- Keynote and Office on the web.
- Add-in API access to picture bytes.
- An EMF carrier for Windows; no EMF producer exists yet.

## Reproduce

Follow [the office spike instructions](../../scripts/office-spike/README.md).
