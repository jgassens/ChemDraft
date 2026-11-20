# ChemDraft Office picture probe

This add-in runs the [Slice 1a feasibility gate](../../../docs/architecture/office-editing.md#slice-1a-feasibility-gate).
It reads and hashes picture bytes in the task pane. Use disposable documents and decks for the
replacement routes.

## Host and sideload

Serve this directory as static files over HTTPS using a certificate trusted by both test machines.
Keep the files together. If you use a different URL, replace every occurrence of
`https://chemdraft.ai/office-spike/` in `manifest.xml` with the HTTPS directory URL, including the
trailing slash. The host serves extensionless HTML URLs, so the manifest uses `/taskpane` for
`taskpane.html`. No build is required. The task pane loads Office.js from Microsoft's CDN and the
replacement PNG from the task pane's own origin.

### Mac

1. Quit Word and PowerPoint. Create the following folders if needed and copy `manifest.xml` into
   each.

   | App | Manifest folder |
   | --- | --- |
   | Word | `~/Library/Containers/com.microsoft.Word/Data/Documents/wef/` |
   | PowerPoint | `~/Library/Containers/com.microsoft.Powerpoint/Data/Documents/wef/` |

2. Reopen each app and open a test file. Choose **ChemDraft probe** from the **Home** ribbon. If
   Office lists the sideloaded manifest under **Insert → Add-ins → My Add-ins → Developer**, select
   it there first.

### Windows

1. Put `manifest.xml` in a shared folder accessible by UNC path, such as `\\COMPUTER\OfficeAddins`.
2. In Word or PowerPoint, go to **File → Options → Trust Center → Trust Center Settings →
   Trusted Add-in Catalogs**. Enter the UNC path as the **Catalog URL**, choose **Add catalog**,
   check **Show in Menu**, and choose **OK**. Close and reopen both apps.
3. Open a test file. From **Home → Add-ins → More Add-ins** or **Insert → My Add-ins**, choose
   **Shared Folder**, select **ChemDraft probe**, and choose **Add**. Use the **ChemDraft probe**
   Home ribbon button to open the pane.

## Run the gate

Run in desktop Word and PowerPoint on Mac and Windows. Record the OS, Office version and build,
and how the picture was inserted. Start with a blank `.docx` or `.pptx`. Paste the iTXt carrier via
ChemDraft where available, or use **Insert → Picture** with
[png-itxt.png](../../../packages/fixtures/office/carriers/png-itxt.png) as the file-insertion control.
Record the insertion method and confirm that the picture selected in the document is the intended
carrier. For the fixture, use the SHA-256 in
[manifest.json](../../../packages/fixtures/office/carriers/manifest.json).
`test-replacement.png` is a byte-for-byte copy of that fixture.

Run each read route with the picture selected, then save, quit the host, reopen the file, reselect
the picture and rerun the reads. Run each replacement route on a fresh copy, both before and
after save and reopen. After each replacement, reselect the result and rerun the reads
immediately and again after save and reopen. For a replacement control, start a separate trial
with `png-ztxt.png`, whose SHA-256 differs from the replacement input. This distinguishes a
successful write from an old picture that already matches the input. Use another fresh copy to
count how many undo steps restore the original picture and its state.

### Word

1. Select the inline picture. Run **A** (selection OOXML), **B** (inline image control), and **C**
   (whole DOCX media). Compare the returned picture hashes to the source. The inline image
   API may render or re-encode the picture.
2. Resize the inline picture and run **D** on a fresh copy. Compare width and height in points.
   Check that the replacement occupied the original location in the surrounding text.
3. Run **E** on a fresh copy of the resized inline picture, then on a separate floating picture
   with known wrapping and position. Check size, wrapping and position in the layout and in
   the before-and-after values. This route uses one DrawingML picture at a time and reports
   when Word's selection OOXML lacks a picture.

### PowerPoint

1. Select the picture on the slide. Run **F** (shape state), **G** (slide export, matched by
   picture ID), and **H** (whole PPTX media). Compare the picture hash to the source. If whole
   file media contains several pictures, use the selected picture's relationship or a
   single-picture deck to identify the relevant part.
2. Add overlapping shapes above and below the picture so stacking changes are visible. For
   a tag-preservation trial, select the picture and, if your Office setup allows the VBA
   editor, run `ActiveWindow.Selection.ShapeRange(1).Tags.Add "CHEMDRAFT", "probe"` in its Immediate
   window. Confirm the tag through **F**.
3. Run **I** on a fresh copy. Compare the before-and-after ID, tag, stacking order, position and
   size. Use separate trials for cropped, rotated and grouped pictures. Select the child
   picture when testing a group, and check crop, rotation and group membership in PowerPoint
   before and after. The probe also reports rotation when PowerPointApi 1.10 is available.
4. Run **J** on a fresh copy with a top-level picture. Compare the same fields and note the
   new ID. If insertion succeeds and a later step fails, the trial may contain both shapes.

Use **Copy results** before closing the pane. Rows include byte length, SHA-256, and the error
when present. A route that cannot obtain bytes leaves length and hash blank. Shape inspection
hashes its UTF-8 JSON. Replacement routes hash the input PNG. Use the read routes on the
replacement to determine whether Office actually stored those bytes. Record unsupported API
sets and webviews without raw deflate support as unavailable routes. For a whole-file media
read, trace the matching part to the selected picture before counting it as retained.

## Results template

Record each platform, Office build, insertion method, and picture variant in a separate row.
Use yes, no, or unavailable for preservation fields. Include the part path and hash in the JSON
evidence.

| OS and Office build | App | Insertion and variant | Stage | Route | Selected PNG byte-identical? | Media path, SHA-256, or error |
| --- | --- | --- | --- | --- | --- | --- |
| | Word | | Before save / reopened | A · getOoxml | | |
| | Word | | Before save / reopened | B · inline control | | |
| | Word | | Before save / reopened | C · compressed DOCX | | |
| | PowerPoint | | Before save / reopened | F · selected shape | — | |
| | PowerPoint | | Before save / reopened | G · slide export | | |
| | PowerPoint | | Before save / reopened | H · compressed PPTX | | |

| OS and Office build | App and route | Picture variant | Replacement PNG byte-identical after reopen? | Size | Position | Wrapping | ID | Tag | Group | Crop | Rotation | Z-order | Undo steps | Error or changes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | Word D · inline Replace | | | | | | — | — | — | — | — | — | | |
| | Word E · OOXML Replace | | | | | | — | — | — | — | — | — | | |
| | PowerPoint I · fill image | | | | | — | | | | | | | | |
| | PowerPoint J · insert and delete | | | | | — | | | | | | | | |

## Local checks

Run from the repository root using Node.js with raw-deflate `DecompressionStream` support.

```sh
pnpm vitest run scripts/office-spike/addin
node --check scripts/office-spike/addin/probe.js
node --check scripts/office-spike/addin/zip.js
```
