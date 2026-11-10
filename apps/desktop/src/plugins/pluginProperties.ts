import {
  PluginChemistryPropertiesRequestSchema,
  type PluginChemistryPropertiesRequest,
  type PluginChemistryPropertiesResult
} from "@chemdraft/plugin-api";
import { analysisClient, type AnalysisClient } from "../analysisClient";
import { chemistryPropertiesInputError } from "@chemdraft/plugin-host";

export const PLUGIN_PROPERTIES_METHODS = ["rdkit.composition", "rdkit.average-mass", "rdkit.monoisotopic-mass"];
let nextSlot = 0;

/** The same lazy, size-bounded analysis worker and source interpretation as the property panel.
 * A distinct slot per call prevents concurrent plugins from superseding each other. */
export async function computePropertiesForPlugin(
  request: PluginChemistryPropertiesRequest,
  client: AnalysisClient | null = analysisClient()
): Promise<PluginChemistryPropertiesResult> {
  const parsed = PluginChemistryPropertiesRequestSchema.safeParse(request);
  if (!parsed.success) return { available: false, reason: chemistryPropertiesInputError(request, parsed.error) };
  if (!client) return { available: false, reason: "The RDKit analysis engine is unavailable in this environment." };
  try {
    const { format, structure } = parsed.data;
    const run = await client.analyze(`plugin.chemistry.properties.${++nextSlot}`, {
      format: format === "smiles" ? "smiles" : /V3000/.test(structure) ? "molfile-v3000" : "molfile-v2000",
      value: structure, methodIds: PLUGIN_PROPERTIES_METHODS
    });
    const source = run.results.filter(result => result.interpretationId === "source" && result.status === "ok");
    const composition = source.find(result => result.methodId === "rdkit.composition");
    const average = source.find(result => result.methodId === "rdkit.average-mass");
    const mono = source.find(result => result.methodId === "rdkit.monoisotopic-mass");
    const engine = run.engines.find(entry => entry.name === "rdkit-minimallib-wasm");
    if (composition?.kind !== "composition" || !composition.formula || composition.formalCharge === null ||
      average?.kind !== "scalar" || average.value === null || mono?.kind !== "scalar" || mono.value === null || !engine) {
      return { available: false, reason: run.warnings[0]?.message ?? "RDKit could not compute properties for this structure." };
    }
    return {
      available: true, formula: composition.formula, averageMass: average.value, monoisotopicMass: mono.value,
      formalCharge: composition.formalCharge, isotopeLabelled: composition.hasExplicitIsotopes,
      method: { engine: "RDKit", version: engine.version,
        conventions: [...composition.conventions, ...average.conventions, ...mono.conventions,
          "As drawn: whole input, preserving charge and isotope labels; no desalting or neutralization.",
          "Average mass: g/mol; monoisotopic mass: Da."] }
    };
  } catch (error) {
    return { available: false, reason: `RDKit properties unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}
