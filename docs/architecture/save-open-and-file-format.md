# Save, Open, and File Format

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

The native document tag stores base64url-encoded UTF-8 JSON from `serializeDocument`. The native payload hash is SHA-256 over the exact UTF-8 bytes of that serialized JSON.

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
- last saved payload hash for verification/reference

Dirty state is driven by document history commits. Viewport, palette, ruler, and other UI-only changes must not dirty the document.

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
