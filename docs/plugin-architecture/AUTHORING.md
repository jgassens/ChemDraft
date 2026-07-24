# Authoring a ChemDraft plugin

A plugin is a TypeScript package that imports **only `@chemdraft/plugin-api`** and exports a manifest
plus command handlers. Bundled examples are composed from source by the desktop build; an installable
plugin is compiled into a verified multi-file worker package by `pnpm plugin:package`.

## The one rule

Runtime source may import `@chemdraft/plugin-api` and ordinary npm packages (e.g. `openchemlib`,
`zod`) — **never any other `@chemdraft/*` package.** This is what makes a plugin extractable and
host-portable. `tools/plugin-extract/boundary.test.ts` enforces it in CI; the extraction script
refuses to package a plugin that breaks it.

Everything the API's own signatures reference is re-exported from the SDK, so you never need to reach
into core — e.g. `import type { ChemDraftDocument, DocumentPatch } from "@chemdraft/plugin-api"`.

## Package shape

```jsonc
{
  "name": "@yourorg/plugin-widget",
  "version": "0.1.0",
  "exports": { ".": { "types": "./src/index.ts", "default": "./src/index.ts" } },
  "peerDependencies": { "@chemdraft/plugin-api": "^0.1.0" }
}
```

`apiVersion` in your manifest declares the SDK contract you target (`PluginApiVersion`, currently
`0.1.0`).

## Manifest + registration

Export a validated manifest and register it with the host (the desktop does this in
`registerBundledPlugins.ts`):

```ts
import { parsePluginManifest } from "@chemdraft/plugin-api";

export const widgetManifest = parsePluginManifest({
  id: "org.yourorg.widget",
  name: "Widget",
  version: "0.1.0",
  apiVersion: "^0.1.0",
  entry: "src/index.ts",
  permissions: ["selection.read", "analysis.write", "ui.menu", "ui.panel"],
  contributes: {
    commands: [{ id: "plugin.widget.run", title: "Run Widget", requiredPermissions: ["selection.read"] }],
    menus: [{ id: "menu.widget.run", title: "Run Widget", commandId: "plugin.widget.run", location: "analyze", requiredPermissions: ["ui.menu"] }],
    panels: [{ id: "panel.widget.result", title: "Widget Result", requiredPermissions: ["ui.panel"] }]
  }
});
```

Command ids are `plugin.<name>.<action>`, menus `menu.<name>.<action>`, panels
`panel.<name>.<name>`, and analyzers `analyzer.<name>.<name>`. The parser normalizes the older
`plugin.<name>.<name>` analyzer-id spelling only so already-built NMR packages remain loadable; new
source must use the canonical analyzer namespace.

## Command handler

A handler receives a `PluginCommandContext` (plugin identity, permission-gated `selection` / `analysis`
/ `panels` APIs) and returns a value or a `{ ok: false, error }` result. Render output as a declarative
`PluginPanelReport` — the host renders it; plugins never ship React:

```ts
const runWidget: PluginCommandHandler = async (context) => {
  const selection = await context.selection?.getSelection();
  await context.panels?.showReport("panel.widget.result", {
    title: "Widget",
    sections: [{ kind: "keyValue", title: "Result", rows: [{ label: "Atoms", value: String(selection?.objectIds.length ?? 0) }] }]
  });
  return { ok: true };
};
```

Report section kinds: `text`, `keyValue`, `table`, `svg`, and `linkedFigure` (an interactive
spectrum/structure figure with a generic primary/alternative method model).

## Worker entry

A plugin that ships as an **installable package** also exports a worker entry at `src/workerEntry.ts`.
It runs inside the plugin's own Web Worker, wires whatever services the command handlers need, and
hands the finished registration to `runPluginWorker`:

```ts
import { runPluginWorker } from "@chemdraft/plugin-api";

import { widgetManifest } from "./manifest";
import { createWidgetRegistration } from "./register";

runPluginWorker({
  manifest: widgetManifest,
  commandHandlers: createWidgetRegistration().commandHandlers
  // onPanelClosed?: cancel in-flight work when your panel closes
});
```

The plugin owns this file because only the plugin knows how to construct its own runtime (the NMR
predictor, for instance, must first stand up its nested OpenChemLib worker). Two rules:

- it has a **top-level side effect**, so never re-export it from `src/index.ts` — importing your public
  surface must not start a worker runtime;
- it obeys the one rule above: `@chemdraft/plugin-api` plus your own relative modules. In particular
  import your own files relatively (`./providers/…`), never by your package's own name.

Installed worker responses carry a restrictive CSP: code, nested workers, WASM, and reference data
may load from the package's own origin, but arbitrary external `fetch`, XHR, WebSocket, and remote
module loads are blocked. `network.fetch` remains a declared future capability; it does not grant an
ambient browser network primitive. External access must eventually travel through a permission-gated
host broker rather than bypassing the command context.

## Distribute

Two artifacts, both fail-closed on a missing license, a dirty or untracked plugin tree, an import
outside the public SDK root, or a relative import that escapes the plugin package. Add an explicit
`LICENSE` or `LICENSE.md` and commit every file that will ship, then run either:

```bash
# Built, installable package — the zip a user downloads and the app loads into a Worker.
pnpm plugin:package -- examples/plugins/<your-plugin>
# → dist/plugin-packages/<name>-<version>.zip          {manifest.json, entry.js + chunks/assets, LICENSE}
# → dist/plugin-packages/<name>-<version>.zip.sha256

# Source distribution — for hosts that compose plugins at build time.
pnpm plugin:extract -- examples/plugins/<your-plugin>
# → dist/plugins/<name>-<version>.zip
# → dist/plugins/<name>-<version>.zip.sha256
```

`plugin:package` builds `src/workerEntry.ts` (override with `--entry`) into an ES-module worker and
emits its chunks and assets alongside it. Its `manifest.json` is your manifest plus the built entry
filename and provenance — enough for a host to identify, permission, and load the plugin with no
ChemDraft monorepo present.

**A built package is relocatable but not a single file.** Its internal references (nested workers,
code-split chunks, data assets) resolve relative to each module's own URL, so a host must keep the
unpacked files **co-located** and serve them from a real directory URL on its **own origin**. A blob
URL cannot host one: a blob has no siblings, so nothing relative can resolve. See
`reports/0030` in the planning workspace for the measured evidence.

The checksum sidecar makes either archive independently verifiable. It is an **integrity** check, not
a signature and not a trust decision — and a successful technical build does not override the license
terms inside the archive.

To host the *extracted source* elsewhere, merge the core-enablement surface
(`docs/plugin-architecture/CORE-ENABLEMENT.md`) and add one `{ manifest, options }` entry to that
host's `registerBundledPlugins` catalog.
