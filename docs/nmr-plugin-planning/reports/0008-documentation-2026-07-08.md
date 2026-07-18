# Report 0008: Documentation & provenance (M12) — 2026-07-08

Executed inline. Worktree `~/Documents/programming/chemdraw-nmr`, branch `codex/nmr-plugin`. Build stamp `7.8.12.42-opus`.

## Outcome

**Milestone 12 complete — Phase 1 is fully complete (M1–M10 + M12; M11 resolved).**
The plugin runtime, the NMR predictor, and its data/licensing are now documented
for maintainers and future plugin authors, reconciling the docs with everything
that shipped.

Validation:
- `pnpm lint`: clean.
- `pnpm test`: **1315 passed, 9 skipped** (unchanged — M12 is documentation + the build-stamp bump).
- `build:web`: unchanged from reports/0007 (docs + a stamp string only).

## What shipped

New architecture docs (`docs/architecture/`):
- **`plugin-runtime.md`** — the generic, domain-neutral runtime: layers, the persistent host, permission-gated capability APIs (selection/analysis/panels/documents), the declarative panel model, menu integration + drift test, the worker pattern + cross-package bundling, panel-close lifecycle (ADR-0012), the command error channel (ADR-0010), the canary, and extension points.
- **`nmr-predictor-plugin.md`** — the NMR package: layout, the `NmrPredictor` interface, both providers (OCL-native default + fixture), normalization, the command, the panel, and testing.
- **`nmr-prediction-data.md`** — prediction-data provenance: what ships and under what license, NMRShiftDB2 license handling (ADR-0014), disclosed provider limitations, the M11 rejection (ADR-0013), future data paths (NMRexp CC BY 4.0), and the provenance checklist.

Updated:
- **`docs/plugin-development/README.md`** — expanded from a stub into a plugin-author quickstart (model, "add a bundled plugin" steps, guidance) linking the architecture docs.
- **`examples/plugins/nmr-predictor/README.md`** — rewritten from M6-only to the full shipped feature (both providers, worker, data provenance, DB rebuild command).
- Build stamp → `7.8.12.42-opus` (`AGENTS.md` + `MainWindow.tsx`).

`THIRD_PARTY_NOTICES.md` and `providers/ocl/NMRSHIFTDB2_LICENSE.md` (shipped in M10)
already cover dependency + database licensing; this milestone cross-links them.

## The plan's M12 checklist

Covered: runtime architecture, canary plugin, generic APIs, predictor interface,
worker boundary, normalization, provider limitations, fixture-data status,
third-party dependency results (M11), database licensing status, future extension
points.

## Phase 1: done

All twelve milestones are complete (M11 = a valid "reject" outcome). The plugin
system is live, the NMR predictor works end to end on real experimental data with
honest provenance and uncertainty, every planned risk was retired, and every
deferred decision (ADRs 0008–0014) shipped. Remaining work is optional Phase-2
scope: broader databases (NMRexp), a native dynamic plugin menu, and third-party
(non-bundled) plugin isolation.
