# pKa architecture: verified findings

**Written:** 2026-08-03 · **Against commit:** `4e1527b8` · **Reviewing:** `codex-suggestions.md`

Nothing in the code was changed to produce this. Every number below came from running the real
pipeline or reading the committed artifacts.

---

## Verdict

Codex's central call is correct: **the next move is a correct state model, not a bigger forest.** All
four P0 findings reproduce. One of them — urea reported as a tetraprotic acid titrating at pH 3.7 — is
the kind of output that would embarrass the product in front of a chemist.

But the report overstates two things in ways that matter for prioritisation, and one of its dataset
recommendations does not survive a license check. Details below, so the decision is made on measured
magnitudes rather than severity labels.

**My own last three commits treated symptoms of the root defect.** The tautomer fix in `4e1527b8` is a
special case of exactly the problem Codex identifies. The measurements were real and the azole numbers
did improve, but I patched a symptom and should have recognised the pattern when the ylide appeared.

---

## 1. What reproduces

Run through the real `analyzeStructure` path with real RDKit:

| probe | SMILES | result |
|---|---|---|
| glycine, neutral | `NCC(=O)O` | 2 sites → macro **2.13 / 9.07** |
| glycine, zwitterion | `[NH3+]CC(=O)[O-]` | **`not-applicable`, zero sites** |
| glycine, N-protonated | `[NH3+]CC(=O)O` | 1 site → **4.31** |
| glycine, O-deprotonated | `NCC(=O)[O-]` | 1 site → **7.07** |
| acetic acid | `CC(=O)O` | **4.50** |
| acetate | `CC(=O)[O-]` | **`not-applicable`, zero sites** |
| acetic + sodium | `CC(=O)O.[Na+]` | **4.62**, status `ok` |
| acetic + iron | `CC(=O)O.[Fe]` | **4.57**, status `ok` |
| acetamide | `CC(N)=O` | atom 2 emits acidic **11.92** *and* basic **8.40** → zwitterionic **true** |
| urea | `NC(N)=O` | 4 sites on 2 N → macro **3.70 / 5.49 / 13.45 / 14.27** |
| pyridine | `c1ccncc1` | 1 site → 5.04 |
| pyridinium | `c1cc[nH+]cc1` | atom 3 emits acidic **5.04** *and* basic **5.25** → zwitterionic **true** |
| aniline | `Nc1ccccc1` | acidic 11.95 + basic 4.61 → zwitterionic **true** |

Four drawings of glycine give four different answers, and the one a chemist would actually draw at
pH 7 gives nothing at all. Acetate — the conjugate base of the most-titrated acid in chemistry —
returns nothing. Urea is reported as a tetraprotic acid; it has one relevant aqueous pKa (~0.1, and
it protonates on **oxygen**, not nitrogen). Acetamide, urea, pyridinium and aniline are all flagged
zwitterionic. None of them are zwitterions.

## 2. The single defect behind most of it

Sites are emitted as `(atom, transition)` pairs and handed to `protonation.ts` as **independent
booleans**. An atom that can both lose and gain a proton emits two unrelated bits, so the enumeration
builds microstates where one nitrogen is simultaneously −1 and +1.

That one decision produces:

- the same-atom acidic/basic duplicates (acetamide, pyridinium, aniline);
- urea's 16-microstate ladder over two physical atoms;
- the false `zwitterionic` flag on four non-zwitterions;
- and the azole ylide I patched in `4e1527b8`.

The correct object is **one variable per atom with ordered levels** (deprotonated / neutral /
protonated), not N independent switches — plus a canonical reference protomer so the answer does not
depend on how the molecule was drawn. Codex states this precisely: *"A physical atom may participate in
several protonation levels, but those levels are mutually constrained."*

A same-atom pair does **not** corrupt the electrostatic coupling term — `coupling()` skips pairs at
distance 0, so `W = 6.0` never fires across one atom. The user-visible flag is wrong; the fitted
physics is not. Worth knowing before assuming the coupling work needs redoing.

## 3. Where Codex overstates

### P0-4 — real bug, negligible magnitude

`external_eval.py` does reuse a pre-canonicalization atom index after a `MolToSmiles` round-trip.
Confirmed by inspection: `mol = kekulized(Chem.MolToSmiles(acid))` then `full_features(mol, atom)`.

Measured with correct atom mapping via `_smilesAtomOutputOrder`:

| | |
|---|---|
| rows compared | 398 |
| rows where the index actually moved | **9 (2.3%)** |
| published MAE | 1.2414 |
| MAE with correct mapping | **1.2254** |

The published number is off by 0.016 log units **in the conservative direction**. It is a genuine
latent hazard that would bite hard on a differently-ordered dataset, and it should be fixed — but
"the committed external MAE is not trustworthy" is not what the data shows.

### P1-1 — fair point, unfair framing

Site-level MAE with sites supplied in advance is what every model in this space reports (QupKake,
pKaLearn, Uni-pKa). The legitimate criticism is that we do not *also* publish end-to-end numbers —
site detection recall, transition classification, representation invariance. That is a real gap. It is
not grounds to call the site-level figure illegitimate.

## 4. Also confirmed, cheap to fix

| finding | verified |
|---|---|
| **P0-3** metal/salt guard | Only checks atoms inside the SMARTS match. Whole-molecule descriptors (mass, TPSA, logP, charge) include the counterion, so Na and Fe shift the answer while status stays `ok`. |
| **P1-3** unreachable chemistry | **1,844 carbon-centered labels** in the QupKake set alone; **zero** carbon-centered entries in the 43-type locator. The model learned chemistry production can never ask it about. |
| **P1-4** provenance | The user-facing contract names Dwar-iBond **5 times** and QupKake **zero**. `pkaModel.ts` has the split right (3,031 + 5,286); the contract users read does not. The contract also still says "3,031 training labels" for the amine rule — stale since training became 8,317. |
| **P1-4** inventory | No pKa entries in `docs/architecture/dependency-inventory.md`. Confirmed. |
| **P1-5** fingerprints | `site-pka-forest.json`, `coupling.json` and `consensus-calibration.json` are imported as plain JSON and appear in **no** run fingerprint. Two builds can differ numerically and report identical provenance. |

## 5. Not verified

- **P1-2** (TPSA `includeSandP` mismatch between training and one runtime path). The flag plumbing
  exists in `methods.ts` and `analysis.ts`; I did not measure the claimed ~0.07 discrepancy. Plausible
  and worth a direct check.
- **P1-6** (coupling artifact not reproduced by its own fitting script). Not re-run.
- Codex's own test counts and probe list were taken as reported.

---

## 6. Licensing — what we could actually ship

We ship **Apache-2.0**. A model trained on NonCommercial data cannot go in it, and "public download"
is not "redistributable". I checked the records rather than restating the table.

| resource | Codex says | **verified** | shippable? |
|---|---|---|---|
| [pKaCHU](https://zenodo.org/records/20089807) | CC BY 4.0 | ✅ **CC BY 4.0**; 9,000 microscopic, experimental | **Yes**, with attribution |
| [D2A-pKa](https://zenodo.org/records/15277342) | CC BY 4.0 | ✅ **CC BY 4.0**; 8,241 experimental across 8 solvents | **Yes**, but non-aqueous — needs its own contract |
| [SAMPL6](https://github.com/samplchallenges/SAMPL6) | permissive | ✅ **MIT**; experimental pKa present | **Yes**, as a never-train benchmark |
| [pKaLearn](https://github.com/MoitessierLab/pKaLearn) | "MIT repository **and artifacts**" | ⚠️ **MIT covers the code. No data license stated; data provenance undocumented.** | **Code yes, data no** |
| [IUPAC aqueous](https://zenodo.org/records/21533589) | CC BY-NC 4.0 | ✅ **CC BY-NC 4.0** | **No** — NC blocks a shipped model |
| [pKaHub](https://github.com/keserulab/pkahub) | no explicit data license | ✅ no LICENSE file present | **No** — lookup/benchmark only |
| [Tautobase](https://github.com/WahlOya/Tautobase) | no explicit license | ✅ none visible; 1,680 tautomer pairs | **No** — diagnostics only |

**The pKaLearn recommendation does not survive its own standard.** Codex flags Dwar-iBond precisely
because a software license does not establish a dataset license — then recommends pKaLearn on the
strength of its MIT *code* license, with undocumented data provenance. Same defect, opposite verdict.

**Our current exposure is real, though.** 3,031 of our 8,317 labels are Dwar-iBond, reaching us via
Uni-pKa (Apache-2.0). Codex cites the DataWarrior author stating the original literature references
were lost. If that holds, we cannot audit those rows to source, and the Apache-2.0 grant on the
*software* does not settle the *data*. That is worth resolving regardless of which option below is
chosen. The QupKake half (BSD-3-Clause, experimental values) is clean.

The genuinely good news: **pKaCHU is CC BY 4.0, experimental, 9,000 microscopic values structured as
explicit protonated/deprotonated pairs** — which is exactly the shape a corrected state model wants,
and it would let us retire the least defensible part of the current corpus.

---

## 7. Options, with honest cost

**A. Fix the state model.** One ordered protonation variable per atom; canonical reference protomer so
all drawings agree; whole-molecule domain guard. Kills P0-1, P0-2, P0-3; subsumes the tautomer patch;
removes the false zwitterion flag. Then the cheap correctness work: contract provenance, artifact
fingerprints, external-eval atom mapping. **Days.** No new datasets, no licensing work, existing
accuracy claims survive with the site-level caveat made explicit.

**B. A, plus mark the feature experimental** and qualify the macroscopic/consensus numbers until
end-to-end evaluation exists. Same work, weaker public claim, lower risk of overstating.

**C. The full Codex program.** Corpus registry, ingest pKaCHU, Chemprop and graph-model comparison,
conformal calibration, species-distribution outputs. **Weeks**, plus a Dwar-iBond provenance audit and
new attribution obligations. Genuinely better science at the end. Note that **none of it fixes urea** —
the state model is upstream of every model choice, so C without A ships the same nonsense from a
better forest.

**D. Nothing yet.**

## 8. What I recommend

**A, then reassess.** The state model is the load-bearing defect, it is bounded, and it is a
prerequisite for everything in C — retraining on pKaCHU without fixing the enumeration would produce
better site values feeding the same impossible ladders. Codex's phases 1–5 are a reasonable direction
but they are a research programme, and the thing that would embarrass us in a demo tomorrow is urea.

Two things I would do regardless of the option chosen, because they are cheap and currently wrong in
user-visible ways: **fix the contract's provenance** (QupKake is invisible to users while its labels
are 64% of the corpus) and **fingerprint the three pKa artifacts** (identical provenance for
numerically different builds is a reproducibility hole, not a cosmetic one).
