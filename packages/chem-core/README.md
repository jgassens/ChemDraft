# @chemdraft/chem-core

Generated arrangement arrows may carry optional `arrangementConnection` endpoint object IDs and a
page-space bend vector. These are drawing-layout relationships only, with no chemical reaction role.
Optional saved settings and ordered item IDs reconstruct the arrangement editor, including its
bounded arrow-length percentage. Older endpoint/bend-only relationships remain valid.
Older documents omit the field and retain their existing arrow geometry.

Owns the native document model, schema versions, migrations, validation, serialization, patch application, and native style presets (including `DocumentStylePreset`).

Offshoot attachments optionally carry `mode: "fullCurve"` and a required `startOffset` in the
parent frame. Optional `tetherFraction` stores normalized shaft arclength (default midpoint).
Optional `normalSign` preserves an authored visual side through parent transforms. Their on-curve
junction remains attached while independently editable tail/head extend on either side.
Omitting the mode retains the existing half-curve behavior; older native files need no migration.

This package must not import UI, Tauri, Ketcher, RDKit, plugin loading, or filesystem APIs.

The MOL writers require an explicit `kekuleBondOrders` map and return `{ contents, warnings }`.
Callers resolve orders through layout-engine; this package cannot depend on it. An empty or partial
map preserves unmapped aromatic bonds as type 4 and returns one warning per ring system, naming its
atoms. Every consumer must surface those warnings through its operation's warning path.

Unknown bond orders write as CTfile type 8 (any) in both formats, with one warning naming all
affected bond ids. This preserves the native unknown order on reimport, but readers treat it as a
query bond with no chemical order. Chemistry and 3D engine callers pass `unknownBondOrders: "refuse"`; this
throws the exported `UnknownBondOrderError` with `bondIds` before any output or warnings are emitted.
