# pKa experiment ledger

Appended as each arm finishes, before the next one starts. Every figure here is measured, not estimated.
A negative result is a finished arm.

**Standing measurement rules.** Frozen family-aware split only (`~/pka-runs/folds.json`, 12,096 rows,
5 folds, 0 families straddling). Paired molecular-family-clustered bootstrap CIs. Screens resolve about
0.04 at best, so anything tighter — and anything about carbon's 449 rows — needs full 5-fold runs.
RMSE reported beside MAE every time.

---

## Settled before this run

| arm | MAE | RMSE | N | O | C | S | verdict |
|---|---:|---:|---:|---:|---:|---:|---|
| acid-only (honest baseline) | 0.7482 | 1.2004 | 0.7620 | 0.6535 | 1.5032 | 0.7990 | comparator |
| pair (reads conjugate base) | 0.7341 | 1.1941 | — | — | — | — | **DISPROVED** vs shells |
| shells | 0.7107 | 1.1994 | 0.7093 | 0.6282 | 1.5963 | 0.6964 | promoted, −0.0375 CI [−0.0466, −0.0279] |
| pair+shells | 0.7096 | 1.2005 | — | — | — | — | **DISPROVED**, pair adds nothing atop shells |
| shells+sqrtbal | 0.7095 | 1.2080 | 0.7137 | 0.6151 | 1.6025 | 0.7681 | spans zero vs shells |
| shells+adamw | 0.7060 | 1.2015 | 0.7035 | 0.6243 | 1.5823 | 0.7315 | spans zero vs shells |
| **shells+adamw+sqrtbal** | **0.7032** | 1.2015 | 0.7086 | 0.6114 | 1.5438 | 0.7825 | **leading**, −0.0450 CI [−0.0544, −0.0353] |
| forest (reference, frozen split) | 1.0417 | 1.5877 | — | — | — | — | blend DISPROVED, best −0.0013 at w=0.05 |

Stage 2 casualties, all disproved on the screen by margins above its noise floor: dropout 0.1 (+0.041),
dropout 0.2 (+0.055), Huber (+0.054), gradient clipping (+0.007, inside noise), residual updates
(+0.002, inside noise), full inverse-frequency balancing (+0.133 — exactly the mechanism Codex predicted).

Two screen failures worth carrying forward: identical configs returned 0.7446 and 0.7322 for the
baseline, and −0.0238 then +0.0076 for AdamW. Screen noise is therefore 0.012–0.019, which puts Codex's
≥0.02 stop rule *below* the resolution of the screen it governs. Sqrt balancing's screened carbon gain
of −0.28 reversed entirely at full scale.

**Interval coverage, leading arm vs shipped** — measured with zero new compute from the existing OOF:

| | coverage (target 68%) | worst bin | interval quartiles | C | N | O | S |
|---|---:|---:|---|---:|---:|---:|---:|
| shipped acid-only | 67.57% | 0.0014 | 0.492 / 0.666 / 0.975 | 67.04% | 67.40% | 67.66% | 72.49% |
| shells+adamw+sqrtbal | 67.63% | 0.0075 | **0.428 / 0.604 / 0.936** | 67.04% | 65.96% | 70.25% | 64.02% |

Coverage holds and the intervals tighten 10–13% at every quartile — a user-visible gain the MAE table
does not show. Caveat: sulfur coverage falls 72.5% → 64.0% on 189 rows, while sulfur MAE improves
0.7990 → 0.7825.

---

## Step 1 — export, parity, and the shipping gates

**Why this is first.** Shells has only ever been scored inside cross-validation. H160 in this same tree
improved *every* scaffold-grouped fold (0.7281 → 0.7156) and then lost the external set
(1.1286 → 1.1691). So this is a falsification test, not paperwork.

### 1a. Export path — built

`pka_gnn_pair.py --export` fits all 12,096 rows with 4 members and writes an artifact whose
`architecture` block carries every number needed to rebuild the feature vector: `siteShells`,
`readsConjugateBase`, `distanceBuckets`, `ringSizeBuckets`, `shellBounds`, and the electronegativity
table. Training figures are derived from the out-of-fold file rather than passed in, so the number in the
artifact is the number that was measured. `gnn_infer.py` routes on those flags and refuses to load an
artifact whose declared shell shape disagrees with the checkout.

Parity traps found and handled while porting to TypeScript:

1. **Distance clipping.** Python initialises every atom to `far` and stops walking there, so an atom
   eight bonds out and an atom in a detached fragment both read 7. The TS `distancesFrom` returns a Map
   that neither clips nor names the unreachable, and `undefined` one-hots to all zeros — a fifth state
   the trained weights have never seen. Fixed with `Math.min(map.get(i) ?? far, far)`.
2. **Bond polarisation double-append.** TS pushes the *same* feature array for both edge directions, by
   reference. Appending |Δχ| after the two pushes would land it twice. Appended once, before.
3. **Ring-search bound.** Verified `MAX_RING = 8` on both sides, so a 9-ring is invisible to both rather
   than to one. Pinned with an explicit 9-ring parity case.

Eight parity cases added targeting only the new features: an 11-carbon chain past the 7-bond clip, 7-,
8- and 9-membered rings across the `MAX_RING` boundary, three halogens for real electronegativity
entries, boron for the table default *and* the element-one-hot "other" flag, a detached fragment for
unreachable atoms, and naphthalene for two rings through one atom.

### 1b. RETRACTION — three arms never applied their variants, and the CI method is anti-conservative

**What happened.** The three knob arms were launched as `--tag "shells-adamw-sqrtbal --wd 0.01
--balance 0.5"`, one quoted shell word, because zsh does not word-split an unquoted variable. `--wd` and
`--balance` were therefore never separate argv entries, `"--wd" in argv` was false, and both knobs stayed
at zero. The evidence was on disk the whole time: every one of those runs printed `wd 0.0  balance 0.0`
in its own header, and the output filenames carry the flags as literal text.

So these are **four replicates of one identical plain-shells configuration**:

| run | reported as | MAE |
|---|---|---:|
| run 1 | shells | 0.7107 |
| run 2 | shells+sqrtbal | 0.7095 |
| run 3 | shells+adamw | 0.7060 |
| run 4 | shells+adamw+sqrtbal | 0.7032 |

mean 0.70735, sd 0.00341, **range 0.0075**. MPS `index_add_` does not accumulate deterministically, so
repeat training does not reproduce.

**Retracted:** "shells+AdamW+sqrt-balance −0.0450, CI [−0.0544,−0.0353]" and "the combination is
significant where neither knob is alone". AdamW and sqrt-balancing are **untested at full scale**.

**Worse, the CI method itself is anti-conservative.** Pairing the four identical-config runs gives six
comparisons whose true effect is exactly zero:

| pair | paired diff | 95% CI | verdict |
|---|---:|---|---|
| run1 vs run2 | −0.0012 | [−0.0066, +0.0040] | spans zero |
| run1 vs run3 | −0.0048 | [−0.0100, +0.0005] | spans zero |
| **run1 vs run4** | **−0.0075** | **[−0.0128, −0.0021]** | **EXCLUDES ZERO — false positive** |
| run2 vs run3 | −0.0035 | [−0.0088, +0.0016] | spans zero |
| **run2 vs run4** | **−0.0063** | **[−0.0115, −0.0011]** | **EXCLUDES ZERO — false positive** |
| run3 vs run4 | −0.0027 | [−0.0080, +0.0025] | spans zero |

**2 of 6, where a valid 95% method allows about 0.3 of 6.** And `run1 vs run4` reproduces the interval
reported as the headline result to four decimals. The family-clustered bootstrap resamples molecules, so
it captures variation across the corpus but **not** run-to-run variation of the training. Any effect below
roughly 0.008 will look significant when it is nothing.

**What survives, and is now firmer.** `--mode` parsed correctly in every run, so **shells vs acid-only is
real**, and four replicates estimate it better than one did: **−0.0409**, twelve times the run-to-run sd.
That remains the only genuine accuracy win in this effort.

**Consequences carried forward.**

- The run-to-run noise floor is **0.0075**, not the 0.0017 quoted previously. Codex's ≥0.02 stop rule is
  below full-run resolution as well as below his screen's; his 0.01 Stage-1 promotion threshold is
  marginal against it.
- The screen irreproducibility recorded earlier (baseline 0.7446 vs 0.7322) was this same
  nondeterminism, not a property of screens.
- **No sub-0.01 effect may be claimed from single runs again.** Either training becomes deterministic, or
  the arm gets replicates and the run becomes the unit of analysis.
- Guard added: `pka_gnn_pair.check_argv` refuses any option value containing whitespace, which is what
  this failure looked like from argv. Verified it catches the exact invocation and passes correct ones.

### 1c. Parity gate — PASSED, first attempt, 21/21

Artifact: 543,748 parameters over 4 members, **5.7 MB** against the shipped 426,244 / 4.5 MB (+27.6%
parameters, +1.2 MB). TypeScript agrees with PyTorch to under 1e-4 on all twenty cases, including the
eight that exist only to stress the new features — the 11-carbon chain past the clip, the 7-, 8- and
9-membered rings, three halogens, boron, the detached fragment, and naphthalene.

All three parity traps were caught by reading rather than by the fixture, which is the only reason this
passed first time. Worth noting for the next port: the fixture would have caught the distance-clipping
trap loudly, but a Map returning `undefined` for an unreachable atom one-hots to all zeros, which is a
*plausible* feature vector — so it would have shown up as a small numeric disagreement rather than an
obvious break.

### 1d. External falsification — the warning fires

Paired on 397 shared external rows, family-clustered, shipped acid-only as A:

| B | A MAE | B MAE | paired B−A | 95% CI | verdict |
|---|---:|---:|---:|---|---|
| shells+adamw+sqrtbal | 1.1311 | **1.1815** | **+0.0504** | [−0.0129, +0.1138] | spans zero, wrong direction |
| ↳ N (n=313) | 1.0953 | 1.1848 | **+0.0895** | [+0.0186, +0.1653] | **worse, excludes zero** |
| ↳ O (n=80) | 1.1994 | 1.1520 | −0.0474 | [−0.1484, +0.0574] | spans zero |
| ↳ S (n=4) | 2.5666 | 1.5126 | −1.0540 | [−2.2121, +0.1040] | n=4, uninformative |

This is the H160 pattern: better on every cross-validated fold, worse on data never seen. Nitrogen is
82% of the external set and it regressed significantly.

**But this single comparison has exactly the weakness just retracted above** — one artifact per arm, and
one artifact is one draw from a nondeterministic training process. Asserting "shells fails externally"
from it would repeat the error in the opposite direction. Two things are therefore in flight before any
conclusion is drawn:

1. The externally-tested artifact was the **untested** adamw+sqrtbal config, not plain shells. Plain
   shells is the configuration with four cross-validation replicates behind it, so it is the one whose
   external behaviour actually bears on the proven claim.
2. Replicates of **both** arms through the same harness — 3 × shells and 3 × acid-only, distinct seed
   offsets, each externally scored. The shipped artifact is also a single draw, and from a different
   training era, so comparing against it alone is not a controlled A/B.

`--seed-offset` added to make replicates explicit; `external_eval.py` now takes `--model` and `--tag` so a
candidate can be scored without editing the checkout; `external_paired.py` added because an unpaired
comparison cannot see a 0.02 effect against this set's per-row SE of 0.0792.

### 1e. Plain shells externally — NEUTRAL, and that is the finding

| B | A MAE | B MAE | paired B−A | 95% CI |
|---|---:|---:|---:|---|
| plain shells | 1.1311 | 1.1400 | **+0.0089** | [−0.0463, +0.0642] spans zero |
| ↳ N (n=313) | 1.0953 | 1.1059 | +0.0106 | [−0.0533, +0.0750] |
| ↳ O (n=80) | 1.1994 | 1.2308 | +0.0314 | [−0.0666, +0.1374] |

So the knobs are what did the damage (+0.0504, N excluding zero); plain shells is externally neutral.
**Shells' −0.0409 cross-validated gain does not transfer to held-out data at all.** Not a collapse like
H160's +0.04, but not a gain either — and Codex's headline gate wants ≥0.02 *better*.

### 1f. Remaining gates on plain shells

**Macroscopic — PASSES.** `macro_validate.py` now takes a model path, so a candidate can face the same
yardstick. 32 values on 15 molecules, tautomer-exclusion variant:

| class | values | shipped | plain shells |
|---|---:|---:|---:|
| independent | 18 | 0.35 | **0.32** |
| zwitterionic | 10 | 0.12 | **0.23** |
| azole | 4 | 0.21 | 0.24 |
| **ALL** | 32 | **0.26** | **0.28** |

+0.02 overall, inside the ≤0.03 tolerance. Flagged: zwitterionic nearly doubles, 0.12 → 0.23. On 10
values that is two or three molecules, but zwitterions are the case the coupling term exists for.

**Interval coverage — PASSES, and sharpens.** Already recorded above; the arm measured there was in fact a
plain-shells replicate, so the figures apply to this candidate: coverage 67.63% against 67.57%, and
quartiles 0.428 / 0.604 / 0.936 against 0.492 / 0.666 / 0.975 — 10–13% tighter at equal coverage.

**Latency — PASSES.** Measured in TypeScript, shipped vs shells, per site, 25 reps after warm-up:

| molecule | shipped | shells | ratio |
|---|---:|---:|---:|
| acetic acid (4 atoms) | 2.14 ms | 1.94 ms | 0.91x |
| caffeine (14) | 6.05 ms | 6.45 ms | 1.07x |
| ibuprofen (15) | 6.19 ms | 6.63 ms | 1.07x |
| piroxicam-like (24) | 9.99 ms | 10.95 ms | 1.10x |

1.02–1.10x, worst case 10.95 ms. I had flagged a risk that the ring-size feature calls `cyclesThrough`
per atom *again* after `siteContext` already does — measurement did not bear it out.

**Artifact size — 5.7 MB against 4.5 MB**, +27.6% parameters (135,937 vs 106,561 per member). No declared
budget exists to test this against, which is itself a gap.

**Site detection and representation invariance — unchanged by construction.** This architecture changes
only the site-value regressor; the locator, canonicalization and ladder code are untouched.

### 1g. Gate tally for plain shells

| Codex's shipping gate | result |
|---|---|
| ≥0.02 MAE better on a fresh locked test | **FAIL** — +0.0089 (worse), and no fresh locked test exists |
| family-clustered paired CI excludes zero | **FAIL externally** (spans zero); holds on CV |
| no critical site class worse by >0.05 | **FAIL** — carbon +0.093 on CV |
| macroscopic worsens ≤0.03 | PASS (+0.02) |
| site-detection precision/recall no regression | PASS (untouched) |
| protomer/tautomer invariance no regression | PASS (untouched) |
| calibrated interval coverage no regression | PASS, and 10–13% sharper |
| artifact size and latency inside budget | latency PASS; size +27.6% against no declared budget |

Three failures, and the first is the headline. **Plain shells is not shippable on this evidence.**
Replicates of both arms are in flight to establish whether the external neutrality is stable or is itself
a single draw.

### 1h. Replicates reverse the sign, and the instrument turns out to be the real limit

Both arms trained through the same harness, three replicates each, all scored on the external set:

| arm | runs | mean | sd |
|---|---|---:|---:|
| acid-only | 1.1624, 1.1223, 1.1685 | 1.1511 | 0.0251 |
| shells | 1.1400, 1.1466, 1.1059 | **1.1308** | 0.0218 |

Difference **−0.0203** in shells' favour, SE 0.0192 — **1.05 SE, not resolvable at 3 v 3**. Pooling
replicates into 12-member ensembles and pairing row by row agrees: 1.1377 vs 1.1141, paired −0.0236, CI
[−0.0841, +0.0372], spans zero.

**So §1e's "+0.0089 worse" was an artefact of the control.** It compared against the *shipped* artifact at
1.1311, which sits at z = −0.80 of acid-only's own external distribution — a favourable draw. Every past
comparison against that number inherited the same bias.

**The external set cannot resolve 0.02, and no amount of retraining fixes that.** Its paired SE across 390
families is 0.0309; reaching SE < 0.01 needs 9.6x more families, about **3,700**. Replicates only help the
run-level view (11 per arm would resolve 0.02 there, ~7 hours); the pooled interval stays at ±0.06 because
it is bound by the 397 rows, not by run noise. **Codex's headline shipping gate — ≥0.02 on a held-out
test — is unmeasurable with the only external set that exists.**

**And it undermines a decision already recorded in this repo.** H160 was rejected for scoring 1.1691
against "1.1286". Against acid-only's real external distribution that is z = **+0.72**, well inside one
standard deviation. H160 was very likely rejected on noise. That rejection is written into `BUILD.md`,
quoted in `external_eval.py`'s docstring as evidence that capacity is not the bottleneck, and repeated by
Codex. The conclusion may still be right; the evidence never supported it.

---

## Step 2 — does the product find the atom at all?

**Why this became the priority.** Every figure above assumes the correct ionizing atom was supplied. A user
supplies a drawing. Codex said so plainly — "the product must locate the site first" — and it had never
been measured. A missed site is not a 2% error; it is a pKa that never appears. It also needs no new data:
12,096 labelled sites already exist.

Measured through `analyzeStructure`, the real entry point, so the domain guards and the default
`reference-protomer` interpretation are in play. Index alignment is verified per molecule from the result's
own `depiction`, whose atoms carry the same numbering the sites use — 52% of these inputs are charged, so
the molecule scored need not be the molecule drawn, and a recall figure spanning two index spaces would be
fiction.

### 2a. The locator's scope is a 42-row SMARTS table, and it has no carbonyl entry

`ionizationSites.ts` holds **42 site types** transcribed from Dimorphite-DL. Not one is carbonyl-oxygen or
thiocarbonyl-sulfur basicity; the only `C=O` in the file is an environment qualifier inside the peroxide
pattern. Dimorphite is built for the aqueous drug-discovery range, so a protonated carbonyl at pKa −5 has
no row and **cannot be found by construction**.

This matters for how recall is read. A first sample appeared to show 70% recall — but `merged-labels.json`
is sorted by pKa, so slicing the first 150 molecules took the **most acidic rows in the corpus**, and every
miss was a protonated carbonyl or thioamide (`=[OH+]`, `=[SH+]`, pKa −5.5 to −0.3). That sample measured
the table's scope, not the locator's skill. The full run is therefore stratified by pKa band: misses below
0 are scope, and recall inside the aqueous window is the number that describes the product.

A coherent pattern is emerging across three separate experiments: **the corpus teaches the model chemistry
the locator can never ask about.** The carbon-prune experiment found the same shape — 100 carbon labels the
locator could not present, whose removal made both scores worse — and 52% of the corpus is charged
protomers of which many are unreachable rungs.

### 2b. Recall: 86.3% over the whole corpus, 89.0% inside the aqueous window

Full pass, all 12,062 molecules, 1,778s:

```
FOUND 10,435    MISSED 1,640    unassessable 21    MISALIGNED 0    declined 0    threw 0
```

**Zero misaligned**, though the protomer derivation fired on 5,904 molecules — the index spaces agree
everywhere, so the recall figure is measuring the locator rather than a numbering mismatch. That was the
main thing that could have made this measurement worthless.

| element | recall | found | missed |
|---|---:|---:|---:|
| N | 95.9% | 6,512 | 271 |
| O | **74.8%** | 3,494 | **1,160** |
| S | 69.8% | 132 | 57 |
| C | 66.1% | 297 | 152 |

| pKa band | recall | missed |
|---|---:|---:|
| below 0 | 53.7% | 29 |
| **0 to 14** | **86.6%** | **1,592** |
| above 14 | 81.2% | 19 |

**The scope hypothesis in §2a was wrong, and the full data refutes it.** 97% of misses fall INSIDE the
aqueous window, not outside it. The carbonyl-table gap explained a biased sample and nothing more.

The app is not being cautious to compensate: it reports **2.29 sites per molecule** against 1.00 labelled.
It reports plenty; it reports the wrong ones.

**One correction in the locator's favour.** 40 of 313 in-window misses on a randomised 2,500-molecule
sample (12.8%) are the app reporting an *equivalent* atom — the other oxygen of the same carboxyl, one
resonance structure apart. Counting those as misses measures a labelling convention, not a failure any user
sees. Corrected: **89.0% inside the window, 87.9% overall.**

### 2c. Two functional groups account for 40% of it, and one is a total blind spot

Measured directly per family rather than scaled, on the randomised sample:

| family | in sample | missed | miss rate | in corpus | est. missed | training rows |
|---|---:|---:|---:|---:|---:|---:|
| **oxime  C=N–OH** | 85 | 85 | **100.0%** | 345 | **345** | 345 |
| **enol  C=C–OH** | 52 | 45 | 86.5% | 240 | ~208 | 240 |
| imine / amidine  C=N | 136 | 21 | 15.4% | 541 | ~84 | 541 |

**The app has never once found an oxime OH.** Not a coverage gap — a complete blind spot for an entire
functional group. Confirmed directly against `analyzeStructure` on four real oximes with tabulated values,
with phenol as a positive control:

```
CC(C)=NO                acetone oxime, pKa ~12.4     NO SITES REPORTED
C/C=N/O                 acetaldoxime, pKa ~11.9      NO SITES REPORTED
ON=C(c1ccccc1)c1ccccc1  benzophenone oxime, pKa ~11  NO SITES REPORTED
ON=Cc1ccccc1            benzaldoxime, pKa ~10.7      NO SITES REPORTED
Oc1ccccc1               phenol (control)             atom 0  Phenol  pKa 9.94
```

A user handed acetone oxime is told it has **no ionizable sites at all**. Silence, not a wrong number.

Remaining families, as share of the 273 genuine in-window misses on the sample: hydroxy-heteroaromatic
c–OH 7.7%, imine/amidine 7.0%, alpha-to-carbonyl 4.0%, thiocarbonyl/thiol 4.0%, arsenic and other
heteroacids 3.7%, N–OH on sp3 N 3.3%, phenol-type c–OH 2.9%, alpha-to-nitro 2.6%, hydroxamic acid 1.5%,
hydroperoxide 1.1%. Unclassified 15.4%.

**Why this is the cheapest fix available: the model already knows this chemistry.** Every missed site is a
corpus row, so the network was trained on 345 oxime sites and 240 enol sites and can value them today. The
42-pattern table simply cannot ask. Roughly six SMARTS additions would address about three quarters of the
in-window misses, with no retraining and no new data.

**Ranked against everything else measured in this effort:**

| | magnitude |
|---|---|
| site-distance features (Codex's #2) | ~2%, unresolvable on any existing test |
| every other arm on Codex's matrix | zero |
| **oximes alone** | **345 sites, 100% silent** |
| **oximes + enols** | **~553 sites** |

### 2d. Final split, and the exact denominator chain

Self-contained harness, all 12,062 molecules, `SITE_DETECTION=1 pnpm vitest run siteDetection`:

```
found at the labelled atom   10,824      RECALL, strict            91.6%  (of 12,021)
equivalent atom, same group     189      RECALL, credit relocation 95.6%
same event, relocated           482
policy removed, unreported      225
genuine gap                     280
label site from a predictor      75      (excluded from the denominator)
flagged unassessable             21
INDEX UNSTABLE                    0
```

| element | strict | relocated | policy-unreported | gap |
|---|---:|---:|---:|---:|
| N (6,789) | 96.2% | 46 | 77 | 80 |
| O (4,669) | 86.7% | 355 | 98 | 134 |
| S (189) | 69.8% | 36 | 13 | 3 |
| C (449) | 66.6% | 45 | 37 | 63 |

**Why the headline moved from 86.3% to 91.6%, in order.** The figures are not revisions of one measurement; each step changed either the software or the question.

| | figure | what changed |
|---|---|---|
| 1 | 86.3% | first full pass. found-vs-missed only, no buckets |
| 2 | 89.0% | *sample of 2,500.* Credited the carboxyl's other oxygen — one resonance structure apart, so which one carries the label is a convention (12.8% of in-window misses) |
| 3 | 90.4% | *software changed.* The Oxime pattern shipped: +85 sites |
| 4 | 90.6% | *software changed.* Four further patterns: +5 sites, near-zero |
| 5 | 91.2% | full pass on the six-bucket harness, strict definition (found + equivalent atom only) |
| 6 | **91.6%** | 75 rows whose site index came from ChemAxon Marvin left the denominator: 12,096 → **12,021** |

The strict definition credits **only** `found` and `equivalent-atom`. `equivalent-atom` requires the same element sharing a neighbour with the labelled atom — any same-element atom anywhere would credit a phenol for a missed carboxyl.

**`same-event-relocated` (482 rows, 4.0 points) IS NOT ADJUDICATED.** Two attempts to verify it failed, both mine: deprotonating the reported atom in the drawn frame removes a second proton from the wrong position, and hand-moving a proton without adjusting bond orders produces radicals. The re-run now dumps the derived structure so the audit can work in the frame the app actually scored. Until then the honest figure is the strict 91.6%.

### 2e. RETRACTION — the interval is not a calibrated 68% interval off-distribution

Reported twice as a differentiator: "67.6% coverage against a 68% target." That is measured **out-of-fold on the corpus, which is where the calibration curve was fitted.** Measured independently on the external set:

| | coverage vs a claimed 68% |
|---|---:|
| out-of-fold corpus (fitted here) | 67.6% |
| **external set (n=398)** | **57.3%** |
| ↳ Novartis | 53.6% |
| ↳ Literature | 65.6% |
| ↳ nitrogen (314) | 55.7% |
| ↳ **N-acidic** (Codex's audit) | **44%** |

Confirms Codex's end-to-end audit at 57.10% on its 352 exact comparisons. **The same defect the carbon stratification was built to fix, one level up:** it was fixed conditional on element and remains open conditional on distribution. Conformal validity rests on exchangeability between calibration and test data, which structurally shifted molecules break.

So the app shows a `±` that is roughly honest on corpus-like molecules and materially over-confident on novel ones — the case a user cares about most.

### 2f. Where a sentinel can and cannot help

Codex proposes a domain sentinel returning "unsupported" for carbonyl-O-basic and thiocarbonyl-S-basic, where its audit reproduced 0 of 10 and 0 of 4 assigned events. The gap is real and matches this corpus audit independently. But the sentinel cannot be keyed on the presence of the group:

| | of 12,062 distinct molecules |
|---|---:|
| contains a neutral carbonyl `C=O` | 5,524 (45.8%) |
| contains a neutral thiocarbonyl | 173 (1.4%) |
| **drawn** protonated `C=[OH+]` | 21 (0.2%) |
| **drawn** protonated `C=[SH+]` | 7 (0.1%) |

`external_eval.sdf_sites` builds a basic record's acid form by protonating a NEUTRAL drawing, so those failures arrive as neutral carbonyls. A sentinel flagging unassessed carbonyl basicity would therefore fire on nearly half of all results and become noise. Keyed on the drawn protonated form it is precise and reaches 0.2%.

The defensible form is a scope statement made ONCE in the contract — this implementation does not assess carbonyl or thiocarbonyl basicity — plus a per-molecule `unassessed` entry only where the user drew the protonated form. Not a flag on 5,524 molecules.
