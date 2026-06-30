# avogadro3d-sidecar

Native C++17 sidecar for ChemDraft's experimental interactive 3D workspace.

The product target is a ChemDraft-owned 3D editor viewport backed by native
sidecar mechanics. ChemDraft owns the visible WebGL panel and camera; the
sidecar owns molecule state, atom-drag constraints, and force-field
optimization. A sidecar-owned Qt viewport may exist only as a dev-only
diagnostic fallback, not as product UI. The sidecar protocol is newline-delimited
JSON over stdio; stdout is protocol-only and logs go to stderr.

This directory currently contains a protocol-scout executable with the real
Avogadro Core/Calc mechanics path linked when local `_deps` are present. It
returns coordinates from Avogadro's built-in BSD UFF optimizer rather than the
earlier React/WASM live-tug path. The implementation target is:

```text
OpenChemistry/avogadrolibs@416651ddaef33a4e20392392e7c0b505d446491b
```

Milestone 1 native build rules:

- C++17.
- Qt/OpenGL rendering is not linked in this headless mechanics slice.
- If a future diagnostic viewport or render backend is added, keep it out of the
  product protocol unless ChemDraft still owns the visible workspace.
- Open Babel is not linked.
- GPL plugins are not linked.
- Optional nonessential features stay disabled until a specific target requires
  them: Python, benchmarks, tests, plotter, libarchive, libmsym, and spglib.
- This slice links only `Avogadro::Core` and `Avogadro::Calc`.

Fetch local source dependencies into the ignored `_deps` directory:

```bash
git clone https://github.com/OpenChemistry/avogadrolibs.git native/avogadro3d-sidecar/_deps/avogadrolibs
git -C native/avogadro3d-sidecar/_deps/avogadrolibs checkout 416651ddaef33a4e20392392e7c0b505d446491b
git clone --depth 1 --branch 3.4.0 https://gitlab.com/libeigen/eigen.git native/avogadro3d-sidecar/_deps/eigen
```

Build the Avogadro-backed protocol scout:

```bash
/opt/homebrew/bin/cmake --preset protocol-scout
/opt/homebrew/bin/cmake --build --preset protocol-scout
```

Without the local `_deps` checkout, the CMake preset intentionally fails rather
than falling back to placeholder mechanics. A no-Avogadro fallback build can be
made explicitly for protocol debugging only:

```bash
mkdir -p native/avogadro3d-sidecar/build/protocol-scout
c++ -std=c++17 \
  '-DCHEMDRAFT_AVOGADRO3D_AVOGADRO_COMMIT="416651ddaef33a4e20392392e7c0b505d446491b"' \
  native/avogadro3d-sidecar/src/main.cpp \
  -o native/avogadro3d-sidecar/build/protocol-scout/avogadro3d-sidecar
```

Run the stdio proof:

```bash
native/avogadro3d-sidecar/build/protocol-scout/avogadro3d-sidecar --stdio
```

Run the ChemDraft real-structure smoke against a built sidecar:

```bash
CHEMDRAFT_ENGINE3D_SIDECAR=native/avogadro3d-sidecar/build/protocol-scout/avogadro3d-sidecar pnpm smoke:engine3d-real-structure
```

For interactive Tauri development, `./run-app --dev` automatically exports
`CHEMDRAFT_ENGINE3D_SIDECAR` when this local binary exists. If another project
already owns port 5173, it chooses the next free port and passes that same port
to Vite and Tauri.

The smoke uses a real 43-atom charged structure, sends world-space atom drag
commands, rejects bulk rigid-body drift/collapse, checks selected-bond stretch,
and requires commit metadata to report `forceField.name === "UFF"` and
`avogadroBacked === true`.

Send one JSON request per line. For example:

```json
{"protocolVersion":2,"requestId":"r1","type":"createSession","input":{"molfile":"...","format":"molfile-v2000","atomIdByMolfileIndex":["a1","a2"],"graphSignature":"fixture","bondSignature":"fixture"}}
{"protocolVersion":2,"requestId":"r2","sessionId":"engine3d-session-1","type":"beginDrag","atomId":"a2"}
{"protocolVersion":2,"requestId":"r3","sessionId":"engine3d-session-1","type":"updateDrag","atomId":"a2","target":{"x":1.5,"y":0.2,"z":0.6}}
{"protocolVersion":2,"requestId":"r4","sessionId":"engine3d-session-1","type":"endDrag","atomId":"a2"}
{"protocolVersion":2,"requestId":"r5","sessionId":"engine3d-session-1","type":"commit"}
{"protocolVersion":2,"requestId":"r6","sessionId":"engine3d-session-1","type":"dispose"}
```

The next native slice should keep this stdio envelope and improve the constrained
optimizer behavior before adding any product-facing rendering surface.
