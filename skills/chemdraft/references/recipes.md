# Worked recipes

Contents: workspace; question grid; stereochemistry; salt reaction; synthesis;
properties table; mass peak; NMR handout; names dataset; slides; human edits.

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

## 10. Human hand-edit loop via CDXML

```sh
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft export --smiles 'CC(=O)Oc1ccccc1C(=O)O' --out "$scratch/editable-aspirin.cdxml"
```

Have the human open this file in ChemDraft with File > Open, edit the
structure and save a native document. Review the final chemistry and obtain
updated SMILES before another headless render. This verified command creates
the handoff file; the human editing/desktop reopening step needs a hands-on
check on each platform. Do not automate editing through the testing bridge.
