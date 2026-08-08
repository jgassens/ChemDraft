# Prospective applicability protocol for the fast aqueous pKa baseline

**Status: DRAFT. Not in force. No evaluation set has been assembled, and §7's primary rule is unwritten.**

This document fixes the rule that decides when a pKa prediction is shown, and how, **before** the data that
rule will be judged on exists. It contains no code and mandates no model change. Once the evaluation set is sealed and
§7's rule is recorded, nothing in §3–§8 may change; a change invalidates the result and requires a new set.
§9 fixes how that order is enforced.

Companion records, all frozen: [product contract](./pka-fast-aqueous-product-contract.md),
[competitor benchmark](./pka-fast-aqueous-competitor-benchmark.md),
[error audit](./pka-fast-aqueous-error-audit.md).

---

## 1. Why this exists before any code

The shipped model reports a value and an interval for every site it finds. The interval is advertised as
covering 68% of errors. Measured:

| set | coverage against a nominal 68% |
| --- | ---: |
| OOF calibration corpus, where the curve was fitted | 67.6% |
| 398-row external development set | 57.3% |
| end-to-end audit, 352 exactly-corresponding events | 57.1% |
| N-acidic stratum of that audit | 44% |

So the number is roughly honest on corpus-like chemistry and materially over-confident elsewhere. **A wrong
value invites checking; a wrong error bar suppresses it.** The remedy is to show a validated interval only
where it is validated — which requires knowing where that is.

**The trap this document exists to avoid.** The only data that tells us where the interval fails is the
402-molecule audit. A threshold fitted to that audit is fitted to its own test. This project has already
made that error twice, and both are on the record:

- the forest blend appeared optimal near a 30% weight **chosen on the external set**; selected there it
  would have been overfitting the test, and on honest folds the best available gain was −0.0013;
- the interval was calibrated on internal folds and then reported as a general 68% guarantee.

`AGENTS.md` §9a records the general form: *a quantity validated conditional on one partition is not
validated conditional on another.* This protocol is the procedural answer to it.

**Everything in §1 is motivation, not evidence for any threshold below.** No number in §4 is derived from
the 402 molecules.

---

## 2. Scope

**In scope.** Whether a prediction is displayed, and with what uncertainty statement.

**Out of scope, explicitly.** Model architecture, weights, features, training data, the calibration curve,
and the site-detection vocabulary. The artifact stays frozen at SHA-256 `79061c4d…`. If the conclusion is
that the model needs to change, that is a separate decision taken after this one.

---

## 3. The decision the rule makes

Every reported site is assigned exactly one tier. The tiers are fixed here; only the rule that assigns them
is under test.

| tier | what the product shows | what is claimed |
| --- | --- | --- |
| **supported** | value **and** interval | the interval meets the coverage target in §4 on chemistry like this |
| **low-confidence** | value, and *no* interval | a value with no validated uncertainty; the reason is named |
| **unsupported** | no value; the site is reported as unassessed with a reason | this implementation cannot answer here |

Two constraints on the tiers themselves:

- **A tier is per site, not per molecule.** A molecule may carry a supported carboxyl and a low-confidence
  N-acidic site at once; collapsing to a molecule-level verdict would either hide the good answer or
  launder the bad one.
- **`low-confidence` must not display an interval at all.** A widened-but-unvalidated interval is the same
  false claim with a bigger number.

---

## 4. Targets, fixed now

A candidate rule passes only if **all four** hold on the sealed set, evaluated over the sites it labels
`supported`.

| # | target | value | where the anchor comes from |
| --- | --- | ---: | --- |
| T1 | interval coverage | **≥ 65%** | the nominal claim is 68%; 3 points is the tolerance already used per-bin by `interval_calibrate.py`. Anchored to the CLAIM, not to observed performance |
| T2 | share of errors > 2.0 pKa units | **≤ 10%** | 2.0 units is the pre-registered failure definition in the frozen error audit, and is the magnitude that flips the ionization state at physiological pH |
| T3 | share of errors > 3.0 pKa units | **≤ 4%** | same definition, the audit's second reported tail |
| T4 | MAE | **≤ 1.10** | ChemAxon Marvin's published Novartis MAE is 0.856 and its literature MAE 0.566 (Baltruschat & Czodrowski 2020, Table 2). 1.10 is deliberately *weaker* than Marvin: this asks whether the supported region is usable, not whether it wins |

**Coverage of the corpus is a reported outcome, not a target.** A rule that labels three sites `supported`
would pass T1–T4 trivially and be worthless. So the primary result is reported as the pair
*(fraction of sites labelled supported, whether T1–T4 hold)*, and a rule labelling **fewer than 40%** of
sites supported is recorded as passing-but-not-useful rather than as a success. 40% is set here, in advance,
and is not derived from any measurement.

**T1–T4 do not apply to `low-confidence` or `unsupported` sites.** Those make no accuracy claim, which is
the point of having them.

---

## 5. Candidate signals

A rule may use only information available at prediction time. Nothing derived from the measured pKa, and
nothing derived from the evaluation set.

Permitted:

- ensemble disagreement (the four members' spread), already computed per site
- ionizing element
- transition class, from `acidCharge` — acidic or basic
- the matched site type, and its training-row count in the corpus
- whether an interpretation fired, and which — `reference-protomer`, `reference-tautomer`, or neither
- whether the site type has fewer than a declared number of corpus rows
- nearest-neighbour similarity to the training corpus (QupKake reported *no* correlation between Tanimoto
  similarity and error, so this is a genuine test, not a foregone conclusion)
- the predicted value's position relative to the training range (−9.02 to 30.90)
- the number of ionizable sites in the molecule

**Element × transition may be used as a stratum, but its thresholds may not be inherited.** The audit's
finding that N-acidic sites cover at 44% is what makes the stratum worth testing; it is not permission to
set the boundary where the audit put it. The strata are structural facts about a site. The numbers attached
to them must come from the sealed set.

Prohibited: anything computed from the 402 audit molecules, the 398-row development set, or the OOF
calibration corpus, beyond the choice of which signals to test.

---

## 6. The evaluation set

**The set is sealed and hashed before the rule is written**, and the order is recorded in git rather than
attested by anyone — see §9. Separation of duties is the textbook safeguard and this project does not have
the headcount for it, so the substitute is a timestamped history in which any later adjustment of the rule
or the targets shows up as a diff.

Requirements:

1. **Family-disjoint** from all of: the 12,096-row training corpus, the interval calibration corpus, the
   398-row external development set, and every molecule in the frozen error audit. Disjointness is by
   normalised molecular family — the InChIKey skeleton block with charges stripped and scaffolds unioned,
   as `pka_folds.py` already does — **not** by raw SMILES. Two protomers of one substance are the same
   molecule for this purpose.
2. **Sourced so that non-overlap is structural, not merely checked.** Preference order:
   (a) experimental values published after the corpus was frozen, where the publication date guarantees it;
   (b) a source held out in its entirety;
   (c) SAMPL/euroSAMPL, and only after exhaustive family removal — several public compilations contain
   these molecules, so "we did not load the SAMPL file" is not sufficient.
3. **Licence recorded per source before assembly**, and any CC BY-NC material marked research-only so it
   cannot silently back a commercial claim. See `pka-provenance.md`.
4. **Site assignment must be experimental or diffed from an acid/base pair, not inherited from a
   predictor.** 4,022 corpus rows carry a ChemAxon Marvin site index, and the frozen audit's assignment
   comes from Marvin via QupKake — which is why it correctly says "not reproduced" is not proof of a wrong
   choice. This set must not repeat that: a row whose atom index comes from another predictor is excluded,
   not scored.
5. **Minimum size, stated before assembly.** At least 400 sites, and at least 40 in each element ×
   transition stratum the rule distinguishes. A stratum below 40 is reported as unpowered rather than
   passed or failed. The paired standard error on the existing 398-row set is 0.0309 across 390 families,
   which is why a set this size cannot resolve small differences — but T1–T4 are absolute thresholds, not
   differences, so 400 is adequate for them and is *not* adequate for any accuracy comparison between
   models.
6. **Sealed and opened once.** Hashed before §7's rule is written, and not scored until that rule is in the
   repository — see §9. The hash is recorded; the set's contents are not committed, so nothing about the
   molecules can leak into the rule through the diff.

---

## 7. The primary rule, and the analysis

**One primary rule is nominated. Everything else is exploratory.** Testing ten candidate rules against one
sealed set spends the set on the search; the pass/fail verdict attaches to the primary rule alone, and any
exploratory result is reported as a hypothesis for a future set.

The primary rule is to be written into this section before the set is scored, in the form:

> A site is **supported** when ⟨conditions on §5 signals⟩.
> It is **unsupported** when ⟨conditions⟩.
> Otherwise it is **low-confidence**.

*(Left blank deliberately. Writing it here, in the same session that read the audit, is the failure mode
this document exists to prevent — the numbers are in working memory and there is no way to tell from the
inside whether the rule is being reverse-engineered from them. It should be drafted against §5 alone, and
recorded as its own commit per §9 before anything is scored.)*

**Analysis.** Computed once, on the sealed set, in this order:

1. Assign a tier to every site using the primary rule.
2. Report the fraction labelled supported.
3. Evaluate T1–T4 over the supported sites only, with 95% intervals from a **molecular-family-clustered**
   bootstrap — per-row resampling treats protonation relatives as independent and overstates certainty.
4. Report, without a pass/fail attached: per-stratum outcomes, the tier breakdown, and the same statistics
   over low-confidence sites, so the cost of abstaining is visible.

**Verdict.** Pass requires T1–T4 to hold with the lower bound of the coverage interval at or above the T1
threshold — not merely the point estimate.

---

## 8. If the primary rule fails

Specified now, because a failure branch invented afterwards is a renegotiation.

- **No second rule is tested on this set.** A failed primary rule means a new rule and a new set.
- **The product falls back to suppressing intervals entirely**: a value with no `±` anywhere, plus the
  method-scope statements already in the contract. That is worse for the user than a working applicability
  rule and better than a false interval.
- **Targets are not relaxed.** If T1–T4 are wrong they were wrong before the data was seen, and changing
  them after is indistinguishable from fitting.
- **No abstention is shipped on audit-derived thresholds** as a consolation. The N-acidic stratum stays
  documented and unenforced until a sealed set says where the boundary is.

---

## 9. Freeze record: order of operations, enforced by git rather than by attestation

No signatures. A signature asserts that someone did not peek, which is unverifiable and worth little. What
is verifiable is **the order the artifacts entered the repository**, and git already timestamps that
permanently. So the protocol is enforced by requiring three separate commits in a fixed order:

| # | commit contains | what the order proves |
| --- | --- | --- |
| 1 | the SHA-256 of the sealed evaluation set, and its provenance per §6 — **not the set itself, and not any molecule in it** | the set was fixed at a known time |
| 2 | §7's primary rule, written out in full | the rule cannot have been fitted to results that did not yet exist |
| 3 | the scores, the tier assignment, and the T1–T4 verdict | the analysis came last |

Rules for the record to be valid:

- **Commit 2 must not touch the set's hash.** If the hash changes between commits 1 and 3, the set was
  altered and the run is void.
- **Commit 3 must not touch §3–§8 or the rule.** A diff there means the target or the rule moved after the
  outcome was visible, and the run is void regardless of what it reported.
- **One evaluation set, one commit-3.** A second scoring pass against the same set is exploratory and must
  say so; it cannot produce a pass.

This replaces separation of duties with something a solo project can actually satisfy: the history is the
witness. It does not prove nobody looked at the set before writing the rule — nothing can — but it does
make any post-hoc adjustment of the rule or the targets visible in the diff, which is the failure this
protocol is guarding against.

| step | commit | date |
| --- | --- | --- |
| set sealed and hashed | | |
| primary rule recorded | | |
| scored, verdict reported | | |

Sealed set SHA-256: ⟨ ⟩

---

## 10. What this protocol cannot do

Stated so it is not over-read.

- It says nothing about whether the model is **accurate**. It decides where its uncertainty statement is
  trustworthy. A rule can pass every target while the model remains behind Marvin by 0.34 MAE on Novartis.
- A 400-site set cannot resolve accuracy **differences** between models; roughly 3,700 families would be
  needed to gate a 0.02 MAE improvement. This set is for absolute thresholds only.
- It does not address the site-detection gaps. Carbonyl and thiocarbonyl basicity remain unsupported by
  the site vocabulary, 0 of 10 and 0 of 4 assigned events reproduced, and no applicability rule creates a
  site the locator cannot find.
- Passing does not make the interval a conformal guarantee. It makes it an interval measured to hold on one
  sealed, family-disjoint sample — which is strictly more than is claimed for it today, and strictly less
  than exchangeability would give.
