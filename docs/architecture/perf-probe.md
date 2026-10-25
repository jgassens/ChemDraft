# Timing probe for desktop speed runs

The timing probe uses **only the existing agent bridge launch gate**. Close the running copy of
the build before starting a measured run; launching a second instance can forward to the old process.
Launch the packaged executable with `--chemdraft-agent-bridge`, or launch it from a process whose
environment contains `CHEMDRAFT_AGENT_BRIDGE=1`. For example, on macOS:

```sh
"app/ChemDraft (dev).app/Contents/MacOS/chemdraft" --chemdraft-agent-bridge
```

On Windows, launch the executable in the installed build's directory with the same argument (PowerShell):

```powershell
& '.\chemdraft.exe' --chemdraft-agent-bridge
```

There is no performance-specific switch. Desktop ignores URL and localStorage flags. Rust uses the
same env/argument parser as `agent_bridge_status` and injects a read-only bootstrap marker only when
enabled. It checks the gate again at every perf command via its launch-gated state. With the bridge
off, the probe installs no listeners, observers or timers, makes no native calls, and creates no file.
The existing bridge's own permission query is unchanged.

The web preview follows the existing `?agentBridge=1` or `localStorage["chemdraft.agentBridge"]` gate.
It has no native app data directory: it retains up to about 1 MiB of JSONL in
`localStorage["chemdraft.perfLog"]`, replacing the buffer when full. Use packaged builds for desktop
comparisons; web preview's cold-launch measurement begins at the webview time origin.

## Log location and bounds

The native writer always resolves **Rust `app.path().app_data_dir()`**, then appends `perf-log.jsonl`:

| Platform | Typical stable-build location |
| --- | --- |
| macOS | `~/Library/Application Support/org.chemdraft.desktop/perf-log.jsonl` |
| Windows | `%APPDATA%\org.chemdraft.desktop\perf-log.jsonl` |

Branch builds use their own `org.chemdraft.desktop.dev.<worktree-slug>` identifier in that same rule.
The stable build and branch build never share logs. No Web Inspector is needed: open the file after
the run. Leave the app open briefly after the final interaction so queued asynchronous writes finish.
Logging does not delay commands; an abrupt process exit can lose queued lines.

Each UTF-8 JSON line is capped at 16 KiB. Before an append would exceed 20 MiB, Rust replaces
`perf-log.1.jsonl` with the current file and starts a new `perf-log.jsonl`. A process-wide mutex
serializes rotation and appends from all webviews; Windows' rename semantics are handled by removing
the previous backup first. There is at most one backup. The frontend bounds pending samples and
queued writes to 256 each. Invalid lines are refused before creating a directory or opening a file.

## Fields and timing boundaries

Every line follows `PerfRecordSchema` in `apps/desktop/src/perf/probe.ts`; Rust also validates the
v1 envelope before writing. No key text, pointer coordinates, file names or document contents are logged.

| Field | Meaning |
| --- | --- |
| `v` | Schema version, currently `1`. |
| `kind` | `pointerdown`, `click`, `keydown`, `native-command`, `cold-launch`, or `document-open`. |
| `commandId` | Shared registry command ID when available. Absent for input with no command. |
| `window` | Input origin: `main`, `palette`, `palette-popover`, `dialog`, or `plugin-panel`. |
| `platform` | `macos`, `windows`, or `linux`; tests pass the platform explicitly. |
| `buildStamp` | Source stamp, build stamp and worktree label. This slice's source stamp is `10.25.12.40-codex`. |
| `t0` | Input timestamp, aligned to the process's monotonic epoch, in milliseconds. |
| `firstFrameMs` | First rAF observation after the state/DOM update, minus `t0`. It is a paint opportunity, not a compositor or display presentation timestamp. |
| `doneMs` | Completion signal timestamp minus `t0`. It may precede or follow the first frame. |
| `doneSignal` | Observed completion boundary, described below. |
| `extra` | Clock calibration error bound, process start for grouping runs, frame source and optional completion window/ambiguity/incomplete markers. |

Only `isTrusted` pointerdown/click/keydown events start input samples. Synthetic agent pointer events
are excluded. A real click can produce both pointerdown and click rows: compare each kind separately,
not their sum. Canvas pointerdown remains pending across preview frames until the document commits.
The `chemdraft:native-command` delivery is measured from entry into the receiving page. That existing
delivery path also carries forwarded palette commands; its rows are not proof of a menu-only source.

Instrumentation wraps the stable shared `CommandRegistry` instance, observes the existing main
dispatch and document-history install funnels, and watches committed DOM changes. It preserves
command arguments, return values, rejections and invocation count. Completion boundaries are:

- `document-commit`: history installation after an edit; document open waits for the open operation's
  final state update, then requests its frame. `document-open` also gets its own row, starting at the
  open command if present, otherwise at entry to the contents-open funnel (for example a shell open).
  File-picker/user-choice time is included when the command is the origin.
- `window-shown`: the native toolbar or report open operation has returned successfully. Toolbar/report
  frame observations are in the requesting main page; they do not measure the destination's content
  readiness. An explicitly declared plugin panel opener waits for the panel window's open result.
- `dialog-open`: the native ready handshake returned after showing the dialog. The destination then
  sends its first rAF timestamp to the originating sample. Reopening a retained dialog uses the
  completed native open call and a new destination rAF.
- `export-written`: the document owner's export callback returned an `exported` result after the
  final file write. A request-ID receipt carries this timestamp back to the originating dialog;
  progress/accepted/preview results cannot finish an export sample. Dialog Apply uses the same receipt
  route for `document-commit`. The first frame may show the dialog's busy state before the write.
- `command-finished`: the registry promise settled, or a command handled directly by the main
  dispatcher returned, without a stronger registered completion. Window-close toggles use this signal.
- `frame`: input with no command or stronger state signal, observed at the next frame.
- `gesture-ended`: a canvas pointer gesture ended or was cancelled without a document commit;
  pointerup/cancel are observed only to settle its existing pointerdown row.
- `canvas-ready`: first rAF after the main canvas is mounted and session hydration finishes.
- `failed` / `timeout`: a rejected command/open or an incomplete operation. Pending operations expire
  after 120 seconds; expired rows carry `extra.incomplete` and may omit `firstFrameMs`.

Cold launch starts at the beginning of Rust `run()`, before constructing Tauri, and ends at
`canvas-ready`. It includes Tauri, clock calibration, React startup and session hydration. It excludes
OS loader work before entry to `run()` and does not wait for optional palettes/engines. A startup file
open is measured separately. Name that boundary when reporting results; this is not a measurement
from clicking the application's icon.

## One monotonic clock across webviews

Rust samples an `Instant` and the wall-clock epoch once at startup. Subsequent timestamps use
`startup_epoch_ms + Instant::elapsed()`; later wall-clock adjustments cannot change durations.
Each enabled webview takes three clock IPC samples before mounting React, chooses the smallest
round-trip time, and aligns `performance.now()` to the midpoint of that sample. `extra.clockErrorMs`
is half that round trip. This bounds IPC synchronization uncertainty; it is not a clock-drift estimate.
No ongoing calibration timer runs. Very long sessions can accumulate oscillator drift; restart for
each speed run.

Modern input `event.timeStamp` values are relative to `performance.timeOrigin`; legacy epoch values
are converted back to that origin before applying the same offset. All event, rAF and completion
timestamps consequently share the Rust epoch even when they originate in different webviews.
Dialog completion receipts contain only bounded IDs, numeric times and an allowed signal. Rust
authenticates the sender and permits only main-to-dialog/dialog-to-main routes; it never grants
general event emission or filesystem access to dialog or plugin windows.

`extra.frameSource` identifies `dom-commit`, `input-task` (no DOM mutation observed), `document-open`,
`window-shown`, `gesture-end`, or `destination-window`. Concurrent commands with ambiguous commit attribution are labelled
`extra.ambiguousCompletion`; compare serial operations and exclude those rows. The probe does not
claim command-specific completion for arbitrary plugin background work after its command returns.

## Comparing macOS and Windows

Use the same commit, source stamp, document, page/zoom, plugin set, saved-session state, display
refresh rate and operation sequence. Run a cold launch separately from repeated warm actions.
Record the worktree/build labels. Exercise real pointer/keyboard/native-menu input; synthetic agent
events are deliberately unsuitable for these latency comparisons. Make one action at a time and
wait for it to finish. Repeat at least five times and compare medians for matching
`kind`, `commandId`, `doneSignal`, `window` and `extra.frameSource` values.

For example, these illustrative rows represent matching warm document-open runs:

```jsonl
{"v":1,"kind":"document-open","commandId":"document.open","window":"main","platform":"macos","buildStamp":"example","t0":1000000,"firstFrameMs":180,"doneMs":160,"doneSignal":"document-commit"}
{"v":1,"kind":"document-open","commandId":"document.open","window":"main","platform":"windows","buildStamp":"example","t0":2000000,"firstFrameMs":220,"doneMs":195,"doneSignal":"document-commit"}
```

The Windows first-frame observation is 40 ms longer (220 − 180); commit completion is 35 ms longer.
The differing absolute `t0` values do not enter that comparison. Filter out `failed`, `timeout`,
`extra.incomplete` and `extra.ambiguousCompletion` rows, and report calibration bounds beside small
differences. Treat illustrative numbers as examples, never benchmark claims.

The packaged macOS/Windows hands-on pass should also verify the bridge-off run creates no log,
dialog/window focus is unchanged, and an export row appears only after its file is written.
