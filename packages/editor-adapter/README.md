# @chemdraft/editor-adapter

Defines the abstract drawing editor interface and capability reporting.

This package must not contain a concrete drawing-engine implementation or own native document state. Ketcher and other editors must report their capabilities through this boundary, while `chem-core` remains the page/document source of truth.

Concrete adapters must report unsupported ChemDraft page-level concepts through capability gaps rather than silently treating editor state as the whole document.
