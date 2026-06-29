# @chemdraft/engine3d-api

Pure protocol types and guards for ChemDraft's external interactive 3D engine sessions.

This package intentionally has no native dependencies. It defines the stable message
contract between ChemDraft and a future Avogadro-style sidecar, plus fake-engine helpers
used by tests before a native sidecar exists.
