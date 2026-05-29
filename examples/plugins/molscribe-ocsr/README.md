# MolScribe OCSR Plugin Scaffold

This folder contains the optional ChemDraft MolScribe OCSR plugin scaffold.

This is not real image recognition. It provides a manifest, command handler, review-panel state helper, fixture-backed recognition result, source-image reference preservation, and proposed-patch flow tests.

It does not install, vendor, download, or execute MolScribe, PyTorch, OpenCV, transformers, Hugging Face tooling, Python sidecars, model checkpoints, model downloads, native services, or network inference.

## Current mock behavior

- Input: selected image reference, represented as `sourceImageRef`.
- Output: a mocked benzene recognition result with confidence, atom/bond confidence, warnings, SMILES, and a mock molfile payload.
- Mutation: no direct mutation. The command queues a proposed `chem-core` document patch through `plugin-host`.
- Review: `createMolScribeOcsrPanelState()` exposes the data a later UI can render for user approval.
- Source preservation: the result keeps `sourceImageRef`, and the command stores the last source reference in plugin-scoped storage when available.

## Legal and dependency boundary

The app name is ChemDraft. Use "MolScribe OCSR" only for this optional plugin or integration.

Real integration requires later review of:

- Dependency licenses and transitive licenses.
- Model checkpoint source, size, and distribution rules.
- Citation and attribution requirements for the upstream MolScribe project.
- Native-service or local-service execution boundaries.
- Explicit permissions for image input, proposed document patches, model loading, network use, and native execution.
- Review-before-insert UI so recognized chemistry is proposed to the user before it changes a document.

Do not add real inference dependencies in this scaffold phase.
