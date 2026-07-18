# ADR-0026: Leakage-free accuracy benchmark — split by structure identity, score the production path

- **Status:** accepted (2026-07-12)
- **Source:** slice 2 of the post-M27 plan (user-directed); prerequisite M28 (reproducible rebuild)
- **Builds on:** [[0017-h1-coupling-and-full-corpus]] (corpus), [[0020-measured-j-needs-np-mrd-confidence-from-applicability]] (confidence = applicability), [[0023-source-backed-increment-refinement]] / [[0024-applicable-increments-always-visible]] (increment second opinion)

## Context

Until now every accuracy statement was either a spot check (strychnine vs SDBS, report 0023) or an
in-sample impression. The bundled database *contains* most molecules a user might test, so naive
self-prediction would grade the predictor on memorized answers. A defensible accuracy claim needs
held-out structures whose shifts never entered the database the predictor consults.

## Decision

1. **Split by structure identity, not by record.** Each raw NMReDATA record is keyed by its OCL
   idcode; a deterministic seeded FNV-1a hash of the idcode assigns *every* record of the same
   compound to the same side. Duplicate entries of one compound can therefore never straddle the
   split — the classic leakage hole in record-level splits. Unparseable records stay in train
   (they cannot be scored).
2. **Train-only database, production configuration.** The reference database is compiled from the
   train side only, with the shipped `n ≥ 5` prune (M28) and the same aggregation as the bundled
   artifact. Nothing about thresholds, spheres, or statistics is tuned against the held-out set.
3. **Score the production lookup itself.** Held-out assignments are evaluated through the exported
   `matchEnvironment` + `shiftFor` (the exact functions `OclHosePredictor` calls), with the same
   deepest-sphere-first code derivation used at ingestion, and the confidence tier mirrors the
   production rule (low: sphere ≤ 1 or n < 3; high: sphere ≥ 3 and n ≥ 8). A reimplementation of the
   lookup is forbidden — the benchmark must break when the product breaks.
4. **Coverage is a first-class result.** An assignment with no database match at any sphere counts
   as uncovered, not as an error of some substituted value. (In the product those atoms become
   disclosed rule estimates or omissions.)
5. **The ¹H additive-increment estimator is benchmarked on the same rows** where it is applicable,
   so "does the increment ever beat HOSE, and on which tier?" gets an empirical answer instead of a
   heuristic one.
6. **Reproducibility:** the run records the corpus SHA-256/bytes (M28 mechanism), seed, hold-out
   per-mille, prune threshold, and statistic. Same corpus + same parameters → same numbers.

## Consequences

- Results are honest for *NMRShiftDB2-like chemistry*; they say nothing about chemistry the corpus
  lacks. The benchmark measures the shipped lookup, not chemistry in general.
- Because held-out structures lose their own contributions, deepest-sphere coverage drops relative
  to the bundled database — the reported coverage is a *lower bound* on production coverage.
- CH₂ diastereotopic pairs appear as two assignments scored against one host prediction; the error
  correctly reflects the centroid approximation the product actually makes.
- The harness lives in the plugin (`providers/ocl/benchmark.ts`, `scripts/run-benchmark.ts`) with
  unit tests; the corpus itself is never committed (284 MB, and ODbL share-alike applies to the
  *compiled* artifact we ship, which is unchanged).
