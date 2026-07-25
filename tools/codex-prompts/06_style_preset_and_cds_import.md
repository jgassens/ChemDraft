# Codex Prompt 06: Style Presets and `.cds` Import

Use this only after the native document/style boundaries are ready. Keep the task bounded to style presets and style-sheet compatibility.

```text
You are working in the ChemDraft repository.

First, read:

- PLAN.md
- AGENTS.md
- README.md
- package.json
- pnpm-workspace.yaml
- packages/chem-core/README.md
- packages/template-library/README.md
- packages/cdx-compat/README.md
- packages/plugin-host/README.md

Goal for this task:
Implement native ChemDraft style presets and ChemDraw `.cds` style-sheet import as a compatibility input, without making `.cds` the native style model.

Required deliverables:

1. Add or update native style preset schema support.

   Native presets should cover the supported subset of:

   - bond length
   - line width
   - spacing
   - wedge/hash style
   - atom, text, caption, and reaction-condition fonts
   - page size and margins
   - grid/ruler preferences
   - color table
   - default object styles

2. Preserve selected style preset in native documents.

   - New documents use the selected default style.
   - Existing documents preserve their saved style unless explicitly changed.
   - Applying a style must be explicit and undoable where practical.
   - Style application must not change chemical identity.

3. Add `.cds` style-sheet import through `packages/style-compat` or a documented temporary style compatibility boundary.

   - Parse/import external style sheets such as `.cds`.
   - Convert supported settings into native ChemDraft style preset objects.
   - Preserve source metadata and unknown fields where practical.
   - Warn on unsupported or lossy settings.
   - Fail safely on malformed input.

4. Add command-backed style operations:

   - `style.applyPreset`
   - `style.setDefaultPreset`
   - `style.managePresets`

   Do **not** add `style.importStyleSheet`. That id was retired (see "Command retirements" in
   `PLANS.md`) because the Molecule Inspector already imports `.cds` through the style
   compatibility boundary, and `App.test.ts` asserts an exact command-id set that reintroducing it
   would fail. Route any new import entry point to the existing path instead.

5. Add compact UI entry points only where needed.

   - Style preset selector in the toolbar or menu surface.
   - Import Style Sheet from File or Format/Style menus.
   - Set As Default must be explicit.
   - Partial imports must show warnings.

6. Add tests.

   Cover:

   - native style preset schema validation
   - default style application
   - save/reopen preserves selected style preset
   - style application does not change chemical identity
   - synthetic/legal `.cds` fixture import smoke test
   - unsupported-field warnings
   - malformed `.cds` safe failure

Hard constraints:

- Do not treat `.cds` as molecule, reaction, page, or document import.
- Do not make `.cds` the native style model.
- Do not fake successful style import.
- Do not commit user-provided `.cds` files such as `Tot_Syn_Style.cds` unless redistribution rights are clear.
- Use synthetic or generated public fixtures when rights are uncertain.
- Do not copy proprietary templates, toolbar art, help text, menu text, sample files, or trade dress.
- Do not wire major style behavior only through button-local handlers.
- Do not import Ketcher or RDKit into app UI packages.

Expected final report format:

Summary:
- What changed

Files changed:
- path/to/file

Tests run:
- command

Results:
- pass/fail details

Known limitations:
- Specific limitations, if any

Recommended next task:
- One concrete next step
```
