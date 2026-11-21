# @chemdraft/plugin-api

Defines public plugin API types, Zod-backed manifest schemas, permission names, contribution types, command context interfaces, plugin storage contracts, proposed/direct-patch envelopes and receipts, and recognition result types. API 0.1.7 adds the host-owned `chemistry.structureToName` capability and the `chemicalName` report section.

This package must not contain app-specific implementation code or direct document mutation logic.

API 0.1.26 defines request-bound document access, tool sessions, chemistry and depiction methods,
and active-document notifications. See the [authoring guide](../../docs/plugin-architecture/AUTHORING.md#request-bound-plugin-tools)
for the contracts, permissions, and transport limits.

API 0.1.23 adds bondStyle 'wavy' (single-bond either stereo), exposed through the public
`MoleculeBond` / `MoleculeBondDisplay` types. Set `display.bondStyle: "wavy"` only on a single bond;
its `fromAtomId` is the explicitly unknown stereocentre. Preserve its direction when copying.

API 0.1.19 bounds panel reports with `PluginPanelReportLimits`: finite numbers, bounded strings,
collections and aggregate counts, and at most 128 MiB of UTF-8 JSON. Structure atoms/bonds and
spectrum peaks are capped per figure; their combined size is bounded by the report envelope.
Oversized reports are rejected whole before schema parsing; see
`docs/plugin-architecture/AUTHORING.md` for the limits and measurement.

API 0.1.17 adds optional `MoleculeBond.stereo: "either"` for E/Z-unspecified double bonds.
Preserve it when copying bonds; it is valid only on double bonds.

API 0.1.15 adds optional command-scoped `context.chemistry.embed3d`, `minimize3d`, and `flatten3d`
methods for plugins declaring `chemistry.compute`. They run in the app's in-process RDKit WASM worker
with no process, network, or new permission. `embed3d` makes explicit-hydrogen ETKDGv3 models for
1–8 SMILES components (seed defaults to 42); `minimize3d` accepts only coordinate changes to the
host-signed model and requires `interfragment`, refusing it for a single component; and `flatten3d`
returns native 2D molecule objects with 3D-derived stereo, without inserting them. The methods are
available only during the plugin's own command. See `docs/plugin-architecture/AUTHORING.md` for
limits, refusal behavior, patch insertion, and the energy honesty rule.

API 0.1.14 adds optional `prompt.restoreDraft` to `overlays.setContent`. The host restores it once
per call into an empty draft only, never overwrites typed text, and never sends it. The string must
fit the contributed prompt's `maxLength` (at most 20,000); the prompt object remains strict.

API 0.1.13 adds optional `prompt: { disabled?: boolean }` to `overlays.setContent`. The prompt
object is strict; every call replaces the disabled state, defaulting to false when omitted.

API 0.1.12 adds `overlays.setContent({ overlayId, sections })` (text, keyValue, actions, image;
20 sections and 64 KiB UTF-8 JSON maximum) and command-scoped `overlays.open({ overlayId, focus? })`.
Both require `ui.canvas` and overlay ownership. Content reuses the panel report schemas and action
rules; control ids also cannot collide with the permanent prompt/select. `showPanelLink: false`
on an overlay contribution hides its optional panel shortcut. Plugins without panels have no shortcut.

API 0.1.11 adds `overlays.setTranscript({ overlayId, entries })`: up to 50 role/text entries,
4,000 characters per text, and 64 KiB of UTF-8 JSON for the entries array. Roles are `user`,
`assistant`, `tool`, `notice`, and `error`. This replaces the owned overlay's transcript; an empty
list clears it. The capability requires `ui.canvas`.

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

API 0.1.16 adds optional positive integer isotope mass numbers to native document atoms.
Native molecule objects and document patches preserve isotope masses; hydrogen-2/3 use D/T elements.

API 0.1.22 adds optional name-to-structure `source`, `matchedName` and `matchedCas` provenance.
API 0.1.20 adds optional `tableStyle.autoColumnMinEm`, the minimum auto column width in em.

API 0.1.21 adds optional `chemistry.properties` (RDKit source composition and masses, gated by
`chemistry.compute`) and `extraTools` on `assistant.createToolSession`. A worker registers
`onAssistantToolCall(context, call, signal)` to handle its own session's tools. See
`docs/plugin-architecture/AUTHORING.md` for validation, cancellation, and result limits.

API 0.1.25 additively exposes native bracketUsage, repeatCount and molecule-scoped crossingBondIds through DocumentObject and ChemDraftDocument. Legacy repeatUnit remains supported.

API 0.1.24 includes binary CDX import/export and optional reaction `arrowObjectIds`/`plusObjectIds`;
shared scheme arrows and plus signs are referenced by id, never copied.

### Request tool sessions in 0.1.26

Open a session from the command that began the request. Supply `definitions` for the tools your
worker handles and `hostTools` for any published host tools you want to include. The plugin must
declare every selected host tool's permissions, including `chemistry.compute` for verified writes.
Names are unique across the two lists. Only the opening invocation may close the session. Ending the
request also closes its sessions and cancels calls. A tool definition may set `readOnly: true` to remove write
capabilities for that call, including when its plugin has a write grant.

The catalog supports up to 32 tools, a 128 KiB UTF-8 catalog and 16 KiB per plugin schema.
Use an object-root schema. Supported types are object, array, string, number, integer, boolean and
null. All accept `description` and `enum`. Objects accept `properties`, `required` and boolean
`additionalProperties` (default true). Arrays require `items` and accept `minItems` and `maxItems`.
Strings accept `minLength` and `maxLength` in Unicode code points. Numbers accept inclusive
`minimum` and `maximum`. The host checks arguments against these constraints before dispatch.

During a request tool call, `documents.getActiveDocument()` and `selection.getSelection()` each
allow up to 4 MiB of UTF-8 JSON. Larger snapshots reject with error code `limit`. Use
`documents.readRequest()` with a page ID and the returned cursor to paginate document objects.

Return `{ ok: true, value }` from `onToolCall`. A value with valid MCP text or PNG
`content` blocks passes through as a tool result. PNGs must have a valid signature, an IHDR first,
image data in IDAT chunks, and an IEND last. Every chunk must pass its CRC check. PNG dimensions
are capped at 2048 pixels per side and both raw and base64 data are capped at 4 MiB. Other JSON
values are returned as text, with object values also available as `structuredContent`. The complete
response must fit 8 MiB.

### Chemistry and depiction in 0.1.26

`chemistry.inspectStructure` returns the source, RDKit's canonical isomeric SMILES, formula,
heavy-atom count and stereo summary. Stereo indices refer to the source order. Pinned molecule
sources use V3000 and expand supported condensed labels. Inspection declines above 500 heavy atoms
and returns `unavailable` if the RDKit worker cannot initialize.

`chemistry.rings` uses `representation: "both"` by default. It returns `chemicalRings` and
`drawableRings` for the same object revision. Each chemical ring lists its native atom IDs in cycle
order and its bond IDs in edge order. Drawable rings include the renderer key used by
`molecule.style.ringStyles`. Request `"chemical"` or `"drawable"` to receive only that
representation in `rings`. A warning identifies chemical cycles in expanded labels that lack a
complete mapping to drawn IDs.

`depiction.measure` returns page-space bounds for supported objects. Text and attached conditions
include `labelBounds`, and molecules report `atomLabels` by native atom ID. Region queries return
whole-object bounds for intersecting objects. Layout estimates use the canvas's font metrics and
geometry plans. Check `unsupported` for objects without an ink measurement.

`depiction.renderRegion` crops a transparent PNG to the supplied rectangle or the requested object
bounds. The rectangle maps to the requested pixel width and height. Object crops can use stored
frames with a warning when ink bounds are unavailable. Direct PNG results allow up to 4,096 pixels
per side, 4,194,304 pixels total and 2 MiB decoded. The page SVG and decoded picture budget each
allow up to 16 MiB. The tool-session image block limits above also apply when returning a direct PNG
as a tool image.

Both depiction methods allow up to 256 page objects, 2,500 page atoms and 5,000 page bonds. An
optional `preview` applies a validated page-local patch or flat batch of up to 256 operations to a
temporary draft. Preview additions use the caller's proposed IDs. Only a successful request write
returns committed IDs.

`depiction.listStylePresets({ requestId })` lists native drawing presets with bond length,
normal and bold line widths, and atom-label font metrics in canvas units. Its `defaults`
field gives the effective drawing and text defaults of the request document.

`depiction.planStyle({ requestId, pageId, objectIds, presetId?, targetBondLength? })`
returns native `updateObject` operations, the affected IDs, moved electron-mark IDs, and
warnings. Supply the children of any targeted group and the associated electron marks as
explicit IDs. A target bond length overrides a preset's bond length and rescales the graph
around its existing centre. The returned operations address objects individually.

`depiction.planLayout` takes a page and one of four specs in `spec`:

- `row` and `grid` arrange `objectIds` in input order from a top-left `anchor`. Use `gap` and
  optional `wrapWidth` in canvas units. Grids also accept `columns`, `columnGap`, and `rowGap`.
- `reaction` places `reactants` and `products` from an `anchor` on the reaction centreline.
  A component can be a page object ID or `{ ref, smiles }` for a proposed molecule. SMILES
  depiction requires `chemistry.compute` alongside `document.read`. The step accepts
  `arrowKind`, optional `bondLength`, `above` and `below` condition lines, and optional `compoundNumbers` entries of
  `{ component, text }`. Use a page ID or `{ ref }` as the label's component.
- `reactionRows` takes `steps` with those reaction fields and one shared `anchor`, `maxWidth`,
  optional `bondLength`, and optional `gap`. `breakBefore` contains zero-based step indices.
  Reuse a proposed intermediate with `{ ref }`, or an existing intermediate by its page
  object ID. A reused intermediate keeps one drawing even across row breaks.

Both planners accept a validated page-local `preview`. To preview or submit a layout, turn
each returned object into an `addObject` operation with its returned local ID, and turn each
transform into an `updateObject` operation using its `changes` field. Match the
`insertionSources` by local object ID and pass the corresponding batch operation index
and `sourceSmiles` in `expectedStructures`. Write through `documents.applyRequestPatch` to
get the committed IDs and the host's scope and chemistry checks.
