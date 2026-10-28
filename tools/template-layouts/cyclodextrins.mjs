import { runFamilyIfMain } from "./generate.mjs";

// Reserved family input: add vetted metadata and original geometric layouts here.
export const generator = {
  scriptName: "cyclodextrins.mjs",
  fileName: "cyclodextrins.ts",
  exportName: "cyclodextrinsTemplates",
  generateTemplates: () => []
};

runFamilyIfMain(import.meta.url, generator);
