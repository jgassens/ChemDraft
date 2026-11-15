# Windows toolbar activation investigation

## HEX multi-click, popover placement and Snap follow-up — 2026-11-15

Build stamp: `11.15.15.40-codex`. Runtime acceptance on Windows remains unverified.

- The no-activate response used to call the command-press cancellation callback
  even when neither a command nor a command flyout was hit. A second/third HEX
  press could therefore revoke its existing lease before the renderer's pointer
  handler reused it. Non-activating field presses now preserve that lease;
  actual commands still revoke it synchronously. The 500 ms command guard only
  bounds delayed acquisitions; it does not expire a held editing lease.
- E/Z content carries both the below-badge anchor and its top edge minus the gap.
  After content sizing, native placement chooses the destination display using
  that top edge, converts with its DPI, flips above when necessary, and clamps
  to its work area. The document's scale resolves overlapping logical monitor
  frames, rather than the hidden popover's old scale. This placement is shared
  with macOS and reapplied after its bottom-anchored resize.
- Windows command palettes are created non-resizable and non-maximizable through
  Tauri's supported creation traits, removing their Snap eligibility while keeping
  Tao's state consistent. Content-fit sizing, native dragging and position saving
  retain their existing paths. Other Windows utility windows also disable
  maximizing; macOS palette creation traits are retained.

Real-event checks still required: double/triple-click HEX, replace the selected
text and continue typing; open E/Z at every work-area edge on 100/150/200% displays;
drag Main by its title/grip to side/top edges and across displays, then reopen it
and check its saved position and content size. Repeat palette field, sizing and
drag checks on macOS Apple silicon and Intel. DOM selection defaults and native
Snap behavior cannot be established by the automated policy tests.

Verification on macOS Apple silicon: 339 Vitest tests across the input-focus,
E/Z popover, input-focus capabilities, palette sizing and drag suites passed.
The isolated checkout needed a temporary dependency-alias config, removed after
the run; no install was performed. Rust filters `panel_window::` (49 tests),
`popover_placement` (2), `toolset_window_config` (1), `window_drag::` (4), and
`global_logical` (1) passed, as did Rust formatting and `git diff --check`.
The existing local Sparkle framework was copied into the ignored build-support
location. No app was launched; Windows compilation, Windows runtime, macOS
hands-on behavior and macOS Intel compilation remain unverified. Recommended
next task: run the real-event checks above on Windows 11/WebView2.

## Inactive-frame pin and default no-activate policy — 2026-11-15

This section supersedes the activation policy described in the historical handoffs below.
Build stamp: `11.15.10.15-codex`. Windows compilation and visual behavior still need
the Windows checks below; this implementation does not establish the DWM hypothesis.

- Core, plugin and user command palettes, and their popovers, answer
  `MA_NOACTIVATE` / `PA_NOACTIVATE` over buttons, background, labels, title and grip.
  Only renderer-registered enabled `input[type=color]` and `select` rectangles
  delegate to default activation. Text fields use the existing input lease.
  Neither result eats the press; title/grip dragging retains its handlers.
  Document windows, tooltips and report-panel activation are unchanged.
- Mouse hit testing uses `GetCursorPos` in physical client pixels. Touch/pen uses
  `GetPointerInfo` for the pointer ID because it need not move the mouse cursor.
  Failure to obtain a position leaves command surfaces nonactivating.
- Command/chooser snapshots replace each other atomically. Selection and command
  broadcasts no longer tear down registration or publish an empty list between
  frames. DOM, resize and scroll observers republish; renderer cleanup clears only
  on unmount or customization. Native hide/destruction still discards rectangles,
  and reveal requests a fresh snapshot.
- A command press blocks delayed pointer input acquisitions for at most 500 ms.
  Mouse/pointer activation reclassifies the new press; native keydown clears the
  old guard. Keyboard/accessibility leases without a pointer timestamp also clear
  it, covering WebView2 child keys that never reach the host HWND. Command flyouts
  still refuse text leases for their entire content session.
- `WM_NCACTIVATE` first passes the **real wParam** through `DefSubclassProc`
  with `lParam=-1`. For active command surfaces, a second, direct
  `DefWindowProcW(hwnd, WM_NCACTIVATE, 0, -1)` pins only the frame inactive.
  The first result is returned. Tao's activation bookkeeping is preserved;
  legitimate field activation can still dim the document title bar.

### Opt-in diagnostics and A/B switch

Ordinary launches install no activation logger. Enable the existing bridge
diagnostics with `CHEMDRAFT_AGENT_BRIDGE=1` (or `--chemdraft-agent-bridge`)
and capture stderr. Every `[windows-activation ...]` line includes a UTC ISO
timestamp with milliseconds. No field contents are logged.

Mouse and pointer activation lines include window label, command box count,
chooser rectangle count, both `GetMessagePos` and `GetCursorPos` screen positions,
the tested client point, command/chooser hit results, and the returned value.
Each `WM_NCACTIVATE` logs wParam and whether the inactive pin was applied.
Each renderer `set_palette_command_hit_boxes` call logs label and both counts.
`activation ... active=true` records real activation, even when the frame is pinned.

The frame pin defaults **on**. Set `CHEMDRAFT_PALETTE_PIN_INACTIVE=0` before
launch to disable just the pin; remove it or set it to `1` to enable it. Restart
between runs: existing windows retain the value read when they were created.
The no-activate/chooser policy and logging stay identical in both runs.

PowerShell, launching the same built development executable for each run:

```powershell
$env:CHEMDRAFT_AGENT_BRIDGE = "1"
$env:CHEMDRAFT_PALETTE_PIN_INACTIVE = "0"
& .\target\debug\chemdraft.exe 2> activation-pin-off.log
# Quit that dev instance before run 2.
$env:CHEMDRAFT_PALETTE_PIN_INACTIVE = "1"
& .\target\debug\chemdraft.exe 2> activation-pin-on.log
```

Run from `apps/desktop/src-tauri`, or substitute the exact development binary
from the Windows build. For a Tauri dev build, keep its Vite server available.
Record the worktree label and build stamp; use the existing synchronized
capture of foreground/active HWNDs and video, with the same clock as the log.

### Two-run Windows protocol

**Run 1, pin off:** At fresh launch, make ten Charge presses: five after a
one-second dwell and five move-and-press from the canvas. Select a caption,
type a HEX value, and repeat. Add five presses within 150 ms of the previous
command and one title drag. Correlate every dark frame with the activation log:

| Log near a dark frame | Interpretation |
| --- | --- |
| `return=1 command_hit=false`, zero boxes or differing positions, then `active=true` | Review's original guard-input failure signature. With the inverted policy a non-chooser command surface must now return 3 even with zero boxes; investigate any other result. |
| `return=3`, then `active=true` | Activation bypassed the mouse/pointer decision; frame pin is needed. |
| No mouse/pointer activation line, then `active=true` | That activation did not reach the host press handler. |
| No `active=true` | The activation-driven shadow hypothesis is not supported for this frame. |

**Run 2, pin on:** Repeat the exact steps and additionally click the HEX field.
Zero dark frames while `active=true` and `WM_NCACTIVATE ... pinned=true` are
logged supports the inactive-frame fix. Continued dark frames mean DWM may
follow true foreground; this pin is then insufficient. Report that outcome
rather than claiming the blink fixed.

In both runs also verify native colour/select opening and choice, HEX typing,
command then immediate touch/pen field entry and Tab entry, a field acquisition
after 500 ms without another mouse activation, title/grip drag, 350 ms holds,
short presses and exactly-once dispatch. Include custom/plugin palettes,
disabled buttons, E/Z keyboard navigation, mixed-DPI monitors and app switching.
Verify report panels still activate normally. macOS Apple silicon and Intel
need the existing palette field/chooser/drag checks to confirm unchanged behavior.

Recommended next task: run this two-run protocol on Windows 11/WebView2 using
the same reviewed build, after Windows compile/clippy/tests.

### Verification of this change

- macOS Apple silicon: `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check`,
  `cargo clippy --all-targets --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings`,
  and `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml panel_window::`
  passed (48 Rust tests). The existing local Sparkle framework was copied into
  this worktree's ignored build-support directory; no download/install was run.
- Vitest: 817 tests across 27 suites passed, covering palette/popover DOM,
  input leases, chooser/command publishing and IPC, capabilities, command
  signatures, drawing tools and the agent bridge. This isolated checkout lacks
  package dependency links, so runs used a temporary Vite alias configuration
  pointing to the already-installed local dependencies and this worktree's
  package sources. No `pnpm install` was run.
- `git diff --check` passed. The command IPC signature remains unchanged:
  native choosers are tagged `nativeChooser: true` in the existing boxes payload,
  so one publication atomically replaces both sets of rectangles.
- Windows compile/clippy/tests and real-event activation/DWM behavior are
  unverified. The windows-sys 0.61 declarations and feature gates were inspected,
  including `GetCursorPos`, `GetPointerInfo`, and `WM_POINTERACTIVATE`.
  Neither macOS architecture received an app launch or hands-on pass; macOS
  Intel compilation was not run. Unit tests do not establish the visual result.

## Renderer follow-up handoff — 2026-11-15

Implementation is ready for integration review; verification remains partial. The
historical native-only investigation below is retained as evidence, and its
"remaining renderer work" is superseded by this section. Build stamp:
`11.15.08.11-codex`. No commit, install, or app launch was performed.

### Changes and ordering

- `ToolPalette` and `PalettePopoverWindow` capture pointerdown and mousedown to
  cancel Windows command-button focus defaults. Capture still reaches buttons
  whose own handlers stop propagation. Pointerup, click, pointer capture, and the
  200 ms hold timer are unchanged. `platform` defaults to the existing detector
  and is supplied by `PaletteWindow`; macOS keeps its pointer defaults.
- Inputs, selects, contenteditable controls, sliders, and colour-picker bodies
  retain their pointer defaults. The same command predicate supplies native hit
  rectangles, now including non-drawing commands, disabled command buttons, and
  custom/plugin palettes. Editable bounds and customization slots stay excluded.
  The native label guard and Windows capability grant admit these palette labels
  only, not plugin report windows.
- Windows E/Z creation/reveal uses Preserve. The document's `useBondStereoPopover`
  routes Tab/Shift+Tab, arrows, Enter and Space through the existing flyout key
  channel, including the exact E/Z session identity. The renderer highlights and
  chooses enabled actions/Keep unspecified without native or DOM focus. Repeated
  activation and its keyup default are consumed even after closure. macOS keeps
  its window/webview focus and Tab loop. Rust no longer accepts the Windows
  E/Z Focus exception and retains `WS_EX_NOACTIVATE` on reuse.
- Dismissal previously invalidated the owner's request/replay immediately but
  queued native close behind `popoverOperationsRef`. The broadcast was prompt,
  but depended on the popover renderer servicing it; a slow open/content
  acknowledgement could delay the owner's native hide. Dismissal now starts the
  identity-checked native close immediately. An ordered close remains behind
  pending work, before subsequent opens, to sweep up a cancelled cold open.
  Existing request/generation checks, replay invalidation, and receiver dismissal
  timestamps prevent delayed content or positioning from reviving the old menu.
  This queue bottleneck was established by source tracing; the reported Windows
  shadow/persistence was not reproduced on this host.
- Added a regression for 350 ms Charge hold, short same-button press, immediate
  hide before a blocked content acknowledgement, exactly one primary invocation,
  no reopening after 650 ms or after the acknowledgement. Added a delayed-position
  reveal/replay regression and platform-specific focus/navigation coverage.

### Changed expectations and reasons

1. `paletteInputFocusCapabilities.test.ts`: replaced the old `active_command_hit`
   late return and `app_was_active` gate assertions with policy selection **before**
   `DefSubclassProc`, synchronous command observation, and default delegation only
   for non-command surfaces. The previous native commit intentionally changed
   this ordering to prevent activation side effects, even when ChemDraft was not
   foreground. The native colour-popup default and already-active input-lease
   assertions remain. Its core-only hitbox assertion now expects core/plugin/user
   labels and their matching capability grant because all these command surfaces
   use the same focus policy.
2. `commandHitBoxes.test.ts`: changed one marked drawing rectangle to four command
   rectangles, including unmarked/custom and disabled buttons. Disabled commands
   must still avoid activation; they remain unable to invoke. Customization is
   now explicitly identified by `.customizing`, rather than inferred from missing
   drawing-command metadata. Editable/colour-picker/slider exclusions remain.
3. `PalettePopoverWindow.bondStereo.dom.test.tsx`: creation and reveal expect
   Preserve for Windows keyboard opens, Focus only for macOS keyboard opens.
   The former two-platform focused Tab/Enter test is retained for macOS; new
   Windows tests assert document-owned key routing, visual highlighting, stale
   session rejection, exactly-once choice, and zero native/DOM focus transfer.
   Windows keyboard E/Z is also included in idle-activation handback coverage,
   because it no longer has the old focused-reveal exemption.
4. Rust `bond_stereo_mouse_popover_is_owned_and_nonactivating`: reuse now retains
   `WS_EX_NOACTIVATE`, instead of asserting that Focus removes it. Rust
   `palette_popovers_open_without_focus_and_lease_their_fields` now expects the
   Windows E/Z Focus request to resolve to Preserve, while macOS still expects
   Focus. Both changes follow document-owned Windows navigation.

### Verification and remaining gate

- macOS Apple silicon: native fmt and clippy with `-D warnings` passed. The local
  Sparkle framework was copied into the ignored worktree build-support path after
  the initial clippy attempt reported it missing; no download or install occurred.
- Full native tests: 839 passed, 27 failed, 9 ignored. All 27 failures are
  sandbox-denied loopback socket operations (`Operation not permitted`). The
  unrelated fake sidecar test passed in this run. The focused `panel_window::`
  native suite passed all 45 tests.
- Targeted Vitest tests pass (10 palette input-focus, 7 core capability-grant,
  and 2 command hit-region tests). Seven DOM suites cannot load this isolated
  worktree's missing React and Tauri API dependency links. This includes the
  newly added regressions; no DOM result is claimed. `pnpm install` was not run.
- Windows compile/clippy/tests and Windows runtime are unverified. Neither macOS
  runtime (Apple silicon or Intel) was launched, per the worker's scoped test-only
  instructions. Re-run the named DOM suites with dependency links present and
  the full native suite in an environment that permits loopback sockets.

Named frontend files attempted with `pnpm vitest run --configLoader runner --no-cache`:
`paletteInputFocusCapabilities.test.ts`, `coreCapabilityGrants.test.ts`,
`commandHitBoxes.test.ts`, `ToolPalette.dom.test.ts`,
`PalettePopoverWindow.bondStereo.dom.test.tsx`,
`PaletteWindow.popoverCleanup.dom.test.tsx`, `PaletteWindow.nativeFlyout.dom.test.tsx`,
`MainWindow.nativeFlyout.dom.test.tsx`, `ToolPalette.colorPicker.dom.test.tsx`, and
`window-manager/popover-dismiss.dom.test.ts` (all under `apps/desktop/src/`).

Windows hands-on checks still required, using real mouse/keyboard events:

1. Fresh launch, then repeat after HEX typing, system colour chooser use, caption
   editing, and shortcuts: Charge/bond/ring/menu choices never activate the
   command window or darken its shadow. Capture active/foreground HWND and the
   existing native activation logs alongside video.
2. A 350 ms Charge hold opens at the unchanged 200 ms threshold without selecting
   Charge. A short same-button press dismisses promptly and selects once. Repeat
   with delayed cold opens/content delivery, rapid alternate holds, and mouse-up
   outside the owner; no stale reveal or close may affect a newer menu.
3. E/Z keyboard open retains the document HWND and DOM focus; Tab/Shift+Tab,
   arrows, Enter/Space, held keys, Escape, disabled choices and Keep unspecified
   work once. Mouse E/Z opens likewise remain nonactivating.
4. Verify HEX/RGB inputs, caption fields, native colour/select choosers and slider
   editing still acquire their normal focus; customization drag/drop, disabled
   buttons, core/plugin/user palettes, mixed DPI, geometry, dragging, and app
   switching still behave correctly. Repeat macOS pointer/hold and E/Z keyboard
   checks on Apple silicon and Intel to confirm the retained behavior.

Recommended next task: run those Windows real-event checks and the blocked DOM
regressions before merging.

## Historical native-only handoff

Native-only handoff, 2026-11-15. Windows execution and the reported shadow blink
have not been reproduced on this macOS host. This is a partial fix: WebView2's
DOM focus defaults and explicit E/Z keyboard focus remain outside this change.

## Activation paths

| Path | Can run on a mouse press after keyboard/editing use? | Finding |
| --- | --- | --- |
| `panel_window.rs::focus_subclass`, `WM_MOUSEACTIVATE` | Yes | Previously called the default subclass chain before returning `MA_NOACTIVATE`, and only over registered enabled drawing-command rectangles while the foreground process was ChemDraft. Missing/stale rectangles, other buttons, right clicks, and every popover fell through. Now command hits return `MA_NOACTIVATE` before that chain, without a foreground-process condition. Command flyouts use the same result over their whole surface. The original mouse message is delivered; no event is eaten or replayed. |
| `palette_key_guard.rs::windows::observe` | Yes | Observes `WM_MOUSEACTIVATE`, then delegates; it does not itself activate. The new early-return path explicitly runs the same pending-key observation, once. |
| `panel_window.rs::focus_subclass`, `WM_NCACTIVATE` | On activation | Existing `lParam=-1` suppresses nonclient repaint, preserving real activation bookkeeping. It does not prevent activation or reliably freeze DWM's shadow. Unchanged. |
| `panel_window.rs::resize_subclass` / `overlay_subclass` | Only plugin/report panels | Resize subclass returns `MA_ACTIVATE`; overlay forwards to its parent. Installed by `install_resize_hit_test` for report panels, not by `install_toolset_input_focus` for palettes/popovers. Unchanged. |
| `set_plugin_panel_input_focus` -> `focus_if_app_active` -> `SetActiveWindow` -> WebView2 `MoveFocus` | Yes, queued IPC from an editable control | `WS_EX_NOACTIVATE` does not prohibit explicit activation. Command presses now cancel a pending lease synchronously and forbid acquisition until a subsequent non-command press. Colour-to-flyout reuse invalidates the lease and forbids edit-focus acquisition while command content is installed. Deliberate editing still uses its existing lease. |
| `return_focus_after_interaction` / `return_focus_to_document` | Yes, on release/blur/idle/drag completion | Only calls `SetForegroundWindow` on the **document**, guarded by exact source/document foreground ownership, then focuses the document webview. Does not restore focus to a toolbar. |
| `route_toolset_command` -> `focus_main_document_window_impl(Force)` | Yes, after command dispatch | Refocuses the document unless an input lease/preserve request retains the palette. Its `set_focus()` never targets the palette. |
| `set_plugin_panel_activation` | Only a plugin report's input request | Checks genuine report activation before focusing its webview. Toolsets use the separate palette lease path. |
| `lib.rs` document reveal, main focus, file-open, single-instance paths | On explicit document requests | Their `set_focus()` targets `main`. The non-macOS `focus_native_document_window` itself is a no-op. |
| `dialog_windows.rs::show_on_main`, reopen, `bring_to_front_on_main` | A toolbar command may open a dialog | `set_focus()` targets the registered dialog. The raise uses `SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOOWNERZORDER`, and never focuses the toolbar sibling used as its z-order anchor. |
| `ensure_spin3d_debugger_window` | Only a debugger request | Explicit `set_focus()` targets the debugger, not a toolbar. |
| `utility_window_builder`, popover/tooltip builders, all subsequent `show()` calls | Yes, when showing/reusing a utility | `focused(false)` is retained by Tao for its lifetime and selects `SW_SHOWNOACTIVATE`. No toolbar path using raw `ShowWindow(SW_SHOW)` was found. The raw maximized show is document-only. |
| `restore_utility_window`, `raise_among_owned_windows` | Yes, suspension restore/popover reveal | All explicit `SetWindowPos` calls include `SWP_NOACTIVATE`. Geometry flags and window shadow configuration are unchanged. |
| Position/size/focusability updates through Tao; drag compensation | Yes | Tao position and style updates include `SWP_NOACTIVATE`. A native drag enters `WM_NCLBUTTONDOWN`; Wry forwards `WM_ENTERSIZEMOVE` to `MoveFocus`, so dragging needs its own hands-on check. |
| `configure_toolset_popover_window`, `toolset_popover_extended_style` | On reuse/open | Ordinary flyouts preserve `WS_EX_NOACTIVATE`. E/Z keyboard opens still deliberately allow focus; see the renderer path below. |
| `PalettePopoverWindow.tsx` E/Z keyboard reveal | After an asynchronous keyboard open | Calls both `getCurrentWindow().setFocus()` and `getCurrentWebview().setFocus()`. Tao's window focus calls `SetForegroundWindow`, with a synthetic-Alt fallback. These calls bypass the native input-lease gate. |
| `window-manager/index.ts::focusMainDocumentWindow` | On document focus requests | Native call targets main, then calls current-window/current-webview `setFocus()`. Current callers must remain document-only; this helper is unsafe to reuse from a palette. |
| Browser default button focus / `pluginPanelInputFocus.ts` | Yes | The existing source explicitly documents that WebView2 can activate its parent despite `NOACTIVATE`/`WM_MOUSEACTIVATE`. It hands focus back on pointerdown/up/click and after a 32 ms idle activation check. This repairs focus after activation and can still expose a dark-shadow frame. A native `MA_NOACTIVATE` result alone cannot prove this path is gone. |

The only direct application `SetForegroundWindow` call found is the guarded
document hand-back. Tao's `set_focus` is the indirect force-activation path.
No macOS behavior, hold timer, command dispatch, dimensions, or shadow setting is
changed. No build stamp was bumped because no `apps/desktop/src` file was edited.

## Debugging the native result

Launch a Windows development build with `CHEMDRAFT_AGENT_BRIDGE=1` (or the existing
`--chemdraft-agent-bridge` argument), capturing stderr. The narrow logger enables
only the `chemdraft::windows_activation` target. Ordinary launches install no
logger and emit none of these diagnostics.

`WM_MOUSEACTIVATE label=toolset-core-main return=3 ...` means `MA_NOACTIVATE`.
For a flyout, `command_popover: true` must appear, even with no registered button
rectangles. `activation ... active=true` after such a return identifies a later
activation path. The log also records default-handler return values on editable
surfaces and rejected late input-focus requests. No logging includes field text.

## Remaining renderer work (outside native ownership)

1. In `ToolPalette.tsx` command buttons and `PalettePopoverWindow.tsx` flyout
   choices, suppress the Windows primary-pointer default that focuses the
   button/webview (`preventDefault` on pointerdown, with the platform supplied
   through the existing detection/test seam). Preserve real pointerup/click
   dispatch, pointer capture and the 200 ms hold timer. Do not suppress editable
   controls or native colour/select chooser defaults. Verify with real events:
   the gated bridge produces synthetic events and cannot prove default focus.
2. Remove Windows E/Z keyboard reveal's direct native window/webview `setFocus`
   calls; keep document keyboard ownership and route menu navigation to the
   command surface. Its existing native Focus-mode exception must be retired
   with that renderer change. Removing it here alone would break keyboard use.
3. `paletteInputFocusCapabilities.test.ts` currently asserts the old late-return,
   foreground-gated native implementation text. Update those assertions to the
   new policy; keep the native-colour-picker regression coverage.
4. Mixed toolbars still depend on renderer-supplied command hit boxes. Expand
   registration to every applicable non-editable command (including custom
   palettes), or supply explicit editable-control bounds before broadening the
   native policy. Forcing `MA_NOACTIVATE` indiscriminately is already documented
   to break WebView2 native colour popups. A literal never-active requirement for
   editable palette windows needs a separate input/keyboard ownership design.

## Charge hold then short press

`PaletteWindow.tsx` capture-phase pointerdown calls `dismissPaletteFlyouts`, even
on the same command button. This invalidates `popoverRequestRef`, clears replay,
queues `closeToolsetPopoverWindow` behind native open/content work, and broadcasts
dismissal. A drawing-command invocation also dismisses. The 200 ms hold timer
creates a fresh generation; a short press clears it. Rust's
`close_toolset_popover` immediately ends the lease and calls `hide()`; it has no
650 ms grace period.

The precise reason for the captured persistence is **not established**. Check
whether the short press reaches renderer pointerdown, whether its dismissal IPC
is delayed behind `popoverOperationsRef`, and whether a queued renderer reveal
arrives after close. Do not add an unversioned hide in `WM_MOUSEACTIVATE`: it would
leave the renderer's opening/replay live and could hide a newer valid hold.
If reproduced, fix the versioned renderer dismissal/reveal sequence and add a
350 ms hold -> short same-button press test with delayed native operations.

## Windows hands-on gate

Test fresh launch and again after HEX entry, native colour chooser use, caption
editing, and keyboard shortcuts. Capture synchronized foreground/active HWNDs,
native logs, and shadows for Main and its flyout: 350 ms Charge holds, short
same-button presses, bond/ring choices, and keyboard opens. Check no command
surface becomes active, shadow darkness stays constant, geometry stays fixed,
short presses dispatch exactly once, holds do not dispatch the primary command,
and a short press dismisses the old dropdown promptly. Also exercise disabled
commands, customized toolbars, mixed DPI, window dragging, and colour/select
editing. Windows runtime and Windows clippy/test remain unverified here; macOS
hands-on and Intel runtime are also unverified.

## Local verification

- macOS Apple silicon: `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check`
  and `cargo clippy --all-targets --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings`
  passed. Sparkle was copied from the existing local framework into the ignored
  worktree build-support directory; no dependency was downloaded or installed.
- Full `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`: 838 passed,
  28 failed, 9 ignored. Twenty-seven failures were sandbox-denied loopback socket
  operations. One was the unrelated fake 3D sidecar round-trip assertion; it
  passed on an isolated rerun with `tests::engine3d_sidecar_session_manager_round_trips_fake_protocol -- --exact`.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml panel_window::`:
  all 45 passed, including the three new activation-policy tests.
- Focused Vitest using `--configLoader runner --no-cache`: the existing native
  source-shape assertion described above failed (9 other assertions passed).
  The flyout and dismissal DOM suites could not load React/Tauri API imports
  from this isolated worktree's existing dependency links. No `pnpm install`
  was run and no frontend file was edited.
- `git diff --check` passed. No desktop app was launched; no visual/platform
  acceptance result is claimed from these unit checks.
