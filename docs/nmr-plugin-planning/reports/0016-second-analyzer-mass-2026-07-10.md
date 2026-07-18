# Report 0016 — M19a: a real second analyzer proves the infra is domain-agnostic

**Date:** 2026-07-10
**Worktree:** `~/Documents/programming/chemdraw-nmr` @ `codex/nmr-plugin`
**Validates:** [ADR-0004](../decisions/0004-declarative-panel-reports.md) (declarative reports) +
[ADR-0005](../decisions/0005-analysis-records-session-only.md) / M5 (generic analysis store)

## Goal

The overarching intent is *maximum extensibility*, but only the NMR plugin exercised the generic
host/analysis/panel APIs — so "generic" was asserted, not demonstrated. M19a builds
`examples/plugins/mass-fragment-demo` (previously a placeholder README) into a **real, non-NMR
analyzer** to prove the infrastructure isn't NMR-shaped.

## What shipped (`@chemdraft/plugin-mass-fragment`)

A mass-spectrometry analyzer for the selected structure:

- **Molecular formula** (Hill) + **monoisotopic** and **average** mass (OpenChemLib).
- **Common ESI adduct m/z** — `[M+H]⁺ [M+Na]⁺ [M+NH₄]⁺ [M+K]⁺ [M+H−H₂O]⁺ [M−H]⁻`.
- **First-order isotope pattern** (M/M+1/M+2) from ¹³C/¹⁵N and ³⁷Cl/⁸¹Br/³⁴S abundances — a labelled
  approximation, not a full convolution.

Verified end-to-end: caffeine `C8H10N4O2`, `[M+H]⁺` 195.0877; bromobenzene **M+2 97.45%** (the ⁸¹Br
signature); aspirin `C9H8O4` 180.0423.

## Why it proves the point

- Registering it is **one import + one `registerPlugin` call** in `registerBundledPlugins.ts` — no
  change to the host, the report renderer, or the menu adapter.
- The command walks the **identical generic path** as NMR — `selection.getSelection` → compute →
  `analysis.write` (a `mass.forward-analysis` record) → `panels.showReport` — and carries a `source`
  ref so the desktop staleness banner (D-09) works unchanged.
- It is deliberately **unlike** NMR: synchronous, in-thread, no worker, no reference database, zero
  spectroscopy concepts. Two very different analyzers on one unmodified API surface is the proof.
- OCL is dynamically imported so the mass code code-splits (a 1.67 kB chunk); no new main-bundle
  bloat, no database in main.

## Files

New package `examples/plugins/mass-fragment-demo/` (manifest, `massAnalysis`, `composeMassReport`,
`application/analyzeSelectedStructureMass`, `register`, index, README) + 3 test files (13 tests).
Desktop: `registerBundledPlugins.ts` (+ workspace dep). Build stamp `7.9.14.13-opus`.

## Verification

`pnpm lint` clean; `pnpm test` → **1360 passed** (+13); web + Tauri build OK; OCL confirmed
code-split (mass chunk 1.67 kB; the reference DB stays in the NMR worker chunk).
