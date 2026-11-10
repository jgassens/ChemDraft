# @chemdraft/cdx-compat

Owns CDXML/CDX import, export, intermediate models, unknown-object preservation, and compatibility warnings.

This package must not become the native document model and must not depend on GPL or AGPL code without an explicit project decision.

Untilted, unrotated square and round brackets write real `graphic` bracket elements and
`bracketedgroup`/`bracketattachment` pair membership. Synthetic fixtures cover those paths.
Repeat pairs write `BracketUsage="SRU"` and visible label text. Repeat-label association and polymer
crossing-bond connectivity remain preserve-and-warn cases; exact native labels survive the document
envelope. External SRU text stays independent, without inventing a label association. Unknown
bracket usage, atom membership and crossing attachments retain their original compatibility data.
Foreign groups with unsupported usage, membership, crossing attachments or extra group data remain
unknown compatibility objects, with specific warnings; they never create native pairs. Re-export
retains the original group in the embedded payload, without emitting a simplified visible group.

Bracket orientation is **UNVERIFIED against an independent reader**. Closing glyphs currently use
reversed `BoundingBox` x coordinates. No repo schema or specification was found documenting that
rule or an alternative orientation attribute. The fixtures are synthetic and confirm internal
consistency only.
See [the bracket handoff](../../docs/architecture/brackets-repeat-units.md) for the remaining work.
