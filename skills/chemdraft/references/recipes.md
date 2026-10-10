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

## 11. A structure in the Nicolaou style, for any molecule

A request for a named chemist's or journal's style is a set of visual
conventions to reproduce, not something to refuse. Nicolaou is a style,
not a molecule. Its calling card is vivid colour: every lettered ring
filled with its own loud, saturated colour, no two neighbouring rings
alike. Ring letters in italic serif, H drawn at ring-fusion stereocentres
and Me labels on ring methyls complete it. Pastel tints, or black and
white with ring letters, are not the style: the coloured figure is the
answer, not an optional variant. All of it is native document art
([art](art.md)).

`scripts/ring-style.mjs` in this skill applies the style to any molecule.
It is plain Node with no dependencies and runs on macOS and Windows. It
edits document JSON only; ChemDraft builds, renders and checks the
chemistry. `style` runs the CLI of the ChemDraft checkout it is given
(`node ring-style.mjs style <dir> <name> <options> --checkout <checkout>`)
with the same Node and no shell, to check every coordinate change it
makes.

### The rules it applies

1. **Which rings.** It fills and letters the core ring system(s): rings
   that share atoms with another ring (fused, bridged or spiro). Isolated
   substituent rings, such as paclitaxel's three phenyls, stay plain
   unless the user or the literature letters them; then set
   `"rings": "all"` and letter them in an explicit `letters` map.
2. **Which letter.** Use the literature's letters when the compound class
   has them. A convention names each ring by its chemistry (size,
   heteroatoms, aromaticity, ring double bonds, which lettered rings it
   shares a bond with), never by its position on the page:

   | `convention` | Letters |
   |---|---|
   | `taxane` | A the cyclohexene (one ring C=C), B the eight-membered ring, C the saturated cyclohexane fused to B, D the oxetane (optional) |
   | `steroid` | D the cyclopentane, C the six-membered ring fused to D, B the one fused to C, A the one fused to B |
   | `morphinan` | A the aromatic ring, B the carbocycle fused to A, C the other carbocycle, D the piperidine, E the tetrahydrofuran (optional) |
   | `walk` (default) | breadth-first from a terminal ring across rings that share atoms; ties go left to right, then top to bottom |

   Ladder polyethers are lettered along the ladder from the ring the
   literature calls A: a walk with a `start` selector (brevetoxins start
   at the lactone, `{"carbonyl": true}`). For any other class with a
   convention, write it as a `letters` map of selectors, assigned in the
   order given, for example
   `{"letters": {"A": {"size": 6, "aromatic": true}, "B": {"size": 5, "hetero": {"N": 1}, "sharesBondWith": ["A"]}}}`.
   Selector fields: `size`, `hetero` (`{"O": 1}`; `{}` is a carbocycle),
   `aromatic`, `ringDoubleBonds` (outside aromatic rings), `carbonyl` (a
   ring carbon with an exocyclic =O), `sharesBondWith` and
   `notSharesBondWith` (letters given earlier), `atoms` (0-based SMILES
   atom indices the ring contains), `optional`. A rule that matches no
   ring or several stops the script with every candidate listed, and so
   does a core ring left without a letter; never guess past either. With
   no convention, the walk is the rule: say so in the caption or report.
3. **Where the letter goes.** At the most open point inside its ring,
   clear of atoms, bonds and labels (such as a gem-dimethyl pointing into
   the ring), in bold italic serif at 20 px, shrinking only to fit.
4. **Letter colour.** White on a dark fill, near-black on a light one,
   chosen by the fill's relative luminance as drawn (white below 0.34).
5. **Fill colours.** Twelve saturated colours in letter order, so each
   ring gets its own; beyond twelve, a greedy colouring over ring
   adjacency keeps rings that share an atom apart.
6. **Fusion H.** At every CH stereocentre shared by two lettered rings,
   the wedge or hash that starts there moves onto a new explicit H with
   the opposite style (a wedged ring bond becomes a hashed H), and the
   ring bond goes plain. The stereochemistry is unchanged, and the check
   below proves it. The H points outward in the clearest direction, never
   across a bond or onto a fill; an H that would touch a bond or label is
   not drawn and its atom keeps the ring wedge (warned).
7. **Me.** Methyls on lettered rings are drawn CH3 in `<name>-carbon.json`,
   the true structure and the editable file. Its CH3 labels are wider than
   Me and can crowd neighbours. `<name>-nicolaou.json` relabels them Me
   for the picture only: a Me label is a placeholder atom (`*`), not a
   carbon ([art](art.md), pattern 2).
8. **Layout.** Before styling, `style` compares three drawings of the
   same molecule: ChemDraft's build, ChemDraft's layout of the canonical
   SMILES (another atom order) and PubChem's own 2D record, fetched by
   CID. PubChem's atoms are matched to the document's and every wedge is
   re-drawn so each stereocentre keeps its handedness. Each layout is
   scored on bond crossings, bonds, atoms and labels lying on a fill that
   is not their own, fill over fill, clashing atoms and stretched bonds;
   the build stays unless another is clearly cleaner. The choice is
   general: nothing in the script knows any molecule.
9. **No substituent on a filled ring.** No substituent atom, bond or
   label may sit inside a filled ring. A substituent is everything past an
   acyclic bond from a lettered-ring atom. Each one found on a fill is
   turned or mirrored about its attachment atom, bond lengths kept, to the
   clearest placement off every fill that lands on no atom and crosses no
   bond. A mirror image swaps the wedges inside the group, so its own
   stereocentres keep their handedness.
10. **Labels that touch.** A substituent whose label touches another
   label, a bond or a fusion H (where the H will go is worked out first)
   is turned by up to 60 degrees, never onto a fill.
11. **Every move is checked.** A new layout, and every move in rules 9
   and 10, must read in `render-document` as the same canonical SMILES
   with the same specified and unspecified stereocentre counts as the
   build's own drawing. A move that fails is undone and reported
   (`UNDONE`), and the next placement is tried; a substituent that cannot
   be cleared is reported by name (`STILL ON A FILL`). The script never
   moves a ring atom and never changes a bond.
12. **Collisions.** `check` measures every atom label and ring letter in
   the rendered SVGs and lists the pairs that nearly touch, naming each
   atom and the atom it hangs from.
13. **Identity.** `check` requires every rendered InChIKey to equal
   PubChem's own InChIKey, and the specified and unspecified stereocentre
   counts to equal PubChem's.

### Run it

Get the structure from a database record, never from memory. OPSIN
(`name`) parses systematic names, not trivial ones such as "paclitaxel":
for a trivial name, `pubchem` looks the name up in PubChem (it also takes
a CID). A name lookup prints every CID it matched and uses the first;
confirm the title and formula, and cite the CID with the figure. If
PubChem has no record, convert a systematic name with `name`, build from
that SMILES, compare InChIKeys as in [art](art.md) "Check the chemistry",
and say the check only shows the drawing kept the SMILES you started
from.

POSIX shell, paclitaxel (CID 36314), taxane letters:

```sh
skill="$checkout/skills/chemdraft"
node "$skill/scripts/ring-style.mjs" pubchem "$scratch" paclitaxel 36314
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft document --batch "$scratch/paclitaxel-job.json" --out-dir "$scratch" > "$scratch/paclitaxel-build.jsonl"
printf '%s' '{"convention":"taxane"}' > "$scratch/paclitaxel-options.json"
node "$skill/scripts/ring-style.mjs" style "$scratch" paclitaxel "$scratch/paclitaxel-options.json" --checkout "$checkout"
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft render-document --document "$scratch/paclitaxel-carbon.json" --out "$scratch/paclitaxel-carbon" --format both --width 2000 > "$scratch/paclitaxel-render.jsonl"
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft render-document --document "$scratch/paclitaxel-carbon.json" --out "$scratch/paclitaxel.chemdraft" >> "$scratch/paclitaxel-render.jsonl"
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft render-document --document "$scratch/paclitaxel-nicolaou.json" --out "$scratch/paclitaxel-nicolaou" --format both --width 2000 >> "$scratch/paclitaxel-render.jsonl"
node "$skill/scripts/ring-style.mjs" identity-jobs "$scratch" paclitaxel
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft analyze --batch "$scratch/paclitaxel-identity-jobs.json" --methods 'rdkit.inchikey,rdkit.composition' > "$scratch/paclitaxel-identity.jsonl"
node "$skill/scripts/ring-style.mjs" check "$scratch" paclitaxel
```

PowerShell (the script also reads UTF-16 files, but write UTF-8):

```powershell
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ringStyle = Join-Path $checkout 'skills/chemdraft/scripts/ring-style.mjs'
node $ringStyle pubchem $scratch paclitaxel 36314
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft document --batch "$scratch/paclitaxel-job.json" --out-dir "$scratch" | Set-Content -Encoding utf8 "$scratch/paclitaxel-build.jsonl"
Set-Content -Encoding utf8 "$scratch/paclitaxel-options.json" '{"convention":"taxane"}'
node $ringStyle style $scratch paclitaxel "$scratch/paclitaxel-options.json" --checkout $checkout
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft render-document --document "$scratch/paclitaxel-carbon.json" --out "$scratch/paclitaxel-carbon" --format both --width 2000 | Set-Content -Encoding utf8 "$scratch/paclitaxel-render.jsonl"
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft render-document --document "$scratch/paclitaxel-carbon.json" --out "$scratch/paclitaxel.chemdraft" | Add-Content -Encoding utf8 "$scratch/paclitaxel-render.jsonl"
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft render-document --document "$scratch/paclitaxel-nicolaou.json" --out "$scratch/paclitaxel-nicolaou" --format both --width 2000 | Add-Content -Encoding utf8 "$scratch/paclitaxel-render.jsonl"
node $ringStyle identity-jobs $scratch paclitaxel
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft analyze --batch "$scratch/paclitaxel-identity-jobs.json" --methods 'rdkit.inchikey,rdkit.composition' | Set-Content -Encoding utf8 "$scratch/paclitaxel-identity.jsonl"
node $ringStyle check $scratch paclitaxel
```

`style` prints the layout it chose with every candidate's score, each
substituent it moved, undid or could not clear, what remains (crossings,
items on a fill not their own, fill overlap, stretched bonds), then each
ring's letter, colour and chemistry, the fusion H and Me it added, and any
warning; `<name>-style.json` keeps the same under `layout`.
`check` prints PubChem's InChIKey and stereo counts beside each render's,
then the near-touching labels, and exits 1 if an InChIKey or count
differs. A failed check means the figure is not the molecule: do not
deliver it.

### Look, fix, look again

Open each PNG at full size and check: every letter sits in the ring the
convention names and reads on its fill; the colours are loud and no two
touching rings match; every wedge and hash is where it was, including on
each new H; no label is clipped or sits on another label or a letter. A
ring fill also runs under a ring heteroatom's label to the atom centre,
so a coloured point pokes into the O (paclitaxel's oxetane, morphine's
furan): look for it, and see [art](art.md), Known limits.

- **`STILL ON A FILL`.** Read the reason. "Enclosed by filled rings"
  means every direction from the attachment atom lies on a fill: the atom
  sits inside a bridged ring system (paclitaxel's C15, between rings A
  and B). No flat drawing can clear it; say so with the figure rather
  than move ring atoms by hand. "Undone" means every placement off the
  fill would change the stereochemistry.
- **Labels still touch.** `check` names each pair. Turn one substituent
  about its attachment atom and restyle: add
  `"rotate": [{"atom": "a52", "about": "a10", "degrees": 25}]` to the
  options (positive turns clockwise on the page; take the ids from
  `check`, which prints each label's atom and the atom it hangs from).
  The rotation runs before the fill and label steps, which still check
  it. This is rarely needed: the label step clears most pairs itself.
- **A crossing or overlap remains.** `style` names it. Some ring systems
  cannot be drawn flat without one (an atom shared by four rings, a
  bridge across a ring); the search keeps the cleanest of the layouts it
  compared. `"layout": "build"` keeps ChemDraft's own layout instead, and
  `relayout` rewrites the job with ChemDraft's canonical SMILES by hand.
  When one lettered ring's outline takes in part of a smaller one, the
  script paints the larger ring's fill as a path object under the
  molecule so the smaller ring shows on top (it says so).
- **A letter rule fails.** Read the candidates it lists and write a
  `letters` map with tighter selectors or `atoms` indices.

Hand over `<name>.chemdraft` (saved from the carbon document) as the
editable file and the `-nicolaou` PNG or SVG as the picture, and say that
the editable file shows CH3 where the picture shows Me.

### Verified examples

Run from empty folders with the commands above, with no `rotate` entries.
Atom ids belong to these builds; read your own.

| Molecule (PubChem CID) | Options | What `style` did | Checked |
|---|---|---|---|
| paclitaxel (36314) | `{"convention": "taxane"}` | build layout; turned the C4 acetate and the C7 OH to clear labels; the C15 gem-dimethyl stays in ring B (enclosed, see below) | A–D, phenyls plain; 2 fusion H, 4 Me; InChIKey `RCINICONZNJXQF-MZXODVADSA-N`; 11 specified, 0 unspecified |
| cholesterol (5997) | `{"convention": "steroid"}` | build layout; turned the C19 methyl 20 degrees clear of the C9 H | A–D; 3 fusion H, 2 Me; `HVYWMOMLDIMFJA-DPAQBDIFSA-N`; 8 and 0 |
| morphine (5288826) | `{"convention": "morphinan"}` | chose PubChem's 2D layout (score 134 against 194 and 173), wedges re-drawn | A–E; 2 fusion H (C14 keeps its ring hash), N–Me; `BQJCRHHNABKAKU-KBQPJGBKSA-N`; 5 and 0 |
| brevetoxin B (10865865) | `{"start": {"carbonyl": true}}` | build layout; turned three methyls 5–10 degrees to clear labels | A–K along the ladder from the lactone; 15 fusion H, 7 Me; `LYTCVQQGCSNFJU-FGRVLNGBSA-N`; 23 and 0 |

What remains, and why:

- **Paclitaxel, C15.** C15 is the one-atom bridge of the bicyclic A/B
  system: its two ring bonds have ring A on one side and ring B on the
  other, so both methyls lie on a fill whichever way they point. Turning
  them into ring A would put two Me labels and the A letter in one
  six-membered ring. The script leaves them where ChemDraft drew them,
  in ring B, the larger ring, reports them as `STILL ON A FILL`, and
  places the B letter clear of them.
- **Morphine.** C13 belongs to four rings, and the ethanamine bridge
  (C15–C16) has to pass a ring to reach the nitrogen. In the chosen
  layout the C15–C16 bond crosses the C9–C10 bond once, the piperidine
  (D) covers the lower part of ring B, whose letter shrinks to 12 px in
  the strip left above it, and the bridge bonds are drawn 1.4 times
  standard length. ChemDraft's own two layouts scored worse: one crushed
  the piperidine across ring B with several crossings, the other drew it
  wholly inside ring B.

## 12. A hand-sketched structure: penicillin G

The sketch effect draws rough strokes of uneven weight over the bonds; a
handwriting label font and a sketched circle finish the look. The one
real hazard is that the rough stroke runs down the middle of a hashed
bond, so the hash can read as solid. This recipe widens and spaces the
stereo bonds and also writes an unsketched copy. Structure from PubChem
CID 5904 (Penicillin G, C16H18N2O4S):

```sh
node -e "fetch('https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/5904/property/Title,MolecularFormula,SMILES/JSON').then(r=>r.json()).then(j=>{const p=j.PropertyTable.Properties[0]; console.log(p.CID,p.Title,p.MolecularFormula,p.SMILES); require('node:fs').writeFileSync(require('node:path').join(process.argv[1],'penicillin-g-job.json'),JSON.stringify([{name:'penicillin-g',smiles:p.SMILES}]));})" "$scratch"
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft document --batch "$scratch/penicillin-g-job.json" --out-dir "$scratch" > "$scratch/penicillin-g-build.jsonl"
```

In PowerShell, capture the `document` output as UTF-8:

```powershell
[Console]::OutputEncoding = [Text.Encoding]::UTF8
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft document --batch "$scratch/penicillin-g-job.json" --out-dir "$scratch" | Set-Content -Encoding utf8 "$scratch/penicillin-g-build.jsonl"
```

Save this as `penicillin-sketch.mjs` in the scratch directory:

```js
// node penicillin-sketch.mjs <scratch>: rough strokes, handwriting labels, a sketched circle and caption,
// plus an unsketched copy for when the stereochemistry must be unambiguous.
import fs from "node:fs";
import path from "node:path";
const dir = process.argv[2];
const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8").replace(/^\uFEFF/, ""));
const build = read("penicillin-g-build.jsonl");
const doc = read("penicillin-g.json");
const page = doc.pages[0];
const mol = page.objects.find((o) => o.type === "molecule");
const ink = "#1f2a44", red = "#c0392b", hand = "Bradley Hand, Segoe Print, Comic Sans MS, cursive";
// Uneven, tapering stroke weight gives the hand-drawn look; the seed
// fixes the wobble so re-renders match.
mol.style.visualEffects = [{ kind: "sketch", roughness: 1.25, bowing: 1, seed: 7, color: ink }];
Object.assign(mol.style, { bondColor: ink, atomLabelColor: ink, atomLabelFontFamily: hand, atomLabelFontSizePx: 16 });
// Wide, well-spaced hashes and wide wedges stay readable under the rough strokes.
const stereo = mol.bonds.filter((b) => b.display?.bondStyle === "wedge" || b.display?.bondStyle === "hashed").map((b) => b.id);
mol.style.bondBoldWidths = Object.fromEntries(stereo.map((id) => [id, 12]));
mol.style.bondHashSpacings = Object.fromEntries(stereo.map((id) => [id, 8]));
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
// The same figure without the rough strokes: every wedge and hash drawn clean.
mol.style.visualEffects = [];
fs.writeFileSync(path.join(dir, "penicillin-g-clean.json"), JSON.stringify(doc));
```

```sh
node "$scratch/penicillin-sketch.mjs" "$scratch"
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft render-document --document "$scratch/penicillin-g-sketch.json" --out "$scratch/penicillin-g-sketch" --format both --width 1200
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft render-document --document "$scratch/penicillin-g-sketch.json" --out "$scratch/penicillin-g-sketch.chemdraft"
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft render-document --document "$scratch/penicillin-g-clean.json" --out "$scratch/penicillin-g-clean.png" --width 1200
```

Verified: the reported canonical SMILES equals the source's (InChIKey
`JGSARLDLIJGVTE-MBNYWOFBSA-N`), with 3 specified stereocentres. The 1
unspecified centre is the bridgehead N, which the plain `render` and
`stereo` report the same way; do not add stereo to it.

Then look at every wedge and hash in the sketched PNG at full size. The
C–S and C–N wedges read as wedges, and the hashed C–CO2H bond shows its
wide ticks with a rough line running through them ([art](art.md), Known
limits). Uneven or tapering plain bonds are expected and fine; if a hash
reads as solid, try another `seed` and look again. Deliver the sketch
with `penicillin-g-clean.png` alongside, and offer the clean one wherever
the stereochemistry must be unambiguous (an exam, a key, a paper). Fonts
are per machine; if neither handwriting font is installed, the generic
`cursive` font is used.
