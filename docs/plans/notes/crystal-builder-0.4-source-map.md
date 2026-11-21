# Task 0.4: Crystal Builder source map

Crystal Builder v1.1.1 (commit `26cbda4d`), MIT. Read-only map by `google-argon` (agentctl run
`cb-source-map-0-4b`, 2026-11-21); the conductor checked the claims below against the source and
corrected the node table, which the worker got partly wrong (see "Corrections").

## What this changes in the plan

1. **The plugin does not need to know which MOFs need a bigger cell.** Every `consistent` build
   scores how many joints are left twisted and reports it as the table row **"Joint twist left"**
   (`xtal/modules/mof.py:345-353`; cost 2.0 per twisted edge, `xtal/mof/attach.py:294-315`). pcu +
   N16 scores 6.0 at 1×1×1 and 0.0 at 2×2×2. So the generic rule is: build at 1×1×1; if "Joint twist
   left" is above zero, rebuild at 2×2×2; if it is still above zero, show the number and do not name
   the material. No per-MOF table. (Crystal Builder has no static list of which pairs need a
   repeat, `xtal/mof/orient.py:495-505`.)
2. **`mof.build --json` is one JSON object on stdout** (`xtal/cli.py:665-674`): `ok`, `summary`,
   `detail`, `filed`, `run`, `output`, `tables` (rows of `label`/`value`/`unit`/`note`), and
   `report_text`. There is **no top-level `formula` or `warnings` key**: fit numbers ("Largest RMSD",
   "Mean RMSD", "Closest contact", "Joint twist left", "Atoms overlap", "Cell") are rows in
   `tables`; the formula comes from the follow-up `inspect`. A failed build prints
   `{"ok": false, "summary": "failed: <reason>", …}` without `tables`.
3. **Exit codes** (`xtal/cli.py`): 0 success; 1 bad input before the run (message on stderr, no JSON)
   or an `inspect` error diagnostic; 2 usage error or a build that ran and failed; 130 SIGINT; 143
   SIGTERM. The companion runner maps 1 and 2 to `exit-nonzero` and still parses stdout when it is JSON.
4. **`bb_dir` reads only `*.xyz`** (`xtal/mof/catalog.py:1175-1179`). Format: atom count; a line of
   0-based connection-atom indices (connection atoms also use the symbol `X`); `symbol x y z` lines;
   then optional bond lines `i j S|D|T|A`. Bonds are optional for a simple two-point linker (distance
   perception) and **required for polydentate or face-aligned blocks** (`xtal/mof/orient.py:523-525`).
   The block id is the file stem; a user block overrides a shipped one with the same stem. So the
   plugin writes bond orders from the drawing (it has them), which also keeps aromaticity.
5. **`xtal inspect --json`** gives `space_group`, `space_group_number`, `detected_space_group`,
   `symprec` (default 0.01 Å), `z`, `formula`, `cell` {a,b,c,alpha,beta,gamma}, `volume`, `density`,
   `site_groups` (element, coordination, count), `n_atoms`, `net_charge`, `fragments`, `diagnostics`
   (`xtal/agent/inspect.py:76-134`). The target check reads `detected_space_group`, `z`, `formula`
   and `cell`.
6. **Where the tool is:** macOS `Crystal Builder.app/Contents/MacOS/xtal`; Windows `xtal.exe` beside
   `Crystal Builder.exe` in the install folder (default `%LOCALAPPDATA%\Programs\Crystal Builder\`),
   sharing `_internal\` (`packaging/windows.spec:139-181`, `docs/PACKAGING.md:79-83`). This matches
   the manifest template's `tool` paths.
7. **Running it as a subprocess:** no network for builds and `inspect`; no first-run prompt; without
   `--workspace` it writes nothing but `-o`; startup about 0.3–0.5 s (lazy imports). It reads
   `XTAL_APP_DATA` and some engine overrides (`XTAL_*`); the host passes a clean environment, so none
   apply. The frozen build sets `PYINSTALLER_RESET_ENVIRONMENT` itself.

## Node ids (checked by counting atoms in each block file)

| Id | Contents (connection points excluded) | Connections | Use |
|---|---|---|---|
| N16 | Zn₄ C₆ O₁₃ | 6 | Zn₄O, MOF-5 (pcu, repeat 2×2×2) |
| N17 | Cu₂ C₄ O₁₀ | 4 | Cu paddlewheel with two axial O (HKUST-1, on tbo with N10) |
| N409 | Cu₂ C₄ O₈ | 4 | Cu paddlewheel without axial O |
| N10 | C₆ H₃ | 3 | benzene-1,3,5 hub (BTC core) |
| N419 | Zr₆ C₁₂ O₃₂ | 12 | Zr₆ cluster, UiO-66 (fcu) |
| N24 | Zr₆ C₁₀ H₈ O₃₂ | 10 | Zr₆ cluster |
| N21 | Zr₆ C₈ H₁₂ O₃₂ | 8 | Zr₆ cluster (NU-1000 type) |
| N14, N15 | Zr₆ C₆ H₁₆ O₃₂ | 6 | Zr₆ clusters |
| N9, N536 | Cr₃ C₆ O₁₆ / O₁₃ | 6 | Cr₃O trimers (MIL-88/100/101) |
| N134, N589 | Ni₃ C₆ O₁₆ / O₁₃ | 6 | Ni₃O trimers |
| N268 | Co₃ C₆ O₁₃ | 6 | Co₃O trimer |
| N125 | Cu₃ C₆ O₁₂ | 6 | Cu₃ trimer |

The catalog has 639 node files (N1–N719, not contiguous), 228 edge files, 12 shipped polydentate
blocks (for example `RUBTAK02_Zr6`, `DOJXRV_Paddlewheel`), and rod SBUs for MIL-53 and MOF-74
(`xtal/mof/catalog.py`, `docs/manual/frameworks/blocks.md`). Before each suggestion row ships, its
node id is checked the same way, and the row is checked by a real build plus `inspect` (the
target-check rule).

## Corrections to the worker's note

The worker called N17 a 6-connected Zr₆ cluster and N18 the Cu paddlewheel. N18 is actually Cu₃
with three connection points. It also described N111 as a 12-connected Ce₃ cluster (it is Co₃,
8-connected) and N55 as a 12-connected Zn₅ cluster (it is a Cd complex, 6-connected). The table
above is from the files themselves. The rest of its note (JSON keys, exit codes, `bb_dir` format,
packaging paths, environment) matched the source where checked (`catalog.py:1175-1179`,
`cli.py:664-675`, `windows.spec:139-169`, `mof.py:347`).
