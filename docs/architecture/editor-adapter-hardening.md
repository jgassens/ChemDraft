# Editor Adapter Hardening

Phase 6 keeps the drawing engine replaceable and subordinate to the native document model.

Current decision:

- `chem-core` remains the source of truth for documents, pages, object IDs, layout, selection, save/open, and compatibility warnings.
- `editor-adapter` defines the active editor session contract and required capability-gap reporting.
- `ketcher-adapter` wraps an injected Ketcher-like engine host and exposes a narrow wrapper for the real Ketcher runtime API. It does not expose Ketcher internals as app API.
- `apps/desktop/src/KetcherEditorHost.tsx` is the only intended direct Ketcher React host. It lazy-loads `ketcher-react` and `ketcher-standalone` for active selected-molecule editing.
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
- Do not import Ketcher directly into random app UI packages. Keep direct imports in the narrow desktop Ketcher host, or move them into a named successor host boundary.
- Keep Ketcher lazy-loaded and subordinate to `editor-adapter`; it must not become the saved ChemDraft document model.
