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
