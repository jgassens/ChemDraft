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
`0.1.6`). API 0.1.6 adds host-owned `context.recognition.recognizeStructure`; plugins that use it
should declare `^0.1.6`. API 0.1.5 added command-scoped `context.images.requestImage`, 0.1.4 added
`context.documents.applyPatch`, and 0.1.3 added the host-owned `context.dialogs.promptText`
capability. Existing `^0.1.0` through `^0.1.5` packages remain compatible.

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

## One-line text prompts

A plugin declaring `ui.panel` may ask for one line of text from inside one of its own command
handlers. The desktop renders core-owned modal chrome and shows the manifest-declared name and id of
the plugin that invoked it. The host guarantees which plugin made the request; it does not attest that
the plugin's self-declared display name is honest:

```ts
const answer = await context.dialogs?.promptText({
  title: "Insert from chemical name",
  label: "Chemical name",
  placeholder: "e.g. 2-acetyloxybenzoic acid",
  submitLabel: "Convert",
  maxLength: 500
});

if (answer?.status === "submitted") {
  // answer.value is exactly what the user typed; trim or otherwise interpret it here if appropriate.
}
```

`dialogs` is absent without `ui.panel`. `promptText` rejects outside that plugin's active command
invocation, and each command invocation may call it at most once (including after its first prompt has
settled). Submit is disabled for an empty field; cancellation returns `{ status: "cancelled" }`.
Disabling, unregistering, or terminating the plugin while its prompt is open also cancels it.

## Host-owned image acquisition

A plugin declaring `image.read` may request a user-selected image only while one of its own commands
is executing:

```ts
const result = await context.images?.requestImage({
  title: "Recognize Structure from Image",
  // Omit `sources` to offer every provider this host currently has.
  sources: ["file", "screenRegion"]
});

if (result?.status === "provided") {
  const { mediaType, bytes, width, height, source, fileName } = result.image;
}
```

`images` is absent without `image.read`, and a retained method rejects after its command ends. The
result is `provided`, `cancelled`, or `unavailable` with a reason. Image bytes are a `Uint8Array`, not
base64: typed arrays cross the worker transport through structured clone without base64's expansion.
The host rejects images larger than 25 MB or 8192 pixels on either side. Supported media types are
PNG, JPEG, TIFF, and WebP. A plugin receives bytes only after the user explicitly chooses a file or
screen region; this permission does not grant arbitrary filesystem or whole-screen access.

## Host-owned structure recognition

API 0.1.6 exposes local image recognition without giving a plugin model installation or native-call
authority. Declare all four capability permissions — `image.read`, `ml.inference`, `model.load`, and
`native.execute` — then pass the exact image returned by `requestImage` during the same command:

```ts
const selected = await context.images?.requestImage({
  title: "Recognize Structure from Image",
  sources: ["file", "screenRegion"]
});
if (selected?.status !== "provided") return;

const recognized = await context.recognition?.recognizeStructure(selected.image);
if (recognized?.status === "recognized") {
  // Validate warnings and submit recognized.result.proposedPatch with documents.proposePatch.
}
```

`recognition` is absent if any one permission is missing. The host rejects an image constructed by the
plugin, modified after selection, retained from another invocation, or used after the command ends.
If the local engine is absent, the host identifies the requesting plugin and offers installation; the
plugin cannot request a download and must not declare `model.download`. Declining or cancelling gives
`engineNotInstalled`. Recognition failures are typed, and successful results include nullable overall
confidence, atom/bond confidence, elapsed time, and engine/model provenance.

MolScribe results remain uncertain inferred output. A recognizer must validate the MOL/SMILES through
available chemistry before proposing it, preserve the source-image preview and applicable uncertainty
warnings, and use `documents.proposePatch`. It must never use `documents.applyPatch` for recognition.

## Direct document writes versus proposals

A plugin declaring the dangerous `document.write` permission may apply a patch directly while one of
its own commands is executing. The host validates the same strict `ProposedDocumentPatch` envelope as
`proposePatch`, commits it through the normal document patch/history path, selects objects inserted by
the patch, and returns a strict `{ applied: true, objectIds: string[] }` receipt:

```ts
const receipt = await context.documents.applyPatch?.({
  reason: "Deterministic structure generated from the name the user entered",
  patch: { op: "addObject", pageId, object: molecule }
});
```

`applyPatch` is absent without `document.write`, and a retained method reference rejects after the
command invocation ends. The direct write is one undo entry labelled with the plugin and command; it
does not open the proposal review tray/window.

Use `applyPatch` only when the user supplied the input and the result is deterministic, such as a
name-to-structure command acting on text entered in the host prompt. Use `proposePatch` for uncertain
or inferred output that needs inspection. Image recognition remains a proposal flow: low confidence,
stereochemistry, charge/radical, and abbreviation uncertainty require explicit user approval before
insertion. Holding `document.write` does not relax that recognition rule.

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

## Official catalog, installs, and updates

Plugins do not advertise themselves to ChemDraft, self-update, or carry install/update URLs in their
manifests. ChemDraft compiles a fixed official-plugin catalog into the desktop host. The catalog owns
each plugin's id, display name, description, exact GitHub repository, and release asset stem; there is
no network discovery. The **Available** section of **Add or Remove Plugins** lists every catalog entry
that is not installed and offers a one-click **Install** action.

The desktop host fetches the latest stable release only from that catalog entry's repository and
requires the exact versioned ZIP and `.zip.sha256` asset names. It applies the same redirect-host,
download-size, checksum, archive, manifest, API, permission, and worker-handshake gates used by
manual package installs and updates. Before either an official install or an update is committed, the
ordinary package-review screen discloses permissions and provenance. The plugin worker remains under
its same-origin-only CSP and receives no network or filesystem capability for this workflow.

Update checks and installs are user-initiated. ChemDraft first shows an available version, then
downloads and inspects the package for a second review screen; only an explicit **Update** action
starts the replacement transaction. The active package stays intact until the candidate has passed
its worker handshake and the new install record commits.

The official catalog contains `org.chemdraft.nmr.predictor`, published from
`jgassens/ChemDraft-NMR-Plugin` as a stable `vX.Y.Z` GitHub release containing both
`nmr-predictor-X.Y.Z.zip` and `nmr-predictor-X.Y.Z.zip.sha256`, and
`org.chemdraft.opsin.nameToStructure`, published from `jgassens/ChemDraft-OPSIN-Plugin` with
`opsin-name-to-structure-X.Y.Z.zip` and its `.zip.sha256` sidecar. A catalog entry with no published
release remains visible and reports that no release is published yet. The host requires the sidecar
to remain present for manual distribution and verifies downloaded bytes against GitHub's
release-asset digest. That digest establishes package integrity, not cryptographic publisher
identity. Do not describe this path as signed or use it for silent updates; a future
publisher-signature design needs its own plugin key, separate from Sparkle's application-update key.

To host the *extracted source* elsewhere, merge the core-enablement surface
(`docs/plugin-architecture/CORE-ENABLEMENT.md`) and add one `{ manifest, options }` entry to that
host's `registerBundledPlugins` catalog.
