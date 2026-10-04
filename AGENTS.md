# Agent Instructions for ChemDraft

ChemDraft is a lightweight, open-source chemical drawing application with a plugin architecture. The
core stays small, stable, testable, legally clean, and focused on drawing. This file governs every AI
agent and human contributor, on every branch. It is repo-wide: scope for one slice belongs in
`PLANS.md`, never here.

## 1. Both platforms, every change

**ChemDraft ships for macOS and Windows together, from the same commit, under one version number.**
Every code change must work on both. A change that works on one platform is not finished, and "the
other platform is a follow-up" is not an acceptable state to merge.

- **Shared code by default.** Branch on the platform only where the operating system forces it, and
  write both sides in the same change. Rust: every `#[cfg(target_os = "macos")]` gets its
  `#[cfg(not(target_os = "macos"))]` (or `cfg(windows)`) side, and clippy runs with `-D warnings` on
  both, so code dead on one side fails there. TypeScript: take the platform as a parameter that
  defaults to detection (`ShortcutPlatform` / `detectDesktopShortcutPlatform()` in
  `keyboardShortcuts.ts`), so one test host can exercise both branches. Tauri: platform-only
  capabilities carry `"platforms": [...]`; Windows-only config lives in `tauri.windows.conf.json`.
- **Known differences you must respect** (most were found the hard way during the Windows port):
  - App origin: `tauri://localhost` on macOS, `http://tauri.localhost` on Windows (WebView2). Anything
    served same-origin, such as installed plugins, must accept both (`installed_plugins.rs`).
  - Menus: app-wide on macOS; on Windows only the document window carries one (`install_app_menu`).
    Attaching a menu to palettes or popovers crashed Windows at startup and quit.
  - Utility windows (palettes, popovers, tooltips) are built `focused(false)` and owned by the
    document window, so on Windows they never steal focus or show on the taskbar.
  - Shortcuts: `CmdOrCtrl`, a Ctrl+Y redo alternate off macOS, Mac glyph labels only on macOS, and
    F5/Ctrl+R must never reload the webview (a reload discards the document).
  - Quitting: on Windows, closing the document window quits after flushing the session.
  - Updates: Sparkle and `appcast.xml` on macOS; `tauri-plugin-updater` and `latest.json` on Windows.
  - Clipboard: Windows formats are handled in `windows_clipboard.rs` (UTF-16, CRLF, Office formats).
  - Files: Windows registers `.chemdraft` only; it must never take over `.cdxml`.
  - Paths and tools: backslashes, 8.3 temp paths, no bash, no `zip`, symlinks need privileges. Use
    `path` APIs, never hard-coded `/`. New repo scripts are Node (`scripts/*.mjs`), not bash, unless the
    job is macOS-only by nature (signing, notarizing, Sparkle, `./run-app`).
  - Native binaries (the 3D sidecar, the OPSIN Java runtime) are built and committed per platform.
- **CI runs three hosts:** Linux (types, tests, web build), macOS (Rust fmt, clippy, tests), and
  Windows (types, tests, web build, Rust fmt, clippy, tests). Treat the Windows job as required: a red
  Windows job blocks merging under this rule even where branch protection does not list it.
- **Verify on both, or say which you did not.** When a change touches native code, windows, menus,
  shortcuts, focus, the clipboard, file input/output, paths, the updater, or plugin install and
  serving, check it on both platforms. If you can run only one, the report must name the other as
  unverified and say exactly what needs checking there. Never report a platform as verified that you
  did not run.
- **Releases** are joint: the macOS DMG and the Windows NSIS installer are built from the same commit,
  release notes have `## macOS` and `## Windows` sections, and neither platform gets a version the
  other does not. See `docs/releasing/macos-updates.md` and `docs/releasing/windows-updates.md`.

## 2. Orientation

Before editing implementation files, read `PLANS.md`, this file, `README.md`, `package.json`, and
`pnpm-workspace.yaml`. If the work touches a package, read its README too.

- **`PLANS.md`** is the slice in flight, and binds unless the user gives newer instructions. Keep
  edits to its files and behaviors. At closeout the slice moves to `docs/shipped/README.md`, so
  `PLANS.md` never becomes a changelog.
- **`PLAN.md`** is the product charter: whether a thing should be built at all. It is not required
  reading for every edit. Read it when scoping a feature (§3, §4, §19), deciding core versus plugin
  (§5 non-goals, §21), adding a dependency or touching licensing (§15), judging release readiness
  (§1.1, §4, §19), or changing a user-facing surface (§6.15).
- **Other references:** `docs/architecture/` (subsystems), `docs/plugin-architecture/AUTHORING.md`
  (plugin authors), `docs/shipped/` (read `selection-policy-refactor.md` before touching selection or
  hit testing), `PLAN-spin3d-forcefields.md`, and `/Users/jeremiahgassensmith/programming/.notary`
  before any signing or notarizing.
- **Names.** The app is ChemDraft. "MolScribe" names only the external recognition project and the
  optional MolScribe OCSR plugin. Public text (website, release notes, PR titles and bodies, commit
  messages) never names a commercial competitor or compares ChemDraft to one; file-format names such
  as CDXML are fine.
- **Landing work.** Work only in the worktree checked out for your branch. `main` is protected:
  changes land by pull request with green CI. Several agents may share a checkout, so check the branch
  before committing and stage explicit paths.

## 3. This phase: plugins and agents

The work now in front of the project grows two surfaces: what **plugins** can do inside ChemDraft, and
what **agents** (AI or scripted callers) can do with it. Both hand ChemDraft's power to code the core
does not control, so they share these rules:

1. **One command system.** Everything a plugin or agent can do is a registered command or a typed host
   capability; no side doors into React state, the DOM, or private functions.
2. **Declared, least privilege.** The host grants only declared permissions; nothing dangerous runs
   without explicit user action.
3. **Changes go through patches**, one labelled undo entry each, with what changed left selected.
4. **Chemistry is never silently changed** (§7), in the CLI, MCP, and plugins as on the canvas.
5. **Typed, versioned contracts.** Additive API changes bump the patch, breaking ones the minor (§4.1).
6. **Same results on both platforms** (§1), headless paths and spawned processes included.
7. **Ship it whole:** permission gate, tests, authoring docs, and an example where one helps, in the
   same change.

## 4. Plugins

### 4.1 Contract and permissions

A plugin imports **only `@chemdraft/plugin-api`** (plus ordinary npm packages), never another
`@chemdraft/*` package; `tools/plugin-extract/boundary.test.ts` enforces this. A manifest declares
`id`, `name`, `version`, `apiVersion`, `entry`, and `permissions`. Plugins may contribute commands,
menus, panels, toolbar buttons, inspectors, templates, importers, exporters, analyzers, transformers,
and recognizers.

`PluginApiVersion` is `0.1.6`. For a 0.x version the minor is the compatibility boundary, so additive
methods bump the patch (0.1.4 added command-scoped `documents.applyPatch`, 0.1.5 `images.requestImage`,
0.1.6 `recognition.recognizeStructure`) and a plugin declares the caret version it needs. Record each
bump in the `plugin-api` header comment and `AUTHORING.md`.

Permission names are defined in `plugin-api`. The dangerous ones are `filesystem.write`,
`network.fetch`, `native.execute`, `model.load`, `model.download`, `clipboard.read`, `document.write`,
and `image.read` beyond a user-chosen image. A plugin never receives a capability it did not declare,
and any capability that spawns a process also requires `native.execute` (OPSIN name→structure needs
it beside `chemistry.compute`).

Naming: commands `plugin.<pluginName>.<action>` (schema-enforced for toolset contributions), menus
`menu.<pluginName>.<action>`, panels `panel.<pluginName>.<name>`, analyzers
`analyzer.<pluginName>.<name>`.

### 4.2 Runtime and panels

- **One** persistent plugin runtime (`plugins/createPluginRuntime.ts`, owned by `usePluginRuntime`),
  created once and fed document and selection through callbacks. Never recreate it on a document,
  selection, viewport, or undo change.
- Plugin commands share the core `CommandRegistry`; a `pluginId` marks them. Every registration path
  goes through the runtime's `registerPlugin`/`unregisterPlugin`, never the bare host, so toolbar
  contributions keep their `ui.toolbar` gate and whole-plugin rollback.
- Analyzers run in per-plugin module Workers (`PluginWorkerBridge`); `terminate()` is total teardown;
  `worker.format: "es"` in `vite.config.ts` is load-bearing.
- Panels are declarative `PluginPanelReport` data drawn by **one** renderer, `PluginReportRenderer`;
  an unknown section kind is never dropped. Each desktop panel is its own native window, and closing
  it notifies the plugin.

### 4.3 Installing, serving, and updating

- Installed packages are staged under `$APPDATA/installed-plugins/` and served same-origin: the app
  pre-empts its own scheme (`installed_plugins.rs`) and Vite mirrors it with `/installed-plugins/`
  middleware. Keep both hooks; never add a plugin scheme (a new origin stops packages loading).
- Never bypass the fail-closed install gates: checksum and CRC, manifest validation, `apiVersion` and
  worker handshake, path-traversal guards in TypeScript and Rust.
- Updates come from allowlisted GitHub releases, SHA-256-verified, then staged, swapped, or rolled
  back. `capabilities/plugin-updates.json` lists **every** release URL exactly, the `.zip.sha256`
  included (`URLPattern` matches exactly); `pluginUpdates.test.ts` guards it.
- Official plugins (NMR predictor, MolScribe OCSR) live in their own repositories and the host catalog
  (`plugins/pluginUpdates.ts`); their menu items exist only once installed.

### 4.4 Writing to the document

Plugins mutate documents only through patches. **Proposal review** is for results the user did not
author and cannot vouch for; image recognition is always proposal-only. When the user supplied the
input and the conversion is deterministic (a typed name parsed by OPSIN), the plugin declares
`document.write` and calls `documents.applyPatch`, which works only while one of its own commands is
running; the host commits one labelled undo entry, selects what was inserted, and opens no review
window. Reports are for failures; success needs no window.

### 4.5 Structure recognition (MolScribe OCSR)

ChemDraft owns the local recognition engine, its install UI, and the native boundary. The plugin
(`org.chemdraft.ocsr.molscribe`) receives only `recognition.recognizeStructure`, for an image the host
returned during the same command; it never declares `model.download` or `document.write`. The engine
installs only on explicit user action and runs only on the computer. Results carry SMILES, molfile,
confidence, candidates, and warnings (confidence, stereo, charge, abbreviations, invalid structure,
missing model); the source image stays unless the user deletes it. Tests use mocked recognitions; never
commit checkpoints or present a recognition as certain.

### 4.6 NMR claims (absolute)

The shipped backend is the OCL-native provider: HOSE-fragment lookup over statistics from NMRShiftDB2
experimental assignments. Never describe it as fixture-backed or synthetic (fixtures are test-only
and labelled synthetic). Accuracy figures stay checksum-gated to the benchmarked corpus. ¹H
multiplicity and J are first-order estimates, labelled so. Stick height is equivalent nuclei, not
integration. Never fabricate a shift for an unmatched environment; partial results carry warnings. No
calibrated confidence percentages, only honest tiers.

### 4.7 Licensing and redistribution

- The core is **Apache-2.0**; example plugins and the two SDK packages are MIT. Changing either is the
  owner's call. `NOTICE` ships with every distribution; a new vendored binary adds its row there and
  in `docs/architecture/dependency-inventory.md` in the same change (InChI 1.07.3 terms are still
  unconfirmed and block public redistribution).
- **Code licence and data licence are separate claims.** A plugin bundling data declares its code
  `license` and a `dataLicenses` entry per dataset; `tools/plugin-extract/gates.ts` refuses a dataset
  covered by a code licence alone. The NMR predictor's database carries nmrshiftdb2's ODbL-derived
  terms: never call that package "MIT".

## 5. Agentic surfaces

| Surface | Where | Contract |
|---|---|---|
| Headless CLI | `packages/chemdraft-cli` | `pnpm -s chemdraft <render\|grid\|reaction\|analyze\|name\|stereo\|nmr\|export>`; JSON Lines on stdout, progress on stderr; exit 0 all ok, 1 any job failed, 2 bad input |
| MCP server | `packages/chemdraft-mcp` | Local stdio server calling the CLI modules in-process; a fresh per-call output directory; 5 MB per returned payload |
| In-app bridge | `apps/desktop/src/agentBridge.ts` | `window.__CHEMDRAFT_AGENT__`; off unless `CHEMDRAFT_AGENT_BRIDGE=1` or `--chemdraft-agent-bridge` (desktop) or `?agentBridge=1` (web build) |
| Shared logic | `packages/document-workflow-core` | The pure document functions the app, CLI, and MCP all use |

Rules:

- **One implementation.** The CLI and MCP import document logic from `document-workflow-core` (or
  another package), never from `apps/`; `importBoundary.test.ts` enforces this. A new agent tool calls
  the same function the app calls, so the canvas and the agent cannot disagree.
- **Machine-readable and quiet.** stdout carries only results (hence `pnpm -s`; a script banner
  corrupts JSON Lines and MCP framing). Failures name what failed and why, per job.
- **Agent input is untrusted input.** Validate it with the same limits as user input (the CLI caps
  input at 5000 characters, 500 heavy atoms, and 500 jobs per batch, and rejects unsafe output names).
  Exports check that the canonical SMILES written equals the input's and fail otherwise.
- **Same honesty as the UI.** Numbers keep their method contract, status, and intervals (§8); estimates
  stay labelled estimates; unpreservable radicals or isotopes are refused, not changed.
- **Plugin code loaded headlessly is trusted explicitly.** The CLI loads an external plugin (such as
  the NMR predictor) only when its directory is listed in the user's trust file; an environment
  variable alone never makes an unlisted directory load.
- **The bridge is an automation surface, not a product API.** Keep it gated; add no new way to turn it
  on. Its events are synthetic and skip browser default actions such as moving focus, so focus- and
  blur-sensitive behavior also needs a real-event test.
- **Agent edits** follow §4.4: patches, one labelled undo entry, what changed left selected.
- New CLI commands and MCP tools ship with README entries and tests, and run on both platforms (§1).

## 6. Package boundaries

Engines stay behind adapters; `chem-core` is the native document model; no package owns UI unless its
row says so.

| Package | Owns | Must never |
|---|---|---|
| `chem-core` | Types, Zod schemas, patches, serialization, migrations, validation, every native object, pages, style presets | UI, Ketcher, Tauri, filesystem, plugin loading |
| `editor-adapter`, `ketcher-adapter` | Abstract editor contract; Ketcher loading and wrappers | Own document state, expose Ketcher internals, fake unsupported objects |
| `plugin-api` | Public plugin types, manifest, permissions, contexts | App code, document mutation |
| `plugin-host` | Validation, permission enforcement, commands, loading, storage scoping, lifecycle, patch review | Grant undeclared permissions, run native code or download models without approval |
| `cdx-compat` | CDXML read/write, best-effort CDX read, unknown-object preservation | Become the native model, depend on GPL code, claim perfect compatibility |
| `clipboard-adapter` | Clipboard format detection and conversion, with warnings | Silent lossy conversion |
| `layout-engine` | Align, rotate, snap, bond-length normalization, **all molecule rendering math** (§9) | Change chemical identity |
| `art-engine` | Art visual plans: strokes, markers, arrow geometry, boolean ops | Touch molecules, own documents, copy molecule rendering math |
| `export-engine` | SVG, PDF, CDXML writers with warnings | Report a format done that `isExportFormatImplemented` denies; diverge from the canvas |
| `shortcut-engine`, `toolset-registry` | Shortcut registry and conflicts; toolset schemas, overrides, menu models, command-ID validation | Bind actions only in click handlers; chemistry, permissions, windows |
| `template-library`, `style-compat` | Original templates and abbreviations; `.cds` style import into native presets | Copy proprietary templates; parse `.cds` in UI; commit user `.cds` files; claim a partial import worked |
| `viewport-engine` | Coordinate, zoom, pan, ruler math | Document mutation, rendering |
| `chemistry-adapter`, `ocl-adapter` | Engine-neutral contract (incl. 3D conformers); OpenChemLib depiction, stereo, conformers | Concrete engines in the contract; collapse an unrepresentable bond order (report `aromatic`/`unknown`) |
| `rdkit-adapter` | Real RDKit analysis and ETKDGv3 conformers on the vendored custom MinimalLib WASM (`vendor/BUILD.md`) | Load at startup; vendor another RDKit build without its own decision |
| `isospec-adapter` | Vendored, **unpatched** IsoSpec WASM, pins, lookups read from the binary | Patch IsoSpec; retype its abundance table; build results (`rdkit-adapter/src/envelope.ts` does). Disclose its ¹³C abundance (0.82% above CIAAW) wherever a derived number shows |
| `analysis-core` | Pure property-suite contracts: interpretations, classification, results, methods, provenance | Import an engine, derive chemistry, branch on `derivation`/`claim` |
| `engine3d-api` | The versioned app↔sidecar protocol | Change shape without bumping `Engine3DProtocolVersion` |
| `document-workflow-core` | Pure document builders shared by app, CLI, and MCP | React, Tauri, DOM, `apps/`, app state, loading an engine (callers inject it), a second copy of anything moved here |
| `editor-shell`, `test-utils`, `fixtures`, `ui-kit` | Unused types; test helpers; test fixtures; original icons and controls | Grow speculatively; ship in production; proprietary or unredistributable content; chemistry in UI |

`examples/plugins/`: `mass-fragment-demo` is the working, deliberately non-NMR example (keep it free of
spectroscopy); `advanced-style-pack` and `journal-style-pack` are README-only placeholders, never
described as shipped.

## 7. Chemistry invariants

Every conversion preserves atom identity, bond order, formal charge, isotopes, radicals,
stereochemistry, superatoms and R-group display where represented, reaction roles and components,
coordinates where applicable, and mechanism annotations (always editable objects, never opaque SVG).
**An operation that cannot preserve chemical meaning must warn or fail, never degrade quietly.**
Toolbar, inspector, style, and layout work never change chemistry. Tests compare canonical SMILES, formula, charge, stereo, atom and bond counts,
reaction component counts, and coordinates within tolerance.

## 8. Analysis and prediction claims

The plan of record is `docs/shipped/analyzers-property-prediction-suite.md`. A bare "§n" in the
analysis source, or a stale "PLANS.md §n" there, refers to that document.

- **One parse, many named interpretations.** Parse once through RDKit. Composition, charge, mass, and
  isotopes describe what the user drew. A method wanting a desalted or neutral form gets a *derived*
  interpretation with a `Transformation` ledger, never a silent substitute; sodium benzoate never
  becomes benzoic acid. The active interpretation is visible and changeable, and per-atom results map
  back to drawn atoms.
- **Enums display, flags decide.** Code branches on `ClassificationFlags`, never on `derivation` or
  `claim`.
- **Declining is a feature.** A method outside its parameterisation returns `unsupported`, not a
  fallback number. "Unavailable" and "not asked for" must look different.
- **Every number carries a method contract** (implementation and version, interpretation, units,
  conventions, scope, declining conditions). Conventions travel on the result; a "see X" note must
  point at a section the report contains. Detect engine capabilities by value, not arity.
- **No second interpretation engine.** Formula, charge, and mass come from RDKit; never re-decide
  valence, hydrogens, or aromaticity.
- **Validation is conditional on a partition.** State the partition with every coverage or accuracy
  figure ("external development set", never a bare percentage). A fix stratified on one partition
  (element, scaffold) can still leak through the next (distribution, molecular family): name and
  measure that one before claiming success. Write abstention rules before opening the set that judges
  them.

## 9. Shared rendering math and Spin 3D

- Molecule rendering math (bond geometry, double and triple bond gaps, wedges and hashes, atom-label
  content and layout, stroke widths, depth cues) lives **only** in `packages/layout-engine`. App code,
  including the spin overlay, imports it and never keeps its own copy, even temporarily: two copies
  once diverged silently. Export a package-internal helper rather than copying it; give app code with
  different behavior a different name.
- Spin 3D shares one `ScreenPlacement` contract across the live overlay, flatten and release, reopen,
  and every drag and typed rotation. `flattenSpunMolecule(..., { placement })` must match
  `projectSpin`. Projection helpers stay in `apps/desktop/src/interaction/`, flattening in
  `documentWorkflow`. Changes here prove themselves with `spin3dModel`, `spinFlatten`,
  `spinFlattenStereo`, `flattenRoundTrip`, `spinOverlay`, and `rotation3d` tests. Force-field work
  follows `PLAN-spin3d-forcefields.md`.

## 10. Commands and toolbars

- Every menu item, toolbar button, palette tool, shortcut, and plugin action is backed by a command in
  the shared registry; never wire major behavior only inside a click handler. Command IDs are
  value-encoded with factory helpers; no generic `*.set` commands with hidden parameters. Do not change
  command IDs unless the active plan retires or introduces them.
- Reuse: `toolsets.ts` maps registry items to palette models, `ToolPalette.tsx` renders the inline
  fallback, `PalettePopoverWindow.tsx` renders native flyouts through the request/snapshot/window-manager
  path, which stays.
- **Toolbar contract:** inline submenu commands invoke exactly once per click; disabled ones never
  invoke; an item with a disabled primary but enabled submenu still opens it; an item with nothing
  enabled is disabled. Inline submenus carry owner/menu/menuitem ARIA; native flyout owners may say
  `aria-haspopup="menu"` but never point `aria-controls` at missing DOM. No invented tooltip filler.
  No permanently disabled buttons: unimplemented tools are removed until their slice lands, and the
  customize gallery excludes them. `disabledReason` is only for transient, state-dependent
  unavailability, and such commands always carry one.

## 11. File-format compatibility

Compatibility is fixture-driven and never claimed beyond fixture coverage. **Tier A** (supported):
atoms, bonds, coordinates, charges, isotopes, radicals, wedges, superatoms, basic R-groups, text,
simple arrows, plus signs, basic brackets and styles. **Tier B** (only with fixtures): R-group logic,
S-groups, polymers, atom lists, mapping, equilibrium and retrosynthesis arrows. **Tier C** (preserve
or approximate, never claim): complex graphics, images, unusual fonts, proprietary style state.
Preserve unknown objects where practical, otherwise warn. CDXML comes before broad CDX writing.

## 12. UI

Familiar to chemists, original in every asset: never copy proprietary icons, templates, dialog art,
help or menu text, sample files, command IDs, or trade dress. Menu and dense icon toolbar on top, a
dominant page workspace, icon-first palettes owned by the document window, panels hidden until needed.
Never show fake chemistry: workspace objects are real `chem-core` objects or an honest disabled state.

## 13. Security, errors, and performance

- **Security.** Plugins get no file, network, native, model, clipboard, or remote-recognition access
  without the matching permission and user action. Outbound network paths are allowlisted in
  `src-tauri/capabilities/`. Imported files are sanitized; malformed input fails safely.
- **Errors are specific.** Not "Import failed." but "CDXML import failed: unsupported bond display type
  "WedgeHashBegin" in object b42." Short for users, detailed in logs. Recognition errors distinguish
  missing model, low confidence, invalid structure, unavailable service, and refused permission.
- **Performance.** Load RDKit, recognition, plugin panels, and optional importers and exporters lazily,
  never at startup. No heavy dependency for a trivial job.

## 14. Testing and verification

Every meaningful change adds or updates tests in its area (schemas and migrations, permissions and
lifecycle, chemistry and format fixtures, export warnings, canvas/export parity, command wiring,
viewport math, mocked recognition). A test that cannot be written yet is explained in the report, with
a TODO only if it is specific (`TODO(cdx-compat): preserve rotation once GraphicObject.rotation
exists`, never `TODO: fix later`). Test platform branches from one host by passing the platform in (§1).

The gauntlet, mirroring CI:

```bash
pnpm lint            # root tsc; stricter than per-package typechecks
pnpm vitest run
pnpm build
git diff --check
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
cargo clippy --all-targets --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Scoped scripts when the work enters their area: `pnpm build:sdk`, `pnpm plugin:extract`,
`pnpm plugin:package`, `pnpm audit:engine3d-sidecar`, `pnpm smoke:engine3d-*`, and
`pnpm smoke:windows-menu-churn` (menus or windows). Pointer, hit-testing, or bridge changes also run
the DOM, agent-bridge, and drawing-tool suites. Interactive surfaces get the hands-on pass in
`docs/manual-stress-checklist.md` on both platforms; add to that list when a slice ships a new
surface, and never replace it with a slice-scoped one.

## 15. Builds, launching, and the stable app

- **Launch from this worktree.** macOS: `./run-app` (packaged build) or `./run-app --dev` (Tauri plus
  Vite hot reload). Windows: `pnpm dev`, or `pnpm --filter @chemdraft/desktop build --bundles nsis`
  for an installer. An already-open window, a sibling worktree's app, `cargo run`, or an old Vite port
  is not proof. Stop other instances from the same checkout first, and report the exact command and
  the success signal (bundle path, or Vite port plus the launched binary).

### 15.1 Every build is labelled by its worktree (do not remove)

Every build shows `<dir> [<branch>]` in the window title, the build stamp, and the `run-app` banner,
driven by `CHEMDRAFT_WORKTREE_LABEL` (`build.rs` re-emits it so cargo recompiles the title). Do not
strip it from `run-app`, `vite.config.ts`, `lib.rs` (`main_window_title`), or `build.rs`, and report
the label you saw. Only a stable build (on `main`, or `CHEMDRAFT_STABLE_BUILD=1` through
`scripts/desktop-tauri.mjs`) is unlabelled, on both platforms.

### 15.2 The stable app is never replaced (do not remove)

The stable app (`/Applications/ChemDraft.app`; `%LOCALAPPDATA%\ChemDraft` on Windows) is built from
`main` as `org.chemdraft.desktop`. Branch builds are a different application, `ChemDraft (dev)` with
identifier `org.chemdraft.desktop.dev.<worktree-slug>`, their own app data (fresh settings and
plugins), and their own single-instance lock; on macOS `run-app` **moves** (never copies) the bundle
into `<worktree>/app/`. A branch never builds over, renames, or unregisters the stable app.
`./run-app --dev` runs a bare binary with no bundle identifier, invisible to identifier-scoped tools.
Identify a build by its stamp, never by its window.

## 16. Closeout and report

Keep tasks narrow, touch the smallest set of files, preserve package boundaries, and never invent a
dependency's capabilities. At closeout:

- Bump `CURRENT_BUILD_STAMP` in `apps/desktop/src/MainWindow.tsx` (CI requires it for any change under
  `apps/desktop/src`, `src-tauri/src`, or `packages`). Its suffix names the authoring agent (`-opus`,
  `-codex`, `-fable`), never the branch.
- Launch the new build (§15) and run the gauntlet (§14).
- Move a finished slice from `PLANS.md` to `docs/shipped/README.md`.
- Report: **Summary**, **Files changed**, **Tests run**, **Results** (pass or fail, honestly),
  **Platforms** (macOS and Windows each verified, or unverified with what remains to check),
  **Known limitations**, and **One recommended next task**.

## 17. Older section numbers

Source comments and docs cite this file's numbering before the 2026-10-04 consolidation. They map:

| Old | Now | Old | Now |
|---|---|---|---|
| §1 | §2 | §8, §8a | §4.2–§4.6 |
| §2, §3, §9 | §10 | §8b, §9a | §8 |
| §4 | §2, §10, §12 | §8c | §4.7 |
| §5.7, §10 | §7 | §11, §12 | §11, §12 |
| §5.26, §5.27 | §9 | §13, §19, §20 | §14 |
| §6.n (by package) | §6 | §14, §15, §16 | §13 |
| §7 | §4.1, §4.4 | §17, §18, §22 | §16 |
| §21, §21.1, §21.2 | §15, §15.1, §15.2 | | |
