# Plugins and agent reach

## Official catalog

The compiled catalog in
[pluginUpdates.ts](../../../apps/desktop/src/plugins/pluginUpdates.ts)
lists these official plugins. Installing a desktop plugin is a separate
user action from configuring a headless tool.

| Plugin | Agent reach |
|---|---|
| NMR Shift Predictor (`org.chemdraft.nmr.predictor`) | Desktop plugin; `nmr` / `predict_nmr` loads a separate owner-trusted source checkout |
| Name to Structure (OPSIN) (`org.chemdraft.opsin.nameToStructure`) | Desktop insertion plugin; `name` / `name_to_structure` independently uses the bundled OPSIN runtime, without loading this plugin |
| Structure from Image (MolScribe) (`org.chemdraft.ocsr.molscribe`) | Experimental desktop-only recognition, through proposal review; no CLI/MCP image-recognition tool |

MolScribe runs locally, with a host-managed engine installed only on
explicit user action. It works best on clean computer-drawn structures;
hand-drawn, sketch-style or colour-filled drawings and grid lines are
often misread. Check every atom and bond before insertion. Its proposed
structure, candidates and warnings are uncertain inferred output, never
presented as certain. The source image stays unless the user deletes it.
An agent must not use name conversion to pretend it recognized an image.

## Headless trust

The CLI loads external NMR plugin code only from a directory listed in the
owner's fixed-location trust file. `CHEMDRAFT_NMR_PLUGIN_DIR` chooses among
trusted directories; an environment variable alone cannot authorize loading.
After the allow-list and real-path checks, the CLI imports and validates
`src/manifest.ts`, including refused permissions, then imports `src/index.ts`
and checks its exports, including required capabilities. The entry executes
before the capability check, so the trust-file allow-list bounds which code
can run. This is in-process code, not a sandbox. See [setup](setup.md); the
agent must never create or edit the trust file, only show the entry printed
by the refusal.
There is no generic headless plugin loader or command to invoke arbitrary
desktop plugin commands.

## Write a plugin

Read [AUTHORING.md](../../../docs/plugin-architecture/AUTHORING.md) and
the working [mass-fragment-demo](../../../examples/plugins/mass-fragment-demo/README.md).
That example demonstrates an analyzer/report flow; it is deliberately non-NMR.
Plugin imports may use only `@chemdraft/plugin-api` among ChemDraft packages,
plus ordinary npm dependencies and their own modules.

A manifest declares `id`, `name`, `version`, `apiVersion`, `entry`,
`permissions`, and any `contributes` entries. Current API is `0.1.6`;
declare the caret version needed. Additive API changes bump patch, breaking
changes bump minor. Code `license` and dataset `dataLicenses` are separate
claims; a code licence alone does not cover bundled data.

Capabilities are typed, declared and least privilege. The dangerous
permissions are `filesystem.write`, `network.fetch`, `native.execute`,
`model.load`, `model.download`, `clipboard.read`, `document.write`, and
`image.read` beyond a user-chosen image. No undeclared capability is granted;
dangerous work needs explicit user action. A process-spawning capability
also requires `native.execute`; OPSIN needs it beside `chemistry.compute`.

Use `plugin.<pluginName>.<action>` command IDs,
`menu.<pluginName>.<action>` menus, `panel.<pluginName>.<name>` panels,
and `analyzer.<pluginName>.<name>` analyzers. Register through the runtime;
commands share the host registry, and panels are declarative reports.
Do not access React state, the DOM or private host functions.

Document writes are patches with one labelled undo entry and changed
objects selected. `documents.applyPatch` requires declared `document.write`
and one of that plugin's own commands running. It only inserts `addObject`
or `addAnnotation`, for deterministic conversion of user-supplied input.
Changing/removing existing content and inferred output use proposal review.
Image recognition is always proposal-only; recognition plugins cannot
declare `document.write` or `model.download`. Never silently change chemistry.

Build SDK packages with `pnpm build:sdk`. Package a committed, clean,
licensed plugin using `pnpm plugin:package -- <plugin-directory>`, with
`--out <scratch-directory>` to keep ZIP/checksum outputs outside the repo.
The SDK build writes package `dist` directories, so run it only in a
developer checkout where those writes are authorized. An installable plugin
owns `src/workerEntry.ts`; packaging enforces licence, boundary and provenance
gates. Integrity checksums are not publisher signatures or trust decisions.

The in-app automation bridge (`window.__CHEMDRAFT_AGENT__`) is ChemDraft's
own testing surface, not a supported agent API, and must not be used to edit
a user's document.
