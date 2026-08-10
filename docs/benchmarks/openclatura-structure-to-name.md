# OpenClatura structure→name benchmark (PLANS.md §8, step 1)

Run 2026-08-01 against **OpenClatura 0.2.0** (MIT, `lamalab-org/openclatura`), scored by round-tripping
every name back through the vendored **OPSIN 2.9.0**. Harness in `tools/openclatura-benchmark/`.

§8 gated any adoption of OpenClatura behind this benchmark, for a stated reason: its advertised
"PubChem/QM9/ZINC22 coverage is 99/97/100 %" is **not naming accuracy**, and "coverage plausibly means
a name was returned". This run confirms that reading and quantifies the gap.

## Method

Structure → OpenClatura name → OPSIN → structure, comparing RDKit canonical SMILES at both ends.

- **Corpus:** `rdkit/Data/NCI/first_5K.smi` (4,999 real NCI compounds), plus a 26-entry adversarial set
  covering the §9 corpus categories — salts, zwitterions, radicals, isotope labels, organometallics,
  boron/silicon, charged heterocycles, tautomers, and stereochemistry.
- **Oracle limit, stated up front:** agreement means *the two engines agree on a structure*. It does
  **not** establish that the name is a preferred IUPAC name, systematic, or compliant. A name can
  round-trip perfectly and still be clumsy or non-preferred. Disagreement is the informative direction.
- Speed: ~95 structures/s for naming; the whole 4,999 takes about a minute, and the round-trip is one
  JVM for the entire batch.

## Headline

| Outcome | NCI (4,999) | |
|---|---:|---|
| Round-trip exact | 4,721 | 94.4% of all, **98.7% of the names it produced** |
| Declined (no name) | 207 | 4.1% — the safe failure |
| **Misnamed** | **36** | **0.72% — a name meaning a different molecule** |
| Name OPSIN could not parse | 27 | 0.54% |
| Raised an exception | 8 | 0.16% |

The 98.7% round-trip rate among produced names is genuinely good, and matches the spirit of their
coverage claim. **The 36 are the finding**, because they are not declines — they are confident,
well-formed, OPSIN-parseable names for the wrong compound.

## The 36, by what happened to the atoms

| | |
|---:|---|
| **14** | **atoms silently dropped — the name describes a *smaller* molecule** |
| 12 | same formula, different connectivity |
| 9 | formula changed in both directions |
| 1 | atoms invented |

The 14 are the serious ones. Seven are arsenic compounds whose entire arsonic acid group vanishes from
the name:

```
NC(=O)CNc1ccc([As](=O)(O)O)cc1   →  "2-(phenylamino)acetamide"
CC(=O)Nc1cc([As](=O)(O)O)ccc1O   →  "N-(2-hydroxyphenyl)acetamide"
```

A chemist reading either name draws an arsenic-free compound. Nothing in the output marks the loss.
The rest are triarylmethane dyes losing N-substituents (ethyl, benzyl) or sulfonate groups.

## Where it declines — and the inconsistency that matters

Declining is handled **well for metals**: Cu (38/38), Co (31/31), Hg (23/23), Ni, Zn, Cd, Mn, Cr, Sb,
Sn, Fe, Ce, Bi, Ti, Th, V, Zr, Pt — 100% declined, no metal misnamed. Ferrocene, cisplatin, and SeO₂
also decline. That is correct behaviour and worth crediting.

**Arsenic is the exception, and it is the shape of the problem:**

| element | n | round-trip | misnamed | declined |
|---|---:|---:|---:|---:|
| As | 20 | **0** | **6** | 14 |

Arsenic is not supported — it never round-trips once. But instead of declining all 20, it declines 14
and silently deletes the arsenic from the other 6. **The boundary between "decline" and "silently
omit" is not aligned with the boundary of what it actually supports.** A tool that declined all 20
would be usable with a documented gap; this one cannot be trusted to tell you which case you are in.

## Adversarial set (26 entries)

**Stereochemistry is a strength.** Every stereo case round-tripped exactly — R/S centres, E/Z alkenes,
the meso tartaric acid distinguished from (R,R) and (S,S), and ring stereochemistry. §8's
"correct stereodescriptors and locants" criterion is met on this evidence. One case
(a cyclohexanepentaol) produced a name OPSIN could not parse, which is as much an OPSIN coverage
question as an OpenClatura one.

**Three failures, all the same silent-omission shape:**

```
[13CH3]C(=O)O          →  "acetic acid"                                (¹³C label deleted)
[2H]C([2H])([2H])C(=O)O →  "acetic acid"                                (three deuteriums deleted)
CC1(C)CCCC(C)(C)N1[O]  →  "1-hydroxy-2,2,6,6-tetramethylpiperidine"    (TEMPO reduced to a
                                                                        closed-shell hydroxylamine)
```

The isotope cases are notable for this repository specifically: they are the exact failure the isotope
envelope refused to commit in §8, where stripping a label to make a formula parse "would report the
natural-abundance envelope of a *different molecule*". OpenClatura commits it, in the naming direction.

Salts and zwitterions are handled (sodium benzoate, glycine as "2-ammonioacetate"), though
`[Cl-].[Cl-].[Ca+2]` names as "calcium chloride chloride" — round-trips correctly, reads poorly.

## Upstream

Active: created 2026-05-08, last push 2026-08-01 (the day of this run), 69 stars, MIT. Development
velocity is high, which is a point in its favour for the "contribute fixes upstream" step.

One provenance wrinkle worth recording: **pip installs 0.2.0 but `openclatura.__version__` reports
0.1.5.** The package disagrees with itself about its own version, so neither string alone identifies
what was run — the same trap IsoSpec's tag-vs-CMakeLists mismatch set, and pinning should be by commit.

## What this means for §8's sequence

Step 1 is done. Reading it against §8's own criteria:

- *structural round-trip* — **98.7% of produced names.** Good.
- *correct stereodescriptors and locants* — **met** on the stereo set.
- *unsupported structures rejected rather than misnamed* — **NOT met.** Correct for metals; wrong for
  arsenic, isotope labels, and radicals, and wrong in the most dangerous direction: silent omission
  rather than refusal.
- *preferred IUPAC name where known* — **not assessed.** A round-trip cannot establish it, and doing so
  needs a reference set of preferred names this benchmark does not have.

**Recommendation: do not port to TypeScript (step 5), and do not ship it as a naming feature yet.**
Not because the engine is bad — 98.7% is a real achievement — but because a 0.72% silent-omission rate
is the wrong failure shape for this product. AGENTS.md §8a's rule is that a predictor which returns a
confident wrong answer is more dangerous than one that declines, and that is precisely what these 36
are. A user cannot tell a correct name from one missing an arsonic acid group without checking the
structure, which is the work the tool was supposed to do.

**The gap is narrow and specific, which makes step 3 (contribute fixes upstream) attractive.** The
failures are not diffuse inaccuracy; they are an unsupported-feature set — arsenic, isotope labels,
radicals — that falls through to omission instead of refusal. A change that makes unnameable features
decline rather than drop would move this from unusable to shippable-with-a-documented-gap, and it is a
change upstream would plausibly welcome.

**Root cause found, and it is narrower than the symptom** — see
`openclatura-upstream-report.md` for the filed-shaped write-up. In short: OpenClatura *already has* the
right check. `assert_component_fully_named` raises `UnnamedAtomError` when a name leaves atoms unnamed,
which is why phenylarsonic acid **as a parent** correctly declines. But it is called once, at component
level, and the recursive substituent namer (`name_subgraph`) never calls it — while `namer.py:919`
records `atom_ids=branch_atoms`, claiming the entire branch regardless of what its name covered. So an
unnameable feature inside a *substituent* is dropped and its atoms are still counted as named, which
satisfies the component-level audit.

That means the fix is applying an existing rule one level deeper, not writing new nomenclature — the
best possible shape for an outside contribution.

**Re-run before any adoption decision.** Upstream pushed the day this ran; these numbers describe
0.2.0 and nothing else.

## Reproducing

```bash
python3 -m venv .venv && .venv/bin/pip install openclatura   # pulls rdkit
./scripts/build-opsin-runtime.sh                             # the OPSIN side of the round-trip
.venv/bin/python tools/openclatura-benchmark/bench_name.py \
    <structures.smi> stage1.tsv
.venv/bin/python tools/openclatura-benchmark/bench_roundtrip.py stage1.tsv stage2.tsv
cut -f6 stage2.tsv | sort | uniq -c | sort -rn
```

RDKit canonicalisation here is the pip build (2026.3.4), not the vendored WASM (2026.03.3). It is used
only as a comparison oracle, never as a shipped number.
