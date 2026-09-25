# ChemDraft plugin core-enablement surface

The minimal set of ChemDraft **core** changes a host app must merge to load a plugin built against
`@chemdraft/plugin-api`. This is the "merge ONLY the updated parts of ChemDraft" companion to an
extracted plugin zip (see `tools/plugin-extract/extract.ts`). A plugin itself imports only the SDK
(enforced by `tools/plugin-extract/boundary.test.ts`); everything below is host-side scaffolding.

The surface is small because the plugin↔core boundary is a single package: an extractable plugin's
runtime source imports **only `@chemdraft/plugin-api`**.

## 1. SDK packages (the contract — merge or publish)

| Package | Role | Depends on |
|---|---|---|
| `@chemdraft/plugin-api` | The only package a plugin imports. Manifest + contributions schema, command context/handlers, permission list, panel-report schema (text/keyValue/table/svg/linkedFigure), host-owned prompt/image/recognition contracts, proposed/direct patch contracts, selection snapshot, analysis records. Re-exports the chem-core document types it references. | `@chemdraft/chem-core` (types), `zod` |
| `@chemdraft/plugin-host` | The runtime a host embeds: `PluginHost` (register/unregister/list/subscribe, command routing, permission enforcement, command-scoped direct patch and recognition forwarding, proposal queue, analysis store, panel-report forwarding, panel-closed hook) + `CommandRegistry`. | `@chemdraft/chem-core`, `@chemdraft/plugin-api` |
| `@chemdraft/chem-core` | **Types only** for the plugin path: `ChemDraftDocument`, `DocumentPatch` (re-exported through the SDK). A host with its own document model can provide compatible definitions instead of the whole package. | — |

## 2. Desktop host wiring (`apps/desktop/src/plugins/`)

Generic, non-NMR scaffolding that renders any plugin's contributions. A different host reimplements
these against its own UI; the shapes are the reference implementation.

| File | Role |
|---|---|
| `createPluginRuntime.ts` | Constructs the singleton `PluginHost` + controllers and forwards direct patch/image-acquisition transactions into the host shell. |
| `applyPluginDocumentPatch.ts` | Applies a direct plugin patch through chem-core, discovers and selects inserted objects, and returns the strict applied receipt before the shell records one undo entry. |
| `usePluginRuntime.ts` | React hook owning the runtime; derives plugins / menu items / open panel / diagnostics and re-renders on host + panel subscriptions. |
| `registerBundledPlugins.ts` | **The integration point.** Catalog of `{ manifest, options }` descriptors, `applyEnabledPlugins`, and startup registration honoring the user's disabled set. *A host edits this one file to add a plugin.* |
| `PluginPanelController.ts` | Owns open-panel state, report forwarding, the panel-closed hook, and runtime diagnostics. |
| `PluginPanelWindow.tsx` + `panelBridge.ts` | Desktop-native host for plugin reports and built-in analysis snapshots, including Run again, staleness, close, and interactive action routing. |
| `PluginPanelSurface.tsx` | Browser-build in-app fallback for contributed reports and diagnostics; never mounted in the desktop drawing window. |
| `PluginReportRenderer.tsx` | Renders a declarative `PluginPanelReport`'s sections. |
| `LinkedFigureView.tsx` + `spectrumExport.ts` | Interactive renderer for the `linkedFigure` report section (generic primary/alternative method model — used by NMR but not NMR-specific; copy/JCAMP export helpers). |
| `PluginDiagnosticsPanel.tsx` | Bundled-plugin list + runtime diagnostics. |
| `PluginManagerDialog.tsx` + `pluginPreferences.ts` | The plugin manager (enable/disable, one-click official-catalog install, package install/remove, and explicit host-managed update review) + localStorage preferences. |
| `PluginPromptTextController.ts` + `PluginPromptTextDialog.tsx` | Persistent host-to-React broker and core-owned modal for `dialogs.promptText`; the dialog identifies the requesting plugin and cancels on teardown. |
| `ImageSourceProvider.ts` + `PluginImageRequestController.ts` + `PluginImageRequestDialog.tsx` | Registry-driven file/screen acquisition and the core-owned `images.requestImage` modal. Provider availability determines its buttons; plugin code never sees native APIs. |
| `structureRecognitionEngine.ts` | The single platform-neutral `StructureRecognitionEngine` port plus the Tauri adapter. All status/install/cancel/remove/inference commands stay behind this interface; callers and tests inject another implementation. |
| `StructureRecognitionController.ts` + `StructureRecognitionInstallDialog.tsx` | Persistent host broker for `recognition.recognizeStructure`. It owns the explicit MolScribe install decision, disk/privacy disclosure, progress/cancel/error UI, and continuation into inference. Plugins receive neither native commands nor `model.download`. |
| `pluginStructureRecognition.ts` | Validates native recognition output with an available chemistry adapter and reuses the normal MOL-to-document import path to prepare a proposal-only insertion. Invalid or unsanitized output never reaches review. |
| `recognitionPreview.ts` | Draws the molecule a recognition proposal would insert with the host's own SVG exporter, from the validated patch object — never plugin-supplied markup — and hands it to the review as an `<img>` data URI. |
| `pluginUpdates.ts` | The compiled-in official plugin catalog plus shared release validation, native download, and pre-install/update package inspection. Plugins never supply these URLs. |
| `pluginMenuModel.ts` | Maps host menu contributions → web menu items. |
| `nativePluginMenu.ts` | Syncs plugin menu items into the Tauri native menu. |
| `selectionSnapshot.ts` | Builds the immutable selection snapshot, emitting a lossless V2000 molfile at the boundary (ADR-0019). |
| `types.ts` | Desktop-local plugin types (`OpenPluginPanel`, `PluginDiagnostic`). |
| `../App.css` | Plugin panel, linked-figure, diagnostics, and manager styling used by the renderer files above. |

## 3. Menu integration

- `apps/desktop/src/appMenu.ts` — the `plugins` section + `plugins.manage` command, `appendPluginMenuItems`, and the `pluginContributed` flag that excludes plugin items from the native-menu drift check.
- `apps/desktop/src-tauri/src/lib.rs` — the plugin native-menu bridge (ADR-0016): `PluginMenuItemInput` / `PluginNativeMenuItems` state, the sync command, plugin items in `build_analyze_submenu`, the **Plugins** submenu + `plugins.manage` in `MENU_COMMAND_IDS`, and prefix routing of `plugin.*` command ids back to the webview.
- `apps/desktop/src-tauri/capabilities/default.json` — grants `allow-sync-plugin-menu-items` to the relevant app windows.
- `apps/desktop/src-tauri/capabilities/plugin-updates.json` — grants only the main window native HTTP
  access to the exact release API, ZIP, and checksum paths for every compiled-in official catalog
  entry. A catalog test requires these scopes to stay synchronized.
- `apps/desktop/src-tauri/permissions/autogenerated/sync_plugin_menu_items.toml` — generated Tauri permission metadata for that command; regenerate it when the command surface changes rather than hand-editing it.

## 4. Host shell wiring (`apps/desktop/src/MainWindow.tsx`)

Call sites, not new modules: call `usePluginRuntime`, feed `pluginMenuItems` into the menu model,
route desktop reports through `openPluginPanelWindow` and the snapshot/event bridge, render
`PluginPanelSurface` only for the web fallback, render `PluginManagerDialog`, register the
`plugins.manage` command, and sync plugin menu items into the native menu via effect.

The MolScribe manager row and recognition request both open the same host-owned install controller.
The dialog names the requesting plugin, reports required/free disk space and local-only processing,
and streams install progress. The native layer owns network and filesystem work; no TypeScript module
downloads the engine or model. A selected image is scoped to its host command-invocation token, so the
recognition endpoint rejects invented, modified, retained, or cross-invocation image objects.

### The recognition engine interface

`StructureRecognitionEngine` (`apps/desktop/src/plugins/structureRecognitionEngine.ts`) is the only
code that names the native OCSR commands. Everything else — the controller, the install dialog, the
plugin manager row, tests — talks to the interface, so a second engine or platform is one new class:

| Method | Tauri command | Result |
|---|---|---|
| `status()` | `ocsr_engine_status` | `{ state: notInstalled \| installing \| installed \| broken \| unsupported, installed?, requiredDiskBytes, freeDiskBytes, detail? }` |
| `install(onProgress)` | `ocsr_engine_install` with `onProgress: Channel<InstallProgress>` | status, or a rejection `{ code: insufficientDisk \| network \| checksumMismatch \| cancelled \| unsupported \| failed, message }` |
| `cancelInstall()` | `ocsr_engine_cancel_install` | status |
| `uninstall()` | `ocsr_engine_uninstall` | status |
| `recognizeImage({ mediaType, bytes })` | `ocsr_recognize_image` with `{ mediaType, bytesBase64 }` | `recognized` (SMILES, molfile, nullable confidence, per-atom/bond confidence, elapsed time, engine commit + model SHA-256), `notInstalled`, or `failed` with a code |

Outside a Tauri host the runtime uses `UnsupportedStructureRecognitionEngine`, which reports the
`unsupported` state honestly instead of attempting IPC. The engine status is read when the plugin
manager opens or when a recognition starts — never at app startup.

### The host install flow

1. A plugin command calls `recognition.recognizeStructure(image)` with an image from this invocation.
2. The controller reads `status()`. If the engine is installed it goes straight to recognition.
3. Otherwise the install dialog opens, naming the plugin, what is installed (a private Python,
   PyTorch and a 1.1 GB model), the space needed and free, and that images never leave the computer.
   An `unsupported` computer gets an explanation and no Install button.
4. **Install** streams phase text and, for byte phases, a progress bar; **Cancel** calls
   `cancelInstall()`. An install error keeps the dialog open with a plain explanation per code.
5. Success continues into recognition. **Not now** (or Escape) before installing, closing the dialog
   after a failed install, or no install dialog being available resolves the plugin's call with
   `engineNotInstalled`. **Cancel** (or Escape) during the install, or the command ending, resolves it
   with `cancelled`, and the plugin stays silent.
6. A recognized result is validated through the chemistry adapter, turned into document geometry by
   the MOL paste path, and returned for the plugin to *propose*; invalid output returns `failed` /
   `invalidResult` and is never proposed.

## 5. Build wiring

The host's desktop `package.json` declares the plugin package as a dependency so the bundler includes
its source (ChemDraft consumes plugins as TypeScript). For an extracted plugin, add the package and
one `{ manifest, options }` entry to the `registerBundledPlugins` catalog — nothing else.

This document is the reviewed **merge manifest**, not a pre-generated Git patch or an isolated merge
branch. Compare these paths against the target branch because `MainWindow.tsx`, `App.css`, and the
Tauri capability file are shared core surfaces that may have moved independently.

## What is NOT required

None of the other ~20 core packages (`ocl-adapter`, `editor-shell`, `viewport-engine`, …) are part
of the plugin path. The NMR plugin carries its own chemistry (OpenChemLib) inside its package.
