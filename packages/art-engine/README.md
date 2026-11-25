# ChemDraft art engine

The art engine plans native shape, stroke, arrow, marker, and effect geometry for the canvas and
exporters. It also provides path editing and boolean operations.

## Convert SVG pictures to native shapes

`convertSvgToShapes(svgSource, { frame, idFactory, domParser })` takes an already sanitized SVG
picture payload, its page frame including rotation in degrees, a function that supplies unique
document object IDs, and a DOM parser. The converter returns ordinary ChemDraft graphics, text,
and groups. `objects` are in paint order with each group following its children. `selectionIds`
contains the top-level IDs in the same order. The caller owns document insertion and undo.

The picture's frame stretches the SVG's intrinsic viewport. The SVG's own `viewBox` and
`preserveAspectRatio` still determine layout inside that viewport. Transforms are baked into
shape geometry. Simple text keeps its SVG baseline and alignment anchor and uses an estimated
editable text box. SVG groups become native groups, whose schema has no display name field.

Check `report.exact` before replacing the picture. Report entries have a stable `code`, a
`detail` string, and the number of distinct source elements affected by that issue. Simple
closed fills can be intersected with simple clips. Curved clip intersections use sampled
polygons and are reported. When an exact translation exceeds the native model, entries describe
the unsupported feature or the approximation used. Examples include non-uniformly transformed
strokes, group opacity, complex text positioning, and gradients whose coordinates cannot fit
the native shape frame.

Limits on source size, nesting, expanded references, objects, and path data are exported as
`SVG_IMPORT_MAX_*` constants. Fatal validation and size refusals throw `SvgImportError` with a
machine-readable `code` and a message identifying the input or exceeded limit. The converter
uses the parser supplied by the caller and has no file or network access.
