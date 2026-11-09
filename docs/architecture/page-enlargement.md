# Page enlargement before inserts and automatic re-layouts

Owner decision 2 resolves left/top overflow by translating affected-page content. This does not
close the unrelated assistant slice in `docs/plans/PLANS.md`.

## Shared implementation and scope

`apps/desktop/src/pageEnlargement.ts` owns `PageEnlargementConsent`, `planDocumentPageFit`,
`applyPageFitDecision` and `commitWithPageFit`. It reuses `nativePrompt`, including document-window
ownership and native utility suspension. Text: “This doesn't fit on the page. Enlarge the page to
fit? Content on the page may shift to make room.” Buttons: Enlarge / Keep Page Size. Tests pass macOS and Windows explicitly.

**Owner decision (2026-11-08): only inserts and automatic re-layouts ask.** MainWindow's ordinary
`commitDocumentChange`, `commitDocumentHistoryFrom`, preview settlement and live-input commits
retain main's synchronous behavior. Approved callers explicitly use
`commitDocumentChangeWithPageFit`, `commitInsertionHistoryWithPageFit` (insert previews only), or
`commitInsertionToTabWithPageFit` (templates and Insert Table). Plugin/proposal and assistant writes
use the shared helper directly. Never put the question back in a general history boundary.

Fitting actions stay synchronous. Non-fitting actions hold their prepared content until the answer,
then recheck their captured document/tab. Whole batches and all affected pages are checked together.
The helper creates no history entry: the existing insert/re-layout entry owns page growth, and
undo/redo restore recorded states without another question. Keep Page Size preserves the builder's
proposal and original page layout. Enlarge preserves chemical graphs, styles and relative geometry;
the host may translate all content on affected pages as described below. Selection remains the
inserted/edited content, excluding unrelated objects moved only to make room.

Writes in one ordinary plugin command share consent keyed by the host-only invocation signal.
Ending/unregistering the command cancels pending writes; receipts wait for the actual commit.
`AssistantTransactions.pageEnlargementConsent(requestId)` shares one answer across assistant tool
calls and direct plugin patches in the same request. Scope, chemistry verification, Stop and the
bounded human-decision deadline remain. Explicit Keep Page Size retains every proposed insertion;
an unanswered assistant question still omits pending non-fitting cells.

`textVisualBoundsForPageFit` in layout-engine measures explicit SVG lines and the stored text frame,
using existing font/script metrics, alignment and the original rotation pivot. It is retained for
pasted/plugin/assistant text and captions, which can overflow a constrained frame. It does not
introduce a question while typing or styling text.

## Asked paths

Paths are relative to the repo. Function names are stable entry-point anchors rather than stale line
numbers. Existing builders' clamping/refusal behavior remains; a question appears only if a surviving
proposal exceeds the page or proposes page growth.

| Path / entry point | Question boundary |
| --- | --- |
| `documentWorkflow.ts: applyClipboardPastePayload` — MOL V2000/V3000, multi-molecule RXN, plain text/InChI fallback, PNG/SVG/native-converted pictures | `MainWindow.tsx: applySyncClipboardPayload`; one check for the complete result. |
| `MainWindow.tsx: renderPastedSmiles` — single SMILES including template substitution | One guarded insertion. The old second imported-page preset prompt stays removed. |
| `documentWorkflow.ts: insertSmilesMoleculeGrid` — SMILES-list grid | `MainWindow.tsx: renderPastedSmilesList`; holds proposed growth for consent; Keep preserves grid positions. |
| `documentWorkflow.ts: pasteSelectionClipboardPayload` — private selections, mixed objects and molecule fragments | `MainWindow.tsx: applySelectionClipboardPayload`; one check for the whole paste. |
| `MainWindow.tsx: applyTableClipboardResult` — HTML/TSV/Office table paste | One check including caption, footnotes and text overflow. |
| `documentWorkflow.ts: insertTableIntoDocument` — Insert Table | `commitInsertionToTabWithPageFit` handles active/inactive histories. |
| `structureTemplateInsertion.ts: insertStructureTemplate` — picker/value-encoded template commands | `MainWindow.tsx: insertTemplateToTab` uses the guarded tab insertion. |
| `MainWindow.tsx: applyNativeTemplateDocumentAtPoint`, `commitNativePlacementDrag` — rings/chairs | Guarded template builder commit, including the pre-placement history snapshot for a new ring preview. |
| `MainWindow.tsx: applyBracketAtPoint`, `applySymbolGlyphAtPoint`, `applyNativeArtDocumentAtPoint` — bracket/symbol/art stamps | Guarded insertion; orbital previews use the insertion-history helper. Default arrow/line click stamps also ask; hand-drawn arrow/line drags do not. |
| `MainWindow.tsx: applyDocumentPatch` — Name to Structure, name text, plugin inserts | Awaits the consent and actual commit before returning a receipt. |
| `plugins/applyPluginDocumentPatch.ts: applyPluginDocumentPatch` — add/update/move/addAnnotation/mixed batches, any page | One shared question at the host write boundary; oversized proposals retain geometry. |
| `plugins/applyPluginDocumentPatch.ts: applyAcceptedPluginProposal` — recognition/proposals | Proposal remains pending until consent and a valid commit; recognition review remains mandatory. |
| `assistant/writeBuilder.ts` — assistant structures/reactions/text/tables | Request-owned consent shared across tools/direct writes; Keep retains all cells. |
| `assistant/writeBuilder.ts` — assistant replacement/style/movement | Generic assistant write preflight uses request consent, including changes an agent makes through a tool. |
| `MainWindow.tsx: cleanUpSelectedStructure` — native polygon/tree Clean Up 2D | One check before the existing cleanup entry. |
| `documentWorkflow.ts: prepareNativeMoleculeEngineRelayout` — engine/alternate Clean Up 2D | The combined prepared result uses the guarded cleanup commit; read-back guards stay. |
| `MainWindow.tsx: cleanUpSelectedStructure3d` — legacy 3D Cleanup | Guarded automatic re-layout commit. |
| `MainWindow.tsx: commitSpinFlatten` — Spin Flatten/Release | Validated reprojection uses the guarded commit; stereo/math unchanged. |
| `MainWindow.tsx: handleApplyKetcherEdit` — structure-editor Save | Reconciled editor result uses the guarded commit. |
| `documentWorkflow.ts: duplicateSelectedDocumentObjects` — Duplicate | `layout.duplicate` uses the guarded insertion commit. HEAD has no separate Alt-drag copy implementation; the former combined inventory label overstated coverage. A future copy gesture must use an insertion boundary. |

Except `MainWindow.tsx`, the desktop paths in this table are under `apps/desktop/src/`.

## Never asks (hand gestures)

These paths use main's original ordinary/history/live-input commits, including its existing
clamping, refusal, chemistry, selection, dirty-state and undo behavior:

- Drag/move whole objects, groups or molecular fragments; keyboard nudges; bond-side drags.
- Rotate objects/groups/fragments, typed rotation, projected tilt and typed X/Y/Z rotations.
  Spin Flatten/Release is the explicit automatic re-layout exception above.
- Resize objects, groups, fragments, text frames, tables and art.
- Draw bonds/chains, freehand, Bezier and polylines; drag-draw arrows/lines; edit path nodes,
  control points, markers, corner radii, gradients and mechanism controls.
- Place text, first typing, edit existing text, font/style changes and text-to-atom conversion.
- Atom labels, elements, charges and continued hotkey typing, including coalesced amendments.
- Table cell/caption/footnote edits, row/column edits, auto-fit, width and font changes.
  Insert Table and pasted tables are the insertion exceptions above.
- Arrange, align, distribute, rotate90, flip and Adjust arrangement spacing commands, including
  inactive-tab spacing commits.
- Molecule settings, bond-length changes, imported appearance/style templates, chooser/numeric
  previews and palette-preview settlement.
- Art markers/effects/strokes, boolean operations and full-appearance eyedropper.

No gesture-specific bug fix from the earlier worker is retained. Its synchronous dirty-ref change,
guarded text/atom-label amendments and replaced preview/history installers were restored to main.
The optional `textCheckpointed` argument on the ordinary commit is retained solely to avoid a
duplicate text checkpoint when a guarded insertion has already checkpointed; its default behavior
is main's. The text-visual-bounds helper remains necessary for pasted and programmatically inserted
text, as described above.

## Other unchanged paths

- CDXML/CDX clipboard kinds currently reach the unsupported return in `applyClipboardPastePayload`,
  leaving the document unchanged. This feature adds no format support.
- File Open/import replaces a document and page layouts. Its existing
  `recommendImportedPageFit` / imported-page preset question remains. Explicit Page Setup/custom
  size/orientation remain explicit layout operations.
- Fresh-document CLI/MCP grid/reaction builders size a new document, rather than enlarge an existing
  UI page. Temporary export/clipboard crops never replace the working document. No dialog is added
  to headless APIs or export.
- Undo/redo, restoration, selections, deletion, metadata and QA-only scene builders do not ask.

## Left/top overflow: owner decision 2 (2026-11-08)

Pages retain their fixed coordinate origin. Once an insertion or automatic re-layout triggers the
question, the helper measures all visible objects on each affected page, including existing content.
`planDocumentPageFit` records `shiftX = max(0, -left)` and `shiftY = max(0, -top)` (with the existing
1e-6 bounds tolerance). When translation is needed, width/height cover the old/proposed page and all visual bounds,
plus those shifts, rounded outward to physical points. Including all content prevents the shift
from stranding objects near the opposite edge. Unaffected pages do not move or resize.

`applyPageFitDecision` updates the layout and calls `documentWorkflow.ts: translateDocumentPage`.
That function reuses the existing per-object group translation patches, without clamping, anchor
cascades or a separate history entry. Every object frame moves once, including group/reaction
frames; molecule atoms, graphic endpoints/paths/freehand points, mechanism controls, point anchors,
and superatom/R-group attachment points move by the same delta. Atom/object references, chemical
graphs, dimensions, styles and selection stay intact. Anchored electron marks and arrows ride with
their targets; freehand caches are invalidated. Opaque compatibility payloads stay opaque while their
native frame translates, as with existing movement.

Right/bottom overflow alone retains the existing growth policy for changed content, without shifting
or fitting unrelated pre-existing right/bottom overflow. Keep Page Size changes neither layout
nor coordinates beyond the action's existing proposal. Undo restores the exact original positions
and page size; redo restores the saved enlarged/translated result without asking again.

Assistant tool writes verify their scoped patch and normalized chemistry before applying the
host-owned translation, so this behavior grants no additional write scope. Assistant history receives
the pre-translation document for touched-object tracking; unrelated translated objects are never added
to the request selection or editable scope. Direct assistant plugin patches use the same tracking and
request-owned consent. No insertion/re-layout path in the inventory needs a separate shift fallback.

The exact Keep Page Size title also means AppKit cannot automatically bind Escape (the existing
native backend recognizes literal Cancel). Click the button on macOS; Windows Escape/close maps to
Keep Page Size. No native backend/capability change was made.

## Validation and handoff

Setup used the requested dependency-relink script. No install, staging, commit, lint, whole-repo
TypeScript check, Cargo command, build or app launch was performed. Build stamp:
`11.08.21.40-codex`. Tests run in batches of at most three files; final handoff records commands
and counts. The native dialogs are mocked; macOS and Windows parameter values are exercised.

The prompt-only cases for rotation, resize, bond-length/style changes, text font changes and table
cell/row edits were removed. Mounted regressions check that overflowing manual rotation/flip,
font changes, table row/column edits and long first typing/text edits never ask or change page size.
Retained insertion/re-layout tests cover fitting, Enlarge, Keep, selection and one-step undo/redo.
The existing graphic-path gesture, drawing-tool and agent-bridge suites verify restored behavior;
assistant tests cover shared request consent.

Prior scope-only results: 765 distinct tests passed across nine files: page enlargement 161,
mounted page commits 62, text edit history 82, graphic-path interactions 71, assistant controller 72,
agent bridge 6, drawing tools 24, desktop shell 229, and plugin patches 58. Six restored shared
handlers were also compared byte-for-byte with origin/main. An initial Vitest config startup
could not write into the relinked node_modules; all successful runs used
`--configLoader runner --cache=false`. A source-count assertion was updated after restoring
inactive-tab spacing, then its complete suite passed. `git diff --check` passed.

The page-translation suite covers left-only, top-only, left+bottom, all four sides, both answers,
and first/second affected pages on explicit macOS/Windows parameter values. It compares canonical
isomeric SMILES from live molecule coordinates, native atom/bond metadata, relative geometry,
selection, and exact undo/redo snapshots. Mixed-object coverage includes every native object kind,
anchored marks/arrows, editable graphic geometry, tables and attachment metadata. Mounted tests cover
ordinary plugin patches, reviewed proposals and direct assistant patches; assistant controller tests
cover host translation after scoped verification, cumulative request selection and shared consent.

Decision-2 focused results: **756 distinct tests passed across 12 files**: page enlargement 161,
page translation 35, mounted page commits 74, assistant controller 74, assistant transaction 9,
assistant placement 10, plugin patches 58, mounted assistant transactions 5, graphic-path interactions
71, drawing tools 24, agent bridge 6, and desktop shell 229. `git diff --check` passed. Existing React
`act` warnings in the graphic-path suite and Node localStorage warnings did not fail the runs.

macOS and Windows native ownership/focus/stacking and hands-on behavior remain unverified. Builds
and native checks were expressly excluded. Recommended next integration task: run the standing
manual stress checklist on both hosts. The unrelated active plan stays
intact.
