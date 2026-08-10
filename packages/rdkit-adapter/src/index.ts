import type {
  ChemistryAdapter,
  ChemistryAdapterCapabilities,
  ChemistryStructureFormat,
  ChemistryStructureInput,
  ChemistryWarning,
  StructureProperties,
  StructureValidationResult
} from "@chemdraft/chemistry-adapter";
import type { AnalysisResult, AnalysisRun } from "@chemdraft/analysis-core";

// Real RDKit ETKDGv3 3D conformer engine (custom MinimalLib WASM — see vendor/BUILD.md).
export * from "./conformer";

// Real RDKit structure analysis: composition, masses, identifiers, and named descriptors, each behind
// a method contract (PLANS.md §9 Release 1). Replaces the fixture-backed placeholder that shipped ten
// hardcoded SMILES with hand-entered masses — "a second implementation by another name" (§7).
export * from "./analysis";
export * from "./composition";
// The isotope envelope (PLANS.md §9 Release 2). Lives here rather than in `isospec-adapter` because it
// needs RDKit's composition and IsoSpec's distribution, so neither engine owns the method.
export * from "./envelope";
// Derived interpretations (PLANS.md §1): the largest-organic-fragment and neutralised views a method
// falls back to when the structure as drawn is outside its domain.
export * from "./interpretations";
export * from "./methods";

import type { AnalysisInputFormat, DetailedAnalysis } from "./analysis";
import { PINNED_RDKIT_VERSION } from "./methods";

// The legacy ChemistryAdapter shim lives in `./adapter` so it can be imported WITHOUT this barrel —
// `export * from "./analysis"` above reaches the pKa model, and an app that only wants an adapter
// should not pay 4.2 MB of JSON in its startup chunk for it. Re-exported here for existing callers.
export * from "./adapter";
