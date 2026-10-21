# Local naming engine (Orthonym)

The optional engine is installed only after explicit user action. `src/naming_engine/` is a second
adapter on `src/local_engine/`: downloads, hash checking, staging, whole-tree swap and rollback,
relocation, cancellation, process-tree termination and sidecar lifetime have one implementation.
Neither the engine nor its Python is loaded at app startup. No webview receives network access.

## Layout and installation

Under Tauri's app-data directory (separate for stable and worktree builds):

```text
naming-engine/
  uv[.exe]
  python/                       uv-managed Python 3.12
  venv/                         relocatable environment
  requirements.txt              reviewed hash lock
  jars/centres-cli-1.2.1.jar     unmodified pinned download
  LICENSES/                     Orthonym LICENSE/NOTICE plus bundled jar licence texts
  cache/                        local Orthonym cache (created when needed)
  install.json                  receipt v1, written last
naming-engine.partial/          staging, swept after interrupted installs
naming-engine.previous/         previous complete installation, restored on failure
naming-engine.discard-*/        interrupted deletions, swept at startup
```

`local_engine::install::install::<NamingSpec>` downloads the shared pinned uv, installs managed
Python, creates a relocatable venv, then runs `uv pip install --python <venv-python>
--require-hashes --compile-bytecode --requirement <lock>`. It downloads and verifies centres,
copies Orthonym's LICENSE and NOTICE from installed dist-info and the bundled
`resources/naming/licenses/*` into `LICENSES/`, swaps, relocates and probes in the final location.
The probe runs `python -I -B -c`, imports orthonym, rdkit and jpype, prints Orthonym's version and
requires exactly `1.0.8`. Failure rolls back the whole tree. Download caches are removed.

The receipt records `receiptVersion: 1`, engine directory name, uv asset/version/hash, Python
version, Orthonym version/commit/wheel hash, requirements hash, centres URL/size/hash, installed-at
timestamp and disk bytes. An unreadable, malformed, mismatched or newer receipt reports `broken`
with a detail string. No receipt upgrade from another engine is attempted.

## Pins and platform support

| Input | Pin |
| --- | --- |
| uv | Shared `local_engine/pins.rs`, 0.12.18 with per-platform archive hashes |
| Python | 3.12 |
| Orthonym | 1.0.8, provenance commit `461987b947f76e41ff0baa6c2aa19ecd79cacd0b` |
| Orthonym wheel SHA-256 | `ffd4f69d95349887c3fd762197464dadff81a1cf494fe42f6a2bcd7d6674393d` |
| Requirements SHA-256 (LF) | `ec5021b4365d77936c99ae71f3057a41c946149e67d8342de24c867edd6d9a2a` |
| centres | `https://github.com/SiMolecule/centres/releases/download/1.2.1/centres.jar` |
| centres size / SHA-256 | 2,291,742 bytes / `6c5d5cafa9393ed7b667a2340222348cd15a9bbdd0d1b92518229f26cc5e87fb` |
| Free-space requirement | 1,000,000,000 bytes (800 MB update peak plus 25% margin) |

The lock includes rdkit 2026.3.5, jpype1 1.7.1, lxml 6.1.3, numpy 2.5.4, pillow 13.0.0 and
packaging 26.3. macOS Apple silicon and Windows x64 are implemented. Intel Mac is `unsupported`
before any download: RDKit 2026.3.5 has no macOS x86_64 Python 3.12 wheel. Other targets are unsupported.

## Disk and download sizes

A fresh install of this exact requirements lock was measured on **2026-10-21, macOS arm64**.
Disk use was measured with one-second `du` sampling of the app-data directory during installation,
then a breakdown of the completed engine. Sizes below are approximate MB; rounding and wheel
variants mean the component totals need not add up exactly.

| Measurement | Size |
| --- | --- |
| Total download | About 100 MB |
| Wheels | About 56 MB: rdkit 29.9, numpy 12.0, pillow 4.9, lxml about 4.6–8.6, Orthonym 4.1, jpype 0.4, packaging 0.1 |
| uv archive / Python 3.12 / centres | About 20 MB / 20 MB / 2.3 MB |
| Fresh-install peak | 490 MB of staging, including the 179 MB download cache |
| Final engine | 310 MB: venv 205, Python 67, uv 35, jars 2.2 |
| Update peak | About 800 MB: the 490 MB install peak plus the previous 310 MB engine |

An update retains the previous copy until the replacement passes its post-swap check.
`REQUIRED_DISK_BYTES` therefore stays at 1,000,000,000 bytes: the approximately 800 MB worst-case
peak plus a 25% margin.

A **Windows 11 x64** run on the same date, launched from Explorer as a normal user with fresh app
data, measured about **296 MB peak disk use** for staging and cache together. The uv cache is on
the same volume as the staged engine, so files are hardlinked and the peak is barely above the
final engine. The final `naming-engine` contains about **265 MB of files**; its `install.json`
records `diskBytes: 277380320` (277,380,320 bytes). Download size was not separately measured.
These Windows measurements do not replace the larger macOS requirement above.

## Transient Windows file locks

That Windows run failed three times, then passed three times. Failures occurred during step 3,
“Installing Orthonym dependencies”, about 20–35 seconds in, after uv's bytecode-compilation Python
processes had run. The error was `Access is denied. (os error 5)`; no other application was known
to be reading the directory. A short-lived Defender or search-indexer lock on newly written files
is suspected, not confirmed.

The shared `local_engine/file_ops.rs` helper labels installer IO failures with the operation and
path (both paths for renames), retains the adapter's error prefix, and logs details to stderr with
the engine's log prefix. On Windows only, raw OS errors **5, 32 and 33** (access denied, sharing
violation, lock violation) get at most six retries after **50, 100, 200, 400, 800 and 1600 ms**,
about **3.15 seconds** total backoff per operation. Other errors fail immediately. Cancellation is
checked between attempts and during the waits; cleanup and rollback still get their first attempt
after cancellation. Retries run only after installer-owned children have been reaped; a failed
wait suppresses retries, and child commands themselves are never retried by this helper. The policy covers staging, extraction,
owned file writes, receipts, relocation, launcher-rewrite cleanup, swap/rollback, and stale-tree
removal. macOS keeps a single attempt.

## Spawn environment and integrity

The shared process manager starts `<venv-python> -I -B <bundled>/naming/orthonym_sidecar.py` with
the engine directory as cwd. It rechecks the centres jar's size and SHA-256 before **every** spawn,
including a crash retry, and refuses a mismatch. OPSIN's bundled jar is covered by the existing
`opsin::tests::jar_bytes_match_the_hash_recorded_in_build_md` check and the app signature.

| Variable | Value |
| --- | --- |
| `JAVA_HOME` | Bundled `resources/opsin/jre` |
| `PATH` | `<jre>/bin`, then only system directories (never the inherited PATH) |
| `ORTHONYM_OPSIN_JAR` | Bundled `resources/opsin/opsin-cli-2.9.0.jar` |
| `ORTHONYM_CENTRES_JAR` | `<engine>/jars/centres-cli-1.2.1.jar` |
| `ORTHONYM_NO_DOWNLOAD` | `1` |
| `ORTHONYM_CACHE_DIR` | `<engine>/cache` |

All inherited `ORTHONYM_*` settings are removed before the above values are set. This excludes
`ORTHONYM_ALLOW_REDUCED` and `ORTHONYM_DISABLE_JPYPE`. `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`,
`JDK_JAVA_OPTIONS`, `CLASSPATH`, and all keys beginning `UV_`, `PIP_`, `PYTHON`, `VIRTUAL_ENV` or
`CONDA` are removed. Windows names are scrubbed irrespective of case. Java resources use ordinary
Windows drive paths rather than `\\?\` drive prefixes, which JVM paths cannot reliably accept.
Fallback bare `java` resolves to the bundled runtime. No system Python, uv or Java is selected.

## Protocol and process limits

Protocol `NAMING_PROTOCOL_VERSION = 1` is JSON Lines, with stdout reserved for messages and stderr
for logs. The Python sidecar redirects fd 1 before imports. The host parses typed messages with
unknown fields refused:

```json
{"type":"ready","protocol":1,"orthonymVersion":"1.0.8","rdkitVersion":"2026.03.5","jvm":"jpype"}
{"type":"fatal","code":"jvm_unavailable","message":"…"}
{"id":"n-1","type":"name","smiles":"CCO"}
{"id":"n-1","type":"result","name":"ethanol","tier":"pin_verified","isPin":true,"opsin":"verified","gateOutcome":"self_consistency_verified","limitCode":null,"stereoUnexpressed":false,"source":"pin_path","elapsedMs":25}
{"id":"n-1","type":"error","code":"invalid_smiles","message":"…"}
{"type":"shutdown"}
```

Ready requires protocol 1, Orthonym exactly 1.0.8 and JPype; `selftest-stub` is refused. Every fatal,
unexpected message or mismatched request id fails closed. Fatal codes include `jvm_unavailable`,
`jar_missing` and `reduced_mode`; request errors include `invalid_smiles` and `namer_raised`.

Startup has 60 seconds, separately from the 30 second request budget. Requests share their budget
across one crash retry; replacement startup does not consume it. Timeouts and user cancellations
are never retried. A second crash reports `engineCrashed`. Only one request (including OPSIN
read-back) runs at a time; another gets `busy`. Idle sidecars are reaped after 10 minutes.
The sidecar stops at app exit (including Windows forced exit), before install and before uninstall.
Cancel uses the shared kill switch plus a cancel counter to cover a cancel racing request startup.
The counter also cancels the host OPSIN read-back, which polls for stops every 20 ms and kills
and reaps its child process tree before releasing the request gate. Install and uninstall mark
the request stopped, stop the sidecar, and acquire that same gate before changing engine files;
a request overlapping either operation fails rather than returning a raw result. A final stop
check under the gate covers a stop racing the last read, including a result with no name.
Shared platform flags use process groups on Unix and `CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP`
on Windows; termination uses the shared tree-kill implementation (currently `taskkill /T /F` on
Windows, with the limitations documented in [OCSR engine](ocsr-engine.md)).

## Commands and raw result contract

All six commands are registered in `lib.rs`, named in `build.rs`, and granted exclusively to the
`main` document window by `capabilities/naming-engine.json`.

| Command | Result |
| --- | --- |
| `naming_engine_status` | `{state, installed?, requiredDiskBytes, freeDiskBytes, detail?, progress?, installElapsedMs?}`; state is `notInstalled`, `installing`, `installed`, `broken` or `unsupported` |
| `naming_engine_install` (`onProgress` channel) | status; rejection `{code, message}` using shared install codes |
| `naming_engine_cancel_install` | immediately cancels install and kills the active install child tree |
| `naming_engine_uninstall` | status; rejection `{code, message}`; cancels/waits for install, stops sidecar, removes engine trees |
| `name_structure_raw` (`{smiles}`) | raw fields below; rejection `{code, message}` |
| `naming_cancel` | cancels the active request including OPSIN read-back; acknowledges only after the request gate is released; leaves an idle sidecar running |

`name_structure_raw` rejects empty, padded, control-character or over-5000-character SMILES before
spawning. Its success value has the sidecar's `name`, `tier`, `isPin`, `opsin`, `gateOutcome`,
`limitCode`, `stereoUnexpressed`, `source` and `elapsedMs` fields at the top level, matching
`OrthonymRawResult`. `opsinReadBack` is null if there is no non-empty name, otherwise
`{smiles: string|null, failureReason: string|null}`. The read-back uses the internal
`opsin::convert_with_options_cancellable(..., OpsinOptions { radicals: true }, ...)`; a read failure returns its
reason beside the unchanged raw result. Nothing in Rust applies acceptance policy or canonicalizes.
Cancellation or an engine stop returns an error instead of a raw result with a read-back failure.
The controller waits for the native cancel acknowledgement before reporting `cancelled` and
clearing its active request. Calls during that wait remain `busy`; a retry after `cancelled`
cannot race the old native read-back. If cancellation IPC fails, it waits for the original request
to settle before releasing controller state. Late results from a cancelled call are discarded.
Known limitation: a cancel in the sub-millisecond window after the request is sent but before native
registration can let that request finish and make an immediate retry report `busy` (pre-existing
ordering window; `StructureNamingController.ts` ~173–175, `naming_engine/mod.rs` ~470–472).
The TypeScript host must compare exact canonical isomeric SMILES through RDKit WASM, especially for
glycine zwitterion, which Orthonym can name as neutral glycine. The independent read-back still
shares OPSIN 2.9.0 with Orthonym and cannot catch a name both engines misread identically.

Naming error codes: `notInstalled`, `invalidSmiles`, `namingFailed`, `engineCrashed`, `timeout`,
`busy`, `cancelled`. Shared install codes: `insufficientDisk`, `network`, `checksumMismatch`,
`cancelled`, `unsupported`, `failed`. A stop initiated by app exit/install/uninstall is
`engineCrashed`, not a user cancellation.

## Shared hooks added for this adapter

- `EngineSpec::pip_install_args()` defaults to empty; existing install argv is unchanged.
- `SidecarProtocol::START_TIMEOUT` defaults to `None`, preserving the existing shared deadline
  for startup plus request. Naming selects 60 seconds separately from its 30 second request budget.
- Existing streaming `pins::sha256_reader` / `verify_reader` helpers are available in production,
  allowing the adapter to reverify centres without a second hash implementation.

Existing MolScribe source, tests, install arguments and effective deadlines are unchanged.

## Unverified on Windows

These checks from the feature design must be run on Windows before release:

- The refactored MolScribe install, cancel and uninstall after T1 (its Windows path was documented
  as "implemented, never run").
- The naming engine's relocation of uv's junction and `pyvenv.cfg` after the swap.
- `taskkill /T /F` tree kill of `python.exe` and its in-process JVM, and the host OPSIN
  `java.exe` read-back, on cancel and quit, with no surviving child; retry immediately after
  cancellation and install/uninstall during read-back must also pass on Windows.
- JPype loading `jre\bin\server\jvm.dll` from `%LOCALAPPDATA%\ChemDraft\…`, including a user profile
  path with non-ASCII characters: JPype's classpath goes through JNI, not the ANSI launcher that
  `opsin.rs` works around.
- Whether the bare-`java` fallback finds `jre\bin\java.exe` from the scrubbed `PATH`.
- `CREATE_NO_WINDOW`, so no console flashes for the sidecar or OPSIN.
- The rdkit/lxml/pillow `win_amd64` cp312 wheels resolving under `--require-hashes`.
- Windows download size (not separately measured in the run above), plus repeat disk measurements
  for update peaks and progress weights.
- Repeated fresh installs with the transient-lock retry policy, cancellation during backoff, and
  contextual operation/path diagnostics if a file remains locked beyond the retry budget.
- Copy in the WebView2 panel window, and the dialog's ownership and focus (AGENTS.md §1).
- The catalog URL capability on `http://tauri.localhost`.

Windows clippy/tests, validation of the retry policy, and real cancel, uninstall and naming still
require a Windows host. The install measurements above predate the retry fix.
The ignored Rust real-engine test takes `CHEMDRAFT_NAMING_ENGINE_DIR` and checks ethanol, raw glycine
zwitterion with OPSIN read-back, and `[Fe]` abstention. Unit tests require no installed engine.
