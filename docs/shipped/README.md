# Shipped slices

Completed implementation slices, newest first. These moved out of `PLANS.md` on 2026-07-30 so that
file could go back to describing only the work in flight; the records themselves are unchanged apart
from heading levels and cross-reference fixes.

Each entry describes the state as shipped. When a later slice supersedes a decision recorded here,
the superseding entry says so — read the newest entry that touches a subsystem, not the oldest.

**Superseded decisions, at a glance:**

- *Toolbar Wiring and Honesty* decided that the four tool-drawn arrows would be semantic
  `reaction-arrow` objects rather than art graphics. The `codex/toolbar-bug-fixes` slice reversed
  this by agreement: all four families are now art arrows tagged for CDXML interop. See `PLANS.md`.

**Slices with their own file:**

- [Selection Policy Refactor](selection-policy-refactor.md) — one pure selection policy, one hit
  resolver with atom→bond→ring precedence, uniform additive behavior across click/marquee/lasso, and
  cross-molecule part storage. All phases landed; kept separate because its design section still
  documents how selection works today.

---

## Toolbar Wiring and Honesty (2026-07-25) — on `main` (PR #21, merge `a7c88a69`)

Status: all eight phases implemented and hardened across two review rounds, landed together with the
plugin-updates slice below. `TRANSITIONAL_STUB_COMMAND_IDS` is empty — shipped toolsets contain zero
permanently disabled buttons.

An external review plus three adversarial passes found roughly nineteen defects in the first cut of
this slice. All five P1s and the P2s are now fixed with regression tests: imported structures keep
an honest `structureFormat` when edited; CDXML arrows use the real `ArrowType` spellings both ways;
arrow resize transforms the endpoints, not just the frame; axis-aligned arrows get a frame that
contains their glyph; formula text distinguishes a charge magnitude from an atom count and keeps
span styling; Escape cancels an in-flight placement instead of arming it; brackets and arrows are
painted once; brackets and curved art warn when they degrade in foreign CDXML; chains stop at the
page edge and rebuild in one pass; stamps centre on the click and clear stale interaction state;
arrows and orbitals can start on top of an existing object; and the Customize gallery offers
neither transitional stubs nor the compat-only art variants.

A second max-effort review over the combined branch found fifteen more, all now fixed with
regression tests. The four that mattered most: the plugin-update capability scope listed the package
`.zip` but not the `.zip.sha256` fetched right after it, so trusted updates could never complete —
the guard test had only checked that the `.zip` pattern *existed* rather than matching real URLs
against the compiled patterns; rotating a reaction arrow applied the angle twice, because the
anchors were rotated and `rotation` incremented while both renderers apply that transform
themselves; flipping never touched arrow anchors at all, so a mirrored scheme kept every arrow's
original direction; and the formula body pattern backtracked exponentially — measured at 8.8 s for
26 digits, doubling per digit — so a pasted numeric label froze the UI thread. The rest covered
plugin-update failure paths that lost catalog records or deleted live payloads, a chain that could
seed a bond-less carbon at a page edge, CDXML inventing `FullHead` for an unrecognized arrow, and a
Customize gallery that keyed off the user's own layout and so deleted any art tool they removed.

Known remaining gap at the time of shipping: the Art inspector still styles only graphics and
molecules, so Color Controls and Object Settings route a bracket or arrow selection to a status
message rather than a working panel. Widening `ArtInspectorStyleObject` is its own slice. **Still
open** — tracked in `PLANS.md`.

### Objective

An audit found 32 non-functional toolbar buttons/commands: 8 drawing-tool stubs hardcoded to
"Requires an active structure editor" (`apps/desktop/src/drawingTools.ts`), 15 manifest-only stubs
with no live handler (`apps/desktop/src/toolsets/desktop-toolsets.json`), 4 orphaned
`view.toolset.*` customization commands and 4 unwired `style.*` commands
(`apps/desktop/src/commands.ts`), and the Customize gallery offering all of them for drag-out. Two
documented policies conflicted: the older contract tolerated disabled-with-reason placeholders,
while `docs/architecture/native-art-toolbar-chrome-plan.md` mandates hide-don't-disable.

This slice adopts the strict policy repo-wide and wires real functionality wherever existing
infrastructure supports it. After it, shipped toolsets contain zero permanently disabled buttons:
every visible button performs its action, and `disabledReason` is reserved for transient,
state-dependent unavailability (selection-dependent commands and similar).

Key mechanic: `apps/desktop/src/toolsets.ts` merges live `CommandSpec`s over manifest items, so a
live command's enabled state and `disabledReason` win. Un-stubbing means registering live behavior;
the JSON `disabledReason` strings are only fallbacks for commands with no live spec.

### Command retirements (the narrow, explained fix)

These command IDs were retired in this slice. Retirement is deliberate and documented here per the
AGENTS.md command-ID stability rule; each can return via git when its feature slice lands.

- `view.toolset.resetLayout`, `view.toolset.resetAllLayouts`, `view.toolset.createUserToolset`,
  `view.toolset.cloneToolset` — the Customize Toolbars dialog performs these actions directly
  through `layoutStateEdits.ts`; the standalone command entries were dead redirects.
- `style.bondStroke`, `style.textSize`, `style.preset.synthetic` — reasonless disabled stubs with
  zero references; superseded by the live style widgets and Molecule Inspector.
- `style.importStyleSheet` — redundant: the Molecule Inspector already imports `.cds` style sheets
  through the style compatibility boundary.
- `tool.mechanismArrow` — mechanism arrows need a real subsystem (atom/bond anchoring, curved
  geometry, half-head markers, renderers, CDXML mapping; `packages/mechanism-tools` is a type stub).
  Deferred to its own future slice; no decorative button meanwhile.
- `tool.templateGrid` — the template library (`packages/template-library`) is an empty stub; a
  template corpus plus grid-picker UI is its own future slice.
- `tool.arrows` — pure duplication of `tool.reactionArrow`'s command-grid submenu.
- `tool.toolOptions` — no defined behavior; lived only in the hidden `core.style` toolset.
- `tool.shape` — manifest items re-point to the live `tool.art.rect` command (shared `Art_Shapes`
  asset per the one-asset-per-command rule); the vague duplicate ID retires.
- `tool.shapeShadow` — retired outright: shadow art variants (`tool.art.rectShadow`,
  `tool.art.circleGloss`, …) are deliberately compat-only and stay out of shipped toolbars; shadow
  styling is applied through the Art inspector's effects.

`surface.canvas.addPageAfter` stays as disabled metadata: the surface registry does not drive
rendered UI (PLAN.md 6.15 sanctions it explicitly — "may exist only as disabled metadata until
`document.addPageAfter` is implemented and wired").

### Disposition of all audited items

| Disposition | Items | Phase |
| --- | --- | --- |
| Wire | tool.atom, tool.settings, style.color, tool.dagger, tool.symbol | 2 |
| Wire | tool.reactionArrow, tool.resonanceArrow, tool.equilibriumArrow, tool.retroArrow | 3 |
| Wire | tool.lobe, tool.shadedLobe, tool.pOrbital, tool.sOrbital | 4 |
| Wire | tool.bracket, tool.squareBracket | 5 |
| Wire | tool.chain, style.formulaText | 6 |
| Re-point | tool.shape → tool.art.rect | 2 |
| Retire | tool.shapeShadow (shadow variants are compat-only; Art inspector effects own shadows) | 2 |
| Retire | mechanismArrow, templateGrid, arrows, toolOptions, importStyleSheet, bondStroke, textSize, preset.synthetic, 4 × view.toolset.* | 1 |
| Keep | surface.canvas.addPageAfter (non-rendered metadata) | — |

### Design decisions

- **Arrows are semantic objects.** *(Superseded 2026-07-27 — see `PLANS.md`. The four families are
  now art arrows tagged for CDXML interop.)* The four wired arrow tools create `reaction-arrow`
  document objects (`packages/chem-core`), not art graphics: the semantic type already has canvas
  rendering, selection/move/transform support, SVG export, and CDXML export+import. Art-route
  arrows would make tool-drawn and CDXML-imported arrows different object types. `arrowKind` gains
  `"resonance"` (additive; round-trips verbatim). Head geometry gets one shared plan in
  `packages/layout-engine` (`planReactionArrowGeometry`: forward filled head, equilibrium harpoon
  pair, retrosynthesis open double-shaft, resonance double-head) consumed by both the canvas
  renderer and SVG export.
- **Unwirable remainder is deleted, not hidden.** No new schema `hidden` field, no seeded layout
  state. Deletion is git-reversible and keeps exactly one honesty mechanism.
- **The Customize gallery excludes permanent stubs** using a static manifest-derived set (specs from
  `getToolsetCommandSpecs()` are availability-independent) — never live `enabled === false`, which
  would wrongly hide transiently disabled commands like Undo and the align/boolean family.
- **Chain uses press-drag rubber-band**: one gesture, one undo entry, no modal click-state machine.
  Segment count from drag length / `bondLengthPx`; zig-zag `±(180 − chainAngleDegrees)/2` about the
  drag axis, with `chainAngleDegrees` resolved from the target molecule's style.

### Delivery sequence

Each phase was one independently green commit (code + pinned-test updates together). The
"expected stub set" test introduced in Phase 1 asserts the exact remaining stub command IDs and
shrinks every phase, reaching empty in Phase 6 and locked by a policy test in Phase 7.

- **Phase 0 — Docs.** The PLANS.md section; AGENTS.md Toolbar Button Contract and §9 updates;
  PLAN.md §6.11/§6.13 updates; build stamp.
- **Phase 1 — Cleanup.** Delete the retired commands (`commands.ts`, `drawingTools.ts`,
  `desktop-toolsets.json` including the two retired IDs inside `tool.reactionArrow`'s submenu);
  gallery stub filter at the `MainWindow.tsx` call site; rewrite the placeholder-count test into the
  exact-stub-set test; update customize-command, chrome-cluster, and manifest-position tests; add a
  gallery-exclusion test.
- **Phase 2 — Quick wires.** `tool.atom` activates the existing atom-label editor on atom click;
  `tool.settings` toggles the Molecule Inspector toolset; `style.color` opens the existing
  object-color controls for the selection; shape/shapeShadow manifest re-points; `tool.dagger` and
  `tool.symbol` become glyph-stamp tools (one text object per click, command-grid submenu of common
  chemistry symbols).
- **Phase 3 — Arrows.** Enum + CDXML import case; shared geometry plan; canvas + SVG renderers on
  the plan; `insertNativeReactionArrow` with click-place and drag-place; enable the four tools.
- **Phase 4 — Orbitals.** Four parametric art-shape rows (teardrop lobe, gradient shaded lobe,
  mirrored two-lobe p orbital, radial-gradient s orbital) with their chemistry command IDs; the art
  pipeline provides pointer handling, transform chrome, and SVG export for free.
- **Phase 5 — Brackets.** Shared `bracketGlyphPathD` generator moves into `layout-engine`; real SVG
  export fragment replaces the labeled-box fallback; `insertNativeBracket` click placement; canvas
  glyph consumes the shared generator.
- **Phase 6 — Chain + formula text.** `planNativeChain`/`applyNativeChainPlan` press-drag tool with
  live preview, Esc cancel, single history entry; `style.formulaText` becomes a one-shot formatting
  command (element-trailing digits → subscript, trailing charge → superscript) over selected text
  objects.
- **Phase 7 — Closeout.** Policy lock test (zero permanently disabled specs in shipped toolsets;
  gallery exclusion holds); usage-hint invariant covers every definition; final stamps.

### Verification

Per phase:

```bash
pnpm vitest run \
  apps/desktop/src/App.test.ts \
  apps/desktop/src/drawingTools.test.ts \
  apps/desktop/src/toolsets.test.ts \
  apps/desktop/src/commands.test.ts \
  apps/desktop/src/documentWorkflow.test.ts \
  apps/desktop/src/toolbars/CustomizeMainToolbar/galleryModel.test.ts \
  packages/layout-engine/src/index.test.ts
```

plus `packages/chem-core` and `packages/cdx-compat` suites when touched. At closeout:

```bash
pnpm lint
pnpm build
git diff --check
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Manual stress pass in the running app after Phases 3, 5, and 6: draw each arrow kind and resize its
heads, place and resize both bracket kinds, drag a chain off an existing atom and off empty canvas,
apply formula text to a typed formula, and confirm SVG export matches the canvas for each.

Definition of done, as met:

- Shipped toolsets contain zero permanently disabled buttons; every visible button performs its
  action.
- The Customize gallery cannot produce a decorative disabled button.
- Reaction, resonance, equilibrium, and retrosynthesis arrows are semantic objects that round-trip
  CDXML. *(Superseded: they are now art arrows that round-trip CDXML.)*
- Orbitals, brackets, symbols, chain, and formula text create real document objects with undo/redo,
  save/reopen, and SVG export parity.
- AGENTS.md, PLAN.md, and the plans file describe the shipped state; build stamps updated.

---

## Host-managed plugin updates (2026-07-25) — on `main` (PR #21, merge `a7c88a69`)

A concurrent session's implementation was ported file-by-file rather than merged: its branch forked
before the toolbar slice, so taking its tree would have reverted eight commits of tool wiring. It
landed on `main` alongside the toolbar slice through PR #21. Only two things were carried forward
from an earlier parked snapshot, both reworked.

(Every branch involved — the concurrent session's, the parked snapshot's, and the shared feature
branch — has been deleted. PR numbers and commit SHAs are the durable references; branch names are
not, so this file names them only where one still exists.)

Ported forward from the parked snapshot:

- `pruneOrphanedPluginPackages`, which reclaims checksum-addressed directories left by a failed
  update or an incomplete cleanup. Its first version keyed off "no records", which
  `loadInstalledPluginRecords` also returns for an unreadable, truncated, or partially-invalid
  catalog — so a momentary IO problem would have deleted a healthy install's payload. The catalog
  now reports `absent` / `loaded` / `unreadable`, and the sweep acts only on the first two.
- The published `.sha256` is fetched and must agree with the digest GitHub recorded for the asset,
  which makes the existing sidecar-must-exist rule mean something. It reuses the same bounded,
  redirect-validating download path as the package, so it is size-capped while streaming rather
  than after buffering, and accepts the uppercase digests Windows publishers produce.

Fixed in the incoming implementation:

- `uninstallPlugin` validated the recorded staging path *after* unregistering the plugin, so a path
  the validator rejects left the plugin gone from the session but still in the catalog — an
  unremovable ghost. Validation now happens before any runtime state changes.
- Rollback re-activated the superseded descriptor even when it had never been deactivated, which
  could throw and abort the rollback, leaving the host registered against a candidate whose
  directory was about to be deleted.
- A disabled-plugin update tore down only the candidate, leaving the old worker running against
  files that were then removed.
- The trusted redirect host was spelled out in both TypeScript and the capability file with nothing
  keeping them in step; a test now pins them together, since GitHub has moved that host before.

### Objective

Add a separate, user-initiated plugin update path to the existing Plugin Manager. ChemDraft owns
the update source, download, package verification, worker handshake, replacement transaction, and
rollback. Plugins remain sandboxed and receive no new network, filesystem, or native-execution
capabilities. Sparkle continues to update only the ChemDraft application bundle.

The first trusted catalog entry is the standalone NMR Predictor plugin
(`org.chemdraft.nmr.predictor`). A check must distinguish update available, up to date, unsupported,
and failed states without silently installing anything. Applying an offered update requires an
explicit user action and must show the target version and package-integrity details.

### Safety and compatibility contract

- Update metadata is host-owned and allowlisted by plugin id; an installed plugin cannot choose its
  own download URL.
- Remote version and checksum metadata are treated as untrusted input and validated before use.
- The downloaded archive must pass the existing SHA-256, CRC/path, strict manifest, API-version,
  permission-review, and worker-handshake gates.
- The archive manifest id must match the installed plugin id, and its version must be strictly newer.
- Replacement is transactional: keep the current package and registration usable until the new
  package has passed staging and handshake, then commit the new package and record. Any failure
  restores the old package, record, registration, and enabled/disabled preference.
- Update checks and installs are user-initiated in this slice. No background polling, silent
  download, silent install, or restart-time mutation.
- A checksum proves integrity only, not publisher identity. The UI and documentation must not call
  an unsigned package cryptographically signed or fully automatic; publisher-signature support is
  a separate follow-up.

### Verification

- Focused tests cover catalog allowlisting, metadata parsing, semantic version comparison, download
  checksum enforcement, manifest-id/version enforcement, successful replacement, rollback, and
  disabled-plugin preservation.
- Plugin Manager DOM tests cover checking, up-to-date, available-update, progress, confirmation,
  success, and error states.
- Run `pnpm lint`, `pnpm test`, `pnpm build`, `git diff --check`, and the relevant Rust checks when
  native code changes.
- Launch this worktree through `./run-app` or `./run-app --dev` and verify the visible worktree
  label in the window title and build stamp matches the branch you meant to test.

---

## Sparkle macOS updates (2026-07-24)

The desktop app uses Sparkle 2 to check the signed macOS appcast automatically and offer newer
versions through Sparkle's native UI. File > Check for Updates… triggers a visible user-initiated
check. Sparkle replaces the application bundle only; installed plugin packages remain in the stable
Application Support `installed-plugins` directory and are revalidated by the normal runtime after
relaunch. Plugin/API incompatibility remains the plugin author's responsibility and must not block or
rewrite an app update.

Release and notarization procedure lives in `docs/releasing/macos-updates.md`.

---

## Runtime union merge (2026-07-16, merge commit `1232a444`)

The plugin program (M1–M36: plugin runtime, NMR/mass analyzers, worker isolation, packaging,
installer, manager) merged into the trunk per ADR-0030: trunk = `main`, plugin architecture = the
plugin program's, with main's four unique plugin pieces (stable command registry,
toolset-contribution stage, disk-backed plugin storage, patch-review tray) ported onto that runtime
and one unified panel renderer serving both the in-app surface and floating panel windows. That
program's full plan and milestone records live in the planning workspace
(`~/Documents/programming/Chemdraft-NMRplugin`) and in `docs/nmr-plugin-planning/`; they are not
duplicated here. Remaining plugin-separation work (publish the SDK, strip bundled NMR,
from-zero install test) is queued there as PLAN-plugin-separation Phases 2+.

The shipped rules this left behind are recorded in AGENTS.md §8a.

---

## Rings Toolbar and Molecule Inspector Tabs (completed 2026-07)

The Rings/Structure/Atom Labels slice shipped: ring appearance lives in its own compact
`core.ringInspector` toolbar, and the Molecule Inspector carries Structure and Atom Labels tabs with
multi-molecule targeting, mixed values, sparse per-atom overrides, `.cds` style-sheet import through
the style compatibility boundary, `.template` export, and a shared font catalog backed by the raster
export font database. Durable schema and architecture notes live in
`docs/architecture/toolbars-and-toolsets.md` and `packages/toolset-registry/README.md`.
