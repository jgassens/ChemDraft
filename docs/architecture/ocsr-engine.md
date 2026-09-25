# Local MolScribe OCSR Engine

ChemDraft's MolScribe integration is an optional, host-managed local engine. It is the native half of
image-to-structure recognition; the TypeScript half (the recognizer plugin and its review flow) calls
the commands below. Nothing is downloaded or started at application startup. The main window must
first obtain explicit user confirmation and invoke `ocsr_engine_install`; recognition remains
proposal-only in the plugin workflow (AGENTS.md §7, §8).

The recognizer plugin itself is not bundled: it is the official MolScribe OCSR plugin, installed from
`jgassens/ChemDraft-MolScribe-Plugin` through Add or Remove Plugins. The engine outlives the plugin —
uninstalling the plugin while the engine is installed asks once whether to remove the engine too, and
the manager's engine row is shown only while the plugin is installed.

## One-click install from the catalog

A catalog entry that needs the engine says so as data — `requiresEngine: "structureRecognition"` in
`OFFICIAL_PLUGIN_CATALOG` (`pluginUpdates.ts`) — and the plugin manager keys only on that, never on a
plugin id. For such an entry the single **Install** button does both installs:

1. The package review states, before the user confirms, that the local recognition engine comes too:
   about 2.5 GB to download, the free space it needs, and the free space now (status is re-read when
   the review opens). It warns if space is short; it says so instead when the engine is already
   installed or the computer is unsupported.
2. Confirming installs the plugin, then immediately starts the engine install in the plugin's row,
   with the same progress display as the first-use dialog.
3. If the engine install fails or is cancelled, the plugin stays installed. The row names the error in
   plain words and offers **Install engine again** as a full-size button. The engine row never uses a
   text link: **Install engine**, **Cancel install** and **Remove engine** are all ordinary buttons.

The first-use dialog (opened when recognition runs without an engine) remains the fallback path, and
shares the same install: if one is already running it shows that one and continues when it finishes.

## Install progress

The install belongs to `StructureRecognitionController`, which lives as long as the plugin runtime —
not to whichever window started it. Closing and reopening Add or Remove Plugins therefore shows the
same install still running (`getInstallRun()`), never a second Install. If the webview itself lost that
state (a reload), `ocsr_engine_status` still reports `installing` with the host's latest `progress`
event and `installElapsedMs`, and the controller follows it by polling status every 500 ms until the
install ends.

Every phase shows **Step N of 5**, an overall bar, the elapsed time, and for the current step either a
byte bar ("X MB of Y MB") or, when a step reports no bytes, how long it usually takes. The overall bar
weights steps by size: uv ≈ 20 MB, Python ≈ 40 MB, packages ≈ 1.2 GB, model 1.13 GB, verify small
(`structureRecognitionInstallProgress.ts`).

uv prints no byte counts when not attached to a terminal, so the two uv steps are **estimated** in Rust
(`progress.rs`): while `uv python install` runs, the growth of `python/` and the uv cache is measured
every 500 ms against about 75 MB; while `uv pip install` runs, the growth of the uv cache and the venv
against about 1.2 GB. The estimate is monotonic, is capped at 99% while the step runs, and only the
step's successful exit reports 100%; such events carry `estimated: true` and the UI labels them
"(estimated)". The expected totals come from one macOS arm64 install and only drive the bar. Events
reach the webview at most about four times a second (a new phase or a completed byte count always
passes); the status snapshot sees every event.

Code: `apps/desktop/src-tauri/src/ocsr_engine/` — `mod.rs` (commands and state), `install.rs`
(installer), `progress.rs` (install progress estimates), `process.rs` (sidecar lifetime), `protocol.rs` (JSON Lines), `platform.rs` (per-OS seam),
`pins.rs` (every supply-chain pin). Sidecar: `apps/desktop/src-tauri/resources/ocsr/`.

## Installed layout

The engine lives under the platform application-data directory:

```text
ocsr-engine/
  uv | uv.exe                pinned uv, extracted from its verified archive
  python/                    uv-managed Python 3.10 (UV_PYTHON_INSTALL_DIR)
  python-bin/, uv-state/     uv's executable links and state, kept inside the tree
  venv/                      isolated MolScribe environment
  requirements.txt           the hash-locked package set (copied from resources/ocsr/)
  swin_base_char_aux_1m.pth  pinned model
  install.json               receipt: every pin plus install date and size
```

Only three names are ever touched, all siblings in the app-data directory: `ocsr-engine/`,
`ocsr-engine.partial/` (staging) and `ocsr-engine.previous/` (a working install set aside during a
reinstall).

## Install transaction

1. **Check disk.** At least 3.0 GB free on the app-data volume, or `insufficientDisk` before anything
   is created.
2. **Stage.** A stale `ocsr-engine.partial/` is removed and a fresh one created. From here on, any
   failure or cancellation deletes it.
3. **uv.** The platform's uv archive is streamed from the GitHub release, SHA-256 verified, and only
   then opened; only the `uv`/`uv.exe` entry is extracted. A `uv` on `PATH` is never used.
4. **Python.** `uv python install 3.10`, then `uv venv --python 3.10 --python-preference only-managed
   --relocatable`.
5. **Packages.** First the MolScribe source archive (GitHub, at the pinned commit; no Git needed) is
   streamed to the staging tree by Rust with the same client, stall timeout and size cut-off as the
   model, and its byte count and SHA-256 must match the pin — so a tampered archive fails in seconds,
   before PyTorch is downloaded. Then the bundled requirements file is checked against its pinned
   SHA-256 and installed with `uv pip install --require-hashes --requirement requirements.txt`: every
   package, transitive ones included, is an exact `==` pin with its archive hashes, and uv refuses
   anything unpinned, unhashed or mismatched. Last, MolScribe is installed from the verified local
   archive with `--no-deps --no-index --no-build-isolation`: its dependencies are the locked set, nothing
   is fetched, and the sdist builds with the venv's hash-locked setuptools rather than an unverified
   build environment. The archive is deleted afterwards.
6. **Model.** Streamed to disk with throttled progress (about one event per MB); the byte count and
   SHA-256 must both match the pin, and a response that runs past the pinned size is cut off.
7. **Receipt.** The download cache, temporary directory and uv archive are removed, the layout is
   checked, and `install.json` is written with the measured size.
8. **Swap and relocate.** An existing `ocsr-engine/` is renamed to `ocsr-engine.previous/`, and the
   staging tree is renamed to `ocsr-engine/`. uv writes the interpreter's location as an absolute path
   — the venv's `python` link, `pyvenv.cfg`'s `home`, and the managed Python's minor-version link —
   so those paths still point into the staging directory, which no longer exists. The installer
   rewrites every symlink under the tree whose target lies in the staging prefix, and the `home` line,
   onto the final prefix (both the path as given and its canonical spelling).
9. **Prove it.** `python -c "import cv2, molscribe, numpy, torch, torchvision"` runs from the final
   location. This is the only check that the relocation worked, so it runs after the swap, not before.
   If it fails or is cancelled, the new tree is deleted and `ocsr-engine.previous/` is renamed back —
   a failed reinstall never costs the user a working engine. On success the previous tree is removed.

Every child process runs with inherited `UV_*`, `PIP_*`, `PYTHON*`, `VIRTUAL_ENV*` and `CONDA*`
variables removed and `UV_NO_CONFIG=1`, so ambient configuration cannot redirect the reviewed install
to another index, mirror or interpreter. uv's cache, temporary, state and executable-link directories
are all redirected into the staging tree. Cancellation is a flag checked between download chunks and
every 50 ms while a uv child runs (which is then killed). The HTTP client's 60-second timeout applies
to each read, not the whole transfer: a slow link finishes, a dead one fails with `network`.

`ocsr_engine_status` re-reads the receipt on every call. A missing or malformed receipt, a receipt
whose pins differ from this build's, a missing uv/interpreter/model, or a model of the wrong size is
reported as `broken` with a `detail`, never accepted silently. Status checks sizes, not hashes: hashing
1.1 GB on every status call would be too slow, and the hash was verified before the file was kept.

## Pins

All pins live in `src/ocsr_engine/pins.rs`. Changing any of them is a deliberate, reviewed
supply-chain change that must update `resources/ocsr/requirements.txt`, NOTICE, the dependency
inventory, and this document together. Tests assert that the requirements file's SHA-256 is
`REQUIREMENTS_LOCK_SHA256`, that every entry in it is an exact pin followed by hashes, and that it
pins the torch, torchvision and numpy versions in `pins.rs`.

| What | Pin |
| --- | --- |
| uv | 0.12.18, per-platform archive SHA-256 |
| Python | 3.10 (uv-managed) |
| Python packages | `resources/ocsr/requirements.txt`: 109 exact pins with SHA-256 hashes (torch 2.14.0, torchvision 0.29.0, numpy 1.26.4, and the rest of MolScribe's dependency tree); the file itself is pinned by SHA-256 |
| MolScribe | `thomas0809/MolScribe` archive at `7296a30413eb55436702011efdff78131f66d162`, 5,727,892 bytes, SHA-256 `8e323f47…e2d6` |
| Model | `yujieq/MolScribe` revision `a0189776…`, `swin_base_char_aux_1m.pth`, 1,134,940,406 bytes, SHA-256 `6f0df56f…ea1d` |
| Free disk | 3.0 GB |

### The requirements lock

`resources/ocsr/requirements.in` lists what the engine needs — torch, torchvision and numpy at the
reviewed versions, MolScribe's own `install_requires` (read from its `setup.py` at the pinned commit),
and setuptools to build it. `requirements.txt` is generated from it by

```bash
uv pip compile requirements.in --universal --python-version 3.10 --generate-hashes -o requirements.txt
```

`--universal` writes one file for every platform, with environment markers on the packages only some
need (`colorama` on Windows, `uvloop` off Windows, and CUDA packages marked Linux-only, which no
supported target installs). It was first resolved on 2026-09-24 constrained to exactly what a real
macOS arm64 install had produced, so the lock reproduces that install: a fresh venv installed from it
with `--require-hashes`, plus MolScribe from the verified archive, matched the real engine's
`uv pip freeze` package for package and passed the import check. uv keeps the versions already in
`requirements.txt` when it re-locks, so re-running the command changes nothing unless `requirements.in`
changes or `--upgrade` is passed. After any re-lock, update `REQUIREMENTS_LOCK_SHA256` (taken with line
endings normalized to LF, so a CRLF checkout on Windows still matches).

A tarball cannot be hash-locked by URL, which is why MolScribe is not in the lock: Rust verifies the
archive and uv installs the local file with `--no-deps`.

**Intel Macs are not installable at these pins.** PyTorch publishes no macOS x86_64 wheel for 2.14.0
(its last Intel-Mac release was 2.2), so `--require-hashes` finds nothing to install and the packages
step fails with uv's resolution error. This was already true of the earlier `~=2.14.0` constraint; the
lock only makes it explicit. Rather than let an Intel Mac download uv and Python only to fail at the
packages step, `platform::current()` reports `unsupported` up front, before anything downloads (see
[Platform seam](#platform-seam)). Genuinely supporting Intel Macs needs a deliberate decision — pinning
an older torch build for that platform — not a silent fallback.

The receipt records the lock's SHA-256, the exact torch/torchvision/numpy versions and the MolScribe
archive's SHA-256; a receipt from before the lock does not match these pins and reads as `broken`, so
such an install is replaced by a verified one.

## Sidecar protocol (version 2)

`resources/ocsr/molscribe_sidecar.py` is bundled with the app; its heavy imports come from the
user-installed venv. It is started as `venv/bin/python -I molscribe_sidecar.py --checkpoint <model>`
(isolated mode) with `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1`, in the engine directory. Stdin
and stdout carry one JSON object per line; stderr is log only and is copied to the app log. Before
importing anything heavy the sidecar points file descriptor 1 at stderr and keeps a private handle
for protocol output, so a stray `print` from a library cannot corrupt a protocol line.

```json
{"type":"ready","protocol":2,"molscribeVersion":"…","torchVersion":"…"}
{"type":"fatal","code":"model_load_failed","message":"…"}
{"id":"ocsr-1","type":"recognize","imagePath":"/absolute/temporary/image.png"}
{"id":"ocsr-1","type":"result","smiles":"…","molfile":"…","confidence":0.97,"atoms":[{"index":0,"symbol":"C","x":0.41,"y":0.2,"confidence":0.99}],"bonds":[{"begin":0,"end":1,"bondType":"single","confidence":0.98}],"agreement":{"runs":5,"agreeing":5,"invalidRuns":0,"scalesPx":[800,900,1000,1100,1200]},"elapsedMs":9500}
{"id":"ocsr-1","type":"error","code":"invalid_image","message":"…"}
{"type":"shutdown"}
```

The result maps MolScribe's own output keys one-to-one: `atoms[].atom_symbol` → `symbol`, `x`/`y`
(fractions of image width and height), `bonds[].endpoint_atoms` → `begin`/`end`, `bond_type` →
`bondType` (`single`, `double`, `triple`, `aromatic`, `solid wedge`, `dashed wedge`), and each
`confidence` as given. A value MolScribe did not return is `null`; nothing is filled in. An image that
Pillow cannot decode is `invalid_image`. When every run raised, the model's own error is returned as
`recognition_failed`; when runs answered but none of their SMILES parsed, `recognition_failed` carries
the plain message "The engine could not read a valid structure from this image. Try a larger or
sharper image." A malformed request line gets an `error` with `id: null`. `shutdown` or EOF on stdin
exits 0. The host refuses a protocol-1 result (no `agreement`), an unknown `agreement` field, and an
inconsistent one (`agreeing` outside `1..=runs`, `agreeing + invalidRuns > runs`, or `scalesPx` not
one entry per run). `invalidRuns` was added within protocol 2; the host reads a result without it as
reporting none.

### Preprocessing: flatten onto white

Every image, whatever its source, is decoded with Pillow and flattened onto white before
recognition: alpha (RGBA, LA, PA) and palette transparency are composited over white, 16-bit gray is
scaled into 8 bits rather than clipped, EXIF orientation is applied, and the result is RGB. MolScribe
reads files with OpenCV, which drops the alpha channel, so a transparent background became black:
Wikimedia's gray + alpha PNG of brevetoxin A came back as a nonsense molecule at confidence 0.087,
and the same image on white was read correctly. The flattened image is handed to MolScribe's
`predict_image` as an RGB array, so OpenCV never reads the file.

### Multi-scale consensus

MolScribe crops the white border and then squashes every image to 384 × 384 with bilinear
resizing. For a large drawing that shrink skips pixels, so the answer depends on the exact input
size — and the confidence does not reveal it. Brevetoxin A on white, resized to width W: 500 wrong
(0.774), 600 right (0.500), 700 wrong (0.336), 800–1200 right (0.33–0.76), 1400–1920 wrong
(0.60–0.72). Even a one-pixel change matters: 800 × 287 was right (0.762) and 800 × 288 unparsable
(0.39).

A single run is therefore chaotic on a large molecule, and the fix is more votes rather than better
tuned sizes. Each image is recognized at many sizes, rescaled (LANCZOS, aspect kept) so its longer side
is the given size:

1. **First pass:** 800, 900, 1000, 1100 and 1200 px. If at least 4 of these 5 give the same valid
   structure, the vote stops here.
2. **Otherwise:** also 760 to 1240 px in steps of 40 (the grid's other ten sizes; 900 and 1100 are
   not on it), so a full vote is **15 runs**.

A size that would enlarge the image more than 2× is skipped; when any are skipped, the original size
votes as well, and an image too small for every size is recognized once as it is.

The answers are compared by RDKit canonical isomeric SMILES. A run whose SMILES does not parse (for
example a pentavalent carbon) or that raised is **invalid**: it never wins and never agrees with
anything, however confident. The winner is the most frequent valid structure; a tie goes to the one
with the higher mean confidence. The most confident run of the winner is returned. `agreement`
reports `{runs, agreeing, invalidRuns, scalesPx}`: `runs` counts every run, invalid ones included,
and `agreeing` the runs that gave the returned structure. Atom `x`/`y` are fractions of the image, so
they do not depend on the size the returned run used. Each request also writes one
`vote {"image", "runs": [{px, key, confidence}]}` line to the log, which the real-engine check reads.

The review uses it (`apps/desktop/src/plugins/recognitionAgreement.ts`): the plugin picks a tier from
the confidence, and the host caps it by how many of **all** runs agreed:

| Runs agreeing | Review tier | Warning |
| --- | --- | --- |
| all (unanimous) | the plugin's tier | none |
| at least two thirds | at most **medium** | yes |
| fewer | **low** | yes |

The warning reads "Recognition gave different answers at different image sizes; check the structure
carefully. Only *k* of *n* readings agreed." The cap is applied where the host builds every review
item (`proposalReviewItem`), keyed by the molfile the host produced, so it holds even if a plugin
drops the warning. A high tier is never shown for a non-unanimous result; an early stop at 4 of 5 is
therefore at most medium.

Measured with the installed engine on brevetoxin A (`pnpm test:ocsr-real`, 2026-09-24; Y the right
structure, x unparsable, - not run):

| Case | 800 900 1000 1100 1200 (first pass) | Result |
| --- | --- | --- |
| 1920 px file, transparent | x Y Y Y Y — stopped | right, 4/5, at most medium |
| Retina screenshot, long side 1400 | Y Y Y Y Y — stopped | right, 5/5, plugin's tier |
| 1x screenshot, long side 700 + 20 px margin | x x x x x — all 15 run | right, 1/15 (14 unparsable), low |

The 1x case is a resolution limit, not a pipeline one: recognizing directly at 740 or 900 px from the
full-resolution source was right.

### Checks

`python3 apps/desktop/src-tauri/resources/ocsr/molscribe_sidecar.py --selftest` runs without torch,
MolScribe or a model (Pillow is required): flattening of gray + alpha, RGBA, palette transparency,
opaque and 16-bit images; an undecodable file; the choice of sizes, including small images; the vote
(unanimous, majority beating a more confident outlier, plurality, ties by mean confidence, invalid
runs never winning); and the whole request loop with a stubbed model — the adaptive stop after 4 of 5,
a full 15-run vote, 11 confident unparsable runs losing to 3 valid ones, every run unparsable
(`recognition_failed` with the plain message), a model exception at every size, result mapping with
`agreement`, missing confidences, a malformed line, a bad path, an undecodable image, and nothing
answered after shutdown. Where RDKit is importable (the engine venv) it also checks the canonical-SMILES key.

`pnpm test:ocsr-real` is the opt-in accuracy check against a real installed engine and the fixtures
in `packages/fixtures/ocsr/` (see its README). It is not part of `pnpm test`.

## Process lifetime

- **Lazy.** The sidecar starts on the first recognition, not at app start, and is reused afterwards.
- **One request at a time.** A second request while one is running is **rejected** with `busy`
  immediately; there is no queue.
- **Timeout.** 300 s per request, measured from the command. It must cover the first request's model
  load plus a full 15-run vote. Measured 2026-09-24 on an M1 Pro while the machine was heavily loaded
  (load average 30–90): 2.1–2.3 s per recognition of brevetoxin A, a 2.6–7.6 s model load, 9.3 s for
  a vote that stopped after 5 runs and 26–33 s for a full 15-run vote. 300 s is about 8× the slowest
  full vote measured, for slower CPUs and a cold first load. On timeout the process is killed; the
  timeout is not retried, and the next request starts a fresh process.
- **Crash.** If the process has died (while idle or mid-request) or writes a malformed line, it is
  discarded and the request is retried once against a fresh process. A second failure is reported as
  `engineCrashed`.
- **Idle and exit.** A reaper thread stops the sidecar after 10 idle minutes. It is also stopped at app
  exit, before an install (which may replace its files), and before an uninstall.

Image bytes cross IPC as base64, are capped at 25 MB decoded, and are decoded in Rust first, so a
corrupt or mislabelled image fails as `invalidImage` before the engine starts. The format is taken
from the bytes, not the declared media type. PNG, JPEG, BMP and TIFF are passed through unchanged;
GIF is re-encoded as PNG in Rust (it once had to be, for OpenCV; the sidecar now decodes with Pillow).
WebP is the one format not decoded in Rust — the app's `image` crate is built without a WebP decoder —
so it passes through by its signature and Pillow decodes it in the sidecar, which reports
`invalid_image` if it cannot (the sidecar self-test round-trips a transparent WebP). The bytes go to
a uniquely named file in the app temp directory, which an RAII guard deletes on every path.

The engine accepts exactly the media types a host hands a plugin — PNG, JPEG, TIFF and WebP
(`PluginImageMediaTypes` in `packages/plugin-api`, `SUPPORTED_MEDIA_TYPES` in `mod.rs`). A Rust test
reads the TypeScript list and fails if the two differ, so an image the host accepts is never refused
by the engine.

## Tauri commands

Registered in `lib.rs`; granted only to the `main` window by `capabilities/ocsr-engine.json` (a test
asserts that). No other window, plugin panel or webview HTTP scope gains access, and the webview makes
no network requests for the engine: Rust downloads uv and the model, and the pinned uv fetches the
Python and packages.

| Command | Arguments | Returns |
| --- | --- | --- |
| `ocsr_engine_status` | — | `{state, installed?, requiredDiskBytes, freeDiskBytes, detail?, progress?, installElapsedMs?}`; `state` is `notInstalled`, `installing`, `installed`, `broken` or `unsupported`; `installed` is `{uvVersion, pythonVersion, molscribeCommit, modelSha256, installedAt, diskBytes}`; `progress` (the latest `InstallProgress`) and `installElapsedMs` are present only while `installing` |
| `ocsr_engine_install` | `onProgress: Channel<InstallProgress>` | status, or `Err({code, message})` with `insufficientDisk`, `network`, `checksumMismatch`, `cancelled`, `unsupported` or `failed`. One install at a time; a second call fails with `failed`. |
| `ocsr_engine_cancel_install` | — | `()` |
| `ocsr_engine_uninstall` | — | status. Cancels a running install and waits for it, stops the sidecar, then removes the three `ocsr-engine*` directories. |
| `ocsr_recognize_image` | `{mediaType, bytesBase64}` | `{status: "recognized", smiles, molfile, confidence, atoms, bonds, agreement: {runs, agreeing, invalidRuns, scalesPx}, elapsedMs, engine: {name: "MolScribe", molscribeCommit, modelSha256}}`, `{status: "notInstalled"}` (also while installing or on an unsupported platform), or `{status: "failed", code, message}` with `invalidImage`, `recognitionFailed`, `engineCrashed` (including a `broken` install), `timeout` or `busy` |

`InstallProgress` is `{phase, message, bytesDone?, bytesTotal?, estimated?}` with `phase` one of
`checkingDisk`, `downloadingUv`, `installingPython`, `installingPackages`, `downloadingModel`,
`verifying`, `done`. `estimated: true` marks byte counts derived from directory growth (see Install
progress); it is omitted otherwise.

## Platform seam

`EnginePlatform` (`platform.rs`) owns everything that differs by OS: the uv asset and checksum, the uv
and venv interpreter paths, and child-process flags. `platform::current()` picks one with `#[cfg]`;
nothing else in the installer or process manager branches on the OS. Free-disk queries are the one
other per-OS function (`statvfs` on Unix, `GetDiskFreeSpaceExW` on Windows).

| Target | uv asset | venv Python | Child processes | Status |
| --- | --- | --- | --- | --- |
| macOS arm64 | `uv-aarch64-apple-darwin.tar.gz` | `venv/bin/python` | default | implemented |
| macOS x86_64 | `uv-x86_64-apple-darwin.tar.gz` | `venv/bin/python` | default | seam implemented, disabled: `unsupported` status ("The recognition engine needs a Mac with Apple silicon."), install fails with `unsupported` before anything downloads — the hash-locked pins have no torch wheel for this target (see above) |
| Windows x86_64 | `uv-x86_64-pc-windows-msvc.zip` | `venv/Scripts/python.exe` | `CREATE_NO_WINDOW` | implemented, never run |
| anything else | — | — | — | `unsupported` status; install fails with `unsupported` before creating anything |

## Adding Windows

The Windows implementation compiles in the seam but has never been built or run on Windows, and CI
runs Rust checks only on macOS. Before calling it release-ready:

- Build and run `cargo clippy --all-targets -- -D warnings` and `cargo test` on Windows.
- Run a real clean install and uninstall, including cancellation during each external step.
- **Relocation is the open question.** On Windows, uv links the managed Python's minor-version
  directory with a junction, and the venv's `python.exe` is a launcher that reads `pyvenv.cfg`. The
  `pyvenv.cfg` rewrite should be enough for the venv, but `std` cannot create junctions, and recreating
  a link with `symlink_dir` needs Developer Mode or elevation, so a junction pointing into the staging
  directory may fail to relocate. If it does, the post-swap import check fails and the install rolls
  back cleanly rather than leaving a broken engine. The likely fixes are to create the junction through
  the Win32 API, or to install with `UV_PYTHON_INSTALL_DIR` outside the renamed tree.
- Check torch wheel resolution for Python 3.10 on Windows, and paths with spaces and non-ASCII
  characters (the sidecar's image path must be valid Unicode).
- A new architecture (e.g. Windows arm64) needs an upstream uv asset and a reviewed checksum in
  `pins.rs` and a new `EnginePlatform` implementation. Never fall back to a system uv or Python.
