import { runFamilyIfMain } from "./generate.mjs";

// C60 and other projection templates are deferred pending a bond-length policy for projection drawings.

export const generator = {
  scriptName: "fullerenes.mjs",
  fileName: "fullerenes.ts",
  exportName: "fullerenesTemplates",
  generateTemplates: () => []
};

runFamilyIfMain(import.meta.url, generator);
