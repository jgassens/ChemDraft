# Native document versions and forward reading

`packages/chem-core` owns this contract. It is platform-independent, with no filesystem or engine
dependency. CDXML/CDX compatibility is a separate boundary.

## Version envelope and the released reader

The native object-model discriminator remains `schema: "chemdraft.document.v1"`. Newer writers can
also emit these **top-level** header fields (versions are stable `major.minor.patch` strings):

| Field | Meaning |
| --- | --- |
| `formatVersion` | The writer's native-file contract revision; currently `1.2.0`. |
| `minAppVersion` | The oldest app that understands the features actually present in the file. |
| `ignorableFields` | Field path patterns for newer, display-only fields actually present; an older reader may omit these from display while preserving them for re-save. Omitted when the list is empty. |

The schema at tag `v1.1.1` is strict at the root and in nested objects. Consequently the 1.2 writer
omits **all three** fields whenever the document needs only 1.1.1 features. It does not add a default
version field to every file. Plain files keep the released serializer's property order and defaults,
and the frozen, test-only 1.1.1 schema parses them. The reader reports an absent `formatVersion` and
an effective `minAppVersion` of `1.1.1` for these legacy files. Existing page-layout and graphic-arc
migrations still apply to legacy files.

When newer features are present, the writer adds `formatVersion`, the computed `minAppVersion`, and
the nonempty `ignorableFields` list derived from the feature table and the fields actually present.
An unmodified 1.1.1 app will reject those files; 1.2 cannot retroactively change that released app.
A newer version envelope alone is not a used feature: saving an otherwise plain document removes it.

`NativeDocumentFormatVersion`, `NativeDocumentReaderVersion`, and the baseline version live in
`documentFeatures.ts`. Compare numeric version components, never strings (`1.10.0` follows `1.3.0`).

## One feature introduction registry

`NativeDocumentFeatureVersions` in `packages/chem-core/src/documentFeatures.ts` is the single table
of additions since 1.1.1. Each entry records `introducedIn`, a required boolean `ignorable`, and its kind:

- `feature`: a field or enum/literal value that raises the minimum when actually present;
- `envelope`: version information, which does not itself raise the minimum;
- `internal`: preservation bookkeeping, which is reconstructed into file data rather than saved as
  a second copy of that data.

`ignorable: true` promises that omitting the addition cannot change chemical meaning: it is purely
display-only. Chemistry-bearing additions must declare `ignorable: false`; envelope and internal
entries also declare false. Every new field, including children of a new field or object type,
needs this explicit decision. Enum/literal entries declare safety too, but only **field** entries
produce `ignorableFields` patterns: unknown values of known fields still use the reader's explicit
fallback policy, never a header-directed substitution.

Schema inventory tokens identify fields (`field:path`) and enum/literal members (`value:path=<JSON value>`).
An array element uses `*`; a discriminated branch uses `[type=molecule]`, for example
`value:pages.*.objects.*[type=molecule].bonds.*.display.bondStyle="wavy"`. A future feature adding that
member must add its introduction entry, plus tests using that feature and a document without it.
New object types need entries for their discriminator and fields, including nested fields. A field
with a default that is always serialized counts as present; use optional fields and omit unused
values when an older app must still accept plain files.

Open metadata also needs explicit semantic feature entries when a new key/value needs a newer app.
For example, an introduced style preset ID inside `style` can use a `value:` token with
`schemaTracked: false`; its string is not a Zod enum. Such entries still participate in minimum
version calculation. They require usage tests because arbitrary metadata has no schema inventory.

`documentCompatibility.test.ts` compares the complete current schema inventory with the frozen
released schema. A new schema field, object discriminator or enum/literal member without a table
entry or without an explicit `ignorable` declaration fails the test. Schema-tracked stale entries
also fail. Every introduction must follow 1.1.1.

**At this branch's starting point the drawing schemas were identical to tag `v1.1.1`.** The initial
table therefore contains only the version envelope and internal preservation state, not invented
1.2 drawing features. Existing `conditionsTextObjectIds`, bond stereo `either`, and the current
style IDs already occur in 1.1.1. Subsequent 1.2 feature slices must register their actual additions
when integrated. Synthetic registry tests cover optional fields, new bond-style enum values,
preset IDs, object branches, multiple simultaneous features and numeric version ordering.

Ordinary saves inspect the registered feature paths rather than re-validating every atom just to
compute the minimum. Already validated patch-engine documents retain their fast save path.

## Ignorable field pattern syntax

Header patterns use the schema inventory's field paths without the `field:` prefix. For example:

```json
{
  "formatVersion": "1.3.0",
  "minAppVersion": "1.3.0",
  "ignorableFields": ["pages.*.objects.*[type=molecule].atoms.*.labelHalo"]
}
```

Dots separate exact field names. `*` consumes exactly one **array element**, never an arbitrary
object key or a subtree. An optional `[key=value]` qualifier filters the selected value by an exact
discriminator string; `[type=molecule]` restricts the object branch. Omitting a qualifier covers all
branches at that position. Field/discriminator names use letters, digits, `_`, `$` and `-`, starting
with a letter, `_` or `$`; discriminator values use the same characters without the first-character
restriction. Numeric array indexes, `**`, empty segments, `[]`, and a leading or final `*` are not
allowed. Patterns match an entire field path, with no implicit descendants: the example permits
the unknown `labelHalo` field and its opaque JSON value, not an unknown parent field or sibling.

A malformed list or pattern fails with `NATIVE_INVALID_DOCUMENT` at `ignorableFields`. A declaration
that could match a known field is also malformed unless that field is registered as a newer,
display-only feature. Baseline fields do not belong in this header. Thus a file cannot declare
`pages.*.objects.*[type=molecule].atoms.*.formalCharge` ignorable, even if no atom or charge field
occurs in the payload; omitting the object discriminator does not evade this check. The header
never relaxes known-field types, chemistry enums or structural validation.

Future writers must derive the list from **used** `kind: "feature"` field entries with
`ignorable: true`, rather than hand-maintaining a second list. On re-save, older readers also retain
source patterns for preserved future fields that actually survive reconstruction. Patterns whose
fields were removed or whose array guards failed are omitted. The resulting list is deduplicated
and sorted, and is emitted only for a document that uses post-1.1.1 features.

## Reader API

```ts
import { readSerializedDocument, serializeDocument } from "@chemdraft/chem-core";

const { document, warnings, formatVersion, minAppVersion } = readSerializedDocument(contents);
// Present warnings and version information through the host's existing open-file flow.
const saved = serializeDocument(document);
```

`readDocument(candidate)` accepts already-decoded input and returns the same `NativeDocumentReadResult`.
Each warning carries a stable `code`, a `(string | number)[]` `path`, the `originalValue`, and a
message. `formatVersion` is optional for legacy files; `minAppVersion` is always the effective
minimum. `deserializeDocument` is the existing document-only convenience API and delegates to this
reader; hosts that need to present warnings must use the result-returning API. `parseDocument`,
`validateDocument`, standalone schemas and patch validation remain strict.

The CDXML envelope boundary uses the same writer through
`prepareNativeDocumentForSerializationWithWarnings(validatedDocument)`, which returns file data and
save warnings rather than an active typed document. It must receive an already validated document; `serializeDocument` performs
that validation for general callers. Do not stringify the active model directly for a native save.
`openChemDraftPayload` forwards native warnings and, for explicitly versioned payloads, exposes
`nativeDocumentVersions` so the desktop open flow can report the file's versions.

Unknown visual classifiers that main already degraded to `unknown` continue to open in **all**
files, including unversioned 1.1.x files and same-version files: table alignment and preset,
bracket/graphic kind, and reaction-arrow kind. They now also produce a named warning and preserve
the original value for re-save. This does not require a newer version declaration.

The same backwards-acceptance rule applies to main's chemistry classifiers: bond order, molecule
`structureFormat`, superatom `expandedStructureFormat` (both molecule metadata and standalone
superatoms), reaction `mappingState`, mechanism `arrowKind`, and electron `markKind`. Unrecognized
**strings** become the existing visible `unknown` state, with `NATIVE_CHEMISTRY_ENUM_FALLBACK`
carrying the path and original value. This is not permission to infer chemistry from the fallback.
Malformed enum types still fail. Strict schemas and patch validation do not perform degradation.

Other forward tolerance is enabled when `formatVersion` or `minAppVersion` declares a version newer
than the current reader. Unversioned files retain existing legacy migrations and strict unknown-key
handling. Unknown fields never justify repairing wrong types or broken known structures. Chemistry
enums outside the explicit legacy allowlist remain strict.

## Preservation and fallbacks

Unknown fields, including entire nested objects, are removed from the active typed model and kept
as JSON data in **in-memory-only** `document.compatibility.nativeExtensions`. Saving removes that
bookkeeping key and reconstructs the original fields in their original locations. JSON values are
preserved by meaning, not by whitespace or key ordering. Clone, patch, undo and redo state retain
the bookkeeping because it is part of the validated, JSON-cloneable document model.

Paths use unique stable IDs wherever the active element has one (including pages, objects, atoms,
bonds, table rows and columns). Moving or reordering those elements keeps future data attached to
the same identity; deleting an owner never resurrects it. Ambiguous duplicate IDs are not used.
Explicitly replacing a degraded value takes precedence over the preserved original.

Arrays without unique IDs (cells, text spans, visual effects and reaction components) carry a read
fingerprint: length and a content hash for every element's normalized known fields. Exact canonical
content is checked too, so even a hash collision cannot misattach data. Fingerprints are captured
after defaults and visual fallbacks, before installing the preservation state. They ignore JSON
object-key order. All guards are checked against the known active model before any future fields
are restored. An inserted, deleted, reordered or edited array loses its preserved entries rather
than restoring by numeric position. Unchanged arrays round-trip. Old in-memory positional state
without fingerprints is also dropped rather than guessed. Cell guards also record table column IDs
in order, so reordering columns cannot move preserved cell data to another column even when the
known cell contents are identical.

Each affected array produces `NATIVE_EXTENSION_DATA_DROPPED`, naming its owning object/path and
explaining that newer-version data was dropped because the array was edited. Deleted identities
also report a drop. Save warnings are logged and returned by
`serializeDocumentWithWarnings(document)` as `{ contents, warnings }` and by
`prepareNativeDocumentForSerializationWithWarnings(validatedDocument)` as `{ value, warnings }`.
The existing convenience functions retain their return types and log the same warnings. The CDXML
envelope writer forwards them in its export result, including the desktop native-save payload.

Warnings have these named codes:

| Code | Behavior |
| --- | --- |
| `NATIVE_UNKNOWN_FIELD_PRESERVED` | Keep unrecognized JSON data for re-save. |
| `NATIVE_BOND_STYLE_FALLBACK` | Unknown bond display style draws as a plain bond; preserve its original value. |
| `NATIVE_STYLE_PRESET_FALLBACK` | Unknown molecule or document drawing preset ID uses the native default; preserve its ID and explicit numeric style settings. |
| `NATIVE_VISUAL_ENUM_FALLBACK` | Use an explicit safe visual fallback and preserve the original value. |
| `NATIVE_CHEMISTRY_ENUM_FALLBACK` | Retain main's legacy `unknown` chemistry state, warn with the original value/path, and preserve that value for save. |
| `NATIVE_EXTENSION_DATA_DROPPED` | Save warning: omit preserved data whose array changed or whose identity was deleted; never attach it to a different element. |

Visual fallbacks are allowlisted, not a blanket enum catch: bond-side placement becomes automatic,
table alignment and preset become unknown, reaction-arrow/bracket/graphic
kinds become unknown, and page preset becomes custom with its pixel dimensions intact. Unknown
paints and arrowhead markers become none; unknown effects become invisible known effects. Cosmetic
line settings, text script and table formatting have defined defaults. Unsupported codecs, units
or structural revisions without a safe interpretation fail instead of guessing.

Unknown fields directly on atoms and bonds fail closed unless the newer file's own
`ignorableFields` contains a matching pattern. The same rule covers molecule-level fields and
chemistry containers, superatoms/S-groups, R-groups and reaction components/roles. Unlisted fields
produce `NATIVE_UNSUPPORTED_CHEMISTRY`, naming the field/path and explaining that it was not declared
ignorable. A listed unknown display field is removed from the active model and preserved with the
same stable-identity and array-fingerprint rules described above. There are no magic safe names:
even `visualDecoration` requires a declaration on a chemistry object. A new chemistry field cannot
become acceptable just by avoiding a list of chemistry-related names; future writers must never
mark chemistry-bearing additions ignorable.
Unknown fields on purely visual graphics, text styling and page decoration remain preservable in
newer files.

Chemistry-bearing unknown values outside the legacy enum allowlist fail: stereo intent, atom kind,
reaction role, query semantics and label bond-side meaning are never substituted. Existing elements,
atom identity, known orders, charges, isotope/radical state, stereo,
coordinates and reaction components are unchanged by visual degradation. A future document object
type is refused because an older reader cannot establish whether it carries chemistry. Errors use
`NativeDocumentReadError`, naming the `code`, `path` and `originalValue`; chemical refusals use
`NATIVE_UNSUPPORTED_CHEMISTRY`.

The preserving native writer restores original enum strings exactly. CDXML embeds that same native
data and warns with `cdxml.native_enum_payload_only` for preserved enum values its visible vocabulary
cannot express. Unknown-order bonds use `Order="any"` in visible CDXML, with
`cdxml.unknown_bond_order`, never a single-bond guess. Removing the native payload therefore still
leaves an unknown query bond. Binary CDX export remains unimplemented and unavailable.

Calculations never interpret an unknown bond as single. Native graph metadata omits formula and
average/exact mass with `native.unknown_bond_order`; native SMILES export refuses. MOL export keeps
type 8 (any) with a warning, and engine-facing MOL writers refuse. Desktop analysis already
declines before creating a worker. Direct RDKit analysis also reads the engine's query/unspecified
bond evidence before deriving composition or descriptors and returns `unsupported` for every
requested method, with no numeric/identifier payload. This covers the legacy formula/mass adapter
and CLI/MCP analyze, including `C~C`; unrequested methods remain `not-requested`. Unknown structure
encodings are never parsed as another format; when a molecule has an explicit native graph, that
graph remains the source of calculations. Reaction mapping and mechanism annotations do not supply
molecular bond orders to the calculation engines.

While any preserved data remains active, saving conservatively retains the source minimum and any
newer format contract. The reader cannot infer the introduction version of a feature it does not
understand. If the source omitted its minimum, its newer format revision supplies a conservative
floor. Once those values are explicitly replaced or their owners deleted, the known-feature table
determines the minimum again.

## Verification and integration

The desktop and CLI call `readNativeDocumentContents` in `document-workflow-core`, injecting
`openChemDraftPayload` as the native JSON/CDXML-envelope decoder. That decoder calls the tolerant
chem-core reader. The shared workflow records missing label bond sides while retaining the entire
read result, including preservation state, named warnings and version information. No second
headless parser or desktop import is involved; MCP calls the CLI module in-process.

Desktop File Open, recent/OS opens, native and browser drops, and browser file uploads converge on
`openDocumentContentsNow`. Once the resolved document is installed, it calls
`notifyNativeDocumentCompatibility` exactly once. Session restore calls the same notifier once per
installed tab, after installing the restored histories; a skipped fresh-start session shows no
notice. Activating an already-open tab shows no new notice. A visible-CDXML conflict choice is
resolved first, so an unused newer embedded document cannot trigger a notice for the visible subset.
The app has no whole-native-document clipboard reader: its private clipboard payload is a selection
of objects with a separate contract.

The notifier uses the reader's newer-file rule: compare the resolved document's `minAppVersion`
numerically with `NativeDocumentReaderVersion`, **or** its `formatVersion` with
`NativeDocumentFormatVersion`. If either is greater it uses the existing document-owned native
message-box path (`owner: "document"`, one OK button) on both macOS and Windows:
“This file was made with a newer ChemDraft (x.y). Some features may not show. Update to keep them.”
The displayed version is the file's full `minAppVersion` when present, otherwise its `formatVersion`
(the current format revisions use app-version numbering). Named native warnings, including paths and original
values, go to the console log. The existing file warning report retains them too. Older and
same-version files show no compatibility message, and a newer minimum or format-only newer file
still shows a message when there are no fallback warnings.

CLI `render-document` and MCP `render_document` add `minAppVersion` and structured
`documentWarnings` to their JSON results, including failures after a successful read. Legacy input
reports the effective `1.1.1` baseline and an empty warning list. Existing `warnings` strings and
`exportWarnings` continue to include read warnings. There is no interactive headless prompt or
extra stdout output. App Save, Save As, session autosave and CLI/MCP ChemDraft exports use the
preserving serializer/envelope writer, so normalization and unrelated edits retain future content
and its source minimum.

The frozen fixture is under `packages/chem-core/src/__fixtures__/v1.1.1/`, copied from commit
`6be9bb8eb040d99dd5e5be0d4fff06382ec0a7d2` (tag `v1.1.1`), including its schema dependencies.
It is test-only and must never become a production reader.

Tests prove released-schema acceptance, existing serializer hashes, migrations, preservation across
open/save and edits, named degradation/drop warnings, unversioned and same-version visual
regressions, insertion/deletion/reordering of arrays, strict malformed-input rejection, and chemical
refusals. The visual regression was also checked against the actual `schemas.ts` and
`deserializeDocument` from main commit `78f82a1e`: the same unversioned file opens with all five
visual classifiers degraded. The test-only OpenChemLib oracle in
`packages/ocl-adapter/src/nativeDocumentCompatibility.test.ts` checks canonical isomeric SMILES,
formula, charge, stereo and counts before and after opening and saving. Engine-free tests also
check isotope/radical and coordinate preservation.

Integration verification must exercise native Open/Save, session restore and compatibility notices
on both macOS and Windows, together with the repository verification gauntlet.
