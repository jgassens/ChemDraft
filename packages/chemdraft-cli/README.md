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
Query bonds (for example `C~CO`, or MOL bond type 8) are refused before MOL identity verification:
matching query SMILES cannot establish a chemical bond order. The failure names the affected bonds.

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

## document

Build the same editable native document that `render` depicts, as plain JSON with
`schema: "chemdraft.document.v1"`. This is the starting point for styled figures without the GUI.

~~~bash
pnpm -s chemdraft document --smiles 'C1CCC2CCCCC2C1' --out decalin.json
pnpm -s chemdraft document --batch jobs.json --out-dir documents
~~~

Batch jobs use the usual `{ "name": "decalin", "smiles": "C1CCC2CCCCC2C1" }` shape.
`--bond-length <px>` defaults to 28, just as `render` does. The JSON result contains `document`
(the host path), `files`, `pages` (id, width, height), and `molecules`. Each molecule reports
`objectId`, `pageId`, atoms (`id`, `element`, `x`, `y`, `inputAtomIndex`), bonds (`id`, `fromAtomId`,
`toAtomId`, `order`, `display`), and rings (`ringKey`, `atomIds`, `bondIds`, `center: {x,y}`, `size`).
Coordinates and ring centers are in page pixels. Ring keys are sorted bond ids joined by `|`;
use the reported keys instead of guessing them. Atom and bond ids are local to their molecule.

`inputAtomIndex` is the 0-based atom token index in the supplied SMILES, including separately
written H tokens. It is verified against RDKit's parse order and the depicted graph; unavailable
mappings (including OCL fallbacks) are `null` with a warning. Existing depiction removes ordinary
separately written hydrogen atoms: `[H]OC([H])([H])C` produces O, C, C with indices 1, 2, 5,
and no H objects. This command does not force hydrogens into the depiction.

## render-document

Render a styled native JSON document or a desktop `.chemdraft` envelope through the same native
loader and SVG exporter as the app. It supports ring interiors, ring letters supplied as text
objects, bold/hashed/wedge bond displays, per-bond/per-atom style maps, sketch visual effects,
text, and art objects to the extent supported by the existing exporter.

~~~bash
pnpm -s chemdraft render-document --document styled.json --out figure.svg
pnpm -s chemdraft render-document --document styled.json --out figure --format both
pnpm -s chemdraft render-document --document styled.json --out figure.pdf
pnpm -s chemdraft render-document --document styled.json --out figure.chemdraft
pnpm -s chemdraft render-document --document figure.chemdraft --out reopened.png
~~~

`--format svg|png|pdf|chemdraft|both` normally infers the extension; `both` writes SVG and PNG.
`--width <px>` (16–4000, default 600), `--background white|transparent` (default white), and
`--padding <px>` (default 24) control SVG/PNG output. PDF uses the native first-page size;
width, background and padding do not change PDF or native saves. SVG, PNG and PDF render only
the first page and warn when more pages exist. `.chemdraft` retains the complete native document
using the desktop's CDXML envelope codec, including style data the visible compatibility layer
may approximate.

The input read is capped at 5 MB before parsing. Limits are 100 pages, 2000 objects per page,
500 heavy atoms per molecule, and 2000 total atoms / 4000 bonds per molecule. Output filenames
use the existing portable batch-name policy; parent traversal and Windows device names are
refused. Parent directories, absolute paths and spaces in paths are supported.

The result has `files`, `molecules` (`objectId`, `canonicalSmiles`, `stereoCenters`,
`unspecifiedStereoCenters`, `unspecifiedDoubleBonds`, `exportWarnings`), `warnings` (messages),
and `exportWarnings` (code, message, severity and object id where applicable). Canonical SMILES
is regenerated from current atoms and bonds. Source-only unknown E/Z flags are retained only
when the regenerated connection table matches the stored one; otherwise a warning records
that reported double-bond stereo follows edited coordinates. Compare it with
the build result after styling; editing wedge/hashed stereo displays can change chemistry.
All exporter warnings are retained, including `export.svg.graphic_fallback` and
`export.svg.graphic_effect_approximation`. Unknown art gets the exporter placeholder; the native
reflection effect is omitted with a warning. Existing format limitations are not repaired by this
command. Invalid JSON, schema violations, input limits and unsafe destinations exit 2; rendering
or chemistry failures return `ok:false` and exit 1. Success exits 0.

For example, after building decalin, edit its JSON using the returned ring key and center:

~~~js
const molecule = document.pages[0].objects.find(object => object.type === "molecule");
molecule.style.ringStyles = {
  [ring.ringKey]: { fillColor: "#ffcc66", fillOpacity: 0.4 }
};
molecule.bonds.find(bond => bond.id === ring.bondIds[0]).display = { bondStyle: "bold" };
molecule.style.visualEffects = [{ kind: "sketch", seed: 42, roughness: 1.3 }];
document.pages[0].objects.push({
  id: "ring-letter", type: "text", text: "A", spans: [],
  x: ring.center.x - 6, y: ring.center.y - 9, width: 12, height: 18,
  rotation: 0, style: { fontSize: 18 }
});
~~~

Here `document` is the parsed output file and `ring` is a ring from the build result.
The full native style and art schemas are defined in `packages/chem-core/src/schemas.ts`.

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

### Plugin trust file

The plugin is code from outside this repository, and it runs in-process with the CLI's full
privileges (and inside the long-lived MCP server, which calls the same command). So the directory
must also be listed in a trust file the owner edits by hand,
`~/.config/chemdraft/trusted-plugins.json`:

~~~json
{
  "version": 1,
  "trustedPlugins": [
    { "id": "org.chemdraft.nmr.predictor", "dir": "/Users/you/programming/chemdraft-nmr-plugin" }
  ]
}
~~~

Why the environment variable alone is not enough: anyone who can set `CHEMDRAFT_NMR_PLUGIN_DIR`
could otherwise point the CLI at any directory and have its `src/index.ts` executed.
`CHEMDRAFT_NMR_PLUGIN_DIR` now only chooses among trusted directories. For the same reason the trust
file's location cannot be changed by an environment variable or a flag, and nothing in the CLI
creates or edits it. Its default location is resolved from the **OS account's home directory**
(`os.userInfo().homedir` — the passwd entry for the effective uid on POSIX, the profile-directory
lookup on Windows), never from `os.homedir()`, `HOME`, or `USERPROFILE`: whoever can set
`CHEMDRAFT_NMR_PLUGIN_DIR` could otherwise also set `HOME` and point the CLI at an allow-list of
their own choosing. If the account's home directory cannot be determined, there is no default — the
CLI refuses every plugin directory with a clear error rather than falling back to the environment.
When a directory is refused, the error names the trust file, the resolved directory, and the exact
entry to add.

Honest limit: this closes the `HOME` route specifically. A caller who controls the process
environment more broadly can still make Node itself run arbitrary code — for example through
`NODE_OPTIONS` — regardless of what this trust file does. The allow-list guards against a wrong or
hostile *plugin directory*; it is not a defense against a hostile *process environment*.

Loading runs in this order (`src/pluginTrust.ts`), and each step stops the load before the next:

1. **Allow-list**, before any plugin file is imported. The trust file is parsed strictly (an unknown
   `version`, unknown keys, relative `dir`, or malformed JSON is refused). The requested directory
   and each listed `dir` are compared by real path, so symlinks to a trusted checkout work; the
   entry (`src/index.ts`) and manifest (`src/manifest.ts`) must also resolve inside the trusted
   directory, so a symlinked file cannot escape it.
2. **Manifest and permissions.** Only `src/manifest.ts` is imported, and its `nmrPredictorManifest`
   export is validated by `@chemdraft/plugin-host`. Its id must be `org.chemdraft.nmr.predictor`,
   and it must not declare any permission the CLI refuses (`document.write`, `filesystem.read`,
   `filesystem.write`, `network.fetch`, `native.execute`, `model.load`, `model.download`,
   `clipboard.read`, `clipboard.write`, `image.read`). This checks what the plugin declares, not what
   its code does; the allow-list is what bounds execution.
3. **Entry.** Only then is `src/index.ts` imported and its exports checked.

The checkout must export `NMR_PLUGIN_CAPABILITIES` with `constitutional-equivalence-grouping`,
`diastereotopic-disclosure`, and `truthful-spectrum-caption`. Older checkouts are refused; update
the checkout (`git pull`) or set `$CHEMDRAFT_NMR_PLUGIN_DIR` to a current one.

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
