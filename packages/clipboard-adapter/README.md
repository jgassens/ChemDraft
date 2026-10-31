# @chemdraft/clipboard-adapter

Owns native clipboard formats and Office-friendly copy/paste behavior.

Native clipboard integration is not implemented in the foundation milestone.

`inspectClipboardPayload` accepts optional `imageItems` and `skippedImageItems` alongside existing
text flavors. Chemistry retains priority; pictures precede prose, with PNG preferred over SVG.
SVG source in a text flavor becomes a UTF-8 SVG image, never a text box. Plain-text SMILES and supported
SMILES-list candidates accompanying a picture still reach the host chemistry parser; detection does
not assert validity. These heuristic `kind: "smiles"` results carry an optional `fallbackImage`
(a `ClipboardImageItem`, like an image result's `image`). If chemistry parsing fails, the host can
paste that picture through its normal image validation path. Explicit chemistry flavors do not carry
this fallback. An advertised but unreadable chemistry flavor blocks pictures (including SVG-source
text and `fallbackImage`), while readable chemistry and prose retain their usual behavior.
If only refused image candidates remain, `image-refused` carries the native refusal reason.
