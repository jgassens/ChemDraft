# ADR-0022: Additive-increment second opinion for low-confidence ¹H peaks (cross-check, not silent replace)

- **Status:** accepted (2026-07-11); eligibility Decision 2 superseded by ADR-0024; presentation section 3 superseded by ADR-0023
- **Builds on:** [[0018-fallback-provenance-multiplet-rendering]] (rule-estimated fallback), [[0021-np-mrd-no-go-estimated-j-is-the-ceiling]] (estimates labelled as estimates)

## Context

The HOSE predictor is ~96% high/med confidence, but the low-confidence tail (shallow-sphere / sparse
matches, e.g. a benzylic CH on a PAH) is exactly where a user comparing against ChemDraw notices
divergence. ChemDraw uses **additive increments** (parent base + tabulated substituent corrections);
HOSE uses the **median of measured spectra**. Where HOSE is weak, a second independent estimate is a
genuine cross-check.

## Decision

1. **Build a real additive-increment ¹H estimator** (`incrementEstimator.ts`): aromatic H = 7.26 + Σ
   ortho/meta/para substituent increments; aliphatic = Shoolery `0.23 + Σσ`; aldehyde/vinyl/alkyne reuse
   the coarse class bases. Standard tabulated values (Pretsch/Bühlmann/Badertscher; Shoolery), validated
   against literature. It also **upgrades the M16 rule-estimated fallback** (no HOSE match → increment
   value, not the flat class value).

2. **Cross-check, never silent replace of the data.** For **low-confidence** HOSE matches only
   (sphere ≤ 1 or n < 3) compute the increment and flag `disagrees` when the two differ beyond
   **max(0.4 ppm, 1.5σ)** — a genuine outlier relative to the environment's own measured scatter. The
   HOSE median stays the resonance's `deltaPpm`; the increment rides along as `crossCheck`.
   - **Percentage thresholds were rejected:** ppm is TMS-referenced (arbitrary zero), so "30% different"
     is physically meaningless near 0. Absolute + σ-scaled is the chemically sound bar.
   - **Silent replacement was rejected as the sole behavior:** the increment isn't always the better
     number (a PAH benzylic CH is a case where HOSE was more physical), so we never hide a value.

3. **Presentation (superseded by ADR-0023):**
   - The **table always shows both** transparently: `… · vs inc 6.99` on a disagreeing row. It does not
     toggle (the detail view never hides a number).
   - The **figure** defaults to **replace** (draws the disagreeing peak at the increment ppm, labelled
     with a subscript `ᵢ`) with an **"Uncertain peaks: Prefer increment | Show both"** toggle; "Show both"
     draws the HOSE and increment peaks side by side.

## Consequences

- The low-confidence tail now carries an interpretable second opinion; genuine method disagreements are
  surfaced, not buried. Confirmed firing on real outliers (naphthylpropanal benzylic CH, dichloro­
  acetophenone CHCl₂) while agreeing (no flag) where HOSE and increments concur.
- The increment estimate is a **rule estimate, surfaced as such** — brown `ᵢ` label, "vs inc" table note,
  never conflated with the measured `hose-fragment` value.
- Known limits (accepted): CH₃ runs a touch low (Shoolery is a CH₂ scheme); fused-PAH aromatic increments
  are approximate (benzene base). Both are the low-confidence regime anyway. Threshold constants
  (0.4 ppm, 1.5σ) are tunable in one place.
