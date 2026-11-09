# @chemdraft/cdx-compat

Owns CDXML/CDX import, export, intermediate models, unknown-object preservation, and compatibility warnings.

This package must not become the native document model and must not depend on GPL or AGPL code without an explicit project decision.

Native payloads share chem-core's feature-versioned writer and tolerant reader. `openChemDraftPayload`
forwards named native warnings (including `path` and `originalValue`) and exposes
`nativeDocumentVersions` when the payload has an explicit version envelope. The CDXML writer calls
`prepareNativeDocumentForSerialization` after validation, keeping its embedded JSON compact while
restoring future fields and avoiding a second schema pass. See
[the native compatibility contract](../../docs/architecture/native-document-compatibility.md).
