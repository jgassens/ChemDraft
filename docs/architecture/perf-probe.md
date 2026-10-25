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

Browser methods in the probe environment always call their owning `window` or `performance`
object. WebKit and WebView2 can reject a detached method with an illegal-invocation error.
In particular, cold launch clears its expiry timer before appending its first row: an unbound
`clearTimeout` previously prevented even that startup row from being written, before any input.
The startup path remains clock/stamp registration before React mount, then session hydration,
`readyCanvas()` and its first rAF; no click is required to create the log.

Probe listeners, deferred callbacks, frame/timer callbacks and app-facing hooks contain diagnostic
errors. The first failure logs one warning and disables the probe, clears pending samples and
attempts every listener/timer/frame cleanup even if one cleanup fails. Later hooks are inert;
normal pointer handlers and registry command results/rejections continue unchanged. Native append
or completion failures also disable the probe. Restart the app after correcting a logging failure
to collect a new run.

Each UTF-8 JSON line is capped at 16 KiB. Before an append would exceed 20 MiB, Rust replaces
`perf-log.1.jsonl` with the current file and starts a new `perf-log.jsonl`. A process-wide mutex
serializes rotation and appends from all webviews. Rotation first tries rename with replacement;
if that fails (for example a Windows sharing restriction), it copies to the backup and truncates the
current file only after the copy succeeds. The first rotation error per process is reported to stderr,
and later appends can retry a failed rotation. There is at most one backup. The frontend bounds pending samples and
queued writes to 256 each. Invalid lines are refused before creating a directory or opening a file.

## Fields and timing boundaries

Every line follows `PerfRecordSchema` in `apps/desktop/src/perf/probe.ts`; Rust also validates the
v1 envelope before writing. No unbound key text, pointer coordinates, file names or document contents are logged.

| Field | Meaning |
| --- | --- |
| `v` | Schema version, currently `1`. |
| `kind` | `pointerdown`, `click`, `keydown`, `native-command`, `cold-launch`, `document-open`, `window-shown`, or `dialog-open`. The last two are additional surface rows, not additional inputs. |
| `commandId` | Shared registry command ID when available. Absent for input with no command. |
| `window` | Input origin, or destination role for surface rows: `main`, `palette`, `palette-popover`, `dialog`, `plugin-panel`, `preferences`, or `spin3d-debugger`. |
| `platform` | `macos`, `windows`, or `linux`; tests pass the platform explicitly. |
| `buildStamp` | `CURRENT_BUILD_STAMP` from `MainWindow.tsx`, build stamp and worktree label. |
| `t0` | Input timestamp, aligned to the process's monotonic epoch, in milliseconds. |
| `firstFrameMs` | First eligible rAF observation, minus `t0`; see `extra.frameSource`. For async commands this can precede the eventual state update or completion. Document-open and window-show samples wait for their explicit boundary; dialog-open uses the destination frame. It is a paint opportunity, not a compositor or display presentation timestamp. |
| `doneMs` | Completion signal timestamp minus `t0`. It may precede or follow the first frame. |
| `doneSignal` | Observed completion boundary, described below. |
| `extra` | Clock calibration error bound, process start for grouping runs, frame source and optional completion window/ambiguity/incomplete markers. |
| `extra.chord` | Shortcut-engine normalized chord (for example `Meta+z` or `Ctrl+z`), only for keydowns resolved by the live shortcut registry. Modifier-only keydowns are excluded entirely. |
| `extra.surface` | Surface identifier on shown rows: `preferences`, `plugin-manager`, a flyout ID, or `artColor`. |
| `extra.originWindow`, `extra.frameWindow` | Webview starting a surface row and webview observing its frame. In particular, Preferences uses a requesting-main frame; Plugin Manager is a committed dialog in the main webview. |
| `extra.flyoutId` | Flyout identifier on the originating palette input. The corresponding popover surface row uses `extra.surface`. |

Only `isTrusted` pointerdown/click/keydown events start input samples. Synthetic agent pointer events
are excluded. A real click can produce both pointerdown and click rows: compare each kind separately,
not their sum. Canvas pointerdown remains pending across preview frames until the document commits.
The main window gives the probe the **same live shortcut registry instance** used by its keydown
handler. Resolution honors the active binding scheme, platform alternates (including Windows Ctrl+Y),
disabled commands, and text-field filtering. This also identifies clipboard shortcuts which are
left to native clipboard events rather than dispatched through `invoke`. Dispatch instrumentation
can refine the command ID; internal forced-document-history wrappers are stripped from Undo/Redo.
Unclaimed keydowns may still produce a frame sample, without a chord or command ID. A resolved
clipboard shortcut with no registry invocation completes at `frame`, not at a claimed file write.
The `chemdraft:native-command` delivery is measured from entry into the receiving page. That existing
delivery path also carries forwarded palette commands; its rows are not proof of a menu-only source.

Instrumentation wraps the stable shared `CommandRegistry` instance, observes the existing main
dispatch and document-history install funnels, and watches committed DOM changes. It preserves
command arguments, return values, rejections and invocation count. Completion boundaries are:

- `document-commit`: history installation after an edit; document open waits for the open operation's
  final state update, then requests its frame. `document-open` also gets its own row, starting at the
  open command if present, otherwise at entry to the contents-open funnel (for example a shell open).
  File-picker/user-choice time is included when the command is the origin.
  Opens queued for hydration or a pending prompt, and requests for an already open file, finish
  with `command-finished` and `extra.openOutcome` of `queued` or `already-open`; they do not claim
  a new document installation. A queued request gets a fresh row when retried.
  All document-open rows and their initiating command rows use `extra.frameSource: "document-open"`,
  including when a subsequent DOM observer callback reschedules the frame. Successful installation
  discards any earlier frame and requests one after completion: `firstFrameMs >= doneMs`.
- `window-shown`: the native toolbar or report open operation has returned successfully. Toolbar/report
  frame observations are in the requesting main page; they do not measure the destination's content
  readiness. An explicitly declared plugin panel opener waits for the panel window's open result.
  Preferences produces an additional `kind: "window-shown"`, `window: "preferences"` row after
  the native toggle returns and visibility is confirmed. It measures native visibility, not content
  readiness; its frame is in main. Toggling it closed completes the initiating input with
  `command-finished` and emits no additional surface row.
- `dialog-open`: the native ready handshake returned after showing the dialog. The destination then
  sends its first rAF timestamp to the originating sample. Reopening a retained dialog uses the
  completed native open call and a new destination rAF.
  Plugin Manager produces a `kind: "dialog-open"`, `window: "dialog"` row when its existing
  in-viewport dialog commits; `extra.surface` is `plugin-manager` and its frame is in main.
  Timing starts in the open handler with the actual triggering command, rather than assuming
  `plugins.manage` in the component. Opens without a command omit `commandId`. The committed
  notification runs once per open; StrictMode effect re-runs and retained remounts cannot create
  another row from the same completed open. Invoking the manager while already open creates no
  additional surface row.
- `popover-shown`: a palette popover's reveal call returned after content commit and sizing.
  Its additional `kind: "window-shown"`, `window: "palette-popover"` row starts when the destination
  receives content and takes its first frame after reveal. Prewarmed placeholders produce no row.
  Rust relays this logged boundary only from the authenticated `toolset-popover-*` window to its
  derived owning `toolset-*` palette. It requires no new capability or generic event emission.
  Matching pending flyout inputs then use the popover's completion and destination frame, rather
  than a palette frame. Because the existing content protocol has no request token, these matches
  carry `extra.approximateCompletion`; the destination row itself directly observes the reveal.
- Flyout buttons keep their pointerdown pending until release or a nonempty content request.
  Ordinary releases and clicks produce normal frame-measured rows with the primary `commandId`;
  pointerup capture attributes the primary action even when React stops propagation. Only an
  observed content request switches the press to `popover-shown`. The release click after that
  long-press is suppressed by the probe, matching the toolbar action. There is no speculative
  1500 ms popover expectation or no-op timer on an ordinary button press.
- `no-op`: empty or superseded popover content finishes its destination row as `no-op`. These
  rows can omit `firstFrameMs`; they do not wait for a frame in a hidden webview and do not claim
  a visible result. The same owner-only relay forwards a destination `no-op` or `failed` result,
  so an already requested but dismissed/superseded popover also settles its palette input
  without a timeout.
- `export-written`: the document owner's export callback returned an `exported` result after the
  final file write. A request-ID receipt carries this timestamp back to the originating dialog;
  progress/accepted/preview results cannot finish an export sample. Dialog Apply uses the same receipt
  route for `document-commit`. The first frame may show the dialog's busy state before the write.
- `command-finished`: the registry promise settled, or a command handled directly by the main
  dispatcher returned, without a stronger registered completion. Window-close toggles use this signal.
- `frame`: input with no command or stronger state signal, observed at the next frame.
- `gesture-ended`: a canvas pointer gesture ended or was cancelled without a document commit;
  pointerup/cancel settle its existing pointerdown row. Palette pointerup is also captured to
  attribute primary flyout-button commands, without starting another input row.
- `canvas-ready`: first rAF after the main canvas is mounted and session hydration finishes.
- `failed` / `timeout`: a rejected command/open or an incomplete operation. Pending operations expire
  after 120 seconds; expired rows carry `extra.incomplete` and may omit `firstFrameMs`.

Cold launch starts at the beginning of Rust `run()`, before constructing Tauri, and ends at
`canvas-ready`. It includes Tauri, clock calibration, React startup and session hydration. It excludes
OS loader work before entry to `run()` and does not wait for optional palettes/engines. A startup file
open is measured separately. Name that boundary when reporting results; this is not a measurement
from clicking the application's icon.

## One monotonic clock across webviews

The literal `CURRENT_BUILD_STAMP` stays in `MainWindow.tsx`, where CI reads it. When the gated
main-window probe starts, its first clock call registers the combined stamp with Rust. Only the
native-authenticated main window may register it; a different stamp cannot replace it during that
process. Clock replies share that stamp with secondary webviews without importing `MainWindow`.
Rust overwrites `buildStamp` on every appended row, including dialog rows, with the registered
value, and refuses writes before registration. Disabled runs cannot register a stamp or write a log.
Web preview passes the same main-window literal directly to its browser-buffer writer.

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
Only main and shared dialog windows have the general completion-forwarding capability. Popover
shown rows have the narrower authenticated owner-only relay described above. Receipts tolerate
up to **10 ms** of negative skew between completion and destination frame, or between input and
remote completion, to accommodate independent midpoint calibrations. Larger reversals are refused.
Durations before the input are clamped to zero and adjusted rows carry `extra.clockSkewAdjusted`.
This bound is a tolerance, not a claim that every calibration has at most 10 ms of error.

`extra.frameSource` identifies `dom-commit`, `input-task`, `document-open`,
`window-shown`, `no-op`, `gesture-end`, or `destination-window`. Concurrent commands with ambiguous commit attribution are labelled
`extra.ambiguousCompletion`; compare serial operations and exclude those rows. The probe does not
claim command-specific completion for arbitrary plugin background work after its command returns.
`input-task` means the frame was scheduled from the input's microtask and no DOM observation
rescheduled it before that rAF ran. For async commands it can show the initial or busy state,
before the awaited work changes the DOM; it does not mean that the command never mutated the DOM.
An expected signal inferred from the sole active registry invocation after an async yield carries
`extra.approximateCompletion`; that inference can belong to unrelated work and should be excluded
from comparisons requiring exact attribution.

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
`extra.incomplete`, `extra.ambiguousCompletion` and `extra.approximateCompletion` rows, and report calibration bounds beside small
differences. Treat illustrative numbers as examples, never benchmark claims.
For flyout input latency, explicitly report the approximate palette/flyout matching policy if those
rows are included; compare the direct popover surface rows separately, since their start excludes
the hold threshold, native window creation, and content delivery before receipt in the destination.

The packaged macOS/Windows hands-on pass should also verify the bridge-off run creates no log,
dialog/window focus is unchanged, and an export row appears only after its file is written.
