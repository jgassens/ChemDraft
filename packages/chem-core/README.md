# @chemdraft/chem-core

Owns the native document model, schema versions, migrations, validation, serialization, and patch application.

This package must not import UI, Tauri, Ketcher, RDKit, plugin loading, or filesystem APIs.

The MOL writers require an explicit `kekuleBondOrders` map and return `{ contents, warnings }`.
Callers resolve orders through layout-engine; this package cannot depend on it. An empty or partial
map preserves unmapped aromatic bonds as type 4 and returns one warning per ring system, naming its
atoms. Every consumer must surface those warnings through its operation's warning path.
