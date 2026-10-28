import { runFamilyIfMain } from "./generate.mjs";

// Reserved family input: add vetted metadata and original geometric layouts here.
export const generator = {
  scriptName: "cucurbiturils.mjs",
  fileName: "cucurbiturils.ts",
  exportName: "cucurbiturilsTemplates",
  generateTemplates: () => []
};

runFamilyIfMain(import.meta.url, generator);
