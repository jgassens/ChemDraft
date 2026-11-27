# Art Library, phase 0: drag spike, hands-on steps

Phase 0 of [`art-library.md`](art-library.md), section 3 ("Drag and drop"), asks one question:
**does a real operating-system file drag started in one of our floating windows reach the document
window's existing drop path, on macOS and on Windows?** The answer decides whether phase 3 drags
tiles as real files or falls back to the in-app drag described in that section.

Nobody has done the hands-on drag yet. This page says how, and what to send back.

## What was built

- `apps/desktop/src-tauri/src/art_library.rs`: the command `art_library_start_drag(path, onEnd)`,
  which starts a file drag of one SVG from the calling window with the `drag` crate (CrabNebula,
  Apache-2.0 OR MIT, 2.1.1): `NSDraggingSession` on macOS, OLE `DoDragDrop` on Windows. It refuses
  any path that is not a plain absolute path to a regular, non-empty `.svg` file under 4 MiB inside
  `<app data>/art-library/` or `<resource dir>/art/`. The path is checked by text before the disk is
  touched (a UNC share is refused there), then opened **once**, without following a link as the
  file itself; the open handle is checked (regular file, size, its own resolved path inside a
  resolved root, compared with exact case, and not on a network volume or mapped network drive) and
  the bytes are read from that handle, at most 4 MiB. The drag image is the SVG drawn at up to 96 px
  (a plain grey tile if it cannot be drawn). Linux refuses ("not available on this platform yet").
- **The drag carries a copy, never the original.** The bytes read above are written to a new
  file in an app-owned local staging folder, one folder per drag, and only that copy's
  path is given to the drag library. The receiving app sees the **original file name**
  (`drag-test.svg` for the harness tile) in a folder named `drag-` plus 16 hex digits:
  - macOS: `~/Library/Application Support/org.chemdraft.desktop.dev/art-drag-staging/drag-<hex>/drag-test.svg`
  - Windows: `%LOCALAPPDATA%\org.chemdraft.desktop.dev\art-drag-staging\drag-<hex>\drag-test.svg`
    (local app data, so it stays on this computer even when the roaming profile is redirected to a
    share; a staging folder on a network location is refused with an error).

  (A stable build uses `org.chemdraft.desktop` in place of `org.chemdraft.desktop.dev`.) A copy is
  deleted at once when its drag is cancelled or fails to start, two minutes after it is dropped (the
  receiving app, our own document window included, reads it after the drag ends), and at the next
  launch once it is older than those two minutes (so a drag started during launch keeps its copy).
  The two minutes run from the drop, not from when the copy was made, so a drag held longer than
  that keeps its copy after the drop too. On Windows, a drag whose end the library reports as an
  error that may follow a drop keeps its copy for the same two minutes.
  Cleanup is never recursive: it deletes the one copied file inside a `drag-<hex>` folder of
  `art-drag-staging`, then that folder if it is empty, and never follows a link (a staging folder
  replaced by a link is left alone). It also removes nothing when the folder now at the staging path
  is not the one the copy was made in (an enclosing folder moved, replaced or linked elsewhere), and
  the first cleanup after launch removes nothing unless the folder's own path, as the system reports
  it, is the staging path itself (an enclosing folder replaced with a link before launch leaves
  cleanup off until a later launch finds the real folder; the reason is logged). The copy is not marked read-only, because Finder and Explorer carry that onto the file
  they make at the drop target. If the drag library itself fails (its Windows code panics when the shell cannot build a
  data object), the panic is caught and the drag rejects with "Art drag could not start: …" instead
  of the app quitting.
- `capabilities/art-library-drag.json`: the command is granted only to Templates dialog windows
  (`dialog-main-structureTemplates-*`), on macOS and Windows. No other capability changed.
- **DEV-ONLY harness, to be removed in phase 3:** in a development build the Templates dialog
  shows one extra **Drag test** tile at the top of its list, marked "development build only". On
  first show, Rust (`art_library_dev_drag_test_prepare`) writes a fixed SVG to
  `<app data>/art-library/spike/drag-test.svg` (to a fresh file, then renamed into place, so it
  never writes through a link or hard link left there); pressing on the tile and moving the pointer more
  than 4 px starts the drag. The status line under the tile reports "Dragging…", then either
  "Dropped (pointer at x, y)." or "Drag cancelled: nothing accepted the file.", or Rust's refusal.
- The document window's drop handling is unchanged. A dropped file arrives through
  `tauri://drag-drop`, `file_drop.rs` re-sends it as `chemdraft://document-file-drop` with the page
  position, and `runFileDrop` reads it through the fs plugin's drop scope, exactly as for a file
  from Finder or Explorer. Nothing in that path knows or cares which application the drag came from.

The tile appears only when **both** hold: the app runs under the development identifier
`org.chemdraft.desktop.dev` (every `./run-app`, `./run-app --dev`, `pnpm dev`, and branch build)
and the build carries a worktree label. A stable build is `org.chemdraft.desktop` and unlabelled, so
its dialog never asks for the tile and Rust would answer "no" if it did.

## Before you start

- Use a checkout of this branch with the dependency rows applied (see "Open items" in the phase 0
  handoff: `dependency-inventory.md`, `NOTICE`, and `apps/desktop/src/about/holderData.json` need the
  new `drag` crate before Vite will build).
- Quit any other ChemDraft (dev) build first; only one runs at a time (AGENTS.md section 15.2).
- Have an SVG-capable app to drop into: on macOS, Keynote or Pages (or Preview, or a browser
  window); on Windows, PowerPoint or Word (or Edge or Chrome).
- Note the label in the window title (`ChemDraft — <worktree> [<branch>]`) and the build stamp.

## macOS

Launch (Apple silicon; add `-t x86_64-apple-darwin` on an Intel Mac or to test the Intel build):

```bash
./run-app
```

`./run-app --dev` also works (Vite hot reload). Success signal: the `run-app` banner prints the
label, and the app bundle path under `<worktree>/app/`.

1. Open a new drawing. **Insert > Templates…** opens the floating Templates dialog.
   - Expect: a dashed "Drag test — development build only" box at the top of the list with one
     flask tile, `drag-test.svg`, and the line "Press and drag onto a document, the desktop, or
     another app."
2. **Onto the canvas.** Move the Templates dialog off the document window if it covers it. Press on
   the flask tile, drag onto an empty part of the page, release.
   - Expect: while dragging, a small flask image follows the pointer and the pointer shows the
     copy badge over the document window. On release, the flask is placed as a picture **where you
     released**, selected, as one undo entry; Undo removes it, Redo restores it. The tile says
     "Dropped (pointer at …)".
   - Also try dropping it on a page edge and on the tab strip (both should place it, as a file
     dragged from Finder does), and with the dialog on a second monitor if you have one.
3. **Compare with Finder.** In Finder go to
   `~/Library/Application Support/org.chemdraft.desktop.dev/art-library/spike/` and drag
   `drag-test.svg` onto the canvas.
   - Expect: identical result to step 2 (same placement rule, same undo behaviour).
4. **Onto the desktop.** Drag the tile onto the desktop (or into an open Finder window).
   - Expect: a copy named `drag-test.svg` appears there (the original stays in app data, and so
     does the staging copy, for two minutes). The tile says "Dropped …". Open the copy in Quick
     Look: the flask. Report whether Finder shows any other name.
5. **Into another app.** Drag the tile into a Keynote slide (or Pages, or a browser window).
   - Expect: the app inserts or opens the SVG as it would a file from Finder.
6. **Cancel.** Start a drag and press Escape before releasing, and separately release it back
   over the Templates dialog itself.
   - Expect after Escape: the image slides back, the tile says "Drag cancelled…". Release over
     the dialog: nothing is inserted anywhere; report what the status line says.
7. **Repeat** steps 2 and 4 three times in a row, and once more after closing and reopening the
   Templates dialog. Expect the same each time, and no crash.
8. **Staging cleanup.** Open
   `~/Library/Application Support/org.chemdraft.desktop.dev/art-drag-staging/` in Finder.
   - Expect: one `drag-<hex>` folder per drag made in the last two minutes, none older; after a
     cancelled drag, no new folder stays. Quit, wait two minutes and relaunch: the folder is
     empty.

## Windows

Launch from the worktree in PowerShell or Command Prompt:

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

Success signal: the console prints the label, the bundle id `org.chemdraft.desktop.dev`, and the
Vite port, then the app window opens with the label in its title. (A CI-built branch installer is
also a development build and also shows the tile.)

1. Open a new drawing. **Insert > Templates…** opens the Templates dialog.
   - Expect: the dashed "Drag test — development build only" box with the flask tile, as on macOS.
2. **Onto the canvas.** Drag the tile onto an empty part of the page and release.
   - Expect: a drag image follows the pointer (Windows draws it semi-transparent) with the copy
     cursor over the document window; on release the flask is placed **where you released**,
     selected, as one undo entry; Ctrl+Z / Ctrl+Y undo and redo it. The tile says
     "Dropped (pointer at …)" — on Windows these are physical pixels, so on a scaled display the
     numbers are larger than the logical position; that is expected.
   - Try it at 100% and at 150% or 200% display scaling, and with the dialog on a second monitor
     with a different scale if you have one.
3. **Compare with Explorer.** In Explorer open
   `%APPDATA%\org.chemdraft.desktop.dev\art-library\spike\` and drag `drag-test.svg` onto the
   canvas.
   - Expect: identical result to step 2.
4. **Onto the desktop.** Drag the tile onto the desktop or into an Explorer window.
   - Expect: a copy named `drag-test.svg` appears there; the original stays in `%APPDATA%`.
     Report whether Explorer shows any other name.
5. **Into another app.** Drag the tile into a PowerPoint slide (or Word, or a browser window).
   - Expect: it inserts or opens the SVG as a file from Explorer would.
6. **Cancel.** Press Escape mid-drag; separately release over the Templates dialog itself.
   - Expect after Escape: "Drag cancelled…", nothing inserted. Over the dialog: nothing inserted;
     report what the status line says.
7. **Repeat** steps 2 and 4 three times, and once more after closing and reopening the dialog.
   - Also watch for: the document window or palettes freezing during the drag (Windows runs the
     drag's own message loop on the app's main thread until you release), focus jumping, the
     Templates dialog appearing on the taskbar, or a menu-bar flicker.
8. **Staging cleanup.** Open `%LOCALAPPDATA%\org.chemdraft.desktop.dev\art-drag-staging\`.
   - Expect: one `drag-<hex>` folder per drag made in the last two minutes, none older; after a
     cancelled drag, no new folder stays. Quit, wait two minutes and relaunch: the folder is
     empty.

## What to report back

For each platform, and for each numbered step:

- pass or fail, with what you saw if it differs from "Expect";
- the status line text after each drag;
- for step 2, how far the picture landed from the release point (roughly), and the display scale;
- anything unexpected: a crash, a hang, a second copy, the drag image missing or the wrong size,
  focus moving to another window, an error in the dialog.

Also report the exact launch command, the label in the title bar, and the build stamp, so the build
can be identified (AGENTS.md section 15).

A failure in step 2 on either platform (the file does not arrive on the canvas, or arrives in the
wrong place in a way the Finder/Explorer comparison in step 3 does not share) triggers the fallback
in `art-library.md` section 3 for that platform.

## What was and was not run

Run by the phase 0 worker, on macOS (Apple silicon) only:

- `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `cargo test` for
  `apps/desktop/src-tauri`: pass. These include the path-guard tests for both rule sets (Windows
  rules tested from macOS by passing the platform in: drive letters, `\` and `/`, UNC shares,
  verbatim and device paths, case-insensitive names, reserved names, alternate data streams),
  real-file tests (missing, folder, empty, oversized, outside, link escape), the drag-image
  renderer, the harness gate, and a resolution of the shipped capabilities proving that only
  Templates dialog windows may call the two commands.
- `pnpm lint` and the Vitest suites under `apps/desktop/src/dialogs` and
  `apps/desktop/src/artLibrary`: pass.

Phase 0 fix round (single open, staged copy, exact canonical containment, network refusal,
panic guard), run on macOS (Apple silicon) only: `cargo fmt --check`, `cargo clippy --all-targets
-- -D warnings`, and the `art_library` tests pass. New tests cover a case-sensitive Windows sibling
(`art-library` against `ART-LIBRARY`, platform passed in), UNC and mapped-drive classification,
a panic in the drag library turning into a rejection, the staged copy (fresh folder per drag,
original name kept, unchanged when the original is replaced, removal limited to its own folders,
no link followed), a FIFO refused without blocking, and the harness writer replacing a hard link
instead of writing through it. `pnpm lint` and the Vitest suites above pass.

**Not run, by anyone:**

- Any hands-on drag, on either platform. Nothing above proves that the drag starts, that the
  document window receives it, or that Finder, Explorer or other apps accept it.
- The app was not launched from this branch.
- Windows was not built at all. The Windows code path (`drag` on OLE, `cfg(windows)` sides,
  including the fix round's Windows file primitives: `FILE_FLAG_OPEN_REPARSE_POINT` opens, folders
  held without delete sharing, `GetFinalPathNameByHandleW`, `GetDriveTypeW`, and the Windows-only
  `links_cannot_escape_a_root` test) was written but never compiled; Windows CI (fmt, clippy,
  tests) is its first compile. No UNC share, mapped drive or case-sensitive folder was tried.
- Linux: the command compiles to a refusal there; not built.
