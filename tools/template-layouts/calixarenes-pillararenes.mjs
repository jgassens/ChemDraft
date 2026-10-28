import { runFamilyIfMain } from "./generate.mjs";

// Reserved family input: add vetted metadata and original geometric layouts here.
export const generator = {
  scriptName: "calixarenes-pillararenes.mjs",
  fileName: "calixarenesPillararenes.ts",
  exportName: "calixarenesPillararenesTemplates",
  generateTemplates: () => []
};

runFamilyIfMain(import.meta.url, generator);
