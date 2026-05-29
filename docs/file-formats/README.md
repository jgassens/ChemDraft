# File Formats

ChemDraft will use a versioned native document format owned by `packages/chem-core`.

Compatibility formats such as CDXML, CDX, MOL, SDF, SMILES, and RXN should be implemented through dedicated adapters and exporters. CDXML/CDX must not become the internal source of truth.
