# Fast aqueous pKa baseline: structured error audit

Frozen 2026-08-08. This audit changes no model, feature, optimizer, loss, calibration, or training data. Its full per-record evidence is in [pka-fast-aqueous-error-audit.json](./pka-fast-aqueous-error-audit.json).

## Pre-registered failure definition

A record fails when the absolute value error is **strictly greater than 2.0 pKa units** on an exactly corresponding benchmark-assigned event, or when that assigned event is absent/unvalued on a state with validated atom correspondence. The report separately counts errors >3 and >5. Source results retain the supplied atom indices directly. A rewritten state is scored only when a separate validation copy preserves a unique V2000 atom map on every source index, preserves indexed elements and adjacency, and after map removal matches the unmarked scored canonical state; otherwise it is indeterminate. Approximate resonance matches are also indeterminate.

The experimental target is molecule-level. Its atom and acidic/basic assignment came from ChemAxon Marvin through QupKake, not from the experiment. Therefore “not reproduced” means disagreement with that assigned event, not proof that ChemDraft selected the chemically wrong event.

## Results

Assigned-event generation is reported as reproduced / not reproduced / unknown. MAE, RMSE, tails, and interval coverage are conditional on validated atom correspondence and an exact atom/transition match.

| set | assigned event T / F / unknown | exact n | MAE | RMSE | errors >2 / >3 / >5 | interval coverage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| novartis | 244 / 26 / 10 | 244 | 1.1521 | 1.7893 | 30 / 18 / 6 | 0.5246 |
| literature | 108 / 7 / 7 | 108 | 0.8008 | 1.8773 | 8 / 6 / 6 | 0.6759 |

Overall: 352 reproduced, 33 not reproduced, and 17 unknown; 352 conditional value comparisons; MAE 1.0443, RMSE 1.8168; 38/24/12 errors above 2/3/5; interval coverage 0.571. There are 71 registered failures and 17 indeterminate records.

This audit has 402 inputs rather than the legacy oracle evaluator's 398 predictions: the public SDFs contain 280 Novartis and 122 Literature rows, while oracle acid construction/re-writing omitted four Novartis basic rows. The product path accepts their supplied base drawings, so they remain here.

## Primary failure categories

| category | count |
| --- | ---: |
| bad-value-for-generated-assigned-event | 38 |
| benchmark-event-not-reproduced | 33 |

The requested decision buckets, including indeterminate chemistry, are:

| disposition evidence | count |
| --- | ---: |
| assignedEventNotReproduced | 33 |
| stateCorrespondenceUnresolved | 10 |
| assignedEventCorrespondenceApproximate | 7 |
| disputedOrIncompatibleLabels | 0 |
| assignedEventsWithheldOrUnvalued | 0 |
| badValuesForGeneratedSupportedEvents | 38 |

Denominator-based performance by assigned element and transition (all 402 inputs, not only failures):

| assigned stratum | assessed | event T / F / unknown | exact n | MAE | RMSE | errors >2 / >3 / >5 | interval coverage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| N-acidic | 57 | 50 / 3 / 4 | 50 | 1.8719 | 2.9781 | 15 / 10 / 4 | 0.44 |
| N-basic | 261 | 243 / 13 / 5 | 243 | 0.8721 | 1.3566 | 17 / 9 / 5 | 0.5761 |
| O-acidic | 70 | 59 / 4 / 7 | 59 | 1.0523 | 2.1437 | 6 / 5 / 3 | 0.661 |
| O-basic | 10 | 0 / 9 / 1 | 0 | — | — | 0 / 0 / 0 | — |
| S-basic | 4 | 0 / 4 / 0 | 0 | — | — | 0 / 0 / 0 | — |

Failure-only mechanism counts, used only alongside those denominators, are:

| assigned element-transition | failure mixture |
| --- | --- |
| N-acidic | bad-value-for-generated-assigned-event: 15; benchmark-event-not-reproduced: 3 |
| N-basic | bad-value-for-generated-assigned-event: 17; benchmark-event-not-reproduced: 13 |
| O-acidic | bad-value-for-generated-assigned-event: 6; benchmark-event-not-reproduced: 4 |
| O-basic | benchmark-event-not-reproduced: 9 |
| S-basic | benchmark-event-not-reproduced: 4 |

## Disposition

Different mechanisms dominate different strata. Retain the frozen baseline for its demonstrated core and abstain or flag outside those strata; resolve the unresolved state mappings and obtain experimental acid/base event truth before choosing a joint locator. Only targeted value-model work on exactly generated assigned events is justified, not general larger-regressor exploration.

The 71 registered failures are near-balanced overall (38 exact-event numerical misses versus 33 assigned-event nonreproductions), but the mixture reverses by transition: acidic has 21 value versus 7 event failures, while basic has 17 value versus 26 event failures. 10 rewritten-state records remain unresolved and 7 more have only approximate resonance correspondence. The benchmark event is Marvin-assigned rather than experimentally observed.

This applies the requested stop rule to the measured mixture. Do not resume general feature, optimizer, or loss exploration without tying the next experiment to the disposition above. Any unresolved state mapping must be cleared through the reaction-valid tautomer/protomer layer, and a locator replacement still requires experimental event truth rather than agreement with Marvin. Numerical misses on exactly generated assigned events justify only targeted value-model experiments in those strata.

## Limitations

- The benchmark site is assigned by ChemAxon Marvin, so a site disagreement is not known to be a ChemDraft event failure.
- The benchmark supplies one target per molecule and cannot establish whether additional reported events are false positives.
- The category assignment is deterministic triage, not manual chemical adjudication of the structures.
- The frozen product does not currently abstain by benchmark stratum; deployable abstention boundaries must be prospectively specified and validated rather than inferred from failure-only counts.

Training-family overlap and nearest radius-2 Morgan similarity are evidence only; they do not alter the frozen applicability contract or reclassify a numerical failure. “Source conflict” requires the same canonical acid/base event and a difference above the existing 0.5-unit corpus conflict threshold.

- The committed report contains canonical structures and derived results, not the source SDF/molblocks.
- Input hashes and the Python/RDKit preparation environment are recorded in the JSON.
- The 68% interval calibration was fitted on training folds; the conditional external coverage measured here is the relevant independent check.

## Reproduce

```bash
python packages/rdkit-adapter/vendor/pka-model/error_audit_prepare.py \
  <QupKake-data-dir> packages/rdkit-adapter/vendor/pka-model/merged-labels.json \
  /tmp/pka-error-audit-context.json
PKA_ERROR_AUDIT=1 \
PKA_ERROR_AUDIT_INPUT=/tmp/pka-error-audit-context.json \
PKA_ERROR_AUDIT_OUTPUT=docs/benchmarks/pka-fast-aqueous-error-audit.json \
PKA_ERROR_AUDIT_SUMMARY=docs/benchmarks/pka-fast-aqueous-error-audit.md \
pnpm vitest run packages/rdkit-adapter/src/pkaErrorAudit.real.test.ts
```
