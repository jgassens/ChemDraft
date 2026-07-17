# Plugin development

ChemDraft hosts bundled plugins through a persistent, domain-neutral runtime.
Start with the manifest types in `@chemdraft/plugin-api` and registration in
`@chemdraft/plugin-host`; the full runtime is documented in
[`../architecture/plugin-runtime.md`](../architecture/plugin-runtime.md), and the
mass-fragment analyzer (`examples/plugins/mass-fragment-demo`) is a complete
worked example in this repo.

## Model in one paragraph

A plugin is a **manifest** (id, version, `apiVersion`, permissions, contributions)
plus **command handlers**. Plugins declare permissions and receive matching
capabilities on the command context — `selection`, `analysis`, `panels`,
`documents` — each present only when its permission is declared (a handler sees
`undefined` otherwise, never a throw). Plugins ship **data, not React**: results
are declarative `PluginPanelReport`s that the desktop renders with core UI.

## Add a bundled plugin

1. Create a package under `examples/plugins/<name>` (`private`, `type: module`,
   `exports` → `./src/index.ts`; depend on `@chemdraft/plugin-api`).
2. Export a `PluginManifest`. Use the id conventions: commands
   `plugin.<name>.<action>`, menus `menu.<name>.<action>`, panels
   `panel.<name>.<name>`. Menu/panel/analyzer contributions must reference a
   contributed command (the host validates this at registration).
3. If the desktop imports the package, add it to `apps/desktop`'s dependencies as
   `workspace:*` (tsc and Vite resolve workspace plugins through that).
4. Register it in `apps/desktop/src/plugins/registerBundledPlugins.ts`:
   `host.registerPlugin(manifest, { commandHandlers, onPanelClosed? })`.

## Guidance

- **Declare permissions** before using a capability; request the minimum.
- **Selection snapshots are immutable copies** — safe to read, cannot mutate host state.
- **Analysis records are session-scoped and plugin-scoped on read**; they never enter the document. Use `proposePatch` (queued for user approval) to change the document.
- **Panels are declarative**; SVG is a string rendered via `<img>` (script-inert). Stamp `report.source` for staleness detection.
- **Long work belongs in a Web Worker** behind the request-id protocol; support `AbortSignal` and `onPanelClosed` cancellation.
- **Commands return `PluginCommandResult`** (`{ ok:false, error }`) or throw — both surface to the user.
- **Bundle third-party data as a separate, attributed asset** with its own license; keep plugin code open-source.

Not yet enabled for third-party (non-bundled) plugins: isolated execution and
gated filesystem/network/native-execution/clipboard access. Bundled plugins are
trusted first-party code.
