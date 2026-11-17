# Linux release

ChemDraft for Linux ships as two packages, built by `.github/workflows/linux-release.yml` on a
GitHub-hosted Ubuntu 22.04 runner from the same tag as the macOS DMG and the Windows installer:

| Package | For | Install |
| --- | --- | --- |
| `ChemDraft_<version>_amd64.deb` | Ubuntu 22.04+, Linux Mint 21+, Debian 12+, Pop!_OS, elementary OS, Zorin | `sudo apt install ./ChemDraft_<version>_amd64.deb` |
| `ChemDraft_<version>_amd64.AppImage` | Other glibc-based distributions (Fedora, openSUSE, Arch, …) | `chmod +x ChemDraft_<version>_amd64.AppImage && ./ChemDraft_<version>_amd64.AppImage` |

`SHA256SUMS-linux.txt` lists both checksums.

## Why Ubuntu 22.04

A Linux binary links against the glibc and WebKitGTK of the machine it is built on and runs only on
systems with the same or newer versions. Building on the oldest supported base (22.04, glibc 2.35,
WebKitGTK 4.1) covers Linux Mint 21 and 22 and every Ubuntu LTS still in support. Move the runner
forward only when 22.04 leaves support.

## Releasing

After creating the draft release (same as for Windows):

```sh
gh workflow run linux-release.yml --ref v<version> -f ref=v<version> -f upload_to_release=v<version>
```

The workflow:

1. Checks that `ref` is a tag (or full SHA) and that `upload_to_release` is `v<app version>`.
2. Builds the OPSIN Java runtime on the runner and smoke-tests it (benzene).
3. Builds a stable `.deb` and AppImage (`CHEMDRAFT_STABLE_BUILD=1`, no worktree label).
4. Checks the bundle identity and that the `.deb` carries `chemdraft`, the 3D sidecar and the
   OPSIN runtime.
5. Uploads the built packages and checksums as a CI artifact. Two independent smoke jobs download
   and verify that same artifact on **Ubuntu 22.04 and 24.04**; neither rebuilds it. Each installs
   the `.deb` and tests **both** it and the AppImage on Xvfb + Openbox, even if one fails. The matrix
   does not fail fast. It fails if ChemDraft exits or panics during start-up, if no window appears
   within 60 seconds, or if the process/window disappears during the next 20 seconds.
6. Only after **both smoke jobs pass**, uploads the packages and checksums to the draft release,
   never to a published one.

The release body gets a `## Linux` section beside `## macOS` and `## Windows`.

## Smoke diagnostics

Each package runs with `WEBKIT_DISABLE_DMABUF_RENDERER=1`, `GDK_BACKEND=x11`, and
`RUST_BACKTRACE=1`. The AppImage always uses `--appimage-extract-and-run`, so no FUSE mount is
needed, and its executable bit is restored after artifact download. Both packages launch with an
allowlisted environment and `/usr/bin:/bin` PATH, excluding inherited `PYTHON*`, loader overrides,
virtual environments, and AppImage variables. Window matching follows the launcher's process
ancestry because an AppImage may fork AppRun. Each launch has empty, writable XDG
config/data/cache/runtime directories and a private
`dbus-run-session`. The harness prints their contents and queries
`org.chemdraft.desktop.SingleInstance` before and after launch. On Linux the single-instance
plugin uses that D-Bus name, **not an app-data lock file**; the preflight requires it to be unowned.
This excludes a previous instance and saved session/plugin state without deleting anyone's data.
`xvfb-run -a` selects an available display and waits for server readiness, using
`-screen 0 1920x1080x24 +extension RANDR +extension GLX -nolisten tcp`. Openbox must advertise
`_NET_SUPPORTING_WM_CHECK` before either package starts. `xdpyinfo` records the server's actual
extensions; the GTK version query accommodates 24.04's `libgtk-3-0t64` package name.

The harness waits on the original PID, prints the captured `$?`, and decodes statuses greater
than 128 as signals. Harness-initiated SIGTERM (or SIGKILL after ten seconds) is labelled, so it
cannot be mistaken for the original startup failure. Cleanup terminates the launcher's process
group, including AppImage/WebKit children, before testing the other package.

On failure it prints every diagnostic log in full and retries under host `/usr/bin/gdb --nx --nh
-batch`, with `GDK_SYNCHRONIZE=1` and another fresh profile/session bus. The generated `debug.gdb`
records `XGetWindowProperty` window/atom IDs and caller stacks (using the amd64 argument registers).
After the retry, `xlsatoms` records the server's numeric atom-to-name mapping in `atoms.log`,
without calling back into Xlib from the debugger. It breaks on `gdk_x_error` if that symbol is
available, on fatal signals, and on `exit`/`_exit`, then prints all thread stacks. Exit breakpoints
retain a stack even when the inferior exits 01 instead of trapping. Synchronous mode is for the
retry only; the first launch retains normal timing.
The retry is bounded to 90 seconds (then ten seconds before SIGKILL); status 124 means the diagnostic
timeout. A successful retry does not clear the original failure. For the AppImage, the debugger
runs the inner ELF through AppRun in a disposable extraction: a wrapper substitutes GDB for
`usr/bin/chemdraft`, preserving AppRun's bundled library/schema/helper environment for the inferior.
The wrapper clears **all `PYTHON*` variables again after AppRun**, which can introduce its own
`PYTHONHOME`/`PYTHONPATH`. GDB starts with host PATH/libraries; a generated command file restores
AppRun's PATH and loader variables only for the inferior. This prevents host GDB's embedded Python
from trying to initialize from the AppImage's incomplete Python tree. The actual smoke
test still launches the unmodified delivered image. `ldd` is printed for the installed executable
and the extracted AppImage executable; the failed AppImage retry also prints it inside AppRun's
environment. Installed GTK, WebKitGTK, libsoup, and glibc package versions are recorded separately.
`4.1` in `libwebkit2gtk-4.1` is the ABI name, not the WebKit engine version; use those recorded
package versions when comparing 22.04 and 24.04.

Logs are preserved by the `always()` artifact step as `linux-smoke-amd64-ubuntu-22.04` and
`linux-smoke-amd64-ubuntu-24.04`, including Xvfb/Openbox/display
logs. The workflow also exports
`RUST_LOG=tauri=debug,tauri_runtime_wry=debug,wry=debug,tao=debug`. **The current Linux build has no
Rust log backend**, so that filter alone produces no debug messages (the existing logger is Windows
activation-only: `apps/desktop/src-tauri/src/windows_activation_log.rs:32`). Panic output/backtraces,
GTK stderr, and GDB remain available; GDB frame detail depends on the release binary's symbols.

### Second diagnostic run (`linux-beta-fail2.log`, 1490 lines)

The evidence narrows the failure to X11 but **does not identify a property atom or issuing call**:

- Lines 515–516: the installed `.deb` exits 133, signal 5 (`SIGTRAP`). Lines 597–605 report
  `BadImplementation`, serial 1048, error 17, core request 20 (`GetProperty`), and explicitly warn
  that X errors are asynchronous. No atom, window ID, or native frame is present there.
- Lines 519 and 747–748: the debugger command returns 0, but its **inferior exits 01**, followed by
  `No stack.` There is no backtrace in this log; GDB's status does not mean the application passed.
- Lines 1064–1065: the AppImage already uses `--appimage-extract-and-run` and returns 127.
  Lines 1146–1149 show that **ChemDraft actually ran**, then XCB reports an unknown sequence
  number / possible missing `XInitThreads`, followed by a `poll_for_event` assertion. Status 127
  alone therefore does not establish a missing executable or FUSE failure.
- Lines 1286–1313 belong to the **AppImage GDB retry**, after `ldd inside the AppRun environment`:
  `PYTHONHOME` and `PYTHONPATH` point inside the disposable AppDir, Python selects `/usr/bin/python`,
  and initialization fails with missing `encodings`. This is debugger environment contamination,
  separate from the first launch's XCB failure; it is addressed by the wrapper above.

Code inspection of the locked Tao 0.35.3 identifies a concrete **candidate**, not a proven culprit:
`src/platform_impl/linux/window.rs:318–330` registers a GTK configure-event handler that calls
`gdk::Window::frame_extents()` to update the cached outer geometry. GTK's X11 frame-extents path
can read `_NET_FRAME_EXTENTS` with `XGetWindowProperty`. GTK window positioning and monitor/workarea
initialization also read window-manager properties, so request 20 alone cannot distinguish them.
ChemDraft's tooltip path at `apps/desktop/src-tauri/src/lib.rs:6127–6135` marshals
`gtk_widget_input_shape_combine_region` onto the main thread; input-shape changes use the **Shape
extension**, not core GetProperty. This does not exclude other GTK calls during realization, but
does not justify changing that already-fixed path. There is no direct `XGetWindowProperty` in
ChemDraft's Rust sources.

**Server conclusion:** Xvfb, Xorg, and XWayland all implement core GetProperty. Reading an absent
`_NET_WM_*`/`_GTK_*` property normally returns type `None`, not `BadImplementation`; missing RANDR or
GLX support does not itself explain core request 20. A valid read should succeed on real servers
too. The XCB sequence assertion makes a client/library threading or protocol-state problem a
candidate that could also affect real servers; it is not proof that `XInitThreads` is missing (Tao
already calls it in `linux/x11/xdisplay.rs:48`). Neither an Xvfb-only quirk nor a specific app bug
is established. No speculative native workaround or Rust unit test is added.

The next task is to run this matrix and inspect synchronous property-call/error stacks, then
reproduce any remaining failure on Xorg or XWayland. The matrix compares two Xvfb/GTK/WebKit stacks;
even a 24.04 pass would not prove Xvfb is the cause. If symbol stripping prevents attribution,
capture an X11 protocol trace to pair the failing serial with its atom and retain native symbols
for the corresponding stack. Both Linux package launches remain unverified locally; macOS and
Windows were also unverified, with no native code changes in this follow-up.

### Ubuntu 22.04 early-exit investigation (PR #381 / `a17dfc84`)

The failed smoke log ends with an AT-SPI bus warning and two groups of GTK accelerator-removal
warnings, without an exit status or panic. Neither warning proves a fatal error. These are ranked
investigation hypotheses from the startup code, **not confirmed causes or evidence that 24.04 fixes
them**:

1. **GTK/muda menu replacement or teardown on the older GTK stack.** The setup installs a menu
   (`apps/desktop/src-tauri/src/lib.rs:1436`), and toolbar/plugin synchronization can rebuild it
   (`lib.rs:3426`, `lib.rs:8243`). `install_app_menu` at `lib.rs:8230` attaches only to the main
   document window on Linux. Two accelerator groups can therefore be **two successive menus on
   the same window**, not menus on two windows. In the locked muda 0.19.2 GTK implementation,
   menu detachment and `MenuChild::drop` remove accelerators and destroy GTK widgets
   (`src/platform_impl/gtk/mod.rs:302`, `:441`). This fits the last observed activity and could
   expose an older GTK lifetime bug; the accelerator warnings alone are harmless. A GDB stop in
   GTK/muda removal with SIGSEGV/SIGABRT would support this hypothesis. The Windows subclass bug
   described above `install_app_menu` is already avoided and does not establish a Linux bug.
2. **WebKitGTK/Wry initialization of additional utility webviews, or a native library/helper
   incompatibility.** Palettes build additional webviews at `lib.rs:9039`/`:9062`, the hidden tooltip
   at `lib.rs:6097`, and plugin panels (only when requested/restored) at `lib.rs:5023`. The
   non-Windows utility builder leaves Linux defaults unchanged (`lib.rs:9379`), while the post-build
   non-macOS configuration is a no-op (`lib.rs:9346`). Older WebKitGTK/GTK under Xvfb may differ in
   graphics initialization, process launching, or handling hidden/nonfocusable windows. Disabling
   DMABUF does not disable every graphics path. A native crash can lack Rust panic text; a WebKit
   subprocess failure alone does not necessarily terminate the host. A completely missing main
   library is less likely because GTK already ran, but late-loaded libraries and AppImage bundled
   versus host resolution remain candidates. Compare both `ldd` views, versions, and GDB frames.
3. **Tooltip realization/input-shape timing.** Prewarming runs after a palette paints
   (`lib.rs:5618`); its tooltip starts hidden/nonfocusable (`lib.rs:6092`, `:6096`). A direct Tao
   `set_ignore_cursor_events` call on an unrealized GdkWindow previously panicked inside a GLib
   callback, where unwinding aborts. **That workaround is already present in this source**:
   `lib.rs:6127` marshals onto the main thread and sets the shape on the GtkWindow widget, which
   GTK retains until realization (`lib.rs:6135`). Do not reintroduce the Tao call or assume this
   already-fixed path caused the observed failure. Only frames in GTK input-shape/realization
   code would justify further changes for GTK 3.24.33.
4. **Single-instance handoff (clean exit 0), or a broken session bus.** Registration is at
   `lib.rs:1067`, before application setup. The locked tauri-plugin-single-instance 2.4.5 Linux
   implementation (`src/platform_impl/linux.rs:85`) calls `cleanup_before_exit` and
   `process::exit(0)` on `NameTaken`; session construction also contains `unwrap` calls. A shared
   runner bus can therefore cause a silent clean exit independently of the distribution. This is
   lower ranked because menu-rebuild warnings suggest setup progressed beyond this check; the
   AT-SPI warning refers to the accessibility bus, not proof that the session bus failed. The
   private bus/name-owner preflight excludes a collision; `RUST_BACKTRACE` exposes a panic.
5. **A normal window-close/quit event rather than a native crash.** Linux takes the non-macOS
   close-request branch (`lib.rs:1224`) and the exit/flush handler (`lib.rs:1599`). An unexpected
   document close or last-window event could exit without panic output, but this code contains no
   unconditional Linux startup quit. If status is zero with no D-Bus collision, trace these
   events next. There is no evidence yet of an Ubuntu-version-specific trigger here.

These original hypotheses are retained as investigation history; the second diagnostic run above
supersedes the original next-step recommendation. The known tooltip workaround and document-only
menu installation remain in place.

## Updates

Linux has no in-app updater yet: the `.deb` and AppImage are updated by downloading the new
release. Options for later, in order of effort: an AppImage `.zsync` update file, a signed APT
repository on GitHub Pages, or a Flathub listing.

## Platform notes

- Webview: WebKitGTK, origin `tauri://localhost` (as on macOS).
- Menus: on the document window, as on Windows (`install_app_menu`). Edit ▸ Cut / Copy / Paste
  are routed commands (`clipboard_edit_menu_item`), not muda's predefined items: on Linux those
  only fake a key press through libxdo, which does nothing on Wayland and was unreliable on X11.
  They carry no accelerator, so Ctrl+X / C / V keep reaching the webview (and focused text fields).
- 3D: the `avogadro3d-sidecar` for Linux is still the placeholder (`binaries/README.md`), so 3D
  reports itself unavailable until a real Linux sidecar is built.
- Clipboard: `linux_clipboard.rs`, GTK's clipboard (X11 and Wayland). Targets are MIME types, so
  the editor's payload types are written unchanged; plain text is also offered as `UTF8_STRING`,
  `STRING` and `TEXT` for older X11 applications.
- Local tools (OCSR engine installer) report themselves unsupported on Linux for now.
- Building locally: `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev
  libayatana-appindicator3-dev libsoup-3.0-dev libssl-dev libxdo-dev patchelf`, then
  `node scripts/build-opsin-runtime.mjs` and
  `LD_LIBRARY_PATH=$PWD/apps/desktop/src-tauri/resources/opsin/jre/lib/server APPIMAGE_EXTRACT_AND_RUN=1 NO_STRIP=true pnpm --filter @chemdraft/desktop build --bundles deb,appimage`.
  The `LD_LIBRARY_PATH` lets linuxdeploy find `libjvm.so` for the bundled OPSIN runtime.
