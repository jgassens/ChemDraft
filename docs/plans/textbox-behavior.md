# Text box behavior (1.2.3)

This spec covers the canvas text box while it is open for editing. Each line has a test ID. The tests
are in `apps/desktop/src/textbox123*.dom.test.tsx`, and the model tests are in
`packages/layout-engine/src/textEditorLayout.test.ts`. Every DOM test drives the editor with real
events (pointer events at client coordinates over the rendered text, plus keydown, beforeinput,
input, composition and paste events as the browser sends them), on macOS and on Windows.

## One model

The text, the selection, the wrapped lines, the box height, the caret, the selection highlight and
the committed object all come from one model:

- **Text:** `TextObject.text` (plus `spans`). The editor's textarea `value` always equals it. Text
  box text holds LF line breaks only (N1), because a textarea reports CRLF and a lone CR as LF.
- **Selection:** the textarea's `selectionStart`, `selectionEnd` and `selectionDirection`. The
  editor also keeps a caret affinity, which says which line the caret is on at a soft wrap.
- **Wrapped lines:** `planNativeTextEditorLayout(object)` in `packages/layout-engine`. It uses the
  same line breaking, baselines and alignment anchor that the page SVG draws.
- **Box height:** `nativeTextObjectBoxHeight(object)` in `packages/layout-engine`. It is computed
  from those same lines.

The textarea is only an input sink, for keys, IME, paste, native undo and accessibility. Its own
browser layout is never shown: its glyphs, caret and selection highlight are transparent, and pointer
hit-testing never goes through it.

## Lines

| ID | Behavior |
|---|---|
| H1 | The stored height changes only when the number of wrapped lines changes. Typing that keeps the line count never changes the height, in either wrap mode. |
| H2 | The height never shrinks below its content, in either wrap mode: it is at least the height of the rendered lines, and at least the bottom of the lowest drawn line (a small line height, a large run or a subscript can reach below the nominal line height). This holds at the page edges too: the page never caps the height, and the box is neither moved nor given a smaller font. Near the bottom, the box reaches past the bottom of the page. |
| H3 | Auto width never wraps: its lines are only the typed paragraphs, even when the width is capped at the page edge. Its height counts only those lines and never claims a wrap that the SVG does not draw. |
| C1 | The drawn caret is where the next character will go: on the rendered line that will receive it, at the boundary between the rendered glyphs. This holds at the end of wrapped text, mid-line, and after a soft wrap. |
| C2 | Clicking over a rendered glyph puts the caret at the nearest glyph boundary on that rendered line. This holds for right-to-left runs, whose glyph boundaries run from right to left. |
| S1 | A drag over the rendered text selects exactly the text that is highlighted, which is the model range between the press and the release. Typing then replaces only that range. Every selected range on a line is highlighted with a nonzero width, in either direction. |
| S2 | Double-click selects a word, in whole graphemes: an emoji is selected on its own and never split, and a letter written as a surrogate pair stays inside its word. Triple-click selects the paragraph. Shift-click extends the selection, even right after a click at the same place (it is never counted as a double-click). |
| K1 | Backspace and Delete remove one character across soft wraps and hard line breaks. With a selection, including a selection over several lines and a hard break, they remove exactly the selection. |
| K2 | Enter and Shift+Enter both insert a hard line break at the caret, replacing any selection. The caret is drawn at the start of the new line. The box stays open. |
| K3 | ArrowUp and ArrowDown move to the line above or below on the rendered lines, keeping the column. Home/End (Windows) and Cmd+Left/Right (macOS) go to the start or end of the rendered line. Shift extends the selection. |
| R1 | Resizing the box narrower or wider rewraps the text and keeps the caret and selection offsets. The caret is redrawn on the new lines. |
| U1 | One finished edit gesture is one undo entry ("Edit Text"). Undo restores the text, and Redo reapplies it. Inside an open edit, Cmd/Ctrl+Z stays the platform's native text undo, and the drawn caret and selection follow the textarea's restored selection. |
| I1 | IME composition: while composing, the caret is drawn at the composition, and the box height changes only if the line count does. Composing over a selection replaces exactly the selection. |
| P1 | Pasting plain text or rich text (HTML plus plain) replaces only the selection, and the caret ends after the pasted text. |
| N1 | Line breaks are stored as LF. CRLF and a lone CR become LF wherever text enters a box: a paste into the editor (a Windows clipboard sends CRLF), a new box from any path (canvas paste, CLI, MCP, assistant), every edit commit, range formatting, and formatting the whole box (style and script). A box from an older file that still stores CR is shown with LF breaks, so its offsets match the textarea's; its first edit stores LF. |
| W1 | Fixed-width boxes wrap at the box width, and auto-width boxes grow along their single lines. Both modes follow every line above. |

## Kept on purpose

- Auto width does not wrap at the page edge. The line runs on past the edge, as in 1.2.2. Only the
  height bug (H1, H3) is fixed.
- Inside an open edit, undo is the platform's native textarea undo. The document gets one "Edit Text"
  entry when the edit finishes (`textEditUndo.dom.test.ts`).
- A newly placed box still selects its "Text" placeholder, so the first key replaces it.
- Within a rendered line, the caret x comes from the rendered SVG glyphs
  (`SVGTextContentElement.getStartPositionOfChar`) when the browser provides them. Otherwise it falls
  back to the layout engine's character advances. The line a character is on, the baselines and the
  height always come from the model.
- Double- and triple-click are counted by the editor with fixed thresholds (500 ms, 5 px), because
  a prevented pointerdown suppresses the browser's counted mousedown. They do not follow the
  system's double-click speed setting.

## Known limitations

- The IME candidate window is placed by the platform at the textarea's own caret, not at the drawn
  caret. The hidden textarea wraps with its own browser layout, so after a soft wrap the candidate
  window can sit at another x, or on another line, than the drawn caret and composition. Deferred.
- In an auto-width box, the first baseline is at the font size, as the page SVG draws it. A run
  much larger than the box's font (a large superscript, say) draws above the box top. The height
  rule (H2) covers only the bottom. Fixed-width boxes move the first baseline down instead.
- A text box near the page bottom keeps its full height (H2), so lines typed into it, or a larger
  format, can take it past the bottom of the page, as an auto-width line already runs past the right
  edge. The page-size question that insertions ask (`commitInsertionHistoryWithPageFit`,
  `commitDocumentChangeWithPageFit`) does not apply to text edits: they are committed through
  `replacePresentDocument` and `commitDocumentHistoryFrom`, so the box is left extending past the
  bottom. A rotated auto-width box stops widening at a side edge with its full height, but its width
  is not capped by its full height at the bottom. Text past the page bottom is cut off in the view
  and in exports: the canvas, SVG and PDF clip at the page edge. CDXML framed captions use their own
  fit path.

## Root cause in 1.2.3 RC4 (line numbers at d872d570d)

| What | Where it was computed or stored |
|---|---|
| Text | `TextObject.text`, written by `updateTextObjectContent` (`MainWindow.tsx:8784`) through `updateNativeTextObjectText` (`documentWorkflow.ts:5375`). The textarea shows it as `value={object.text}` (`MainWindow.tsx:31807`). Single source, so this was not the bug. |
| Selection | The textarea's native `selectionStart`/`selectionEnd`. Browser hit-testing set it through the textarea's own CSS layout. It was copied into `activeTextSelection` (`MainWindow.tsx:2848`, `recordTextSelection` at `:7940`) on select, keyup and pointerup. |
| Visible wrapped lines | `nativeTextSpanLayout` (`layout-engine/src/textLayout.ts:18`), through `textObjectSpanLayout` (`index.ts:4346`), at `width - 6` (`index.ts:4348`), using the layout engine's conservative character advances. `planTextObjectSvg` (`index.ts:4235`) draws them. |
| Hidden wrapped lines | The textarea's CSS `white-space: pre-wrap; overflow-wrap: break-word` (`App.css:5921`), at the full `object.width x scale` (`textPlacement.ts:45`), using the real font. |
| Caret | The textarea's native caret (`caretColor`, `MainWindow.tsx:31724`), placed by the hidden lines. |
| Box height | `nativeTextObjectSizeForText` (`document-workflow-core/src/textObjects.ts:32`). Fixed width counted the SVG's own lines, so it agreed with the SVG. Auto width used `sum(ceil(lineWidth / (width - 6)))` (`textObjects.ts:59-60`). |

Where they disagreed:

1. **The hidden lines against the visible lines (bugs 1 and 2).** The browser fits more on each line
   than the layout engine does: it has 6 more units of width and narrower real advances. So once text
   wraps, its hidden lines break at different words. The caret, the native selection highlight and
   every click or drag all used the hidden lines. That put the caret mid-word ("ag|ain") or past the
   last word, and it let a drag that looked like lines 1-2 select up to the end of the text. Typing
   then replaced the whole text.
2. **The auto-width height against the SVG (bug 3).** `width = natural + 6`, then
   `ceil(natural / (width - 6))`. Floating point made `(natural + 6) - 6` slightly smaller than
   `natural` on some keystrokes, so the count came out as 2, and the height jumped between one and two
   lines on alternate keystrokes. Once the width is capped at the page edge, the same formula claims 2
   or 3 lines that the SVG, which never wraps auto width, does not draw.

The fix: the editor reads `planNativeTextEditorLayout` for the caret, the highlight, hit-testing,
vertical moves and line start and end (`apps/desktop/src/textBoxEditor.ts`). Auto-width height reads
`nativeTextObjectBoxHeight`. Both come from the lines the SVG draws.

The first draft of that fix had one more disagreement of its own: **pointer to page point.** It drew
the caret through the page SVG's measured screen matrix (`measureTextEditorViewport`), but it inverted
presses through the page box and the nominal zoom (`pagePointFromRenderedPageRect`). The page's border
and the SVG's letterboxing sit between the two, so a press missed by that offset (one character in the
test). Presses now invert the same matrix (`textEditorPointFromClient` in `MainWindow.tsx`, 295efcbba).

In 1.2.2 the editor worked the same way (a transparent textarea with its native caret over the SVG
glyphs), and the SVG did not wrap at all, so wrapped text disagreed even more. The auto-width height
formula was the same.

## Verification

jsdom has no textarea hit-testing and no native caret. On d872d570d and in 1.2.2, the browser placed
the caret and selection through the textarea's own layout. So in jsdom, a pointer test fails there
because nothing places the selection, and a drawn-caret test fails because no caret is drawn from the
model. To tell the text logic apart from the hit-testing, a scratch-only variant (not committed) placed
the selection the way the browser reports it (`setSelectionRange` plus `select`), then sent the same
key, paste and IME events.

| Line | Test (`textbox123*`, both platforms) | d872d570d (RC4) | 1.2.2 | Now |
|---|---|---|---|---|
| H1, H3 | `H1/H3` (auto width) | Fails: two lines' height after "it shou" (bug 3) | Same | Passes |
| H1, H2 | `H1/H2` (fixed width) | Passes | Differs: height from a width estimate, below the drawn lines; the SVG did not wrap | Passes |
| C1 | `C1` (both modes) | Fails: no caret drawn from the model (bug 2) | Same | Passes |
| C2 | `C2` (both modes), `C2 … measured page viewport` | Fails: no hit-testing of the rendered lines | Same | Passes; the viewport test fails at 31a98c10a, one character off |
| S1 | `S1` (both modes) | Fails: a press does not place the selection. The variant passes, so typing replaced the selection correctly; bug 1 came only from hit-testing the hidden lines | Same | Passes |
| S2 | `S2` (both modes) | Fails: same reason | Same | Passes |
| K1 | `K1`, `K1 Cmd+Backspace/Delete` (macOS) | Fails: a press does not place the caret; the variant passes. The native line delete used the textarea's own line | Same | Passes |
| K2 | `K2` (Enter, Shift+Enter) | Fails: a press does not place the caret; the variant passes | Same | Passes |
| K3 | `K3` | Fails: arrows and line keys were left to the textarea's own lines | Same | Passes |
| R1 | `R1` | Fails: a drag does not place the selection; the variant (selection kept) passes | Same | Passes |
| U1 | `U1` | Fails: no drawn caret; the variant (one undo entry, restored selection) passes | Same | Passes |
| I1 | `I1` | Fails: no drawn caret; the variant (height kept) passes | Same | Passes |
| P1 | `P1` (plain, rich) | Fails. Variant: the text is right, but the caret was moved a frame later (`requestAnimationFrame`), so it showed at the end for one frame, and a key typed in that frame landed there | Same | Passes; the caret is placed in the same commit |
| W1 | every line above in both wrap modes | | | Passes |

## Round 4 (at 14240b2cc)

The review of 14240b2cc found the items below. Each test named here fails at 14240b2cc and passes
now. The LF cases of the multi-line selection tests (K1, I1) already passed and are kept as coverage.

| Finding | Test |
|---|---|
| CRLF text: the model counted CRLF as two offsets, and the textarea counts it as one, so a press, a drag, the opened caret and typing landed one character per break too far (bugs 1 and 2 again) | `CRLF: …` in `textbox123.dom.test.tsx` (both modes); `over a partial multi-line selection (CRLF)` in `textbox123.keys.dom.test.tsx`; the CRLF model tests; `documentWorkflow.textLineBreaks.test.ts` |
| A paste of CRLF text stored CR in the model | `P1: a plain/rich Windows paste (CRLF)` (LF and CRLF boxes) |
| Double-click split a surrogate pair | `selects whole graphemes` (model) |
| Right-to-left glyph stops: hit-testing chose the line start, and highlights had negative width | `hit-tests and highlights a right-to-left run` (model) |
| Shift-click within 500 ms and 5 px of a click selected a word | `S2` (both modes), with no wait before the Shift-click |
| Auto-width height below the lowest drawn line | `never gives an auto-width box less height than its lowest drawn line` (model); `is never below the lowest drawn line` (`textBoxHeight.test.ts`) |

## Round 5 (at ae2a57a27)

Each test named here fails at ae2a57a27 and passes now.

| Finding | Test |
|---|---|
| Near the page bottom the stored height was clamped to the room left on the page, below the lowest drawn line, in both wrap modes ("a\nb" at 20 px and line height 0.5, 24 above the bottom: line bottom 34, height 24). The clamp is gone: the content height is never capped (`nativeTextObjectSizeForText` caps only a fixed-size box's chosen height), and the box reaches past the bottom | `H2: lines typed into a box on the page bottom …` (both modes) in `textbox123.dom.test.tsx`; `text box height at the page bottom` (both modes, typing, whole-box format, fixed-width resize) and `… 1° … growing at the left page edge` in `documentWorkflow.textLineBreaks.test.ts`; `never caps the content height at maxHeight` in `textBoxHeight.test.ts` |
| Formatting a whole older CRLF box (style or script) kept its CR text and runs | `stores LF when an older CRLF box is formatted as a whole …` in `documentWorkflow.textLineBreaks.test.ts` |
