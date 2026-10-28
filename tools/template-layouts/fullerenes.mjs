import { runFamilyIfMain } from "./generate.mjs";

// Reserved family input: add vetted metadata and original geometric layouts here.
export const generator = {
  scriptName: "fullerenes.mjs",
  fileName: "fullerenes.ts",
  exportName: "fullerenesTemplates",
  generateTemplates: () => []
};

runFamilyIfMain(import.meta.url, generator);
