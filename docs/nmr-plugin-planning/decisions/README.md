# Decision log

One file per durable decision (ADR style). These exist so future plugins and
future sessions inherit the *why*, not just the rule — and so a decision can
be deliberately reversed instead of accidentally eroded.

Record a decision when: an assignment report resolves an open question, the
user overrules a recommendation, a plan/repo conflict gets settled, or a
"we'll do it the simple way for now" tradeoff is made that someone will later
be tempted to "fix" without context.

Statuses: `proposed` (recommendation awaiting validation or user sign-off) →
`accepted` → `superseded by ADR-NNNN`.

Open questions that are not yet decisions live in `STATUS.md` → "Open
decisions", keyed D-NN; when resolved they graduate to an ADR here.

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-planning-workspace-operating-model.md) | Planning-workspace operating model | accepted |
| [0002](0002-fixture-first-predictor.md) | Fixture-first predictor; Phase 1 success is architectural | accepted |
| [0003](0003-canary-first-runtime-bringup.md) | Canary-first runtime bring-up with molscribe-ocsr | accepted |
| [0004](0004-declarative-panel-reports.md) | Declarative panel reports, never plugin UI components | accepted |
| [0005](0005-analysis-records-session-only.md) | Analysis records are session-only derived data | accepted |
| [0006](0006-c13-default-h1-experimental.md) | ¹³C default, ¹H experimental, no fabricated shifts | accepted |
| [0007](0007-nmr-predictor-bounded-spike.md) | `nmr-predictor` is an optional bounded spike with kill criteria | accepted |
| [0008](0008-extend-existing-selection-api.md) | Extend the existing selection API; keep optional context properties | accepted |
| [0009](0009-analyze-menu-via-appmenu-model.md) | Analyze menu via the existing appMenu model + drift-test exclusion | accepted |
| [0010](0010-command-error-channel.md) | One canonical, user-visible command error channel | accepted & shipped (M8) |
| [0011](0011-no-command-arguments.md) | No command arguments; value-encoded command IDs | accepted |
| [0012](0012-panel-close-lifecycle.md) | Panel-close lifecycle + closed-panel report policy | accepted & shipped (M9) |
| [0013](0013-reject-nmr-predictor-package.md) | Reject the cheminfo `nmr-predictor` package (duplicate OCL + remote data) | accepted (M11) |
| [0014](0014-nmrshiftdb2-data-source.md) | NMRShiftDB2 as the M10 reference-shift database | accepted & shipped (M10) |
| [0015](0015-core-owned-interactive-panel-sections.md) | Core-owned interactive panel sections (`linkedFigure`): zoomable spectrum + annotated structure, data-only plugins | accepted (M13) |
| [0016](0016-plugin-native-menu-bridge.md) | Plugin commands in the native menu via a `plugin.`-prefix-routed bridge (core change in scope) | accepted (M14) |
| [0017](0017-h1-coupling-and-full-corpus.md) | Usable ¹H: full NMRShiftDB2 corpus (pruned, 6.1 MB) + first-order multiplicity/J estimation | accepted (M15) |
| [0018](0018-fallback-provenance-multiplet-rendering.md) | Robust/honest ¹H: functional-group fallback estimates, per-peak provenance, first-order split-peak rendering | accepted (M16) |
| [0019](0019-lossless-molfile-at-plugin-boundary.md) | Plugins receive a lossless molfile at the selection boundary, not the app's lossy hand-rolled SMILES (fused rings were predicted as straight chains) | accepted |
| [0020](0020-measured-j-needs-np-mrd-confidence-from-applicability.md) | Measured J requires a dedicated NP-MRD ingestion (NMRShiftDB2's export has none); prediction confidence is surfaced as applicability (sphere depth + n), never a fabricated score | accepted (forward half superseded by 0021) |
| [0021](0021-np-mrd-no-go-estimated-j-is-the-ceiling.md) | NP-MRD is a no-go for measured J (small/natural-product-biased/mostly-predicted); labelled topology-estimated J is the honest ceiling for a free lookup plugin | accepted |
| [0022](0022-increment-cross-check.md) | Additive-increment second opinion for low-confidence ¹H peaks — cross-check storage + absolute/σ threshold, not % | accepted; presentation superseded by 0023 |
| [0023](0023-source-backed-increment-refinement.md) | Source-backed v1.2 increment refinement, high-dispersion eligibility, and HOSE-first comparison | accepted |
| [0024](0024-applicable-increments-always-visible.md) | Every applicable increment is visible while HOSE remains primary | accepted (M25) |
| [0025](0025-confidence-free-spectrum-trace.md) | The spectrum trace is confidence-blind (uniform curves + labels); confidence renders in structure labels/table/notices; method provenance still restyles the trace | accepted (M27) |
| [0026](0026-leakage-free-benchmark-protocol.md) | Leakage-free benchmark: split by structure identity (idcode), train-only DB at production config, score the exported production lookup; coverage first-class; increment benchmarked on the same rows | accepted (M29) |
| [0027](0027-core-owned-plugin-manager.md) | Core-owned plugin manager; disable means unregister; local persistence; package installation deferred | accepted (M32) |
| [0028](0028-plugin-extraction-architecture.md) | Plugin extraction: single-package SDK boundary (plugin imports only `@chemdraft/plugin-api`), machine-enforced guard, source-distribution zip, documented core-enablement patch; runtime loader deferred | accepted (M33) |
