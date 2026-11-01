# @chemdraft/clipboard-adapter

Owns native clipboard formats and Office-friendly copy/paste behavior.

Native clipboard integration is not implemented in the foundation milestone.

`inspectClipboardPayload` accepts optional `imageItems` and `skippedImageItems` alongside existing
text flavors. Chemistry retains priority; pictures precede prose, with PNG preferred over SVG.
SVG source in a text flavor becomes a UTF-8 SVG image, never a text box. Plain-text SMILES and supported
SMILES-list candidates accompanying a picture still reach the host chemistry parser; detection does
not assert validity. `chemistryCandidates` contains every heuristic candidate in clipboard text-flavor
order, with each flavor's strict single-token SMILES candidate before its SMILES-list candidate.
Entries carry `sourceType`, `text`, and `kind` (`"smiles"` or `"smiles-list"`). The result's usual
kind, text, and source type describe the first candidate; the host tries candidates in order and
commits only the first one that yields structures.
Single candidates use `kind: "smiles"`; lists use the app's `kind: "plain-text"` list-paste path,
including compact lists without spaces. Both heuristic results carry an optional `fallbackImage`
(a `ClipboardImageItem`, like an image result's `image`). If chemistry parsing fails, the host can
paste that picture through its normal image validation path after exhausting candidates. Explicit
chemistry flavors do not carry this fallback. An advertised but unreadable chemistry flavor blocks pictures (including SVG-source
text and `fallbackImage`), while readable chemistry and prose retain their usual behavior.
If only refused image candidates remain, `image-refused` carries the native refusal reason.

Clipboard reads admit at most 1 GiB per flavor and per paste, with the existing 25 MiB picture
limit retained. The native readers check allocation/data/string lengths before copying; the adapter
checks text and base64 sizes before normalization or decoding. Unused binary/container flavors are
never fetched. Admission follows chemistry, pictures, then prose; the returned text-flavor order still determines resolution. Only retained flavors consume the
shared total. A flavor exceeding the remaining total is skipped with a warning, allowing smaller
alternatives. A size-skipped chemistry flavor always refuses the paste, including private selections
and chemistry recognized in generic text; it cannot fall back to a picture or prose. Native
`skippedItems` metadata carries that flavor's own byte size and limit; `size-refused` names it with
the same message on native and DOM paste. Copy retains main's 64 MiB UTF-8/binary input cap. Its separate paste accounting charges retained
UTF-8 exactly once (including Windows CRLF); native allocation preflights and aliases add no retained
charge. Optional representations exceeding their own cap or copy total are dropped with named warnings.
Admitted text aliases are compared before decoding or charging, so duplicate chemistry cannot refuse paste. Hosts parsing
private text flavors before inspection must call `guardClipboardPayload` first.

Before validation, an unprefixed `<svg>` root without a default namespace declaration gets
`xmlns="http://www.w3.org/2000/svg"` added to its start tag. If an `xlink:` use has no declaration in its scope
and the root has no `xmlns:xlink` declaration, `xmlns:xlink="http://www.w3.org/1999/xlink"` is also
added there. The bounded XML scanner locates the root; only its start tag is edited. Declared
namespaces are never replaced. Prefixed roots bound to the SVG namespace are accepted without
rewriting; roots outside the SVG namespace are refused.
These declarations are included in the stored picture bytes so the SVG renders as a standalone file.
The same handling covers SVG text, SVG image flavors and chemistry fallback pictures.

SVG validation applies size limits to the namespaced text and refuses DOCTYPE/ENTITY declarations
and processing instructions before parsing with `globalThis.DOMParser` (`image/svg+xml`). Parser
errors anywhere in the document produce a specific SVG refusal, stripping browser boilerplate and
reporting positions in the original pasted text; the parsed root must be in the SVG namespace.
Headless validation checks namespace bindings, duplicate attributes, tag balance and comment syntax without
expanding entities. Tests can pass `{ svgParser }` as the second argument to `inspectClipboardPayload`,
or `{ svgParser: null }` to exercise the headless fallback. Apart from the missing root declarations,
accepted SVG bytes are preserved, and the existing sanitizer and size limits apply to SVG flavors,
SVG text and chemistry fallback pictures.
