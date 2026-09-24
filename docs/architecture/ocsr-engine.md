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

Code: `apps/desktop/src-tauri/src/ocsr_engine/` — `mod.rs` (commands and state), `install.rs`
(installer), `process.rs` (sidecar lifetime), `protocol.rs` (JSON Lines), `platform.rs` (per-OS seam),
`pins.rs` (every supply-chain pin). Sidecar: `apps/desktop/src-tauri/resources/ocsr/`.

## Installed layout

The engine lives under the platform application-data directory:

```text
ocsr-engine/
  uv | uv.exe                pinned uv, extracted from its verified archive
  python/                    uv-managed Python 3.10 (UV_PYTHON_INSTALL_DIR)
  python-bin/, uv-state/     uv's executable links and state, kept inside the tree
  venv/                      isolated MolScribe environment
  requirements.txt           reviewed package constraints (copied from resources/ocsr/)
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
5. **Packages.** `uv pip install --requirement requirements.txt` into the venv: torch, torchvision and
   numpy under `~=` constraints, and MolScribe from the GitHub archive tarball at the pinned commit (no
   Git needed).
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
inventory, and this document together; a test asserts the requirements file and `pins.rs` agree.

| What | Pin |
| --- | --- |
| uv | 0.12.18, per-platform archive SHA-256 |
| Python | 3.10 (uv-managed) |
| torch / torchvision / numpy | `~=2.14.0` / `~=0.29.0` / `~=1.26.4` |
| MolScribe | `thomas0809/MolScribe` archive at `7296a30413eb55436702011efdff78131f66d162` |
| Model | `yujieq/MolScribe` revision `a0189776…`, `swin_base_char_aux_1m.pth`, 1,134,940,406 bytes, SHA-256 `6f0df56f…ea1d` |
| Free disk | 3.0 GB |

The Python packages resolved by uv are constrained, not hashed: torch's transitive set is platform
specific, so a fully hashed lock per platform is a possible later hardening. The receipt records the
constraints that were in force.

## Sidecar protocol (version 1)

`resources/ocsr/molscribe_sidecar.py` is bundled with the app; its heavy imports come from the
user-installed venv. It is started as `venv/bin/python -I molscribe_sidecar.py --checkpoint <model>`
(isolated mode) with `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1`, in the engine directory. Stdin
and stdout carry one JSON object per line; stderr is log only and is copied to the app log. Before
importing anything heavy the sidecar points file descriptor 1 at stderr and keeps a private handle
for protocol output, so a stray `print` from a library cannot corrupt a protocol line.

```json
{"type":"ready","protocol":1,"molscribeVersion":"…","torchVersion":"…"}
{"type":"fatal","code":"model_load_failed","message":"…"}
{"id":"ocsr-1","type":"recognize","imagePath":"/absolute/temporary/image.png"}
{"id":"ocsr-1","type":"result","smiles":"…","molfile":"…","confidence":0.97,"atoms":[{"index":0,"symbol":"C","x":0.41,"y":0.2,"confidence":0.99}],"bonds":[{"begin":0,"end":1,"bondType":"single","confidence":0.98}],"elapsedMs":812}
{"id":"ocsr-1","type":"error","code":"invalid_image","message":"…"}
{"type":"shutdown"}
```

The result maps MolScribe's own output keys one-to-one: `atoms[].atom_symbol` → `symbol`, `x`/`y`
(fractions of image width and height), `bonds[].endpoint_atoms` → `begin`/`end`, `bond_type` →
`bondType` (`single`, `double`, `triple`, `aromatic`, `solid wedge`, `dashed wedge`), and each
`confidence` as given. A value MolScribe did not return is `null`; nothing is filled in. An image that
OpenCV cannot read is `invalid_image`; any exception from the model is `recognition_failed`; a
malformed request line gets an `error` with `id: null`. `shutdown` or EOF on stdin exits 0.

`python3 apps/desktop/src-tauri/resources/ocsr/molscribe_sidecar.py --selftest` runs the whole
request loop against a fake model — result mapping, missing confidences, a malformed line, a bad
path, a model exception, and nothing answered after shutdown — without torch or MolScribe.

## Process lifetime

- **Lazy.** The sidecar starts on the first recognition, not at app start, and is reused afterwards.
- **One request at a time.** A second request while one is running is **rejected** with `busy`
  immediately; there is no queue.
- **Timeout.** 120 s per request, measured from the command, so the first request's model load
  (about 15 s) comes out of the same budget. On timeout the process is killed; the timeout is
  not retried, and the next request starts a fresh process.
- **Crash.** If the process has died (while idle or mid-request) or writes a malformed line, it is
  discarded and the request is retried once against a fresh process. A second failure is reported as
  `engineCrashed`.
- **Idle and exit.** A reaper thread stops the sidecar after 10 idle minutes. It is also stopped at app
  exit, before an install (which may replace its files), and before an uninstall.

Image bytes cross IPC as base64, are capped at 25 MB decoded, and are decoded in Rust first, so a
corrupt or mislabelled image fails as `invalidImage` before the engine starts. The format is taken
from the bytes, not the declared media type. PNG, JPEG, BMP and TIFF are passed through unchanged;
GIF is re-encoded as PNG because OpenCV, which MolScribe reads with, cannot open GIF. The bytes go to
a uniquely named file in the app temp directory, which an RAII guard deletes on every path.

## Tauri commands

Registered in `lib.rs`; granted only to the `main` window by `capabilities/ocsr-engine.json` (a test
asserts that). No other window, plugin panel or webview HTTP scope gains access, and the webview makes
no network requests for the engine: Rust downloads uv and the model, and the pinned uv fetches the
Python and packages.

| Command | Arguments | Returns |
| --- | --- | --- |
| `ocsr_engine_status` | — | `{state, installed?, requiredDiskBytes, freeDiskBytes, detail?}`; `state` is `notInstalled`, `installing`, `installed`, `broken` or `unsupported`; `installed` is `{uvVersion, pythonVersion, molscribeCommit, modelSha256, installedAt, diskBytes}` |
| `ocsr_engine_install` | `onProgress: Channel<InstallProgress>` | status, or `Err({code, message})` with `insufficientDisk`, `network`, `checksumMismatch`, `cancelled`, `unsupported` or `failed`. One install at a time; a second call fails with `failed`. |
| `ocsr_engine_cancel_install` | — | `()` |
| `ocsr_engine_uninstall` | — | status. Cancels a running install and waits for it, stops the sidecar, then removes the three `ocsr-engine*` directories. |
| `ocsr_recognize_image` | `{mediaType, bytesBase64}` | `{status: "recognized", smiles, molfile, confidence, atoms, bonds, elapsedMs, engine: {name: "MolScribe", molscribeCommit, modelSha256}}`, `{status: "notInstalled"}` (also while installing or on an unsupported platform), or `{status: "failed", code, message}` with `invalidImage`, `recognitionFailed`, `engineCrashed` (including a `broken` install), `timeout` or `busy` |

`InstallProgress` is `{phase, message, bytesDone?, bytesTotal?}` with `phase` one of `checkingDisk`,
`downloadingUv`, `installingPython`, `installingPackages`, `downloadingModel`, `verifying`, `done`.

## Platform seam

`EnginePlatform` (`platform.rs`) owns everything that differs by OS: the uv asset and checksum, the uv
and venv interpreter paths, and child-process flags. `platform::current()` picks one with `#[cfg]`;
nothing else in the installer or process manager branches on the OS. Free-disk queries are the one
other per-OS function (`statvfs` on Unix, `GetDiskFreeSpaceExW` on Windows).

| Target | uv asset | venv Python | Child processes | Status |
| --- | --- | --- | --- | --- |
| macOS arm64 | `uv-aarch64-apple-darwin.tar.gz` | `venv/bin/python` | default | implemented |
| macOS x86_64 | `uv-x86_64-apple-darwin.tar.gz` | `venv/bin/python` | default | implemented |
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
