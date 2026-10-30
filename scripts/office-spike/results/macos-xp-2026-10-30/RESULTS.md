# Office cross-platform, Part M (macOS): 2026-10-30 09:08–09:09

- Windows-made files from `c2083844`: `XW-win.docx` (W-S1) and `XP-win.pptx` (P-S1).
- office-spike HEAD: 91261035.
- Word and PowerPoint for Mac, keys only, except one click on an empty slide area in PowerPoint (the runbook's step).

| Step | App | Result | Detail |
|---|---|---|---|
| M0 inspect-before | — | PASS | exit 0; `word/media/image1.png` and `ppt/media/image1.png`: `png zTXt: valid; expect=true` |
| MW1 open | Word | PASS | The caffeine structure and the ethanol → acetaldehyde "oxidation" scheme show as one picture, about two-thirds of the page width, sharp. Status bar: "1 characters". |
| MW2–3 copy back | Word | **PASS** | ⌘Home, ⇧→, ⌘C (no click in the page). Pasteboard types include com.microsoft.Art--GVML-ClipFormat (23510 bytes), public.png (63448), com.adobe.pdf (18940), public.tiff, public.jpeg, Object-Descriptor and others. Inspect exit 0. **GVML `clipboard/media/image1.png`: `png zTXt: valid; expect=true`.** The top-level public.png, PDF and TIFF carry no carrier. |
| MW4–5 edit, save | Word | **PASS** | ⌘End, Return, `x`, ⌘S (no sheet), ⌘W. `inspect-MW-saved.tsv`: `word/media/image1.png` (19783 bytes, the same size as before) `png zTXt: valid; expect=true`. |
| MP1 open | PowerPoint | PASS | Both drawings show on the slide, the same as in Word. |
| MP2–3 copy back | PowerPoint | **PASS** | Click an empty slide area, ⌘A, ⌘C. Types: PowerPoint Internal-Shapes/Theme/Color-Scheme, a GVML-style zip, public.png, PDF, TIFF and others. Inspect exit 0. **`clipboard/media/image1.png`: `png zTXt: valid; expect=true`.** |
| MP4–5 edit, save | PowerPoint | **PASS** | ⇧⌘N (new slide), ⌘S (no sheet), ⌘W. The file now has 2 slides. `inspect-MP-saved.tsv`: `ppt/media/image1.png` (19783) `png zTXt: valid; expect=true`. |

**Summary:** the ChemDraft PNG carrier made on Windows survives opening in Mac Office, copying back to the clipboard (inside the Office GVML zip), and saving after an edit, in both Word and PowerPoint. The plain public.png Office puts on the clipboard has no carrier, so a paste back into ChemDraft has to read the GVML/Art format. That wasn't tested here.

**Prompts:** none. No save sheets.

Screenshots are in the session's tool-results: Word open, PowerPoint open.
