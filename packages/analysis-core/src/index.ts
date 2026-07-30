/**
 * `@chemdraft/analysis-core` — the contracts the property & prediction suite is built on.
 *
 * Pure data and pure functions: no RDKit, no OpenChemLib, no worker, no DOM. Adapters produce these
 * types; the worker, the panel, and the provenance report consume them. Keeping the engines out is
 * what lets the contracts be validated, tested, and reasoned about without a 7.5 MB WASM load.
 *
 * The four pieces, and the PLANS.md section each implements:
 *   §1 `interpretation` — parse once, derive named interpretations, keep the atom mapping
 *   §2 `classification` — three display axes, three branchable flags
 *   §3 `results`        — the discriminated union, the run, schema versioning
 *   §5 `scheduler`, `session` — debounce, supersession, cancellation, and the session cache
 *   §10 `methodContract`, `propertyCorpus`, `invariance` — what keeps the UI and the science aligned
 */
export * from "./classification";
export * from "./interpretation";
export * from "./invariance";
export * from "./methodContract";
export * from "./propertyCorpus";
export * from "./provenance";
export * from "./results";
export * from "./scheduler";
export * from "./session";
export * from "./units";
