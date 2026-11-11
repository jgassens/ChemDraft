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
snapshots. Hiding the migrated main window and process teardown keep its saved entry, preserving
the existing single-window behavior. A7 owns the subsequent close-versus-quit lifecycle split.

The renderer keeps its 800 ms debounce and per-window serializer WeakMap. Native writes occur at
most every 800 ms across **all** windows, with one coordinator timer to publish pending changes.
`flush = true` bypasses the limit; strict update flushes propagate disk/backup errors. Quit handlers
submit with `flush = true` before confirmation. Native quit also calls `flush()` to drain accepted
snapshots when a renderer misses its grace period. This does not replace A7's future all-renderer
flush barrier: another renderer's unsubmitted edits still require its acknowledgement there.

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
through chemistry formats. These hooks expose no renderer command and move no tabs; A10b remains held.

Rust tests cover exact migration/backup, one-window parity, two-window interleaved revisions,
800 ms throttling, immediate flush, per-window distribution, the temporary combined restore,
unreadable data, sticky read/fresh-start guards, backup failure, close tombstones and hand-off.
Native queue tests cover three files and a failed batch member. TypeScript tests cover queued
opens during hydration on macOS/Windows parameters, effect replay, wake-up races, increasing IPC
revisions, strict failures, fresh-start parity, readable-tab future metadata and existing recovery.

Worker verification passed 59 session/queue unit cases, 9 quit IPC cases, 7 startup-preference
cases and 13 focused MainWindow session cases. The broad `App.test.ts` run passed 228 cases and
failed two pre-existing panel source assertions (the expected parent/title patterns are absent in
HEAD). The general tab and save-mid-edit runs were stopped before completion; scoped session
regressions were run separately. These are scoped results, not a full-gauntlet claim.

The worker ran no Cargo command, native build or application launch, per task instruction.
macOS Apple silicon, macOS Intel and Windows native behavior remains unverified. The integrating
coordinator must run Rust fmt/clippy/tests, launch the worktree build, and exercise migration,
backup failure, crash/relaunch, quit/update, fresh startup and multi-file Finder/Explorer opens.
