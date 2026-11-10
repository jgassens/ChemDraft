# Brackets and repeat units

Square and round tools create two native `BracketObject` glyphs around the drag rectangle, in one
patch batch, one labelled history entry, with both selected. A click places an 80 × 64 pair. The
round icon is original 24-unit line art from ui-kit. Both default palettes place its registered
`tool.roundBracket` command beside `tool.squareBracket`.
Completed placement returns to Select so both members' selection chrome is visible. Older saved
Main-toolbar orders that omit Round Bracket insert it immediately after Square Bracket; an explicit
saved placement is retained.

The optional v1 `side`, `pairId`, `repeatUnit`, `bracketUsage`, `repeatCount` and `crossingBondIds` fields extend the existing object rather than
introducing another bracket type. Missing fields preserve legacy documents and their original
single glyph appearance, including the old `polymer` kind. Duplicate and native paste remint pair
identities so editing a copied pair cannot change the original.
Membership travels only with copied objects: uncopied member IDs are dropped. Copying one glyph
removes its pair identity, repeat mark and label. Deleting or cutting one glyph clears those fields
on the survivor in the same patch batch; undo restores both original glyphs exactly. Native loading
also clears orphaned pair metadata and records a warning naming each affected bracket.

UI choice for coordinator review: the object context menu offers **Mark as Repeat Unit** /
**Remove Repeat Unit** and **Edit Repeat Label**. Both are registered commands. Marking applies to
the pair even when only one member is selected. The closing glyph defaults to `n`. Label editing
uses in-place annotation input, consistent with atom labels and table captions: Enter or blur commits
one labelled undo entry; Escape cancels. This avoids a new dialog or palette for a single label.
Double-clicking the painted repeat label invokes the same Edit Repeat Label command. As with
existing text objects, a single click with Select selects without opening the editor.
The original pair shape remains independent of its repeat-unit status. Removing the mark hides the
label and retains its text for a subsequent mark.

`bracketLabelPlan` in layout-engine supplies lower-right placement, script font size and measured
bounds. The page SVG render plan, canvas overlay, label input and SVG/PDF exports consume it.
Copy-scope bounds include custom labels. Molecular graph data is never rewritten by these tools.
SMILES export reports `export.repeat_unit_not_represented` once per repeat pair associated with
exported atoms, including when only the molecule is selected. The warning names the repeat label,
atom count and bracket id. Copy uses the normal warning sink and shows the warning in its status;
file exports carry it in their report. SDF also warns for its graph-only SMILES property.
The warning retains the shared one-copy chemistry context, including multiple-group counts and
unknown bracket usage, so graph-only exports never silently discard those meanings.

MOL V2000/V3000 and SDF connection tables write SRU SGroups with atom membership, crossing bonds,
repeat label and default EU connectivity. Explicit whole-molecule membership is retained; otherwise
atoms inside untransformed brackets determine membership, even when their molecule extends outside
the pair. Merged molecule ids and abbreviation expansions preserve that mapping. Missing membership,
partially exported units, transformed brackets and unrepresentable labels warn naming the bracket
instead of asserting an SRU. Pairs unrelated to the exported molecules remain quiet. Plain brackets
do not change the graph output. Multiple groups and unknown usages warn rather than being written
as SRUs. Successful SRU output retains the chemistry warning that values and the molecular graph
describe one drawn copy. SDF currently carries that writer warning separately from the warning for
its graph-only SMILES property. The CLI SMILES-input exporter receives no repeat-bracket documents;
the separate document-backed export path retains contextual warnings.
Copy warning sinks are optional; omitting them never prevents copying. Plain brackets and lone
glyphs remain quiet, as do pairs with no exported molecule, including pairs on other pages.

## CDXML and binary CDX coverage

Square and round graphics become native pairs through the existing bracket import/export path.
Group SRU usage maps to bracketUsage sru and repeatUnit; MultipleGroup maps to multiple and a
positive integer repeatCount. An absent group usage falls back to graphic-level usage, then generic.
Other usages map to unknown with cdxml.bracket_usage_unknown. SRULabel supplies the closing glyph's
free-text label. A group without SRULabel keeps independent text and still warns about association.

Geometry decides sides: the glyph centre to the left opens the pair. Endpoint order does not decide
orientation. Source BoundingBox text is retained verbatim until the native geometry changes. LipSize,
Z, IgnoreWarnings, Warning, line width, colour and other source attributes stay in compatibility data
and are re-emitted. Custom colour indices are allocated against the output colour table to retain RGB.
Unmapped native appearance warns on import. Additional group data and children remain opaque and
round-trip with a named warning.

Crossing BondID values resolve to crossingBondIds, using molecule-scoped objectId/bondId references.
Unresolved references remain compatibility data and warn. InnerAtomID remains opaque and is written
back for an unchanged bond; retopologising the bond drops its old association. Whole-fragment
BracketedObjectIDs become containedObjectIds. Atom-level and unresolved members remain compatibility
data with a warning, while the pair stays editable. Deleted known members are removed from visible
export. Missing/non-pair attachments still use unknown-object preservation rather than inventing a
pair. Source attributes and opaque children are retained alongside native semantic snapshots so edits
regenerate the affected data.

The existing binary codec already contains the bracketedgroup, bracketattachment, crossingbond,
BracketUsage, RepeatCount, SRULabel, GraphicID, BondID, InnerAtomID, LipSize and BracketType mappings.
Its existing Octet Draw / Apache-2.0 attribution remains in cdxTags.ts and cdxBinary.ts; no new
reference code was copied. Synthetic brackets-native-sru.cdxml and brackets-native-multiple.cdxml
exercise real binary decode/import/export/decode as well as visible-only CDXML round trips. Native
envelopes are removed for the visible checks.

## Chemistry and cleanup

chem-core supplies one bracket-context check shared by export warnings and desktop analysis.
It uses whole-object membership, preserved atom membership, crossing references, and enclosure.
Multiple groups name x plus their repeatCount; SRUs name their free-text repeat label; unknown usage
also warns. Legacy repeatUnit true without bracketUsage still means SRU. Formula, exact mass and
average mass cached on a molecule carry chemistry.bracket_multiplier after loading or patching.
Those values and graph exports describe one drawn copy. No atoms are expanded.

MOL V2000/V3000 and shared SMILES writers retain cached warnings or accept live document context.
SMILES/MOL/SDF document export warns even when only the contained molecule is selected. Desktop
property analysis and validation decline bracketed members before engine computation; changing
bracket context also changes the analysis subject key. Assistant document summaries decline formula
and SMILES with the same warning. CLI analyze accepts SMILES rather than documents, so no document
bracket context can enter that command. CLI document-backed export carries contextual warnings.

Orphan repair and deletion remove bracketUsage, repeatCount and crossingBondIds along with the
existing pair metadata. The plain-pair command clears the new fields too. Paste and duplicate
remap only copied bond references, and drop uncopied or missing bonds; patches prune references when
a bond or molecule is deleted. Merging molecules remaps both molecule and local bond ids. Cached
chemistry warnings disappear when the multiplier is removed.

The SDK exposes DocumentObject and ChemDraftDocument, so the additive native fields require API
0.1.25. Its minor compatibility boundary remains unchanged.

## Changed existing test expectations

- cdx-compat/brackets.test.ts: native square/round repeat labels now assert SRULabel and visible-only
  label round trips, replacing independent text and the two payload-only warnings because those
  semantics are now written.
- cdx-compat/brackets.test.ts: the three foreign SRU-crossing/unknown-usage/atom-membership cases now
  assert native pairs and preserved data, replacing rejection as unknown objects. The paired
  crossing-bonds case likewise asserts a native crossing reference and atom-membership warning.
- desktop/bracketCommands.test.ts: the square/round graph-invariance cases now compare atoms and
  bonds plus explicitly warned chemistry metadata, because metadata now names the multiplier.
  Their warning text checks the repeat label.
- desktop/bracketCommands.test.ts: exporting a member without its pair selected now must warn;
  the previous quiet result silently omitted its multiplier.
- plugin-api/workerProtocol.test.ts and reportLimits.test.ts: the asserted current SDK version changes
  from 0.1.24 to 0.1.25 for the public additive bracket fields.

Automated verification is scoped to this task. The isolated worktree lacks package-level dependency
links, so tests use a temporary task-local Vitest config pointing at dependencies already installed.
No install, native build, GUI launch, whole-repository test suite, root typecheck or cargo command was
run. macOS-hosted unit tests do not verify interactive macOS behavior. Windows behavior is unverified;
run the scoped tests and the shared manual bracket checklist on Windows before integration.

Recommended next task: verify edited and untouched bracket geometry and group semantics in an
independent CDXML/CDX reader, then complete the shared interactive checklist on both platforms.
