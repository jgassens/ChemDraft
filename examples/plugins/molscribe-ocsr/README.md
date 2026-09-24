# MolScribe OCSR Plugin Scaffold

This folder contains the optional ChemDraft MolScribe OCSR plugin scaffold.

This is not real image recognition. It provides a manifest and command handler that exercise the
host-owned `images.requestImage` capability with a real file or screen-region image.

It does not install, vendor, download, or execute MolScribe, PyTorch, OpenCV, transformers, Hugging Face tooling, Python sidecars, model checkpoints, model downloads, native services, or network inference.

## Current scaffold behavior

- Input: the host asks the user to choose an image file or capture a screen region.
- Output: after a real image is received, a short report states its dimensions and source and explains
  that no recognition engine is installed.
- Mutation: none. The scaffold does not create, insert, or propose a structure.
- Cancellation: silent.
- Test fixtures: mocked recognition output exists only in tests; shipped runtime code has no fake
  benzene, confidence value, SMILES, molfile, or patch.

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
