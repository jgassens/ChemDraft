# Editing ChemDraft structures inside Word and PowerPoint

Status: design, 2026-11-20. Builds on the Phase 0 measurements in
[office-round-trip.md](office-round-trip.md).

## Goal

A user edits a ChemDraft structure in Word or PowerPoint on macOS and Windows, and the document keeps
working when it moves between the two. On Windows the structure opens in ChemDraft and goes back into
the document on save; on a Mac it is edited in a panel inside Office.

Two containers carry the drawing:

- The **carrier PNG**: a high-DPI PNG with the ChemDraft drawing in a text chunk (today an
  uncompressed iTXt chunk with the keyword `application/x-chemdraft-selection+json`, written by
  `packages/clipboard-adapter/src/pngSelection.ts`). Phase 0 showed Word and PowerPoint save it
  byte-identical on both platforms and across Mac↔Windows moves. This is what the Mac route edits.
- The **Windows OLE object** (section 4): a native stream holding the same JSON, plus a preview that
  embeds a carrier PNG. The native stream is the source of truth for the object; the preview's copy
  lets a Mac or the paste-back route recover the drawing.

ChemDraft can write the carrier today but cannot read it back: no paste path reads the carrier, GVML
or EMF+ yet. Slice 0 adds the reader that every later slice uses.

## Owner decision, 2026-11-20

- **Windows**: a ChemDraft structure is ChemDraft's own embedded OLE object. Double-click opens it in
  ChemDraft and saving writes it back. No add-in, so an organization's add-in settings cannot block
  it; Office's OLE settings still can (section 4).
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
| Replace (first choice) | `insertOoxml(…, "Replace")` with the new PNG, its own extent and the old width, wrapping and position (measured: keeps a floating picture's placement, one undo step) | Insert with `setSelectedDataAsync`, restore z-order, rotation, name, tags, alt text and a plain link, delete the old shape (measured: works, three undo steps); see "PowerPoint Update: kept, warned, rolled back" below. `shape.fill.setImage` does **not** replace a picture: it sets the shape's fill |
| Refuse | Pictures the measurements show cannot be replaced faithfully | Grouped, cropped or flipped pictures, and rotated ones if rotation cannot be restored; never silently drop shape state: what cannot be carried over is named in a warning after Update |
| Mark ChemDraft pictures | Alt-text description holds a short marker; the carrier stays the source of truth | Shape tag `CHEMDRAFT` (PowerPointApi 1.3) as a fast filter; the carrier stays the source of truth |

PowerPointApi 1.8 is available in PowerPoint on the web, Windows Microsoft 365 version 2504 and
later, and Mac 16.96 and later; not in volume-licensed perpetual or LTSC versions. Replacement in
PowerPoint is insert-and-delete, which needs 1.8 (for `setZOrder`; `fill.setImage` was measured not
to replace a picture). PowerPoint versions without 1.8 can still read a structure
(through `getFileAsync`) but get a clear "updating needs a newer PowerPoint" message instead of a
replacement that loses stacking order.

#### PowerPoint Update: kept, warned, rolled back

Insert-and-delete makes a new shape, so everything on the old one must be copied across or reported.
The manifest declares no requirement sets; every feature below is detected at run time
(`isSetSupported` plus a check that the property is writable on the shape). The old picture's state
is read from the slide XML the add-in already reads for the carrier (`p:cNvPr`, `p:spPr`, the
slide's `p:timing` and relationships), because Office.js cannot read most of it.

| State | What Update does |
| --- | --- |
| Position, width, stacking order, name, tags | Restored and read back; a mismatch fails the update and removes the new picture |
| Rotation | Restored and read back with PowerPointApi 1.10; without it a rotated picture is refused before anything is inserted |
| Alt text title and description, decorative flag | Written with PowerPointApi 1.10 (`altTextTitle`, `altTextDescription`, `isDecorative`) and read back, so the new picture never keeps alt text PowerPoint generated for it. Without 1.10, alt text or a decorative flag on the old picture is named in the warning |
| A plain click hyperlink to an external address | Written with `Shape.setHyperlink` (PowerPointApi 1.10). Office.js cannot read a shape's hyperlink back, so a write that fails, or a host without the method, is named in the warning instead |
| Animations targeting the picture, links to slides, action settings, mouse-over actions, the hidden setting, locks, a border, effects or a style, color adjustments on the picture | No Office.js API writes these; when the slide XML shows the old picture had any of them, Update still succeeds and the pane names them: "Not carried over from the old picture: animations, its link." No warning is shown when the old picture had none |

Rollback: once `setSelectedDataAsync` has inserted the new picture, every later step (identifying
it, restoring its state, verifying, deleting the old one) runs inside the rollback path. On any
failure before the old picture is deleted, a fresh batch removes the new picture: by its shape ID
when the update got far enough to learn it, otherwise as the only new picture at the exact
position and size the insert was asked for (an image cannot carry a tag or name until it exists).
If neither finds exactly one picture, or the delete fails, the error says the new picture may
remain on the slide.

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
own class. Double-click opens it in ChemDraft; saving or closing that window writes it back. It does
not depend on Office add-ins. It can still be blocked by Office's OLE settings (see "Blockers"),
which PowerPoint's managed-security defaults do.

**Class and registration**

- Class: ProgID `ChemDraft.Structure.1` (version-independent `ChemDraft.Structure`), with a CLSID
  generated once for ChemDraft and never changed. It is shown as "ChemDraft Structure" in Insert →
  Object. ChemDraft never registers, claims or converts another program's class, ProgID, CLSID or
  file type, and never `.cdxml` (AGENTS.md §1).
- Server: out of process (`LocalServer32` pointing at `chemdraft.exe`; COM itself adds `-Embedding`
  when it starts the server, and the server then registers its class factory). An out-of-process
  server works with 32- and 64-bit Office. The server implements `IOleObject`, `IDataObject` and
  `IPersistStorage`, which COM marshals between processes. Drawing the object inside Office is done by
  Office's in-process default handler from the object's cache (`IOleCache`, `IViewObject2` live in
  Office's process and never cross to ChemDraft).
- Registry keys: `Insertable`, `DefaultIcon`, `AuxUserType`, `MiscStatus` and two verbs, Edit
  (primary) and Open, both opening the structure in a ChemDraft window.
- Where: the per-user installer writes under `HKCU\Software\Classes`; the all-users installer writes
  under `HKLM\Software\Classes`. Uninstall removes only the keys that installation wrote.
- Dev builds: their own CLSID **and** their own ProgIDs and display name ("ChemDraft (dev)
  Structure"), so a branch build never shadows or removes the stable app's registration (HKCU entries
  take priority over HKLM in Windows' merged view, AGENTS.md §15.2).

**How users make one**

- ChemDraft's Copy puts an OLE data object on the clipboard (`OleSetClipboard`, then
  `OleFlushClipboard` so it outlives ChemDraft) offering `Embed Source`, `Object Descriptor` and an
  EMF picture (`CF_ENHMETAFILE`), which Office uses to fill the new object's cache, plus the carrier
  PNG. Microsoft lets the container choose; whether a plain Paste in Word and PowerPoint picks the
  embedded object is an acceptance test in slice 2, not a given. Paste Special lists both.
- Insert → Object → ChemDraft Structure opens an empty structure in ChemDraft.
- A carrier PNG already in a document (for example from a Mac) becomes an object by copying it into
  ChemDraft (reading the carrier from the clipboard, slice 3) and copying back as an object
  (slice 2).

**What the object holds**

- Native data: one stream, `ChemDraftDocument`, in the object's storage, holding the same versioned
  JSON as the carrier. Round-trip tests compare canonical SMILES (AGENTS.md §7).
- Preview: what Office shows and prints, and what machines without ChemDraft see. Office's OLE cache
  takes Windows picture formats, so the preview is an **EMF holding the carrier PNG in an EMF+ image
  record, plus ordinary GDI records drawing the same image** (EMF+-only content is invisible to plain
  GDI). In the saved file Office also keeps a separate preview image part (Word: `v:imagedata` in
  `word/media`; PowerPoint: a `p:pic` under `p:oleObj` in `ppt/media`) beside the OLE package.
- **Size budget and Slide Show (2026-11-20):** a small molecule's whole embedded object, OLE cache
  included, must stay well under 200 KB. The EMF keeps the 384-dpi PNG and carries only a 96-dpi,
  8-bit GDI fallback (600 x 671 px at 384 dpi: EMF 1.63 MB before, 47 KB after; the old
  full-resolution 32-bit DIB made a 2.8 MB `oleObject1.bin`). PowerPoint Slide Show does not activate
  an embedded object on double-click (standard PowerPoint behavior; an Action Settings "Object
  action" is needed).
- **Goal, not yet measured:** that Office keeps this preview through save and reopen in both places,
  shows it sharply, prints it at full resolution, and refreshes it after an edit. Slice 2 measures
  this before building the rest.

**What other machines see (expected; to be measured)**

| Machine | Shows | Double-click |
| --- | --- | --- |
| Windows with ChemDraft | Preview | Opens in ChemDraft, writes back |
| Windows without ChemDraft | Preview | Office says the program that created the object is not available |
| Mac | The saved preview image, if Office for Mac draws it (measured in slice 2) | Missing server: Mac Office has no third-party OLE |
| Word for the web | Possibly a placeholder; cannot be edited, moved or resized | Nothing |
| PowerPoint for the web | The preview; cannot be edited | Nothing |

On a Mac the add-in can edit such an object if it can read `ChemDraftDocument` from the object's
package (`oleObject*.bin`) and, in Word, write the object back. Both are measured in slice 2b. In
PowerPoint, where Office.js cannot create an OLE object, the add-in replaces the object with a carrier
picture and says so in the pane.

**Blockers to handle and test**

- **PowerPoint OLE policy.** Microsoft's current Microsoft 365 Apps security baseline sets "OLE Active
  Content" to *disabled* by default in PowerPoint. Many managed (university and company) machines
  therefore block activating OLE objects in PowerPoint. Slice 2 measures exactly what that setting
  stops (double-click editing in normal view, or only activation during a slide show) before the
  Windows route is called done for PowerPoint. Word has no such baseline default.
- **Protected View** (files from the internet or email open read-only): activation is unavailable
  until the user enables editing.
- **Per-class blocks**: Office can block individual classes (the COM "kill bit" list). The object then
  shows its preview only.
- When OLE is blocked by policy or a per-class block, the paste-back route (slice 3) still works once
  the document is open for editing; in Protected View nothing can change the document until the
  user enables editing.

### 5. Mac: distribution, and the managed-tenant risk

The add-in is the Mac route only (owner, 2026-11-20). It is also what Office on the web would run, but the web is not a target.


**Owner decision, 2026-11-20 16:24: both routes.**

1. **ChemDraft installs the add-in** into Word's and PowerPoint's local developer (`wef`) folders on
   explicit user request: an *Install Office Add-in* / *Remove Office Add-in* command, never silent,
   removable, macOS only. The help text says Microsoft describes this route as for testing and that
   Microsoft may change it. Measured on 2026-11-20: it works even when an organization has turned the
   add-in store off.

   **macOS asks first (measured on macOS 26.7.3, 2026-11-21).** The `wef` folders are inside
   Word's and PowerPoint's containers (`~/Library/Containers/<bundle>/Data/Documents/wef`), which
   macOS protects as other apps' data (TCC service `SystemPolicyAppData`). The first access shows
   "“ChemDraft” would like to access data from other apps. Keeping app data separate makes it
   easier to manage your privacy and security." with Don't Allow and Allow. Every user sees it once;
   an ad-hoc signed dev build sees it again after each rebuild, because its code signature changes.
   How ChemDraft handles it:

   - **Said before it happens.** The Install confirmation, shown before anything is written, says
     macOS will ask next, why (the add-in file goes into Word's and PowerPoint's own folders), and
     that Don't Allow leaves Office unchanged.
   - **All or nothing.** `office_addin.rs` reads both apps' state before writing either. A read that
     fails writes nothing. If the second app's write fails, the first app's change is undone: a new
     manifest is deleted with any folders created for it, a replaced one is restored byte for byte,
     and a removed one is written back. Each write goes through a temporary sibling that is deleted
     on failure. A missing app or an unrecognized file at ChemDraft's filename is a skip, not a
     failure, so the other app still proceeds.
   - **Denial named.** `EPERM`/`EACCES` comes back as `errorKind: "permissionDenied"`. The message
     says Office was not changed, that macOS denied access, and how to allow it: choose the command
     again and Allow when asked, or, if macOS does not ask, turn ChemDraft on in System Settings >
     Privacy & Security > Full Disk Access. macOS 26 has no separate App Data list in Privacy &
     Security (its settings list has App Management, which covers changing other apps' bundles, not
     their data). `tccutil reset SystemPolicyAppData org.chemdraft.desktop` (or
     `org.chemdraft.desktop.dev`) makes macOS ask again. A denial keeps both Help items enabled, so
     choosing one again is the retry. Remove is handled the same way.
   - **Off the main thread.** The three commands are `async` and do their file work in
     `tauri::async_runtime::spawn_blocking`, one action at a time, so menus and the window stay
     responsive while the prompt is up. (Tauri 2 runs a non-`async` command on the main thread.)
   - **Help rows from launch.** The rows come from the webview's menu sync. The native menu is built
     before the webview loads, so lib.rs seeds them (`initial_plugin_menu_items`) disabled; the
     webview's command says "Checking Office add-in status…" until the status check returns, and its
     sync then updates the rows. macOS only; the Windows menu has no such rows.
2. **Store listing and IT-admin deployment**: prepare the AppSource listing materials and an IT-admin
   deployment guide (centralized deployment manifest and steps). Submission to the store waits for
   the owner.

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

1. **Shared first: the carrier reader (slice 0).** Every route reads carriers.
2. **Windows: the OLE object (slice 2)**, starting with the preview and PowerPoint-policy measurements.
3. **Mac: the slice 1a gate on the iMac, then the add-in (slice 1b)** if Word and PowerPoint for Mac
   return the stored PNG intact.
4. **Both: paste-back and embedded-object import (slice 3)**, also the fallback wherever add-ins or
   OLE are switched off.
5. Do not build a PowerPoint content add-in now.

## Slices

### Slice 0: carrier reader (shared)

- Reader for the iTXt carrier (and zTXt for older carriers) beside the writer in
  `packages/clipboard-adapter`, with OOXML-picture and .pptx-media lookups as pure functions; tests
  for a byte-exact round trip, malformed and missing carriers, and bounds on untrusted input. The
  canonical-SMILES check runs in slice 3, where the recovered JSON is parsed into a document.

### Slice 1a: Mac feasibility gate

A minimal add-in (no editor), in `scripts/office-spike/addin/`, hosted at
`https://chemdraft.ai/office-spike/`. For the selected picture it reads the PNG through each route and
reports its SHA-256, and replaces it with a fixed test PNG. The test pictures are carrier PNGs whose
SHA-256 is known, so a matching hash proves the carrier survived; the gate needs no carrier reader.
Run on Word and PowerPoint for Mac (the Intel iMac), and record here, with the Office version and the
account type Office is signed in with:

- `getOoxml`, `exportAsBase64` and `getFileAsync`: stored PNG byte-identical, yes or no.
- PowerPoint `fill.setImage`: carrier kept after save and reopen; ID, tag, group, crop, rotation and
  z-order kept; number of undo steps.
- Word `insertOoxml` and `insertInlinePictureFromBase64` Replace: size, wrapping, position kept; undo.
- The insert-and-delete fallback: what it loses.

The Windows run was dropped when the owner chose OLE for Windows.

**Results, 2026-11-20, Intel iMac, Word and PowerPoint for Mac 16.115.1, signed in with an
organization (university) Microsoft 365 account.** Raw results are kept with the project's
private runbooks.

- The developer-installed add-in loaded in both apps although the organization had turned the add-in
  store off ("The add-in store has been disabled… contact your IT administrator"). A store listing
  therefore cannot reach such users; organization deployment or the ChemDraft-installed route can.
- **Reading passes.** `getOoxml` and `getFileAsync` (Word) and `exportAsBase64` and `getFileAsync`
  (PowerPoint) returned the stored carrier PNG byte-identical, before and after save and reopen.
  `getBase64ImageSrc` also matched, but works only on inline pictures; Word for Mac inserts pictures
  floating (square wrap) by default.
- **Word replacement passes with `insertOoxml(…, "Replace")`**: it kept a floating picture's anchor,
  wrapping and offsets exactly, in one undo step. It stretched the new picture into the old frame,
  so the add-in writes the new picture's own extent (keeping the old width) in the OOXML it inserts.
  `insertInlinePictureFromBase64(…, "Replace")` works only on inline pictures (one undo step, kept
  the width and took the new aspect ratio).
- **PowerPoint `shape.fill.setImage` fails as a replacement**: it reported success but set the
  shape's background fill (`p:spPr/a:blipFill`); the picture the slide shows (`p:blipFill`) was
  unchanged after save and reopen. Do not use it for pictures.
- **PowerPoint insert-and-delete works with known losses**: the picture was replaced visibly and the
  carrier kept; position, size and z-order were restored; the shape ID and name changed; **rotation
  was lost**; it took **three undo steps**. Slice 1b restores rotation and name after inserting
  (if the API allows; measured then) and stretches nothing: it sets the new picture's own aspect.

### Slice 1b: the Mac add-in (needs slice 0 and a passed 1a)

- `office.html` entry, Office host mode, pane UI (editor, Update, Cancel, status line), Word and
  PowerPoint adapters behind one interface, selection-change loading.
- Tests: canonical SMILES before and after open and update; OOXML and .pptx fixtures for inline,
  floating, resized and grouped pictures; refusal for pictures without a carrier.
- Preview install preference (macOS only, with the matching `cfg` side compiled out on Windows);
  manifest validation.

### Slice 2: Windows OLE object

- First, measurements: an EMF writer (EMF+ image record with the carrier PNG, plus GDI records) and a
  hand-made ChemDraft object, checked in Word and PowerPoint for preview kept through save and reopen
  (both the OLE cache and the OOXML preview part), sharp display, full-resolution print, refresh after
  edit; what Mac Office shows; and what the PowerPoint "OLE Active Content" baseline setting blocks.
  Report to the owner before building further if PowerPoint OLE is blocked in normal editing.
- Out-of-process COM server in the Tauri app (Windows only; on macOS the code is compiled out with a
  matching `cfg` side) for open editing; registration in both installers, removal on uninstall, dev
  builds with their own CLSID and ProgIDs.
- Copy offers the OLE data object; Insert → Object works.
- Acceptance matrix: 64- and 32-bit Office; per-user and all-users registration; Insert → Object,
  plain Paste, Paste Special, double-click, save-back, save and reopen, uninstall; Protected View; the
  security baseline. Rust unit tests for storage and EMF writing; storage round trip with canonical
  SMILES.

### Slice 2b: Mac editing of Windows objects

- With real objects from slice 2: do `getOoxml`, `exportAsBase64` and `getFileAsync` return
  `oleObject*.bin` intact on Mac; can Word for Mac take the object back through `insertOoxml`. If not,
  the Mac add-in converts such an object to a carrier picture and says so.

### Slice 3: paste-back and embedded objects, both platforms

- Paste reads the carrier from GVML, EMF+ and PNG clipboard data (using slice 0).
- Paste of the "Embedded Object" clipboard format (Windows) and of ChemDraft OLE packages; import
  structures from a .pptx or .docx file.
