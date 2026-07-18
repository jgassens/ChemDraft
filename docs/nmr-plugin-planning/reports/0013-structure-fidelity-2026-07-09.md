# Report 0013 — Structure fidelity: fused rings were predicted as straight chains

**Date:** 2026-07-09
**Worktree:** `~/Documents/programming/chemdraw-nmr` @ `codex/nmr-plugin`
**Decision:** [ADR-0019](../decisions/0019-lossless-molfile-at-plugin-boundary.md)

## Symptom (user-reported, two screenshots)

- Hand-drawn **naphthalene + isopropyl** → panel predicted a **13-carbon straight alkane**
  (6 resonances, all 0.88–1.30 ppm, no aromatics; the linked figure drew a linear zigzag).
- A **single ring** did *not* collapse to a chain (user's key observation: the failure was
  topology-specific), though hand-drawn rings had their own bond-order oddities.

## Diagnosis (reproduced, not inferred)

The app serializes drawn molecules to SMILES with a hand-rolled writer,
`nativeSingleBondGraphSmiles`, that only handles a single ring-with-branches or a tree. **Any
fused/polycyclic system** hits a fallback that concatenates atom symbols with no bonds —
`atoms.map(nativeAtomSmiles).join("")`. Because SMILES implicitly bonds adjacent characters, a
10-carbon naphthalene becomes `CCCCCCCCCC` = **decane**. The selection bridge forwarded that string
to the plugin, so the predictor faithfully predicted a straight chain.

Reproduction through the real `moleculeToMolfileV2000` + OCL + the bundled predictor:

| Input (same naphthalene atoms+bonds) | OCL sees | Predicted ¹H |
|---|---|---|
| current lossy SMILES `CCCCCCCCCC` | C₁₀H₂₂ decane, 0 aromatic | `[0.88, 1.25, 1.27, 1.28, 1.30]` |
| **lossless molfile** | **C₁₀H₈ naphthalene, 10 aromatic** | **`[7.40, 7.48, 7.80]`** |

Single rings survived because the single-ring path emits Kekulé `C1=CC=CC=C1`, which OCL aromatizes
(verified: C₆H₆, 6 aromatic — same as its molfile).

## Fix (ADR-0019)

Hand plugins a **lossless V2000 molfile** built from the molecule's live atom/bond graph instead of
the lossy SMILES. `selectionSnapshot.ts` gains `pluginFacingStructure()`: `atoms.length > 0` →
`moleculeToMolfileV2000(molecule, { fromDocFrame: true })`; else pass the existing structure through.
Fingerprint stays on the object's coordinate-free structure string (no move-induced staleness). No
OCL in the main bundle — the molfile writer is pure string formatting and already existed for the
3D-spin pipeline. This also fixes the linked-figure depiction (the predictor draws from the same,
now-correct, molecule).

## Files

- `apps/desktop/src/plugins/selectionSnapshot.ts` — `pluginFacingStructure()` + snapshot wiring
- `apps/desktop/src/plugins/selectionSnapshot.test.ts` — molfile-emission + passthrough coverage (+3)

## Verification

- `pnpm lint` clean; `pnpm test` → **1341 passed** / 9 skipped; web + Tauri release build OK.
- End-to-end: naphthalene molfile → aromatic ~7.4–7.8 ppm through the bundled DB.

## Follow-up (out of scope, filed)

`nativeSingleBondGraphSmiles` remains lossy for the app's *own* `object.structure` (copy-as-SMILES,
round-trips). A general SMILES writer (DFS spanning tree + ring-closure digits) would fix it at the
source. Not required for the plugin, which now takes the molfile path.
