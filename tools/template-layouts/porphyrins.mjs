import { runFamilyIfMain } from "./generate.mjs";

// Reserved family input: add vetted metadata and original geometric layouts here.
export const generator = {
  scriptName: "porphyrins.mjs",
  fileName: "porphyrins.ts",
  exportName: "porphyrinsTemplates",
  generateTemplates: () => []
};

runFamilyIfMain(import.meta.url, generator);
