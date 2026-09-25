# Windows port — hands-on and stress test (2026-09-25)

Branch `windows-port`, installed NSIS build (`%LOCALAPPDATA%\ChemDraft`; `%LOCALAPPDATA%\ChemDraft (dev)`
since the review follow-up, which gives branch builds their own product name), Windows 11 VM. Driven with
real mouse and keyboard input (computer use) plus scripted IPC over WebView2 DevTools. Every issue below
was reproduced before it was fixed and re-checked on a fresh installer build afterwards.

## Fixed

| # | Symptom | Cause | Fix |
|---|---|---|---|
| 1 | **Crash at startup or quit** (`0xC0000005` then `0xC000041D` in `muda::…::menu_subclass_proc`; `GDI32.dll` at exit) | Tauri's app-wide menu is attached to every window on Windows, which subclasses each palette, popover, and the tooltip with muda's menu proc. `remove_menu` clears the bar but never removes the subclass, and Tauri frees a replaced menu while palettes still point at it; the next `WM_NCACTIVATE`/`WM_NCPAINT` read freed memory. | Off macOS the menu is set on the document window only, so no other window is ever subclassed (`install_app_menu`). An interim version also retained old menus across rebuilds; review showed that was unnecessary — on the main thread `Window::set_menu` keeps the old menu alive until the subclass is re-pointed. Old build: 4/4 cycles crashed under `smoke:windows-menu-churn`. Fixed builds: 0 crashes over 25 launches / ~990 rounds, every exit clean. |
| 2 | Ctrl+Y and Edit ▸ Redo did nothing (menu said "Ctrl+Y") | muda's predefined Redo works by sending Ctrl+Y; redo was only bound to Ctrl+Shift+Z | Platform alternate binding `Ctrl+Y` → `edit.redo` on Windows and Linux (`keyboardShortcuts.ts`) |
| 3 | Hovering a palette button greyed the document's title bar; keys went to the tooltip | `window.show()` on Windows is `SW_SHOW`, which activates despite `focusable(false)` | Build utility windows `focused(false)` (tao then shows them with `SW_SHOWNOACTIVATE`) and owned by the document window (off the taskbar, always above it) |
| 4 | Tooltips drawn behind their palette (after 3) | `SW_SHOWNOACTIVATE` keeps the old z-order | `SetWindowPos(HWND_TOP, SWP_NOMOVE \| SWP_NOSIZE \| SWP_NOACTIVATE)` after the show |
| 5 | Tooltip left on screen, empty, after the pointer moved away | Hide went through the JS window API (a different IPC path that could overtake a show), and tao's `hide()` was a no-op because tao never saw the raw show | New sync `hide_toolset_tooltip_window` command. With the show going through tao again (row 3), tao's `hide()` works; a generation counter drops a show that a hide overtook |
| 6 | Typing `#1E88E5` in a colour picker's HEX field produced `#11EE88` | Every keystroke was committed, and `#1E8` is valid shorthand | Live-apply only six-digit values; shorthand on Enter/blur; invalid input restored on blur (all platforms) |
| 7 | Ctrl+, "did nothing" when Preferences was open behind the document (same for the 3D Debugger toggle) | The toggle hid any visible window | Hide only when visible, not minimized, and not covered by the document window (a z-order walk from the document window — a non-activating window is never "focused"); otherwise bring it forward |
| 8 | Palettes restored stacked in the screen's top-left corner | Minimizing the document minimizes its palettes; Windows parks them off-screen and the `Moved` event saved (-16000, -16000) | Don't persist palette frames while the palette or the document is minimized |

Items 1's side effects also cleared: the Window menu opening empty, and the 3D Debugger being created
hidden on its first open.

## Review follow-up (`/code-review max`)

Fixed after review (all platforms unless noted): popovers and tooltips placed by the scale of the
monitor they land on rather than the moving window's own (mixed DPI); closing the document window or
File ▸ Exit flushes the session before quitting (Windows/Linux); F5 and Ctrl+R no longer reload the
webview (Windows/Linux); a maximized window restores maximized; opened documents join the fs scope so
they can be saved; sidecar placeholders rejected by marker, PE header read correctly; clipboard — shell
and Office formats never decoded as text, UTF-16 detection, MDLCT padding and cp1252, CRLF on write,
PNG dpi carried into the DIB; Escape abandons a half-typed HEX value and RGB/CMYK settle once; shortcut
labels (`Cmd++`, `CmdOrCtrl`, Mac glyph labels off macOS); OPSIN launch failures reported as engine
failures; launcher scripts keep Windows' `Path`, label builds, and give branch builds their own
identifier and product name (`ChemDraft (dev)`) so they neither replace nor hand off to a stable
install; the Windows installer no longer takes over `.cdxml` from ChemDraw (NSIS ignores the
Alternate rank; `tauri.windows.conf.json` registers `.chemdraft` only); plugin tooling works with 8.3 temp paths and GNU tar, and zip reads verify CRCs; NOTICE
carries avogadrolibs and Eigen for the shipped sidecars.

## Verified working

Palettes stay above the document; minimize/restore hides and shows them; maximize/restore. Menu bar on
the document window only (Preferences, 3D Debugger, plugin panel windows have none); checkmarks update
(View ▸ Show Rulers). Bond and ring drawing; Ctrl+Z/Y/N/S/O/R/Ctrl+,; menus read "Ctrl+…". Keybinding
scheme switch rebuilds the menu live (Export: Ctrl+Shift+E ↔ Ctrl+E). Colour picker popover opens at
the swatch and takes typing. Copy As SMILES → Notepad, Notepad → paste as structure, Copy As PNG → Paint.
Save / reopen round trip (fill colour preserved). Help ▸ About shows 0.3.4. File ▸ Exit and the close
button both exit with code 0. Analyze ▸ Mass (IsoSpec WASM) in panel and pop-out window. Spin 3D and
Interactive 3D (sidecar): rotate, flatten, and Esc cancel (Esc checked through DevTools input — see below).

## Known issues, not fixed

- **Native `title=` tooltips render as a solid black box in palette windows** (seen on the disabled Art
  colour trigger). Chromium draws these itself; the palettes' own tooltips are unaffected. Cause not
  established; 62 `title=` attributes in the UI, so the fix needs a decision (route them through the
  floating tooltip, or find why WebView2's native tooltip is unpainted in these windows).
- Palette tooltips sometimes took ~2 s rather than the 500 ms delay when moving between adjacent
  buttons. The show path is now two IPC round trips (monitor query and size in parallel, then one
  position-and-show command) instead of four sequential ones; not re-measured.
- Palettes already saved at (-16000, -16000) by the pre-fix build restore to the screen corner once;
  moving them saves a good position again.
- Plugin panel "Open as window" opens at the screen's top-left rather than near the document.
- A plain Copy of a molecule publishes no `text/plain` (by design, same on macOS): pasting into Notepad
  needs Copy As ▸ SMILES/MOL.

## Testing notes

- **Never send a real Escape while Claude computer use is active**: Escape is its stop key, so the session
  ends and the app never receives the key. That produced a false "Esc doesn't work" lead; the app handles
  Esc correctly when the key is delivered through DevTools `Input.dispatchKeyEvent`.
- `pnpm smoke:windows-menu-churn` reproduces item 1 against the installed build (Windows only). It needs
  no screen, but pops windows on the desktop while it runs.
