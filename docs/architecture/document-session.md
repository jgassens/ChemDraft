# Document session persistence

`apps/desktop/src-tauri/src/session_coordinator.rs` owns `document-session.json` in the
application data directory. Stable and dev identifiers, directories and single-instance locks
are unchanged. Renderers never write the session file themselves.

## Format and preservation

```json
{
  "version": 2,
  "windows": [
    { "id": "main", "frame": null, "activeTabIndex": 0, "tabs": [] }
  ],
  "activeWindowId": "main"
}
```

Tabs retain their version 1 document envelopes: serialized document contents, file path, dirty
flag, display name, saved time, pristine flag, viewport and warnings. A window can also carry
`unrestoredTabs`, opaque raw entries kept by the existing recovery flow. Existing active-document
mirror fields stay on the window for compatibility. Unknown root/window fields are carried by
the coordinator. Unknown readable-tab metadata, including nested view/report metadata, is retained
by MainWindow alongside each restored tab and merged with freshly serialized known fields.
Unreadable tab envelopes are never interpreted by the coordinator or silently discarded.

A v1 tab session becomes exactly one window with the same tab array, active index, paths, dirty
flags and raw recovery entries. A legacy single-document envelope becomes that window's sole tab.
Reading does not change the file. Before the first v2 replacement, the coordinator atomically
writes the original v1 **bytes** to the sibling `document-session.json.v1.bak`. An existing regular
backup is never replaced, including on later launches. A backup failure prevents replacing v1.
Unknown versions, malformed outer envelopes and read errors leave the native write gate closed.

The existing `write_file_atomic` helper writes both backup and session using sibling temporary
files and atomic replacement (including the existing Windows retry). The coordinator mutex spans
replacement, so an earlier writer cannot publish after a newer snapshot. A failed replacement
retains the previous complete file and leaves the merged state dirty for retry/flush.

## Startup and restore

Native setup reads once, before the document requests restoration. `restore_window(id, fresh_start)`
returns only that window's assigned v1-shaped restore view. File scopes are renewed on a detached
copy through `document_session::restore_file_scopes`; transient path-access errors do not modify
the persisted original. React effect replay uses the same cached restore input.

**A6 fallback until A10:** setup uses `initialize(path, "main", true)`. All saved windows' tabs
are restored into the first native window, in saved-window order. The saved active window's active
tab determines the combined active index. Recovery lists are concatenated in window order. The
complete original windows are retained under `collapsedSessionWindows` on the combined window,
so conflicting unknown window metadata is also recoverable. That field is provenance, never a
second source of restore candidates. A single saved window behaves as before. No additional
native windows are created by A6. A10 can disable this fallback (`collapse = false`) and request
each saved id independently; the coordinator already tests this distribution path.

The fresh-start preference is captured before asynchronous IPC, and the first restore request
establishes it for the whole coordinator. The document still validates the session even when
skipping installation. Its sticky pristine guard refuses to submit an untouched startup blank,
including on quit or viewport changes. Native metadata updates cannot bypass that guard. A
submission with `replace_preserved = true` records that the document has passed its guard because
of new work, an explicit save/open, additional tabs, or an explicit recovery decision. After that,
the normal whole-session write path is open. No renderer may submit before its native restore read.

## Snapshot and flush API

The existing document-only IPC names are retained:

- `load_document_session({ freshStart })` delegates to `restore_window`, then renews file access.
- `save_document_session({ state, revision, flush, replacePreserved })` derives the window id from
  the authenticated native caller; a supplied snapshot cannot name another owner.

`saveDocumentSession` allocates a monotonic revision per webview before asynchronous IPC preparation.
`submit(id, revision, snapshot, replace_preserved, flush, now)` accepts only increasing revisions
for that window. Stale/duplicate submissions cannot roll back any window; a stale flush still
flushes the latest accepted merged state. Windows retain their insertion order. `set_active` and
`set_frame` record native metadata; frame capture shares the existing minimized/fullscreen/normal
frame guards. `close_window` removes an actual closed window and tombstones its id against late
snapshots. Application quit and process teardown keep the saved entries, preserving
the quit-time restore behavior. A7 destroys closed document windows; only application quit keeps
the open windows in the session.

The renderer keeps its 800 ms debounce and per-window serializer WeakMap. Native writes occur at
most every 800 ms across **all** windows, with one coordinator timer to publish pending changes.
`flush = true` bypasses the limit; strict update flushes propagate disk/backup errors. Quit handlers
submit with `flush = true` before confirmation. Native quit also calls `flush()` to drain accepted
snapshots when a renderer misses its grace period. The A7 barrier also waits for each renderer's
unsubmitted edits, using an operation ticket and the authenticated window label for acknowledgements.

## Window close, application quit and update (A7)

Native close requests enter `request_close_window`, separately from application Quit. Closing a
document always settles its drafts and asks about dirty tabs, even with ask-to-save-on-quit off.
The existing native Save / Don't Save / Cancel prompt is shared with quit. Window closes have
their own cancellable request identity and never time out into discarding a drawing. A failed
strict snapshot or close write leaves the window editable, including its native dialog coordinator.

For a non-last document on either OS, and the last document on macOS, the final snapshot goes to
the coordinator. `close_window` removes that entry and flushes immediately, bypassing the 800 ms
timer, before native destruction. A failed replacement rolls back the removal. If the bounded close
wait expires while its worker finishes a disk write, the accepted window snapshot and its revision
authority are restored; a failed native destruction rolls back the close too. Late snapshots for
the closed incarnation are refused. Recreating the first window resets its revision sequence and
returns no closed tabs. Windows' last document instead enters the existing A6 application quit flow
with a mandatory save choice; its final state is retained for quit-time session restore.

`DocumentWindowRegistry` is the only source of window counts; runtime, palettes, popovers,
tooltips, dialogs and plugin panels do not count. Approved closes serialize with window creation
and recheck the count at commit. Shared palettes are hidden with zero documents on macOS and
re-owned before a Windows document owner is destroyed. The plugin runtime, coordinator, recognition,
naming, external tools and assistant services survive document destruction; their shutdown remains
on application exit. Document-bound dialogs and plugin panels close with their own owner.

macOS stays alive without a tray icon and without a document window. Dock reopen, a second launch,
and OS file opens use the existing reveal/open queue path to recreate the migrated first window.
A10 alone enables more than one native document window. The app-wide native menu and Sparkle
remain available with zero documents; Sparkle termination drains the coordinator through A6's
existing AppKit TerminateLater handshake, including the zero-window case.

Application Quit visits every document. Preference-off quits request all final snapshots together;
preference-on quits visit each window's dirty choices in sequence. No first acknowledgement can
finish the application. Each choice has a fresh request id, and cancellation releases documents
that already answered. The existing bounded grace, AppKit single reply and Windows teardown
watchdog remain authoritative. Failed flushes wait for that grace instead of claiming confirmation.
Windows update installation uses the same renderer flush event, operation tickets and coordinator
drain, but refuses installation on a window error or missing acknowledgement. An update cannot
supersede an active quit question. A zero-document barrier completes immediately and still drains
the coordinator.

## OS file-open queue

`PendingOpenDocument` is a native FIFO. Windows single-instance arguments and macOS
`RunEvent::Opened` queue every file, in order, and continue after a failed member, returning the
collected errors. Paths use `Path`/`PathBuf`. Live events target the active document window and
carry only a wake-up; document bytes are consumed once via `take_pending_open_document`.

MainWindow subscribes before the initial drain. `createNativeOpenQueue` serializes consumption;
the existing `openDocumentContents` hydration/prompt queue still decides when installation is
allowed. Wake-ups during an in-flight poll are retained. A result arriving during React effect
cleanup stays buffered until resubscription. Other utility windows cannot drain the native queue.

## Held hand-off hooks and verification

`offer(from, to, tab_id, data)` stages opaque JSON and returns a receipt. `installed(to, receipt)`
accepts only the destination once; `release(from, receipt)` accepts only the source after
installation and retires the receipt. Duplicate offers for a tab, foreign acknowledgements,
early release and replay are refused. Closing either window cancels its offers. A stub-client
Rust test transfers complete opaque history/baseline metadata without parsing or serialization
through chemistry formats. `can_close_after_handoff` validates an installed destination and its live
registry entry before the future no-prompt empty-source close; `close_quits` counts the documents
after that installation, including on Windows. These hooks expose no renderer command and move no
tabs; A10b remains held.

Rust tests cover exact migration/backup, one-window parity, two-window interleaved revisions,
800 ms throttling, immediate flush, per-window distribution, the temporary combined restore,
unreadable data, sticky read/fresh-start guards, backup failure, close tombstones and hand-off.
Native queue tests cover three files and a failed batch member. TypeScript tests cover queued
opens during hydration on macOS/Windows parameters, effect replay, wake-up races, increasing IPC
revisions, strict failures, fresh-start parity, readable-tab future metadata and existing recovery.

A7 adds platform-parameterized close-count tests, immediate removal/reopen and failure-retry disk
tests, multi-document barrier and zero-document update tests, mandatory dirty-close DOM tests and
dialog reuse after a failed close. Native hands-on checks still need macOS Apple silicon, macOS
Intel and Windows: close-first/last, Cancel/Save/Don't Save, Dock reopen, file open with no documents,
shared palette survival, all-window quit and update (including a zero-document Sparkle update).
