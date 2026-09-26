# @chemdraft/chemdraft-cli

chemdraft is the shared command-line entry point for headless ChemDraft workflows. Always call
pnpm -s chemdraft ...; -s keeps stdout pure JSON. The package is private and its source modules
are intended for workspace tools that need the same document and rendering path.

## Common contract

Commands write machine-readable JSON lines to stdout and human-readable progress to stderr. A
successful line has ok: true, a name, command inputs, command outputs, and warnings: []; a failed
line has ok: false, its identifying inputs, and an error string. Commands exit 0 when all jobs
succeed, 1 when any attempted job fails, and 2 when arguments or batch input are invalid.

Batch files are JSON arrays of named jobs. Names are trimmed and must match
^[A-Za-z0-9][A-Za-z0-9 _-]{0,99}$; names must be unique without regard to case. A batch may contain
at most 500 jobs. Empty input is rejected; chemical input is limited to 5000 characters and 500
heavy atoms. PNG output is limited to a width of 16–4000 pixels.

Every chemical file export is checked so that the canonical SMILES written equals the input's; if it
does not, the job fails.

## render

Render one SMILES string or a JSON batch to cropped SVG, PNG, or both.

~~~bash
pnpm -s chemdraft render --smiles 'CCO' --out ethanol.svg
pnpm -s chemdraft render --smiles 'CCO' --out ethanol --format both
pnpm -s chemdraft render --batch jobs.json --out-dir rendered --format both
~~~

Batch input is a JSON array of {"name":"aspirin","smiles":"CC(=O)Oc1ccccc1C(=O)O"}. Names are
trimmed; blank/duplicate names, path separators, and names beginning with a dot are rejected.

Options: --width <px> is the PNG width (16–4000, default 600); --background white|transparent
defaults to white; --bond-length <px> defaults to 28 (the desktop paste value); --padding <px>
defaults to 24; and --format png|svg|both normally infers the extension in single mode. One JSON
line per structure is written to stdout and progress to stderr. stereoCenters counts specified
centers; unspecifiedStereoCenters counts constitutional centers without a specified descriptor;
unspecifiedDoubleBonds counts unknown E/Z double bonds. Exit 0 is used when every structure
succeeds, 1 when any render fails, and 2 for bad arguments.

## grid

Render a named SMILES batch as one multiple-choice PNG or SVG grid. Every entry is validated before
the image is written; a bad SMILES fails the entire grid.

~~~bash
pnpm -s chemdraft grid --batch jobs.json --out questions.svg --columns 2 --labels letters
~~~

Batch input is a JSON array of {"name":"aspirin","smiles":"CC(=O)Oc1ccccc1C(=O)O"}. Options:
--columns <N> (default automatic), --labels none|letters|names (default letters), --width <px>
(PNG width, default 600; ignored for SVG), --gutter <px> (default 32), --padding <px> (default 24),
and --background white|transparent (default white). One JSON result line is written to stdout and
progress to stderr. Exit 0 is used on success, 1 when the grid cannot be rendered, and 2 for bad
arguments.

## reaction

Render a reaction scheme as PNG or SVG.

~~~bash
pnpm -s chemdraft reaction --rxn 'CC(=O)O.OCC>OS(=O)(=O)O>CC(=O)OCC' --out ester.png
pnpm -s chemdraft reaction \
  --reactant '[Na+].[O-]C(=O)C' --agent 'OS(=O)(=O)O' --product 'CC(=O)O' \
  --out scheme.svg
~~~

Reaction SMILES must contain exactly two > separators. Each side is split on ., so a dot-joined
salt is drawn as two species. Repeated --reactant/--agent/--product flags preserve each value as one
molecule object, including dot-joined salts. Agents are validated and shown above the arrow as
composition formulas, falling back to SMILES only when composition fails; --conditions appends text
there. Agent formulas carry net ionic charge as a superscript; hydroxide is written OH⁻. Carbon-free
formulas use conventional written order rather than strict Hill order (H2SO4, HCl, NH3); each
exact Hill formula is kept in agentTexts[].hillFormula. Species, plus signs, and the arrow use
24 px gutters.

Batch jobs contain either rxn or reactants/agents/products arrays. Array entries preserve . as one
molecule object. Each job may supply out; otherwise --out-dir is required and files are named from
the job name (PNG by default). Options: --conditions <text>; --arrow
forward|equilibrium|resonance|retrosynthesis (default forward); --width <px> (default 1000);
--background white|transparent (default white); --out-dir <dir>; and --format <kind> for batch
output when jobs omit out (default png). One JSON line per reaction is written to stdout and
progress to stderr. Exit 0 is used when every reaction succeeds, 1 when any render fails, and 2
for bad arguments.

## analyze

Analyze SMILES with ChemDraft's property and prediction suite.

~~~bash
pnpm -s chemdraft analyze --smiles 'CC(=O)Oc1ccccc1C(=O)O'
pnpm -s chemdraft analyze --batch jobs.json --methods rdkit.composition,rdkit.crippen-logp
~~~

--smiles <SMILES> analyzes one structure. --batch <file> analyzes a JSON array of
{"name":"...","smiles":"..."} jobs. --methods <id,id> runs only the comma-separated method ids.
--format json|md|text defaults to json; --out <file> writes a single job's JSON or rendered report
to a file. Every job emits one JSON result line. For md/text without --out, the rendered report is
carried in that line's report field so stdout remains valid JSON Lines.

The summary object reports the drawn (source) structure where a method ran on it. When a method ran
only on a derived interpretation - the pKa ladder is built on the reference protomer, with every
removable formal charge removed - its field carries interpretationId and interpretationLabel, and
per-site atomIndex is mapped back to the 0-based atom of the drawn SMILES (derivedAtomIndex keeps
the index in the derived form). not-requested means the method was not run at all.

## name

Convert a chemical name with the bundled OPSIN runtime, optionally rendering the result.

~~~bash
pnpm -s chemdraft name --name '2-acetoxybenzoic acid' --render aspirin.png
pnpm -s chemdraft name --batch names.json
~~~

Batch input is a JSON array of {"name":"aspirin","query":"2-acetoxybenzoic acid"}. Names are
trimmed, must match /^[A-Za-z0-9][A-Za-z0-9 _-]{0,99}$/, and must be unique without regard to case.
--name <name> converts one chemical name; --batch <jobs.json> converts named queries; --render
<out.png> renders a single successful result to PNG; and --allow-ambiguous returns OPSIN's result
for an ambiguous name. One JSON line per query is written to stdout and progress to stderr. Exit 0
is used when every query succeeds, 1 when any conversion or render fails, and 2 for bad arguments.

## stereo

Inspect tetrahedral R/S centres and double-bond E/Z geometry.

~~~bash
pnpm -s chemdraft stereo --smiles 'C/C=C/C'
pnpm -s chemdraft stereo --batch jobs.json
~~~

--smiles <SMILES> inspects one structure; --batch <jobs.json> inspects a JSON array of
{"name":"alanine","smiles":"C[C@H](N)C(=O)O"} jobs. Atom and bond indices are 0-based molfile
order. Tetrahedral centres and stereogenic double bonds are reported separately; constitutionally
stereogenic units without a descriptor count as unspecified. One JSON line per structure is written
to stdout and progress to stderr. Exit 0 is used when every structure succeeds, 1 when any structure
fails, and 2 for bad arguments.

## nmr

Predict ¹H/¹³C shifts using the separately checked-out ChemDraft NMR predictor plugin.

~~~bash
pnpm -s chemdraft nmr --smiles 'CCO' --nuclei 1H,13C --spectrum ethanol.svg
pnpm -s chemdraft nmr --batch jobs.json --spectrum-dir spectra --spectrum-format png
~~~

Options: --nuclei <list> (comma-separated nuclei, 1H and/or 13C, default 1H,13C); --name <name>
(default structure); --spectrum <file.svg|.png> (single mode; multiple nuclei use -1H/-13C
suffixes); --spectrum-dir <dir> (batch naming <dir>/<name>-<nucleus>.<format>);
--spectrum-format svg|png (default svg); --width <px> (default 1280); --statistic median|mean
(default median); and --ignore-labile (omit exchangeable O-H, N-H and S-H protons). The plugin is
loaded from $CHEMDRAFT_NMR_PLUGIN_DIR (default: ~/programming/chemdraft-nmr-plugin). It is a
separate repository and is not bundled here.

What the numbers are:
  - Shifts come from HOSE-fragment lookup over statistics derived from NMRShiftDB2 experimental
    assignments. They are predictions, not measurements. source "hose-fragment" is a database
    match; source "rule-estimated" is a disclosed additive-rule estimate, emitted only where the
    rule applies and always flagged by an NMR_RULE_ESTIMATED warning.
  - 1H multiplicity and J are first-order estimates from bond topology. They are labelled
    estimated ("estimated": true) and are never measured values.
  - nEquivalent (and stick height in the spectrum) is the predicted number of equivalent nuclei.
    It is not an integration.
  - No shift is ever invented for an unmatched environment: it is omitted and a warning
    (NMR_NO_FRAGMENT_MATCH / NMR_PARTIAL_PREDICTION) says so.
  - No confidence percentages are reported; thin matches carry warnings instead.
  - Atoms the predictor finds equivalent by constitution are reported as one resonance;
    nEquivalent counts them. Where such atoms may still differ because the molecule has a
    stereocenter (the two H of a CH2, or two methyls on one carbon), they stay one resonance
    with one shift and an NMR_POTENTIALLY_DIASTEREOTOPIC_HYDROGENS or
    NMR_POTENTIALLY_DIASTEREOTOPIC_METHYLS warning says so.
  - The reference database is a derivative database under the nmrshiftdb2 Database License
    (ODbL-derived: attribution, share-alike). That licence is separate from the code licence;
    each result line names it under "database".

One JSON line per structure is written to stdout and progress to stderr. atomIndices are 0-based
indices into the drawn structure (the molfile ChemDraft depicts from the SMILES); for 1H they are
the atoms carrying the hydrogens. Exit 0 is used when every structure succeeds, 1 when any fails,
and 2 for bad arguments.

## export

Export one SMILES string or a JSON batch to CDXML, PDF, SDF, MOL, or SMILES.

~~~bash
pnpm -s chemdraft export --smiles 'CC(=O)Oc1ccccc1C(=O)O' --out aspirin.cdxml
pnpm -s chemdraft export --batch jobs.json --out-dir mols --format mol
pnpm -s chemdraft export --batch jobs.json --out combined.sdf --format sdf
~~~

Batch input is a JSON array of {"name":"aspirin","smiles":"CC(=O)Oc1ccccc1C(=O)O"}. Names are
trimmed; blank/duplicate names, path separators, and names beginning with a dot are rejected.
--format sdf and --format smi combine every batch structure into one file written to --out. Every
other format writes one file per structure into --out-dir, named <job name>.<extension>.
--format cdxml|pdf|sdf|mol|smi selects the output format; in single mode it normally infers it from
--out. One JSON line per structure is written to stdout and progress to stderr. Exit 0 is used when
every structure succeeds, 1 when any export fails, and 2 for bad arguments.
