# Source audit and accuracy limits

Rules checked on 2026-10-21. This is an AI-assisted transcription and implementation review,
not publisher endorsement or independent human certification. Every starter profile remains
**partial coverage**. The source's recommendation is not a guarantee of acceptance or a claim
that every submission stage requires the journal's final production style.

| Journal | Sections checked | Implemented factual settings | Not inferred |
|---|---|---|---|
| JACS | Official author instructions, Appendix 2: Resolution and Size | Lettering minimum 4.5 pt; lines minimum 0.5 pt; suggested Arial/Helvetica; single/double-column size limits and artwork-category DPI | No exact bond length or font size; Arial/Helvetica are suggestions, not an exclusive-font mandate |
| Organic Letters | Same named sections on its own official page; TOC/Abstract Graphic | Its stated minimum lettering/line sizes, suggested fonts, column constraints, DPI and TOC size limit | No inheritance from JACS; no exact bond length inferred |
| Analytical Methods | Its own Chemical structures and Table of contents specifications | Published pt drawing settings; TOC dimensions, TIFF and resolution | No universal requirements asserted for other RSC journals; general scheme dimensions remain unknown |
| RSC Advances | Its own Chemical structures and Table of contents specifications | Independently checked pt drawing settings; TOC dimensions, TIFF and resolution | Same values do not justify applying this profile to all RSC journals |
| Nature Chemistry | Its journal-specific Figures instructions plus page 4 of the shared Nature Portfolio chemical-structures guide | The explicitly applicable structure settings, atom-label font, width and raster resolution | No general claim covering every Nature Portfolio journal, figure category or submission stage |

Official links are in README.md and every implemented rule/figure record. Journal identities use
Crossref metadata only; that service is not used as a source of drawing requirements.

## How to review additions strictly

1. Identify the exact journal and ISSN, article type, submission stage and artwork category.
2. Use its official instructions, following shared guides only where applicability is explicit.
3. Record the source section, check date, units, minimum versus exact target, recommendation versus
   mandatory wording, exceptions and unknowns. Never insert a familiar publisher default as a fact.
4. Resolve conflicting official values before enabling a numerical rule. Otherwise leave the value
   unknown and document the conflict. Do not mark an unverified profile as verified.
5. Translate only representable settings into native styles. Preview and compare at final physical
   size. Keep unresolved fonts, unsupported output, explicit overrides, rich text and geometry limits
   visible. A source check is separate from verifying that a particular drawing meets those rules.
6. Review the source and exported result independently before changing a profile to full verified
   coverage. New profile data need regression tests, supported-format checks and both native-platform
   checks. Saved documents retain their embedded rule/style snapshot after later catalog changes.

The existing implementation offers advisory export checks; it does not certify a drawing's complete
compliance or block every noncompliant export. Treat additional journals as pending until their own
instructions can be checked. Unknown or unrepresentable requirements must remain visible limitations.

The fifteen additional approved journals and omitted candidates are audited in
[EXPANDED_CATALOG.md](EXPANDED_CATALOG.md). Five unverified candidates were omitted from the selectable data before publication.
