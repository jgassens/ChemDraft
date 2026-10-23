# Audit of the journal feature contribution

Audited 2026-10-22 against upstream `b1325d561ff273ca1e4c1a6ad6fa19b5665739e6`.
This branch is separate from the earlier export/session bug-fix PR #151. The changes below are
present in the working files and patch. They are not a reconstruction of unavailable earlier bug reports.
No unsupported journal is described as lacking author instructions: the narrower claim is that its
rules were not verified in this work.

| Change actually implemented | Files/functions | Reason and behavior |
|---|---|---|
| Shared Edit command | `commands.ts`, `appMenu.ts`, native `lib.rs`, `MainWindow.openJournalPresets` | The original base lacked this journal picker. Both menu paths use `edit.journalPresets`. |
| Native and browser forms | `JournalPresetForm.tsx`, `JournalPresetsBrowser.tsx`, `DialogWindow.tsx` | Shared local draft, search, artwork choice, scope, preview, source/date/status and four controls. Apply requires the current preview. |
| Authenticated native transport | `DialogCoordinator.ts`, `dialogProtocol.ts`, `dialog_windows.rs`, permission/capability files | Reuse owner-bound modeless windows, validated actions, private preview transport and close cleanup. Source opening accepts only retained official URLs. |
| Strict contracts | `chem-core/src/journalStyles.ts`, `parseJournalCatalog`, `JournalProfileSchema`, `JournalRequestSchema` | Validate metadata separately from versioned numerical profiles; reject duplicates, bad units, missing provenance and malformed drafts. |
| Pure style operation | `document-workflow-core/src/journalStyles.ts`: `applyJournalStyle`, `journalTargetIds`, `journalRulePixels` | Reuse patches and existing target-bond-length operation, convert physical units once, include selected group children and retain chemical payloads. |
| Single history transaction | `MainWindow.tsx`: journal owner callbacks and `journalSource` | Commit once to the originating tab. Reject stale drawing/selection snapshots and unfinished label/text edits. Cancel mutates no document. |
| Existing renderer preview | `owner.ts`: `journalStylePreview` | Use the export engine; crop only the displayed preview. No second bond-rendering implementation was added. |
| Offline save behavior | `applyJournalStyle`, existing serializer/save pipeline | Attach profile/version/rules/figure/resolved-style snapshots to affected objects. No file-format migration. Later catalog loads do not restyle documents. |
| Export advisories | `preflight.ts`; `MainWindow.createDialogExportResult` | Check saved constraints, actual size, format, DPI and scaled font/line values; retain ordinary exporter output and warnings. |
| Sourced catalog | starter JSON and `examples/plugins/journal-style-pack/data/` | Five starter plus fifteen explicitly loaded profiles. Cell is enabled for chemical figures. Unknown or unsupported categories remain outside each profile. |
| Compatibility with newer upstream | shared dialog files, capability test, workflow barrel | Retain upstream engine/tool installation dialogs and document-style export while adding journal support. |

## Feature-development defects corrected

These were found while developing this feature, rather than asserted to be original project bugs:

- Ordinary exports initially gained an unnecessary asynchronous preflight import. The wrapper now
  returns immediately when the exported page has no journal metadata; existing export tests cover it.
- Reapplying a preset could nest an older `journalPreset` inside its resolved-style snapshot. The
  operation removes that old metadata before making the new snapshot; repeated-application tests cover it.
- Applying while an atom label/text draft was active could absorb that edit into the style transaction.
  Open/Apply guards require finishing it first; the originating-tab regression cases cover the guard.
- A source-wiring assertion was updated for the added commit normalization path. Direct unsupported
  dependency imports and test fixture typings were corrected during development; they are not reported
  as original user-visible defects.

## Verified, partial and uncertain

- Code presence and patch differences are verified. Actual test outcomes are only those in TEST_RESULTS.md.
- Sources were checked per rule, generally 2026-10-21; check dates are stored in each profile. These
  are AI-assisted transcriptions, not publisher endorsements or an independent human certification.
- Every included profile is partial. Molecules covers export guidance only; Nature Materials/Energy
  cover explicitly applicable shared chemical-structure preferences, not unavailable journal-specific
  final-size rules. Angewandte's conflicting wide TOC option is withheld.
- Native macOS/Windows runtime behavior, font embedding, full-page visual acceptance and a publisher's
  acceptance decision remain unverified. Save/reopen unit tests use the real native file envelope,
  but do not establish that both operating-system file dialogs work.
- Full database coverage, executable style-pack plugin installation, graphical-abstract formatting for
  Cell, proprietary style sheets and full journal-compliance certification were not implemented.
- Older runnable bug-fix demo folders and prior bug-fix history are outside this contribution.

## Files to include and exclude

Include only the journal feature paths listed in the submission package's FILES_TO_INCLUDE.txt,
plus these contribution documents. Review `git diff --cached` before publishing.
Exclude `node_modules`, generated `dist`, logs, screenshots, local launcher, downloaded formatter,
review ZIP, backup/stash, private files and changes from the earlier bug-fix PR. Native platform
checks remain required before merge; a draft PR is appropriate for sharing the work meanwhile.
