# Sidecar Bundle Placeholders

Tauri requires `bundle.externalBin` entries to have target-triple-suffixed files
at build time. These placeholders keep the desktop shell buildable while the real
`native/avogadro3d-sidecar` binaries are produced by the native build pipeline.

Real binaries: `aarch64-apple-darwin` and `x86_64-pc-windows-msvc` (built with
`cmake --preset windows-msvc && cmake --build --preset windows-msvc` — static CRT,
depends only on KERNEL32.dll). The others are still placeholders. Every placeholder
carries the text `avogadro3d-sidecar placeholder`, which the app looks for (and on
Windows it also requires a PE image), so a placeholder reports the sidecar
unavailable rather than failing to start it. Keep that text in any new placeholder.

macOS sidecar builds must target macOS 11.0, the app's declared minimum. Check
`otool -l apps/desktop/src-tauri/binaries/avogadro3d-sidecar-aarch64-apple-darwin`:
the `LC_BUILD_VERSION` minos (or `LC_VERSION_MIN_MACOSX` version) must be no
greater than 11.0.

The runtime bridge does not execute arbitrary renderer-provided paths. During
development, set `CHEMDRAFT_ENGINE3D_SIDECAR` to a built sidecar executable.
Release packaging should replace the placeholder matching the target triple with
the real native binary.

## Intel macOS staging

The `x86_64-apple-darwin` file remains a placeholder until a separate native-build
change replaces and commits it. On Apple silicon, configure and build with
`protocol-scout-x86_64` in `native/avogadro3d-sidecar` (see that directory's README).
The result is `build/protocol-scout-x86_64/avogadro3d-sidecar`; copy the validated
thin x86_64 executable to
`apps/desktop/src-tauri/binaries/avogadro3d-sidecar-x86_64-apple-darwin`.
Check architecture, minimum macOS 11.0, dynamic dependencies, and all three
engine3d smokes before committing. Update the Intel-placeholder test in
`src-tauri/src/lib.rs` when the binary lands.

The Intel app also needs an x86_64 OPSIN runtime built with
`node scripts/build-opsin-runtime.mjs --arch x86_64`; see
`../resources/opsin/BUILD.md` for JAVA_HOME and Rosetta requirements. The runtime
is generated, never committed. Build and package architectures sequentially
because both use `resources/opsin/jre`. The release checker at
`tools/release/verify-macos-app.mjs` rejects missing/wrong-architecture runtimes
and sidecar placeholders by default. The advisory Intel CI job may explicitly
permit the known sidecar placeholder while skipping its smokes; that is not
release acceptance.
