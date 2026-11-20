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

## Owner decision, 2026-11-20

- **Windows**: a ChemDraft structure is ChemDraft's own embedded OLE object. Double-click opens it in
  ChemDraft and saving writes it back. No add-in, so nothing an organization's add-in settings can
  block. (Section 4.)
- **Mac**: Office for Mac has no third-party OLE, so the Mac route is the task-pane add-in (sections
  1–3, 5), with a paste-back fallback for organizations that switch add-ins off.

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

### 1. Mac: task-pane add-in that edits the selected picture, pending one measurement

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

### 4. Windows: ChemDraft's own embedded object (the Windows route)

On Windows, a ChemDraft structure in Word or PowerPoint is an **embedded OLE object** of ChemDraft's
own class. Double-click opens it in ChemDraft; saving or closing that window writes it back. Nothing
depends on Office add-ins, so an organization that turns add-ins off does not turn this off.

**Class and registration**

- Class: ProgID `ChemDraft.Structure.1` (version-independent `ChemDraft.Structure`), with a CLSID
  generated once for ChemDraft and never changed. It is shown as "ChemDraft Structure" in Insert →
  Object. ChemDraft never registers, claims or converts another program's class, ProgID, CLSID or
  file type, and never `.cdxml` (AGENTS.md §1).
- Server: out of process (`LocalServer32` pointing at `chemdraft.exe` with an `-Embedding`
  argument), so 32- and 64-bit Office both use it; COM's built-in marshaling for the standard OLE
  interfaces carries calls between them. The keys also carry `Insertable`, `DefaultIcon`, `AuxUserType`,
  `MiscStatus` and the `verb` list (Edit, Open).
- Where: the per-user installer writes under `HKCU\Software\Classes`; the all-users installer writes
  under `HKLM\Software\Classes`. Uninstall removes exactly these keys. A ChemDraft (dev) build
  registers its own separate CLSID, so a branch build never takes over the stable app's objects
  (AGENTS.md §15.2).
- Click-to-Run Office sees both HKCU and HKLM classes; slice 2 confirms this on the target Office
  builds.

**How users make one**

- ChemDraft's Copy adds the OLE clipboard formats (`Embed Source`, `Object Descriptor`) beside the
  carrier PNG, so a plain Paste into Word or PowerPoint inserts a ChemDraft object. Paste Special →
  Picture still gives the carrier PNG.
- Insert → Object → ChemDraft Structure opens an empty structure in ChemDraft.
- A carrier PNG already in a document (for example from a Mac) can be turned into an object by
  copying it into ChemDraft and copying back (slice 3 adds the GVML reader for that).

**What the object holds**

- Native data: one stream, `ChemDraftDocument`, in the object's storage, holding the same versioned
  JSON as the carrier. ChemDraft reads it back exactly; round-trip tests compare canonical SMILES
  (AGENTS.md §7).
- Preview picture: what Office shows and prints, and what every machine without ChemDraft sees.
  Office's OLE picture cache accepts only Windows picture formats, so the preview is an **EMF that
  contains the high-DPI carrier PNG** in an EMF+ image record (the form Phase 0 found PowerPoint
  writing itself). It shows sharp, prints at full resolution, and still carries the drawing for any
  reader that knows where to look.

**What other machines see**

| Machine | Shows | Double-click |
| --- | --- | --- |
| Windows with ChemDraft | Preview | Opens in ChemDraft, writes back |
| Windows without ChemDraft | Preview | Office says the program that created the object is not available; the document is otherwise fine |
| Mac (any) | Preview (EMF; Office for Mac draws EMF+) | Office for Mac reports a missing server: Mac Office has no third-party OLE |
| Office on the web | Preview | Nothing |

On a Mac the Mac route (section 1) edits such an object: the add-in reads `ChemDraftDocument` from
the object's package (`oleObject*.bin`) in the document file, if the read measurements in slice 1a
show the package arrives intact. In Word it writes the object back through OOXML if Word accepts
that (measured in slice 2); in PowerPoint, where Office.js cannot create an OLE object, it replaces
the object with a carrier picture and says so in the pane.

**Blockers to handle and test**

- **Protected View** (files from the internet or email open read-only): activation is unavailable
  until the user enables editing. ChemDraft is not involved until then, so there is nothing to
  handle beyond documenting it.
- **Policy**: the Microsoft 365 Apps security baseline can turn off OLE activation in PowerPoint,
  and Office can block individual classes (the COM "kill bit" list). The object then shows its
  preview only. The help page explains it; ChemDraft's paste-back route still works.
- **Unproven**: ChemDraft has no EMF writer yet, and whether Office keeps, prints and refreshes the
  EMF preview is unmeasured. Slice 2 starts by measuring it.

### 5. Mac: distribution, and the managed-tenant risk

The add-in is the Mac route only (owner, 2026-11-20). It is also what Office on the web would run,
but the web is not a target.

| Route | Who | Notes |
| --- | --- | --- |
| Microsoft AppSource (store) | Everyone on a Mac | The production route. Free listing; Microsoft validates the add-in. Users add it from Office's Add-ins button, and it follows their Microsoft account. |
| Installed by ChemDraft, preview | Testing | The `wef` folder in Word's and PowerPoint's containers. Microsoft describes this as sideloading for testing. Behind a preference, off by default; never the release route. |
| Organization deployment | Labs and companies | The Microsoft 365 admin pushes it to everyone, subject to tenant requirements. |

**Managed-tenant risk.** University and company Microsoft 365 tenants can switch add-ins off. On
2026-11-20, Office on Windows signed in with the owner's university account showed no add-ins at all,
not even a developer-sideloaded one (Home → Add-ins did nothing; `WEF\AutoInstallAddins` had
`StoreDisabled=1`). Mac Office signed in to such a tenant may behave the same; the slice 1a iMac run
records which account Office is signed in with. Many chemists use Office through a university
account, so the Mac route needs a fallback that does not depend on add-ins:

- **Edit in ChemDraft, paste back**: copy the structure picture in Office and paste it into
  ChemDraft, which reads the carrier from the clipboard's GVML or PNG data; edit; copy; paste back
  into Office. Pasting over a selected picture adds a second picture rather than replacing it
  (Phase 0), so the user deletes the old one. Clumsy, but always available and it needs no network.
- If the tenant allows organization deployment, an admin can add the ChemDraft add-in for everyone.

Other add-in details:

- **Manifest**: the add-in-only XML manifest, because it works in every Office for Mac we want and
  with the simple preview install. (The unified manifest is supported on Word and PowerPoint for Mac
  16.103 and later; it can be adopted later.)
- **Hosting**: the pane's web code is served over HTTPS from `https://chemdraft.ai/office/<version>/`,
  versioned so older documents keep working with the add-in version that is installed. The editor,
  chemistry engines and carrier reader are bundled with it.
- **Network**: Office.js itself must be loaded from Microsoft's CDN (Microsoft says not to bundle it),
  so the pane needs `appsforoffice.microsoft.com` and `chemdraft.ai`, and nothing else. If Office.js
  does not load within 10 seconds the pane says the network may be blocking it.
- **Offline**: Office needs both sites to load the pane; offline behavior is not guaranteed. The
  paste-back route above is the offline fallback.
- **AGENTS.md §13 allowlists**: the add-in runs inside Office, not inside the ChemDraft app, so it
  adds nothing to `src-tauri/capabilities/`. The app gains no network path.
- **Where the code lives**: the editor is part of `apps/desktop`, and packages must not import
  `apps/`. So the pane is a second web entry of the desktop app's web build (`office.html`), running
  the same editor in an "Office host" mode, with the Word and PowerPoint adapters in
  `apps/desktop/src/office/`. The carrier reader and the OOXML and .pptx lookups are pure functions
  in `packages/clipboard-adapter`, shared with the desktop paste path. The manifest lives in
  `apps/desktop/office/`.

### Why the two platforms differ (AGENTS.md §1)

AGENTS.md §1 asks for shared behavior unless the operating system forces a difference. Here it does
on one side and the owner chose on the other: Mac Office cannot host third-party OLE objects, and on
Windows the owner ruled (2026-11-20) that editing must not depend on an add-in store an organization
can switch off. The shared parts stay shared: one carrier format, one reader in
`clipboard-adapter`, one editor, the same paste-back route on both platforms, and documents that
open on either platform with their structures still editable there.

## Recommendation

1. **Windows: build the OLE object (slice 2)**, starting with the EMF preview measurement.
2. **Mac: run the slice 1a gate on the iMac, then build the add-in (slice 1b)** if Word and
   PowerPoint for Mac return the stored PNG intact.
3. **Both: the paste-back route and the carrier reader (slice 3)**, which is also the fallback when
   a managed tenant disables add-ins.
4. Do not build a PowerPoint content add-in now.

## Slices

### Slice 1a: Mac feasibility gate

A minimal add-in (no editor), in `scripts/office-spike/addin/`, hosted at
`https://chemdraft.ai/office-spike/`. For the selected picture it reads the PNG through each route and
reports its SHA-256, and replaces it with a fixed test PNG. The test pictures are carrier PNGs whose
SHA-256 is known, so a matching hash proves the carrier survived; the gate needs no carrier reader.
Run on Word and PowerPoint for Mac (the Intel iMac), and record here, with the Office version and
the account type Office is signed in with:

- `getOoxml`, `exportAsBase64` and `getFileAsync`: stored PNG byte-identical, yes or no.
- PowerPoint `fill.setImage`: carrier kept after save and reopen; ID, tag, group, crop, rotation and
  z-order kept; number of undo steps.
- Word `insertOoxml` and `insertInlinePictureFromBase64` Replace: size, wrapping, position kept; undo.
- The insert-and-delete fallback: what it loses.

The Windows run was dropped when the owner chose OLE for Windows.

### Slice 1b: the Mac add-in (only if 1a passes)

- `office.html` entry, Office host mode, pane UI (editor, Update, Cancel, status line), Word and
  PowerPoint adapters behind one interface, selection-change loading; reads ChemDraft OLE packages
  too.
- Tests: carrier round trip; canonical SMILES before and after open and update; OOXML and .pptx
  fixtures for inline, floating, resized and grouped pictures; refusal for pictures without a
  carrier.
- Preview install preference (macOS only, with the matching `cfg` side compiled out on Windows);
  manifest validation.

### Slice 2: Windows OLE object

- First: EMF writer (EMF+ image record holding the carrier PNG, plus a plain GDI fallback record) and
  a measurement that Word and PowerPoint keep, show, print and refresh it, and how Mac Office shows
  it.
- Out-of-process COM server in the Tauri app (Windows only; on macOS the code is compiled out with a
  matching `cfg` side), implementing the standard embedding interfaces for open editing; registration
  in both installers and removal on uninstall; dev builds use their own CLSID.
- Copy adds `Embed Source` and `Object Descriptor`; Insert → Object works.
- Tests: storage round trip with canonical SMILES; registration keys; Rust unit tests for the
  storage and EMF writers; measurements on 64-bit Microsoft 365, Protected View and the security
  baseline.

### Slice 3: paste-back and embedded objects, both platforms

- Carrier reader (iTXt, and zTXt for older carriers) in `clipboard-adapter`, with tests; paste reads
  the carrier from GVML, EMF+ and PNG clipboard data.
- Paste of the "Embedded Object" clipboard format (Windows) and of ChemDraft OLE packages; import
  structures from a .pptx or .docx file.
