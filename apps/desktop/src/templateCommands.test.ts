import { describe, expect, it } from "vitest";
import { structureTemplates } from "@chemdraft/template-library";
import { createEmptyDocument, DocumentStylePreset, nativeDrawingStyleFromObjectStyle, stylePresetToObjectStyle } from "@chemdraft/chem-core";
import { allShellCommands, templateInsertCommandId } from "./commands";
import { insertStructureTemplate } from "./structureTemplateInsertion";
import { buildGalleryModel } from "./toolbars/CustomizeMainToolbar/galleryModel";
import { filterStructureTemplates, structureTemplatePickerFamilies } from "./dialogs/structureTemplatePickerModel";

it("registers one value-encoded command per template, plus the customizable picker", () => {
  const commands = allShellCommands(createEmptyDocument());
  expect(commands.find(command => command.id === "template.insertDialog")).toMatchObject({ title: "Templates…", icon: "templates" });
  for (const template of structureTemplates) {
    expect(templateInsertCommandId(template.id)).toBe(`template.insert.${template.id}`);
    expect(commands.filter(command => command.id === templateInsertCommandId(template.id))).toHaveLength(1);
  }
  expect(() => templateInsertCommandId("../invalid")).toThrow("Unknown structure template");
  expect(buildGalleryModel(commands, [], new Set(), "Templates").some(entry => entry.commandId === "template.insertDialog")).toBe(true);
});

it("adds and selects the template in one patch transaction at the DEFAULT bond length", () => {
  const source = createEmptyDocument();
  const template = structureTemplates.find(template => template.name === "β-Cyclodextrin")!;
  const result = insertStructureTemplate(source, template.id, { x: 125, y: 250 });
  expect(result.label).toBe("Insert β-Cyclodextrin");
  expect(source.pages[0]!.objects).toHaveLength(0);
  expect(result.document.pages[0]!.objects).toHaveLength(1);
  const molecule = result.document.pages[0]!.objects[0]!;
  if (molecule.type !== "molecule") throw new Error("Expected molecule");
  expect(result.document.selection.objectIds).toEqual([molecule.id]);
  expect(molecule.x + molecule.width / 2).toBeCloseTo(125);
  expect(molecule.y + molecule.height / 2).toBeCloseTo(250);
  const byId = new Map(molecule.atoms.map(atom => [atom.id, atom]));
  const length = molecule.bonds.reduce((sum, bond) => { const a = byId.get(bond.fromAtomId)!, b = byId.get(bond.toAtomId)!; return sum + Math.hypot(a.x - b.x, a.y - b.y); }, 0) / molecule.bonds.length;
  expect(length).toBeCloseTo(nativeDrawingStyleFromObjectStyle(stylePresetToObjectStyle(DocumentStylePreset)).bondLengthPx, 4);
});

describe("picker substring search", () => {
  it.each(["β-CD", "beta", "BETA cyclodextrin"])("finds β-Cyclodextrin for %s", query => {
    expect(filterStructureTemplates(query).map(template => template.name)).toContain("β-Cyclodextrin");
  });
  it.each([['cucurbit[7]', 'Cucurbit[7]uril'], ['crown', '18-Crown-6'], ['pillar', 'Pillar[5]arene']])("finds %s", (query, name) => {
    expect(filterStructureTemplates(query).map(template => template.name)).toContain(name);
  });
  it("keeps families in order and pillar variants adjacent", () => {
    const families = structureTemplatePickerFamilies("", structureTemplates.map(template => template.id));
    expect(families[0]!.family).toBe("crown-ethers-cryptands");
    const ids = families.find(family => family.family === "calixarenes-pillararenes")!.templates.map(template => template.id);
    expect(ids.slice(ids.indexOf("pillar-5-arene"), ids.indexOf("pillar-5-arene") + 4)).toEqual([
      "pillar-5-arene", "dimethoxypillar-5-arene", "pillar-6-arene", "dimethoxypillar-6-arene"
    ]);
  });
});
