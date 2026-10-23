# @chemdraft/plugin-api

Defines public plugin API types, Zod-backed manifest schemas, permission names, contribution types, command context interfaces, plugin storage contracts, proposed/direct-patch envelopes and receipts, and recognition result types. API 0.1.7 adds the host-owned `chemistry.structureToName` capability and the `chemicalName` report section.

This package must not contain app-specific implementation code or direct document mutation logic.

API 0.1.10 adds declarative `prompt`, `actions`, and `image` panel sections, optional panel
`preferredWindowSize`, and `PluginCommandContext.input`. Prompt, select, section, and button ids must
be unique within a report. Input payloads must be JSON data of at most 4000 serialized characters,
without prototype-polluting keys. Panel controls invoke the contributing plugin's own commands;
the optional input travels through the existing worker protocol without a protocol-version bump.

Document patches support atomic `batch` operations with 1–256 non-batch entries. Direct writes may
insert content and update, move, remove, or reorder only the objects selected when the command
started plus objects inserted by that invocation. Recognition continues to require proposal review.

External-tool wire schemas are checked against Rust-generated JSON in
`apps/desktop/src/externalTools/__fixtures__/wire`. After an intentional wire change, regenerate
with `CHEMDRAFT_UPDATE_WIRE_FIXTURES=1 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml wire_fixtures_are_current`,
then run `pnpm vitest run --configLoader runner packages/plugin-api/src/externalToolsWire.test.ts`.
PR A runs may omit `mcpSessionId` (or pass an empty string); non-empty sessions require PR B.
API 0.1.8 exposes `context.tools` only with both `assistant.run` and `native.execute`; every method
re-checks both permissions. Manifest validation refuses `assistant.run` without `native.execute`
because external tools spawn processes.

API 0.1.7 adds `chemistry.structureToName`, limited to a molecule in the current selection and gated
on `chemistry.compute`, `native.execute`, and `selection.read`. API 0.1.6 adds `recognition.recognizeStructure`, limited to an image returned by
`images.requestImage` during the same command invocation and gated on local-inference permissions.

Plugin contribution ids are namespaced by surface: `plugin.<pluginName>.<action>` for commands,
`menu.<pluginName>.<action>` for menus, `panel.<pluginName>.<name>` for panels, and
`analyzer.<pluginName>.<name>` for analyzers. Analysis-record envelopes are runtime-validated at the
host boundary; their domain-specific `payload` remains opaque to the SDK.

For compatibility with the already-packaged standalone NMR plugin, manifest parsing accepts a legacy
`plugin.<pluginName>.<name>` analyzer id and immediately normalizes it to the canonical `analyzer.*`
form. Commands, menus, and panels do not have this compatibility exception.

API 0.1.10 also adds one optional `canvasOverlays` contribution per plugin, requiring the
non-dangerous `ui.canvas` permission. An overlay declares a namespaced `overlay.<plugin>.<name>`
id, title (1–80 characters), base64 SVG/PNG `icon` URI (at most 64,000 characters), an owned
`commandId`, `prompt`, and optional `defaultCorner` (defaults to `bottom-right`) and
`requiredPermissions`. The `prompt` value is a `PluginPanelPromptSectionSchema` object,
including `kind: "prompt"`; its command and optional select command must also belong to the
plugin. `context.overlays.setStatus({ overlayId, text })` requires `ui.canvas`, accepts at most
120 characters, and clears the status with an empty string. Overlay commands receive
`context.input.source = "overlay"` with the owned `overlayId`.
