# Journal formatting presets

Use **Edit > Journal Presets…**, choose a journal and figure type, review the preview,
then Apply. Save or export normally afterwards. Apply is one **Apply Journal Preset**
undo entry. Cancel, Reset and changes to the form do not modify the drawing. Reset resets
only the form, not a previously applied style; use Undo to revert an applied style.

## Five starter journals

All five starter profiles are **partial coverage**, version 1.0.0; official source rules checked
2026-10-21. These are journal-specific entries, not universal publisher compliance presets.
Journal identity metadata was checked against Crossref's `/journals/{issn}` endpoint on
2026-10-21. Nothing contacts Crossref or a publisher when ChemDraft starts or opens a file.

| Publisher/portfolio | Journal | Official instructions |
|---|---|---|
| ACS | Journal of the American Chemical Society (JACS) | https://researcher-resources.acs.org/publish/author_guidelines?coden=jacsat |
| ACS | Organic Letters | https://researcher-resources.acs.org/publish/author_guidelines?coden=orlef7 |
| RSC | Analytical Methods | https://www.rsc.org/publishing/publish-with-us/publish-a-journal-article/analytical-methods |
| RSC | RSC Advances | https://www.rsc.org/publishing/publish-with-us/publish-a-journal-article/rsc-advances |
| Nature Portfolio | Nature Chemistry | https://www.nature.com/nchem/submission-guidelines/aip-and-formatting |

Nature Chemistry additionally uses the explicitly applicable shared chemical-structure guide:
https://www.nature.com/documents/nr-chemical-structures-guide.pdf (page 4).

The current ACS journal instructions give minimum lettering and line sizes; they do not specify
an exact bond length in the checked sections. Those profiles preserve existing bond lengths and
larger fonts/lines. They do not import numerical settings from other ACS journals. RSC entries
independently cite each journal's drawing settings. Published pt values are used where the source
also supplies rounded cm equivalents. Nature cm settings are converted as physical lengths.
Every implemented rule has its own source URL and section; each figure's limits also have provenance.
Unknown limits are JSON `null`, and absent drawing rules retain existing values.

## What Apply changes

- Native molecule label and bond appearance, plus plain-text font settings, in the selected scope.
- A target bond length for later operations on those molecules, where a source specifies it.
- **Only when checked:** molecule coordinates scale uniformly around each molecule's centre using
  the existing target-bond-length operation. This can affect relative spacing; inspect the preview.
- Per-object `journalPreset` metadata: profile ID/version, checked date, source rules, selected
  figure requirements, and a resolved native style snapshot. Whole-document scope also records
  document-level metadata. The object styles themselves render offline without a catalog lookup.

Chemical graphs, atom identities, charges, radical/isotope/stereo metadata, bond payloads, reaction
roles and object editability are retained. Selection includes children of selected groups on the
selected page. Whole-document scope covers every page; the preview shows the selected/first page.
New drawings and objects created later keep the app's ordinary defaults until explicitly styled.
Catalog updates never restyle a saved document. Reapplying a preset replaces its old snapshot.

Native windows are modeless and use the authenticated shared dialog host, retained placement,
owned-window construction, close cleanup and private chunked preview transport. They never receive
the document itself. An originating-tab edit or selection change invalidates the frozen preview:
close and reopen the dialog. Finish text and atom-label edits before opening the dialog, so an
unfinished chemical-label draft cannot be folded into the style Undo entry. Applying into an
inactive tab changes that tab's history only.
Browser builds use the same form through an in-page fallback. Desktop creation failures do not.

## Export and limitations

Existing geometry stays unchanged unless resizing is selected. Page size is never changed by this
feature; the preview is cropped for display only. Use Export's sizing/content-crop controls where
available. Output checks use saved rules, actual requested physical dimensions, supported format
status, DPI requirements and scaled font/line sizes. Their warnings appear in export previews and
export results; they are advisory and do not certify submission compliance. Existing export warnings
and bytes are preserved. DPI requirements are artwork-category-specific; the automated warning
uses the most conservative applicable category. Unspecified raster DPI is reported as unchecked.

- Arrows, brackets, images, rich-text runs and explicit per-atom/per-bond overrides retain their
  appearance. Font availability checks use the host's font API and cannot certify embedded fonts.
- Bond angles, typography conventions, caption content, colour usage, final editorial judgement,
  manuscript length and article-specific exceptions are not automated.
- RSC TOC profiles list TIFF and 600 dpi; ordinary schemes list TIFF/EPS/PDF. Current desktop TIFF
  is implemented; EPS is deferred and PS is not an available export format. Wiley vector profiles
  therefore use PDF within ChemDraft; listing a publisher format does not add an exporter. Raster export requires the desktop app, not the browser preview.
- A visual style cannot satisfy proprietary native-source-file requirements. Confirm accepted
  source formats with the journal. This feature does not introduce a new format writer.
- Five starter entries are lazy-loaded with the form. Click **Load additional journal pack (15 journals)**
  for the optional broader catalog: 20 total, all with partial coverage. See
  [EXPANDED_CATALOG.md](EXPANDED_CATALOG.md) for every approved journal, limitation and omitted candidate.
  A full journal directory and executable installable plugin remain outside this slice.

## Data and boundaries

`apps/desktop/src/journal-presets/journals.json` stores identities; `profiles.json` stores versioned
rules and figure constraints. The strict contracts live in chem-core; pure patch-based styling is
in document-workflow-core; the desktop owns UI, preview and export advisories. Existing document
metadata stores the snapshots, with no schema migration, new dependency or public plugin API change.

The catalog is an original selection and transcription of factual numerical requirements and
minimal bibliographic facts, with source links. No publisher style-sheet files, artwork, templates,
logos or full guideline text are redistributed. Publisher sites retain their own rights; this does
not grant a licence to copy those assets. Crossref metadata is used for identity, never as evidence
of formatting rules. Custom preset settings are labelled user-defined and have no publisher source.

The expanded identity/profile files live under `examples/plugins/journal-style-pack/data/`.
They are validated atomically before loading, with no startup network dependency.

Cell now has a sourced chemical-figure profile (1.0.1), enabled after direct browser verification
of its current linked instructions. Graphical abstracts and Leading Edge artwork are excluded.
