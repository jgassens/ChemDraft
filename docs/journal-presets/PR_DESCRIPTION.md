# Add sourced journal formatting presets to the Edit menu

ChemDraft users preparing publication figures currently translate journal instructions into drawing
settings by hand. Add Edit > Journal Presets with search by journal/publisher/ISSN, artwork category,
selection/document scope, an existing-renderer preview, proposed changes, official sources/check dates,
Apply/Cancel/Reset and user-defined Custom controls.

Apply reuses native styles, patches, geometry helpers and one history transaction. It preserves
chemical payloads and editable objects, keeps coordinates unless resizing is explicitly selected,
refuses stale originating drawings, and stores resolved styles/rule versions for offline reopening.
Export advisories use the saved rules and actual physical size, format, DPI and typography scale.

Include twenty partial profiles: five starter entries plus fifteen in an explicitly loaded local
journal-style data pack. Cell is enabled for final-production chemical figures; its graphical abstracts
and Leading Edge artwork are excluded. Journals whose rules could not be verified are omitted.
No proprietary style sheets, new database server, runtime dependency or public plugin API change.

Changed areas: shared command/menu registry, owner-bound native dialog host and restricted source-link
permission, browser fallback, chem-core validation, document-workflow-core style transactions, sourced
JSON catalogs, preview/export advisories, regression tests and contribution documentation. Newer
upstream engine/tool installation dialogs are retained. This branch excludes the earlier bug-fix PR.

Validation on the macOS host: root TypeScript check passed; focused dialog/journal checks passed
204 tests; full regression suite passed **8,318 tests with 38 skipped** (407 files passed, seven
skipped); production browser build passed. Rust 1.97.1 formatting passed. Browser Cell Apply, Cancel
and one-step Undo/Redo were exercised. Cargo is unavailable; native macOS/Windows build and hands-on
checks remain unverified. See
`docs/journal-presets/TEST_RESULTS.md` for exact commands, failed historical attempts and platform limits.

Limitations: molecule/plain-text styles only; explicit atom/bond/rich-text overrides, stereo-width
limitations, fonts/embedding, captions, page arrangement and editorial exceptions need manual review.
Every profile discloses partial coverage; no universal journal compliance or acceptance is certified.
Native macOS/Windows build and hands-on checks remain unverified here, so this PR is a draft.

Review aids: `docs/journal-presets/AUDIT.md`, `EXPANDED_CATALOG.md`, `MANUAL_TESTING.md` and
`PROFESSOR_NOTE.md`. The original project's required CI/platform checks must pass before merge.
