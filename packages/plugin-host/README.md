# @chemdraft/plugin-host

Owns plugin manifest handling, command registration, permission enforcement, plugin storage scoping, and lifecycle behavior.

This package validates trusted manifests, registers command-backed plugin contributions, enforces declared permissions, scopes plugin storage, queues proposed document patches for host/user approval, and forwards `document.write` patches only from the owning plugin's active command invocation. Image acquisition is similarly limited to an `image.read` plugin's active command and enforces the 25 MB / 8192-pixel host limits before bytes reach plugin code.

API 0.1.16 adds optional `MoleculeBond.stereo: "either"` for E/Z-unspecified double bonds.
Preserve it when copying bonds; it is valid only on double bonds.

API 0.1.15 exposes optional `chemistry.embed3d`, `chemistry.minimize3d`, and `chemistry.flatten3d`
only to an active command from a plugin that declares `chemistry.compute`. The host runs them in its
in-process RDKit WASM worker, validates component and timeout limits, signs each model's atoms and
bonds so plugins may alter coordinates but not the chemical graph, and cancels work when the command
ends. Flattening returns objects rather than mutating the document; a plugin must use its separately
gated `document.write` patch capability to insert them. The host refuses interfragment minimization
for a single component and refuses flattening when stereochemistry would not survive.

API 0.1.6 also gates local structure recognition on `image.read`, `ml.inference`, `model.load`, and
`native.execute`, and accepts only bytes the host handed to that same command invocation.

API 0.1.8 gates `tools` on both `assistant.run` and `native.execute`, including a permission check
on every method call. Manifests declaring `assistant.run` without `native.execute` are refused.

Registration is transactional across the shared command registry: all command ids are preflighted,
partial registration is rolled back, and uninstall removes only commands still owned by that plugin.

API 0.1.10 accepts `invokeCommand(commandId, { input })` for panel controls. The host validates and
snapshots the input, requires the invoked plugin to declare its `panelId`, and delivers it as
`context.input` only for that invocation. Reports may bind prompt, select, and action controls only
to commands declared and registered by the reporting plugin.

Direct writes enforce an invocation's initial selection plus its accepted insertions. Flat `batch`
patches (1–256 operations) are checked as a whole before application. `invokeCommand(commandId,
{ writeSelection })` lets an embedding host pass a selection snapshot captured at Send; otherwise
the host snapshots only `getActiveDocument().selection.objectIds` at invocation start, without
calling the plugin-visible selection provider. `writePatchOps` flattens a validated batch.

Canvas overlays are registered only with `ui.canvas`, owned command references, and an overlay id
unique across registered plugins. `listCanvasOverlays()` returns `{ pluginId, overlay }` entries.
An embedding host can supply `overlays.setStatus(pluginId, overlayId, text)`; the capability
re-checks permission, ownership, and the 120-character limit before forwarding each call. Without
a sink the capability rejects with a specific error. Overlay input is accepted only for an overlay
contributed by the invoked command's plugin, including invocation through the shared registry.

API 0.1.11 adds the optional embedding sink `overlays.setTranscript(pluginId, overlayId, entries)`.
The host snapshots and validates entries (50 maximum, 4,000 characters each, 64 KiB UTF-8 JSON total),
checks ownership and `ui.canvas` on each call, and rejects specifically if no transcript sink exists.

API 0.1.14 adds `restoreDraft?: string` to that prompt argument, validates it against the owned
overlay prompt's `maxLength`, and snapshots it before forwarding. Embedding hosts restore once per
call into an empty draft only; restoration never submits or overwrites a draft typed meanwhile.

API 0.1.13 forwards a validated, snapshotted optional fourth argument `prompt: { disabled?: boolean }`
to the `overlays.setContent` embedding sink. Hosts replace the prompt's disabled flag on every call;
an omitted prompt or disabled flag means false. Permission and ownership checks remain unchanged.

API 0.1.12 adds optional `overlays.setContent(pluginId, overlayId, sections)` and
`overlays.open(pluginId, overlayId, focus)` embedding sinks. Content is bounded to 20 existing
text/keyValue/actions/image sections and 64 KiB UTF-8 JSON; ids must be unique alongside the overlay's
prompt/select, and commands obey the same ownership rules as panel reports. Both methods recheck
`ui.canvas` and ownership. `open` additionally requires a live command invocation from that plugin;
focus defaults to false. Embedding hosts resolve action metadata from their current content store.
