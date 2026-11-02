# Brackets and repeat units

Square and round tools create two native `BracketObject` glyphs around the drag rectangle, in one
patch batch, one labelled history entry, with both selected. A click places an 80 × 64 pair. The
round icon is original 24-unit line art from ui-kit. Both default palettes place its registered
`tool.roundBracket` command beside `tool.squareBracket`.

The optional v1 `side`, `pairId`, and `repeatUnit` fields extend the existing object rather than
introducing another bracket type. Missing fields preserve legacy documents and their original
single glyph appearance, including the old `polymer` kind. Duplicate and native paste remint pair
identities so editing a copied pair cannot change the original.

UI choice for coordinator review: the object context menu offers **Mark as Repeat Unit** /
**Remove Repeat Unit** and **Edit Repeat Label**. Both are registered commands. Marking applies to
the pair even when only one member is selected. The closing glyph defaults to `n`. Label editing
uses in-place annotation input, consistent with atom labels and table captions: Enter or blur commits
one labelled undo entry; Escape cancels. This avoids a new dialog or palette for a single label.
The original pair shape remains independent of its repeat-unit status. Removing the mark hides the
label and retains its text for a subsequent mark.

`bracketLabelPlan` in layout-engine supplies lower-right placement, script font size and measured
bounds. The page SVG render plan, canvas overlay, label input and SVG/PDF exports consume it.
Copy-scope bounds include custom labels. Molecular graph data is never rewritten by these tools.
SMILES/SDF/MOL export reports `export.repeat_unit_not_represented` once per pair. Copy helpers refuse
to silently omit repeat semantics when called without a warning sink; plain brackets remain quiet.

## CDXML coverage and remaining work

Real square/round `graphic` brackets and pair `bracketattachment` membership are covered by
`packages/fixtures/cdxml/brackets-square.cdxml` and `brackets-round.cdxml`. Native document envelope
round trips preserve square, round and repeat pairs (labels `n` and `m`) exactly. Plain square/round
pairs also round-trip through the visible layer with all native metadata removed.

Repeat pairs write `BracketUsage="SRU"` and independent visible text at the shared label location.
The repeat-label association is **not mapped**: the existing fixtures document bracket attachments
and crossing bonds but no label association. The external specification could not be fetched in
the restricted environment. No `RepeatPattern` or other guessed attribute is written. Export warns
with `cdxml.repeat_label_payload_only`; external label text stays independent on import, with
`cdxml.repeat_label_unassociated`. A native payload is required for exact editable `n`/`m` round trips.
On visible-only import, no extra default `n` is painted over the independently retained text.

The native model carries whole-object membership, not polymer atom subsets, crossing-bond
attachments or head-to-tail connectivity. Export reports `cdxml.repeat_connectivity_not_represented`.
Imported `crossingbond` and unsupported bracket-group data remain unknown compatibility objects,
with a warning, instead of being asserted as native polymer chemistry. Curly/unknown/legacy-polymer
glyphs and transformed brackets retain `cdxml.bracket_payload_only` until covered by a verified
mapping. No general Tier B polymer-compatibility claim is made.

Recommended next task: obtain authoritative CDXML repeat-label/connectivity fixtures and complete
the standard repeat-label association plus atom-level attachment mapping. Verify the synthetic
single-glyph orientation and pair representation in an independent CDXML reader as well.

Automated verification is scoped to this task. GUI launch, builds and the full gauntlet were
excluded by the worker instructions. Run the bracket entry in the shared manual stress checklist
on macOS and Windows before integration; neither platform's interactive behavior is verified here.
