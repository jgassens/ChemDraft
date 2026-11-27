# ChemDraft Plans

This file describes **the slice currently in flight** — nothing else. Completed slices move to
`docs/shipped/README.md` when they land, so that an agent told to "follow docs/plans/PLANS.md" gets the work
in progress rather than a changelog.

---

# In flight

## Molecule angle entry (`resubmit/molecule-rotation`)

Adapt the requested numeric context-menu option from #183 to current main's shared canvas-menu
model and current rigid rotation engine. Offer Rotate Molecule only for a whole native molecule;
reuse angle entry, preview, cancel and Undo/Redo. Keep current pointer rotation and Shift/tilt
behavior. Cover both platform settings, arbitrary angles, isotope/charge/stereo and geometry.
Native Windows and both macOS builds remain unverified.

## Main document zoom controls (`resubmit/document-zoom`)

Rebuild #188 on current main. Add the customizable Main widget with Zoom Out/In and exact
25/50/75/100/200/400% presets. Step buttons through 25/50/75/100/125/150/200/300/400/600/850%;
keep wheel/pinch smooth. Anchor toolbar/keyboard zoom at the measured visible workspace center,
accounting for rulers and scrollbars, and guard queued work when documents change. Broadcast only
validated small view state to palettes. Preserve document geometry/history and current clipboard,
assistant, text/color and menu infrastructure. Native Windows and both macOS checks remain pending.

## Native effect color picker (`resubmit/effect-color-picker`)

Rebuild #180 on current main's art/text color and opening-session protocol. Route effect colors
through the existing owned popover, preserve target-specific preview/commit/cancel and opening
identity, and keep the inline web fallback. Cover target changes, ordinary paint and dismissal.
Native Windows and both macOS builds, display scaling and monitor checks remain pending.

## Fixed-width text wrapping (`resubmit/text-box-wrap`)

Rebuild #216 with current font/script metrics, shared SVG live editing, conditions text and page-fit
bounds. Wrap resized fixed-width/fixed-size ordinary text without rewriting its source. Share
word wrapping and line metrics with sizing; distinguish paragraphs from soft wraps. Keep authored
reaction conditions and auto text unchanged. Test drag/release/blur, Undo/Redo, formatted text,
Unicode and Windows paragraphs. Native Windows and both macOS builds remain pending.

## Curly pair usage hint (`resubmit/curly-bracket-pair`)

Current main already implements curly/square/round pairs and editable repeat labels, superseding
the implementation proposed in #185. Correct the remaining stale single-glyph hint on the curly
tool and characterize click/drag pair placement. No duplicate tool or document/schema changes.

## Nested inspector scrollbar drag (`resubmit/palette-scrollbar`)

Resubmit #178 against current main. Palettes drag from their background again; only presses that
may be scrollbar presses are excluded. A press whose target is a scroll owner showing a scrollbar
(overflow auto/scroll/overlay on an axis where its content overflows, and the scrollbar not hidden
by `scrollbar-width: none` or a zero-size `::-webkit-scrollbar`) stays with the webview, on both
the drag and the Windows text-input-lease hand-back paths. That includes the owner's own blank
area, since overlay scrollbars draw inside it; its descendants, scrollers whose content fits, and
the hidden-scrollbar floating tool palette background still drag. Preserve native title dragging,
disabled-control exclusion, click compensation and the mouse fallback. Test both platform routes; actual Windows/macOS
scrollbar dragging and mixed-DPI native checks remain pending.

## Image drag and drop (`feat/1.2.3-image-drop`)

Drop PNG, JPEG, GIF, WebP and SVG files on the canvas (owner request for 1.2.3), as native picture
objects through `createImageGraphicObject`, the same model Paste Picture uses. One shared handler in
`apps/desktop/src/imageDrop/` serves the Tauri path drop and the browser `File` drop: pictures are
recognised by their bytes, documents keep the open path unchanged, BMP/TIFF/HEIC/AVIF/SVGZ/PDF and
files over 20 MB are refused by name before reading. JPEG/GIF/WebP are decoded by the webview after a
header pixel-cap check and stored as PNG; SVG is sanitised into an inert, allow-listed copy. All
pictures of a drop are one "Insert Image" entry, placed at the drop point (per-platform position
conversion; on macOS Rust removes the live title-bar inset, `file_drop.rs`), in the tab under the drop
only; the drop's status stays with that tab and is also shown on the tab in front. No drop navigates any window. Pictures keep their aspect
ratio under every resize. Hands-on pass on native Windows and both macOS builds remains pending.

# ChemDraft Assistant plugin (active, branches claude/assistant-*)

## Objective

Add a document-aware Assistant plugin harness for local Claude Code and Codex. It can read the
current document and selection and place results directly on the page through typed host tools.

## Design decisions

- The host owns CLI discovery, pinning, install, sign-in, consent, command rendering, process
  lifetime, and local MCP; the plugin owns provider choice, prompt, transcript, and UI.
- Results land directly, with no approval window. Send fixes the write scope: selected objects and
  objects inserted by that request. Each request is one labeled undo entry, selects what changed,
  and redo never calls AI.
- A canvas overlay is allowed alongside the floating assistant panel. Consent names the receiving
  company and says document/page content leaves the computer.
- PRs B/C update AGENTS.md §4.4 and §12 with their corresponding behavior.

## Delivery sequence

1. **PR A — runner (merged, #186):** external-tool catalog, pins, probe/install/sign-in, consent,
   supervised runs, plugin API tools, dialog/controller, and documentation.
2. **PR B — assistant tools + local tool server (current):** batch/write scope, direct assistant
   writes and request transaction, document tools, shared reaction/grid layout, API 0.1.9
   `assistant`, run-to-session binding, and the hardened loopback MCP server. Owner decisions are
   applied: writes need no approval window; scope is the Send selection plus request insertions;
   each request is one undo entry; provider web access is open.
3. **PR C — panel input + canvas overlay (complete):** plugin input sections, panel action routing, and the
   viewport prompt overlay.
4. **Plugin repository:** `org.chemdraft.assistant`, providers, system prompt, transcript, tests,
   and release.
5. **PR D — catalog + docs:** official catalog entry, release URLs, agent documentation, and slice
   closeout.

## Verification

- macOS and Windows probe/install/sign-in/cancel paths; no batch shims or console flash.
- Pinned download checksum, archive-entry, signature, and rollback tests; release pin check.
- Consent is per plugin/tool and revocable; the host accepts no plugin argv, environment, or paths.
- Cancel/quit kills process trees (including the Windows Job Object); output limits and typed errors
  are reported. Assistant writes obey scope, group into one undo, and select touched objects.

---

# Plugin live panels (API 0.1.30)

For an educational plugin that shows a target NMR spectrum beside the live prediction for whatever
the student draws. Generic: any plugin can use it.

- **Live re-run.** A panel report may set `liveRerun: true` with `rerunCommandId` (schema rejects
  the flag alone). While such a panel is open, in-app or detached, each change to the active document
  re-invokes `rerunCommandId` 250 ms after the last change, through MainWindow's per-plugin command
  queue (the "Run again" path), so runs never overlap. Selection-only and viewport changes, the
  plugin's own report, and documents committed by the same plugin's own `document.write` (tagged at
  commit in `applyDocumentPatch`) do not trigger it. It stops when the panel closes, the plugin is
  unloaded, or a report without the flag replaces it. A live panel hides the "out of date" banner
  only while its re-run is scheduled or running; it shows it when its last run failed or its result
  is stale with nothing pending.
- **`documents.getMolecules()`** (`document.read`): every molecule on the active page, in the
  `getSelection` per-molecule shape, regardless of selection. In-process and worker plugins.
- **Files:** `packages/plugin-api/src/{index,workerProtocol,workerRuntime}.ts`,
  `packages/plugin-host/src/index.ts`, `apps/desktop/src/plugins/{livePanelRerun,selectionSnapshot,createPluginRuntime}.ts`,
  `apps/desktop/src/MainWindow.tsx` (hook call, banner rule, write-author tagging, failed-command
  state; the plugin command queue itself is unchanged), AUTHORING.md, AGENTS.md §4.1.
- **Tests:** `reportLimits.test.ts`, `workerProtocol.test.ts`, plugin-host `index.test.ts`,
  `livePanelRerun.dom.test.ts`, `selectionSnapshot.test.ts`, `plugins/MainWindow.plugins.dom.test.ts`.
- **Preloaded web plugins (no API change).** The browser build can run released packages that whoever
  builds or serves it stages with `scripts/stage-web-plugins.mjs` (install gates, `.sha256` required)
  and serves at `/web-plugins/` (`CHEMDRAFT_WEB_PLUGINS_DIR`, `dev:web:plugins` / `build:web:plugins`;
  refused in any Tauri build). Loaded by `plugins/webPreloadedPlugins.ts` through `loadPackagedPlugin`
  with the installed-plugin gates and handshake; listed as Preloaded in the Plugin Manager. This is
  how the external NMR teaching plugin runs on the web without entering this repository (PLAN.md §5).
  Tests: `webPreloadedPlugins{,.dom}.test.ts`, `scripts/web-plugins/{stage,vitePlugin}.test.ts`.
  Remaining: a hands-on browser pass with a real package; Windows paths in the staging script.
- **Remaining:** request-bound writes (API 0.1.26 request history) are not tagged with their plugin,
  so a live command writing through a request would still re-trigger itself; hands-on pass of a live panel on macOS and Windows; move to `docs/shipped/` on landing.

# Parked

These items are not in flight; reopening any item needs a reason recorded here first.

The analyzers slice shipped and moved to
[`docs/shipped/analyzers-property-prediction-suite.md`](docs/shipped/analyzers-property-prediction-suite.md).
What remains open from it:

- **The prospective applicability protocol**, `docs/benchmarks/pka-applicability-prospective-protocol.md`.
  §7 — the rule deciding when a prediction is shown with an interval, without one, or not at all — is
  deliberately blank, and the evaluation set it will be judged on has not been assembled. Order of
  operations is enforced by three commits in sequence: the sealed set's hash, then the rule, then the
  scores. Writing the rule after seeing the set voids the result.
- **OpenClatura silent omission.** A validated patch exists at `docs/benchmarks/openclatura-patch`; it
  has not been submitted upstream.
- **The pKa model itself is frozen** at SHA-256 `79061c4d…`. Model research is stopped, not paused for
  lack of ideas: the measured gap is not where feature or optimizer work reaches. Reopening it needs a
  reason recorded here first.

Other parked work:

- **Structure naming on the CLI and MCP (jgassens/ChemDraft#165 follow-up).** The policy is shared in
  `document-workflow-core/structureName.ts`; a headless caller needs the engine directory listed in the
  user's trust file (§5), never an environment variable alone.
- **MolScribe engine install on the `engineInstall` dialog kind.** The OCSR install still uses its own
  flow; moving it onto the shared dialog kind the naming engine introduced is parked.

---

# Known open items (not in flight)

These are standing gaps left by the toolbar,
palette, and arrow bug-fixes slice (shipped 2026-08-02, PR #26, merge `2fa4c21` — see
`docs/shipped/README.md`), not active work. One of its three original open items has since been
fixed; it is not repeated here.

1. **Art inspector still styles only graphics and molecules.** `ArtInspectorStyleObject` is
   `GraphicObject | MoleculeObject` (`apps/desktop/src/artInspectorModel.ts:156`), so Color
   Controls and Object Settings route a bracket or mechanism-arrow selection to a status message
   rather than a working panel. Widening it is its own slice.
2. **Stale comment in the CDXML importer.** `packages/cdx-compat/src/index.ts:2445` says
   equilibrium and retrosynthesis "stay the legacy `reaction-arrow` object until they're migrated
   in a later pass" — they were migrated in `163d7b7` and `4248c59`, and the condition on the
   line below already routes all four kinds to `importReactionArrowAsArtArrow`. Only `unknown` is
   legacy now. One-line comment fix.

(Fixed since: the third original open item — that electron-pushing arrows were art, not mechanism
annotations, and `tool.mechanismArrow` was a retired stub — was resolved 2026-08-12 by PR #32,
merge `a4477da`. `tool.mechanismArrow` and `tool.mechanismFishhook` are now live, atom/charge-anchored
`mechanism-arrow` document objects; see `docs/shipped/README.md`. `packages/mechanism-tools` is
still only shared types, but the working feature lives in `chem-core`, `documentWorkflow.ts`, and
`layout-engine`, not that package.)

Work scoped to a branch other than `main` carries its own plan; this file does not describe it.

---

Repo-wide scope lives in `docs/plans/PLAN.md`. One further scoped plan applies inside its area:
`docs/plans/spin3d-forcefields.md` (Phase 3 blocked on owner decisions). The selection-architecture plan
finished and moved to `docs/shipped/selection-policy-refactor.md`.
