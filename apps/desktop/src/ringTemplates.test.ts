import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { nativeDrawingStyleFromObjectStyle, type MoleculeObject } from "@chemdraft/chem-core";
import { createDesktopToolsetRegistry, getToolsetItemGroups } from "./toolsets";
import { activateDrawingToolCommand, createActiveToolState, getDrawingToolCommandSpecs } from "./drawingTools";
import { Icon, type IconName } from "./icons";
import {
  createPhase4Document, insertNativeSingleBondMolecule, nativeTemplateForToolCommand,
  planNativeTemplatePlacement, applyNativeTemplatePlacementPlan
} from "./documentWorkflow";

const ringCommandIds = [
  "tool.benzene", "tool.cyclopropane", "tool.cyclobutane", "tool.cyclopentane",
  "tool.cyclohexane", "tool.cycloheptane", "tool.cyclooctane",
  "tool.chairCyclohexaneA", "tool.chairCyclohexaneB"
];

describe("ring toolbar organization", () => {
  it.each(["core.main", "core.structure"])("groups all rings under one benzene icon in %s", (toolsetId) => {
    const items = getToolsetItemGroups(toolsetId).flat();
    const rings = items.filter(item => ringCommandIds.includes(item.id));
    expect(rings).toHaveLength(1);
    expect(rings[0]).toMatchObject({ id: "tool.benzene", assetName: "Custom_Benzene", primary: { command: { id: "tool.benzene" } } });
    expect(rings[0].submenu?.items.map(command => command.id)).toEqual(ringCommandIds);
  });

  it("retains saved benzene visibility and ignores removed standalone ring slots", () => {
    const registry = createDesktopToolsetRegistry({ version: 1, toolsetOverrides: [{
      toolsetId: "core.main", hiddenCommandIds: ["tool.benzene"],
      itemOrder: { "core.main.items": ["tool.cyclopentane", "tool.benzene", "tool.cyclohexane", "tool.select"] }
    }] });
    const items = getToolsetItemGroups("core.main", registry).flat();
    expect(items.some(item => item.id === "tool.benzene")).toBe(false);
    expect(items.some(item => item.id === "tool.select")).toBe(true);
  });

  it.each([[3, "cyclopropane"], [4, "cyclobutane"], [7, "cycloheptane"], [8, "cyclooctane"]] as const)("activates and places the %i-membered ring through its drawing command", (size, name) => {
    const command = getDrawingToolCommandSpecs([]).find(command => command.id === `tool.${name}`)!;
    expect(activateDrawingToolCommand(createActiveToolState(), command).state.activeKind).toBe("ring");
    const template = nativeTemplateForToolCommand(command.id)!;
    expect(template).toBe(name);
    const document = createPhase4Document("Ring sizes");
    const plan = planNativeTemplatePlacement(document, { point: { x: 300, y: 300 } }, template)!;
    const placed = applyNativeTemplatePlacementPlan(document, plan).pages[0].objects[0] as MoleculeObject;
    expect(placed.atoms).toHaveLength(size);
    expect(placed.bonds).toHaveLength(size);
    expect(placed.chemistry?.formula).toBe(`C${size}H${2 * size}`);
    const length = nativeDrawingStyleFromObjectStyle(placed.style).bondLengthPx;
    for (const bond of placed.bonds) {
      const a = placed.atoms.find(atom => atom.id === bond.fromAtomId)!;
      const b = placed.atoms.find(atom => atom.id === bond.toAtomId)!;
      expect(bond.order).toBe("single");
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeCloseTo(length, 8);
    }
    const markup = renderToStaticMarkup(createElement(Icon, { name: `ring${size}` as IconName }));
    expect(markup.match(/points="([^"]+)"/)?.[1].split(" ")).toHaveLength(size);
  });

  it.each([[7, "cycloheptane"], [8, "cyclooctane"]] as const)("attaches and fuses %i-membered rings without moving the original bond", (size, template) => {
    const seed = insertNativeSingleBondMolecule(createPhase4Document("Ring targets"), { x: 300, y: 300 });
    const molecule = seed.pages[0].objects[0] as MoleculeObject;
    const atom = molecule.atoms[0];
    for (const kind of ["atom", "bond"] as const) {
      const target = kind === "atom"
        ? { kind, objectId: molecule.id, atomId: atom.id, distanceToPointer: 0 }
        : { kind, objectId: molecule.id, bondId: molecule.bonds[0].id, fromAtomId: molecule.atoms[0].id, toAtomId: molecule.atoms[1].id, distanceToPointer: 0 };
      const plan = planNativeTemplatePlacement(seed, { point: { x: atom.x, y: atom.y - 20 }, target }, template)!;
      expect(plan.kind).toBe(kind === "atom" ? "attach-atom" : "fuse-bond");
      expect(plan.molecule.atoms.slice(0, 2)).toEqual(molecule.atoms);
      expect(plan.molecule.atoms).toHaveLength(kind === "atom" ? size + 1 : size);
    }
  });
});
