# Codex Prompt 01: Repository Foundation

Use this as the first Codex task. Keep the task bounded. Do not ask Codex to implement chemistry drawing or image recognition yet.

```text
You are working in the ChemDraft repository.

First, read these files fully:

- PLAN.md
- AGENTS.md

Goal for this task:
Create the repository foundation only. Do not implement real chemistry drawing, Ketcher integration, RDKit integration, CDXML/CDX parsing, native clipboard integration, plugin sandboxing, MolScribe OCSR inference, Python sidecars, or model downloads yet. Establish a clean monorepo that future tasks can build on.

Required deliverables:

1. Create a pnpm workspace monorepo with this structure:

   apps/
     desktop/

   packages/
     chem-core/
     editor-shell/
     editor-adapter/
     ketcher-adapter/
     chemistry-adapter/
     rdkit-adapter/
     cdx-compat/
     clipboard-adapter/
     export-engine/
     layout-engine/
     shortcut-engine/
     mechanism-tools/
     template-library/
     plugin-api/
     plugin-host/
     ui-kit/
     fixtures/
     test-utils/

   examples/
     plugins/
       mass-fragment-demo/
       molscribe-ocsr/
       opsin-name-to-structure/
       advanced-style-pack/
       journal-style-pack/

   docs/
     architecture/
     plugin-development/
     file-formats/
     compatibility/
     migration/

   tools/
     codex-prompts/
     scripts/

2. Add root-level project files:

   - package.json
   - pnpm-workspace.yaml
   - tsconfig.base.json
   - README.md
   - LICENSE placeholder or license note if the final license is not decided
   - vitest config if appropriate
   - formatting/linting config if practical

3. Create minimal package skeletons for each package:

   - package.json
   - src/index.ts
   - README.md
   - a minimal test file where useful

4. Add minimal exports/types only. Keep them intentionally small.

   Required initial examples:

   - packages/chem-core: export a DocumentSchemaVersion constant and a createEmptyDocument() function with a minimal typed document object.
   - packages/plugin-api: export a minimal PluginManifest type or schema placeholder, a PermissionName union placeholder, and a RecognizedStructureResult type placeholder for future image-to-structure plugins.
   - packages/plugin-host: export a minimal command registry class or function stub.
   - packages/editor-adapter: export a minimal EditorAdapter interface placeholder.
   - packages/shortcut-engine: export a minimal command-bound shortcut type placeholder.

5. Add a simple desktop app shell placeholder in apps/desktop.

   Preferred: Vite + React + TypeScript shell that renders a basic layout with top menu placeholder, left toolbar placeholder, center canvas placeholder, right inspector placeholder, and bottom status bar placeholder.

   If Tauri setup is straightforward, add Tauri scaffolding. If Tauri setup is likely to consume too much time or create brittle setup work, create the Vite app shell first and leave a clear TODO for Tauri integration.

6. Add an example MolScribe OCSR plugin scaffold only:

   - examples/plugins/molscribe-ocsr/README.md explaining that this is an optional future integration with the external MIT-licensed MolScribe OCSR project.
   - examples/plugins/molscribe-ocsr/manifest.example.json with placeholder permissions such as image.read, document.proposePatch, analysis.write, ui.panel, chemistry.compute, and plugin.storage.
   - The README must state that real inference will require later dependency, license, checkpoint, native-service, and permission review.
   - Do not add Python code, PyTorch, OpenCV, transformers, Hugging Face tooling, model weights, model downloads, or runtime integration in this foundation task.

7. Add tests that prove the skeleton works:

   - createEmptyDocument() returns a valid minimal document object.
   - command registry can register and invoke a fake command.
   - plugin manifest placeholder validates or type-checks a minimal manifest if validation exists.
   - RecognizedStructureResult can represent a mocked SMILES/MOL/confidence/warnings result.

8. Add scripts to root package.json:

   - pnpm lint, or a placeholder script that is honest if linting is not configured yet
   - pnpm test
   - pnpm build

9. Preserve architecture boundaries from AGENTS.md.

Hard constraints:

- Do not add Ketcher yet.
- Do not add RDKit yet.
- Do not add OPSIN yet.
- Do not install or integrate the external MolScribe OCSR package yet.
- Do not add PyTorch, Torchvision, OpenCV, transformers, Hugging Face downloads, Python sidecars, model checkpoints, or ML runtime dependencies.
- Do not implement CDXML/CDX parsing yet.
- Do not implement native clipboard integration yet.
- Do not add proprietary assets, copied icons, copied templates, or ChemDraw-branded materials.
- Do not add GPL/AGPL dependencies.
- Do not create cross-package imports that violate package responsibilities.
- Do not use MolScribe as the app name; reserve MolScribe for the optional OCSR plugin integration.
- Do not overbuild. This task is foundation only.

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
