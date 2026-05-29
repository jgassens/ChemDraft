# Codex Prompt 05: Chemistry Validation and Basic Properties

Use this only after Phase 4 first drawing workflow closeout criteria are satisfied. Keep the task narrow.

```text
You are working in the ChemDraft repository.

First, read:

- PLAN.md
- AGENTS.md
- README.md
- package.json
- pnpm-workspace.yaml
- packages/chemistry-adapter/README.md
- packages/rdkit-adapter/README.md
- packages/editor-adapter/README.md
- packages/chem-core/README.md

Goal for this task:
Implement Phase 5 narrowly: chemistry validation and basic properties for the selected structure path.

Required deliverables:

1. Update `packages/chemistry-adapter` with a focused contract for:

   - selected-structure validation
   - formula
   - average mass
   - exact mass where available
   - total charge
   - basic stereochemistry warnings where available
   - capability reporting

2. Update `packages/rdkit-adapter` with either:

   - an RDKit-backed implementation if the dependency, license, size, and runtime path have been reviewed and accepted, or
   - an honest placeholder adapter with explicit capability gaps and tests.

3. Wire only the minimal app/plugin surface needed to request validation for the selected structure.

   - Use command definitions where UI or plugin actions are visible.
   - Do not add a new toolbar concept.
   - Do not redesign the workspace.

4. Add fixture tests for supported validation and property behavior.

   Include fixtures for:

   - valid simple molecule
   - invalid or unsupported structure
   - charged molecule
   - isotope where supported
   - stereochemistry warning where supported

5. Keep adapter boundaries intact.

Hard constraints:

- Do not implement broad UI polish.
- Do not add CDXML/CDX compatibility.
- Do not add clipboard compatibility.
- Do not add NMR, MS, pKa, logP, logS, retrosynthesis, or image-to-structure recognition.
- Do not import RDKit directly into app UI packages.
- Do not import Ketcher directly into app UI packages.
- Do not mutate `chem-core` document state from chemistry adapters.
- Do not claim exact mass, stereochemistry, or validation support beyond what fixtures prove.
- Do not add dependencies without documenting package name, purpose, license, core/optional status, distribution impact, and why it is needed.

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
