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
- Desktop Copy As MOL/SDF export has no canonical-identity check on the scaled bytes (the CLI does); consider adding one if 4-decimal rounding ever changes stereo for near-collinear wedges.
