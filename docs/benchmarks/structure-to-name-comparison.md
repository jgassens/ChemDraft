# Structure→name engines compared: Orthonym 1.0.8, OpenClatura 0.4.3, OpenClatura 0.2.0

Run 2026-10-21. This repeats the August benchmark (`openclatura-structure-to-name.md`) with the same
corpus, the same oracle, and the same scoring, on three engines:

| Engine | Licence | Pinned to | Notes |
|---|---|---|---|
| **Orthonym 1.0.8** (`Steinbeck-Lab/Orthonym`) | MIT | tag `v1.0.8` = commit `461987b947f76e41ff0baa6c2aa19ecd79cacd0b` | PyPI wheel byte-identical to the tag's `src/orthonym` |
| **OpenClatura 0.4.3** (`lamalab-org/openclatura`) | MIT | commit `ca79ac8e04f8cfe67f9064825da3851ef0d8f707` ("release: prepare 0.4.3", 2026-10-13) | no git tag exists; PyPI wheel byte-identical to that commit's `src/openclatura`; `main` is 5 commits later, changing only the changelog, a GIF and a website script |
| **OpenClatura 0.2.0** (control) | MIT | commit `db7d1d46c67b64fbb0caa588863d8af7a6b30e7c` ("Bump version from 0.1.5 to 0.2.0") | still installs from PyPI; wheel byte-identical to that commit |

**The August version mismatch is explained.** At `db7d1d46` the pyproject says `0.2.0` but
`src/openclatura/__init__.py` hard-codes `__version__ = "0.1.5"`, so pip and the package disagreed. 0.4.3
reads its version from a generated `_version.py`, and both strings now say `0.4.3`. Pinning by commit
still stands: OpenClatura publishes no tags for 0.2.0, 0.4.2 or 0.4.3.

Orthonym ran at two of its emit tiers:

- **default**: it returns a name only when its preferred-IUPAC-name (PIN) path built the name and OPSIN
  verified it. There are a few marked exceptions, such as names from exact-match lists and stereodescriptors
  OPSIN cannot parse.
- **valid** (`general_fallback=True`, the CLI's `--emit-tier valid`): this also returns OPSIN-verified
  systematic names that are not the PIN.

A plugin would choose between them, so both are reported.

## Method

The method is unchanged from August. See `tools/structure-to-name-benchmark/README.md`. The harness was
`tools/openclatura-benchmark/`; it was moved with `git mv` and generalised with `--namer
{openclatura,orthonym}`.

- **Corpus:** RDKit `Data/NCI/first_5K.smi`, 4,999 NCI compounds. The file is identical, by SHA-256, in
  every RDKit build used here. The 26-entry `adversarial.smi` set was also run.
- **Oracle:** each name goes through ChemDraft's vendored OPSIN 2.9.0
  (`apps/desktop/src-tauri/resources/opsin/opsin-cli-2.9.0.jar`, on its bundled JRE). RDKit canonical
  SMILES is then compared at both ends, under the August rule: `round-trip`, `stereo-lost`, `MISNAMED`,
  `name-unparseable`, `declined`, `error`.
- **Scoring RDKit:** 2026.03.4, the same build as August, in a separate venv. Both ends are now
  canonicalised in that venv, because the namers bring their own RDKit builds (OpenClatura 2026.09.1,
  Orthonym its pinned 2026.03.5). In August both stages already shared one RDKit, so this does not change
  the rule.
- **The control reproduces August exactly:** 4,721 round-trip / 207 declined / 36 MISNAMED / 27
  unparseable / 8 error. The numbers below are therefore directly comparable with August.
- **Orthonym's own OPSIN check** used the same vendored jar (`ORTHONYM_OPSIN_JAR`). That jar differs from
  the upstream OPSIN release only by code signing, as `BUILD.md` records. Orthonym's CIP labeller jar
  (centres 1.2.1) was fetched once with curl and matched Orthonym's pinned SHA-256. All runs used
  throwaway venvs under `$TMPDIR`, which were deleted afterwards.

**One correction to August.** The 8 `error` rows are not exceptions raised by a namer. They are 8 corpus
SMILES that RDKit itself cannot parse (ids 2110, 2917, 3249, 3402, 4563, 4650, 4651, 4844), and they are
the same 8 for every namer. August's "raised an exception: 8" should read "corpus SMILES RDKit cannot
read: 8". OpenClatura 0.2.0 raised nothing.

## Headline: NCI, 4,999 structures

| Outcome | OC 0.2.0 (control) | OC 0.4.3 | Orthonym default | Orthonym valid |
|---|---:|---:|---:|---:|
| Round-trip exact | 4,721 (94.4%) | 4,797 (96.0%) | 3,413 (68.3%) | **4,821 (96.4%)** |
| …as % of names produced | 98.7% | 99.7% | **99.97%** | 99.9% |
| Declined | 207 (4.1%) | 178 (3.6%) | 1,577 (31.5%) | 165 (3.3%) |
| **MISNAMED** | **36 (0.72%)** | **14 (0.28%)** | **0** | **4 (0.08%)**, all a resonance form of the drawn ion (same standard InChI) |
| Name OPSIN could not parse | 27 | 2 | 1 (a correct radical name) | 1 (the same) |
| Error (corpus SMILES RDKit cannot read) | 8 | 8 | 8 | 8 |
| Stereo-lost | 0 | 0 | 0 | 0 |
| Throughput | 84/s | 119/s | 32/s | 25/s |
| Per structure: median / p95 / max | 10.6 ms / 22 ms / 0.21 s | 4.3 ms / 19 ms / 2.1 s | 15 ms / 90 ms / 3.8 s | 25 ms / 108 ms / 2.1 s |

The timings come from an Apple M1 Pro. The first three stage-1 runs ran at the same time, as three
processes, and the valid tier ran alone. Orthonym's time includes its in-process OPSIN check, and its
first call starts the JVM, which takes about 1 s. No structure hit the 20 s timeout.

What each column means for a user:

- **OpenClatura 0.4.3** has halved its misnames since 0.2.0 (36 → 14) and almost eliminated unparseable
  names (27 → 2). It still emits **14 confident, OPSIN-readable names for the wrong compound**.
- **Orthonym's default tier** misnamed nothing. It pays for that by declining almost a third of the
  corpus. Of its 1,577 declines, 1,094 are `UNNAMEABLE`, 332 are `NO_VERIFIED_PIN` (it built a valid name
  that is not a certified PIN) and 151 are `UNSUPPORTED_ELEMENT`. These breakdowns come from raw run
  files not committed to the repo; regenerate them by rerunning the benchmark harness above and
  inspecting its stage-1 output.
- **Orthonym's valid tier** has the best coverage of any engine. Its 4 "misnames" are not wrong
  compounds: each is the same delocalised cation with the positive charge drawn on the other nitrogen (see
  [Where Orthonym's own check and the oracle disagree](#where-orthonyms-own-check-and-the-oracle-disagree)).

## (a) Every structure any engine misnamed

There are 44 structures. "Dropped" means OPSIN's structure has fewer atoms than the input (counting
hydrogens and isotopes), "invented" means it has more, "same formula" means the connectivity differs,
"both" means atoms changed in both directions, and "same InChI" means the standard InChI is identical
(a resonance form, a mobile-H tautomer, or a zwitterion read as neutral). Full names are in
`structure-to-name-data/nci/misnamed-any.csv`.

| id | input | OC 0.2.0 | OC 0.4.3 | Orthonym default | Orthonym valid |
|---:|---|---|---|---|---|
| 375 | `CCCCOc1ccc(NC[S](=O)=O)cn1` | **MISNAMED** (dropped) | **MISNAMED** (dropped) | unparseable | unparseable |
| 577 | `c1ccc2c(c1)[I]c1ccccc1-2` | **MISNAMED** (invented) | **MISNAMED** (invented) | declined | declined |
| 676 | `O=C(O)CCC(=O)OOC(=O)CCC(=O)O` | **MISNAMED** (both) | round-trip | declined | round-trip |
| 1125 | `O=[As](O)(O[As](=O)(O)c1ccccc1)c1ccccc1` | declined | **MISNAMED** (dropped) | declined | round-trip |
| 1126 | `C1C[S+]2CC[S+]1CC2` | **MISNAMED** (invented) | round-trip | declined | round-trip |
| 1462 | `Fc1ccc([I]c2ccc(F)cc2)cc1` | **MISNAMED** (invented) | **MISNAMED** (invented) | declined | declined |
| 1613 | `CC(CCC(=O)O)C1CCC2(C)C3CCC4C(C)(C)C(O)CCC4(C)C3C(=O)CC12C` | **MISNAMED** (same formula) | round-trip | declined | round-trip |
| 1760 | `NNC(=O)CCc1ccc2ccc3ccccc3c2c1` | **MISNAMED** (same formula) | round-trip | declined | round-trip |
| 1840 | `OCc1cc2ccccc2c2ccccc12` | **MISNAMED** (same formula) | round-trip | declined | round-trip |
| 1910 | `C[As](C)(=O)O` | declined | **MISNAMED** (dropped) | round-trip | round-trip |
| 1929 | `COc1ccc2cc(C(C)=O)c3ccccc3c2c1` | **MISNAMED** (same formula) | round-trip | declined | round-trip |
| 1930 | `O=C(O)C=Cc1cc2ccccc2c2ccccc12` | **MISNAMED** (same formula) | round-trip | declined | round-trip |
| 2050 | `NC(=O)CNc1ccc([As](=O)(O)O)cc1` | **MISNAMED** (dropped) | round-trip | round-trip | round-trip |
| 2052 | `CCN(CC)CC(O)c1ccc2ccc3ccccc3c2c1` | **MISNAMED** (same formula) | round-trip | declined | round-trip |
| 2072 | `CCC(=O)c1ccc2ccc3ccccc3c2c1` | **MISNAMED** (same formula) | round-trip | declined | round-trip |
| 2086 | `CCN(CC)CCC(=O)c1ccc2ccc3ccccc3c2c1` | **MISNAMED** (same formula) | round-trip | declined | round-trip |
| 2607 | `CCCCCCCCCCCC(=O)[O][Sn]([CH2]CCC)([CH2]CCC)[O]C(=O)CCCCCC…` | declined | **MISNAMED** (dropped) | declined | round-trip |
| 2670 | `O=[PH](O)c1ccccc1` | **MISNAMED** (same formula) | round-trip | declined | round-trip |
| 2891 | `O=S(=O)(O)c1ccc(-c2ccc([As](=O)(O)O)cc2)cc1` | **MISNAMED** (dropped) | round-trip | declined | round-trip |
| 2930 | `O=C(O)C=Cc1c2ccccc2cc2ccccc12` | **MISNAMED** (same formula) | round-trip | declined | round-trip |
| 2931 | `c1ccc(N=NC(=NNc2ccccc2)c2ccccc2)cc1` | **MISNAMED** (invented) | **MISNAMED** (invented) | round-trip | round-trip |
| 3089 | `CN(C)c1ccc2nc3ccc(N(C)C)cc3[s+]c2c1` | **MISNAMED** (invented) | **MISNAMED** (invented) | declined | round-trip |
| 3090 | `CN(C)c1ccc(C(=C2C=CC(=[N+](C)C)C=C2)c2ccc(N(C)C)cc2)cc1` | **MISNAMED** (dropped) | round-trip | declined | round-trip |
| 3091 | `CC[N+](C)(C)c1ccc(C(=C2C=CC(=[N+](C)C)C=C2)c2ccc(N(C)C)cc…` | **MISNAMED** (dropped) | round-trip | declined | round-trip |
| 3140 | `NNC(=O)C(CC(C(=O)NN)C(=O)NN)C(=O)NN` | round-trip | **MISNAMED** (dropped) | declined | round-trip |
| 3247 | `CC(=O)Nc1cc([As](=O)(O)O)ccc1O` | **MISNAMED** (dropped) | round-trip | round-trip | round-trip |
| 3250 | `CCN(CC)c1ccc2nc3c(cc(N)c4ccccc43)[o+]c2c1.O=S(=O)([O-])O` | **MISNAMED** (invented) | **MISNAMED** (invented) | declined | round-trip |
| 3545 | `O=S(=O)(Nc1ccc(-c2ccccc2)cc1)c1ccc([As](=O)(O)O)cc1` | **MISNAMED** (dropped) | round-trip | declined | round-trip |
| 3873 | `Cc1ccc(S(=O)(=O)[O-])cc1.Oc1cc(-[n+]2ccc3ccccc3c2)c(O)c2c…` | **MISNAMED** (dropped) | **MISNAMED** (dropped) | declined | round-trip |
| 4003 | `NC(=O)CNCc1ccc([As]=O)cc1` | **MISNAMED** (both) | round-trip | declined | round-trip |
| 4189 | `CN(C)c1ccc(N=Nc2ccc([As](=O)(O)O)cc2)cc1` | **MISNAMED** (dropped) | round-trip | round-trip | round-trip |
| 4252 | `CCc1cc[c-](C)[n+](=O)c1` | **MISNAMED** (invented) | round-trip | declined | round-trip |
| 4318 | `CCN(Cc1cccc(S(=O)(=O)O)c1)c1ccc(C(=C2C=CC(=[N+](CC)Cc3ccc…` | **MISNAMED** (dropped) | round-trip | declined | round-trip |
| 4319 | `CCN(Cc1cccc(S(=O)(=O)[O-])c1)c1ccc(C(=C2C=CC(=[N+](CC)Cc3…` | round-trip | round-trip | declined | **MISNAMED** (same InChI) |
| 4431 | `Cc1cc2ccccc2n1C=CC1=[N+](C)c2ccccc2C1(C)C` | round-trip | round-trip | declined | **MISNAMED** (same InChI) |
| 4434 | `Cn1c(-c2ccccc2)c(C=CC2=[N+](C)c3ccccc3C2(C)C)c2ccccc21` | round-trip | round-trip | declined | **MISNAMED** (same InChI) |
| 4655 | `CC1=[O+][Mg]2([O+]=C(C)C1)[O+]=C(C)CC(C)=[O+]2` | **MISNAMED** (both) | round-trip | declined | declined |
| 4719 | `CC(=O)Oc1c2ccccc2c(OC(C)=O)c2ccccc12` | **MISNAMED** (same formula) | round-trip | declined | round-trip |
| 4836 | `CCOC(=O)COC(=O)c1ccccc1C(=O)OC` | **MISNAMED** (same formula) | round-trip | declined | round-trip |
| 5010 | `CCN(CC)c1ccc(C(=C2C=CC(=[N+](CC)CC)C=C2)c2cc(O)c(S(=O)(=O…` | **MISNAMED** (dropped) | **MISNAMED** (invented) | declined | round-trip |
| 5011 | `CCN(CC)c1ccc(C(=C2C=CC(=[N+](CC)CC)C=C2)c2ccccc2)cc1.O=S(…` | **MISNAMED** (dropped) | **MISNAMED** (invented) | declined | round-trip |
| 5016 | `CCN(Cc1cccc(S(=O)(=O)[O-])c1)c1ccc(C(=C2C=CC(=[N+](CC)Cc3…` | round-trip | round-trip | declined | **MISNAMED** (same InChI) |
| 5017 | `CCN(Cc1ccccc1)c1ccc(C(=C2C=CC(=[N+](CC)Cc3ccccc3)C=C2)c2c…` | **MISNAMED** (dropped) | **MISNAMED** (invented) | declined | round-trip |
| 5018 | `CCN(Cc1cccc(S(=O)(=O)O)c1)c1ccc(C(=C2C=CC(=[N+](CC)Cc3ccc…` | **MISNAMED** (dropped) | round-trip | declined | round-trip |

The table shows four things.

- **Orthonym never misnamed a structure in the sense that matters.** Neither tier ever names a
  structure with a different InChI. Every structure that OpenClatura of either version misnamed, Orthonym
  either named correctly or declined. In `375` the correct name is a radical name, which only OPSIN `-r`
  reads.
- **OpenClatura 0.4.3 still drops atoms silently.** It drops atoms in 6 structures and invents them in 8.
  The worst cases are new in 0.4.3: three structures that 0.2.0 declined, and one it named correctly,
  are now misnamed.
  - `2607` dibutyltin dilaurate → **"1-hydroxydodecan-1-one"**. The tin, both butyl groups and one
    laurate vanish, so the name describes lauric acid.
  - `1910` cacodylic acid `C[As](C)(=O)O` → "(methylarsinoyl)methane". The OH is lost, and OPSIN reads
    the name as `C[AsH](=O)C`.
  - `1125` arsenic anhydride: one As–OH is lost the same way.
  - `3140`: this round-tripped in 0.2.0 and **regressed** to the ambiguous
    "2,4-diaminocarbamoylpentanedihydrazide".
  - In 4 dye salts a proton is invented and a charge lost. In 2 of them (`3250`, `5011`) the
    hydrogen-sulfate counter-ion becomes "sulfuric acid"; in the other 2 (`5010`, `5017`) the internal
    sulfonate becomes "sulfonic acid".
- **Arsenic is mostly fixed in OpenClatura, not entirely.** It now round-trips 17 of 20 As compounds (it
  was 0), misnames 2 and declines 1. All 6 arsenic compounds that 0.2.0 misnamed now round-trip.
  August's text says 7; its own element table, and this re-run, say 6.
- **The engines fail independently.** No structure was misnamed (by different InChI) by both OpenClatura
  and Orthonym. Hypervalent iodine (`577`, `1462`) is the boundary: OpenClatura names it wrongly in both
  versions, and Orthonym declines it in both tiers.

## (b) Independent check against PubChem's IUPAC names

PubChem's IUPAC name comes from a different name generator. That generator shares neither code nor an
OPSIN validation step with either engine, so PubChem is a check that does not route through OPSIN. The
method, in `pubchem_check.py`:

1. Take a seeded random sample (seed 20261021) of names that round-tripped.
2. Look up each input's InChIKey through PUG REST, one request at a time at most every 0.35 s, with every
   response cached in the temp directory.
3. Compare the strings, then read PubChem's name with the same OPSIN.

Results are in `structure-to-name-data/pubchem-*.csv`.

**Sample 1: 200 Orthonym default-tier names (verified PINs).** PubChem had a name for all 200.

| | n |
|---|---:|
| Exact string agreement | **119 (59.5%)**; ignoring case adds none |
| Different string, and PubChem's name parses (OPSIN) to the identical structure | 69 |
| PubChem's name parses to a different **tautomer** of the drawn structure | 11 |
| PubChem's name OPSIN cannot parse (`oxalic acid;urea`, a mixture written with a semicolon) | 1 |

- **The 69 differing names were read by hand, and every one is an alternative spelling of the same
  compound.** The differences are style, not structure:
  - enclosing marks: `2-[(carboxymethyl)sulfanyl]` vs `2-(carboxymethylsulfanyl)`;
  - explicit locants: `ethan-1-ol` vs `ethanol`, `2-(4-methoxyphenyl)acetonitrile` vs
    `(4-methoxyphenyl)acetonitrile`;
  - indicated hydrogen: `1H-pyrazolo[3,4-d]pyrimidine` vs `pyrazolo[3,4-d]pyrimidine`;
  - multiplicative names: `2,2'-disulfanediylbis(5-chloroaniline)` vs a substitutive name;
  - fusion-name choice: `dibenzo[b,d]furan` vs `dibenzofuran`, `2H-1-benzopyran` vs `2H-chromene`.

  None of the 69 is a name that a chemist following the IUPAC rules would read as a different
  compound. Some of PubChem's own spellings are the less correct ones; `pyrazolo[5,4-d]` for
  `pyrazolo[3,4-d]` is one example.
- **The 11 tautomer cases favour Orthonym.** PubChem's record is the tautomer it registered, for example
  `3-methyl-1H-pyridin-2-one` for a drawn `Cc1cccnc1O`, or `7H-purine` for a drawn 9H-purine.
  Orthonym's names (`3-methylpyridin-2-ol`, `9H-purine-2,6-diamine`) describe the tautomer that was
  actually drawn.
- **For scale, OpenClatura 0.4.3 on the same 200 structures** matched PubChem exactly 120 times, and its
  names equalled Orthonym's 151 times. String agreement therefore says nothing that separates the two
  engines on easy structures. What it does establish is that the PINs Orthonym verified through OPSIN
  are also conventional names to an outside generator, not names that only OPSIN accepts. These figures
  come from raw run files not committed to the repo; regenerate them by rerunning the benchmark harness above.

**Sample 2: 100 names only the valid tier adds** (structures the default tier did not name). PubChem
had 99 of them. Exact agreement was **6/99**. PubChem's names parsed to the same structure in 84 cases,
including the 6 exact string matches,
to a different tautomer in 11 (imine/amine, thiosemicarbazone/carbamimidothioic acid, hydroxy/oxo;
in each, Orthonym named the tautomer that was drawn), and not at all in 4 (salts and mixtures joined
with a semicolon). These are the harder
structures, and Orthonym's wider-tier names are structurally right but often unidiomatic:

- `(acetamidoamino)benzene` for N'-phenylacetohydrazide;
- `1-hydroxy-2-{…}benzene` where a chemist writes `…phenol`;
- von Baeyer names for fused rings: `3-azatetracyclo[12.4.0.0^2,7.0^8,13]octadeca-…-11-ol` for a
  phenanthro[9,10-b]pyridinol;
- `(3-oxo-3-phenyl-4-oxa-3λ6-thiabuta-1,3-dien-1-yl)benzene` for phenyl styryl sulfone;
- `1,3-dioxa-2-selenapropa-1,2-diene` for selenium dioxide.

OPSIN reads them all correctly, but a user would not recognise many of them.

## (c) The hand-checked cases

Every name below was read by hand, and the radical names were also read by OPSIN with radicals
enabled (`-r`).

| Case | OC 0.2.0 | OC 0.4.3 | Orthonym (both tiers) | Verdict |
|---|---|---|---|---|
| `[13CH3]C(=O)O` | "acetic acid" | "acetic acid" | **"(2-¹³C)acetic acid"** (`(2-13C)acetic acid`) | OpenClatura still deletes the label; Orthonym gives the correct isotopically substituted name |
| `[2H]C([2H])([2H])C(=O)O` | "acetic acid" | "acetic acid" | **"(²H₃)acetic acid"** | same |
| TEMPO `CC1(C)CCCC(C)(C)N1[O]` | "1-hydroxy-2,2,6,6-tetramethylpiperidine" | same | **"(2,2,6,6-tetramethylpiperidin-1-yl)oxyl"** | OpenClatura names the closed-shell hydroxylamine; Orthonym names the radical, and OPSIN `-r` reads it back exactly |
| Sulfonyl radical `375` | "…N-(sulfonylmethyl)…amine" | same | **"[(6-butoxypyridin-3-yl)amino]methanesulfonyl"** | correct radical name, read back exactly by OPSIN `-r` |
| Sodium benzoate | sodium benzoate | sodium benzoate | sodium benzoate | all correct |
| CaCl₂ | "calcium chloride chloride" | "calcium dichloride" | "calcium dichloride" | fixed in 0.4.3 |
| Glycine zwitterion `[NH3+]CC(=O)[O-]` | "2-ammonioacetate" | "2-ammonioacetate" | **"glycine"** | OpenClatura keeps the drawn charges. Orthonym names the neutral form: same compound, but the drawn formal charges are gone (§7) |
| Arsonic acids (`2050`, `3247`, `4189`) | group deleted | correct | correct | all fixed |
| Cacodylic acid `1910` | declined | **OH dropped** | "dimethylarsinic acid" | Orthonym correct |
| All 20 As compounds | 0 RT / 6 MIS / 14 dec | 17 / 2 / 1 | default 11 / 0 / 9; valid 20 / 0 / 0 | |
| Metals Cu, Co, Hg, Ni, Zn, Cd, Mn, Cr, Fe, Ce, Ti, Th, V, Zr, Pt; ferrocene, cisplatin | all declined | all declined (and Mg, Sn, Bi, Sb now named) | all declined except 3 Hg compounds (valid tier) and **ferrocene, which Orthonym names correctly** | no metal misnamed by Orthonym |
| Boron (18 NCI compounds) | 18 RT | 18 RT | default declines all 18; valid 18 RT | |

The adversarial set (26) scores 19 round-trip, 3 MISNAMED, 1 unparseable and 3 declined for both
OpenClatura versions. That is identical in outcome, though 0.4.3's names read better
(`phenylboronic acid`, `tetramethylsilane`). Orthonym default scores 19 / 1 (glycine) / 2 / 4, and
Orthonym valid scores 22 / 1 (glycine) / 1 / 2. With OPSIN reading radicals, TEMPO round-trips for
Orthonym.

## Stereo handling

**The NCI subset carries no stereochemistry at all**, so stereo evidence is the 11 adversarial cases and
nothing else. That is too little to support a claim, and a stereo-rich corpus is the first follow-up.

- **No engine lost or inverted a stereodescriptor anywhere** (stereo-lost: 0 in every run).
- R/S centres, E/Z alkenes, and (R,R), (S,S) and *meso* tartaric acid all round-trip in all four
  configurations. Orthonym uses retained names with D/L for amino acids (`D-alanine`), which OPSIN reads
  correctly.
- **Two adversarial labels are wrong.** The structure labelled `stereo-S-ibuprofen` is (R)-ibuprofen,
  and `stereo-L-alanine` is D-alanine; their partners are the reverse. All four configurations, OPSIN
  and RDKit's CIP labeller agree. The ids are kept as they are, for comparability with August.
- **Cyclohexane-1,2,3,4,5-pentol.** Every engine gives (1R,2R,3R,4S,5R), and RDKit's new CIP labeller
  independently agrees. OPSIN fails on it ("Failed to assign CIP stereochemistry"), so it scores
  unparseable. This is an OPSIN limit, not a naming error.
  - Orthonym's default tier still returns the name, honestly marked `tier=pin_unverified`,
    `opsin=verified_constitution_only`.
  - Its valid tier declines the same structure. The two tiers disagree with each other here.
- Orthonym's default tier declines the stereo ring amide (`NO_VERIFIED_PIN`). The valid tier names it
  `N-[(S)-1,2,3,4-tetrahydronaphthalen-2-yl]acetamide`.
- Orthonym's provenance row carries a `stereo_unexpressed` flag for a name that does not state a
  stereocentre the input has. It was never set in this run.

## Where Orthonym's own check and the oracle disagree

Orthonym's validation compares the **full standard InChIKey** of the input with that of OPSIN's reading
of the name (`_self_consistency_full_key` in `namer.py`). That is looser than this oracle's exact
canonical SMILES. The InChIKey normalises mobile hydrogens and charge-separated forms, so Orthonym
accepts a name for another resonance form, tautomer or protonation state of the drawn structure. Every
disagreement in the run comes from that difference or from an OPSIN flag:

| Where | Orthonym says | Oracle says | Who is right |
|---|---|---|---|
| Glycine zwitterion (adversarial) | `pin_verified`, `self_consistency_verified` | MISNAMED (`NCC(=O)O`) | Same compound. Under §7 the drawn formal charges are lost, so this must not ship silently |
| 4 dye cations (`4319`, `4431`, `4434`, `5016`; valid tier) | `systematic_verified`, `full_key_round_trip_verified` | MISNAMED | The same delocalised cation with the charge on the other nitrogen. Not a wrong compound, but not the drawing either |
| TEMPO, sulfonyl radical `375` | `pin_verified` | name-unparseable | Orthonym. The oracle runs OPSIN without `-r`, as in August, so it cannot read radical names |
| Cyclohexanepentol | `pin_unverified`, constitution only | name-unparseable | Orthonym's descriptors are right; OPSIN cannot assign CIP here. Orthonym flags the name as unverified rather than hiding that |

**Circularity, stated plainly.** Orthonym validates with OPSIN 2.9.0, and the oracle is OPSIN 2.9.0, run
here from the very same jar. Its 0 misnames on the oracle are therefore **largely by construction**: it
discards any name that OPSIN reads as something else, and this benchmark's question is whether OPSIN
reads the name as something else. What the oracle can still catch is the gap between Orthonym's InChIKey
equality and exact structure equality, and it caught all of it (the 4 rows above). It **cannot** catch a
name that Orthonym and OPSIN both misread the same way. Three pieces of evidence bear on that blind spot,
and none of them shares the OPSIN path:

1. The PubChem sample: 119/200 identical strings from an independent generator, and the other 69 were
   checked by hand as the same compound.
2. RDKit's CIP labeller agreeing on the stereodescriptors.
3. The hand checks in (c).

None of them found a shared misreading. They are a sample, not a proof. OpenClatura has no such
circularity: it does not consult OPSIN by default. Version 0.4.3 has an opt-in `verify_with_opsin`
through the `opsin` extra (py2opsin), which this benchmark did not use.

## Recommendation

**Orthonym is fit to be the engine of a ChemDraft naming plugin, provided ChemDraft re-validates every
name itself. OpenClatura 0.4.3 is not fit.** Under AGENTS.md §7 and §8, a decline is a feature and a
confident wrong name is the failure that matters. OpenClatura 0.4.3 still produces 14 such names in
4,999 structures, and it still deletes isotope labels and closes radicals. Orthonym produced none that
named a different compound, declines unsupported chemistry (organometallics, hypervalent iodine), and
names isotopes and radicals correctly. Whatever the oracle flagged was the same compound in a different
charge or resonance form, which ChemDraft's own check rejects.

Which tier:

- **Ship the valid tier.** Its names agree with this oracle on 4,821 structures, against the default
  tier's 3,413, and after the plugin's own check (rule 1 below) its 4 resonance-form names become
  declines.
- **Label what kind of name each one is.** Use Orthonym's `is_pin` and `tier` to say "preferred IUPAC
  name" or "systematic name (not the preferred name)", the way analysis results carry honest tiers (§8).
  Many valid-tier names are unidiomatic, so the label matters.

What the plugin must enforce, whatever Orthonym says:

1. **Re-validate with ChemDraft's own OPSIN, by exact structure.** Compare isomeric canonical SMILES, so
   formal charges, H placement, isotopes and stereo all count, against the drawn structure. Do not
   compare InChIKeys.
   - A name that fails is declined: "no verified name". This turns the glycine and dye-cation cases into
     declines, and it is the step that makes the plugin's guarantee independent of Orthonym's internals.
   - Run OPSIN with radicals enabled (`-r`) for this check. Exact equality already guarantees that a
     radical name is accepted only for a drawn radical.
2. **Refuse anything Orthonym did not fully verify.** That means `opsin` other than `verified`, tier
   `pin_unverified` or `best_effort`, any `carveout:*` gate outcome, and `stereo_unexpressed`. The
   cyclohexanepentol shows this matters: rule 1 cannot verify a name that OPSIN cannot read, so such a
   name must be declined, not trusted.
3. **Isotopes and radicals follow from rule 1.** They are named only when the round trip reproduces the
   label or the unpaired electron exactly. OpenClatura would fail this on every labelled compound.
4. **Declines carry Orthonym's reason** (`limit_code`: `UNSUPPORTED_ELEMENT`, `UNNAMEABLE`, and so on),
   per §8: unavailable and not-asked-for must look different.
5. **Stereo:** make no stereo claim beyond these 11 cases until a stereo corpus has been run through the
   same harness.

Costs and licence issues to settle before building it:

- **Runtime.** Orthonym is Python with exact pins (`rdkit==2026.3.5`, `jpype1==1.7.1`, `lxml==6.1.3`), an
  in-process JVM through JPype, and two jars. It is about 15 MB of Python (`namer.py` alone is 11,500
  lines). A TypeScript port is not realistic, so it would run as a locally installed engine.
  - The model for that is the MolScribe OCSR plugin: installed on explicit user action, run as a native
    process, `native.execute` declared (§4.1).
  - It can reuse ChemDraft's vendored JRE and OPSIN jar, as this run did.
- **Licences.**
  - Orthonym, OpenClatura and OPSIN are MIT.
  - **The OPSIN jar bundles jna-inchi (LGPL-2.1) and JNA.** `jna-inchi-core` and its `libjnainchi`
    natives are inside `opsin-cli-2.9.0.jar`. ChemDraft already ships this jar, and the dependency table
    in `apps/desktop/src-tauri/resources/opsin/BUILD.md` lists six permissive libraries and omits
    jna-inchi. That table and `NOTICE` should be checked regardless of this plugin.
  - **The centres jar (CIP labelling) is mixed.** centres itself is BSD-2-Clause by its LICENSE file,
    although its Maven POM says LGPL-3.0. The shaded jar bundles **CDK 2.9 (LGPL-2.1-or-later)** and
    **javax.vecmath (GPL-2.0 with the Classpath Exception)**.
  - Orthonym ships neither jar and downloads them, checksum-pinned, on first use. A ChemDraft plugin
    should do the same, or redistribute the unmodified jars separately with their notices and a source
    offer. They must never be merged into ChemDraft's Apache-2.0 core.
- **Maturity.**
  - Orthonym's repository was created 2026-09-29 and has published 8 releases in about three weeks. Pin
    it by commit and re-run this benchmark on every upgrade.
  - OpenClatura is more established (93 stars against 10), but it is also moving fast, and 0.4.3
    introduced new misnames (`2607`, `1910`, `1125`, `3140`) while fixing old ones.

## Data

`structure-to-name-data/` holds the summary files. The raw per-structure NCI files (4.2 MB) are not
committed; re-run the harness to regenerate them.

- `nci/summary.csv` and `adversarial/summary.csv`: the headline tables.
- `nci/outcomes.csv`: every structure's outcome under every engine.
- `nci/misnamed-any.csv`: the table above, with every engine's name.
- `nci/elements.csv`: outcomes per element outside C H N O S P and the halogens.
- `nci/provenance.csv`: Orthonym's own verdict crossed with the oracle's.
- `adversarial/stage2-*.tsv`: raw per-structure results for the adversarial set.
- `pubchem-orthonym-default-sample200.csv` and `pubchem-orthonym-valid-only-sample100.csv`.

The misname categoriser is now committed in `compare.py`; August's was not. It reproduces August's
"atoms dropped" count (14) for 0.2.0 and splits the rest as 12 same formula / 7 invented / 3 both,
against August's 12 / 1 / 9. The difference is hydrogen counting.

A secondary score with OPSIN reading radicals (`bench_roundtrip.py --allow-radicals`) changes two
things. Orthonym's 2 radical names become round-trips. Three of OpenClatura 0.2.0's unparseable names
become MISNAMED: H-phosphonates named `…phosphoryl…`, which OPSIN `-r` reads as P-centred radicals.
Nothing else changes.
