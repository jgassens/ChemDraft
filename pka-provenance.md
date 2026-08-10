# pKa corpus provenance and open licensing questions

**Purpose.** One place recording, per corpus, what the licence actually covers, whether the rows feed the
shipped model or are research-only, and the question a lawyer needs to answer. Written so the open
questions can be resolved without re-deriving any of this from the code.

**Standing rule for this work:** a licensing question never blocks an experiment. It gets recorded here,
and artifacts derived from an encumbered corpus stay in `~/pka-runs/` rather than `packages/`, so that no
decision is foreclosed by something already committed.

**The recurring error, stated once.** Several of these corpora ship inside a software repository. The
repository's licence — BSD, Apache, MIT — governs its *code*. It is not a grant over a dataset sitting in
that repository's `data/` directory. Two rows in `ionizationContract()` had made exactly that
substitution and are corrected below.

---

## Shipped training corpus — 12,096 rows

| corpus | rows | licence recorded | what it covers | status |
|---|---:|---|---|---|
| pKaCHU | 4,419 | CC BY 4.0 | the dataset itself, Zenodo 20089807 | **clear** |
| QupKake experimental | 4,022 | **CC BY 4.0** (corrected) | the upstream dataset | **corrected, attribution owed** |
| Dwar-iBond | 3,031 | **unresolved** (corrected) | nothing established for the data | **OPEN — largest question** |
| D2A-pKa, aqueous only | 624 | CC BY 4.0 | the dataset, Zenodo 15277342 | clear for the aqueous rows |

### QupKake experimental, 4,022 rows — CORRECTED

Was recorded as `BSD-3-Clause`, `redistributable: true`. BSD-3-Clause is **QupKake's software licence**.
The data originates with Baltruschat & Czodrowski (*Machine-learning-meets-pKa*), released **CC BY 4.0**.

Now recorded as CC BY 4.0. Still `redistributable: true`, which is correct — CC BY 4.0 permits
redistribution — but it carries an **attribution obligation that BSD-3-Clause does not describe**, and
that obligation travels with the model artifact, not just with the source tree.

Separately and unchanged: the **values** are measurements, the **site index** is ChemAxon Marvin's
assignment. That is a predictor annotation embedded in the label and is disclosed per row.

*Question for legal:* is the attribution as currently rendered in `NOTICE` and the acknowledgements view
sufficient for CC BY 4.0 when what is distributed is model weights rather than the data?

### Dwar-iBond, 3,031 rows — OPEN, AND THE ONE THAT MATTERS

Was recorded as `Apache-2.0` — **Uni-pKa's software licence**, the same category error. No terms have been
established for the data itself. Now recorded as
`"unresolved — Apache-2.0 covers Uni-pKa's code, not this dataset"`.

`redistributable` has been **left at `true`**, and that is a deliberate, flagged choice rather than a
finding: it is the status quo under which the model already shipped. Flipping it to `false` would be a
legal determination, and it is not mine to make.

Why this is the largest question: **3,031 rows are 25% of the training corpus.** If these rows turn out to
be non-redistributable, the remedy is not a notice edit — the corpus has to be re-derived without them and
the model retrained. Worth knowing early rather than late.

Compounding factor already recorded in the contract: the DataWarrior author has stated the original
literature references for part of this set were lost, so these rows cannot all be audited back to a
measurement.

*Question for legal:* can a model trained on this set be distributed commercially, and if not, what is the
exposure of the artifact already shipped?

---

## Research-only, never in the shipped corpus

| corpus | rows | licence | why it is quarantined |
|---|---:|---|---|
| IUPAC Dissociation Constants | — | **CC BY-NC 4.0** | non-commercial. Usable for research analysis; cannot back commercially-distributed weights. |
| D2A-pKa, nonaqueous | 4,445 | CC BY 4.0, but incorporates iBonD/IUPAC material | the incorporated material's downstream terms are unclear. Needed for Codex's Stage 6. |
| QupKake 1.55M ChemAxon-labelled | ~1.55M | ChemAxon terms govern bulk calculated output | Codex's research-only last arm. Weights derived from it must not be distributed without written clearance, and the inherited-predictor provenance must be disclosed. |
| QMugs | ~665k mols | CC BY 4.0 | clean, and the intended Stage 5 pretraining corpus. No obstacle expected. |
| SAMPL6/8, euroSAMPL | — | challenge data | reserved as never-train test material. |
| pKaLearn | 12,817 | MIT (code) | **design donor only.** Its CSV mixes DataWarrior/F1000Res lineage, Epik-generated rows, and SAMPL benchmark molecules, so ingesting it would import both a licence question and benchmark contamination. |

**External evaluation set (398 rows).** QupKake's Novartis and literature SDFs. The data is **not
vendored** — only `external_eval.py` is, and it reads a checkout the user supplies. So no dataset
redistribution occurs for this set. Its statistical status is a separate problem: it has now selected
models repeatedly and is development data, not a blind test.

---

## What is asserted where

- `ionizationContract().datasets` in `packages/rdkit-adapter/src/ionization.ts` — the machine-readable
  record, and the source for the acknowledgements view. Both corrections above are applied there.
- `NOTICE` at the repository root — needs the QupKake attribution restated as CC BY 4.0. **Not yet done**;
  no redistributability claim has been added for anything unresolved.
- `pka-experiment-ledger.md` — measurements, not provenance.

## Summary for legal

1. **Dwar-iBond, 3,031 rows, 25% of the corpus.** Terms unestablished, references partly lost. Highest
   exposure; determines whether a retrain is needed.
2. **QupKake, 4,022 rows.** Licence corrected to CC BY 4.0. Confirm attribution is adequate when the
   distributed thing is weights.
3. **Anything ChemAxon-labelled.** Written clearance required before distributing derived weights.
4. **IUPAC CC BY-NC.** Research analysis only; must not back commercial weights.
