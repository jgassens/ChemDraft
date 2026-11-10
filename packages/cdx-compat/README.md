# @chemdraft/cdx-compat

Owns CDXML/CDX import, export, intermediate models, unknown-object preservation, and compatibility warnings.

This package must not become the native document model and must not depend on GPL or AGPL code without an explicit project decision.

Native payloads share chem-core's feature-versioned writer and tolerant reader. `openChemDraftPayload`
forwards named native warnings (including `path` and `originalValue`) and exposes
`nativeDocumentVersions` when the payload has an explicit version envelope. The CDXML writer calls
`prepareNativeDocumentForSerializationWithWarnings` after validation, keeping its embedded JSON compact while
restoring future fields and avoiding a second schema pass. Export warnings include
`NATIVE_EXTENSION_DATA_DROPPED` when edits invalidate preservation of identity-free arrays. See
[the native compatibility contract](../../docs/architecture/native-document-compatibility.md).

Legacy unknown chemistry enum strings survive exactly in the embedded native payload; the visible
CDXML layer reports `cdxml.native_enum_payload_only` when it cannot represent them. Unknown-order
bonds write `Order="any"` with `cdxml.unknown_bond_order`, never a single-bond guess. Binary CDX
export remains unavailable.
