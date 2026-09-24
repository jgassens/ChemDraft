# MolScribe OCSR Plugin

This optional ChemDraft plugin recognizes a chemical structure from a user-chosen image with a
ChemDraft-managed local MolScribe engine.

The engine is installed only after explicit user action. ChemDraft’s host-owned installer explains
that it installs a private Python, PyTorch, and a 1.1 GB model, reports required/free disk space, and
shows download progress. Recognition runs entirely on this computer; images are not sent to a remote
service. The plugin has no `network.fetch` or `model.download` permission.

## Recognition and review flow

1. ChemDraft asks for an image file or a screen-region capture.
2. The plugin passes that same command-scoped image to `recognition.recognizeStructure`.
3. The host validates the returned molfile with an available chemistry adapter and builds editable
   document geometry through the same molfile import path used by paste.
4. The plugin submits a proposal. It never inserts directly and does not request `document.write`.
5. ChemDraft’s proposal review shows the source thumbnail, a host-drawn picture of the recognized
   structure, its SMILES, an honest confidence tier, and applicable chemistry warnings. The user
   accepts or rejects it.

### Confidence tiers

MolScribe’s confidence is the model’s own score, not a calibrated probability of being right, so it
is shown only as a tier (`RECOGNITION_CONFIDENCE_THRESHOLDS` in `src/index.ts`):

| Tier | Overall score | Meaning for the reviewer |
|---|---|---|
| high | ≥ 0.85 | usually right; still look at it |
| medium | ≥ 0.65 and < 0.85 | check every stereocentre, charge and label |
| low | < 0.65 | expect at least one wrong atom or bond |
| missing | no score | nothing is known about reliability |

### Warnings

Each applies only when the result gives a reason for it:

- **low confidence** — the overall tier is low, or any atom or bond scored below 0.65;
- **missing confidence data** — no overall score, no per-atom scores, or no per-bond scores for a
  structure with more than one atom;
- **stereochemistry uncertainty** — any stereo in the result (`@`, `/`, `\` in SMILES; wedge/hash,
  atom parity, or V3000 `CFG` in the molfile);
- **charge/radical uncertainty** — any charge or radical;
- **abbreviation/superatom uncertainty** — `*`, an R-group or abbreviation label, an alias, or a
  superatom group;
- **radicals or isotope labels not drawn** — ChemDraft keeps them in the structure data, but the
  drawing does not show them;
- **invalid or unsanitized SMILES/MOL** — reported in the plugin’s panel and never proposed.

If the engine is not installed and the user chooses **Not now** or cancels the install, the plugin’s
panel says recognition needs the engine and that it can be installed from Add or Remove Plugins,
where the MolScribe row also shows the installed size and a **Remove** action.

The source image is retained unchanged throughout this flow. Mock recognition output exists only in
tests.

MolScribe is an external image-to-graph molecular recognition project. Its commit and model SHA-256
are recorded with every result; its licenses and citation requirements apply to the installed engine
artifacts. ChemDraft remains the application name.
