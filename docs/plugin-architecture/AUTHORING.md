# Authoring a ChemDraft plugin

A plugin is a TypeScript package that imports **only `@chemdraft/plugin-api`** and exports a manifest
plus command handlers. ChemDraft consumes it as source (the desktop's Vite build transpiles it), so
there is no plugin build step to maintain.

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

Command ids are `plugin.<name>.<action>`, menus `menu.<name>.<action>`, panels `panel.<name>.<name>`.

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

## Extract for distribution

Add an explicit `LICENSE` or `LICENSE.md` to the plugin, commit every file that will ship, then run:

```bash
pnpm plugin:extract -- examples/plugins/<your-plugin>
# → dist/plugins/<name>-<version>.zip
# → dist/plugins/<name>-<version>.zip.sha256
```

Extraction fails closed for a missing license, a dirty or untracked plugin tree, an import outside
the public SDK root, or a relative import that escapes the plugin package. The generated manifest
uses the SDK as a peer dependency, records the clean source commit, and the checksum sidecar makes
the archive independently verifiable. A successful technical extraction does not override the
license terms inside the archive.

To host the extracted plugin elsewhere, merge the core-enablement surface
(`docs/plugin-architecture/CORE-ENABLEMENT.md`) and add one `{ manifest, options }` entry to that
host's `registerBundledPlugins` catalog.
