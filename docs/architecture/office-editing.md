# Editing ChemDraft structures inside Word and PowerPoint

Status: design, 2026-11-20. Builds on the Phase 0 measurements in
[office-round-trip.md](office-round-trip.md).

## Goal

A user edits a ChemDraft structure without leaving Word or PowerPoint, on macOS and Windows, and the
document keeps working when it moves between the two.

Every structure ChemDraft puts into Office is a high-DPI PNG carrying the ChemDraft drawing in a
text chunk inside the PNG (the **carrier**; today an uncompressed iTXt chunk with the keyword
`application/x-chemdraft-selection+json`, written by `packages/clipboard-adapter/src/pngSelection.ts`).
Phase 0 showed that this PNG is saved byte-identical by Word and PowerPoint on both platforms and
survives Mac↔Windows moves. Everything below reads and writes that carrier; nothing depends on a
second copy of the drawing.

ChemDraft can write the carrier today but cannot read it back: no paste path reads the carrier, GVML
or EMF+ yet. Slice 1 adds the reader.

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

### 1. Task-pane add-in that edits the selected picture: the best route, pending one measurement

The pane hosts ChemDraft's editor. The user selects a structure picture; the pane reads its carrier,
opens it in the editor, and on **Update** puts the edited picture where the old one was.

Microsoft documents the APIs below, but **does not promise that any read route returns the picture's
stored bytes unchanged**, and the carrier lives in those bytes. Slice 1 therefore starts with a
feasibility gate (see Slices) and the add-in is built only if it passes.

| Step | Word | PowerPoint |
| --- | --- | --- |
| Find the selected picture | `document.getSelection()`; `inlinePictures` for inline pictures, the OOXML of the range for floating ones | `presentation.getSelectedShapes()` (PowerPointApi 1.5) |
| Read the stored PNG (first choice) | `range.getOoxml()`: a flat Office package with each picture in `pkg:binaryData` | `slide.exportAsBase64()` (PowerPointApi 1.8): the slide as a one-slide .pptx; follow the shape's `r:embed` to `ppt/media/…` |
| Read the stored PNG (fallback) | `Office.context.document.getFileAsync(Office.FileType.Compressed)`: the whole .docx in slices, on web, Windows and Mac, including older perpetual Office | Same, for the whole .pptx |
| Check the carrier | New reader in `clipboard-adapter`, beside the writer; refuse a picture whose carrier is missing or invalid | Same |
| Replace (first choice) | `insertOoxml(…, "Replace")` with the new PNG and the old size, wrapping and position; `insertInlinePictureFromBase64(…, "Replace")` for inline pictures | `shape.fill.setImage(base64)` (PowerPointApi 1.8): changes the image of the existing shape, so its ID, tags, group, rotation and z-order stay |
| Replace (fallback) | — | Insert with `setSelectedDataAsync` (`coercionType: Image`, old left/top/width/height), restore z-order with `shape.setZOrder` (1.8) and the tag, then delete the old shape |
| Refuse | Pictures the measurements show cannot be replaced faithfully | Grouped, cropped or rotated pictures unless `fill.setImage` handles them; never silently drop shape state |
| Mark ChemDraft pictures | Alt-text description holds a short marker; the carrier stays the source of truth | Shape tag `CHEMDRAFT` (PowerPointApi 1.3) as a fast filter; the carrier stays the source of truth |

PowerPointApi 1.8 is available in PowerPoint on the web, Windows Microsoft 365 version 2504 and
later, and Mac 16.96 and later; not in volume-licensed perpetual or LTSC versions. The
insert-and-delete fallback also needs 1.8 (for `setZOrder`), so it is only for 1.8 hosts where
`fill.setImage` turns out not to work. PowerPoint versions without 1.8 can still read a structure
(through `getFileAsync`) but get a clear "updating needs a newer PowerPoint" message instead of a
replacement that loses stacking order.

Not used:

- `InlinePicture.getBase64ImageSrc()` (Word) and `Shape.getImageAsBase64()` (PowerPoint, 1.10)
  render or re-encode; neither is documented to return the stored bytes.
- `ShapeCollection.addPicture` (PowerPoint) is still preview-only, and Microsoft says not to use
  preview APIs in production.

Size rule: the new PNG is written at the same physical size the old picture showed at (or scaled by
the same factor if the user resized it), so a figure does not jump.

Chemistry rule (AGENTS.md §7): the pane round-trips the drawing through the same `chem-core`
serializer as the desktop app, and slice 1 tests compare canonical SMILES before and after an
edit-free open and update.

### 2. PowerPoint content add-in on the slide: possible, not recommended

A content add-in can show the editor directly on the slide and edit there. Office saves a snapshot
picture with it (`AllowSnapshot`, on by default), which is what anyone without the add-in sees, and
what desktop PowerPoint prints and exports. Against it:

- PowerPoint only; Word has no content add-ins.
- Users report blank output when printing or exporting to PDF from PowerPoint on the web.
- The object is not a picture: copying it into Word, email or another program gives the snapshot,
  without a carrier, so the structure stops being editable once it leaves the slide.
- Viewers without the add-in see a static snapshot rather than our high-DPI carrier PNG.

### 3. Selecting a structure opens it automatically: yes, once the pane is open

`DocumentSelectionChanged` fires in Word and PowerPoint on all three platforms. While the pane is
open, selecting a ChemDraft picture loads it into the editor with no click, and selecting anything
else shows "Select a ChemDraft structure". Office.js has no double-click hook, so this is the closest
an add-in gets. The pane opens from an **Edit Structure** ribbon button; `showAsTaskpane` is also
available for store add-ins, while the auto-open-with-document setting is being restricted by
Microsoft, so the design does not rely on it.

### 4. Windows double-click: yes, through a ChemDraft OLE server, with known blockers

On Windows ChemDraft can register its own OLE class (`ChemDraft.Structure`, its own CLSID; never
another program's class and never `.cdxml`), per user, as an out-of-process server (`LocalServer32`,
which works for both 32- and 64-bit Office). Office stores the object as a native data stream plus
a cached picture. Double-click asks ChemDraft to open the structure in an editing window and write
the result back when the user saves or closes it (open editing, not editing inside the Office
window).

Plan for the cached picture: an EMF holding our carrier PNG in an EMF+ image record, the form Phase
0 saw PowerPoint use. **Unproven:** ChemDraft has no EMF writer yet, and whether Office keeps, prints
and refreshes such a cache is unmeasured.

Blockers to handle with a clear message, and test:

- **Protected View** opens documents read-only; activation does not work there.
- **Policy**: the Microsoft 365 Apps security baseline can turn off OLE active content in
  PowerPoint, and Office can block individual OLE classes (the COM "kill bit" list).

**macOS has no third-party OLE.** Office for Mac embeds only Microsoft's own object types (Microsoft
documents this thinly; the Mac Office forums and other vendors' support pages agree). Other objects
show as their cached picture and double-click reports a missing server. So on a Mac:

- The OLE object displays its cached picture.
- The add-in may still edit it: the object's package (`oleObject*.bin`) is part of the Word OOXML,
  the PowerPoint slide export and the `getFileAsync` file, so the add-in can read our native stream
  from it if those routes return it intact (measured in slice 2). On update it replaces the object
  with a carrier picture, because Office.js cannot create an OLE object in PowerPoint, and says so in
  the pane. In Word it may write the OLE object back through OOXML; slice 2 measures whether Word
  accepts that.

### 5. Distribution and where the add-in's code lives

| Route | Who | Notes |
| --- | --- | --- |
| Microsoft AppSource (store) | Everyone | The production route. Free listing; Microsoft validates the add-in. Users add it from Office's Add-ins button on any platform, and it follows their Microsoft account. |
| Installed by ChemDraft, Windows, after AppSource listing | Windows users of the app | Microsoft supports a Windows installer registering a published store add-in (`WefAutoInstallAddins`). The ChemDraft installer can offer this. |
| Installed by ChemDraft, preview | Testing | The developer locations: the `wef` folder in Word's and PowerPoint's containers on macOS, `HKCU\Software\Microsoft\Office\16.0\Wef\Developer` on Windows. Microsoft describes this as sideloading for testing. Behind a preference, off by default; never the release route. |
| Organization deployment | Labs and companies | The Microsoft 365 admin pushes it to everyone, on Windows, Mac and the web, subject to tenant requirements. |

- **Manifest**: the add-in-only XML manifest, because it works in every Office version we want,
  including perpetual Office, and with the simple preview install above. (The unified manifest is
  now supported on the web and on Word and PowerPoint for Mac 16.103 and later; it can be adopted
  later.)
- **Hosting**: the pane's web code is served over HTTPS from `https://chemdraft.ai/office/<version>/`,
  versioned so older documents keep working with the add-in version that is installed. The editor,
  chemistry engines and carrier reader are bundled with it.
- **Network**: Office.js itself must be loaded from Microsoft's CDN (Microsoft says not to bundle it),
  so the pane needs `appsforoffice.microsoft.com` and `chemdraft.ai`, and nothing else. If Office.js
  does not load within 10 seconds the pane says the network may be blocking it.
- **Offline**: Office needs both sites to load the pane; offline behavior is not guaranteed (Office
  may use its cache). Without the pane, the planned desktop route is: copy the picture into ChemDraft,
  edit, copy back. That needs the paste-side carrier reader (slice 1) and GVML reading (slice 3).
- **AGENTS.md §13 allowlists**: the add-in runs inside Office, not inside the ChemDraft app, so it
  adds nothing to `src-tauri/capabilities/`. The app gains no network path. Installing the manifest
  is a local file or registry write behind a preference.
- **Where the code lives**: the editor is part of `apps/desktop`, and packages must not import
  `apps/`. So the pane is a second web entry of the desktop app's web build (`office.html`), running
  the same editor in an "Office host" mode, with the Word and PowerPoint adapters in
  `apps/desktop/src/office/`. The carrier reader and the OOXML and .pptx lookups are pure functions
  in `packages/clipboard-adapter`, shared with the desktop paste path. The manifest lives in
  `apps/desktop/office/`.

## Recommendation

1. **Run the slice 1 feasibility gate first.** If Word and PowerPoint return the stored PNG intact on
   Mac and Windows through one of the read routes, and PowerPoint can replace a picture faithfully,
   build the task-pane add-in. It is the only route that gives direct editing on Mac, Windows and the
   web, in both apps, with one code base.
2. **Add the Windows OLE server second** for true double-click on Windows, after measuring the EMF
   cache and the Protected View and policy cases.
3. **Then paste of embedded objects and .pptx import (slice 3).**
4. Do not build a PowerPoint content add-in now.

If the gate fails on a platform, the fallback there is the desktop route (copy into ChemDraft, edit,
paste back) with the OLE server on Windows; the owner decides before more is built.

## Slices

### Slice 1a: feasibility gate

A minimal add-in (no editor) with buttons that, for the selected picture, read the PNG through each
route and report its SHA-256, and replace it with a fixed test PNG. The test pictures are carrier
PNGs whose SHA-256 is known, so a matching hash proves the carrier survived; the gate needs no
carrier reader.
Run on Word and PowerPoint, Mac and Windows (the web if time allows), against carrier PNGs pasted by
ChemDraft, and record here:

- `getOoxml`, `exportAsBase64` and `getFileAsync`: stored PNG byte-identical, yes or no.
- PowerPoint `fill.setImage`: carrier kept after save and reopen; ID, tag, group, crop, rotation and
  z-order kept; number of undo steps.
- Word `insertOoxml` and `insertInlinePictureFromBase64` Replace: size, wrapping, position kept; undo.
- The insert-and-delete fallback: what it loses.

### Slice 1b: the add-in (only if 1a passes)

- Carrier reader (iTXt, and zTXt for older carriers) and OOXML and .pptx lookups in
  `clipboard-adapter`, with tests; the desktop paste path reads the carrier from a PNG.
- `office.html` entry, Office host mode, pane UI (editor, Update, Cancel, status line), Word and
  PowerPoint adapters behind one interface, selection-change loading.
- Tests: carrier round trip; canonical SMILES before and after open and update; OOXML and .pptx
  fixtures for inline, floating, resized and grouped pictures; refusal for pictures without a
  carrier.
- Preview install preference on both platforms; manifest validation.

### Slice 2: Windows OLE server

- Out-of-process COM server in the Tauri app (Windows only; on macOS the menu and registration code
  are absent, compiled out with a matching `cfg` side), registered per user by the installer; open
  editing; EMF cached picture with the carrier.
- Tests and measurements: default settings, Protected View, the security baseline, 32- and 64-bit
  Office; cache rendering, printing and refresh.
- Mac: the add-in reads OLE packages; measure what Word for Mac shows and keeps.

### Slice 3: embedded objects and .pptx import

- Paste of the "Embedded Object" clipboard format (Windows) and of GVML (both platforms) holding a
  ChemDraft carrier or OLE package; import structures from a .pptx or .docx file.
