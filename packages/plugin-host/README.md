# @chemdraft/plugin-host

Owns plugin manifest handling, command registration, permission enforcement, plugin storage scoping, and lifecycle behavior.

This package validates trusted manifests, registers command-backed plugin contributions, enforces declared permissions, scopes plugin storage, queues proposed document patches for host/user approval, and forwards `document.write` patches only from the owning plugin's active command invocation. Image acquisition is similarly limited to an `image.read` plugin's active command and enforces the 25 MB / 8192-pixel host limits before bytes reach plugin code.

API 0.1.6 also gates local structure recognition on `image.read`, `ml.inference`, `model.load`, and
`native.execute`, and accepts only bytes the host handed to that same command invocation.

API 0.1.8 gates `tools` on both `assistant.run` and `native.execute`, including a permission check
on every method call. Manifests declaring `assistant.run` without `native.execute` are refused.

Registration is transactional across the shared command registry: all command ids are preflighted,
partial registration is rolled back, and uninstall removes only commands still owned by that plugin.

API 0.1.10 accepts `invokeCommand(commandId, { input })` for panel controls. The host validates and
snapshots the input, requires the invoked plugin to declare its `panelId`, and delivers it as
`context.input` only for that invocation. Overlay input is refused until canvas-overlay contributions
are supported. Reports may bind prompt, select, and action controls only to commands declared and
registered by the reporting plugin.

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
