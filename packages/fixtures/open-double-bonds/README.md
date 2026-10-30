# Open double-bond interchange fixtures

Synthetic fixtures generated with ChemDraft's native builders and the vendored RDKit
2026.03.3. No external drawing assets or data are included.

`cases.json` records source and canonical isomeric SMILES, RDKit formula and charge,
native atom/bond counts, the explicit `either` bond indices, and tetrahedral states.
Each case has native v1 JSON, V2000 and V3000 MOL, SMILES, and visible CDXML with **all
ChemDraft native payload tags removed**. `mixed-records.sdf` alternates both MOL
versions for every case. The tests assert the native flag separately from canonical
SMILES, since SMILES alone cannot distinguish explicit either from unassigned E/Z.
In visible CDXML an either double bond is written as a plain `Order="2"` bond;
only the embedded native payload preserves the either flag. Export warns once per
such bond that other applications see a plain double bond.

- `open`, `e`, `z`: but-2-ene with open, assigned E, and assigned Z stereo.
- `mixed-diene`: one open alkene and one assigned E alkene.
- `conjugated-diene`: adjacent open and assigned alkenes sharing a directional
  SMILES single bond; tests preserve stereo without removing slash characters.
- `explicit-h`: two ordinary, explicitly drawn hydrogen atoms next to the open bond.
- `ring-closure`, `ring-closure-reindexed`: the same cyclohexyl-substituted alkene
  with different SMILES traversal and native double-bond indices (6 and 1).
- `neighboring-centers`: an open alkene and an open tetrahedral center next to an
  assigned tetrahedral center; no wedge may appear at the open center.
- `charged`: an open alkene with an ammonium group, exercising nonzero charge.

`serializer-baseline.json` was captured **before the implementation change**, using
the then-current `serializeDocument(deserializeDocument(input))`. It records SHA-256
hashes for every tracked native JSON fixture plus every chem-core graph corpus case
wrapped in a document with the fixed timestamp `2026-10-27T00:00:00.000Z`. It is a
compatibility lock, not a snapshot to refresh when behavior changes.

SMILES-derived native molecules remain geometry-defined by default. Opt-in callers
pass `openUnspecifiedDoubleBonds: true` to `createSmilesMolecule` (after `source`) or
`insertSmilesMolecule`. The molfile depiction parser retains explicit either markers;
OCL SMILES callers also pass the option to `depictSmiles2D` to request their perception.
MOL import and OCL MOL relayout retain explicit markers independently of that policy.
RDKit callers pass the same option to `generateSmiles2DMolfile`; this asks RDKit's
stereo cleanup to perceive potential bonds, then writes STEREOANY through its JSON
boundary. This also handles conjugated double bonds its default MOL writer leaves
unmarked. Existing assigned stereo is retained with `assignStereo: false` when
reading that JSON, followed by the usual canonical read-back guard.
