# Native document versions and forward reading

`packages/chem-core` owns this contract. It is platform-independent, with no filesystem or engine
dependency. CDXML/CDX compatibility is a separate boundary.

## Version envelope and the released reader

The native object-model discriminator remains `schema: "chemdraft.document.v1"`. Newer writers can
also emit two **top-level** stable `major.minor.patch` strings:

| Field | Meaning |
| --- | --- |
| `formatVersion` | The writer's native-file contract revision; currently `1.2.0`. |
| `minAppVersion` | The oldest app that understands the features actually present in the file. |

The schema at tag `v1.1.1` is strict at the root and in nested objects. Consequently the 1.2 writer
omits **both** fields whenever the document needs only 1.1.1 features. It does not add a default
version field to every file. Plain files keep the released serializer's property order and defaults,
and the frozen, test-only 1.1.1 schema parses them. The reader reports an absent `formatVersion` and
an effective `minAppVersion` of `1.1.1` for these legacy files. Existing page-layout and graphic-arc
migrations still apply to legacy files.

When newer features are present, the writer adds `formatVersion` and the computed `minAppVersion`.
An unmodified 1.1.1 app will reject those files; 1.2 cannot retroactively change that released app.
A newer version envelope alone is not a used feature: saving an otherwise plain document removes it.

`NativeDocumentFormatVersion`, `NativeDocumentReaderVersion`, and the baseline version live in
`documentFeatures.ts`. Compare numeric version components, never strings (`1.10.0` follows `1.3.0`).

## One feature introduction registry

`NativeDocumentFeatureVersions` in `packages/chem-core/src/documentFeatures.ts` is the single table
of additions since 1.1.1. Each entry records `introducedIn` and its kind:

- `feature`: a field or enum/literal value that raises the minimum when actually present;
- `envelope`: version information, which does not itself raise the minimum;
- `internal`: preservation bookkeeping, which is reconstructed into file data rather than saved as
  a second copy of that data.

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
entry fails the test. Schema-tracked stale entries also fail. Every introduction must follow 1.1.1.

**At this branch's starting point the drawing schemas were identical to tag `v1.1.1`.** The initial
table therefore contains only the version envelope and internal preservation state, not invented
1.2 drawing features. Existing `conditionsTextObjectIds`, bond stereo `either`, and the current
style IDs already occur in 1.1.1. Subsequent 1.2 feature slices must register their actual additions
when integrated. Synthetic registry tests cover optional fields, new bond-style enum values,
preset IDs, object branches, multiple simultaneous features and numeric version ordering.

Ordinary saves inspect the registered feature paths rather than re-validating every atom just to
compute the minimum. Already validated patch-engine documents retain their fast save path.

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
`prepareNativeDocumentForSerialization(validatedDocument)`, which returns file data rather than an
active typed document. It must receive an already validated document; `serializeDocument` performs
that validation for general callers. Do not stringify the active model directly for a native save.
`openChemDraftPayload` forwards native warnings and, for explicitly versioned payloads, exposes
`nativeDocumentVersions` so the desktop open flow can report the file's versions.

Tolerance is enabled only when `formatVersion` or `minAppVersion` declares a version newer than
the current reader. Unversioned unknown input follows the existing strict/migration path. Unknown
fields are not a reason to repair wrong types or broken known structures.

## Preservation and fallbacks

Unknown fields, including entire nested objects, are removed from the active typed model and kept
as JSON data in **in-memory-only** `document.compatibility.nativeExtensions`. Saving removes that
bookkeeping key and reconstructs the original fields in their original locations. JSON values are
preserved by meaning, not by whitespace or key ordering. Clone, patch, undo and redo state retain
the bookkeeping because it is part of the validated, JSON-cloneable document model.

Paths use stable IDs for identifiable array members (pages, objects, atoms, bonds, table rows and
columns). Moving or reordering an object therefore keeps its future data attached to it. Deleting
an owning object does not resurrect it. Explicitly replacing a degraded value takes precedence over
the preserved original. Arrays without unique IDs use positional paths; replacing/reordering such
an array is an explicit edit to that visual payload.

Warnings have these named codes:

| Code | Behavior |
| --- | --- |
| `NATIVE_UNKNOWN_FIELD_PRESERVED` | Keep unrecognized JSON data for re-save. |
| `NATIVE_BOND_STYLE_FALLBACK` | Unknown bond display style draws as a plain bond; preserve its original value. |
| `NATIVE_STYLE_PRESET_FALLBACK` | Unknown molecule or document drawing preset ID uses the native default; preserve its ID and explicit numeric style settings. |
| `NATIVE_VISUAL_ENUM_FALLBACK` | Use an explicit safe visual fallback and preserve the original value. |

Visual fallbacks are allowlisted, not a blanket enum catch: bond-side placement becomes automatic,
table alignment becomes unknown, table preset becomes three-line, reaction-arrow/bracket/graphic
kinds become unknown, and page preset becomes custom with its pixel dimensions intact. Unknown
paints and arrowhead markers become none; unknown effects become invisible known effects. Cosmetic
line settings, text script and table formatting have defined defaults. Unsupported codecs, units
or structural revisions without a safe interpretation fail instead of guessing.

Chemistry-bearing unknown values always fail: bond order, stereo intent, atom kind, structure
encoding, reaction role, query semantics, electron-mark kind and label bond-side meaning are never
substituted. Existing elements, atom identity, orders, charges, isotope/radical state, stereo,
coordinates and reaction components are unchanged by visual degradation. A future document object
type is refused because an older reader cannot establish whether it carries chemistry. Errors use
`NativeDocumentReadError`, naming the `code`, `path` and `originalValue`; chemical refusals use
`NATIVE_UNSUPPORTED_CHEMISTRY`.

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

The notifier compares the resolved document's `minAppVersion` numerically with
`NativeDocumentReaderVersion`. For a greater minimum it uses the existing document-owned native
message-box path (`owner: "document"`, one OK button) on both macOS and Windows:
“This file was made with a newer ChemDraft (x.y). Some features may not show. Update to keep them.”
The version is the file's full `minAppVersion`. Named native warnings, including paths and original
values, go to the console log. The existing file warning report retains them too. Older and
same-version files show no compatibility message, and a newer minimum still shows a message when
there are no fallback warnings.

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
open/save and edits, named degradation warnings, strict malformed-input rejection, and chemical
refusals. The test-only OpenChemLib oracle in
`packages/ocl-adapter/src/nativeDocumentCompatibility.test.ts` checks canonical isomeric SMILES,
formula, charge, stereo and counts before and after opening and saving. Engine-free tests also
check isotope/radical and coordinate preservation.

The host must wire the result-returning reader into its warning/version UI. Build-stamp changes,
desktop launches and Windows checks belong to the integration work; this package slice does not
change native code or UI.
