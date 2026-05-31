# Editor Adapter Hardening

Phase 6 keeps the drawing engine replaceable and subordinate to the native document model.

Current decision:

- `chem-core` remains the source of truth for documents, pages, object IDs, layout, selection, save/open, and compatibility warnings.
- `editor-adapter` defines the active editor session contract and required capability-gap reporting.
- `ketcher-adapter` now wraps an injected Ketcher-like engine host. It does not import Ketcher directly, add a runtime dependency, or expose Ketcher internals as app API.
- The current Ketcher boundary supports basic molecule object load/save only.
- Editor save results must be applied back to a ChemDraft document through patches.

Capability gaps that must remain explicit:

- Mechanism annotations such as curved arrows, electron marks, lone pairs, and radical dots are page-level ChemDraft objects.
- Page layout objects such as text, brackets, plus signs, graphics, groups, reaction arrows, and annotations are not owned by the structure editor.
- Superatom, R-group, S-group, and generic-atom metadata may be preserved by `chem-core`, but they are not yet editable through the Ketcher adapter.
- Reaction object editing is not enabled until an adapter proves a real reaction load/save path without replacing the composited page model.

Rules:

- Do not let an editor adapter save a whole ChemDraft document.
- Do not silently convert page objects into editor-only state.
- Do not silently drop ChemDraft metadata that the editor cannot represent.
- Do not import Ketcher directly into app UI packages.
- Add a real Ketcher dependency only in `packages/ketcher-adapter` after license, size, build behavior, and lazy-loading have been reviewed.
