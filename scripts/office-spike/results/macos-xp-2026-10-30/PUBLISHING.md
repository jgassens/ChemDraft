# Publishing notes

This folder is the macOS half (Part M) of the cross-platform Office test, run on 2026-10-30. It was
copied here unchanged except for two privacy redactions made before publishing:

- In every `inspect-*.tsv`, the local folder prefix was removed from the Container column, so paths are
  relative to this folder. No other column changed.
- `dumps/MP-copyback/0-1-com.microsoft.Object-Descriptor` was left out. PowerPoint's object descriptor
  holds the local path of the source document. It plays no part in carrier recovery; `index.json`
  still lists it as captured.

The `.docx` and `.pptx` files carry "ChemDraft" as creator and the owner's name as last modifier,
as Office wrote them.
