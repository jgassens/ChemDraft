# Worked recipes

Contents: workspace; question grid; stereochemistry; salt reaction; synthesis;
properties table; mass peak; NMR handout; names dataset; slides; human edits;
a figure in a named chemist's style; a hand-sketched structure.

## Prepare an external workspace

Replace `<checkout>` with the confirmed checkout. Scratch paths must be
outside it. POSIX shell:

```sh
checkout="<checkout>"
scratch=$(node -p "require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'chemdraft-figures-'))")
```

PowerShell:

```powershell
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$checkout = '<checkout>'
$scratch = node -p "require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'chemdraft-figures-'))"
```

Set UTF-8 console output encoding before capturing CLI output so PowerShell
decodes Unicode correctly before `Set-Content` writes it. Prefer the command's
`--out` option when available; batch analysis and name conversion need stdout capture.
Shell state may reset between tool calls: set `$checkout`, `$scratch` and
console encoding again in each call, or substitute literal paths.

Unless labelled otherwise, the following single-line commands work in both
shells. Node snippets only prepare/read files; they do not compute chemistry
or draw structures. Read `ok` and warnings after every ChemDraft command.
View each final image once. Keep all input SMILES and options with the document.

## 1. Multiple-choice structure question with answer key

Question: Which structure is ethanol? Create choices in a fixed order:

```sh
node -e "require('node:fs').writeFileSync(require('node:path').join(process.argv[1], 'choices.json'), JSON.stringify([{name:'ethanol',smiles:'CCO'},{name:'dimethyl-ether',smiles:'COC'},{name:'acetone',smiles:'CC(=O)C'},{name:'acetic-acid',smiles:'CC(=O)O'}]))" "$scratch"
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft grid --batch "$scratch/choices.json" --out "$scratch/question.png" --columns 2 --labels letters --width 1000
```

Answer key: A (ethanol), B (dimethyl ether), C (acetone), D (acetic acid).
The key is tied to input order; do not put it on the student-facing image.
The choices are real rendered structures, with one shared depiction scale.

## 2. Stereochemistry question with R/S answers

Question: Assign each drawn center's absolute configuration.

```sh
node -e "require('node:fs').writeFileSync(require('node:path').join(process.argv[1], 'stereo.json'), JSON.stringify([{name:'first',smiles:'C[C@H](O)C(=O)O'},{name:'second',smiles:'C[C@@H](O)C(=O)O'}]))" "$scratch"
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft grid --batch "$scratch/stereo.json" --out "$scratch/stereo-question.png" --columns 2 --width 1000
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft stereo --batch "$scratch/stereo.json"
```

The verified output assigns atom 1 of the first structure S and the second
R; use those outputs for the answer key. `stereo` reports `specifiedCount`
and `unspecifiedCount`, plus separate `stereoCenters` and `doubleBonds`
arrays; require `unspecifiedCount: 0` for this exercise. A render's two
unspecified counts must also be zero. Do not infer R/S directly from `@`
or from wedge direction alone.
For E/Z exercises, use `stereo` on slash-specified alkene SMILES too.

## 3. Reaction scheme with agents, conditions and a salt

Show an acid workup of sodium acetate. Preserve the salt as one reactant:

```sh
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft reaction --reactant '[Na+].[O-]C(=O)C' --agent 'Cl' --product 'CC(=O)O' --conditions 'aqueous acid workup' --out "$scratch/salt.svg"
```

Check sodium/counterion identity and the HCl agent label. This simplified
scheme omits byproducts; it is not a claim of a balanced equation.
Repeated role flags keep the dot-joined salt whole. Reaction SMILES would
split it into species.

## 4. Multi-step synthesis

Show oxidation of ethanol to acetic acid, then esterification. These are
supplied illustrative transformations, not products inferred by ChemDraft.

```sh
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft reaction --reactant 'CCO' --product 'CC(=O)O' --conditions 'oxidation' --out "$scratch/step-1.png"
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft reaction --reactant 'CC(=O)O' --reactant 'CCO' --agent 'OS(=O)(=O)O' --product 'CC(=O)OCC' --conditions 'reflux' --out "$scratch/step-2.png"
```

Place the two verified images in order. Keep conditions as supplied;
do not invent experimental yields, safety directions or feasibility claims.

## 5. Properties table for a compound list

Use the choices batch to compute formula, masses, logP and TPSA.
POSIX shell (redirect stdout only):

```sh
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft analyze --batch "$scratch/choices.json" --methods 'rdkit.composition,rdkit.monoisotopic-mass,rdkit.average-mass,rdkit.crippen-logp,rdkit.tpsa' > "$scratch/properties.jsonl"
```

PowerShell (write UTF-8, rather than Windows PowerShell's default UTF-16):

```powershell
[Console]::OutputEncoding = [Text.Encoding]::UTF8
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft analyze --batch "$scratch/choices.json" --methods 'rdkit.composition,rdkit.monoisotopic-mass,rdkit.average-mass,rdkit.crippen-logp,rdkit.tpsa' | Set-Content -Encoding utf8 "$scratch/properties.jsonl"
```

Read the lines into a table; this snippet also handles a UTF-8 BOM:

```sh
node -e "const fs=require('node:fs'); const rows=fs.readFileSync(process.argv[1],'utf8').replace(/^\uFEFF/,'').trim().split(/\r?\n/).map(JSON.parse); console.table(rows.map(r=>({name:r.name,ok:r.ok,formula:r.summary?.formula.value,mass:r.summary?.monoisotopicMass.value,logP:r.summary?.logP.value,logPStatus:r.summary?.logP.status,tpsa:r.summary?.tpsa.value})));" "$scratch/properties.jsonl"
```

Keep the JSON beside the table: display method/version, units, interpretation
and statuses for **each** property when publishing. The abbreviated console
table is an inspection aid, not a complete scientific report.

## 6. Check an observed mass-spec peak against m/z

Illustrative user-supplied peak: m/z 181.0495, singly charged positive ion,
absolute tolerance 0.001. Check an aspirin protonated-ion candidate:

```sh
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft analyze --smiles 'CC(=O)Oc1ccccc1C(=O)O' --methods 'rdkit.monoisotopic-mass,rdkit.mz.M+H' --out "$scratch/mass.json"
node -e "const r=JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')); const p=r.run.results.find(x=>x.methodId==='rdkit.mz.M+H'); if(!p||p.value===null) throw Error('Candidate not computed'); const observed=181.0495; console.log(JSON.stringify({method:p.methodId,version:p.methodVersion,status:p.status,unit:p.unit,computed:p.value,observed,delta:observed-p.value,withinTolerance:Math.abs(observed-p.value)<=0.001}));" "$scratch/mass.json"
```

Report compatibility with that candidate and tolerance, not proof of identity.
The m/z table has no fragmentation or intensity prediction.

## 7. Predicted ¹H/¹³C spectrum for a handout

Requires the separate owner-trusted NMR plugin; see [setup](setup.md).

```sh
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft nmr --smiles 'CCO' --nuclei '1H,13C' --ignore-labile --statistic median --spectrum "$scratch/predicted-ethanol.svg"
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft nmr --smiles 'CCO' --nuclei '1H,13C' --ignore-labile --spectrum "$scratch/predicted-ethanol.png"
```

Two files per command get nucleus suffixes. Caption **Predicted ¹H/¹³C
shifts; multiplicities/J are first-order estimates; stick height is
equivalent nuclei, not integration; labile protons omitted.** Keep rule
estimates and thin-match/partial warnings visible, with database attribution.
Compare per environment beside an experimental spectrum; never shift the
predictions to fit it. Read [NMR](nmr.md) for all honesty constraints.

## 8. Names → SMILES → one SDF dataset

Prepare name jobs:

```sh
node -e "require('node:fs').writeFileSync(require('node:path').join(process.argv[1], 'names.json'), JSON.stringify([{name:'ethanol',query:'ethanol'},{name:'acetic-acid',query:'acetic acid'}]))" "$scratch"
```

POSIX shell:

```sh
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft name --batch "$scratch/names.json" > "$scratch/names.jsonl"
```

PowerShell:

```powershell
[Console]::OutputEncoding = [Text.Encoding]::UTF8
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft name --batch "$scratch/names.json" | Set-Content -Encoding utf8 "$scratch/names.jsonl"
```

Stop the dataset pipeline if any conversion failed; preserve each name:

```sh
node -e "const fs=require('node:fs'),path=require('node:path'); const rows=fs.readFileSync(path.join(process.argv[1],'names.jsonl'),'utf8').replace(/^\uFEFF/,'').trim().split(/\r?\n/).map(JSON.parse); if(rows.some(r=>!r.ok||!r.smiles)) throw Error('A name conversion failed'); fs.writeFileSync(path.join(process.argv[1],'named-structures.json'),JSON.stringify(rows.map(r=>({name:r.name,smiles:r.smiles}))));" "$scratch"
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft export --batch "$scratch/named-structures.json" --out "$scratch/named-structures.sdf" --format sdf
```

Check every export JSON line too. Failed jobs never become guessed structures.

## 9. Transparent slide figure

```sh
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft render --smiles 'CC(=O)Oc1ccccc1C(=O)O' --out "$scratch/slide-aspirin" --format both --background transparent --width 1200 --padding 24
```

Inspect the PNG, then place SVG if the slide software supports it; otherwise
use PNG. Check contrast against the slide background. Keep the SMILES/options.
Known limitation: `render` still paints an opaque white patch behind each
atom label (the O and OH here) on a transparent background. On a coloured
slide, build the figure with `document`, set
`molecule.style.atomLabelBackgroundColor` to `"transparent"`, and render it
with `render-document --background transparent` ([art](art.md)).

## 10. Human hand-edit loop via CDXML

```sh
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft export --smiles 'CC(=O)Oc1ccccc1C(=O)O' --out "$scratch/editable-aspirin.cdxml"
```

Tell the human to save the current drawing first, because File > Open
replaces the open document without asking. Then have them open this file in
ChemDraft with File > Open, edit the
structure and save a native document. Review the final chemistry and obtain
updated SMILES before another headless render. This verified command creates
the handoff file; the human editing/desktop reopening step needs a hands-on
check on each platform. Do not automate editing through the testing bridge.

## 11. A structure "in the style of" a named chemist: brevetoxin B, Nicolaou-style

A request for a named chemist's or journal's style is a set of visual
conventions to reproduce, not something to refuse. Nicolaou's ladder-
polyether drawings use lettered rings, H at every ring-fusion
stereocentre, Me labels and, in reviews, shaded ring interiors. All are
native document art ([art](art.md)).

Never type a structure this size from memory. Take it from PubChem CID
10865865 (Brevetoxin B, C50H70O14) and cite the CID with the figure:

```sh
node -e "fetch('https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/10865865/property/Title,MolecularFormula,SMILES/JSON').then(r=>r.json()).then(j=>{const p=j.PropertyTable.Properties[0]; console.log(p.CID,p.Title,p.MolecularFormula,p.SMILES); require('node:fs').writeFileSync(require('node:path').join(process.argv[1],'brevetoxin-b-job.json'),JSON.stringify([{name:'brevetoxin-b',smiles:p.SMILES}]));})" "$scratch"
```

Build the editable document. POSIX shell:

```sh
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft document --batch "$scratch/brevetoxin-b-job.json" --out-dir "$scratch" > "$scratch/brevetoxin-b-build.jsonl"
```

PowerShell:

```powershell
[Console]::OutputEncoding = [Text.Encoding]::UTF8
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft document --batch "$scratch/brevetoxin-b-job.json" --out-dir "$scratch" | Set-Content -Encoding utf8 "$scratch/brevetoxin-b-build.jsonl"
```

Save this script as `brevetoxin-style.mjs` in the scratch directory. It
fills the eleven rings with pastel colours, letters them A–K left to
right at their centres, moves each ring-fusion stereo bond onto an
explicit H (opposite wedge/hash, along the fused bond), and writes two
files: `-carbon` (verifiable) and `-nicolaou` (methyls relabelled Me).

```js
// node brevetoxin-style.mjs <scratch>: shaded rings, ring letters A-K, H at ring fusions, Me labels.
import fs from "node:fs";
import path from "node:path";
const dir = process.argv[2];
const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8").replace(/^\uFEFF/, ""));
const build = read("brevetoxin-b-build.jsonl");
const doc = read("brevetoxin-b.json");
const page = doc.pages[0];
const mol = page.objects.find((o) => o.type === "molecule");
const atom = (id) => mol.atoms.find((a) => a.id === id);
const neighbours = (id) => mol.bonds.flatMap((b) => b.fromAtomId === id ? [b.toAtomId] : b.toAtomId === id ? [b.fromAtomId] : []);
const rings = [...build.molecules[0].rings].sort((a, b) => a.center.x - b.center.x);
// Pastel ring interiors and italic serif ring letters, A to K from left to right.
const fills = ["#f4b6b6", "#f7d2a6", "#f6eaa2", "#cfe8a9", "#a9dcc6", "#a8d4ec", "#b4bff0", "#d0b8ee", "#efb8dc", "#f4c4c4", "#e9d7b0"];
mol.style.atomLabelBackgroundColor = "transparent";
mol.style.ringStyles = Object.fromEntries(rings.map((r, i) => [r.ringKey, { fillColor: fills[i % fills.length], fillOpacity: 0.55 }]));
rings.forEach((r, i) => page.objects.push({ id: `ring-${i}`, type: "text", text: String.fromCharCode(65 + i), spans: [],
  x: r.center.x - 10, y: r.center.y - 0.64 * 20, width: 20, height: 24, rotation: 0,
  style: { fontSizePx: 20, fontWeight: 700, fontStyle: "italic", textAlign: "center", color: "#3a3a3a", fontFamily: "Times New Roman, Times, serif" } }));
// Ring-fusion CH stereocentres: move the stereo bond onto an explicit H along the fused bond.
for (const a of [...mol.atoms]) {
  const mine = rings.filter((r) => r.atomIds.includes(a.id));
  const stereo = mol.bonds.find((b) => b.fromAtomId === a.id && ["wedge", "hashed"].includes(b.display?.bondStyle));
  const partner = neighbours(a.id).find((id) => mine.every((r) => r.atomIds.includes(id)));
  if (a.element !== "C" || mine.length < 2 || neighbours(a.id).length !== 3 || !stereo || !partner) continue;
  const c = atom(a.id), p = atom(partner), d = Math.hypot(c.x - p.x, c.y - p.y);
  mol.atoms.push({ id: `h_${a.id}`, element: "H", x: c.x + (c.x - p.x) / d * 22, y: c.y + (c.y - p.y) / d * 22, formalCharge: 0 });
  mol.bonds.push({ id: `b_h_${a.id}`, fromAtomId: a.id, toAtomId: `h_${a.id}`, order: "single",
    display: { bondStyle: stereo.display.bondStyle === "wedge" ? "hashed" : "wedge" } });
  delete stereo.display.bondStyle;
}
fs.writeFileSync(path.join(dir, "brevetoxin-b-carbon.json"), JSON.stringify(doc));
// Display-only last step: methyl carbons on ring atoms become "Me" labels.
const ringAtoms = new Set(rings.flatMap((r) => r.atomIds));
for (const a of mol.atoms) {
  const n = neighbours(a.id);
  const bond = mol.bonds.find((b) => b.fromAtomId === a.id || b.toAtomId === a.id);
  if (a.element === "C" && n.length === 1 && ringAtoms.has(n[0]) && bond.order === "single") a.element = "Me";
}
fs.writeFileSync(path.join(dir, "brevetoxin-b-nicolaou.json"), JSON.stringify(doc));
```

Style, render and save:

```sh
node "$scratch/brevetoxin-style.mjs" "$scratch"
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft render-document --document "$scratch/brevetoxin-b-carbon.json" --out "$scratch/brevetoxin-b-carbon.png" --width 2000
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft render-document --document "$scratch/brevetoxin-b-nicolaou.json" --out "$scratch/brevetoxin-b-nicolaou" --format both --width 2000
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft render-document --document "$scratch/brevetoxin-b-nicolaou.json" --out "$scratch/brevetoxin-b-nicolaou.chemdraft"
```

Check, as verified when this recipe was written:

- The `-carbon` render reports 23 specified stereocentres, 0 unspecified.
  Run `analyze --methods 'rdkit.canonical-smiles,rdkit.inchikey'` on the
  PubChem SMILES and on the reported `canonicalSmiles`; both gave
  InChIKey `LYTCVQQGCSNFJU-FGRVLNGBSA-N` and formula C50H70O14.
- The `-nicolaou` render writes each Me as `*` and warns once per label;
  its stereo counts read as unspecified for that reason. Replace `*` with
  `C` in its `canonicalSmiles` and check the same InChIKey.
- Look at the PNG: eleven shaded rings lettered A–K, fifteen fusion H
  atoms, seven Me labels, no label sitting on a ring letter.

## 12. A hand-sketched structure: penicillin G

The sketch visual effect draws rough strokes over the bonds; a
handwriting label font and a sketched circle finish the look. Structure
from PubChem CID 5904 (Penicillin G, C16H18N2O4S):

```sh
node -e "fetch('https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/5904/property/Title,MolecularFormula,SMILES/JSON').then(r=>r.json()).then(j=>{const p=j.PropertyTable.Properties[0]; console.log(p.CID,p.Title,p.MolecularFormula,p.SMILES); require('node:fs').writeFileSync(require('node:path').join(process.argv[1],'penicillin-g-job.json'),JSON.stringify([{name:'penicillin-g',smiles:p.SMILES}]));})" "$scratch"
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft document --batch "$scratch/penicillin-g-job.json" --out-dir "$scratch" > "$scratch/penicillin-g-build.jsonl"
```

In PowerShell, capture the `document` output with
`| Set-Content -Encoding utf8` as in recipe 11. Save this as
`penicillin-sketch.mjs` in the scratch directory:

```js
// node penicillin-sketch.mjs <scratch>: rough strokes, handwriting labels, a sketched circle and caption.
import fs from "node:fs";
import path from "node:path";
const dir = process.argv[2];
const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8").replace(/^\uFEFF/, ""));
const build = read("penicillin-g-build.jsonl");
const doc = read("penicillin-g.json");
const page = doc.pages[0];
const mol = page.objects.find((o) => o.type === "molecule");
const ink = "#1f2a44", red = "#c0392b", hand = "Bradley Hand, Segoe Print, Comic Sans MS, cursive";
mol.style.visualEffects = [{ kind: "sketch", roughness: 1.25, bowing: 1, strokeWidth: 1, seed: 7, color: ink }];
Object.assign(mol.style, { bondColor: ink, atomLabelColor: ink, atomLabelFontFamily: hand, atomLabelFontSizePx: 16 });
// Keep wedges and hashes legible under the rough strokes.
const stereo = mol.bonds.filter((b) => b.display?.bondStyle === "wedge" || b.display?.bondStyle === "hashed").map((b) => b.id);
mol.style.bondBoldWidths = Object.fromEntries(stereo.map((id) => [id, 9]));
mol.style.bondHashSpacings = Object.fromEntries(stereo.map((id) => [id, 5]));
const lactam = build.molecules[0].rings.find((r) => r.size === 4);
page.objects.push({ id: "lactam-circle", type: "graphic", graphicKind: "ellipse", rotation: 0,
  x: lactam.center.x - 25, y: lactam.center.y - 25, width: 50, height: 50,
  style: { fillColor: "none", visualEffects: [{ kind: "sketch", roughness: 2.2, bowing: 2, seed: 3, color: red, strokeWidth: 2 }] }, data: {} });
page.objects.push({ id: "lactam-note", type: "text", text: "β-lactam", spans: [], rotation: 0,
  x: lactam.center.x + 26, y: lactam.center.y - 58, width: 80, height: 20, style: { fontFamily: hand, fontSizePx: 15, color: red } });
const xs = mol.atoms.map((a) => a.x), bottom = Math.max(...mol.atoms.map((a) => a.y));
page.objects.push({ id: "caption", type: "text", text: "penicillin G", spans: [], rotation: 0,
  x: Math.min(...xs), y: bottom + 24, width: Math.max(...xs) - Math.min(...xs), height: 26,
  style: { fontFamily: hand, fontSizePx: 20, textAlign: "center", color: ink } });
fs.writeFileSync(path.join(dir, "penicillin-g-sketch.json"), JSON.stringify(doc));
```

```sh
node "$scratch/penicillin-sketch.mjs" "$scratch"
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft render-document --document "$scratch/penicillin-g-sketch.json" --out "$scratch/penicillin-g-sketch" --format both --width 1200
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft render-document --document "$scratch/penicillin-g-sketch.json" --out "$scratch/penicillin-g-sketch.chemdraft"
```

Verified: the reported canonical SMILES equals the source's (InChIKey
`JGSARLDLIJGVTE-MBNYWOFBSA-N`), with 3 specified stereocentres. The 1 unspecified centre is the bridgehead N,
which the plain `render` and `stereo` report the same way; do not add
stereo to it. Look at the image at full size: the sketch traces the
centre of the hashed C–CO2H bond, which is why the script widens the
hashes ([art](art.md), Known limits). Fonts are per machine; if neither
handwriting font is installed, the generic `cursive` font is used.
