# ADR-0018: Robust + honest ¹H — fallback estimates, per-peak provenance, split-peak rendering

- **Status:** accepted (2026-07-09) — user direction after an external (ChatGPT) review; "build it"
- **Builds on:** [[0017-h1-coupling-and-full-corpus]] (full corpus + first-order coupling)

## Context

After M15 the predictor still (a) **dropped** any environment the HOSE DB didn't cover — so a few
groups (tiny-molecule aldehydes/CH₂) silently vanished — and (b) drew each resonance as a single
stick, not the multiplet its couplings imply. The external review's "fastest visible improvement"
was: never silently drop a proton, mark estimates honestly, and draw first-order multiplets. Data
licensing was **cleared** by the user (this is a *free plugin*, not part of the core app, so CC BY-NC
and CC BY sources are fine) — but the engine work below is independent of and precedes the data work.

## Decision

1. **Functional-group fallback** (`providers/ocl/functionalGroupFallback.ts`). When the DB has no
   match, classify the host by OCL topology (aldehyde, aromatic, alkene/alkyne, C adjacent to
   O/N/halogen, α-to-carbonyl, generic sp³; carbonyl subtypes for ¹³C) and emit a **rule-estimated**
   resonance (with its computed multiplet) rather than dropping it. Aldehydes never disappear.
2. **Per-peak provenance.** `NmrPredictionEvidence.method` gains `"rule-estimated"`; estimated
   resonances carry it + a `rule-estimated` flag + wide uncertainty. The panel marks them — a "≈"
   prefix and `rule-estimated` in the shift table, a **dashed muted** stick in the figure — so a guess
   never reads as a measured `hose-fragment` match. A single `NMR_RULE_ESTIMATED` info notice summarizes.
3. **First-order split-peak rendering.** `LinkedFigureView` draws each resonance as first-order
   multiplet lines (recursive binomial splitting by its couplings; J Hz → ppm at an assumed 400 MHz),
   sub-pixel at full view and resolving as you zoom, capped at 32 lines (denser → single envelope).
4. **Coupling refinement.** The coupling engine now excludes labile O/N/S–H partners (exchange-
   decoupled), so e.g. ethanol's CH₂ is a quartet, not a quintet.

## Consequences

¹H is now **robust** (nothing silently drops), **honest** (estimates are visibly and structurally
marked, never conflated with measured data), and **visual** (multiplets are drawn, not just tabulated).
The estimates are deliberately coarse first-approximation values, flagged low-confidence.

**Next (unblocked by the licensing call):** an NP-MRD (CC BY-NC) / NMRexp (CC BY) provider for
*measured* multiplicities + J and broader assigned coverage — a separate data-ingestion milestone, not
a drop-in HOSE source (NMRexp is not atom-assigned). Rejected here: shipping that corpus now (multi-GB
ingestion + assignment layer, out of scope for this milestone).
