# Editing ChemDraft structures inside Word and PowerPoint

Status: design, 2026-11-20. Builds on the Phase 0 measurements in
[office-round-trip.md](office-round-trip.md).

## Goal

A user edits a ChemDraft structure without leaving Word or PowerPoint, on macOS and Windows, and the
document keeps working when it moves between the two.

Every structure ChemDraft puts into Office is a high-DPI PNG carrying the ChemDraft drawing in a
zTXt chunk (the **carrier**). Phase 0 showed that this PNG is saved byte-identical by Word and
PowerPoint on both platforms and survives Mac↔Windows moves. Everything below reads and writes that
carrier; nothing depends on a second copy of the drawing.

## Words used here

- **Office add-in**: a small web app (HTML and JavaScript) that Office loads in a built-in browser
  view. The same add-in runs in Office for Windows, Office for Mac and Office on the web. It talks to
  the document through **Office.js**, Microsoft's JavaScript library.
- **Task pane**: the panel an add-in shows on the side of the Word or PowerPoint window.
- **Content add-in**: an add-in that lives on a PowerPoint slide itself, like a picture that runs code.
- **OLE**: the Windows mechanism behind "double-click an embedded object to edit it in its own app".
- **Requirement set**: a versioned group of Office.js features (for example `PowerPointApi 1.8`);
  an add-in checks at run time which sets the Office it runs in supports.

## Answers

### 1. Task-pane add-in that edits the selected picture: yes, on both platforms

This is the core of the design. The pane hosts ChemDraft's web editor (the same build as the web
app). The user selects a structure picture; the pane reads its carrier, opens it in the editor, and
on **Update** replaces the picture in place.

| Step | Word | PowerPoint |
| --- | --- | --- |
| Find the selected picture | `document.getSelection()`; `inlinePictures` for inline pictures, the OOXML of the range for floating ones | `presentation.getSelectedShapes()` (PowerPointApi 1.5) |
| Read the original PNG bytes | `range.getOoxml()` returns the selection as a flat Office package with each picture's original bytes in `pkg:binaryData` | `slide.exportAsBase64()` (PowerPointApi 1.8) returns the slide as a one-slide .pptx; the add-in unzips it and follows the shape's `r:embed` to `ppt/media/…` |
| Check the carrier | Same reader the desktop app uses for paste; refuse a picture whose carrier is missing or invalid | Same |
| Replace in place | `insertOoxml(…, "Replace")` with the new PNG and the old size, wrapping and position; `insertInlinePictureFromBase64(…, "Replace")` for inline pictures if OOXML loses anything | `setSelectedDataAsync` with `coercionType: Image` and the old shape's left, top, width and height, then delete the old shape |
| Mark ChemDraft pictures | Picture alt-text description holds a short marker; the carrier stays the source of truth | Shape tag `CHEMDRAFT` (PowerPointApi 1.3) as a fast filter; the carrier stays the source of truth |
| Undo | One Office undo step per update where Office allows; verified per platform | Same |

Not used, and why:

- `InlinePicture.getBase64ImageSrc()` (Word) and `Shape.getImageAsBase64()` (PowerPoint) are not
  documented to return the stored bytes, and the PowerPoint one renders a new image, which has no
  carrier. They are only a fallback to measure.
- `ShapeCollection.addPicture` (PowerPoint) is still preview-only; Microsoft says not to use preview
  APIs in production. Switch to it when it is in a released set, because it can replace a picture
  without going through the selection.

Size rule: the new PNG is written at the same physical size the old picture showed at (or scaled
by the same factor if the user resized it), so a fixed figure does not jump.

Chemistry rule (AGENTS.md §7): the pane round-trips the drawing through the same `chem-core`
serializer as the desktop app, and slice 1 tests compare canonical SMILES before and after an
edit-free open/update.

### 2. PowerPoint content add-in on the slide: possible, not recommended as the main path

A content add-in can show the editor directly on the slide and edit there. Office saves a snapshot
picture with it (`AllowSnapshot`, on by default), which is what anyone without the add-in sees, and
what desktop PowerPoint prints and exports. Against it:

- PowerPoint only; Word has no content add-ins.
- Reported blank output when printing or exporting to PDF from PowerPoint on the web.
- The object is not a picture: copying it into Word, email or another program gives the snapshot,
  without a carrier, so the structure stops being editable the moment it leaves the slide.
- Every viewer without the add-in sees a static snapshot rather than our high-DPI carrier PNG.

Kept as a possible later option for live slides; the picture plus task pane covers both apps with
one design.

### 3. Selecting a structure opens it automatically: yes, once the pane is open

`DocumentSelectionChanged` fires in Word and PowerPoint on all three platforms. While the pane is
open, selecting a ChemDraft picture loads it into the editor with no click, and selecting anything
else shows "Select a ChemDraft structure". That is the closest an add-in gets to double-click:
Office.js has no double-click hook, and since a February 2026 change an add-in can no longer open its
own pane without a user action. The ribbon gets an **Edit Structure** button that opens the pane.

### 4. Windows double-click: yes, through a ChemDraft OLE server

On Windows ChemDraft can register its own OLE class (`ChemDraft.Structure`, its own CLSID; never
another program's class and never `.cdxml`). Office stores the object as a native data stream plus
a cached picture. Double-click calls ChemDraft, which opens the structure in an editing window and
writes the result back to the object when the user saves or closes it (open editing, not in-place
editing inside the Office window).

The cached picture is written as an EMF holding our carrier PNG in an EMF+ image record, the form
Phase 0 already showed PowerPoint keeps and our reader understands, so the object still carries the
drawing.

**macOS has no third-party OLE.** Office for Mac embeds only Microsoft's own object types; other
objects show as their cached picture and double-click reports a missing server. So on a Mac:

- The OLE object displays its cached picture.
- The add-in still edits it: the object's package (`oleObject*.bin`) is inside the Word OOXML and the
  PowerPoint slide export, so the add-in reads our native stream from it. On update it replaces the
  object with a carrier picture, because Office.js cannot create an OLE object on PowerPoint, and
  says so in the pane. In Word it can write the OLE object back through OOXML; slice 2 measures
  whether Word accepts that.

### 5. Distribution and where the add-in's code lives

| Route | Who | Notes |
| --- | --- | --- |
| Microsoft AppSource (store) | Everyone | The production route. Free listing; Microsoft validates the add-in. Users add it from Office's Add-ins button, on any platform, and it follows their Microsoft account. |
| Installed by ChemDraft | Preview and testing | ChemDraft can write the manifest where Office looks for developer add-ins: the `wef` folder in Word's and PowerPoint's containers on macOS, `HKCU\Software\Microsoft\Office\16.0\Wef\Developer` on Windows. Microsoft describes this as sideloading for testing; fine for previews, not the release route. Behind a preference, off by default. |
| Organization deployment | Labs and companies | The Microsoft 365 admin can push it to everyone. Works with the same manifest. |

- **Manifest**: the add-in-only XML manifest. The unified manifest cannot be sideloaded on Mac or the
  web.
- **Hosting**: the pane's web code is served over HTTPS from `https://chemdraft.ai/office/<version>/`,
  versioned so a document opened by an older add-in keeps working. It contains no secrets and makes
  no other network calls: the editor, chemistry engines and carrier reader are all bundled.
- **Offline**: Office needs to reach the hosting site to load the pane; offline behavior is not
  guaranteed (Office may use its cache). Without the pane the user still has the desktop route:
  copy the picture into ChemDraft (paste reads GVML and the carrier), edit, and copy back.
- **AGENTS.md §13 allowlists**: the add-in runs inside Office, not inside the ChemDraft app, so it
  adds nothing to `src-tauri/capabilities/`. The app gains no network path. Writing the manifest
  (preview route) is a local file or registry write behind a preference.
- **Plugin or core**: the add-in is a separate product surface built from shared packages
  (`chem-core`, `layout-engine`, `export-engine`, the carrier reader). It lives in its own workspace
  package `apps/office-addin`, importing packages and never `apps/desktop` (same rule as the CLI).

## Recommendation

1. **Build the task-pane add-in first (slice 1).** It is the only route that gives direct editing on
   Mac, Windows and the web, in both apps, with one code base, and it works on every carrier PNG
   already in users' documents.
2. **Add the Windows OLE server second (slice 2)** for true double-click on Windows, writing the same
   carrier so the add-in can edit those objects on a Mac.
3. **Then paste of embedded objects and .pptx import (slice 3)**: read the "Embedded Object" clipboard
   format and OLE packages in documents, on both platforms.
4. Do not build a PowerPoint content add-in now.

## Slices

### Slice 1: task-pane add-in, both platforms

- `apps/office-addin`: manifest, pane UI (editor, Update, Cancel, status line), Word and PowerPoint
  adapters behind one interface, selection-change loading.
- A shared, pure carrier package (read and write PNG zTXt/iTXt, OOXML picture lookup, slide-export
  lookup), used by the add-in and by the desktop paste path. Moved out of the app, not copied.
- Tests: carrier round trip; canonical SMILES before and after open/update; OOXML and pptx fixtures
  for inline, floating, resized and grouped pictures; a refusal for pictures without a carrier.
- Measurements on both platforms, recorded in this file: whether `getOoxml` returns the original
  PNG bytes; whether replacement keeps size, position, wrapping and z-order; undo behavior; Word and
  PowerPoint on Mac and Windows, and on the web.
- Preview install: the ChemDraft preference that writes the developer manifest, on both platforms.

### Slice 2: Windows OLE server

- Out-of-process COM server in the Tauri app (Windows only, with the macOS side a documented no-op),
  registered per user by the installer; open editing; EMF cached picture with the carrier.
- Mac: add-in reads OLE packages; measure what Word for Mac shows and keeps.

### Slice 3: embedded objects and .pptx import

- Paste of the "Embedded Object" clipboard format (Windows) and GVML (both) holding a ChemDraft OLE
  package; import structures from a .pptx or .docx file.

## Open questions to measure in slice 1

- Does Word's `getOoxml` return the stored PNG byte-identical on Mac and Windows?
- Does PowerPoint's `exportAsBase64` keep the original media, and is it fast enough on large decks
  (it exports one slide)?
- Can a PowerPoint picture be replaced in a single undo step, or does select-insert-delete take two?
- Is PowerPointApi 1.8 available in the Office versions we target (Microsoft 365 current channel on
  both platforms)? If not, the fallback for reading is not yet known.
