# OCSR accuracy fixtures

Images with a known correct structure, for checking the local MolScribe recognition engine
(docs/architecture/ocsr-engine.md) against a real installed model. They are **not** used by
`pnpm test`: CI has no model. Run the check by hand:

```bash
pnpm test:ocsr-real
# or choose the engine:
CHEMDRAFT_OCSR_ENGINE_DIR="/path/to/<app data>/ocsr-engine" pnpm test:ocsr-real
```

Without `CHEMDRAFT_OCSR_ENGINE_DIR`, `run-real-engine-check.mjs` searches the app data folders of the
stable app (`org.chemdraft.desktop`) and every dev build (`org.chemdraft.desktop.dev.*`) and uses
the most recently installed engine. It then starts `real_engine_check.py` with that engine's own
venv interpreter, which runs this checkout's sidecar exactly as the app does. The check only reads
the engine folder.

Each fixture is tried in three variants, and `expected.json` says what each must produce:

| Variant | What it simulates | Expects |
| --- | --- | --- |
| `file` | the file as shipped | `majority` |
| `retina-2x-on-white` | the drawing shown 700 points wide on a 2x (Retina) display: on white, long side 1400 px | `majority` |
| `1x-on-white-20px-margin` | the same on a 1x display, cropped with a 20 px white border: long side 740 px | `exactLowOrFailed` |

- `majority`: the RDKit canonical isomeric SMILES matches exactly, and more than half of the sizes
  the sidecar tried gave it.
- `exactLowOrFailed`: either that exact answer with the host's review tier capped at low, or a failed
  result. A wrong structure fails at any tier.

For each case the check prints one character per size, read from the sidecar's log (`Y` the expected
structure, `.` another valid one, `x` unparsable, `-` not run because the vote stopped early), then
the agreement, the tier cap and the time taken.

## Files

| File | What it is |
| --- | --- |
| `brevetoxin-a.svg` | Source drawing of brevetoxin A |
| `brevetoxin-a-1920.png` | Wikimedia's 1920 × 690 PNG rendering of that SVG: 8-bit gray + alpha, transparent background |
| `expected.json` | Expected structure per fixture and the variants to try |
| `run-real-engine-check.mjs` | Finds an installed engine and starts the check (`pnpm test:ocsr-real`) |
| `real_engine_check.py` | The check itself; needs Pillow and RDKit, so it runs in the engine venv |

**Source and licence.** Wikimedia Commons, [File:Brevetoxin_A.svg](https://commons.wikimedia.org/wiki/File:Brevetoxin_A.svg),
author Minutemen. Licence: **Public domain**. The PNG is Wikimedia's own rendering of that file.

**Expected structure.** From PubChem CID 10865808 (brevetoxin A, all stereocentres), with the
`CH2C(=CH2)CHO` side chain replaced by `*` because the drawing shows it as `R`. Written as RDKit
canonical isomeric SMILES:

```text
*[C@@H]1C[C@H](O)[C@@H]2O[C@@H]3C[C@]4(C)O[C@@H]5/C=C\C[C@@H]6O[C@H]7[C@H](C/C=C\C[C@H]6O[C@H]5CCC[C@H]4O[C@H]3C[C@H]2O1)O[C@@H]1C[C@@H]2O[C@@H]3CC(=O)O[C@H]3C[C@@H](C)C[C@@]2(C)O[C@H]1C[C@@H]7C
```

## Why this molecule

It is large (70 heavy atoms, 22 stereocentres, two cis double bonds) and Wikimedia ships it on a
transparent background, which is how it exposed two engine defects: OpenCV drops the alpha channel,
so the transparent PNG was read as noise (confidence 0.087), and the answer on a white background
changed with the image size — sometimes wrong with a confidence as high as a right one. See the
engine doc for what the sidecar does about each.

Add a fixture only when it is legally redistributable (see `../README.md`), and record its source,
licence and how the expected SMILES was derived here.
