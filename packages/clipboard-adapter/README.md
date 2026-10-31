# @chemdraft/clipboard-adapter

Owns native clipboard formats and Office-friendly copy/paste behavior.

Native clipboard integration is not implemented in the foundation milestone.

`inspectClipboardPayload` accepts optional `imageItems` and `skippedImageItems` alongside existing
text flavors. Chemistry retains priority; pictures precede prose, with PNG preferred over SVG.
SVG source in a text flavor becomes a UTF-8 SVG image, never a text box. Plain-text SMILES candidates
accompanying a picture still reach the host chemistry parser; detection does not assert validity.
If only refused image candidates remain, `image-refused` carries the native refusal reason.
