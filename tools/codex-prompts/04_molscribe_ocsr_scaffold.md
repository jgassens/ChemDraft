# Codex Prompt 04: MolScribe OCSR Plugin Scaffold

Use this only after the monorepo foundation, plugin API, command registry, and proposed-patch result types exist. This is the first real plugin scaffold, not real ML inference.

```text
You are working in the ChemDraft repository.

First, read:

- PLAN.md
- AGENTS.md
- packages/plugin-api/README.md
- packages/plugin-host/README.md
- examples/plugins/molscribe-ocsr/README.md, if it exists

Goal for this task:
Create a scaffold for the optional MolScribe OCSR image-to-structure plugin. The scaffold should exercise the plugin API, recognition result shape, permissions, command registration, warning display, and proposed-patch flow using mocked fixture output only.

Required deliverables:

1. In examples/plugins/molscribe-ocsr, add or update:

   - README.md
   - manifest.example.json or manifest.json depending on the repository convention
   - src/index.ts
   - src/mockRecognition.ts
   - src/types.ts if useful
   - tests for the mocked recognizer and manifest permissions

2. The manifest should identify the plugin clearly:

   - id: org.chemdraft.ocsr.molscribe
   - name: MolScribe OCSR
   - category/menu: Tools or Analyze -> Recognize Structure from Image
   - permissions: image.read, document.proposePatch, analysis.write, ui.panel, chemistry.compute, plugin.storage

3. Implement only mocked recognition.

   The mocked result should include:

   - source image reference or placeholder
   - proposed SMILES
   - proposed molfile placeholder or minimal valid fixture if available
   - overall confidence
   - atom-level confidence placeholder
   - bond-level confidence placeholder
   - warnings array
   - proposed document patch or proposed molecule object

4. Add a command stub:

   - plugin.molscribeOcsr.recognizeImage

   It should return or display a mocked RecognizedStructureResult. It must not mutate the document directly.

5. Add a review-before-insert path if the plugin host has enough API surface.

   If the host does not yet support review UI, add a typed proposed patch and a clear TODO:

   TODO(plugin-host): route RecognizedStructureResult.proposedPatch through a user approval dialog before applying it.

6. Add tests:

   - Manifest includes only declared permissions.
   - Mock recognizer returns SMILES/MOL/confidence/warnings.
   - Mock recognizer does not directly mutate a document.
   - Proposed patch shape type-checks.

Hard constraints:

- Do not install or vendor the upstream thomas0809/MolScribe code.
- Do not add PyTorch, OpenCV, transformers, Hugging Face tooling, RDKit, Python sidecars, or model checkpoints.
- Do not download model weights.
- Do not call external services.
- Do not add network.fetch, native.execute, model.load, or model.download permissions in this scaffold unless the code only documents them as future permissions.
- Do not use MolScribe as the app name.
- Do not present mocked output as real recognition.

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
