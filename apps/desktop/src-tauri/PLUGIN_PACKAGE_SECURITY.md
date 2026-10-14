# Local plugin package handle validation

`read_plugin_package` opens the archive with final-component no-follow protection, checks the
handle's metadata for a regular file, and resolves that handle's final path. macOS uses
`libc::fcntl(F_GETPATH)`; Windows uses `windows_sys::GetFinalPathNameByHandleW` with normalized
DOS paths. The native dialog's `fs_scope().is_allowed` checks that final path before any archive
bytes are read. Swapping an ancestor before open therefore requires authorization for the actual
opened destination (P1); swapping it afterwards cannot redirect the already-open archive handle.

The checksum name is the final ZIP basename plus `.sha256`, so Windows 8.3 aliases cannot suppress
the real long-name sibling (P2). Its handle gets the same no-follow and regular-file checks. Its
final parent and filename must match the expected sibling separately, using Windows ordinal
case-insensitive comparison or exact macOS filesystem-returned names. A redirected checksum is
refused before reading. Only `NotFound` from opening the sibling is optional; other errors fail
closed. Both byte streams are read from the validated handles. Scope grants, IPC framing, size
caps, digest validation, and the main-window restriction are retained.

No crate was added. The existing `windows-sys` dependency enables `Win32_Globalization` for
`CompareStringOrdinal`. Other non-shipping targets retain a path-based fallback; Linux CI runs
web checks, not the native Rust build. The build stamp is unchanged as requested.

## Verification

- macOS: all 14 `plugin_package` Rust tests pass, including a deterministic parent replacement
  immediately before archive open, replacement after authorization proving reads use the opened
  handle, replacement before sibling open, and a case-variant basename checking the real sibling.
- Plugin Vitest: 47 files pass, 558 tests pass, one pre-existing test is skipped.
- macOS: repository Cargo fmt and full `cargo clippy --all-targets -- -D warnings` pass.
- Windows: the actual platform helpers and test bodies pass an isolated cross-target clippy check
  with `-D warnings`. This checks compilation and linting, not native filesystem behavior or the
  full Tauri application. A Windows host must run the checks below.

The macOS sandbox used a temporary `Sparkle.framework` symlink, `DYLD_FRAMEWORK_PATH` pointing
to this worktree's `src-tauri`, and a test-only `TAURI_CONFIG` pointing `build.frontendDist` at
the existing checkout's web build and clearing `bundle.resources`, `bundle.externalBin`, and
`bundle.macOS.frameworks`. The temporary Sparkle symlink was removed after checks. The initial
unfiltered Cargo invocation exceeded available disk space while producing the static library;
`cargo test --locked --lib --manifest-path apps/desktop/src-tauri/Cargo.toml plugin_package -- --nocapture`
passes without that unrelated archive. No GUI launch was performed.

## Windows hands-on follow-up

1. Run `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check`,
   `cargo clippy --all-targets --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings`,
   and `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml plugin_package -- --nocapture`.
   The parent-swap test creates a real junction with `cmd /C mklink /J`, requiring no symlink privilege.
2. On a volume that generates 8.3 names, create `LongPluginName.zip` and an invalid
   `LongPluginName.zip.sha256`. Use `cmd /C dir /X` to find the short ZIP name. Grant the long ZIP
   through the main window's native dialog, then call `read_plugin_package` from that window with
   the short path. Expect a checksum error, never an unchecked success. Replace the real checksum
   with a valid digest naming `LongPluginName.zip`; expect a verified result. The automated 8.3
   test prints an explicit skip when the volume does not generate a different short basename.
3. Grant `picked\plugin.zip`, with a different `unpicked\plugin.zip` beside it. Pause just before
   the archive OS open, rename `picked` to `original`, and create `picked` as a junction targeting
   `unpicked` (`cmd /C mklink /J picked unpicked`). Resume: expect the opened-path dialog-scope
   refusal and no returned archive bytes. The automated parent-swap test reproduces this boundary.
4. With no checksum, confirm the binary response has a zero checksum length. With a checksum
   directory, reparse point, unreadable file, oversized file, invalid UTF-8, bad digest, or wrong
   named ZIP, confirm refusal. Repeat with a Unicode path and a path exceeding 512 UTF-16 units
   to exercise Windows casing and final-path buffer growth.
