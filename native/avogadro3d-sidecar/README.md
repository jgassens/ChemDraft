# avogadro3d-sidecar

Native C++17 sidecar for ChemDraft's experimental interactive 3D workspace.

Milestone 1 is intentionally a companion native process with its own Qt/OpenGL
viewport, not an embedded child window in the Tauri webview. The sidecar protocol
is newline-delimited JSON over stdio; stdout is protocol-only and logs go to
stderr.

This directory currently contains a protocol-scout executable. It proves the
terminal flow and bundling boundary before the Avogadro 2 targets are linked.
The implementation target is:

```text
OpenChemistry/avogadrolibs@416651ddaef33a4e20392392e7c0b505d446491b
```

Milestone 1 native build rules:

- C++17.
- Qt 6 and OpenGL are allowed for the companion viewport.
- Open Babel is not linked.
- GPL plugins are not linked.
- Optional nonessential features stay disabled until a specific target requires
  them: Python, benchmarks, tests, plotter, libarchive, libmsym, and spglib.

Build the protocol scout:

```bash
cmake --preset protocol-scout
cmake --build --preset protocol-scout
```

Run the stdio proof:

```bash
native/avogadro3d-sidecar/build/protocol-scout/avogadro3d-sidecar --stdio
```

Send one JSON request per line. For example:

```json
{"protocolVersion":1,"requestId":"r1","type":"createSession","graphSignature":"fixture","bondSignature":"fixture"}
{"protocolVersion":1,"requestId":"r2","sessionId":"engine3d-session-1","type":"showViewport"}
{"protocolVersion":1,"requestId":"r3","sessionId":"engine3d-session-1","type":"startAutoOptimize"}
{"protocolVersion":1,"requestId":"r4","sessionId":"engine3d-session-1","type":"pointer","phase":"move","atomId":"a2","position":{"x":1,"y":0,"z":0}}
{"protocolVersion":1,"requestId":"r5","sessionId":"engine3d-session-1","type":"commit"}
{"protocolVersion":1,"requestId":"r6","sessionId":"engine3d-session-1","type":"dispose"}
```

When the real Avogadro slice lands, this executable should keep the same stdio
envelope and replace only the protocol-scout internals.
