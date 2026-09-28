/**
 * The CI fixture's manifest: the real plugin's id with its non-dangerous permissions. Left untyped
 * because `PluginManifest` is the schema's parsed output (every contribution list filled in); the
 * CLI validates this object through @chemdraft/plugin-host before loading the fixture.
 */
export const nmrPredictorManifest = {
  id: "org.chemdraft.nmr.predictor",
  name: "NMR Shift Predictor (CLI test fixture)",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  entry: "src/index.ts",
  permissions: ["selection.read", "analysis.write"]
};
