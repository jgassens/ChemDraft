# Sidecar Bundle Placeholders

Tauri requires `bundle.externalBin` entries to have target-triple-suffixed files
at build time. These placeholders keep the desktop shell buildable while the real
`native/avogadro3d-sidecar` binaries are produced by the native build pipeline.

The runtime bridge does not execute arbitrary renderer-provided paths. During
development, set `CHEMDRAFT_ENGINE3D_SIDECAR` to a built sidecar executable.
Release packaging should replace the placeholder matching the target triple with
the real native binary.
