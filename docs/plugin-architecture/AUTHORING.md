# Authoring a ChemDraft plugin

A plugin is a TypeScript package that imports **only `@chemdraft/plugin-api`** and exports a manifest
plus command handlers. Bundled examples are composed from source by the desktop build; an installable
plugin is compiled into a verified multi-file worker package by `pnpm plugin:package`.

## Assistant tools (0.1.9)

Declare `document.read`, `document.write`, `selection.read`, `chemistry.compute`, `native.execute`,
and `assistant.run` to receive `context.assistant`. Every method re-checks all six permissions;
individual tools also check their own permissions. Declare `apiVersion: "^0.1.9"`.

Keep the plugin's submit command pending for the whole run. At Send, call
`assistant.beginRequest({ prompt, label? })`: the host captures the document tab and selection
and opens a labelled transaction. Tools may change only that selection plus objects inserted
earlier in the same request. Changing the selection during a run never widens its scope; an empty
selection permits additions only. Results land directly on the page, with no approval window.

`listTools()` returns the host's tool schemas. `callTool({ name, input })` executes a tool in the
plugin's active request. For a command-line provider, call `createToolSession({ requestId })` and
pass its `sessionId` to `tools.run` as `mcpSessionId`. The server is named `chemdraft`; the returned
`tools` lists its names. The host allows two sessions per plugin and four concurrent tool calls.
`closeToolSession({ sessionId })` releases one session. Ended requests, closed tabs, cancellation,
deadlines, and unregistering the plugin prevent late writes.

Always call `endRequest({ requestId })` in a `finally` block before the submit command returns.
This closes its sessions and finishes one undo entry, leaving the changed objects selected. It
returns `{ touchedIds, summary, split }`; `split` reports that a user edit interrupted the run's
history entry. Undo and redo restore the recorded states exactly and never call the plugin or
the AI again. Session ids belong to the plugin and request that created them.

```ts
const { requestId } = await context.assistant!.beginRequest({ prompt });
try {
  const session = await context.assistant!.createToolSession({ requestId });
  // Start and await the provider run, using session.sessionId as mcpSessionId.
} finally {
  await context.assistant!.endRequest({ requestId });
}
```

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
`0.1.10`). API 0.1.10 adds panel input and canvas overlays; plugins that use either should declare
`^0.1.10`. API 0.1.8 adds host-owned `context.tools`; plugins that use it should declare `^0.1.8`.
API 0.1.7 adds host-owned `context.chemistry.structureToName`; plugins that use it should declare
`^0.1.7`. API 0.1.6 adds host-owned `context.recognition.recognizeStructure`; plugins that
use it should declare `^0.1.6`. API 0.1.5 added command-scoped `context.images.requestImage`, 0.1.4 added
`context.documents.applyPatch`, and 0.1.3 added the host-owned `context.dialogs.promptText`
capability. API 0.1.9 adds `context.assistant` for request-scoped tools and MCP sessions.
Existing `^0.1.0` through `^0.1.10` packages remain compatible, each on a host at or above the version it declares.

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

Report section kinds: `text`, `keyValue`, `table`, `svg`, `chemicalName`, and `linkedFigure` (an interactive
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

`dialogs` is absent without `ui.panel` and present with it, whether the plugin runs in-process or in its
worker. An embedding host that has no prompt UI rejects the call with a plain error rather than hiding
the capability, so both execution paths see the same shape. `promptText` rejects outside that plugin's active command
invocation, and each command invocation may call it at most once (including after its first prompt has
settled). Only a prompt the user was actually shown uses up that allowance: a call the host refuses
first — an invalid request, another of the plugin's prompts still open, or a host with no prompt UI —
leaves it, so a corrected retry in the same invocation still works. Submit is disabled for an empty field; cancellation returns `{ status: "cancelled" }`.
Disabling, unregistering, or terminating the plugin while its prompt is open also cancels it.

## External tools (0.1.8)

`context.tools` lets a plugin use host-managed AI command-line tools (`claude` and `codex`). Declare
both `assistant.run` and `native.execute`, and `apiVersion: "^0.1.8"`. The capability is absent
without either permission, and every method re-checks both when called. Manifest validation refuses
`assistant.run` without `native.execute` because external tools spawn processes. The
host obtains consent separately for each plugin and each tool, so a plugin must be prepared for
install or run to be declined.

Plugins send typed tool requests, never argv, environment variables, or file paths. The host renders
the fixed command line and owns installation, sign-in, process lifecycle, and output limits. A
long-running command can poll with `tools.poll` (up to one second of waiting) while its submitting
command remains active. Stopping a run is a separate plugin command that calls `tools.cancel`; do not
try to cancel by ending the submitting command.

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
plugin cannot request a download. A plugin declaring all four recognition permissions is a recognizer,
and the host refuses to register one that also declares `model.download` or `document.write` (see
below) — the error names the plugin and the conflicting permissions. Declining the install, or an
install that fails, gives `engineNotInstalled`, which a plugin may explain. Cancelling — the user
cancels a running install, or the command invocation is abandoned — gives `cancelled`: the user
already knows, so the plugin should stay silent. Recognition failures are typed, and successful results include nullable overall
confidence, atom/bond confidence, elapsed time, and engine/model provenance.

MolScribe results remain uncertain inferred output. A recognizer must validate the MOL/SMILES through
available chemistry before proposing it, preserve the source-image preview and applicable uncertainty
warnings, and use `documents.proposePatch`. It must never use `documents.applyPatch` for recognition,
and the host enforces that (below).

**The review describes the recognition as the host saw it.** When the host recognizes an image it keeps
its own record of that recognition: the warnings it attached (engine disagreement across image sizes,
missing scores, validation and import notes), a confidence tier it assigns itself, the recognized bytes,
and the SMILES and MOL block. When a proposal of that recognition is queued — through the
`hostHeldRecognition` reference below, or with a `recognition` review block, or (for a plugin holding
`document.read`) as the host's own insertion — the host attaches that record to it:

- the review block's `confidenceTier`, `sourceImageRef`, `proposedSmiles`, and `proposedMolfile` are the
  host's, whatever the plugin sent. On the desktop the tier is the engine score's tier capped by how far
  the engine's readings agreed, so a split vote is shown as low even if the plugin claims high;
- the proposal's `reason` is the host's, since a plugin's text could claim a confidence the review does
  not show;
- the host's warnings always come first. A plugin may add warnings of its own after them; it cannot
  remove or replace the host's, so passing `warnings: []` hides nothing.

A `recognition` review block on a proposal that no recognition in the same command invocation produced
is refused: only the host may describe a recognition for review.

## Structure naming (0.1.7)

API 0.1.7 exposes `context.chemistry?.structureToName?.({ objectId })` for a molecule in the current
selection, or the page’s only molecule when nothing is selected. An object outside that scope is refused. The desktop host reads the current document itself. Declare all three permissions — `chemistry.compute`, `native.execute`, and
`selection.read` — and declare `apiVersion: "^0.1.7"`. The method is absent if any is missing, and is
valid only during one of the plugin's command invocations. The host reads the selected molecule; a
plugin supplies neither SMILES nor a name, and it cannot request an engine download.

```ts
const result = await context.chemistry?.structureToName?.({ objectId: "molecule-1" });
if (result?.status === "named") {
  await context.panels?.showReport("panel.example.result", {
    title: "Name",
    sections: [{
      kind: "chemicalName",
      label: "Name",
      name: result.name,
      kindLabel: result.kindLabel,
      warnings: result.warnings
    }]
  });
}
```

`named` carries either `preferredIupacName` or `systematicName`, verification provenance, engine
provenance, and warnings. The host fixes `kindLabel` text: it is exactly **“Preferred IUPAC name”** or
**“Systematic name (not the preferred IUPAC name)”**; a plugin must display that value rather than
inventing its own label. `stereoLimitedEvidence` means the name includes stereodescriptors but stereo
naming has limited benchmark evidence. `abbreviationExpanded` records an exact-SMILES conversion that
expanded an abbreviation. `chemicalName` is a declarative report section; the host provides its Copy
button, so a plugin needs no clipboard permission.

Every result status is significant: `declined` means no name passed host policy; its codes are
`noVerifiedName`, `notFullyVerified`, `unsupportedElement`, `unnameable`, `engineLimit`,
`structureNotExact`, and `tooLarge` (the raw naming-engine limit is available as `limitCode` where
applicable). `engineNotInstalled` means the user declined or did not finish host-owned installation;
`cancelled` means the user cancelled or abandoned the invocation and the plugin should stay silent;
`unsupported` identifies a platform, host, or OPSIN-runtime limitation; and `failed` has one of
`engineCrashed`, `timeout`, `busy`, `installFailed`, or `invalidResult` plus a message. Never show a
partial or unverified name: only `named` carries a name. A failed engine install is `failed` with `installFailed`, rather than a chemical decline.

For `named`, the host reads the name back through OPSIN and compares host-canonical exact isomeric
SMILES, including formal charge, isotopes, radicals, and stereo. This check cannot catch a name that
Orthonym and OPSIN both misread in the same way, because both use OPSIN 2.9.0; do not describe it as a
proof beyond that limitation.

**`proposedPatch` without `document.read`.** The insertion the host builds for a recognized structure is
laid out against the active document — its page id, an object id derived from the document's object
count, and page-centre coordinates. A plugin that did not declare `document.read` must not learn those,
so it receives `proposedPatch.patch` as an opaque `{ op: "hostHeldRecognition", ref }`
(`HostHeldRecognitionPatchOp` in `@chemdraft/plugin-api`). Pass the `proposedPatch` to
`documents.proposePatch` unchanged — adding warnings is fine; the host's reason, warnings, and review
block apply regardless (above) — during the same command invocation; the host substitutes the real insertion, queues it once, and returns a
receipt without the patch. A second proposal of the same `ref`, a forged `ref`, or a proposal after the
command ends is refused. A plugin that holds `document.read` receives the insertion itself, as before.
The official MolScribe plugin declares `document.proposePatch`, not `document.read`, and spreads
`proposedPatch` unchanged, so it takes this path with no code change.

## Panel input and canvas overlays (0.1.10)

API 0.1.10 lets a report contain interactive, host-rendered sections. Declare
`apiVersion: "^0.1.10"`; add `ui.panel` for a panel and `ui.canvas` for a canvas overlay. Panels
may also declare `preferredWindowSize: { width, height }`, where both values are positive integers.
It is a preferred native-window size, not a fixed frame.

`PluginPanelReport.sections` adds these section kinds. Control and section ids use
`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$` and must be unique within the report.

- `prompt` has `id`, `commandId`, and optional `title`, `label`, `placeholder`, `submitLabel`
  (default `"Send"`), `hint`, and `disabled`. Its `maxLength` is 1–20,000 (default 4,000), and
  `rows` is 1–12 (default 3). It may have one `select`: `{ id, label, value, options,
  commandId? }`, with 1–20 `{ value, label }` options and values no longer than 100 characters.
- `actions` has `id`, optional `title`, and 1–8 buttons. A button has `id`, `label`, `commandId`,
  optional JSON-serialisable `payload` (at most 4,000 characters), optional `disabled`, and a
  `tone` of `default`, `primary`, or `danger`.
- `image` has `dataUri`, `alt`, and optional `title`, `caption`, and positive-integer `maxWidthPx`.
  The data URI is base64 `image/png`, `image/jpeg`, or `image/webp`, at most 1 MiB.

When a user activates a control, its handler receives `context.input`. It contains `source`
(`"panel"` or `"overlay"`), exactly the matching `panelId` or `overlayId`, `sectionId`, and
`control` (`"prompt"`, `"select"`, or `"button"`), plus `controlId`, `text`, `selected`, or
`payload` when that control supplies one. Treat it as invocation-scoped input, not stored UI state.
The host takes the command id, button payload, select options, and input limits from the live report
in the document window — never from the detached panel's message. It refuses unknown, disabled,
foreign, or over-limit controls. The textarea itself is never disabled while an action is pending,
because doing so would end its native input-focus lease; only Send and the select become unavailable.
Its draft clears only after the host accepts the action.

The host acknowledges a panel or overlay submission as soon as it **accepts and queues** the
command; it does not wait for a long-running command such as an AI run. The accepted draft therefore
clears immediately. A **host refusal** — a stale or closed panel, disabled control, too-long text,
unknown option, or foreign command — keeps the draft and appears inline. A refusal or failure decided
by the plugin's own command is the plugin's to report in its panel or overlay content (for example, a
transcript line or `overlays.setStatus`); the document status line also reports command failures.

The native **Plugins** menu is the `plugins` menu location. A plugin may also contribute at most one
`canvasOverlays` entry. It requires `ui.canvas` and has an `overlay.<plugin>.<name>` id, a title of
at most 80 characters, a base64 PNG or SVG data-URI icon of at most 64 KB, the overlay command id,
the same `prompt` declaration, an optional `defaultCorner` (`bottom-right` by default; also
`bottom-left`, `top-right`, or `top-left`), and optional required permissions. `context.overlays?.setStatus({
overlayId, text })` updates its status line; text is at most 120 characters (an empty string clears
it). Per AGENTS.md §12, this icon-plus-prompt widget is the only allowed in-viewport plugin surface:
one declared overlay per plugin. Panels, palettes, and dialogs remain separate floating native
windows.

```ts
export const manifest = parsePluginManifest({
  id: "org.example.prompt", name: "Prompt", version: "0.1.0", apiVersion: "^0.1.10", entry: "src/index.ts",
  permissions: ["ui.panel", "ui.canvas", "ui.menu"],
  contributes: {
    commands: [{ id: "plugin.prompt.send", title: "Send" }],
    menus: [{ id: "menu.prompt.open", title: "Open Prompt", commandId: "plugin.prompt.send", location: "plugins" }],
    panels: [{ id: "panel.prompt.main", title: "Prompt", preferredWindowSize: { width: 420, height: 560 } }],
    canvasOverlays: [{ id: "overlay.prompt.quick", title: "Quick prompt", icon: "data:image/png;base64,...",
      commandId: "plugin.prompt.send", prompt: { kind: "prompt", id: "quick", commandId: "plugin.prompt.send" } }]
  },
});

const send: PluginCommandHandler = async (context) => {
  if (context.input?.control === "prompt") await context.overlays?.setStatus({
    overlayId: "overlay.prompt.quick", text: `Received ${context.input.text?.length ?? 0} characters`
  });
};
```

## Direct document writes versus proposals

A plugin declaring the dangerous `document.write` permission may insert content directly while one of
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
command invocation ends. It accepts **insertion only** — `addObject` and `addAnnotation`, both of which
refuse an id that already exists. Any other op (`removeObject`, `updateObject`, `moveObject`,
`updatePageLayout`, `setSelection`, …) is refused with an error naming the op: changing or removing what
is already in the document is not deterministic insertion of user input, so it goes through
`proposePatch` and the user's review. The direct write is one undo entry labelled with the plugin and command; it
does not open the proposal review tray/window.

Use `applyPatch` only when the user supplied the input and the result is deterministic, such as a
name-to-structure command acting on text entered in the host prompt. Use `proposePatch` for uncertain
or inferred output that needs inspection. Image recognition remains a proposal flow: low confidence,
stereochemistry, charge/radical, and abbreviation uncertainty require explicit user approval before
insertion, and the host enforces that at registration: **a plugin declaring the four recognition
permissions may not also declare `document.write`** (nor `model.download`), and such a manifest is
refused with an error naming the plugin and the conflicting permissions. A per-invocation rule was not
enough: a plugin holding both could recognize an image in one command and insert the structure through
`applyPatch` from another — or from a concurrent — command, where nothing ties the write to the
recognition. A plugin that needs both recognition and deterministic direct writes (a typed name) ships
them as two plugins.

Behind that, as defence in depth, `applyPatch` still refuses every call in an invocation that has
recognized a structure, and any patch carrying a `recognition` review block or a `hostHeldRecognition`
reference.

**A direct write is bound to its document.** The host records which document was active when the
command started and refuses `applyPatch` if a different document is active when the write arrives —
after File > New, File > Open, or a switch to another document window — with "The document changed
while the plugin was running; nothing was inserted." Edits and undo inside the same document do not
count as a change. Proposals remain queued for review in their originating document.

## Proposal lifetime

A proposal stays in the host's queue only while it is pending. Accepting or rejecting it removes it
(a recognition proposal carries its whole source image, which must not be held for the session), so
`listProposedPatches("accepted")` and `listProposedPatches("rejected")` are always empty; the result of
an accept or reject is carried by its return value and the `onProposedPatchesChanged` notification.
Pending proposals survive unregistering the plugin — an update or disable must not discard review the
user has not done yet.

A desktop proposal belongs to the document tab its command started in, even if the result arrives
after a tab switch. Switching or closing tabs never discards pending proposals. Accepting brings the
originating document forward and applies the proposal there; if that document was closed, Accept is
refused and the proposal stays pending and can only be rejected. With multiple tabs open, the review
window names each proposal's document.

**Accepting is the user's action, not the plugin's.** `acceptProposedPatch` is the review step the
recognition rule above waits for, so none of `applyPatch`'s refusals reach it: not the recognition
rule, not the invocation binding (the command finished long ago), and not the direct-write document
key. The desktop activates the proposal's own tab and inserts an accepted proposal as one
undo entry, selects what it inserted, and reports the result in the status line. A proposal whose
patch cannot be applied stays pending, and the reason is shown both in the status line and on the
proposal in the review window, so the user can retry or reject it. The review window waits for the
main window's answer to every Accept and Reject and says so if none arrives — an Accept is never a
button that silently does nothing.

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

Nested module workers are supported on both macOS and Windows to depth 1: on Windows, a plugin
worker can start a nested module worker, but a worker started from inside that nested worker
(depth 2 or greater) is not supported. Use
`new Worker(new URL("./assets/worker.js", import.meta.url), { type: "module" })` and keep the
worker's assets co-located. On Windows, the host installs a compatibility shim before plugin
code executes: same-origin module workers start through a small blob with a static import of
the real absolute URL. The imported module retains its real `import.meta.url`, and worker
options and native messaging APIs are preserved. The shim is installed in the plugin worker, but
not reinstalled by the nested worker's blob wrapper, which is why deeper nesting still fails.
macOS and web builds retain their native behavior. Classic workers and cross-origin URLs are not
shimmed. This grants no additional permissions or network access.

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

To install a package by hand, choose **Plugins ▸ Add plugin from package…** and pick the `.zip`. Keep
the `.zip.sha256` beside it: ChemDraft reads it automatically and refuses the install if it is
present but wrong. Without it the package still installs, unverified by checksum. See
`docs/architecture/plugin-package-reading.md`.

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
