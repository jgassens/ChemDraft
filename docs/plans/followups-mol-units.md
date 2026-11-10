# Landing plan

- This branch, `fix/mol-units-1.2.1`, targets release 1.2.1, not 1.2.
- It is based on `release/1.2-rc`, so no pull request opens until 1.2 merges into `main`, expected the week of 2026-11-12.
- After that merge, open a draft pull request into `main`. Its title must start with `[1.2.1]`, not `[1.2]`, and it will show only this branch's commits.
- Before landing during the 1.2.1 cycle, check Copy As MOL, File > Export SDF, and MOL paste on screen on macOS and Windows; the full test suite runs in CI on that pull request.

# MOL/SDF units follow-ups

Phase 1 targets release 1.2.1: external drawing exports use one uniform scale per CTAB,
with a 1.5 Angstrom median bond length; MOL paste (including RXN MOL blocks) and image recognition
scale the input median bond to the destination document's bond length. Generated depictions,
name-to-structure and templates retain their previous mean-based sizing.
The native writer default remains raw.

Deferred:

- Scaled plugin selection snapshots and assistant get_structure molfiles, with a plugin-api bump for 1.3.
- Preserve z/3D input separately from drawing geometry; physical conformer/model units stay unchanged.
- Multi-record SDF import.
- Open/drop of .mol/.sdf files.
- The structural fallback (used only when neither side has canonical SMILES) does not check coordinate-derived stereo (wedge parity, E/Z); consider an orientation-sign check.
