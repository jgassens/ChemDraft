/**
 * Everything a caller can want from this package WITHOUT loading the chemistry engine.
 *
 * The barrel does `export * from "./analysis"`, and `analysis.ts` reaches `pkaGnn.ts`, which
 * statically imports a 4.2 MB JSON model. So a module that only wanted `PINNED_RDKIT_WASM_SHA256`
 * pulled the entire pKa network into the app's startup chunk — measured at 7.43 MB, of which
 * 4,042,470 characters were one `JSON.parse` of the model, in a bundle loaded synchronously before
 * the first frame. The analysis worker, which is the only thing that actually runs the model, then
 * shipped its own second copy.
 *
 * This module imports nothing heavier than a type. Consumers that need constants, method ids, or the
 * source interpretation import `@chemdraft/rdkit-adapter/constants`; the worker keeps the barrel.
 */
export { ISOTOPE_ENVELOPE_METHOD_ID } from "./envelope";
export {
  PINNED_PKA_MODEL_SHA256,
  PINNED_RDKIT_VERSION,
  PINNED_RDKIT_WASM_SHA256
} from "./methods";
export { SOURCE_INTERPRETATION_ID, sourceInterpretation } from "./sourceInterpretation";
