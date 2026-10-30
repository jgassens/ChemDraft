# Office picture round trip: Phase 0

## Purpose

ChemDraft wants a structure pasted into Microsoft Word or PowerPoint to stay editable. Every picture
ChemDraft puts on the clipboard carries the ChemDraft drawing hidden inside the picture file; this
hidden copy is called a **carrier**. Phase 0 measured whether Office on macOS and Windows keeps it before product code
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
write them. COMBINED-WIN offered six Windows formats: registered `PNG`, `image/png`, CF_DIBV5
(an uncompressed bitmap), `image/svg+xml`, `application/pdf` and ChemDraft's private JSON.

## Environment

The macOS measurements were made on 2026-10-29 with macOS 26.7.1 (25G241), Microsoft Word 16.114.2 (build 16.114.26102345) and PowerPoint 16.114.1 (build 16.114.26102031). The versions were read from the installed app bundles (`CFBundleShortVersionString` and `CFBundleVersion`), not from the apps' About boxes.

The Windows measurements were made on 2026-10-30 with Windows 11 build 26300.9711, Word and
PowerPoint Microsoft 365 16.0.20527.20088 (x64), and Node v24.19.0. Both apps were signed in.
The Windows test session followed `scripts/office-spike/RUNBOOK-windows.md` at
`claude/office-spike` commit `37a4ab2e`; its raw results are in
`scripts/office-spike/results/windows-2026-10-30/` on branch
`review/office-phase0-windows-results`, commit `c2083844`.

## Results

On macOS, both apps kept the tested PNG and PDF carriers in saved files; neither pasted SVG alone.
On Windows, both kept PNG carriers but removed SVG metadata, and neither pasted PDF alone.
All results were verified with `inspect.mjs --expect`; “kept” means the recovered drawing was
byte-identical to the one pasted.

| Case | macOS: Word and PowerPoint | Windows: Word and PowerPoint |
| --- | --- | --- |
| COMBINED | Both pasted the PDF as a crisp vector picture. Each saved file held one 1,948,032-byte EMF, at `word/media/image1.emf` or `ppt/media/image1.emf`. Its `EMR_COMMENT` `GDIC` multi-format record (`MS-EMF EMR_COMMENT_MULTIFORMATS`) contained the original PDF byte-identical; a GDIC record is a standard EMF comment that can carry the same picture in other formats, here a PDF; carrier kept. | Both pasted SVG as a vector graphic. The saved SVG was rewritten from 61,453 bytes to 5,889 bytes without metadata; carrier lost. Word also saved a re-encoded 664×744 PNG at 192 dpi as a fallback; PowerPoint saved only the SVG. |
| PNG alone: zTXt, iTXt, 384 dpi | Saved as the same PNG byte-identical; carrier kept. The 384 dpi PNG pasted physically smaller: Office honours its resolution. | Saved byte-identical in both apps; carrier kept. The 384 dpi PNG pasted at a quarter of the size: Office honours its resolution. |
| PDF alone: embedded file and catalog key | Saved as an EMF wrapping the original PDF byte-identical; both carriers kept. | Nothing pasted with `application/pdf`. |
| SVG alone | Nothing pasted. | Both pasted a vector graphic and saved the same rewritten SVG without metadata; carrier lost. Word added the PNG fallback. |
| image/png alone | Not applicable: Windows clipboard format | Nothing pasted. |
| CF_DIBV5 alone | Not applicable: Windows clipboard format | Both pasted a re-encoded PNG without a carrier, as expected for this control. |
| Copy back selected picture after save and reopen | Original PDF and carrier recovered; see below. | PNG paste: original PNG and carrier recovered from GVML; see below. COMBINED paste: no carrier recovered. |
| Copy back whole Word document, unsaved | PDF rendered again without the carrier; RTF contained the original PDF in EMF pictures; see below. | Not measured |
| Paste over a selected picture | Added a second picture in both apps; see below. | Added a second picture in both apps; Word moved the old picture to page 2 and PowerPoint stacked a second `<p:pic>`. Undo removed the new picture and redo restored it. |
| Prompts with blank files | No save dialogs, repair prompts or Protected View prompts appeared. | No Save As, repair, Protected View or licensing prompt appeared; only Office tip bars (“Pasting is getting smarter”, accessibility tips). Every save was Ctrl+S in place. |

On macOS, after save and reopen, selecting the picture and copying it back used Cmd+Home, Shift+Right, Cmd+C
in Word; in PowerPoint it used Cmd+A on the slide, then Cmd+C. The clipboard's `com.adobe.pdf` was
the original PDF byte-identical, with a valid carrier. `com.microsoft.Art--GVML-ClipFormat` was a
GVML zip (Office's own zip-based clipboard format for drawings) whose `clipboard/media/image1.emf`
wrapped the same PDF. The other pictures were fresh renders without the hidden drawing: Word's
copy-back had `public.png`, `public.tiff` and `public.jpeg`, and PowerPoint's had only `public.tiff`.
Word also advertised `com.microsoft.image-svg-xml` but supplied no data.

Copying a whole unsaved Word document with Cmd+A, Cmd+C gave a re-rendered `com.adobe.pdf` without
a carrier. Its `public.rtf` (7.9 MB) held `\emfblip` and `\wmetafile8` picture groups, each
containing the same EMF and therefore the original PDF byte-identical.

On Windows, after save and reopen, copying a picture pasted as PNG produced a fresh 150 dpi
render without a carrier in the top-level PNG. The `Art::GVML ClipFormat` zip held
`clipboard/media/image1.png`, the original PNG byte-identical with a valid carrier, in both apps.
For the tested COMBINED paste on macOS, GVML held an EMF wrapping the original PDF; for the tested
PNG-only paste on Windows, GVML held the original PNG. PowerPoint also put the original PNG in its `CF_ENHMETAFILE` (an EMF), inside an EMF+
image object at byte 640, followed by one zero byte of padding. EMF+ is the newer set of drawing
records Office stores inside EMF comment records. Readers must stop at the PNG's IEND chunk because
the EMF+ object adds padding. PowerPoint also offered `Web Custom Format0`, named `ppt/shapes` in
the format map and readable by web browsers: its UTF-16 JSON `data` field is a base64 zip containing
the same original PNG with a valid carrier at `clipboard/media/image1.png`. Word offered no web
format. For a COMBINED SVG paste, no carrier survived copy-back: GVML held the rewritten SVG and,
in Word, the re-encoded PNG.

The first inspection of PowerPoint's PNG copy-back failed because `emf.mjs` searched whole EMF
comments for a ChemDraft marker and matched the PNG's own zTXt keyword inside EMF+ data; the fix
on 2026-10-30 recognises our EMF comment format only at the start of a comment and extracts EMF+
image objects as pictures, after which re-inspection exited 0 and found the carrier in both GVML
and the EMF+ image object.

On macOS, pasting over a selected picture added a second picture: Word added a second page, while PowerPoint
added a second `<p:pic>` on top, making it look like a replacement on screen. Undo and redo behaved
normally.

Word and PowerPoint for Mac write EMF files with a final `EMR_EOF` record of 16 bytes, although
MS-EMF specifies 20 bytes. Readers must accept that.

## Decisions supported by the measurements

macOS:

1. Rely on PDF with the drawing as an embedded file for Word and PowerPoint. Keep the PNG carrier,
   which also survives, and keep writing SVG for other apps.
2. For paste-back, check each source in this order: `com.adobe.pdf`, then GVML zip media, then RTF picture data, then PNG. Validate the carrier found, and fall through to the next source when a carrier is missing or fails validation.
3. Use the planned Office add-in to replace a picture with an edited version; paste-over adds a picture
   in both apps.

Windows:

1. Word and PowerPoint take SVG over PNG when both are offered and drop the carrier. ChemDraft's Copy
   must not offer `image/svg+xml` to Office on Windows unless the format-order test below shows that
   placing PNG first changes Office's choice. Rely on PNG with a zTXt or iTXt carrier, which both apps
   keep byte-identical at its stated resolution.
2. Windows Office ignores PDF and `image/png`.
3. For paste-back, check each source in order: GVML zip media, EMF+ image objects in
   `CF_ENHMETAFILE`, then the top-level PNG. Validate the carrier found and fall through when it is
   missing or invalid. PowerPoint's `ppt/shapes` web format also contains a zip holding the original
   PNG with a valid carrier. Whether Office on the web or the add-in can read it is not yet measured.
4. Use the planned add-in to replace a picture, as on macOS.
5. Windows gets a bitmap, not a vector picture, until an EMF carrier is measured.

## Not yet measured

The following remain unmeasured:

- Compress Pictures and Paste Special.
- Cropped, rotated or grouped pictures.
- Copy-back of a picture pasted as PNG on macOS.
- Whether Windows Office still takes SVG when PNG is written before SVG.
- Documents moved between macOS and Windows, and copy-back there.
- Whole-document copy on Windows.
- Pictures large enough that the EMF+ image object is split across records; only a 19,783-byte PNG
  was measured.
- Keynote and Office on the web.
- Add-in API access to picture bytes.
- An EMF carrier for Windows; no EMF producer exists yet.

## Reproduce

Follow [the office spike instructions](../../scripts/office-spike/README.md).
