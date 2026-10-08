# Predicted NMR shifts and spectra

NMR (nuclear magnetic resonance) spectra describe nuclei in their chemical
environments. `nmr` / MCP `predict_nmr` predicts ¹H and ¹³C chemical shifts
from the separate NMR Shift Predictor plugin. This is the OCL-native
provider using HOSE-fragment statistics from NMRShiftDB2 experimental
assignments. HOSE codes describe progressively larger atom neighborhoods.
The shipped provider must not be described as synthetic or fixture-backed.

## Plugin and trust

Set `CHEMDRAFT_NMR_PLUGIN_DIR` to `<plugin-checkout>`; configure an explicit
absolute path for portable setups rather than relying on the source's default
directory. This repository does not bundle the external plugin.
Its directory must be listed under `org.chemdraft.nmr.predictor` in the
owner's trust file. An environment variable alone grants nothing.
See [setup](setup.md) for exact locations on both OSes. **Never create or
edit the trust file as an agent. Show the entry the refusal prints.**
The plugin must export the required grouping, diastereotopic-disclosure and
truthful-spectrum-caption capabilities; older checkouts are refused.

## Options

| CLI flag | Meaning / default |
|---|---|
| `--smiles` | Single structure, exclusive with batch |
| `--batch` | JSON array of `{name, smiles}` jobs |
| `--name` | Single result name, default `structure` |
| `--nuclei` | Comma-separated `1H`, `13C`; default both |
| `--spectrum` | Single `.svg` or `.png`; optional |
| `--spectrum-dir` | Batch spectrum directory; optional |
| `--spectrum-format` | Batch `svg` (default) or `png` |
| `--width` | PNG width, default 1280; keep within 16–4000 |
| `--statistic` | Shift statistic `median` (default) or `mean` |
| `--ignore-labile` | Omit exchangeable O-H, N-H, S-H protons; default false |
| `--help` | Print help |

With both nuclei, single spectra get `-1H` / `-13C` suffixes. Batch files
are `<name>-<nucleus>.<format>`. ¹³C predictions are proton-decoupled
singlets; ¹³C multiplicity is `null` and J list is empty in CLI JSON.
MCP accepts `smiles`, `nuclei` array, `spectrum` boolean, `statistic`,
`ignoreLabileHydrogens`; spectra requested through MCP are PNG.

```sh
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft nmr --smiles 'CCO' --nuclei '1H,13C' --ignore-labile --statistic median --spectrum "$scratch/predicted-ethanol.svg"
```

## What the numbers are

- Shifts are predictions from HOSE-fragment lookup over NMRShiftDB2-derived
  statistics, not measurements. `source: "hose-fragment"` is a database
  match; `source: "rule-estimated"` is a disclosed additive-rule estimate
  only where the rule applies, flagged `NMR_RULE_ESTIMATED`.
- ¹H multiplicity and J couplings are first-order estimates from bond
  topology, labelled `estimated: true`; they are not measured values.
  J is a coupling in hertz; shift is in parts per million (`shiftPpm`).
- `nEquivalent` and spectrum stick height mean predicted equivalent nuclei,
  not integration. Line shape and field, where shown in plugin simulations,
  are simulation parameters. The CLI exposes stick spectra, with no line
  shape or field controls.
- No shift is invented for an unmatched environment. Omitted environments
  retain `NMR_NO_FRAGMENT_MATCH` / `NMR_PARTIAL_PREDICTION` warnings.
  Applicable rule estimates remain disclosed estimates, not database matches.
- No confidence percentages. Keep thin-match warnings and honest tiers;
  do not fabricate accuracy or remove a warning because the image looks tidy.
- Atoms equivalent by constitution are grouped in one resonance, counted
  by `nEquivalent`. They may differ in a molecule with a stereocenter:
  two hydrogens on CH₂ or two methyl groups on one carbon can be
  diastereotopic (chemically different because of stereochemistry).
  The predictor keeps one shift and warns
  `NMR_POTENTIALLY_DIASTEREOTOPIC_HYDROGENS` or
  `NMR_POTENTIALLY_DIASTEREOTOPIC_METHYLS`. Do not invent split shifts.
- The reference derivative database has the **nmrshiftdb2 Database License
  (ODbL-derived: attribution and share-alike)**, separate from the code
  licence. Each result names it under `database`; retain attribution.
  Never describe the whole data-bundling package as MIT.

`atomIndices` are 0-based indices into the drawn molfile depiction. For
¹H they identify the atoms carrying those hydrogens. Preserve the JSON
mapping beside a labelled structure when explaining environments.

## Comparing with experiment

Place the prediction next to the experimental spectrum with a clear
**Predicted** label and its method/data provenance. Compare per environment,
retaining the user's experimental conditions and assignments. Never move
predicted shifts, alter the input structure, or choose another statistic
merely to fit the experimental trace. Describe differences and limitations.
Omitted environments stay omitted; grouped potentially diastereotopic
environments keep their warning. An incomplete prediction is still incomplete
when placed in an attractive handout. Keep experimental integration separate
from predicted stick height.
