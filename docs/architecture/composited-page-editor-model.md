# Composited Page Editor Model

Phase 4 keeps ChemDraft centered on one native composited page, not isolated molecule editor islands.

Decision:

- `chem-core` owns the document, page, object list, layout relationships, and compatibility warnings.
- `editor-adapter` owns only the active drawing-engine session contract for supported object editing.
- A concrete editor such as Ketcher may edit a molecule or reaction object, but it must report capability gaps and return changes as objects or patches.
- Reaction arrows, mechanism annotations, text, brackets, graphics, page layout, grouping, and export remain page-level ChemDraft concerns.

Why:

- Chemists compose figures, mechanisms, text, arrows, and reactions on a page.
- Compatibility formats must not become the app state.
- Plugins and recognition tools need reviewable proposed patches instead of live document mutation.
- Ketcher integration can remain replaceable and honest about unsupported ChemDraft objects.

Current Phase 4 shell state:

- The workspace shows a blank native page with rulers, grid, and margins.
- The editor area reports `EditorAdapter not connected`.
- No fake molecule, reaction, product, arrow, or mechanism placeholder objects are shown.
- Inspector and plugin panels are hidden by default.
