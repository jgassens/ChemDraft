# Naming engine inputs (Orthonym)

What the optional naming engine installs and runs. The engine is downloaded on request, never
bundled; these files are the pinned inputs the app ships to drive it. Design:
[`docs/architecture/naming-engine.md`](../../../../../docs/architecture/naming-engine.md).

| File | Role |
|---|---|
| `requirements.in` | Human-edited pins: `orthonym==1.0.8` and its exact runtime pins `rdkit==2026.3.5`, `jpype1==1.7.1`, `lxml==6.1.3` |
| `requirements.txt` | Hash-locked, universal (macOS arm64, Windows x64 and GNU Linux x86_64), Python 3.12. Installed with `uv pip install --require-hashes` |
| `orthonym_sidecar.py` | The JSON Lines worker (protocol 1). `python3 orthonym_sidecar.py --selftest` needs no Orthonym |
| `licenses/` | Licence texts for the parts of the downloaded centres jar (LGPL, GPL with Classpath exception); see its README |

## Pins

- **requirements.txt SHA-256** (LF line endings, as committed):
  `ec5021b4365d77936c99ae71f3057a41c946149e67d8342de24c867edd6d9a2a`
- **Orthonym**: PyPI wheel `orthonym-1.0.8-py3-none-any.whl`, 4,090,379 bytes, SHA-256
  `ffd4f69d95349887c3fd762197464dadff81a1cf494fe42f6a2bcd7d6674393d`. Provenance commit
  `461987b947f76e41ff0baa6c2aa19ecd79cacd0b` (tag `v1.0.8`). Checked 2026-10-21: every file under the
  wheel's `orthonym/` equals `src/orthonym/` at that tag (`diff -rq`, no differences).
- **Resolved set** (7 distributions): orthonym 1.0.8, rdkit 2026.3.5, jpype1 1.7.1, lxml 6.1.3,
  numpy 2.5.4, pillow 13.0.0, packaging 26.3.
- **centres jar** (installed separately, verified by the host before every spawn):
  `centres-cli-1.2.1.jar`, 2,291,742 bytes, SHA-256
  `6c5d5cafa9393ed7b667a2340222348cd15a9bbdd0d1b92518229f26cc5e87fb`, from
  `https://github.com/SiMolecule/centres/releases/download/1.2.1/centres.jar`.

## Platform wheels in the lock (checked against PyPI on 2026-10-21)

Every hash in `requirements.txt` was matched to a file on PyPI. For Python 3.12:

| Package | `cp312` win_amd64 | macOS arm64 |
|---|---|---|
| rdkit 2026.3.5 | `rdkit-2026.3.5-cp312-cp312-win_amd64.whl` | `…-macosx_11_0_arm64.whl` |
| lxml 6.1.3 | `lxml-6.1.3-cp312-cp312-win_amd64.whl` | `…-macosx_10_13_universal2.whl` |
| pillow 13.0.0 | `pillow-13.0.0-cp312-cp312-win_amd64.whl` | `…-macosx_11_0_arm64.whl` |
| numpy 2.5.4 | `numpy-2.5.4-cp312-cp312-win_amd64.whl` | `…-macosx_11_0_arm64.whl` |
| jpype1 1.7.1 | `jpype1-1.7.1-cp312-cp312-win_amd64.whl` | `…-1-cp312-cp312-macosx_11_0_universal2.whl` |
| orthonym, packaging | pure Python (`py3-none-any`) | same |

Intel Macs: rdkit 2026.3.5 has no macOS x86_64 wheel, so the engine reports `unsupported` there.

The lock was resolved by `uv 0.11.7`. Re-lock command is in `requirements.in`. Whether the Windows
wheels actually install under `--require-hashes` on a Windows host is **unverified**: only the
macOS arm64 install was run.

## Verified so far

- GNU Linux x86_64 (2026-10-29): all seven packages installed from this unchanged
  lock under managed Python 3.12; imports, the bundled JVM and both verified jars
  passed. The real sidecar named ethanol, abstained on iron, and rejected invalid
  SMILES. Raw naming results still pass through the host's exact-structure OPSIN
  policy before the app accepts them.

- macOS arm64: `uv pip install --require-hashes --compile-bytecode -r requirements.txt` into a Python
  3.12 venv, then a real run of the sidecar with ChemDraft's bundled JRE and the vendored OPSIN 2.9.0 jar
  plus the centres jar (ethanol, glycine zwitterion, `[Fe]`, an invalid SMILES): see the task handoff.
- `--selftest` passes with plain `python3`.
- Windows: unverified (sidecar, JPype loading `bin\server\jvm.dll`, wheels, non-ASCII profile paths).
