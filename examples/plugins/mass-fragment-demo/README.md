# Mass / m/z Analyzer (`@chemdraft/plugin-mass-fragment`)

A second, deliberately **non-NMR** analyzer whose job is to prove the ChemDraft plugin
infrastructure is domain-agnostic. It reads the same selection, writes the same generic analysis
store, and renders the same declarative panel report as the NMR predictor — with zero spectroscopy
concepts, no worker, and no reference database.

For the selected molecule it computes:

- **Molecular formula** (Hill notation) and **monoisotopic** + **average** mass (via OpenChemLib).
- **Ion m/z** — common ESI adducts (`[M+H]⁺`, `[M+Na]⁺`, `[M+NH₄]⁺`, `[M+K]⁺`,
  `[M+H−H₂O]⁺`, `[M−H]⁻`) for neutral structures; an already charged structure instead reports
  its native `[M]` ion and net charge, without inventing neutral-precursor adducts.
- The **isotope envelope**, computed by the *host* through the `chemistry.compute` capability and
  rendered with the engine, truncation policy, and abundance conventions that produced it. The plugin
  does not compute it: it used to ship a first-order M/M+1/M+2 estimate over an eight-element abundance
  table with no recorded source, which was retired on 2026-07-30. Where the host cannot answer — no
  engine, or a structure the engine declines — the panel says so rather than falling back to an
  estimate.

## What it demonstrates

Registering it is *one import + one `registerPlugin` call* in
`apps/desktop/src/plugins/registerBundledPlugins.ts` — no changes to the host, the report renderer,
or the menu adapter. The command walks the identical generic path as NMR
(`selection.getSelection` → compute → `analysis.write` → `panels.showReport`), so the contrast —
a light, synchronous, in-thread analyzer beside the worker-backed NMR one — is the point.

## Layout

- `manifest.ts` — Analyze command / menu / panel / analyzer contributions.
- `massAnalysis.ts` — pure `analyzeMass(structure)` (the only OpenChemLib user; dynamically imported
  by the command so it code-splits out of the desktop's main bundle).
- `composeMassReport.ts` — `MassReport` → declarative `PluginPanelReport`.
- `application/analyzeSelectedStructureMass.ts` — the command flow.
- `register.ts` — `createMassRegistration()` for `host.registerPlugin`.
