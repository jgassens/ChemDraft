# @chemdraft/plugin-api

Defines public plugin API types, Zod-backed manifest schemas, permission names, contribution types, command context interfaces, plugin storage contracts, proposed/direct-patch envelopes and receipts, and recognition result types. API 0.1.6 adds the host-owned `recognition.recognizeStructure` capability for images returned by `images.requestImage` in the same command invocation.

This package must not contain app-specific implementation code or direct document mutation logic.

API 0.1.6 adds `recognition.recognizeStructure`, limited to an image returned by
`images.requestImage` during the same command invocation and gated on local-inference permissions.

Plugin contribution ids are namespaced by surface: `plugin.<pluginName>.<action>` for commands,
`menu.<pluginName>.<action>` for menus, `panel.<pluginName>.<name>` for panels, and
`analyzer.<pluginName>.<name>` for analyzers. Analysis-record envelopes are runtime-validated at the
host boundary; their domain-specific `payload` remains opaque to the SDK.

For compatibility with the already-packaged standalone NMR plugin, manifest parsing accepts a legacy
`plugin.<pluginName>.<name>` analyzer id and immediately normalizes it to the canonical `analyzer.*`
form. Commands, menus, and panels do not have this compatibility exception.
