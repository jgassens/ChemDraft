# Office embedded-object preview probe

This Slice 2a probe tests what Word and PowerPoint display, print, and retain when a
ChemDraft object uses an unregistered test class. It uses Node 20 or later and needs
no npm dependencies. The class is `ChemDraft.Structure.Probe`
(`{9555AC51-4097-416B-8588-E2BA35E8AF94}`). Leave it unregistered for the run.

- [emf-writer.mjs](emf-writer.mjs) writes the dual EMF. Its EMF+ image contains the original PNG
  bytes. The GDI fallback draws the same raster as a top-down 32-bit DIB, composited onto white.
  The PNG decoder accepts noninterlaced 8-bit grayscale, RGB, indexed, and RGBA PNGs.
- [cfb-writer.mjs](cfb-writer.mjs) writes and reads v3 compound storage up to 50 MiB, including
  mini streams and DIFAT sectors. The probe contains `\x01CompObj`, `\x01Ole`, and
  `ChemDraftDocument`. The initial preview lives in the OOXML package. The inspector lists any
  OLE presentation cache streams Office adds on save.
- [make-ole-docs.mjs](make-ole-docs.mjs) generates `preview.emf`, `oleObject1.bin`,
  `ole-word.docx`, `ole-ppt.pptx`, and `manifest.json`. The manifest records the hashes of
  the input PNG and JSON, the EMF, and the compound file.
- [zip-compat.mjs](zip-compat.mjs) uses the shared ZIP writer when Node supplies `zlib.crc32`
  and a dependency-free ZIP writer on earlier supported versions.
- [inspect-ole.mjs](inspect-ole.mjs) lists embedding and preview parts, relationship sources,
  the root CLSID, stream names and sizes, and comparison results.
- [ole.test.ts](ole.test.ts) verifies PNG decoding, the EMF records, compound storage, and both packages.

## Generate the baseline

Run this from the repository root, ideally on the Office test machine so the fresh files have
no download or email provenance.

```text
node scripts/office-spike/ole/make-ole-docs.mjs --out ole-baseline
node scripts/office-spike/ole/inspect-ole.mjs ole-baseline/ole-word.docx --json
node scripts/office-spike/ole/inspect-ole.mjs ole-baseline/ole-ppt.pptx --json
```

The default inputs are
[carriers/png-itxt.png](../../../packages/fixtures/office/carriers/png-itxt.png) and
[sample-document.json](../../../packages/fixtures/office/sample-document.json).
Use `--png <carrier.png> --json <payload.json>` to override them. The writer uses the PNG's
rounded DPI when it declares equal horizontal and vertical densities and uses 96 DPI otherwise.
The manifest records the image's pixel dimensions and its display size in inches.

## Run in Word and PowerPoint

Repeat these steps in Windows Word, Windows PowerPoint, Mac Word, and Mac PowerPoint. Record
the OS version, Office build, and any relevant policy or Protected View banner. Start each run
from a fresh baseline file.

1. Open `ole-word.docx` in Word or `ole-ppt.pptx` in PowerPoint. Record any repair or conversion
   prompt. In editing view record what appears at 100% and 200% zoom. Compare fine strokes and
   text with the source PNG at a similar scale. Take screenshots of the display or placeholder.
2. Print to PDF (Microsoft Print to PDF on Windows, or Print → PDF → Save as PDF on macOS).
   Record the paper size, orientation, and scale. Inspect the PDF at high zoom and record whether
   the preview is visible and sharp. Count the embedded image pixels with `pdfimages -list` if
   available, or use a PDF image inspector. Compare against the manifest's pixel dimensions
   after accounting for any print scaling. Record the pixel dimensions and effective PPI where
   measurable.
3. Double-click the object in normal editing view. Expect an error about starting or editing
   the object because the server is unregistered. Record the exact message or what the click
   does. For Windows PowerPoint, record the effective **OLE Active Content** policy if known and
   any activation differences in Slide Show. A missing-server result alone leaves the policy's
   activation behavior inconclusive.
4. Save As a distinct DOCX or PPTX in its original format, close it, then reopen the saved copy.
   Repeat the view and zoom checks after reopening. Run the inspector against the saved copy
   with the original manifest. Keep the saved document, PDF, screenshots, and inspection JSON.

```text
node scripts/office-spike/ole/inspect-ole.mjs word-windows-saved.docx --manifest ole-baseline/manifest.json --json
node scripts/office-spike/ole/inspect-ole.mjs ppt-mac-saved.pptx --manifest ole-baseline/manifest.json --json
```

If `--manifest` is omitted, the inspector looks next to the input package for `manifest.json`.
Comparison fields are `null` when no baseline is available. Record whether the embedding has
a live relationship, the probe CLSID, and the original document hash. Also record the preview
part's type and size, and whether the EMF or its internal PNG kept the original hash. A media
part with no relationship may be left over from an earlier save. `changed-or-re-rendered`
means the original bytes were unavailable in the checked representation. Use the display and
print observations to assess what Office rendered.

| OS and version | Office host and build | Policy or prompts | Visible at 100% and 200% | Print pixels, PPI, and quality | Double-click result | Visible after reopen | OLE part, CLSID, and JSON hash | Preview part, bytes, and hash state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Windows | Word | | | | | | | |
| Windows | PowerPoint | | | | | | | |
| macOS | Word | | | | | | | |
| macOS | PowerPoint | | | | | | | |
