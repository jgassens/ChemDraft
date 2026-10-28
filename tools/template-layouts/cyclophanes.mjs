import { runFamilyIfMain } from "./generate.mjs";

// Reserved family input: add vetted metadata and original geometric layouts here.
export const generator = {
  scriptName: "cyclophanes.mjs",
  fileName: "cyclophanes.ts",
  exportName: "cyclophanesTemplates",
  generateTemplates: () => []
};

runFamilyIfMain(import.meta.url, generator);
