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
  byte-identical in the tested cases on both platforms and across Mac↔Windows moves. Windows Word
  can strip the carrier on save with default image compression, or on plain paste; use Insert → Object
  there for a durable drawing (see the Windows findings below). This is what the Mac route edits.
- The **Windows OLE object** (section 4): a native stream holding the same JSON, plus a preview that
  embeds a carrier PNG. The native stream is the source of truth for the object; the preview's copy
  lets a Mac or the paste-back route recover the drawing.

Slice 0 added the carrier reader that every later slice uses; slice 3 reads it back from Word and
PowerPoint files and from a copied Office picture (GVML or PNG; EMF+ is not read).

## Owner decision, 2026-11-20

- **Windows**: a ChemDraft structure is ChemDraft's own embedded OLE object. Double-click opens it in
  ChemDraft and saving writes it back. No add-in, so an organization's add-in settings cannot block
  it; Office's OLE settings still can (section 4).
  Owner decision, 2026-11-22: this note goes wherever Word on Windows usage is described:
  > "In Word on Windows, insert structures with Insert > Object > ChemDraft to keep them editable. Pictures pasted or inserted into Word lose their ChemDraft data when Word saves the document."
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
| Alt text title and description, decorative flag | Written with PowerPointApi 1.10 (`altTextTitle`, `altTextDescription`, `isDecorative`) and read back, so the new picture never keeps alt text PowerPoint generated for it. Title and description are read back whether or not the picture is decorative; a mismatch on a non-decorative picture fails the update and removes the new picture; on a decorative picture PowerPoint may clear them, so the update goes ahead and the warning names "its alt text". Without 1.10, alt text or a decorative flag on the old picture is named in the warning |
| A plain click hyperlink to an external address | Written with `Shape.setHyperlink` (PowerPointApi 1.10). Office.js cannot read a shape's hyperlink back, so a write that fails, or a host without the method, is named in the warning instead |
| Animations targeting the picture, links to slides, action settings, mouse-over actions, the hidden setting, locks, a border, effects or a style, color adjustments on the picture, a picture shape other than a rectangle (`a:prstGeom` other than `rect`, or `a:custGeom`), membership of a slide layout placeholder (`p:nvPicPr/p:nvPr/p:ph`) | No Office.js API writes these; when the slide XML shows the old picture had any of them, Update still succeeds and, after it, the pane names them: "Not carried over from the old picture: animations, its link, its place in the slide layout (placeholder)." The new picture is an ordinary picture. No warning is shown when the old picture had none |

Rollback: before inserting, the update checks that the selected picture's slide is the one active
slide; otherwise it refuses and inserts nothing. Once `setSelectedDataAsync` has inserted the new
picture, every later step (identifying it, restoring its state, verifying, deleting the old one) runs
inside the rollback path. That path first checks the active slide again, then identifies the new
picture as the one new shape on the original slide, which must be an image, and learns its shape ID.
On any failure before the old picture is deleted, a fresh batch removes the new picture by that ID.
A shape is never deleted by its position or size. When identity is uncertain (the active slide
changed during the insert, no new picture or more than one appeared, or no new shape carries the
learned ID), the rollback deletes nothing; the error ends with "Couldn't find the inserted structure
to remove — delete it by hand.", and the user removes the inserted picture by hand before retrying
(the owner retired the older exact-placement fallback on 2026-11-22). If the ID is known but the
delete fails, the error says the new picture may remain on the slide. The old picture counts as
deleted only once its `delete()` call has returned: a `delete()` that throws leaves the old picture,
so the new one is removed. A failure in the sync after a successful `delete()` leaves the outcome
unknown, and the error asks the user to check the slide before retrying.

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

- Native data: one stream, `ChemDraftDocument`, holding the same versioned JSON as the carrier.
  Round-trip tests compare canonical SMILES (AGENTS.md §7).
- **Storage layout** (`office_ole/server/persist.rs`, `save_generation`). `IStorage` may be in direct
  mode, so a save never overwrites the live drawing in place. It writes `ChemDraftDocument`, and
  `ChemDraftPreview` (the source PNG) and `ChemDraftExtent` (two little-endian HIMETRIC `i32`s) when
  there are any, into a new child storage `ChemDraftDrawingPending`. Only once every stream is
  written does it publish: an existing `ChemDraftDrawing` is renamed to `ChemDraftDrawingPrevious`, then
  `ChemDraftDrawingPending` is renamed to `ChemDraftDrawing`. After that it removes
  `ChemDraftDrawingPrevious` and the legacy root streams; a failed cleanup does not fail the save. A
  failed write removes the pending storage and leaves the old drawing in force; a failed final
  rename leaves it readable as `ChemDraftDrawingPrevious`. Objects saved before this layout keep
  the three streams at the root of the object's storage.
- **Reading it** (`drawing_storage` for `IPersistStorage::Load` and paste; `readChemDraftOleObject`
  in `packages/clipboard-adapter/src/oleObject.ts` for file import, tested in `oleObject.test.ts`).
  The same precedence in both: `ChemDraftDrawing` when that storage exists, else
  `ChemDraftDrawingPrevious`, else the root streams. The storage that exists decides; one without
  `ChemDraftDocument` is an error, not a reason to try the next. `ChemDraftDrawingPending` is never
  read: an object holding only a pending save is refused as unreadable.
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

**Windows session end** (`windows_session_end.rs`, `office_ole/session_publish.rs`,
`office_ole/recovery.rs`)

- When Windows asks to end the session, every open editor is asked for its drawing, and ChemDraft
  refuses the session end with a reason until each drawing is saved in Office or beyond saving, for
  at most 30 seconds (below). A drawing still at risk has a recovery copy under the app data folder.
- The editors asked are fixed when the session end begins. Registering a newly activated editor
  and beginning a session end are one decision under one lock: an editor that finishes activating
  after the session end began is refused, its window is closed and Office's activation fails, so no
  open editor is ever left out of the session end.
- An editor that cannot render or send its drawing answers with a failure instead of staying
  silent. ChemDraft then stops waiting for it, keeps refusing the session end with the document's
  name, and keeps a recovery copy of its last known drawing; the editor unlocks, so Update and
  Close work again once the user cancels the sign-out.
- **Recovery copies are written off the message thread** (`office_ole/recovery.rs`). One writer
  thread does every disk operation of a session end: each recovery copy (written to `.partial`,
  synced, then renamed into place), each stale copy's removal, and the Office log
  (`office-session-end.log`). It starts as soon as the session end begins and is woken whenever an
  editor's drawing arrives or Office saves or closes an object, so copies are written while the
  editors are still being asked. The thread that answers Windows only reads shared state and pumps
  messages; it never touches the disk.
- **Queued is not durable.** A copy counts only once the writer has synced and renamed it and
  recorded it in the tracker. Until then the session end stays refused with the generic reason,
  even if Office holds every drawing it can still take. So a drawing Office closed is never allowed
  through with only an older copy.
- **Byte budget.** One session end writes at most 50 MiB of copies (two drawings at the 25 MiB
  IPC limit). A drawing past the budget gets no copy; the log says so, as for any failed write.
- **Refusal has a time limit.** Thirty seconds after a session end begins, ChemDraft stops refusing
  it, even if a drawing is still unsaved in Office or its newest copy is not written yet. It logs
  each such drawing and says whether its recovery copy holds its newest drawing.
- **Committed session end** (WM_ENDSESSION with TRUE). Every wait is bounded, measured from the
  message (`windows_session_end.rs`). Before the message returns, ChemDraft waits (still pumping
  messages) for the recovery copies until 2.5 s, then logs what is still at risk and waits for the
  writer to close until 2.75 s. The watchdog fires at 3 s, waits for the writer until 4 s at most
  (below the 5 s after which Windows lists an app as not responding), and then always force-exits,
  even if a write is in flight. A copy that finishes after its deadline is deleted and never renamed
  over the last good copy, and the next start removes any leftover `.partial` files
  (`remove_stale_partials`).

**Palette clicks in an editor.** A click in an editor's palette arms a native key guard for up to
one second, while the palette works out whether the click takes keyboard focus. Meanwhile Delete,
Paste, Undo and Redo are held back from the drawing. A pointerdown on the editor's page releases the
guard through the `palette_key_guard_clear` command. That command releases only a click pending in
the calling window's own palettes. It is granted to the document window and `office-object-*`.
Office windows have no app-wide event-emit permission, and the page does not need one.

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

   - **Nothing reads the containers until the user acts.** There is no status check at launch, on
     focus or anywhere else (AGENTS.md §13): a launch-time check raised the prompt with no user
     action, for example after a rebuild. Both Help rows, *Install Office Add-in…* and *Remove
     Office Add-in…*, are always enabled (disabled only while one of them runs). Each reads Office's
     state only after the user chooses it and confirms, and its report says what it found: already
     installed, or for Remove "The Office add-in is not installed in Word or PowerPoint, so nothing
     was removed."
   - **Said before it happens.** The Install confirmation, shown before anything is read or
     written, says macOS will ask next, why (the add-in file goes into Word's and PowerPoint's own
     folders), and that Don't Allow leaves Office unchanged. The Remove confirmation says macOS may
     ask, why, and that Don't Allow leaves Office unchanged.
   - **All or nothing.** `office_addin.rs` reads both apps' state before writing either. A read that
     fails writes nothing. If the second app's write fails, ChemDraft tries to undo the first app's
     change: a new manifest is deleted with any folders created for it, a replaced one is restored
     byte for byte, and a removed one is written back. The undo is conditional: if the file changed
     in the meantime it is left alone (see below), so the report then gives each app's state, and the
     user should check both before retrying. Each write goes through a temporary sibling that is deleted
     on failure. A missing app or an unrecognized file at ChemDraft's filename is a skip, not a
     failure, so the other app still proceeds.
   - **Checked again at the moment of change.** The file can change between the first read and the
     write, for example while the other app's read waits on macOS's prompt. So right before
     replacing or removing a manifest, ChemDraft reads it again and changes it only if it is still a
     regular file that is a ChemDraft manifest (same `<Id>` and `<ProviderName>ChemDraft`), or, for
     Install, if no file is there. A file that no longer qualifies is left alone and reported in
     the same words as at the first read ("… is not a ChemDraft add-in manifest, so ChemDraft did
     not replace it"). An undo reads the file again too and puts the old one back only over exactly
     what the change left: the manifest it wrote, or no file after a Remove. Otherwise it leaves the
     file and reports that the change could not be undone.
   - **Denial named.** `EPERM`/`EACCES` comes back as `errorKind: "permissionDenied"`, with the
     build's bundle identifier (`bundleIdentifier`, from the running app's configuration). The
     message says Office was not changed, because macOS did not allow ChemDraft to access Word's
     and PowerPoint's data; to choose the command again and click Allow when macOS asks; and, if
     macOS does not ask again, to reset that one decision in Terminal and try again, giving the
     exact command for this build: `tccutil reset SystemPolicyAppData org.chemdraft.desktop`, or
     `org.chemdraft.desktop.dev` for a dev build. It never recommends Full Disk Access, which grants
     far more than this needs. Both Help items stay enabled, so choosing one again is the retry.
     Remove is handled the same way.
   - **Off the main thread.** The two commands are `async` and do their file work in
     `tauri::async_runtime::spawn_blocking`, one action at a time, so menus and the window stay
     responsive while the prompt is up. (Tauri 2 runs a non-`async` command on the main thread.)
   - **Help rows from launch.** The rows come from the webview's menu sync. The native menu is built
     before the webview loads, so lib.rs seeds the same rows (`initial_plugin_menu_items`), enabled,
     and the webview's first sync changes nothing. macOS only; the Windows menu has no such rows.
2. **Store listing and IT-admin deployment**: prepare the AppSource listing materials and an IT-admin
   deployment guide (centralized deployment manifest and steps). Submission to the store waits for
   the owner.

| Route | Who | Notes |
| --- | --- | --- |
| Microsoft AppSource (store) | Everyone on a Mac | The production route. Free listing; Microsoft validates the add-in. Users add it from Office's Add-ins button, and it follows their Microsoft account. |
| Installed by ChemDraft, preview | Testing | The `wef` folder in Word's and PowerPoint's containers. Microsoft describes this as sideloading for testing. On macOS, Help ▸ *Install Office Add-in…* (no preference needed); restart Word or PowerPoint afterwards and **Edit Structure** appears on the Home tab. Never the release route. |
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
- **AGENTS.md §13 allowlists**: the pane runs inside Office, not inside the ChemDraft app, so it needs
  no Tauri capability and gives the app no network path. The app's own Help commands that install
  and remove the add-in are a separate, macOS-only grant (`capabilities/office-addin.json`, the
  `office_addin_install` and `office_addin_remove` commands).
- **Where the code lives**: the editor is part of `apps/desktop`, and packages must not import
  `apps/`. So the pane is a second web entry of the desktop app's web build (`office.html`), running
  the same editor in an "Office host" mode, with the Word and PowerPoint adapters in
  `apps/desktop/src/office/`. The carrier reader, the OOXML and .pptx lookups and the whole-file
  importer (`officeImport.ts`) are pure functions in `packages/clipboard-adapter`, shared with the
  desktop paste path and File ▸ Import Structures from Word or PowerPoint…. The manifest lives in
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
- Preview install from Help ▸ *Install Office Add-in…* (macOS only, with the matching `cfg` side
  compiled out on Windows; restart Word or PowerPoint to see **Edit Structure** on the Home tab);
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

**Done (2026-11-21): import structures from a .pptx or .docx file.** File ▸ *Import Structures from
Word or PowerPoint…* (command `document.importOfficeStructures`, the same item in the native menu on
macOS and Windows and in the web menu) opens the native file dialog filtered to `.docx` and `.pptx`,
reads the file through the bounded read behind File ▸ Open (`readNativeFileBytes`), and inserts every
valid structure as one undo entry, left selected.

- **Finding carriers** (`packages/clipboard-adapter/src/officeImport.ts`, `importOfficeStructures`):
  pure, and built on the slice 0 pieces: `readZip`, the namespace-aware XML reader and
  `readChemDraftSelectionFromPng`. PowerPoint: slides in `p:sldIdLst` order, then each slide's
  `p:pic/p:blipFill/a:blip`, groups included, in reading order within the slide (left to right, then
  top to bottom; the same row rule as paste-back; positions include group and picture flips and
  rotations), not drawing order. Word: the main document's DrawingML `a:blip` and VML
  `v:imagedata` in body order, with the paragraph they fall in. In both, ChemDraft embedded objects
  are read too (see "paste and import of ChemDraft embedded objects" below). Both read
  only the chosen branch of `mc:AlternateContent`, so a picture is not counted twice through its
  fallback. Headers, footers, notes, slide layouts and masters are not searched.
- **Untrusted input.** The file is refused, with a specific message, when it is over 64 MB (the
  open-document limit), has more than 2000 entries, an entry over 50 MB or more than 200 MB in all
  once inflated (checked against the declared sizes before anything is inflated, and inflation is
  capped at the declared size), is not a ZIP, or has crafted entry names (a backslash, an absolute
  path, a drive letter, a control character, a `.` or `..` segment, or two names that differ only by
  case). Only `.xml` and `.rels` entries are inflated at first. Then, in a second pass with the same
  limits, exactly the parts that the placed pictures' and embedded objects' relationships target
  are inflated, matched without case (OPC part names are case-insensitive), whatever their
  extension: a picture stored as `word/media/drawing.bin` under a content-type override, or targeted
  as `../MEDIA/IMAGE.PNG`, is still read. A picture part is read as a PNG only when its bytes start
  with the PNG signature. A relationship target that leaves the
  package gives a per-picture warning and is not read; linked (external) pictures are skipped. At most
  500 pictures are checked, and a note says so when there are more. One carrier's JSON may be at most
  8 MB, all carriers together 64 MB.
- **Per-picture warnings** for a carrier that is present but unusable: damaged (CRC, framing, invalid
  UTF-8 or JSON, not a ChemDraft drawing), an unknown data version (only version 1 is read), or over
  the size limits. Pictures without a carrier are not reported.
- **Chemistry check** (`apps/desktop/src/officeStructureImport.ts`, AGENTS.md §7). The carrier records
  no SMILES, so each drawing is read with the same parser as a ChemDraft paste
  (`parseSelectionClipboardPayload`), must keep every molecule with all its atoms and bonds, and must
  survive serialize → parse with the same `chem-core` identity (element, charge, isotope, radical,
  bond-order and connectivity signature, wedge and hash markers). After placement each new molecule is
  compared with its drawing again. A drawing that fails either check is not inserted and is counted
  in the report. Tests also compare canonical SMILES before and after import.
- **Layout and report.** Drawings are laid out by their real extent (never the bounds the file
  claims), left to right in rows that wrap at the page width, below existing content or centered on
  an empty page. The status line says what happened: "Imported 3 structures from Slides.pptx.",
  "Skipped 1: 1 has damaged ChemDraft data.", "No ChemDraft structures were found in Report.docx.
  Only pictures placed from ChemDraft can be imported.", or "Could not import structures from …:"
  with the reason. Per-structure reasons go to the log.
- **Native code.** One `lib.rs` change: the File menu item and its `MENU_COMMAND_IDS` entry, with no
  `cfg` branch. The dialog and file read use permissions the app already had.

**Built (2026-11-21), not yet checked in real Office: paste-back from a copied Office picture,
macOS and Windows.** Copy a ChemDraft structure picture in Word or PowerPoint and paste it into
ChemDraft: the editable structure is pasted, not a flat picture.

- **Finding carriers** (`packages/clipboard-adapter/src/pasteBack.ts`, `recoverPasteBackStructures`
  and `recoverPasteBackFromClipboard`): pure and bounded, on the slice 0 pieces. First Office's
  picture archive, GVML (`Art::GVML ClipFormat` on Windows, `com.microsoft.Art--GVML-ClipFormat` on
  macOS), a ZIP that keeps the picture's original media bytes even when Office re-encodes the PNG it
  also puts on the clipboard: `readZip`, the root and drawing relationships (falling back to every
  PNG part when an archive lacks them), then `readChemDraftSelectionFromPng` on each picture, in
  reading order: left to right, then top to bottom (`inReadingOrder`: pictures whose vertical
  centers are within half the smaller height share a row; positions include group and picture flips
  and rotations), not drawing order. Then the PNG flavor (ChemDraft's own, or Office's when it kept the chunk), only
  when the archive gave no structure. Carriers are judged by `readCarrierEnvelope`, which the file
  importer now uses too, so both refuse the same carriers with the same words.
- **EMF+ is not read**, and the result says so when an EMF flavor is present: ChemDraft has no EMF
  reader (its only EMF code is the slice 2 preview writer, in Rust), and GVML holds the same media.
- **Untrusted input.** The archive is refused, with a note in the log, when it is over 32 MB (the
  native readers refuse it before copying), has more than 200 entries, a part over 25 MB, more than
  64 MB inflated, a crafted or duplicated entry name, or damaged relationships; the PNG is still read
  then. Up to 4 KB of zero bytes after the ZIP end record (Windows reports the allocation size) are
  trimmed. At most 50 pictures are checked; one carrier's JSON may be 8 MB, all together 16 MB.
- **Precedence.** ChemDraft's own selection flavor wins, as before: with it on the clipboard the
  native readers do not fetch the archive and paste-back does nothing. A picture without a carrier
  pastes as a picture, as before. A carrier that is present but unusable (damaged, unknown data
  version, over the limits) pastes nothing and the status says why.
- **Chemistry check** (`apps/desktop/src/officePasteBack.ts`): the importer's own,
  `checkOfficeStructure` then a trial placement with `insertOfficeStructures`. A drawing that fails
  is not pasted: "The copied structure failed the chemistry check: … Nothing was pasted." One
  structure pastes like a ChemDraft selection, at the paste position; several are laid out like
  File ▸ Import Structures, as one undo step. Details go to the log (`[paste-back]`).
- **Native code** (the same on both platforms; AGENTS.md §1). The clipboard read gains an
  `officeItems` list: `clipboard_images.rs` names the two archive formats, picks the one to read only
  when ChemDraft's selection flavor is absent, and checks the 32 MB cap and ZIP signature;
  `lib.rs` (macOS, `clipboard_office_items`) and `windows_clipboard.rs` (`read_office_items`) each read
  the one flavor within the shared read budget, checking its size before copying. Linux returns an
  empty list. The macOS text reader no longer tries GVML as text (`clipboard_limits.rs`). The Office
  formats in `windows_clipboard.rs` are otherwise unchanged; GVML stays out of the text reader there.
- Unverified until run on real Office: the exact GVML layout Mac Office writes (the PNG fallback
  covers a different layout), and that Office renders GVML promptly on request. See
  `docs/manual-stress-checklist.md`, "Paste back from Word or PowerPoint".

**Built (2026-11-22), not yet checked in real Office: paste and import of ChemDraft embedded
objects.** Copy a ChemDraft object (slice 2) in Word or PowerPoint on Windows and paste it into
ChemDraft, or import a .docx or .pptx that holds one, on either platform: the editable structure
comes in, with the same checks, warnings and refusals as a picture's carrier. This completes slice 3.

- **Clipboard, Windows** (`windows_clipboard.rs`, `read_embedded_object`). Word and PowerPoint offer a
  copied object as "Embedded Object"; ChemDraft's own server offers "Embed Source". Unless
  ChemDraft's selection flavor is on the clipboard, the reader asks OLE for the first of the two
  (`OleGetClipboard`, `IDataObject::GetData` with `TYMED_ISTORAGE`, or `TYMED_HGLOBAL` opened with
  `StgOpenStorageOnILockBytes`, at most 50 MiB) on the shared single-flight reader (one long-lived
  thread, made on first use, because OLE needs a single-threaded apartment) and waits at most 10
  seconds. Only one read is outstanding at a time. A paste that arrives while an earlier read is
  still outstanding starts no OLE read: it skips the embedded object and uses the other formats. If
  nothing else on the clipboard can be read, or the clipboard cannot be opened because of that read,
  the paste says "Windows is still reading the previous clipboard item. Try pasting again in a
  moment." The ordinary formats are snapshotted first; OLE opens the clipboard separately, and its
  result is kept only if the clipboard sequence still matches the snapshot.
- **One storage reader.** The object is read by the OLE server's own code
  (`office_ole/server/persist.rs`, `pasted_drawing`): the storage's class (`ReadClassStg`) must be
  ChemDraft's, stable or dev (`office_ole/storage.rs`, `read_pasted_document`, tested on every host),
  and then `ChemDraftDocument`, at most 25 MiB, is read from the same generation `IPersistStorage::Load`
  uses (`drawing_storage`, see "Storage layout" above) by `Load`'s stream reader and checked by its
  decoder (`decode_document`). Another program's object is not read at all and is not
  an error: the paste falls through to GVML and PNG. A ChemDraft object whose storage cannot be read
  is logged and falls through the same way.
- **Precedence.** ChemDraft's own selection flavor, then a ChemDraft embedded object, then GVML,
  then the PNG. The Windows native reader (`read_payload`) snapshots the ordinary formats first
  (text, the PNG) before either optional read can block. It then reads the embedded object (up to
  10 seconds, above) and, separately, GVML, on its own single-flight reader bounded at 1 second; a
  busy, timed-out, unavailable, or refused archive is skipped and the snapshot's PNG is kept. A
  timed-out archive read keeps the clipboard open on its own thread until Office answers (only that
  thread may close it), so a later paste that cannot open the clipboard while either reader is
  outstanding says "Windows is still reading the previous clipboard item…" too, and starts no second
  archive read. GVML is read even when an OLE drawing was read, so one payload's `officeItems` can
  carry both. The TypeScript layer (`recoverPasteBackFromClipboard`, then
  `recoverPasteBackStructures`) checks the
  object's class again (`isChemDraftOleClassId`), judges its drawing first, decodes the GVML archive
  only when the OLE drawing is absent or refused, and falls back to the PNG only when neither gave a
  structure. An object whose drawing is unusable (damaged, a newer data version, over
  8 MB) is refused with the carrier's words ("The copied structure was made by a newer or unknown
  ChemDraft (data version 2)."); it can fall back to a good GVML carrier if the archive was read,
  then to a good PNG carrier, with the refusal in the log. The object's own EMF is its preview and
  is not mentioned.
- **Chemistry check**: the same as a picture's (`officePasteBack.ts`: `checkOfficeStructure`, then a
  trial placement). The status names the source: "Pasted the ChemDraft structure from the copied
  object." Tests compare chemical identity and canonical SMILES (stereo, charges, isotopes).
- **Import** (`importOfficeStructures`). Word: a `w:object` with `o:OLEObject Type="Embed"` (or
  `w:objectEmbed`); PowerPoint: `p:oleObj`, on the chosen `mc:AlternateContent` branch. The object
  takes the place of its preview pictures, which are not read (a linked object's preview stays a
  picture). Each object's `oleObject` part is read by a bounded compound-file reader
  (`packages/clipboard-adapter/src/oleObject.ts`, MS-CFB versions 3 and 4, at most 50 MB, no
  dependency; its sector, mini-sector and directory walks refuse loops and out-of-range indexes). It
  reads the root class and, only for ChemDraft's, `ChemDraftDocument` from the place the storage
  layout above sets (`ChemDraftDrawing`, else `ChemDraftDrawingPrevious`, else the root; never
  `ChemDraftDrawingPending`), refused unread over 8 MB.
  Another program's object is skipped silently. A ChemDraft object (by class or ProgID) that cannot be
  read is reported per object: "The embedded ChemDraft object on paragraph 3 could not be read: … Open
  the file in Word or PowerPoint on Windows, copy the object and paste it into ChemDraft."
- **Class list.** `CHEMDRAFT_OLE_CLASSES` in TypeScript mirrors `OleClass` in `office_ole/mod.rs`;
  `officeEmbeddedObjects.test.ts` fails if they drift.
- **Native code.** `clipboard_images.rs` names the two formats and builds the item (`officeItems`
  gains an optional `clsid`); `windows_clipboard.rs` reads it and no longer offers "Embedded Object"
  to the text reader; `office_ole/storage.rs` and `server/persist.rs` as above. macOS and Linux have
  no OLE clipboard format and return no embedded object; their readers are unchanged.
- Unverified until run on real Office on Windows: that Word and PowerPoint hand over the object's
  storage promptly (and which medium they use), that the storage Office keeps still carries
  ChemDraft's class and `ChemDraftDocument`, and that a saved file's `oleObject*.bin` reads the
  same. On macOS, what Office for Mac puts on the pasteboard when a Windows object is copied there is
  not handled.

## Planned for 1.3 (tracked, not built)

Findings from Windows hands-on testing (2026-11-22, Word for Windows; carrier PNG of 15069 bytes
with a 3064-byte iTXt chunk):

- **Insert > Pictures, Word's default (compress images).** The carrier is kept in memory (copying
  the picture back pastes an editable structure) but lost at save: Word writes a palette PNG
  (2415 bytes, no iTXt).
- **Insert > Pictures with "Do not compress images in file" on.** Kept byte for byte, and
  File > Import works. The option is per document, so it is not a fix.
- **Ctrl+V of a ChemDraft copy (either option).** Word picks ChemDraft's SVG clipboard flavor over
  the OLE object and the PNG. It stores an SVG (1302 bytes) plus a fallback PNG without the chunk, so
  the carrier is lost at paste.
- **PowerPoint** keeps the carrier on save. The Windows OLE object route keeps its drawing, because
  the drawing is not stored in the picture.

Owner decision, 2026-11-22: tell users to insert through Insert > Object (the note in "Owner
decision" above). The two items below are the follow-up.

- **(b) Make the SVG flavor, or the clipboard choice, carry the drawing.** Either carry the drawing
  in the SVG flavor too (an SVG `<metadata>` element with the same JSON, read from SVG media parts),
  or change ChemDraft's Windows clipboard so Office picks the carrier PNG or the OLE object. Open
  check first: whether Word stores ChemDraft's SVG byte for byte.
- **(c) Durable fix: store the drawing in the .docx outside the picture bytes.** Tie it to the
  picture, through its alt-text description or a custom XML part keyed by the picture's ID. The Mac
  add-in writes it, and so does ChemDraft's Copy where possible; import, paste-back and the add-in
  read it. Word documents then stay editable across Mac and Windows under Word's default settings.
