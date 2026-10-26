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

## Separation from app commands

No probe data belongs in any app Tauri command signature, argument, event payload or return value.
The probe uses only its own `perf_log_*` commands. App calls retain their original arguments and
return types from `origin/main`; there are no `perfOpen` / forwarded-origin app parameters or
diagnostic toggle booleans. All diagnostic calls are fire-and-forget from the action's perspective,
including clock/state queries: their promises may update probe state, but no app action awaits them.
The command-separation backstop recursively scans every Rust file under
`apps/desktop/src-tauri/src/`, except `perf_log.rs`, and compares every command's name, generics,
parameters, return type and async marker against the checked-in
`apps/desktop/src/perf/commandSignatures.json` snapshot. Whitespace is normalized. It needs no Git
history or remote ref, so it also runs on CI's depth-1 checkout. Every scanned signature and all app
invoke arguments/type parameters are checked for diagnostic identifiers, even after regeneration.

After an intentional app command contract change, regenerate with Node 24+ from the repository root:

```sh
node apps/desktop/src/perf/commandSignatures.ts
```

Review and include the snapshot diff with the contract change; tests never regenerate it.

The Rust clock core accepts plain request data, an authenticated window label, an injected
clock reading and observed destination existence. It emits effects through a sink; only the
command wrapper holds Tauri handles, delivers JavaScript events or schedules native expiry.
Unit tests call this core and the plain completion/receipt helpers, never command wrappers or
`PerfClockContext`. Windows lib test executables have no common-controls v6 manifest; bringing
Wry window types into these tests pulls in `TaskDialogIndirect` and prevents the executable
from starting before any test can run.

Only main has `allow-perf-log-window-state`; main and shared dialogs have completion forwarding.

The native `on_window_ready` hook exists only under the existing bridge launch gate. Its
`window_created` callback returns unit, uses a nonblocking lock and cannot propagate a `Result`
into window creation; contention/poisoning disables diagnostics. Startup timestamps are observations
at that hook, not an extra step required to create any window.

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
Clock/stamp registration runs in the background alongside React mount and never delays it.
Session hydration retains its own performance timestamp even if calibration has not finished yet.
After calibration, that timestamp is aligned to the native clock for cold-launch `doneMs`; the
first post-paint task after both conditions supplies `firstFrameMs`, without requiring a click.
Late calibration can increase `firstFrameMs` but cannot inflate the recorded hydration duration.

Probe listeners, deferred callbacks, frame/timer callbacks and app-facing hooks contain diagnostic
errors. The first failure logs one warning and disables the probe, clears pending samples and
attempts every listener/timer/frame cleanup even if one cleanup fails. Later hooks are inert;
normal pointer handlers and registry command results/rejections continue unchanged. All app-facing
hooks catch synchronous throws and rejected promises, including with the switch off. No action or
React mount awaits probe work. Native append
or completion failures also disable the probe. Restart the app after correcting a logging failure
to collect a new run. Native failures disable the shared Rust writer for the process as well.

Each UTF-8 JSON line is capped at 16 KiB. Before an append would exceed 20 MiB, Rust replaces
`perf-log.1.jsonl` with the current file and starts a new `perf-log.jsonl`. A process-wide mutex
serializes rotation and appends from all webviews. Rotation first tries rename with replacement;
if that fails (for example a Windows sharing restriction), it copies to the backup and truncates the
current file only after the copy succeeds. The first rotation error per process is reported to stderr,
and later appends can retry a failed rotation. There is at most one backup. The frontend bounds pending samples and
queued writes to 256 each. Invalid lines are refused before creating a directory or opening a file.

## Fields and timing boundaries

Every line follows `PerfRecordSchema` in `apps/desktop/src/perf/probe.ts`; Rust also validates the
v3 envelope before writing. Both validators reject other versions and unknown top-level fields.
No unbound key text, pointer coordinates, file names or document contents are logged.

| Field | Meaning |
| --- | --- |
| `v` | Schema version, currently `3`. Version 1 used rAF-entry timestamps; version 2 lacked forwarded toolbar origins and distinct startup rows. Do not pool versions. |
| `kind` | `pointerdown`, `click`, `keydown`, `native-command`, `cold-launch`, `document-open`, `window-shown`, `dialog-open`, or `startup`. Surface and startup rows are not additional inputs. |
| `commandId` | Shared registry command ID when available. Absent for input with no command. |
| `window` | Input origin, or destination role for surface rows: `main`, `toolset`, `settings` (Drawn Structure Settings), `inspector` (Art, Text, Ring, Molecular and other object property windows), `palette-popover`, `dialog`, `plugin-panel`, `preferences`, or `spin3d-debugger`. |
| `platform` | `macos`, `windows`, or `linux`; tests pass the platform explicitly. |
| `buildStamp` | `CURRENT_BUILD_STAMP` from `MainWindow.tsx` plus the build stamp, which already contains the worktree label. The label appears once. |
| `t0` | Input timestamp, aligned to the process's monotonic epoch, in milliseconds. For `startup` rows, Rust stamps native window creation in its `on_window_ready` callback; this includes webview load and calibration. Web preview uses the webview time origin. Main `cold-launch` uses Rust process start. |
| `firstFrameMs` | Timestamp of a task posted from the first eligible rAF, minus `t0`; see `extra.frameSource`. A `MessageChannel` task (or bound `window.setTimeout(..., 0)` fallback) runs after that rendering turn, including work performed later in the same frame. For async commands this can precede the eventual state update. Native opens use the destination frame. This is an after-paint observation, not a compositor/display presentation timestamp. |
| `rafStartMs` | rAF callback entry minus `t0`, retained separately so rendering work before the post-frame task remains visible. Remote rows carry the destination's rAF entry. |
| `windowShownMs` | Native show/open return minus `t0`, when observed. It is separate from content readiness and is never substituted for a missing destination paint. |
| `doneMs` | Completion signal timestamp minus `t0`. It may precede or follow the first frame. |
| `doneSignal` | Observed completion boundary, described below. |
| `extra` | Clock calibration error bound, process start for grouping runs, frame source and optional completion window/ambiguity/incomplete markers. |
| `extra.chord` | Shortcut-engine normalized chord (for example `Meta+z` or `Ctrl+z`), only for keydowns resolved by the live shortcut registry. Modifier-only keydowns are excluded entirely. |
| `extra.surface` | Surface identifier on shown rows: `preferences`, `plugin-manager`, a flyout ID, or `artColor`. |
| `extra.originWindow`, `extra.frameWindow` | Webview starting a local surface row and webview observing its frame. Plugin Manager is a committed dialog in the main webview. |
| `extra.inputId` | Native-open correlation ID shared by the initiating input row and the destination open row. Startup surfaces without an input use a local `startup-*` ID, `kind: "startup"` and `doneSignal: "startup-painted"`; they do not complete an input. |
| `extra.paintMethod` | `first-contentful-paint` uses the cold destination's buffered Paint Timing FCP entry for `doneMs`; `post-paint-content` uses its first content render's post-frame task when Paint Timing is unsupported, or a fresh content frame for a retained window. |
| `extra.missingDestinationPaint` | The destination never reported content paint before expiry (for example, it closed early or failed). With `extra.incomplete`, this prevents a native visibility measurement from masquerading as content readiness. |
| `extra.flyoutId` | Flyout identifier on the originating palette input. The corresponding popover surface row uses `extra.surface`. |

Only `isTrusted` pointerdown/click/keydown events start input samples. Synthetic agent pointer events
are excluded. A toolbar logs its input ID, command and `t0` through `perf_log_clock(forwardInput)`
in pointerup capture (or click capture for click-only activation), separately from the unchanged
`route_toolset_command(commandId)` call. Rust sends main a dedicated `chemdraft:perf-forward`
diagnostic event, authenticated with the toolbar window label. No origin enters `native-command`.

Main associates each forwarded input with the **next delivered native-command for that command**
whose delivery lies from 10 ms before its aligned `t0` (clock tolerance) to 250 ms after it. A
native diagnostic row is held until 250 ms after delivery to accept out-of-order diagnostic events;
the app action, its completion timestamp and observed frames are never held. One candidate sets
`extra.originInputId`, `extra.originWindow`, `extra.forwarded` and the input's `t0`;
`extra.nativeDeliveredAt` retains delivery time. The main/destination `extra.inputId` still links
the native open and its paint, while `originInputId` joins them to toolbar input rows.
Late events beyond this collection window and stale inputs are not joined.

Rarely, two toolbars can forward the same command before either delivery. Both forwards then
match the same next delivery: main sets `extra.forwardAmbiguous` and `candidateInputIds`, keeps
delivery as `t0`, and assigns neither origin. It never guesses between those candidates, nor
reuses them for the next delivery. Subsequent deliveries inside that ambiguous set's 250 ms
window also carry `forwardAmbiguous` if they match no distinct forward; their native delivery
latency must not masquerade as an unambiguous input latency. A menu command arriving inside a lone forward's window is
inherently indistinguishable; measure serial interactions and exclude ambiguous rows.
Toolbar-local rows retain `doneSignal: "forwarded"`, `extra.nonCompleting: true`, and no claimed
completion/frame latency. Count one interaction by its IDs; do not sum its rows.
Additional surface/startup rows are not inputs. Canvas pointerdown remains pending across preview frames until the document commits.
The main window gives the probe the **same live shortcut registry instance** used by its keydown
handler. Resolution honors the active binding scheme, platform alternates (including Windows Ctrl+Y),
disabled commands, and text-field filtering. This also identifies clipboard shortcuts which are
left to native clipboard events rather than dispatched through `invoke`. Dispatch instrumentation
can refine the command ID; internal forced-document-history wrappers are stripped from Undo/Redo.
Unclaimed keydowns may still produce a frame sample, without a chord or command ID. A resolved
clipboard shortcut with no registry invocation completes at `frame`, not at a claimed file write.
The app `chemdraft:native-command` payload contains only its original command ID. Without an
unambiguous separate forward observation, timing begins at delivery to main.

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
- `window-painted`: an input opening a native toolset, Drawn Structure Settings, Preferences,
  3D Debugger or report window waits for the **destination's** content paint. Cold webviews with
  Paint Timing support report their actual first-contentful-paint entry as `doneMs`, then a
  destination post-frame observation as `firstFrameMs`. A retained window reports a fresh content
  frame after reveal; platforms without Paint Timing use that same post-paint method, explicitly
  labelled by `extra.paintMethod`. The destination emits its own `window-shown` row (or `dialog-open`
  for Settings), with its real role, originating input ID and timestamp. Native show return remains
  `windowShownMs`. Closing a toggle finishes with `command-finished`, without an open row. Preferences and
  3D Debugger register an open intent through the probe's own fire-and-forget `perf_log_clock`
  call before invoking their unchanged toggle IPC. IPC FIFO ordering makes the intent available
  to a fast-calibrating cold window, which waits for its show receipt instead of logging startup.
  After the toggle resolves, the probe independently asks `perf_log_window_state(label)` for
  `visible`, `hidden`, `minimized` or `absent`. Only visible publishes the show receipt through
  `perf_log_clock`; other states finish the input as `command-finished`. Thus a minimized/covered
  window revealed by Rust is measured as an open, while a closing toggle publishes no show receipt. The query observes state after resolution and is not an atomic toggle result:
  another rapid toggle can race it. A rejected toggle IPC completes as `failed` on the
  requesting window's frame, without waiting for a destination-paint timeout.
  If the destination never reports, the input expires as `timeout` with `extra.incomplete` and
  `extra.missingDestinationPaint`; it has no claimed destination frame. There is no fallback to
  native visibility or a requesting-main frame.
- `window-shown`: local/browser surface visibility. Native input openers use `window-painted` above;
  `kind: "window-shown"` still identifies additional destination surface rows, independently of signal.
- `dialog-open`: the native ready handshake returned after showing the dialog. The destination then
  sends its post-paint timestamp and rAF entry to the originating sample. Completion waits for
  that destination paint; native visibility is kept in `windowShownMs`. Reopening a retained dialog
  uses the completed native open call and a new destination frame.
  Plugin Manager produces a `kind: "dialog-open"`, `window: "dialog"` row when its existing
  in-viewport dialog commits; `extra.surface` is `plugin-manager` and its frame is in main.
  Timing starts in the open handler with the actual triggering command, rather than assuming
  `plugins.manage` in the component. The committed notification runs once per open; StrictMode
  effect re-runs and retained remounts cannot create another row from the same completed open.
  Invoking the manager while already open creates no additional surface row.
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
- `canvas-ready`: the main canvas is mounted and session hydration finishes. `doneMs` uses that
  readiness timestamp; `firstFrameMs` uses the subsequent observed post-paint task.
- `failed` / `timeout`: a rejected command/open or an incomplete operation. Pending operations expire
  after 120 seconds; expired rows carry `extra.incomplete` and may omit `firstFrameMs`.

Cold launch starts at the beginning of Rust `run()`, before constructing Tauri, and ends at
`canvas-ready`. Its `doneMs` includes Tauri, React startup and session hydration. `firstFrameMs` also
includes any calibration that trails hydration and the subsequent paint observation. It excludes
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
Each enabled webview takes three clock IPC samples alongside React mount, chooses the smallest
round-trip time, and aligns `performance.now()` to the midpoint of that sample. `extra.clockErrorMs`
is half that round trip. This bounds IPC synchronization uncertainty; it is not a clock-drift estimate.
No ongoing calibration timer runs. Very long sessions can accumulate oscillator drift; restart for
each speed run.

Modern input `event.timeStamp` values are relative to `performance.timeOrigin`; legacy epoch values
are converted back to that origin before applying the same offset. All event, rAF and completion
timestamps consequently share the Rust epoch even when they originate in different webviews.
Main registers a bounded destination identity, originating input ID, `t0` and command through
`perf_log_clock` before ordinary opens and toggles; the separate toggle-state query controls
the subsequent show receipt. Rust maps that
identity to a native label; the destination receives this diagnostic context during calibration or
through a perf-only show notification. A newly created window reports its buffered FCP (or the
documented post-paint fallback) through `perf_log_append`, with its authenticated window label.
Rust checks numeric paint/frame bounds and the registered destination/time range, then relays only
the destination identity, actual label and timestamps. It does not send an ID through an app command.
The relay includes the registered show timestamp so cold-open origin rows retain `windowShownMs`
even when the destination paint arrives before the origin processes its own show notification.
Main matches this report to its pending native-open input by destination label mapping and time
(`t0 <= paint + 10 ms`, at most 120 seconds old). Exactly one candidate completes; overlapping
candidates get `extra.destinationAmbiguous` and remain incomplete instead of guessing.
The logged destination row also retains `extra.inputId` for offline joining.
Secondary windows need no general event emission. Missing reports expire after **120 seconds from the originating input**, producing an incomplete
`timeout`/`missingDestinationPaint` input row. Rust removes the matching open entry when its expiry
timer fires (an old timer cannot remove a newer request for that window). Rows still pending when
the app quits are lost; quit does not synchronously flush or complete them.

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
rescheduled it before that frame's post-paint task ran. For async commands it can show the initial or busy state,
before the awaited work changes the DOM; it does not mean that the command never mutated the DOM.
An expected signal inferred from the sole active registry invocation after an async yield carries
`extra.approximateCompletion`; that inference can belong to unrelated work and should be excluded
from comparisons requiring exact attribution.

## Comparing macOS and Windows

Use the same commit, source stamp, document, page/zoom, plugin set, saved-session state, display
refresh rate and operation sequence. Run a cold launch separately from repeated warm actions.
Record the worktree/build labels. Exercise real pointer/keyboard/native-menu input; synthetic agent
events are deliberately unsuitable for these latency comparisons. Make one action at a time and
wait for it to finish. Repeat at least five times and compare **`firstFrameMs`** medians for matching
`kind`, `commandId`, `doneSignal`, `window` and `extra.frameSource` values.

For example, these illustrative rows represent matching warm document-open runs:

```jsonl
{"v":3,"kind":"document-open","commandId":"document.open","window":"main","platform":"macos","buildStamp":"example","t0":1000000,"rafStartMs":170,"firstFrameMs":180,"doneMs":160,"doneSignal":"document-commit"}
{"v":3,"kind":"document-open","commandId":"document.open","window":"main","platform":"windows","buildStamp":"example","t0":2000000,"rafStartMs":210,"firstFrameMs":220,"doneMs":195,"doneSignal":"document-commit"}
```

Use `firstFrameMs` for cross-platform latency comparisons. Paint Timing FCP semantics may differ
by approximately one display frame: WebView2 may stamp presentation while WebKit stamps paint.
That engine offset is plausible, not experimentally verified here; `doneMs` based on FCP should
not be treated as a platform-neutral presentation time.

The Windows first-frame observation is 40 ms longer (220 − 180); commit completion is 35 ms longer.
The differing absolute `t0` values do not enter that comparison. Filter out `failed`, `timeout`,
`extra.incomplete`, `extra.forwardAmbiguous`, `extra.destinationAmbiguous`,
`extra.ambiguousCompletion` and `extra.approximateCompletion` rows, and report calibration bounds beside small
differences. Treat illustrative numbers as examples, never benchmark claims.
For flyout input latency, explicitly report the approximate palette/flyout matching policy if those
rows are included; compare the direct popover surface rows separately, since their start excludes
the hold threshold, native window creation, and content delivery before receipt in the destination.

The packaged macOS/Windows hands-on pass should also verify the bridge-off run creates no log,
dialog/window focus is unchanged, and an export row appears only after its file is written.

The fail-open action suites inject a synchronous throw and a held-then-rejected promise at these
real hook paths, assert the action's observable effect before settling the promise or advancing
fake time, and assert the probe disables (no subsequent fault calls or rows):

- `MainWindow.failOpen.dom.test.tsx`: Preferences/3D Debugger open, close and failed IPC; the
  independent post-toggle state query; browser Preferences; native and inline Drawn Structure
  Settings; analysis-window expect/open/show/complete and snapshot publication; plugin panel
  expect/open/show and registryExpected through a registered plugin's real showReport command;
  Plugin Manager initial/repeated opens; menu and separately forwarded command dispatch;
  startup shortcut/registry/canvas/DOM hooks on native and browser paths; shortcut-registry cleanup
  on unmount; native/inline Rings close, including ring selection clearing and the status update
  **after** the completion hook; empty/replaced/dismissed/failed popovers and ordinary toolbar/
  popover clicks; SVG/PDF writes and post-write success publication; File Open start, commit,
  skipped and failed paths.
- `dialogs.failOpen.dom.test.tsx`: all eight coordinator/host hooks: new/reused dialog expectations,
  reveal receipt, dialog ready, Apply/Export expectations and their host completion receipts.
- `startup.dom.test.tsx`: the entrypoint gate hook and both main/secondary probe starters, including
  permanently pending starters; React mounts independently.
- `firstPaint.failOpen.dom.test.tsx`: real Preferences/3D Debugger React content under rendered,
  timestamp and destinationPaint faults, with PerformanceObserver unavailable.
  Paint Timing entries themselves are simulated in `runtime.test.ts`, which also tests cold
  Preferences/3D Debugger calibration before their show receipt.
- Rust: plain `clock_request(disable: true)` invocation clears open correlations and refuses
  subsequent clock requests; core tests cover cold/warm opens, effect ordering, authenticated
  forwarding, sink failures and completion timestamp validation. File tests cover bounded writes,
  rotation fallback and invalid input; creation-hook tests cover enabled/disabled startup stamping.

This matrix tests those hooks, not every internal method or native OS operation. Window effects
and files are mocked at transport boundaries; real focus/z-order and compositor timing still need
the packaged macOS/Windows hands-on pass above.
The independent AST backstop scans every non-test source file under `apps/desktop/src`, recognises
optional/non-null calls and aliases/destructuring, and reports unisolated or awaited diagnostics with
file and line. Paths are separator-agnostic, tested with explicit macOS/Windows path selection.
Deferred callbacks, object/class methods, accessors, constructors and class field initializers
need their own `perfHook`; an outer wrapper cannot catch their later throws.
