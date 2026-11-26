# Linux release

Linux is an optional, community-tested beta indefinitely. A Linux build is named after its parent
version plus β: the Linux build of 1.2.3 is ChemDraft 1.2.3β (in general, `<version>β`). It ships
under the same release tag, `v<version>`, as the macOS and Windows builds. macOS and Windows
releases never wait on Linux. When Linux packages are available and included, both packages
and their `.build.json` records must be attached. The release checker validates their names,
version, hashes, sizes and commit against the same release tag as the macOS DMGs and Windows
installer. The GitHub-hosted Ubuntu 22.04 runner builds both packages in `linux-release.yml`.

| Package | For | Install |
| --- | --- | --- |
| `ChemDraft_<version>-beta_amd64.deb` | Ubuntu 22.04+, Linux Mint 21+, Debian 12+, Pop!_OS, elementary OS, Zorin | `sudo apt install ./ChemDraft_<version>-beta_amd64.deb` |
| `ChemDraft_<version>-beta_amd64.AppImage` | x86-64 distributions with glibc 2.35 or later and compatible host graphics libraries | `chmod +x ChemDraft_<version>-beta_amd64.AppImage && ./ChemDraft_<version>-beta_amd64.AppImage` |

For 1.2.3 these are `ChemDraft_1.2.3-beta_amd64.deb` and `ChemDraft_1.2.3-beta_amd64.AppImage`.
The `.deb`'s package version is `<version>~beta` (`1.2.3~beta`). Debian sorts `~` before the plain
release, so a later `<version>` final installs over the beta as an upgrade.

`SHA256SUMS-linux.txt` lists both package checksums. The combined `SHA256SUMS.txt` covers all
other attached release assets, including the Linux packages and records when supplied.

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
   For uploads, the build ref must also match the workflow commit.
2. Verifies the committed x86_64 3D sidecar before anything else: runs the sidecar audit, then
   `scripts/verify-committed-linux-sidecar.mjs`, which fails unless
   `scripts/engine3d-sidecar-linux.json` is filled in, the committed file is not a placeholder, its
   SHA-256 equals the pinned one, and `scripts/check-engine3d-sidecar.mjs` passes it (a native
   x86-64 ELF that needs only glibc libraries, at most glibc 2.35, and completes the protocol
   handshake). Packaging never builds the sidecar or writes over it; see
   [The x86_64 3D sidecar](#the-x86_64-3d-sidecar). Until a maintainer commits it, the pin reads
   `PENDING-MAINTAINER-COMMIT` and every Linux package build fails here, on purpose.
3. Builds the OPSIN Java runtime on the runner and smoke-tests it (benzene). Then, right before
   bundling, it fails unless `Cargo.lock` is current (`cargo metadata --locked`) and
   `git status --porcelain --untracked-files=normal` is empty, printing any dirty paths: the
   footer's build stamp says `+dirty` otherwise. It builds a stable `.deb` and AppImage
   (`CHEMDRAFT_STABLE_BUILD=1`, no worktree label) and fails if the bundle build left the tree
   dirty. Any failure fails the job.
4. Names the packages for the beta. Tauri writes `ChemDraft_<version>_amd64.*`; the workflow renames
   the AppImage to `ChemDraft_<version>-beta_amd64.AppImage` and rebuilds the `.deb` with
   `dpkg-deb` as `ChemDraft_<version>-beta_amd64.deb`, changing only its control `Version` to
   `<version>~beta` (Tauri has no setting for it short of changing the shared app version).
   Then it checks the bundle identity and that the `.deb` carries `chemdraft`, the 3D sidecar and the
   OPSIN runtime. The `.deb`'s sidecar must have the SHA-256 pinned in
   `scripts/engine3d-sidecar-linux.json`, pass the same checks as the committed file
   (`scripts/verify-committed-linux-sidecar.mjs --packaged`), and be a regular file with mode
   exactly 0755, both in the archive listing and once extracted, so every user can run it after a
   root-owned install.
5. Repacks the AppImage after Tauri bundles it. It replaces linuxdeploy's copy of the sidecar
   (whose RUNPATH linuxdeploy may rewrite) with the committed file verified in step 2, and after
   repacking re-extracts the AppImage and checks that copy against the pin and for mode 0755 the
   same way. It uses
   the host's Wayland and compiler runtime libraries and the host's `libgpg-error.so.0`. It also removes the bundled copies of libraries
   that host Mesa (`libEGL_mesa`, `libgallium`, `libgbm`, the DRI drivers) depends on, so the
   Ubuntu 22.04 copies never shadow the host's newer ones: `libzstd.so*`, `libelf.so*` and
   `libelf-*.so`, `libffi.so*`, `libXau.so*`, `libXdmcp.so*`, `libxcb-randr.so*`,
   `libxcb-shm.so*`, `libbsd.so*`, and `libmd.so*`. Each is a standard base package on every
   supported host (on Debian and Ubuntu: `libzstd1`, `libelf1`, `libffi8`, `libxau6`,
   `libxdmcp6`, `libxcb-randr0`, `libxcb-shm0`, `libbsd0`, `libmd0`); `libxcb.so.1` stays
   bundled. The job verifies that the finished image contains none of these and no `libwayland-*`,
   `libstdc++.so*`, or `libgcc_s.so*` files or symlinks. The job logs the bundled shared libraries
   under `usr/lib` and rejects bundled `libEGL*`, `libGL.so*`, `libGLX*`, `libOpenGL.so*`,
   `libGLESv1_CM.so*`, `libGLESv2.so*`, `libGLU.so*`, `libGLdispatch*`, `libgbm*`, `libdrm*`,
   `libglapi*`, `*_dri.so`, `libvulkan*`, and any `dri` directory or symlink.
   The repack lets ChemDraft select the GTK backend and sets absolute paths for the WebKit injected
   bundle and bundled GIO modules in the AppRun hook. WebKitGTK starts its helpers relative to the
   working folder set by AppRun.
6. Records the source commit and final bytes of each package, then stages the packages, records,
   and checksums as the `linux-release-amd64` workflow artifact.
7. Runs independent smoke jobs on **Ubuntu 22.04 and 24.04**. Each downloads and verifies the same
   22.04-built packages against `SHA256SUMS-linux.txt`. The jobs run both package checks, even
   when the AppImage or the other runner fails.
8. The Debian sid, Fedora and Arch container checks, including the native-Wayland AppImage and
   .deb jobs, also have to pass before upload. After the
   smoke jobs pass, the workflow fetches the draft's tag and checks that it resolves to the build
   commit. It uploads to the existing draft, validates the attached builds, and refreshes the
   combined checksums.

The [release body generator](three-builds.md#draft-the-body-on-macos) adds `## Linux` when both
packages and their records are present and verified. Passing `--include-linux` requires that complete
verified set in the assets directory.

## The x86_64 3D sidecar

`apps/desktop/src-tauri/binaries/avogadro3d-sidecar-x86_64-unknown-linux-gnu` is a committed
binary, pinned by SHA-256 in `scripts/engine3d-sidecar-linux.json`, the one place packaging reads
its hash. Once the file is no longer the placeholder, `scripts/verify-committed-linux-sidecar.test.ts`
checks the bytes on disk against the pin, and the dependency inventory against both pinned values.
`.github/workflows/linux-sidecar-build.yml` builds it from the pinned avogadrolibs and Eigen
commits on Ubuntu 22.04, as `native/avogadro3d-sidecar/README.md` describes, runs the audit, the
handshake check and the three `smoke:engine3d-*` smokes, and uploads the artifact
`engine3d-sidecar-linux-x86_64` (the binary and its `.sha256`). To land or replace it:

1. `gh workflow run linux-sidecar-build.yml --ref <branch or tag>` once the file is on `main`
   (GitHub dispatches only workflows on the default branch), or push the commit to build to the
   branch `ci/linux-sidecar-build` (`git push -f origin <commit>:refs/heads/ci/linux-sidecar-build`),
   which triggers it. It has no inputs and builds that ref's sources.
2. From the run's summary, note the run id and the SHA-256. Download the artifact
   (`gh run download <run id> -n engine3d-sidecar-linux-x86_64 -D <dir>`) and check it with
   `sha256sum --check avogadro3d-sidecar-x86_64-unknown-linux-gnu.sha256` in that folder.
3. `install -m 0755 <dir>/avogadro3d-sidecar-x86_64-unknown-linux-gnu
   apps/desktop/src-tauri/binaries/` (git must record mode 100755).
4. In `scripts/engine3d-sidecar-linux.json`, replace both `PENDING-MAINTAINER-COMMIT` values:
   `buildRunId` with the run id, `sha256` with the SHA-256.
5. In `docs/architecture/dependency-inventory.md`, fill in the same `run id:` and `SHA-256:`
   in the `avogadrolibs` row.
6. Commit all three files together. Any change to the avogadrolibs commit pinned in
   `native/avogadro3d-sidecar/CMakeLists.txt` needs a rebuilt, recommitted sidecar: the handshake
   check requires the binary to report that commit.

## Ubuntu smoke diagnostics

Both runners use the package smoke composite action shared with the container workflow. Each
runner restores the AppImage's executable bit and launches it with `--appimage-extract-and-run`
before apt installs the `.deb` and its dependencies. Each launch uses Xvfb, Openbox, a private
D-Bus session, and fresh XDG directories. Xvfb selects a free display with RANDR and GLX enabled,
and the action waits for Openbox readiness. The action checks that the app and a WebKit web process
start and a ChemDraft window appears within 60 seconds. The app must stay up for another 20 seconds,
with a visible window and live web process at the end. A WebKit web process crash or app panic fails
the check. The harness matches processes and windows to the active launch by process ancestry.
The smoke test also reports EGL display initialization failures and logs the display backend settings.
For the AppImage, it checks that the extracted GTK hook preserves the caller's backend, the
exported resource paths point inside the extraction, and ChemDraft reads relative document
arguments from two separate launch folders on startup and single-instance handoff.

The `linux-smoke-amd64-ubuntu-22.04` and `linux-smoke-amd64-ubuntu-24.04` artifacts preserve
package setup, library versions, display, app, and process logs even when smoke fails. The harness
records the traced launch's exit status and any encoded signal, and labels signals it sends during
cleanup. It also records profile contents and the single-instance D-Bus name owner. The `ldd` logs
cover the app and WebKit helpers, using installed paths for the `.deb` and AppRun's library paths
for the AppImage. Compare the reported package versions across runners since `4.1` names the
WebKitGTK ABI.

A failed launch gets a GDB retry with a fresh profile and D-Bus session and synchronous GTK X11
errors. The retry times out after 90 seconds, with a further ten seconds before SIGKILL. It records
thread stacks if GDB catches a fatal signal or reaches an exit breakpoint. For the AppImage, the
action uses a disposable extraction so the app under GDB has AppRun's environment and GDB can use
host libraries and Python. A successful retry leaves the original failure in place. GDB frame
detail depends on the binary's available symbols.

## Container smoke test

A tester can run ChemDraft with `CHEMDRAFT_PALETTE_FOCUS_LOG=1` to get one `[palette-focus] linux-acquire` line per field click on stderr; the smoke sets it.

Pull requests changing Linux packaging paths, any desktop Rust source, `Cargo.toml` or `Cargo.lock`
also build and smoke-test packages from the PR head.

Build and test both packages using the workflow from a branch or tag:

```sh
gh workflow run linux-container-smoke.yml --ref <branch-or-tag>
```

To test existing packages, add `-f artifact_run_id=<linux-release-run-id>` and optionally
`-f artifact_name=<name>` (defaults to `linux-release-amd64`). A reusable caller can also supply
`artifact_name` for packages uploaded earlier in the same run. Reusable callers need
`actions: read` for artifact downloads. The shared build runs with read access.

The workflow checks Debian sid and Fedora under Xvfb and headless Weston, and Arch under Xvfb.
AppImage jobs extract the image and use its library search path to check host Mesa, DRI, GBM and
DRM dependencies with `ldd`; missing or AppImage-shadowed dependencies fail the job. The containers install
libgpg-error as a desktop system would. Debian installs the
.deb with apt and Fedora extracts its payload and runs it with Fedora's libraries. Each job
uploads display, app, and process logs. These tests cover startup and subprocess crashes. GPU
rendering still needs a desktop check. The privileged containers allow `strace` to trace the app
and glycin's bubblewrap to create user namespaces. Weston runs the AppImage both with and without
XWayland.

On Ubuntu and in the Xvfb container jobs, readiness requires the Main Toolbar window and more
than 16 distinct colors in the document screenshot below the native menu bar. The check reads
the Main Toolbar and Drawn Structure Settings entries from the GTK **View > Toolbars** accessibility
tree. It uses `xclip` and real keyboard shortcuts to round-trip plain SMILES text and the native
ChemDraft selection format through the X11 clipboard. Inspector digit entry and preservation of the
drawing during that entry are skipped because the package harness has no document snapshot reader.

The Debian and Fedora Wayland jobs where ChemDraft uses XWayland (both packages, by default) also
run `.github/workflows/linux-package-smoke/toolbar-field.py` twice: once under headless Weston
(`--compositor weston`) and once under a virtual KWin (`--compositor kwin`, which runs
`kwin_wayland --virtual --xwayland`; the jobs install Debian's `kwin-wayland` or Fedora's
`/usr/bin/kwin_wayland`). Each run starts its own compositor with XWayland, pastes
propane and reads the document back with **Edit > Paste**, **Select All**, **Copy As > SMILES** and
**Copy**, opens Drawn Structure Settings from **View > Toolbars**, clicks into one of its number
fields with an XTEST click and types `30`. Under KWin it first clicks an empty area of the
document's canvas with an XTEST click, as a user would to bring ChemDraft to the front, waits
until the document has focus (falling back to `xdotool windowfocus`, and saying so, if KWin did
not focus it on the click), and chooses **Select All** again, since that click clears the
selection. Those fields are enabled only while a molecule is
selected, which **Select All** leaves in place. It finds the field over AT-SPI as WebKitGTK exposes
it (a spin button, or an editable entry named for a number field, that is enabled or sensitive;
the AppImage's WebKitGTK reports these fields with the role "embedded", and the log notes it),
clearing libatspi's cache before each scan, and logs every candidate it saw. When it finds none,
it also logs the palette's accessibility tree, so the log shows whether the web content, the
selection or only the field's state was missing. It chooses every menu command over AT-SPI rather than
typing its shortcut, because the compositor's X window manager decides where X keyboard focus goes and
can undo a focus change that `xdotool` makes. It first requires that no ChemDraft window other
than the document has focus, since the Edit commands follow the focused window. Under KWin it passes only
if the field's value changed and the document's Copy As SMILES text and native selection JSON
did not. KWin's X window manager honors a client's own focus request, as on KDE Plasma, so the
KWin run is the pass/fail check for click-to-focus in a toolbar field. Under Weston only the
chemistry must stay the same: an unchanged field is logged as a notice, not a failure, because
Weston cannot test click-to-focus (below). The native Wayland job does
not run it: Weston has no protocol that lets a test client type into another client's window, and
`xdotool` reaches X11 windows only. KWin and Weston still differ from Mutter and other X window
managers, so a pass does not prove focus handling under every desktop.

KWin 6 routes XWayland's XTEST input, which is what `xdotool` sends, through libei, and by default
it holds that input behind a "Remote Control" prompt (`kwin_eis_prompter`) until someone presses
Allow. Before starting KWin, the check writes `XwaylandEisNoPrompt=true` in group `[Xwayland]` to
the `kwinrc` in the session's own `XDG_CONFIG_HOME`. That is the setting System Settings' "Legacy
X11 App Support" page writes, and it makes KWin accept XWayland's input without asking (KWin 6.7.4
and 6.8.3, `src/kwin.kcfg` and `src/plugins/eis/xwaylandeiscontext.cpp`). The log says which input
path XWayland used (libei when its process has `LIBEI_SOCKET`) and whether the prompt appeared.

Weston cannot test click-to-focus, whatever the app does, so its run is not a focus gate; it
keeps its setup, accessibility and chemistry checks. Weston's X window
manager gives X focus only to the window the compositor last activated and resets any other
focus change a client makes; it ignores `_NET_ACTIVE_WINDOW`. The compositor activates a window
only on input from a Wayland seat. Headless Weston has no seat unless started with `--fake-seat`,
and XTEST clicks never leave XWayland, so X focus stays on Weston's 1x1 no-focus window. Under both
compositors ChemDraft writes one `[palette-focus] linux-acquire` line per field click to its log on
Linux, whatever the agent-bridge setting, and the script prints those lines: they show whether the
click reached the app (`gtk-click`), whether a ChemDraft window had focus when the request ran
(`app-foreground=`) and when one last lost focus relative to the press (`app-focus-lost=`, such
as `40ms-before-press` or `never`), which X window held the keyboard when the request ran
(`focus-holder=`, one of `chemdraft(0x...)`, `none`, `pointer-root`, `root`, `wm(0x...)`,
`other(0x...)`, `unknown`, or `n/a` off X11, followed by `net-active=` with the root window's
`_NET_ACTIVE_WINDOW`), what its focus gate decided (`request=`), whether it called
`XSetInputFocus`, and which X window held focus afterwards. The script then repeats
`app-foreground`, `app-focus-lost`, `request` and `outcome` for each line. If moving the pointer to the field
does not take, the script retries a few times and then moves it with relative XTEST motion before
it gives up, and prints XWayland's libei lines from `display.log`.

Linux follows Windows and macOS (owner decision, 2026-11-21): a click on a palette field while
another application is really in front does not take the keyboard. The keys stay with that
application, and the user clicks a ChemDraft window first. The only exception covers the X11
focus handoff race. A window manager may move X focus off the document as it offers the click to
the palette, which does not accept focus until the field asks, so no ChemDraft window has focus
when the request runs although ChemDraft was in front at the press.

Without a focused ChemDraft window, the gate needs positive evidence of that race. It lets a
request through only when all of these hold:

- a live GTK button press on that same palette backs it, with an X server time, less than one
  second old;
- the X window holding the keyboard when the request runs is a ChemDraft window (a toplevel or a
  child of one), or nobody's: `None`, `PointerRoot`, the root window, or a window no client
  manages, which is the window manager's own no-focus window. ChemDraft reads this with
  `XGetInputFocus`, walking up the window tree for a ChemDraft window or a window carrying
  `WM_STATE` (a managed client), and down through a window manager frame to its client. A
  `_NET_ACTIVE_WINDOW` on the root window that names another client counts as that client
  holding the keyboard;
- a ChemDraft window lost toplevel focus at most 300 ms before the press, or after it. The
  handoff happens within the dispatch of the press itself, so the loss should land within
  milliseconds of it (`app-focus-lost=` in the log shows the real figure); a person who switches
  away first needs about 400 ms just to move a hand from the keyboard to the mouse (the
  Keystroke-Level Model's homing time).

When another client holds the keyboard, the gate refuses with `denied:other-app-focused`, however
recently ChemDraft lost focus: Alt+Tab to a terminal and an immediate click on a palette field
leaves the keys with the terminal. A failed X query refuses with `denied:focus-holder-unknown`.
Otherwise a press with no recent ChemDraft focus loss is refused with
`denied:app-not-focused-at-press`, and a request with no live press with
`denied:app-not-focused` (a JavaScript-only or delayed request, a press older than one second,
one with no X server time, or one on another window). Hidden and minimized palettes are always
refused. The X server ignores `XSetInputFocus` with a click time older than the last focus
change, so a click followed by a switch to another application cannot pull focus back.

One limit remains, under XWayland only. A native Wayland application (one not running through
XWayland) in front is invisible to X: the compositor's X window manager leaves X focus on its
no-focus window, on `None`, or on the ChemDraft window that last had it, and `_NET_ACTIVE_WINDOW`
names no X window. The handoff itself can produce the same readings, so ChemDraft cannot tell the
two apart, and only the 300 ms bound applies. A palette click within 300 ms of switching from
ChemDraft to a native Wayland application can still take the keyboard. Under native Wayland
(`CHEMDRAFT_NATIVE_WAYLAND=1`), ChemDraft makes no X focus call and the compositor alone decides
whether the palette gets focus. Without any window manager, no window carries `WM_STATE`, so
another client's window reads as a window manager window and, again, only the 300 ms bound
applies.

## Updates

Linux has no in-app updater yet: the `.deb` and AppImage are updated by downloading the new
release. Options for later, in order of effort: an AppImage `.zsync` update file, a signed APT
repository on GitHub Pages, or a Flathub listing.

## Platform notes

- On Wayland with a non-empty `DISPLAY`, ChemDraft defaults to XWayland so it can position
  floating toolbars and dialogs. With no X11 display, GTK chooses native Wayland.
  `CHEMDRAFT_NATIVE_WAYLAND=1` skips this default and an explicit `GDK_BACKEND` takes precedence.
- Webview: WebKitGTK, origin `tauri://localhost` (as on macOS). Before startup on Linux,
  ChemDraft defaults `WEBKIT_DISABLE_DMABUF_RENDERER` to `1` to avoid Wayland graphics
  problems. An explicit value, including `0`, takes precedence.
  For AppImage launches, an explicit `EGL_PLATFORM` takes precedence. Otherwise, a `GDK_BACKEND`
  starting with `x11` or `wayland` selects that EGL platform. For other or unset backends, ChemDraft
  selects `wayland` when `WAYLAND_DISPLAY` is non-empty and `x11` otherwise.
- AppRun's working folder stays inside the image for WebKitGTK. ChemDraft resolves relative
  document arguments against the caller's `OWD` or home folder before opening or forwarding them.
  File dialogs use an explicit start path when supplied, otherwise they start in `OWD` or home
  (home also when `OWD` cannot be listed or entered).
- A document whose file name is not valid UTF-8 cannot be saved back in place, because the
  renderer keeps the path as text. ChemDraft refuses to open it and shows a message naming the
  file. A second AppImage launch forwards its other documents, shows the same message, and exits
  with status 1.
  ChemDraft starts its child processes in the home folder or a directory required by the tool.
- Linux session end uses the same recovery write as File ▸ Exit. The app requests it on SIGTERM,
  SIGINT, SIGHUP, a GNOME session-end notification, or a logind shutdown notification. When
  available, a logind delay inhibitor gives the renderer up to two seconds to confirm the
  write. A separate three-second deadline covers a stalled event loop or teardown. When the
  write is not confirmed in time, ChemDraft answers GNOME's session-end request with "not OK"
  and the reason "ChemDraft could not save your open documents", and exits with status 1.
- Menus: on the document window, as on Windows (`install_app_menu`). Edit ▸ Cut / Copy / Paste
  invoke WebKitGTK's native editing commands in the focused window. The webview receives
  Ctrl+X / C / V directly and uses the same clipboard events for menu clicks and shortcuts.
- 3D: the x86_64 `avogadro3d-sidecar` is committed like the macOS and Windows ones, built by
  `linux-sidecar-build.yml` (see [The x86_64 3D sidecar](#the-x86_64-3d-sidecar)); the aarch64
  Linux file stays a placeholder (`binaries/README.md`). The container smoke checks that the
  installed sidecar from the `.deb` and from the AppImage is a real ELF that completes its
  handshake on each distro. A build that bundles a placeholder omits Interactive 3D from the
  toolbars, menus, palettes and Customize gallery for the whole session (AGENTS.md §10) rather
  than showing it disabled; Spin 3D does not use the sidecar and always stays.
- Clipboard: `linux_clipboard.rs`, GTK's clipboard (X11 and Wayland). Targets are MIME types, so
  the editor's payload types are written unchanged; plain text is also offered as `UTF8_STRING`,
  `STRING` and `TEXT` for older X11 applications.
- Local tools (OCSR engine installer) report themselves unsupported on Linux for now.
- Building locally: `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev
  libayatana-appindicator3-dev libsoup-3.0-dev libssl-dev libxdo-dev patchelf`, then
  `node scripts/build-opsin-runtime.mjs` and
  `LD_LIBRARY_PATH=$PWD/apps/desktop/src-tauri/resources/opsin/jre/lib/server APPIMAGE_EXTRACT_AND_RUN=1 NO_STRIP=true pnpm --filter @chemdraft/desktop build --bundles deb,appimage`.
  The `LD_LIBRARY_PATH` lets linuxdeploy find `libjvm.so` for the bundled OPSIN runtime. Apply the
  repack step in `linux-build.yml` before launching the AppImage.
