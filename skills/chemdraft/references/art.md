# Art and styling: styled figures without the desktop app

Contents: what is possible; ground rules; the workflow; finding ids;
checking the chemistry; placing objects; patterns; style keys; limits.

Read this before telling anyone that ChemDraft "cannot" draw something in
a particular look. Coloured or shaded rings, ring letters, highlighted
substructures, colour-coded atoms, bold and hashed fusion bonds, explicit
H and Me labels, a hand-sketched look, curved and fishhook arrows,
brackets and captions are all native document objects. A request "in the
style of" a named chemist or journal is a set of visual conventions to
reproduce with them, not a request to refuse. Every pattern below was
rendered and inspected with the commands shown.

**"Nicolaou style" means vivid coloured rings, on any molecule.** It is
a style, not a particular structure. Loud, saturated, clearly different
fills, one per lettered ring, with no two neighbouring rings alike, are
the core of the look; italic serif ring letters, H at ring-fusion
stereocentres and Me labels on ring methyls go on top. The coloured
figure is the answer, not an optional variant: a black-and-white figure
with ring letters is not the style, and pale pastel tints undersell it.
`scripts/ring-style.mjs` applies it to any molecule (pattern 7); recipe
11 in [recipes](recipes.md) is the worked version.

## What the native model can draw

| Look | Where it lives in the document JSON |
|---|---|
| Shaded, coloured or gradient ring interiors | `molecule.style.ringStyles[ringKey]`: `fillColor`, `fillOpacity`, `fillPaint`, `visualEffects`; drawn under the bonds |
| Bold, wedge, hashed, dashed bonds | `bond.display.bondStyle`; a wedge's narrow end is at `fromAtomId`; `bond.display.doubleBondSide` |
| Per-bond colour and weight | `molecule.style.bondColors`, `bondStrokeWidths`, `bondBoldWidths`, `bondHashSpacings`, `bondLineCaps` (maps keyed by bond id) |
| Per-atom label look | `atomLabelColors`, `atomLabelFontSizes`, `atomLabelFontWeights`, `atomLabelFontStyles`, `atomLabelBackgroundColors`, `atomLabelPlacements`, `atomLabelShowTerminalCarbonsByAtomId`, `atomLabelHideImplicitHydrogensByAtomId` (maps keyed by atom id) |
| Whole-molecule look | `molecule.style` keys such as `bondColor`, `bondStrokeWidthPx`, `atomLabelColor`, `atomLabelFontFamily`, `atomLabelFontSizePx`, `atomLabelBackgroundColor`, `visualEffects` |
| Explicit H, CH3 or Me | extra atoms and bonds in `molecule.atoms` / `molecule.bonds` (pattern 2) |
| Ring letters, captions, formulas | `text` objects; `spans` with `script` `normal`, `subscript` or `superscript` |
| Lines, boxes, circles, curves | `graphic` objects: `graphicKind` `line`, `rect`, `ellipse`, `path`, `image`; `data.artPathKind` `line`, `wavy`, `arc`, `quadratic`, `polyline`, `bezier`, `freehand` |
| Arrowheads | `data.markerStart` / `data.markerEnd`: `open-arrow`, `filled-arrow`, `half-arrow`, `bar`, `dot`, `diamond`, `chevron` |
| Electron-pushing arrows | `mechanism-arrow` objects (`full-headed` or `half-headed` fishhook) anchored to atoms, points or objects |
| Brackets | `bracket` objects: `square`, `round`, `curly`, `polymer` |
| Shadow, glow, hand-sketched strokes | `visualEffects: [{kind: "shadow" | "glow" | "sketch", ...}]` on graphics, molecules and single rings |
| Stacking order | the order of `page.objects`: earlier objects are drawn underneath |

Gradients are `fillPaint` objects: `{kind: "solid", color, opacity}`,
`{kind: "linear-gradient", units: "object", x1, y1, x2, y2, stops}` or
`{kind: "radial-gradient", units: "object", cx, cy, r, stops}`, with
coordinates from 0 to 1 across the filled shape and stops
`{offset, color, opacity}`. The schemas are in
`packages/chem-core/src/schemas.ts`; style maps are read in
`packages/layout-engine/src/index.ts`.

## Ground rules

- **Appearance never changes chemistry, and appearance changes are always
  allowed.** Colour, fills, fonts, labels, effects, arrows and atom
  positions are drawing choices. Adding explicit H atoms or moving a wedge
  onto them is allowed only when the reported structure is unchanged.
- **Verify after every edit.** `render-document` regenerates canonical
  SMILES from the edited atoms and bonds. Compare it with the source
  (see "Check the chemistry"). A mismatch means the edit changed the
  molecule: undo it.
- **Look at every render.** `molecule.style` is a free-form record: a
  misspelled key, or `fontSize` where text expects `fontSizePx`, is
  silently ignored. Only the image tells you it worked.
- **Edit the document, never draw by hand.** The figure must come from the
  native document through `render-document`, not from an SVG you wrote.

## The workflow

1. Get the structure (a name through `name`, or a cited database record).
2. Build the editable document. It reports atom, bond and ring ids.
3. Edit the JSON with a small Node script in the scratch directory.
4. Render, read `ok`, compare the chemistry, look at the image.
5. Iterate until the figure is legible and in the requested style.
6. Save a `.chemdraft` copy so a human can fine-tune it in the app.

```sh
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft document --smiles 'C1CCC2C(C1)CCC3C2CCC4CCCC34' --out "$scratch/gonane.json" > "$scratch/gonane-build.json"
node "$scratch/style.mjs" "$scratch"
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft render-document --document "$scratch/gonane-styled.json" --out "$scratch/gonane-styled.png" --width 1200
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft render-document --document "$scratch/gonane-styled.json" --out "$scratch/gonane-styled.chemdraft"
```

Windows PowerShell (write UTF-8 instead of Windows PowerShell 5.1's default UTF-16):

```powershell
[Console]::OutputEncoding = [Text.Encoding]::UTF8
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft document --smiles 'C1CCC2C(C1)CCC3C2CCC4CCCC34' --out "$scratch/gonane.json" | Set-Content -Encoding utf8 "$scratch/gonane-build.json"
node "$scratch/style.mjs" "$scratch"
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft render-document --document "$scratch/gonane-styled.json" --out "$scratch/gonane-styled.png" --width 1200
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft render-document --document "$scratch/gonane-styled.json" --out "$scratch/gonane-styled.chemdraft"
```

`--format svg|png|pdf|chemdraft|both` follows the extension by default
(PDF currently misplaces labels; see Known limits);
`--background transparent`, `--padding` and `--width` work as in `render`.
Use absolute paths: the launcher runs the command inside the checkout,
so a relative path resolves there, not in your working directory.
Through MCP, `build_document` takes `smiles`; its first text block is the
JSON summary and its second text block is the document JSON. Style that
second block, or read the file named by the summary's `document` field.
`render_document` takes
`documentPath` or inline `documentJson`, plus `format`, `width`,
`background` and `padding`.

The `.chemdraft` file opens in the desktop app with File > Open. Tell the
user to save the current drawing first, because File > Open replaces the
open document without asking.

## Find the ids

The `document` result (stdout) lists, per molecule, `objectId`; `atoms`
with `id`, `element`, page `x`/`y` and `inputAtomIndex` (the 0-based atom
position in the SMILES); `bonds` with `id`, `fromAtomId`, `toAtomId`,
`order` and `display`; and `rings` with `ringKey`, `atomIds`, `bondIds`,
`center` and `size`. Use the reported `ringKey` (sorted bond ids joined
by `|`) instead of building one. The ring list is not in drawing order,
and position alone is a poor way to letter rings: it interleaves pendant
rings with the core. Letter by the literature's convention or a ring walk
(pattern 7).
Ordinary separately written hydrogen atoms are removed by existing depiction;
add them yourself (pattern 2).

Every pattern below starts from a script like this:

```js
// style.mjs - run with: node style.mjs <scratch>
import fs from "node:fs";
const dir = process.argv[2];
const build = JSON.parse(fs.readFileSync(`${dir}/gonane-build.json`, "utf8").replace(/^\uFEFF/, ""));
const doc = JSON.parse(fs.readFileSync(`${dir}/gonane.json`, "utf8"));
const page = doc.pages[0];
const mol = page.objects.find((o) => o.type === "molecule");
const rings = [...build.molecules[0].rings].sort((a, b) => a.center.x - b.center.x);
const atom = (id) => mol.atoms.find((a) => a.id === id);
// ... pattern code ...
fs.writeFileSync(`${dir}/gonane-styled.json`, JSON.stringify(doc));
```

## Check the chemistry

Read `molecules[].canonicalSmiles`, `stereoCenters`,
`unspecifiedStereoCenters` and `unspecifiedDoubleBonds` from the
`render-document` result. Explicit H atoms appear in that SMILES as
`[H]`, so do not compare strings by eye: normalise the source SMILES and
the reported one with the same method and compare InChIKeys.

```sh
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft analyze --smiles '<reported SMILES>' --methods 'rdkit.canonical-smiles,rdkit.inchikey'
```

Run it for both and require identical `summary.inchiKey` and
`summary.canonicalSmiles`. The stereo counts should match the plain
`render` of the source SMILES.

## Place objects

- Coordinates are page pixels; y grows downward. Atom `x`/`y` and ring
  `center` are in the same space.
- A `text` object draws its baseline at `y + fontSizePx`; with
  `textAlign: "center"` its centre is `x + width / 2`. To centre a capital
  letter on a point `(cx, cy)`: `x = cx - w/2`, `y = cy - 0.64 * fontSizePx`.
- Give every added object a box (`x`, `y`, `width`, `height`) that covers
  what it draws: the PNG/SVG crop is computed from those boxes, and an
  object left at `0,0` with size 0 drags the crop to the page corner.
- Moving atoms changes only the drawing, but check the chemistry again.

## Patterns

### 1. Shaded ring interiors and ring letters

```js
const fills = ["#9ecae1", "#fdd0a2", "#a1d99b", "#bcbddc"];
mol.style.ringStyles = Object.fromEntries(rings.map((r, i) => [r.ringKey, { fillColor: fills[i], fillOpacity: 0.6 }]));
// Gradient and per-ring effect variants:
mol.style.ringStyles[rings[1].ringKey] = { fillPaint: { kind: "linear-gradient", units: "object", x1: 0, y1: 0, x2: 1, y2: 1,
  stops: [{ offset: 0, color: "#fdd0a2" }, { offset: 1, color: "#e6550d", opacity: 0.8 }] } };
mol.style.ringStyles[rings[3].ringKey].visualEffects = [{ kind: "glow", color: "#756bb1", blurPx: 4, opacity: 0.8 }];
rings.forEach((r, i) => page.objects.push({ id: `ring-${i}`, type: "text", text: "ABCD"[i], spans: [],
  x: r.center.x - 10, y: r.center.y - 0.64 * 16, width: 20, height: 20, rotation: 0,
  style: { fontSizePx: 16, fontWeight: 700, textAlign: "center", color: "#333333" } }));
```

Verified on gonane: four filled rings (solid and linear gradient fills,
one glowing) with letters A–D centred, SMILES unchanged. On coloured
fills, set `mol.style.atomLabelBackgroundColor = "transparent"` so
heteroatom labels do not sit on white patches.

For a vivid look (Nicolaou style), use saturated colours at
`fillOpacity` about 0.9, never two alike side by side, and pick each
ring letter's colour for its fill by luminance: white on red, green,
blue, purple or magenta; near-black on yellow, orange, cyan or light
green. `scripts/ring-style.mjs` (pattern 7) does all of this with a
twelve-colour palette. A per-atom white
`atomLabelBackgroundColors` patch on ring O atoms looked worse (a speck
of fill shows inside the O); black O labels on the transparent default
stayed readable at the ring corners.

### 2. Explicit H at a ring fusion, bold fusion bond, CH3 or Me

The depiction puts each stereo bond on a ring bond starting at the
stereocentre. To draw the H instead: remove that bond's `bondStyle`, add
an H atom straight out along the fused bond (away from the fusion
partner, the neighbour sharing both rings), and give the C–H bond the
opposite style. A wedged ring bond (ring neighbour toward the viewer)
becomes a hashed H; a hashed ring bond becomes a wedged H.

```js
function addAlong(centerId, partnerId, element, bondStyle, length = 22) {
  const c = atom(centerId), p = atom(partnerId), d = Math.hypot(c.x - p.x, c.y - p.y);
  const id = `${element.toLowerCase()}_${centerId}`;
  mol.atoms.push({ id, element, x: c.x + (c.x - p.x) / d * length, y: c.y + (c.y - p.y) / d * length, formalCharge: 0 });
  mol.bonds.push({ id: `b_${id}`, fromAtomId: centerId, toAtomId: id, order: "single", display: { bondStyle } });
}
const old = mol.bonds.find((b) => b.fromAtomId === "a6" && b.display?.bondStyle);
addAlong("a6", "a1", "H", old.display.bondStyle === "wedge" ? "hashed" : "wedge");
delete old.display.bondStyle;
mol.bonds.find((b) => b.id === "b10").display = { bondStyle: "bold" };      // the fused bond
mol.style.atomLabelShowTerminalCarbonsByAtomId = { a0: true };              // methyl drawn as CH3
```

Verified on `C[C@@]12CCCC[C@H]1CCCC2`: hashed H below the fusion, bold
fusion bond, CH3 label; identical InChIKey. Always confirm: if the
InChIKey changes, swap the H's wedge and hash.

**Setting an atom's element to a label string changes the chemistry.**
`atom.element` is the atom's identity, not its caption: `"Me"`, `"Et"`,
`"Ph"` or any other string that is not an element turns that atom into a
placeholder. A `Me` label (`atom.element = "Me"`) draws "Me", but the
identity check writes it as a dummy atom `*` with a warning, the stereo
counts then read every centre as unspecified, and a `.chemdraft` saved
from that document holds `*` atoms, so anyone who opens or copies it
gets the wrong molecule. The atom schema (`packages/chem-core`) has no
display-label field that keeps the element C while showing "Me"; the
closest is `atomLabelShowTerminalCarbonsByAtomId`, which draws CH3 and
keeps the carbon.

So the trade-off is: the Me-labelled document is a picture only. Verify
and save the figure with carbons (drawn CH3), relabel to `Me` as the
last, display-only step, and render the picture from that copy. Hand
over the carbon `.chemdraft` as the editable file and say that it shows
CH3 where the picture shows Me. To check the picture, replace each `*`
in its reported SMILES with `C` and confirm the InChIKey still matches.
`scripts/ring-style.mjs` does exactly this (pattern 7).

### 3. Highlight a substructure

```js
const ester = ["b0", "b1", "b2", "b3"];
mol.style.bondColors = Object.fromEntries(ester.map((id) => [id, "#c0392b"]));
mol.style.bondStrokeWidths = Object.fromEntries(ester.map((id) => [id, 3]));
mol.style.atomLabelColors = { a2: "#c0392b", a3: "#c0392b" };
mol.style.atomLabelBackgroundColor = "transparent";
page.objects.unshift({ id: "panel", type: "graphic", graphicKind: "rect", x: 411, y: 522, width: 78, height: 85, rotation: 0,
  style: { fillColor: "#fde0dd", strokeColor: "#c0392b", strokeWidth: 1, strokeDasharray: "4 3" },
  data: { cornerRadiusPx: 8 } });                                    // unshift = drawn underneath
```

Verified on aspirin: the acetyl ester in red, thicker, on a dashed
rounded panel behind the molecule; compute the panel box from the
atoms' coordinates plus padding.

### 4. Colour-code atoms

```js
const colors = { O: "#d62728", N: "#1f77b4" };
const hetero = mol.atoms.filter((a) => colors[a.element]);
mol.style.atomLabelColors = Object.fromEntries(hetero.map((a) => [a.id, colors[a.element]]));
mol.style.atomLabelFontWeights = Object.fromEntries(hetero.map((a) => [a.id, 700]));
```

Verified on paracetamol: red bold O and OH, blue bold NH.

### 5. Hand-sketched look

```js
mol.style.visualEffects = [{ kind: "sketch", roughness: 1.25, bowing: 1, seed: 7, color: "#1f2a44" }];
mol.style.bondColor = "#1f2a44";
mol.style.atomLabelColor = "#1f2a44";
mol.style.atomLabelFontFamily = "Bradley Hand, Segoe Print, Comic Sans MS, cursive";
// Wide, well-spaced hashes and wedges stay readable under the rough strokes.
const stereo = mol.bonds.filter((b) => ["wedge", "hashed"].includes(b.display?.bondStyle)).map((b) => b.id);
mol.style.bondBoldWidths = Object.fromEntries(stereo.map((id) => [id, 12]));
mol.style.bondHashSpacings = Object.fromEntries(stereo.map((id) => [id, 8]));
page.objects.push({ id: "ring-circle", type: "graphic", graphicKind: "ellipse", x: 341, y: 509, width: 50, height: 50, rotation: 0,
  style: { fillColor: "none", visualEffects: [{ kind: "sketch", roughness: 2.2, bowing: 2, seed: 3, color: "#c0392b", strokeWidth: 2 }] },
  data: {} });
```

Sketch parameters: `roughness` (default 1.25), `bowing` (0.8),
`strokeWidth` (1.5), `seed` (fixes the wobble so re-renders match),
`color` (default near-black; a graphic's `strokeColor` does not colour
its sketch), `opacity`. On a graphic the sketch replaces the clean
stroke; on a molecule rough strokes are drawn over the normal bonds and
labels stay clean, so a handwriting `atomLabelFontFamily` completes the
look. On a molecule the sketch stroke is never thinner than the bond stroke
width, so only values above it change anything. Fonts come from the machine:
Bradley Hand is on macOS, Segoe Print on Windows; list both with a generic
fallback. Verified on penicillin G
(recipe 12).

**The sketch can mislead about stereochemistry.** Uneven, tapering stroke
weight is the intended hand-drawn look, including on plain bonds. The
real stereo hazard is that the stroke runs down the middle of a hashed
bond, so a hash can read as a solid line. Widen and space the stereo
bonds with `bondBoldWidths` (about 12) and `bondHashSpacings` (about 8).
After every sketched render, look at each wedge and hash at full size; if
a hash reads as solid, try another seed. When stereochemistry must be
unambiguous (exams, answer keys, papers), also render the document with
`visualEffects` removed and offer that clean version.

### 6. Arrows, brackets and annotations

```js
// Straight arrow with an open head.
page.objects.push({ id: "arrow", type: "graphic", graphicKind: "line", x: 470, y: 518, width: 60, height: 20, rotation: 0,
  style: { strokeColor: "#000000", strokeWidth: 1.5 },
  data: { lineStart: { x: 472, y: 528 }, lineEnd: { x: 528, y: 528 }, markerEnd: { kind: "open-arrow", sizePx: 10 } } });
// Curved arrow through a control point.
page.objects.push({ id: "curve", type: "graphic", graphicKind: "path", x: 388, y: 532, width: 30, height: 40, rotation: 0,
  style: { strokeColor: "#000000", strokeWidth: 1.5 },
  data: { artPathKind: "quadratic", lineStart: { x: 402, y: 572 }, lineEnd: { x: 396, y: 536 },
    pathControlPoint: { x: 420, y: 552 }, markerEnd: { kind: "filled-arrow", sizePx: 9 } } });
// Arc: centred in its box, radius width/2 - 4 unless arcRadiusX/arcRadiusY; a half-arrow head makes a fishhook.
page.objects.push({ id: "hook", type: "graphic", graphicKind: "path", x: 380, y: 440, width: 58, height: 58, rotation: 0,
  style: { strokeColor: "#1f77b4", strokeWidth: 1.5 },
  data: { artPathKind: "arc", arcSweepRadians: Math.PI, markerEnd: { kind: "half-arrow", sizePx: 10 } } });
// Electron pushing: full-headed, or "half-headed" for a fishhook.
page.objects.push({ id: "push", type: "mechanism-arrow", arrowKind: "full-headed", x: 356, y: 484, width: 44, height: 44, rotation: 0, style: {},
  source: { kind: "point", point: { x: 380, y: 525 } }, target: { kind: "atom", objectId: mol.id, atomId: "a0" },
  controlPoints: [{ x: 384, y: 488 }], warnings: [] });
// A bracket object is one side; the closing side is the same bracket rotated 180 degrees.
page.objects.push({ id: "open", type: "bracket", bracketKind: "square", x: 352, y: 486, width: 8, height: 84, rotation: 0, style: {}, containedObjectIds: [mol.id] });
page.objects.push({ id: "close", type: "bracket", bracketKind: "square", x: 490, y: 486, width: 8, height: 84, rotation: 180, style: {}, containedObjectIds: [mol.id] });
```

Verified on cyclohexanone: open and filled arrowheads, a curved attack
arrow, a half-headed arc, a mechanism arrow onto O, a fishhook, and a
bracket pair; separately, a molecule `shadow` effect
(`{kind: "shadow", color: "#000000", opacity: 0.4, offsetX: 3, offsetY: 3, blurPx: 2}`).
Mechanism-arrow anchors that render are `atom`, `point` and `object`.
A `bond` anchor is not resolved by the exporter: the arrow is silently
left out with no warning, so anchor at a `point` on the bond instead.

### 7. Nicolaou-style rings on any molecule: `scripts/ring-style.mjs`

The skill ships a plain Node script (no dependencies, macOS and Windows)
that applies patterns 1 and 2 to any molecule. Recipe 11 in
[recipes](recipes.md) has the full commands and the rules; in short:

- `node <skill>/scripts/ring-style.mjs pubchem <dir> <name> <cid or name>`
  fetches the SMILES, InChIKey and stereo counts from PubChem and writes
  the `document` batch.
- `node <skill>/scripts/ring-style.mjs style <dir> <name> [options.json] --checkout <checkout>`
  reads the `document` output and writes `<name>-carbon.json` (true structure, methyls drawn CH3: render
  it and save the `.chemdraft` from it) and `<name>-nicolaou.json` (the
  picture, methyls relabelled Me). It fills and letters the core ring
  system (rings sharing atoms with another ring, not pendant phenyls),
  letters by a literature convention (`taxane`, `steroid`, `morphinan`),
  an explicit `letters` map of chemistry selectors, or a ring walk, and
  stops when a rule matches no ring or several. Letters go at the most
  open point in each ring, in white or near-black by fill luminance;
  touching rings never share a colour; each fusion CH stereocentre gets
  an explicit H carrying its wedge or hash. First it picks the cleanest
  of three layouts (ChemDraft's, ChemDraft's from the canonical SMILES,
  PubChem's 2D record), turns every substituent off the filled rings
  (no substituent atom, bond or label inside a fill) and turns
  substituents whose labels touch. Each change (the layout, every move,
  each turn the options' `rotate` asks for, each fusion H) must read in
  the checkout's `render-document` as the same molecule and stereo
  counts, or it is undone and reported `UNDONE`; what cannot be cleared
  is named, and a label left on a fill gets white or near-black text by
  that fill's luminance (no box or halo).
- `relayout <dir> <name>` rewrites the job with ChemDraft's canonical
  SMILES, to try that layout by hand.
- `identity-jobs` and `check` compare every rendered InChIKey and the
  stereocentre counts with PubChem's, and list labels that nearly touch;
  the options' `rotate` turns a substituent about its attachment atom
  when one still does, checked like every other move.

Verified on paclitaxel, cholesterol, morphine and brevetoxin B (recipe 11).

## Style keys worth knowing

| Object | Keys |
|---|---|
| `text` style | `fontSizePx` (not `fontSize`), `fontFamily`, `fontWeight`, `fontStyle`, `color`, `textAlign` (`left`, `center`, `right`), `letterSpacingPx`, `lineHeight` |
| `text` span style | `fontSizePx`, `color`, `fontFamily`, `fontWeight`, `fontStyle` |
| `graphic` style | `strokeColor`, `strokeWidth`, `strokeDasharray`, `strokeLineCap`, `strokeLineJoin`, `fillColor`, `fillPaint`, `opacity`, `strokeOpacity`, `fillOpacity`, `visualEffects` |
| `graphic` data | `lineStart`, `lineEnd`, `pathControlPoint`, `pathNodes`, `arcCenter`, `arcRadiusX`, `arcRadiusY`, `arcStartRadians`, `arcSweepRadians`, `markerStart`, `markerEnd`, `cornerRadiusPx` |
| Shadow and glow | `color`, `opacity`, `offsetX`, `offsetY`, `blurPx`, `spreadPx` |

## Known limits

- With `--background transparent`, `render` and an unstyled
  `render-document` still paint an opaque white patch behind every atom
  label. For a transparent figure, use `render-document` with
  `molecule.style.atomLabelBackgroundColor = "transparent"`.
- Text spans export with a space between spans, so `C`, subscript `6`,
  `H`… reads "C 6 H 10 O" in the SVG and PNG. Unicode subscript
  characters (`C₆H₁₀O`) in one span avoid the gaps but may fall back to
  another font. Look at the image either way.
- The molecule sketch traces the centre line of wedge and hashed bonds,
  so a hashed bond reads as a spine with ticks. Use the settings in
  pattern 5, inspect every wedge and hash at full size, and offer an
  unsketched version when stereo must be unambiguous.
- **PDF output misplaces atom labels and text.** In three independent
  runs, even for unstyled molecules such as aspirin, labels were drawn off
  their atoms (and sometimes twice), "HO" split into separate letters, and
  fonts were replaced; `render-document --format pdf` of the same aspirin
  document shows the same fault. View every PDF before
  delivering it, and prefer SVG or PNG until this is fixed.
- **A ring fill runs under a ring heteroatom's label to the atom centre.**
  With `atomLabelBackgroundColor` transparent (needed on coloured fills),
  the fill polygon's corner shows inside the label, so a coloured point
  pokes into the O of an oxetane or furan. Look for it at full size; it
  cannot be hidden from the document today.
- **Ring fills are painted in a fixed order the document cannot change.**
  Where a bridged ring's outline takes in part of another ring, the
  larger fill can cover the smaller one. `scripts/ring-style.mjs` then
  paints the larger ring as a closed `path` graphic under the molecule;
  that path does not follow the atoms if they are moved in the app.
- **CH3 labels are wider than Me.** The carbon copy of a Me-labelled
  figure can crowd neighbouring labels that cleared in the picture; check
  both renders.
- `image` graphics fall back to a placeholder in exports
  (`export.svg.graphic_fallback`); the reflection effect is approximated
  or omitted with a warning. SVG, PNG and PDF render only the first page.
- A `.chemdraft` save warns that colours outside the standard CDXML
  colour table are kept exactly only in the embedded native payload.
- OpenChemLib stereo perception can report 0 specified/0 unspecified for ring-symmetric fused centres (for example `C[C@@]12CCCC[C@H]1CCCC2`) while canonical SMILES retains `@`; compare canonical SMILES or InChIKey to confirm chemistry, not stereo counts alone.
