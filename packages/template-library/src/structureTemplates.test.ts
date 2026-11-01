import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  structureTemplateById,
  structureTemplateFamilyNames,
  structureTemplateFamilyOrder,
  structureTemplates
} from "./index";

describe("structure template registry", () => {
  it("answers every exact id, returning the registered entry", () => {
    for (const template of structureTemplates) expect(structureTemplateById(template.id)).toBe(template);
    expect(structureTemplateById("missing-template")).toBeUndefined();
    expect(structureTemplateById("18-Crown-6")).toBeUndefined();
  });

  it("keeps all seven picker families in a stable order, including empty families", () => {
    expect(structureTemplateFamilyOrder.map((family) => structureTemplateFamilyNames[family])).toEqual([
      "Crown ethers & cryptands", "Cyclodextrins", "Cucurbiturils", "Calixarenes & pillararenes",
      "Cyclophanes", "Porphyrins", "Fullerenes"
    ]);
    const positions = structureTemplates.map((entry) => structureTemplateFamilyOrder.indexOf(entry.family));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("ships exactly the reproducible generator output for every family", () => {
    const buildScript = fileURLToPath(new URL("../../../tools/template-layouts/build.mjs", import.meta.url));
    expect(() => execFileSync(process.execPath, [buildScript, "--check"], { stdio: "pipe" })).not.toThrow();
  });
});
