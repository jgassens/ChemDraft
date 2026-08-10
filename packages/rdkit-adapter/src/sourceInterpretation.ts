/**
 * The source interpretation, in a module with no engine dependencies.
 *
 * Lifted out of `analysis.ts` so `analysisClient` can name what the user drew without dragging the
 * pKa model into the app's startup chunk — see `constants.ts`. Pure: a hash and a policy record.
 */
import {
  hashInterpretation,
  hashSource,
  SOURCE_INTERPRETATION_ID,
  type MolecularInterpretation
} from "@chemdraft/analysis-core";

export { SOURCE_INTERPRETATION_ID };

/** The source interpretation: what the user drew, sanitised but not derived. */
export function sourceInterpretation(format: string, value: string): MolecularInterpretation {
  const sourceHash = hashSource(format, value);
  const policy = {
    id: SOURCE_INTERPRETATION_ID,
    sourceHash,
    componentPolicy: "whole-input" as const,
    explicitHydrogenPolicy: "as-drawn — implicit hydrogens stay implicit, explicit ones stay explicit",
    isotopePolicy: "preserve-labels",
    // Stated rather than left implicit, which is what a tautomer-sensitive method requires before it
    // may run (§1). "as-drawn" is the honest description: no tautomer standardisation is applied, so
    // the keto and enol forms of acetylacetone are analysed as the two different molecules they are.
    // Declaring it does not weaken the guarantee — it is the guarantee, made checkable.
    tautomerPolicy: "as-drawn — no tautomer standardisation; the drawn form is the analysed form",
    aromaticityModel: "rdkit-default",
    transformations: []
  };
  return {
    ...policy,
    label: "as drawn",
    interpretationHash: hashInterpretation(policy)
  };
}
