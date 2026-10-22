# Multiple document windows

Each native document window owns its existing tab controller, undo histories, selection,
viewport and plugin runtime. Rust registers document labels and remembers the active owner.
Utility windows have an immutable document owner assigned when they are created. They never
receive document creation, transfer, session or quit permissions.

## Opening and moving documents

Open targets the active document window. A native file claim identifies an already-open file
and activates its owning window and tab instead of creating another editable copy. Native
open-with deliveries retain the destination selected when the request arrived.

File offers New Window, Move Tab to New Window and Move Tab to Window. A move settles drafts,
checks outstanding saves and plugin work, freezes the source and flushes its recovery snapshot.
The transfer includes complete undo/redo history and labels, file state, selection, viewport,
scroll and warnings. Runtime capabilities and native dialogs are not transferred.

The destination validates and stages the tab, persists its candidate state, then acknowledges
receipt. Rust commits the source removal and destination ownership together. Before that commit,
workspace persistence omits the destination candidate; after it, late source autosaves omit the
moved tab. The source removes its live copy only after acceptance. Failed transfers keep the
source drawing. An emptied source closes unless it still holds unreadable recovery drawings.
Transfer receipts contain only metadata. Snapshot reads use recipient-authenticated chunks of
at most 1024 Unicode characters, each measured below Tauri's shared-response-queue threshold.
Terminal receipts release their snapshot buffers while retaining status for source confirmation.

## Sessions and quitting

The existing `document-session.json` migrates to a workspace envelope with `workspaceVersion: 1`,
`windows` keyed by document label, and `activeWindow`. Each renderer can update only its own
record. A native mutex serializes merge and atomic replacement. Legacy one-window sessions and
unreadable recovery data remain supported. File grants are renewed only from natively read,
validated persisted paths using the existing conservative checks.
If the last `main` tab moved to another window, launch promotes the saved active document
into the configured `main` window, avoiding an extra empty window while retaining peer
sessions and unknown recovery records.

Closing a window runs its own optional save decision and session flush; peers remain open.
Closing the last Windows document enters application Quit. The last macOS document retains
the existing hide-and-Dock-reopen behavior after its close decision and flush.

Application Quit uses the existing QuitFlow and Windows exit watchdog. With save prompting
enabled, document owners make their decisions in sequence; cancellation or failed saving
cancels the coordinated quit. Successful earlier saves remain saved. After the decisions,
every participating window receives a targeted final flush. Acknowledgements must match the
native flush generation and participant, and one acknowledgement cannot exit early. The
existing bounded grace remains available for an unresponsive renderer. Ordinary macOS Dock
Quit follows this flow too; system termination remains non-blocking.

Updater installation separately requests strict persistence from every window before replacing
the application. Plugin storage uses native per-key mutations to avoid whole-file lost updates
between independent runtimes.
Interactive 3D sidecar sessions are also bound to their originating native document owner;
replacement, polling and teardown cannot operate on a peer's session.

## Delivery and menus

Rust-to-document messages use `emit_to` with an explicit registered label. Document and utility
listeners subscribe to their current window. Reports, command snapshots and edit requests stay
within the immutable owner group; shared preferences and toolbar customization explicitly
target their intended windows.

Every Windows document receives the full app menu, including Toolbars; utilities receive no
menu. macOS retains its app-wide menu, refreshed for the active document. Shared toolbar
visibility stays synchronized, while document view state belongs to its owner.

Verification is recorded with the implementation results. Native menu, focus, close/quit,
mixed-DPI and recovery behavior require the standing manual checklist on both platforms.
