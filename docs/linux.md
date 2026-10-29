# Linux development build

Linux support is experimental. The desktop application uses Tauri, GTK 3 and
WebKitGTK 4.1. The Flatpak build uses GNOME SDK/Platform 49 so it can also run on
hosts whose system packages do not provide WebKitGTK 4.1, including AlmaLinux 9.
It packages the existing desktop editor and its floating native windows.

This local build has the application ID `org.chemdraft.desktop.dev` and appears as
**ChemDraft (dev)**. It stays separate from the stable application's identity and
data. Nothing is uploaded or published by the packaging script.

## Install and run a locally built package

Install Flatpak using your distribution's package manager, then add Flathub if it
is not already configured:

```bash
flatpak remote-add --user --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
flatpak install --user ./artifacts/ChemDraft-linux-x86_64.flatpak
flatpak run org.chemdraft.desktop.dev
```

Flatpak may ask to install the GNOME 49 runtime. The package is unsigned and is a
local development artifact. On ARM64 the bundle filename ends in `aarch64`.
Installing another build with the same app ID and branch replaces this development
build. The package can also be launched from the desktop application menu.

The application can read and write files in your home directory, access the
network, and use X11, shared memory and GPU rendering. Network access supports
the existing plugin downloads. Flatpak keeps application data under
`~/.var/app/org.chemdraft.desktop.dev/`; the native Tauri app-data directory is
inside its `data/` directory. Files outside your home directory are not granted
general access by this package.

The package deliberately uses X11 (`GDK_BACKEND=x11`). On a Wayland desktop this
requires XWayland. Floating palettes currently rely on global window positions,
which native Wayland does not provide through the existing GTK/Tauri code.

New native CDXML saves use `chemdraft.cdxml.v3`, whose visible-XML checksum sorts
attribute names by UTF-16 code units independently of the locale. Existing v1/v2
envelopes are still verified and opened, including files written with the older
English or POSIX ordering. Their native document hash remains mandatory, and an
actual change to the visible XML is still detected. Saving upgrades an old file
to v3; merely opening it leaves the file unchanged. See the
[checksum contract](../packages/cdx-compat/README.md#native-cdxml-envelope-checksums).
The package no longer overrides `LC_ALL` to work around checksum ordering.

To remove the application while retaining its data:

```bash
flatpak uninstall --user org.chemdraft.desktop.dev
```

## Build the Flatpak

Prerequisites on the host:

- Node 24 and pnpm 10.12.1, available on `PATH`.
- Rust through rustup; `rust-toolchain.toml` pins the required toolchain.
- Flatpak and `taskset` (from util-linux).
- At least four available logical CPUs. The script reserves three for the operating
  system and uses at most three concurrent Cargo jobs.
- Enough disk space for the SDK, JavaScript dependencies and Cargo outputs.

```bash
flatpak remote-add --user --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
flatpak install --user flathub org.gnome.Sdk//49 org.gnome.Platform//49
pnpm install --frozen-lockfile
node scripts/build-linux-flatpak.mjs
```

Compilation runs inside GNOME SDK 49, using the host's Node, pnpm and Rust
toolchains. The build sandbox has access to the checkout, home directory and
network for dependency resolution. The source checkout and Cargo caches remain on
the host. Run the script from a checkout below your home directory, with your
toolchains below home or otherwise available in the SDK; host `/usr` is replaced
by the SDK's `/usr` during compilation.

The script builds a release executable with `tauri build --no-bundle` and an
explicit development identity. The window title and build stamp retain the
checkout's worktree label. Its default outputs are:

| Path | Contents |
|---|---|
| `apps/desktop/src-tauri/target/release/chemdraft` | Native release executable |
| `artifacts/flatpak-build/` | Staged Flatpak application and metadata |
| `artifacts/flatpak-repo/` | Local OSTree repository, branch `linux-dev` |
| `artifacts/ChemDraft-linux-x86_64.flatpak` | Installable single-file bundle |

The regular build includes the pinned `st` sign-in terminal and its complete
MIT/X Consortium licence. It stages resources, the application icon, desktop
launcher, `LICENSE` and `NOTICE`. It installs resources at
`/app/lib/chemdraft/resources` and adds relative aliases matching Tauri's product
name. No host WebKit libraries are
copied into the package; GNOME Platform supplies them at runtime.

To package an executable already compiled inside GNOME SDK 49:

```bash
node scripts/build-linux-flatpak.mjs --stage-only
node scripts/build-linux-flatpak.mjs --stage-only --binary /absolute/path/to/chemdraft
```

`--stage-only` also requires the previously built terminal at
`native/linux-terminal/build/chemdraft-terminal`. If missing, build it with
`node scripts/build-linux-terminal.mjs` after initializing the SDK build directory.

An arbitrary host-built binary may require a newer glibc or other libraries than
the runtime provides. `--stage-only` checks the executable's Linux architecture;
it does not establish runtime library compatibility or verify which build identity
was compiled into it. Use an SDK build with the development identity shown above.

`--build-dir` selects another build directory below this checkout's `artifacts/`;
`--output-dir` selects the directory for the repository and bundle. `CARGO_TARGET_DIR`
and `CARGO_BUILD_TARGET` are respected when finding the default executable.
`CARGO_BUILD_JOBS` can reduce parallelism below three. The same build directory
can be reused; its generated staged files are replaced on each packaging run.

## Repeat the native integration smoke

Use Node 24, host Xvfb and `tauri-driver` 2.1.0 (the version used for the recorded
checks). Install the driver with `cargo install tauri-driver --version 2.1.0 --locked`
if needed. The GNOME SDK supplies `/usr/bin/WebKitWebDriver`. After staging the
current development build, run:

```bash
node scripts/smoke-linux-native.mjs \
  --tauri-driver "$HOME/.cargo/bin/tauri-driver" \
  --build-dir artifacts/flatpak-build \
  --app /app/bin/chemdraft
```

The script records the current Node executable and uses a private profile, mounts
`scripts/test-resources/linux-desktop-v2.chemdraft` read-only, and runs the eight
native WebKit/GTK checks under `C.UTF-8`. Its engine checks require 8 GB for OCSR
and 1 GB for naming without installing either engine. It reserves three CPUs,
monitors disk reserves and writes `artifacts/linux-native-smoke.json`, screenshots
and logs. Display `:99` and ports 4448–4449 must be unused; select alternatives
with `--display :N --port N`. Existing displays and services are refused, and
cleanup signals only process groups started by the script. Use `--help` for the
output-directory option. No provider account or model request is used.

## Optional engines and current limits

**OPSIN name-to-structure:** build the trimmed Java runtime on Linux before
packaging, using JDK 21 or newer:

```bash
node scripts/build-opsin-runtime.mjs
```

The runtime is included when present. Without it, OPSIN reports itself unavailable.
The source checkout's Java runtime is not used as a release fallback.

**Native interactive 3D:** the script includes
`native/avogadro3d-sidecar/build/protocol-scout/avogadro3d-sidecar` when present.
Build it from the pinned dependencies using the
[native sidecar instructions](../native/avogadro3d-sidecar/README.md), replacing
the example Homebrew CMake path with `cmake` on Linux. The CMake build must use
the same architecture as the application. Linux placeholder files in
`src-tauri/binaries/` are never packaged as working engines. Without a real
sidecar, interactive native UFF mechanics reports itself unavailable.

**Assistant tools:** Claude Code 2.1.308 and Codex 0.163.0 have pinned Linux x86_64
and ARM64 downloads. Their sizes and SHA-256 values are checked before install;
Codex extracts only its CLI and the required `codex-code-mode-host`. Installation
and sign-in are explicit actions. In Flatpak, sign-in opens the bundled
`/app/bin/chemdraft-terminal` inside the sandbox. The terminal uses pinned
[st 0.9.3](../native/linux-terminal/README.md); it needs no host-process execution
permission. Sign-in remains interactive, and installation does not sign in for
you. Use Ctrl+Shift+V to paste; press Enter after the CLI finishes to close the
terminal. A native build outside Flatpak searches the supported terminal emulators.
ARM64 download integrity was checked, but ARM64 execution was not tested here.

**MolScribe recognition and Orthonym structure-to-name:** the optional local
engine installers support GNU Linux x86_64. Both use private uv-managed Python
environments and install only on explicit user action. Inference and naming run
locally; recognition results still require review, and names retain the exact
OPSIN read-back check. Cancellation, staged replacement and rollback use the
shared engine installer. Linux ARM64 is not enabled for these engines pending
complete dependency and integration validation.

| Optional engine | Linux installation inputs | Additional free space required | Measured completed install |
|---|---|---|---|
| MolScribe | uv 0.12.18, Python 3.10, separate 88-package CPU lock, torch 2.14.0+cpu / torchvision 0.29.0+cpu, verified source and 1.1 GB model | 8,000,000,000 bytes | 3,031,588,381 bytes |
| Orthonym | uv 0.12.18, Python 3.12, existing seven-package hash lock, Orthonym 1.0.8 and verified centres 1.2.1 jar | 1,000,000,000 bytes | 434,086,381 bytes |

MolScribe's Linux lock is `resources/ocsr/requirements-linux-x86_64.txt`, SHA-256
`381da6b0648e386311c87eed9c4dde0b79dbf68bf9ef6dbda1bd3e3e7173413f`.
Installation retains `--require-hashes` and selects the official PyTorch CPU
index with `--torch-backend cpu`; no CUDA, NVIDIA or Triton packages are installed.
The 8 GB gate measures currently free space on the app-data volume and covers
new staging and cache usage. An existing engine already occupies allocated space
and is renamed during the swap, so it is not counted again as a new copy.
Exact vendor pins, source/model hashes and licences are recorded in the
[dependency inventory](architecture/dependency-inventory.md),
[OCSR engine](architecture/ocsr-engine.md) and
[naming engine](architecture/naming-engine.md) notes.

Screen capture still requires a Linux implementation. The Linux build has no
automatic application updater; install a newer local Flatpak to update it.
macOS and Windows builds remain separate verification targets.

For source-level development on a Linux distribution with WebKitGTK 4.1
development libraries installed, the existing `pnpm dev` launcher can also be
used. It requires the host's native GTK/WebKitGTK build dependencies and keeps the
same development identity. A browser preview remains available with `pnpm dev:web`.

## Follow-up verification (2026-10-29)

The following checks cover the Linux installers and checksum changes following
the initial prototype reported below:

- The opt-in production installer test passed for the actual Claude/Codex Linux
  x86_64 vendor binaries, using the previously downloaded, verified vendor bytes.
  It exercised extraction, ELF validation, `--version`, the managed-directory
  commit, receipt and status; no user account was used.
- The real MolScribe production installation passed in GNOME SDK 49 in 66.07 s,
  including all downloads, the 88-package hash lock, source and model verification,
  final-directory relocation, import probe and receipt. Orthonym passed the same
  production transaction, including its jar/licence copies, in 11.75 s. Both
  tests removed their temporary engines after recording receipts. These elapsed
  times describe this test environment, not an installation-speed guarantee.
- The real MolScribe sidecar recognized an original synthetic ethanol drawing as
  `CCO` with three atoms and two bonds. The naming sidecar named ethanol, abstained
  on iron and rejected invalid SMILES using the bundled JVM and verified jars.
- The real Codex CLI and code-mode helper completed a loopback MCP echo in both
  GNOME SDK 49 and the installed Flatpak runtime with ChemDraft's read-only
  sandbox and shell-feature settings. Scripted local Responses events drove the
  test; it used no credentials and made no request to an external model provider.
  Repeat it with `scripts/smoke-linux-ai-mcp.mjs`.
- The bundled terminal passed a native-window PTY check, including Unicode and a
  real Enter key. A real provider-account sign-in was not performed.
- JavaScriptCore probes passed under `C.UTF-8`, `de_DE.utf8` and `en_US.utf8`:
  English and POSIX legacy files retained the identical native document, new
  v3 saves had the same visible hash in all three locales, and edits to the
  visible XML were detected.

Evidence: `artifacts/linux-followup/{ai,ocsr,naming}-production-install.log`,
`artifacts/linux-followup/real-engine-installs/*.json`,
`artifacts/linux-followup/cdxml-jsc-summary.json`,
`artifacts/linux-codex-code-mode-{sdk,runtime}.json` and
`artifacts/linux-terminal-pty.json`.

The final x86_64 package shows build stamp `10.29.10.50-codex`, is 74,246,288
bytes and has SHA-256
`622cb3b01f5292f345b0e4c5657ebb32f38d1b946d5abac390a0c4e22e391c80`.
Its local OSTree commit is
`c469dec5cd60b608410510a8850e1e1d3e28c8016ab7750018738aa42a225888`.
The package contains the Linux terminal and its licence, the OPSIN runtime and
the native UFF sidecar. It sets `GDK_BACKEND=x11` and does not set `LC_ALL`.

Final code checks passed: TypeScript, production web/native builds, Rustfmt,
release Clippy with `--all-targets -- -D warnings`, and 576 Rust tests (10
tests ignored). The three actual production-installer tests
were run separately as recorded above. The full JavaScript run reported 9,979
passes, 38 skips, two timeouts and one worker-RPC timeout during the requested
meeting pause; both affected files passed on retry (83 tests). The final
installer/catalog UI checks passed 116 tests, and the CDXML package passed all
138 tests. No remaining failing test case was identified.

Eight native WebDriver checks passed for this final build under `C.UTF-8`:
opening the legacy two-molecule file, chemical/Unicode MIME clipboard transfer,
real Ctrl+C/V/X text editing, PNG clipboard, actual OPSIN ethanol conversion,
packaged 3D sidecar discovery, supported Linux installer status/free-space gates
and responsiveness after native tooltip/palette prewarming. Evidence:
`artifacts/linux-native-smoke.json`, `artifacts/linux-followup/package.json` and
the corresponding logs in `artifacts/linux-followup/`.

The exact final bundle passed installation and rendered-editor checks on all
four container distributions:

| Container host | Flatpak | Result |
|---|---|---|
| Ubuntu 24.04.5 | 1.14.6 | Passed |
| Debian 13.7 | 1.16.6 | Passed |
| Fedora 44 | 1.18.4 | Passed |
| Arch rolling | 1.18.4 | Passed |

Each showed the final build stamp, native editor and both palettes. Ubuntu and
Fedora screenshots were independently inspected; Debian and Arch screenshots
were byte-identical to Ubuntu. Exact package hash, installed commit, window
state and image identity are recorded in
`artifacts/container-portability/{results,acceptance-summary}.json`.

To repeat the distribution checks, use an x86_64 Linux host with Docker, a
self-contained Node 24+ binary, the local bundle and system-installed
`org.gnome.Platform/x86_64/49` (`flatpak install --system flathub org.gnome.Platform//49`):

```bash
node scripts/test-linux-distributions.mjs --prepare-images
node scripts/test-linux-distributions.mjs --cleanup
```

The first command prepares missing Ubuntu 24.04, Debian 13, Fedora 44 and Arch
test images, then installs and launches the exact bundle with the committed
legacy drawing. Use `--distributions ubuntu24,debian13` to select a subset.
Private users, D-Bus and Xvfb isolate each run; only results are writable on the
host. The GNOME runtime, bundle, fixture and host Node binary are mounted read-only;
no host home directory or credentials are mounted. Each container is capped at
1.5 CPUs, three host CPUs remain outside the test affinity, and the shared disk
guard retains 20 GiB on home/output/Docker volumes and 10 GiB on root. Results,
package hashes, clipboard evidence and screenshots go to `artifacts/container-portability/`.
Cleanup removes only this harness's labelled containers/images; shared upstream
base images remain in Docker's cache. These Xvfb checks complement the separate
window-manager matrix below.

The final bundle also passed all six functional checks in each isolated desktop
session, using the same prepared Debian 13 image:

| Window manager / compositor | ChemDraft transport | Result |
|---|---|---|
| KDE KWin 6.3.6 | X11 | 6/6 passed |
| GNOME Shell 48.7 / Mutter | X11 | 6/6 passed |
| Xfce xfwm4 | X11 | 6/6 passed |
| Openbox 3.6.1 | X11 | 6/6 passed |
| KDE KWin 6.3.6 | Wayland compositor, XWayland client | 6/6 passed |
| GNOME Shell 48.7 / Mutter | Wayland compositor, XWayland client | 6/6 passed |

The checks cover the actual manager/compositor, rendered editor and palettes,
move/resize, real Ctrl+A/C/V and Undo with chemical-graph comparisons, palette
focus return, and minimizing/restoring the document and both palettes before
continued editing. Screenshots were visually inspected for all six sessions.
`scripts/test-linux-desktops.mjs --prepare-image` reproduces the matrix; evidence
is in `artifacts/linux-followup/desktops/results.json` and its per-session
screenshots. Tests use private displays/D-Bus, software rendering and the shared
read-only GNOME 49 runtime. They do not cover a full login session, physical GPU,
multiple monitors or native GTK Wayland window placement. Containers share the
host kernel. No real provider-account login was performed.

The final bundle was reinstalled per-user and the installed OSTree commit was
verified. A previously running development instance continues using its older
deployment until it is restarted; it was left open to preserve ongoing work.

During follow-up tests CPU affinity excluded cores 9–11, Cargo used at most three
jobs and Vitest at most two workers. A separate disk monitor retained a 20 GiB
home/Docker reserve and 10 GiB root reserve; neither threshold was reached.
The lowest observed free space was 81.78 GiB on home/Docker and 18.45 GiB on
root. Task-only desktop/distribution images and large model/download test
caches were removed after verification; unrelated images and containers were
left intact. Logs and final resource totals are in
`artifacts/linux-followup/disk-monitor.jsonl` and
`artifacts/linux-followup/resource-summary.json`.
macOS and Windows native checks remain unverified in this workspace.

## Initial prototype verification (2026-10-29)

This historical report describes the first editor package. The follow-up above
supersedes its locale workaround and unsupported-installer limitations.

Built from upstream `47899f92` plus the local `linux-port` changes. The application
shows build stamp `10.29.10.30-codex` and worktree label `chemdraft [linux-port]`.
The delivered x86_64 bundle is 74,084,144 bytes, SHA-256
`c63bcb32018a16abf400fecab386b4e210211fdf5806ea5fe48cfe08907d077e`.

| Container host | Flatpak version | Final bundle installation and rendered editor |
|---|---|---|
| Ubuntu 24.04.5 | 1.14.6 | Passed |
| Debian 13.7 | 1.16.6 | Passed |
| Fedora 44 | 1.18.4 | Passed |
| Arch rolling, image 20261025.0.616225 | 1.18.4 | Passed |

Each container showed the native menu, page canvas, rulers and both native tool
palettes after at least 30 seconds. Tests used isolated Xvfb displays, software
rendering and the shared read-only GNOME 49 runtime. Containers share the host
kernel; these checks do not establish native Wayland or separate hardware/GPU
coverage. The installed application also opened the example drawing on the
AlmaLinux 9 desktop through XWayland, with its normal renderer and native palettes.

Other verification:

- Root TypeScript check, production web build, Rust formatting and Linux Clippy
  with `--all-targets -- -D warnings` passed.
- The complete JavaScript suite initially reported 9,946 passes and 23 failures
  from resource deadlines and the newly added native command-signature variants.
  After updating the signature snapshot, all 19 affected files passed on retry
  with two workers: 408 passed, 7 skipped. No remaining failing JavaScript case
  was identified.
- Rust release tests passed: 569 passed, 7 ignored. The actual GTK display
  regression test was run separately and passed, including Unicode text aliases,
  exact custom chemistry formats and PNG bytes.
- Seven native WebDriver checks passed: document import, GTK chemical/Unicode
  clipboard, real Ctrl+C/V/X text editing, PNG, bundled OPSIN, native sidecar
  discovery and responsiveness after tooltip prewarming. The packaged sidecar
  also passed the 43-atom UFF smoke inside the SDK.
- The installed runtime's English collation opened the browser-generated example
  and saved/reopened its native envelope without warnings. POSIX collation was
  retained as a negative control for the existing locale-sensitive codec.

Historical evidence is in `artifacts/linux-followup/previous-linux-native-smoke.json`
and `artifacts/linux-followup/previous-container-portability/results.json`, with
their screenshots/logs. Container test scripts are retained in
`artifacts/container-portability/`; the prepared test
images and containers were removed. CPU 9–11 were excluded from the final builds
and tests; Cargo used at most three jobs and containers at most 1.5 CPUs each.
Disk monitoring ran every ten seconds and never reached its stop threshold.

macOS and Windows were not run in this workspace. Their Rust tests/Clippy and
native menu, clipboard and window-focus checks remain required before upstream
integration. ARM64 packaging is implemented by the script but was not tested.
