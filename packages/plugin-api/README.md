# @chemdraft/plugin-api

Defines public plugin API types, Zod-backed manifest schemas, permission names, contribution types, command context interfaces, plugin storage contracts, proposed-patch envelopes, and recognition result types.

This package must not contain app-specific implementation code or direct document mutation logic.

Plugin contribution ids are namespaced by surface: `plugin.<pluginName>.<action>` for commands,
`menu.<pluginName>.<action>` for menus, `panel.<pluginName>.<name>` for panels, and
`analyzer.<pluginName>.<name>` for analyzers. Analysis-record envelopes are runtime-validated at the
host boundary; their domain-specific `payload` remains opaque to the SDK.

For compatibility with the already-packaged standalone NMR plugin, manifest parsing accepts a legacy
`plugin.<pluginName>.<name>` analyzer id and immediately normalizes it to the canonical `analyzer.*`
form. Commands, menus, and panels do not have this compatibility exception.
