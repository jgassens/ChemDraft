# Save, Open, and File Format

For native payload version fields, feature introduction rules, and tolerant reading, see
[Native document versions and forward reading](native-document-compatibility.md).

Status: Implemented CDXML-compatible ChemDraft envelope, progressive visible CDXML subset, and native desktop save/open bridge.

ChemDraft keeps `ChemDraftDocument` as the in-memory source of truth. Save/open compatibility belongs at the boundary:

```text
ChemDraftDocument -> @chemdraft/cdx-compat -> CDXML envelope
CDXML envelope or external CDXML -> @chemdraft/cdx-compat -> ChemDraftDocument
```

CDXML and CDX must not become the native document model.

## 1. Native Save Format

New `.chemdraft` saves are XML CDXML envelopes with a ChemDraft-owned native payload:

- XML declaration and CDXML doctype.
- `<CDXML CreationProgram="ChemDraft">`.
- one `<page>` per native page.
- visible CDXML children for the subset ChemDraft can currently represent.
- ChemDraft-owned `objecttag` metadata on the first page.

Required `objecttag` names:

- `org.chemdraft/codec-version`
- `org.chemdraft/schema-version`
- `org.chemdraft/native-payload-hash`
- `org.chemdraft/visible-cdxml-hash`
- `org.chemdraft/native-document`

The native document tag stores base64url-encoded UTF-8 JSON: a compact `JSON.stringify` of the validated document (not `serializeDocument`'s indented form, which grew a large drawing's file about 1.8x). The native payload hash is SHA-256 over the exact UTF-8 bytes of that JSON. Files written with the older indented payload still open, since the reader hashes and parses whatever JSON bytes the envelope carries.

## 2. Hashing and Canonicalization

The writer never hashes hand-built XML directly. Both export and open use the same visible hash pipeline:

```text
parse CDXML
strip org.chemdraft/* objecttags
remove comments and processing instructions
preserve non-whitespace text
collapse whitespace-only inter-element text
sort attributes alphabetically
serialize empty elements consistently
hash canonical UTF-8 bytes
```

`fast-xml-parser` is configured in ordered mode with attribute and text coercion disabled. CDXML is validated before parsing so malformed XML returns a warning result instead of a raw exception or a partially trusted parse.

New envelopes use visible hash-semantics version `"2"`, stored as root attribute
`attrib4345="|x|32"` (the opaque encoding of binary property `0x4345`). That selector is included
in the visible XML hash. CDX Save As also stores `visibleHashVersion: "2"` in its native envelope
JSON; the two version copies must agree. The raw binary hash covers property `0x4345` and every
other byte except the native envelope property itself. Both the stored XML hash and the binary
hash must match, even if an external editor recomputes the binary hash.

Version `"2"` uses only current canonicalization, which decodes numeric character references once
and preserves text and attribute control characters with appropriate escaping. An absent version
uses only the frozen released canonicalization, which leaves numeric references literal and uses
the released whitespace escaping. Unknown versions require the existing conflict review; readers
never try both semantics. Removing or changing the hashed selector cannot authorize an edit.

Known, accepted legacy limitation: a line break encoded as `&#10;` and the literal text `&#10;`
encoded as `&amp;#10;` have the same legacy hash (similarly for other numeric references). This is
a cosmetic substitution that never changes chemistry. Unversioned files open silently whenever
the legacy checks match, including unchanged files with line breaks, without any new prompt or
conflict. CDX still requires its binary hash to match. Saving a legacy document again upgrades it
to version `"2"`; cross-semantics substitutions in v2 files require the existing conflict review.

## 3. Open Behavior

`openChemDraftPayload` first strips a leading byte-order mark and leading whitespace, then sniffs:

- JSON: legacy ChemDraft JSON open path.
- XML with ChemDraft objecttags: envelope open path.
- XML without ChemDraft objecttags: external CDXML visible-subset import.
- empty or unrecognized content: warning result with no document.

Envelope open validates codec version, schema version, native payload hash, and visible hash. Future codec/schema versions return friendly compatibility warnings.

If the visible CDXML hash does not match the saved hash, ChemDraft returns a conflict result. The desktop UI asks whether to import the edited visible subset or restore the embedded ChemDraft document. This is intentional: the hidden payload guarantees ChemDraft-to-ChemDraft lossless round-trip, not ChemDraw-proof losslessness after external visible edits.

## 4. Desktop File IO

The desktop app supports:

- `document.open`
- `document.save`
- `document.saveAs`

In Tauri, file IO uses `@tauri-apps/plugin-dialog` and `@tauri-apps/plugin-fs`. Browser/web fallback still uses the hidden file input and download path.

File UI state is kept outside the native document:

- current file path
- dirty flag

Dirty state is driven by document history commits. Viewport, palette, ruler, and other UI-only changes must not dirty the document.

Session restore renews per-run fs/asset access from the coordinator's startup read of the app's own
`document-session.json` (see [the session coordinator](document-session.md)). Only readable tab envelopes' saved paths are considered (including
legacy single-document sessions and readable kept tabs retried on launch). The outer active-tab
mirror and arbitrary objects in document contents never authorize paths. Each grant uses
`allow_file` for one absolute, existing, regular `.chemdraft`, `.cdxml` or `.cdx` file; directories,
symlink components, Windows reparse points, and read-only files are refused. Both session IPC
commands accept only registered document windows, and no frontend path-grant command is exposed.

A refused or failed grant adds a transient `restoreSavePathError` to the returned tab. Restore
keeps its contents, dirty state, and original file association; Save (including a close prompt's
Save) explains the failure and opens Save As. Cancel preserves the drawing and successful Save As
replaces its association. Autosave does not persist this transient result: access is checked
again on each launch. The filesystem checks are a restore-time safeguard, not a defense against
another local process replacing a path after it was checked.

## Binary CDX desktop boundary

File > Open, shell-open requests, and dropped files detect the eight-byte `VjCD0100` header,
regardless of extension. CDX reaches `importCdx` as a `Uint8Array`; shell requests carry a JSON
byte array through the existing event/pending-open transport without UTF-8 decoding. Text
documents retain the UTF-8/UTF-16 byte-order-mark decoder and existing CDXML/native JSON opener.
Malformed CDX reports `cdx.invalid_binary` with the codec's reason; import warnings use the
same status line and warning report as CDXML.

Save As offers CDX alongside ChemDraft and CDXML. Saving to `.cdx` (including later Save and
session-restored paths) calls `exportDocumentToCdx` with `embedNativePayload: true`. Its
ChemDraft-specific property contains the exact native document; unchanged visible objects restore
that payload, and external visible edits trigger the existing conflict choice. File > Export CDX
uses `embedNativePayload: false`, for visible interchange only. Both use the existing scoped native
file dialogs and byte writer; save and export warnings remain visible after writing.

The binary codec feeds the shared CDXML conversion: supported fixtures cover atoms, bonds,
coordinates, charge, isotopes, representable radicals and stereo, text, and supported drawing
objects. It accepts both byte orders and legacy/UTF-8 text. Unsupported attributes, elements,
values and malformed properties warn; unknown binary properties retain raw bytes where possible.
Complex graphics, unusual fonts, proprietary style state and unrepresented chemistry are not
promised a lossless visible conversion. Native metadata does not expand another reader's supported
visible subset. Compatibility is claimed only to fixture coverage, never for arbitrary CDX files.
Limits are 64 MB, 64 nested child-object levels and one million objects.

macOS registers `.cdx` as an Alternate editor with the established CDX UTI and `public.data`.
Windows registers `.chemdraft` only; neither `.cdx` nor `.cdxml` is associated by its installer.

## 5. Visible CDXML Subset

The current visible subset is progressive and warning-backed.

Exported:

- `MoleculeObject` as `<fragment>`
- atoms as `<n>`
- bonds as `<b>`
- text as `<t>`
- plus signs as `<t>+</t>`
- simple reaction arrows and graphics as `<graphic>`
- brackets as graphics

Imported:

- pages
- fragments
- atoms
- bonds
- text
- simple graphics and reaction-arrow line graphics
- unsupported objects as `unknown-compatibility-object` where feasible

Imported molecule graphs set `structureFormat: "unknown"` and `structure: ""`; ChemDraft does not derive a canonical SMILES/molfile string during CDXML import yet.

Coordinate conversion uses:

```text
cdxmlPoint = cssPx * 72 / 96
cssPx = cdxmlPoint * 96 / 72
```

CDXML `p` pairs are written and read as `horizontal vertical`; `BoundingBox` is `left top right bottom`. This was corrected against real ChemDraw 26 CDXML where a vertical object stack otherwise imported as a horizontal row. Y-axis orientation must still be verified against more real ChemDraw reference files before claiming full geometry fidelity.

## 6. Warning Rules

ChemDraft must warn rather than silently change chemical identity. Current warning-backed paths include:

- aromatic bond approximation
- unknown bond order
- unsupported visible bond display metadata
- unsupported element mapping
- unsupported molecule metadata such as isotope/radical/stereo aggregates
- unsupported or unpreserved over/under crossing metadata
- partial reaction scheme export
- mechanism annotations that remain payload-only
- unknown CDXML object import
- missing derived structure string on visible CDXML molecule import

## 7. Synthetic Fixtures

Synthetic CDXML fixtures live in `packages/fixtures/cdxml`. Do not commit proprietary ChemDraw sample files or derived fixtures unless redistribution rights are explicit.

The current fixture set covers:

- empty page
- single bond
- heteroatom double bond
- triple bond
- aromatic warning
- wedge/hash/dash/bold display warning
- crossing-bond over/under metadata
- BactVue-style integrated visible subset: text, reaction arrow, wedge/dash/bold
  bond display, and crossing metadata in one file
- text plus molecule
- reaction arrow
- unsupported step preservation

## 8. Over/Under CDXML Interop

External ChemDraw CDXML can encode over/under crossing intent separately from
chemical connectivity. The BactVue reference file also shows why integration
fixtures matter: one real scheme can combine wedges, dashed bonds, bold bonds,
text, reaction arrows, and crossing/occlusion marks.

- `CrossingBonds` on `<b>` records lists bond ids that visually cross the bond.
- `Z` and display attributes such as `Display="Bold"` help infer which side is
  visually in front.
- round bracket `<graphic>` elements can be attached through `bracketedgroup` ->
  `bracketattachment` -> `crossingbond BondID="..." InnerAtomID="..."`.

The native target is the page-level pairwise crossing override model described in
`over-under-crossing-model.md`. `cdx-compat` resolves CDXML bond ids to
object-qualified native bond refs during import and exports native crossing overrides back
to reciprocal `CrossingBonds` plus coherent `Z` values. Richer crossing attachment
metadata, including bracket/crossingbond records, stays in compatibility/unknown data or
generates warnings until editable native support exists. If ChemDraft cannot preserve a
crossing or attached mark, it must warn rather than silently flattening the weave.

## 9. Manual Validation Checklist

Before making stronger compatibility claims, manually test the built desktop app and at least one external CDXML reader:

1. Save a blank ChemDraft document as `.chemdraft`.
2. Confirm the saved file opens back into ChemDraft losslessly.
3. Confirm the saved file opens in ChemDraw or another CDXML reader without rejecting the document.
4. Save a simple molecule and confirm ChemDraft reopens it losslessly.
5. Open that molecule file in ChemDraw and visually inspect whether the visible layer renders as expected.
6. Save an over/under fixture with alternating crossings and confirm the visible CDXML
   contains reciprocal `CrossingBonds`, coherent `Z`, and no app-only SVG hit targets.
7. Open a synthetic ChemDraw-style crossing fixture and confirm native `page.crossings`
   is populated where refs resolve.
8. Edit the visible layer externally, reopen in ChemDraft, and confirm the conflict prompt appears.
9. Exercise native `Save`, `Save As`, and `Open` through macOS dialogs, including save-with-existing-path after Save As.

Until those checks are complete, user-facing claims should stay limited to the tested behavior: ChemDraft-to-ChemDraft lossless envelope round-trip plus a progressive, warning-backed visible CDXML subset.
