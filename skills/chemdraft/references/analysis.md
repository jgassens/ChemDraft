# Properties and prediction suite

Contents: calling analysis; statuses; interpretations; method catalog;
pKa; m/z and isotope envelope; reporting.

## Calling analysis

`analyze` and MCP `analyze_structure` call the same property suite. One
RDKit parse supplies the source composition, charge, masses and descriptors;
methods needing other forms use named derived interpretations. Do not
re-decide hydrogens, valence or aromaticity in a second chemistry engine.

| CLI flag | Meaning / default |
|---|---|
| `--smiles` | One SMILES; exclusive with batch |
| `--batch` | JSON array of `{name, smiles}` jobs |
| `--methods` | Comma-separated IDs; omitted runs all registered methods |
| `--format` | `json` (default), `md`, `text` |
| `--out` | Single job's JSON or report file; forbidden with batch |
| `--help` | Help |

MCP takes `smiles`, optional `methods` array, and `format: "json"` or
`"md"`. It has no text-format or batch parameter. Use CLI for batches.

```sh
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft analyze --smiles 'CC(=O)O' --format md --out "$scratch/acetic-acid.md"
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft analyze --smiles 'CCO' --format text --out "$scratch/ethanol.txt"
```

Without `--out`, md/text reports are in the JSON line's `report` field;
stdout remains JSON Lines. JSON format includes `run`, with full results,
interpretations and engine provenance. Reports contain values, Not computed
sections, conventions, methods and provenance; keep those with quoted numbers.

## Summary and statuses

`summary` has fields `formula`, `monoisotopicMass`, `averageMass`,
`canonicalSmiles`, `inchiKey`, `logP`, `tpsa`, `hbd`, `hba`,
`rotatableBonds`, `pka`. Each is `{value, status}`, optionally `reason`
and derived interpretation fields. A missing value is `null`, not zero.
Many suite methods appear only in `run.results`, not in the summary.

| Status | How to read it |
|---|---|
| `ok` | Computed result |
| `partial` | Some values available; retain omissions and warnings |
| `unsupported` | Outside method support; not computed |
| `not-applicable` | Method does not apply; not computed |
| `failed` | Runtime/computation failure; not computed |
| `cancelled` | Cancelled; not computed |
| `timed-out` | Time limit reached; not computed |
| `not-requested` | Summary only: method was not run |

Only `ok` and `partial` statuses carry payloads. A successful job can still
contain declined methods. Give the reason from `reason` or the full result's
`applicability.reasons`, and distinguish it from a method never requested.

## Named interpretations

Composition, charge and masses describe the source **as drawn**, including
counterions. Derived forms have their own `interpretationId`, label,
transformation ledger and atom mapping in `run.interpretations`.
The suite can offer largest-organic-fragment, neutralized,
reference-protomer and reference-tautomer interpretations where appropriate;
the CLI has no flag for choosing an interpretation override.
The source decline remains present alongside a derived result. Sodium
benzoate must not silently become benzoic acid.

The summary prefers a source result, even a source decline. If a method
runs only on a derived form, its summary carries `interpretationId` and
`interpretationLabel`. For pKa, `atomIndex` maps to the drawn structure's
0-based atom; it can be `null` when there is no source counterpart.
`derivedAtomIndex` retains the derived form's index. Do not confuse the two.

## Method catalog

These are the IDs composed by `rdkitAnalysisContracts()` and accepted by
`--methods`. A listed method can decline; inclusion is not a promise of a
number for every molecule. Counts and descriptors follow the conventions
on each result, including the ring and rotatable-bond definitions.

| ID | Meaning |
|---|---|
| `rdkit.composition` | Formula, components, formal charge, isotope/radical composition |
| `rdkit.average-mass` | Mass using engine standard atomic weights |
| `rdkit.monoisotopic-mass` | Most-abundant-isotope mass, respecting explicit labels |
| `rdkit.inchi` | Standard InChI structure identifier |
| `rdkit.inchikey` | Compact hashed InChI identifier |
| `rdkit.canonical-smiles` | Engine canonical SMILES |
| `rdkit.crippen-logp` | Wildman–Crippen estimated octanol/water partition logP |
| `rdkit.crippen-mr` | Crippen molar refractivity estimate |
| `rdkit.tpsa` | Ertl topological polar surface area; keep returned S/P convention |
| `rdkit.rotatable-bonds` | Rotatable-bond count under the returned definition |
| `rdkit.hbd` | Hydrogen-bond donor count |
| `rdkit.hba` | Hydrogen-bond acceptor count |
| `rdkit.lipinski-hbd` | Lipinski donor count |
| `rdkit.lipinski-hba` | Lipinski acceptor count |
| `rdkit.heavy-atom-count` | Atoms other than hydrogen |
| `rdkit.heteroatom-count` | Atoms other than carbon and hydrogen |
| `rdkit.amide-bond-count` | Amide bonds under the engine pattern definition |
| `rdkit.fraction-csp3` | Fraction of carbon atoms that are sp³ |
| `rdkit.ring-count` | Rings under the engine ring convention |
| `rdkit.aromatic-ring-count` | Aromatic rings |
| `rdkit.aliphatic-ring-count` | Aliphatic rings |
| `rdkit.saturated-ring-count` | Saturated rings |
| `rdkit.heterocycle-count` | Rings containing a heteroatom |
| `rdkit.aromatic-heterocycle-count` | Aromatic heterocycles |
| `rdkit.saturated-heterocycle-count` | Saturated heterocycles |
| `rdkit.aliphatic-heterocycle-count` | Aliphatic heterocycles |
| `rdkit.spiro-atom-count` | Atoms joining rings at one shared atom |
| `rdkit.bridgehead-atom-count` | Bridgehead atom count |
| `rdkit.atom-stereocentre-count` | Potential atom stereocentres |
| `rdkit.unspecified-atom-stereocentre-count` | Atom stereocentres without specified configuration |
| `rdkit.labute-asa` | Labute approximate surface area |
| `rdkit.hall-kier-alpha` | Hall–Kier atom correction index |
| `rdkit.kappa1` | First Kier shape index |
| `rdkit.kappa2` | Second Kier shape index |
| `rdkit.kappa3` | Third Kier shape index |
| `rdkit.phi` | Kier flexibility index |
| `rdkit.chi0n`, `rdkit.chi0v` | Order-0 simple / valence connectivity index |
| `rdkit.chi1n`, `rdkit.chi1v` | Order-1 simple / valence connectivity index |
| `rdkit.chi2n`, `rdkit.chi2v` | Order-2 simple / valence connectivity index |
| `rdkit.chi3n`, `rdkit.chi3v` | Order-3 simple / valence connectivity index |
| `rdkit.chi4n`, `rdkit.chi4v` | Order-4 simple / valence connectivity index |
| `rdkit.mz.M+H` | Protonated neutral molecule m/z |
| `rdkit.mz.M+Na` | Sodium adduct m/z |
| `rdkit.mz.M+K` | Potassium adduct m/z |
| `rdkit.mz.M+NH4` | Ammonium adduct m/z |
| `rdkit.mz.M+2H` | Doubly protonated ion m/z |
| `rdkit.mz.M-H` | Deprotonated ion m/z |
| `rdkit.mz.M+Cl` | Chloride adduct m/z |
| `rdkit.mz.M+HCOO` | Formate adduct m/z |
| `rdkit.mz.M-2H` | Doubly deprotonated ion m/z |
| `rdkit.mz.M+H-H2O` | Protonated-ion position after hypothetical water loss |
| `rdkit.mz.M+H-NH3` | Position after hypothetical ammonia loss |
| `rdkit.mz.M+H-CO` | Position after hypothetical carbon monoxide loss |
| `rdkit.mz.M+H-CO2` | Position after hypothetical carbon dioxide loss |
| `rdkit.mz.M+H-HCOOH` | Position after hypothetical formic acid loss |
| `rdkit.mz.M+H-CH3OH` | Position after hypothetical methanol loss |
| `rdkit.mz.M+H-HCl` | Position after hypothetical hydrogen chloride loss |
| `isospec.isotope-envelope` | Theoretical isotope distribution |
| `joback.normal-boiling-point` | Joback group-contribution boiling-point estimate |
| `joback.critical-temperature` | Joback critical-temperature estimate |
| `joback.critical-pressure` | Joback critical-pressure estimate |
| `joback.critical-volume` | Joback critical-volume estimate |
| `dimorphite.ionizable-sites` | Ionizable sites and predicted pKa transition ladders |

## pKa and intervals

pKa describes proton loss at a stated site/charge transition; a basic
site's pKa is that of its conjugate acid. The suite builds ordered
transitions on a reference protomer, removing removable formal charges;
that is a named derived interpretation, not a replacement of the drawing.
Per-site summary rows contain `atomIndex`, `siteType`, `transition`,
`acidCharge`, `basis`, `value`, `interval`, and sometimes `reason` and
`derivedAtomIndex`. All atom indices are 0-based.

`interval` is `{lower, upper}`, computed as the value minus/plus the
reported spread, or `null` if no value/spread is supplied. Quote the
predicted value **with those bounds**, the site, direction, charge state,
basis and interpretation. Do not call an interval an exact range of
physical truth or invent its confidence level. If a value has no interval,
say the interval is unavailable. If a site has `value: null`, report the
reason instead of filling it. Full ionization results carry additional
ladder/macroscopic information; do not equate a microscopic site value
with a molecule-wide experimental titration value.

## m/z and isotope envelopes

m/z means ion mass divided by the magnitude of its charge. Adduct and
neutral-loss positions use engine exact masses and electron bookkeeping.
The neutral-loss gate checks composition only; it does not predict that
the loss happens. Adduct methods decline for structures already carrying
net formal charge. Keep the observed peak's charge/adduct assignment and
the user's tolerance separate from the computed candidate position.
No fragmentation, collision-energy, MS/MS or observed-intensity claims.

The IsoSpec envelope is a **theoretical isotope distribution**, not a
predicted mass spectrum. Neutral positions are in daltons; a drawn ion's
positions are m/z (`thomson`) with electron correction and division by
absolute charge. Intensities are normalized to the base peak at 100.
The default relative threshold is 1e-4; retain the truncation and covered
probability disclosures. Explicit isotope labels are treated as certain
labels, not an enrichment percentage. Unsupported labels are declined.

Beside every reported envelope-derived number or image, disclose:
**IsoSpec built-in abundances: ¹³C 0.010788 versus CIAAW representative
0.0107, 0.82% relatively higher, raising M+1 by that fraction. The tables
have no upstream provenance; values are read from the shipped binary.**
CIAAW is the Commission on Isotopic Abundances and Atomic Weights.
Do not attach that abundance difference to RDKit exact-mass arithmetic,
which does not derive its mass positions from isotope abundance.

## Preserve method contracts

Each number needs its method ID/version, implementation and engine version,
interpretation, units, conventions, support scope and decline conditions.
JSON results carry `methodId`, `methodVersion`, `interpretationId`, units,
`conventions`, `classification`, `applicability`, `uncertainties`, citations
and datasets; `run.engines` identifies engines and artifact hashes.
The complete implementation/support contracts live in
[methods](../../../packages/rdkit-adapter/src/methods.ts),
[mass](../../../packages/rdkit-adapter/src/mass.ts),
[envelope](../../../packages/rdkit-adapter/src/envelope.ts),
[Joback](../../../packages/rdkit-adapter/src/joback.ts) and
[ionization](../../../packages/rdkit-adapter/src/ionization.ts).
Do not claim the JSON contains a separate full contract object.
Use md/text when handing a readable report to a human. Keep conventions
and provenance sections when a value points to them. Make no bare accuracy
claim: any figure needs its named validation partition and limitations.
