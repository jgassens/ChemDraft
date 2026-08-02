# ChemDraft Toolbar Bug-Fix Branch Code Review

**Review date:** 2026-07-31  
**Branch reviewed:** `codex/toolbar-bug-fixes`  
**Reviewed head:** `e1eb700f5c4b183e7e582a670808c44e0c6dcb76`  
**Base branch:** `origin/main`  
**Merge base:** `3e690db7179419cd7df35aa8860a6cc3f744ab27`  
**Diff size:** 68 files, 8,039 insertions, 936 deletions

## Executive summary

The branch is **not ready to merge in its current state**. The review found 14 discrete,
actionable issues:

| Priority | Count | Meaning in this report |
|---|---:|---|
| P1 | 2 | Release-blocking correctness problems; fix before merge. |
| P2 | 11 | Significant user-facing, persistence, interaction, or development-workflow regressions. |
| P3 | 1 | A narrower edge case that makes the UI misleading but does not alter chemistry. |

The two P1 findings are both interchange failures:

1. Fishhook and no-reaction arrows do not survive SVG/PDF export visually.
2. Standard CDXML reaction arrows import with a transposed object frame, even though their
   endpoints are parsed correctly.

The highest-risk P2 findings are silent CDXML appearance loss, loss of previously saved toolbar
customization after the arrow command-ID migration, incorrect arrowhead resizing on scaled
dual-shaft arrows, and native-window races affecting popover and tooltip placement.

No finding suggests that this branch directly changes atom identity, bond order, charge, or other
chemical identity. The principal risks are visual fidelity, geometry/editing correctness, saved UI
state, and macOS development/release behavior.

## Review scope and method

The review compared the complete branch against the supplied merge base:

```bash
git diff 3e690db7179419cd7df35aa8860a6cc3f744ab27
```

The pass covered:

- toolbar and toolset manifests;
- persisted customization and command-ID compatibility;
- selection-aware style widgets and arrow commands;
- native palette, popover, tooltip, and Rust window transport;
- art-engine arrow geometry and editing inverses;
- SVG, PDF, and CDXML import/export paths;
- the worktree-specific macOS bundle launcher and Sparkle configuration;
- temporary diagnostics included in production output;
- focused and full test behavior.

Repository guidance checked during the review included the toolbar button contract, ownership of the
toolset registry and native flyout transport, the active arrow implementation plan, and the rule that
lossy export must warn and exported arrows must match the canvas.

The review was read-only. This Markdown report is the only artifact added afterward.

## Findings summary

| ID | Priority | Area | User-visible consequence | Primary location |
|---|---|---|---|---|
| F-01 | P1 | SVG/PDF export | Fishhooks become bars; the no-reaction X disappears. | `apps/desktop/src/documentWorkflow.ts:456-469` |
| F-02 | P1 | CDXML import | Reaction-arrow selection and transform frames are transposed. | `packages/cdx-compat/src/index.ts:1979` |
| F-03 | P2 | CDXML export | Dashed/color/head edits are silently lost externally. | `packages/cdx-compat/src/index.ts:716-720` |
| F-04 | P2 | Toolbar persistence | Saved visibility and order for legacy arrow commands stop applying. | `apps/desktop/src/toolsets/desktop-toolsets.json:484-494` |
| F-05 | P2 | Arrow editing | Resizing a scaled equilibrium head multiplies the requested size twice. | `packages/art-engine/src/index.ts:877` |
| F-06 | P2 | Native popovers | A cold/prewarm-race popover can open displaced from its button. | `apps/desktop/src/PaletteWindow.tsx:724-728` |
| F-07 | P2 | Native tooltips | A delayed show can resurrect a tooltip after pointer leave. | `apps/desktop/src/PaletteWindow.tsx:598-610` |
| F-08 | P2 | Arrow defaults | A dashed tool cannot remember an explicitly solid default. | `apps/desktop/src/documentWorkflow.ts:1869-1870` |
| F-09 | P2 | Arrow editing | Short equilibrium shafts jump when their length handle is grabbed. | `packages/art-engine/src/index.ts:1521-1523` |
| F-10 | P2 | Style inspector | Asymmetric start/end head sizes are falsely reported as uniform. | `apps/desktop/src/artInspectorModel.ts:213-223` |
| F-11 | P2 | Style widget | Pointer cancellation can freeze the widget on the wrong selection layout. | `apps/desktop/src/toolbars/mainStyleWidget/MainStyleWidget.tsx:66-70` |
| F-12 | P2 | macOS updates | A dev bundle checks a production update feed with a different bundle identity. | `run-app:551` |
| F-13 | P2 | Production hygiene | A self-driving, document-mutating diagnostic is shipped in production output. | `apps/desktop/src/main.tsx:12-14` |
| F-14 | P3 | Style widget | Mixed-width selections offer head sizes that cannot render as selected. | `apps/desktop/src/toolbars/mainStyleWidget/ArrowVariant.tsx:49-54` |

## Detailed findings

### F-01 — SVG/PDF export omits the new arrow visuals

**Priority:** P1  
**Locations:** `apps/desktop/src/documentWorkflow.ts:456-469`; `packages/layout-engine/src/index.ts:3624-3764`

**Observed behavior.** The branch adds `half-arrow`, used by straight and curved fishhooks, and
`shaftMark: "cross"`, used by the no-reaction arrow. The desktop canvas renderer understands both.
The shared layout-engine SVG renderer does not. Its marker switch has no `half-arrow` case, so the
marker falls through to the generic bar fallback, and it never emits `plan.shaftMark`.

A direct SVG export produced this fishhook marker path:

```xml
<path ... d="M 220 92 L 220 108" ... />
```

That is a perpendicular bar, not a single-barb fishhook. The no-reaction arrow exported its normal
filled head but no X. Both exports returned empty warning arrays. PDF export delegates through the
same SVG representation, so it inherits both defects.

**Impact.** A scientific figure leaving the app does not match the drawing the user reviewed on
screen. This violates the repository rule requiring exported arrows to match the canvas and requiring
a warning whenever export is lossy.

**Recommended correction.** Add shared layout-engine rendering for `half-arrow` and
`NativeArtShaftMarkPlan`. Keep the geometry in the shared rendering layer. If a format cannot
represent either concept, return a precise warning rather than silently substituting or omitting it.

**Regression tests.** Add SVG tests for straight/curved fishhooks and the no-reaction cross; add a
PDF test proving it consumes the corrected SVG; compare marker kind, shaft mark, color, width, and
opacity against the canvas plan.

### F-02 — CDXML reaction-arrow frames use the wrong coordinate order

**Priority:** P1  
**Location:** `packages/cdx-compat/src/index.ts:1979`

**Observed behavior.** `importReactionArrowAsArtArrow` now reuses `importShapeGraphic`. That generic
importer treats a line graphic's `BoundingBox` as XY coordinates. Standard CDXML reaction-arrow
bounding boxes use the vertical-horizontal, or YX, order used by `formatLineBoundingBox` and
`parseBoundingBox`.

The endpoints are correctly parsed with the YX point parser, but the containing object frame is not.
For a horizontal arrow whose converted endpoints differ by about 170.67 px in X and not in Y, the
imported frame was:

```json
{ "width": 1, "height": 170.66666666666666 }
```

The visual line remains horizontal while selection, hit testing, and transform geometry see a tall,
one-pixel-wide object.

**Impact.** Ordinary third-party CDXML can display an arrow in one place while its selection and
transform frame describe a different shape. The included reaction-arrow fixture follows this path.

**Recommended correction.** Give semantic reaction arrows a YX-aware frame path. Parse their frame
with `parseBoundingBox`, or override the generic result from the correctly parsed line endpoints.
Do not change the XY convention used by generic CDXML graphic objects.

**Regression tests.** Import non-square horizontal and vertical arrows for forward, resonance,
equilibrium, and retrosynthetic `ArrowType` values. Assert frame/endpoints and selection bounds, not
only `artToolId`.

### F-03 — Semantic CDXML export silently drops edited appearance

**Priority:** P2  
**Location:** `packages/cdx-compat/src/index.ts:716-720`

**Observed behavior.** `exportSemanticReactionArrowGraphic` emits only `GraphicType`, `ArrowType`,
`BoundingBox`, `Start`, and `End`. Unlike the generic graphic exporter, it does not call the existing
color or `LineType` helpers.

Direct reproductions showed that `reactionArrowDashed` exported without `LineType="Dashed"`, and an
edited semantic arrow whose end head was removed still exported as `ArrowType="FullHead"`. Neither
loss produced a relevant warning. External software therefore reconstructs a default solid,
full-headed reaction arrow even when that is not what the ChemDraft canvas shows.

**Recommended correction.** Pass the warnings collection into this exporter, reuse
`cdxmlGraphicColorAttribute` and `cdxmlLineTypeAttributes`, and map marker state to a standard
`ArrowType` only when truthful. Warn for geometry or marker state that standard CDXML cannot carry.

**Regression tests.** Cover red/dashed and bold semantic arrows, removed or changed heads, and an
external reopen test that does not rely on ChemDraft's embedded native payload.

### F-04 — Saved arrow toolbar customizations are not migrated

**Priority:** P2  
**Location:** `apps/desktop/src/toolsets/desktop-toolsets.json:484-494`

The branch deliberately transitions four semantic arrow buttons:

| Legacy ID | New ID |
|---|---|
| `tool.reactionArrow` | `tool.art.reactionArrow` |
| `tool.resonanceArrow` | `tool.art.resonanceArrow` |
| `tool.equilibriumArrow` | `tool.art.equilibriumArrow` |
| `tool.retroArrow` | `tool.art.retroArrow` |

**Observed behavior.** Persisted toolbar state is ID-based. Existing `hiddenCommandIds` and
`itemOrder` entries continue to refer to legacy IDs, and no migration remaps them. A reproduced layout
that hid Reaction Arrow and moved Retro first instead showed all four new commands in default order.
The saved data is not deleted; it becomes ineffective after upgrade.

**Recommended correction.** Extend the existing layout migration to map all four IDs before pruning
or layout application. Apply it to both `core.main` and `core.arrows`, audit every persisted ID-bearing
field, and keep the migration pure and idempotent.

**Regression tests.** Load a pre-change layout that hides and reorders all four IDs in both toolsets,
save the migrated state, restart, and prove the result remains stable.

### F-05 — Dual-shaft scaling is applied twice during marker drag

**Priority:** P2  
**Location:** `packages/art-engine/src/index.ts:877`

**Observed behavior.** `planNativeArtVisual` scales an equilibrium marker for display using
`dualShaftScale`. `editGraphicMarkerSize` then measures against that displayed handle but stores the
displayed distance as the raw, unscaled marker size. With scale 2, the reproduction was:

```json
{
  "storedBefore": 14,
  "visualBefore": 28,
  "requestedVisualSize": 40,
  "storedAfter": 40,
  "visualAfter": 80
}
```

**Recommended correction.** Divide displayed distance by `dualShaftArrowScale(object)` before
snapping, comparing, and storing it. Define the clamp behavior at minimum and maximum scale.

**Regression tests.** Exercise scale below 1, equal to 1, and above 1; test symmetric and
Shift/asymmetric resizing; assert the resulting rendered handle remains at the pointer distance.

### F-06 — Cold popover replay loses its anchor

**Priority:** P2  
**Location:** `apps/desktop/src/PaletteWindow.tsx:724-728`

**Observed behavior.** Normal popover content carries content plus a global logical anchor. After
content-fit resizing, the popover reasserts this position because macOS can shift a bottom-anchored
window during resize. On a cold first open, or a click while prewarm is still loading, the initial
content event can precede listener registration. The mount-time request is answered with content only,
so `anchorRef` remains empty and the correction cannot run.

**Recommended correction.** Cache a complete `{content, anchor}` payload after palette position
resolves and before opening the window, then replay that payload. Preserve the rule that a merely
prewarmed window has no payload before the first real user open.

**Regression tests.** Force first emit before listener registration, click during prewarm, and assert
final screen position after resize. Verify warm reuse remains unchanged.

### F-07 — A stale asynchronous tooltip show can win after hide

**Priority:** P2  
**Location:** `apps/desktop/src/PaletteWindow.tsx:598-610`

**Observed behavior.** Showing awaits `currentWindowLogicalPosition()` before broadcasting. Hiding
broadcasts immediately. If the pointer leaves while the position request is pending, hide arrives
first and stale show arrives afterward. Rapid A-to-B hover can likewise let the older tooltip win.

**Recommended correction.** Use a monotonically increasing request generation or cancellation token.
Invalidate it on every show candidate, hide, customization transition, and cleanup; recheck it after
the await and before emitting show.

**Regression tests.** Use a deferred position promise followed by pointer leave, reverse promise
resolution during A-to-B hover, and unmount with a request pending.

### F-08 — Explicitly solid arrow defaults are not representable

**Priority:** P2  
**Location:** `apps/desktop/src/documentWorkflow.ts:1869-1870`

**Observed behavior.** The dashed reaction-arrow tool starts with `strokeDasharray: "6 6"`. Making it
solid removes or leaves undefined the dash property. Default capture records the field only when it is
a string, so the saved style has no instruction to clear the tool's base dash. The next arrow restores
`"6 6"` instead of honoring the solid default.

**Recommended correction.** Represent dash state as three states: not captured, explicit solid, or a
dash string. A nullable field or explicit sentinel can work if the overlay deletes the base dash for
explicit solid. Migrate/validate old localStorage defaults.

**Regression tests.** Cover dashed-to-solid and solid-to-dashed capture, creation, persistence, and
restart.

### F-09 — Short equilibrium shaft handles use a non-invertible inset

**Priority:** P2  
**Location:** `packages/art-engine/src/index.ts:1521-1523`

**Observed behavior.** Handle placement clamps its seat inset to half the shaft length. The inverse
drag calculation always adds the full 16 px inset multiplied by scale. With
`dualShaftForwardFrac = 0.2`, feeding the unchanged handle point into the editor changed the fraction
to `0.32`. The shaft jumps as soon as it is dragged.

**Recommended correction.** Factor the effective seat inset into one helper and use it for placement
and inverse drag math. An unchanged handle must always be a no-op.

**Regression tests.** Round-trip minimum, short, medium, and full lengths for forward/reverse shafts
at multiple scales.

### F-10 — Asymmetric head sizes are reported as uniform

**Priority:** P2  
**Location:** `apps/desktop/src/artInspectorModel.ts:213-223`

**Observed behavior.** The style model reads `markerEnd.sizePx` whenever an end marker exists and uses
the start only otherwise. Shift-drag legitimately allows a 12 px start and 24 px end, but the toolbar
reports `{ value: 24, mixed: false }`. Its size command then updates both heads despite claiming a
uniform current state.

**Recommended correction.** Aggregate every non-none marker represented by the control and report
mixed when start/end sizes differ, including within one object. If start and end should be edited
separately, provide distinctly labeled controls instead.

**Regression tests.** Cover one asymmetric arrow, several arrows with different uniform sizes, mixed
marker presence, and `none` markers.

### F-11 — Pointer cancellation can permanently latch the wrong widget variant

**Priority:** P2  
**Location:** `apps/desktop/src/toolbars/mainStyleWidget/MainStyleWidget.tsx:66-70`

**Observed behavior.** The widget freezes its selection-aware layout during a pointer gesture so the
pressed control is not unmounted before commit. `beginInteraction` sets `interactingRef`, but only
window-level `pointerup` clears it. A `pointercancel` from OS gesture takeover or window deactivation
does not guarantee a later pointerup. The ref remains true, later selection changes are ignored, and
later pointerdowns cannot install a fresh listener.

**Recommended correction.** Use the same cleanup for `pointerup`, `pointercancel`, and window blur.
Remove every terminal listener when any one runs and on component unmount.

**Regression tests.** Dispatch pointerdown/cancel, change selection kind, and begin another gesture;
repeat with window blur.

### F-12 — Worktree bundles retain the production Sparkle feed

**Priority:** P2  
**Location:** `run-app:551`

The launcher correctly gives each worktree a separate identity, for example:

```text
org.chemdraft.desktop.dev.chemdraw-toolbar-bug-fixes
```

The generated dev bundle nevertheless retained:

```text
SUFeedURL=https://raw.githubusercontent.com/jgassens/ChemDraft/main/appcast.xml
SUEnableAutomaticChecks=true
```

That feed distributes production builds using `org.chemdraft.desktop`. When it advances beyond the
branch version, the worktree app can offer an update with a different identity. Installation fails
validation or violates the branch-isolation invariant the new ID was meant to establish.

**Recommended correction.** For `org.chemdraft.desktop.dev.*`, disable scheduled checks and remove
the production feed or disable Sparkle/update-menu behavior. A dev feed is safe only if it publishes
the exact matching development bundle ID.

**Regression tests.** Inspect the staged Info.plist, verify Check for Updates is disabled or explains
the development build, and preserve the stable production configuration.

### F-13 — The production bundle contains a self-driving diagnostic

**Priority:** P2  
**Location:** `apps/desktop/src/main.tsx:12-14`

**Observed behavior.** `main.tsx` dynamically imports `ghostProbe` when `?ghostProbe=1` is present.
The built production assets contain a `ghostProbe-*.js` chunk despite the source calling it a
temporary, not-shipped diagnostic.

Activation pins and repeatedly focuses the window. With the agent bridge enabled, it enters an
unbounded loop that moves graphic objects, waits, and invokes global `edit.undo`. A user edit made
during that observation delay could be the action undone. The probe is dormant without the flag, but
dormant document-mutating diagnostics should not ship.

**Recommended correction.** Remove it before merge, or guard it behind a compile-time development
feature eliminated from production. Re-audit and remove native capabilities added solely for it.

**Regression tests.** Confirm production output contains no ghost-probe chunk or source reference;
confirm no probe-only permissions remain; if retained for development, prove release builds cannot
activate it.

### F-14 — Mixed stroke widths produce impossible head-size options

**Priority:** P3  
**Location:** `apps/desktop/src/toolbars/mainStyleWidget/ArrowVariant.tsx:49-54`

**Observed behavior.** The renderer floors an ordinary arrowhead to four times its stroke width. The
widget filters out smaller presets, but a mixed-width selection gives `strokeWidth.value = null`, so
the code assumes 2 px. If selection includes an 8 px-stroke arrow, the UI can offer an 8 px head even
though that arrow must render at least 32 px. The command stores 8 while the canvas displays 32.

**Recommended correction.** Expose the maximum selected stroke width, or an equivalent safe lower
bound, and calculate the shared preset floor from it. Do not derive mixed-selection constraints from
an arbitrary fallback.

**Regression tests.** Select 2 px and 8 px arrows together, verify every offered size is renderable
for every object, and verify narrowing selection recalculates the presets.

## Recommended remediation order

1. **Restore interchange correctness:** F-01, F-02, F-03.
2. **Preserve saved user intent:** F-04, F-08.
3. **Make arrow editing reversible and the inspector honest:** F-05, F-09, F-10, F-14.
4. **Close native-window and pointer lifecycle races:** F-06, F-07, F-11.
5. **Separate development and production behavior:** F-12, F-13.

## Verification performed

| Check | Result | Notes |
|---|---|---|
| Exact branch/base verification | Passed | Head and supplied merge base matched this report. |
| `git diff --check` | Passed | No whitespace errors. |
| `pnpm lint` | Passed | Exit code 0. |
| Focused art/CDXML/document/toolbar tests | Passed | Existing suites did not cover the reported edge paths. |
| Direct TypeScript reproductions | Failed as described | Confirmed F-01, F-02, F-03, F-04, F-05, F-08, and F-09. |
| Full `pnpm test` | Not green | 1,914 passed, 6 failed, 10 skipped. Four were timeouts; the two assertion failures passed in isolation. |
| Existing packaged artifact inspection | Found issues | Confirmed the ghostProbe chunk and dev-bundle/production-feed combination. |
| Installed-app interaction pass | Not performed | Native races require real macOS verification after fixes. |

The full-suite timeouts are not findings because this pass did not establish that the branch
introduced them. They should still be rerun after the fixes, without concurrent heavy producers.

## Required post-fix verification matrix

| Surface | Required proof |
|---|---|
| SVG/PDF | Export fishhook, no-reaction, dashed, colored, and resized arrows; compare with canvas. |
| CDXML outbound | Reopen externally without relying on embedded native payload; confirm appearance or warnings. |
| CDXML inbound | Import horizontal/vertical arrows of all four semantic kinds and inspect selection frames. |
| Persistence | Load a pre-change layout, migrate, save, restart, and confirm order/visibility. |
| Arrow geometry | Verify pointer distance equals marker size at several scales; unchanged handles are no-ops. |
| Inspector | Exercise asymmetric heads and mixed widths; controls must report mixed/valid values. |
| Native popover | Force cold first open and click-during-prewarm; verify final coordinates after resize. |
| Native tooltip | Delay position resolution, leave the button, and prove no stale tooltip appears. |
| Pointer lifecycle | Cancel and blur mid-gesture, then change selection and begin another gesture. |
| Worktree app | Build with `./run-app`, inspect identity/updater keys, launch that exact app, and leave stable app untouched. |
| Production assets | Confirm no ghost-probe chunk or probe-only permissions. |
| Repository checks | Run focused/full tests, lint, build, Rust tests, and diff check; bump the required build stamp. |

## Merge recommendation

Do not merge until F-01 and F-02 are fixed and verified. F-03 through F-13 should also be resolved
before treating the branch as ready for normal users because they affect silent interchange loss,
saved customization, core arrow editing, native palette behavior, or production/development
boundaries. F-14 should be handled in the same style-widget correction slice but is not independently
a release blocker.

The decisive post-fix proof should be on the real surfaces: external file round trips, persisted
layout restart, and the packaged macOS worktree app—not only unit tests or source inspection.
