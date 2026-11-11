import { describe, expect, it } from "vitest";
import type { ElectronMarkObject, MoleculeObject } from "@chemdraft/chem-core";
import { electronMarkPlacementPointForAtom, lonePairDragDirection, lonePairPlacementPlanForAtom, moleculeLayoutLabelBoxes } from "./index";

describe("lone-pair drag direction", () => {
  const atom = { x: 210, y: 175 };
  const pointer = (degrees: number) => ({ x: atom.x + 40 * Math.cos(degrees * Math.PI / 180),
    y: atom.y + 40 * Math.sin(degrees * Math.PI / 180) });
  it.each([[100, 105], [-100, -105], [179, 180], [-179, -180], [0, 0], [7, 0], [8, 15]])(
    "snaps %s° to %s° about the atom", (degrees, snapped) => {
    expect(lonePairDragDirection(atom, pointer(degrees))).toBeCloseTo(snapped * Math.PI / 180, 10);
  });
  it.each([100, -100, 7])("retains the free %s° angle with Alt", degrees => {
    expect(lonePairDragDirection(atom, pointer(degrees), true)).toBeCloseTo(degrees * Math.PI / 180, 10);
  });
  it("has no direction at the center or for non-finite coordinates", () => {
    expect(lonePairDragDirection(atom, atom)).toBeUndefined();
    expect(lonePairDragDirection(atom, { x: NaN, y: 1 })).toBeUndefined();
    expect(lonePairDragDirection({ x: Infinity, y: 1 }, pointer(100))).toBeUndefined();
  });
});

describe.each(["growth slot", "open angle"])("electron-mark placement via %s", route => {
  it.each([0, 37])("clears updated H labels with an authored size and rotation %s", rotation => {
    for (const element of ["N", "O"]) for (const fontSize of [15, 36]) for (const size of [18, 48]) {
      const molecule: MoleculeObject = {
        id: "molecule", type: "molecule", x: 160, y: 200, width: 40, height: 0, rotation: 0,
        style: { atomLabelFontSizePx: fontSize }, structureFormat: "smiles", structure: "",
        atoms: [
          { id: "target", element, formalCharge: 1, x: 200, y: 200 },
          { id: "neighbor", element: "C", formalCharge: 0, x: 160, y: 200 }
        ],
        bonds: [{ id: "bond", fromAtomId: "neighbor", toAtomId: "target", order: "single" }],
        superatoms: [], rGroups: []
      };
      const point = electronMarkPlacementPointForAtom(molecule, "target", [molecule], 792, 612, {
        growthPoint: route === "growth slot" ? { x: 222, y: 200 } : undefined,
        mark: { width: size, height: size, rotation }
      });
      expect(point).toBeDefined();
      const label = moleculeLayoutLabelBoxes(molecule).find(label => label.atom === 0)!;
      const radians = rotation * Math.PI / 180;
      const half = size * (Math.abs(Math.cos(radians)) + Math.abs(Math.sin(radians))) / 2;
      expect(point!.x - half < label.x + label.width && point!.x + half > label.x &&
        point!.y - half < label.y + label.height && point!.y + half > label.y).toBe(false);
    }
  });
});

function oxygen(bondAngles: number[], element = "O", fontSize = 15): MoleculeObject {
  return {
    id: "molecule", type: "molecule", x: 150, y: 150, width: 100, height: 100, rotation: 0,
    style: { atomLabelFontSizePx: fontSize }, structureFormat: "smiles", structure: "",
    atoms: [{ id: "oxygen", element, formalCharge: 0, x: 200, y: 200 },
      ...bondAngles.map((angle, index) => ({ id: `neighbor-${index}`, element: "C", formalCharge: 0,
        x: 200 + 22 * Math.cos(angle), y: 200 + 22 * Math.sin(angle) }))],
    bonds: bondAngles.map((_, index) => ({ id: `bond-${index}`, fromAtomId: "oxygen",
      toAtomId: `neighbor-${index}`, order: bondAngles.length === 1 ? "double" : "single" })),
    superatoms: [], rGroups: []
  };
}

function anchoredMark(angle: number, markKind: ElectronMarkObject["markKind"] = "lone-pair"): ElectronMarkObject {
  return { id: `mark-${angle}`, type: "electron-mark", markKind, charge: markKind === "charge" ? 1 : undefined,
    x: 200 + 35 * Math.cos(angle) - 9, y: 200 + 35 * Math.sin(angle) - 9,
    width: 18, height: 18, rotation: 0, style: {},
    anchor: { kind: "atom", objectId: "molecule", atomId: "oxygen" } };
}

function expectDirection(plan: ReturnType<typeof lonePairPlacementPlanForAtom>, angle: number) {
  expect(plan).toBeDefined();
  const dx = plan!.center.x - 200, dy = plan!.center.y - 200;
  const radius = Math.hypot(dx, dy);
  expect(dx / radius).toBeCloseTo(Math.cos(angle), 10);
  expect(dy / radius).toBeCloseTo(Math.sin(angle), 10);
  const rotation = plan!.rotation * Math.PI / 180;
  expect(Math.cos(rotation) * dx / radius + Math.sin(rotation) * dy / radius).toBeCloseTo(0, 10);
  expect(plan!.rotation).toBeGreaterThanOrEqual(0);
  expect(plan!.rotation).toBeLessThan(360);
}

describe("lone-pair placement plans", () => {
  it.each([0, Math.PI / 7, -Math.PI / 2])("places the first ketone pair opposite its bond after rotation %s", turn => {
    const molecule = oxygen([Math.PI + turn]);
    const plan = lonePairPlacementPlanForAtom(molecule, "oxygen", [molecule], 792, 612);
    expectDirection(plan, turn);
    expect(plan!.rotation).toBeCloseTo(((turn * 180 / Math.PI + 90) % 360 + 360) % 360, 10);
  });

  it("places the second ketone pair in a remaining gap, breaking equal-gap ties by smallest positive bisector", () => {
    const molecule = oxygen([Math.PI]);
    const first = lonePairPlacementPlanForAtom(molecule, "oxygen", [molecule], 792, 612)!;
    const existing = { ...anchoredMark(0), x: first.center.x - 9, y: first.center.y - 9, rotation: first.rotation };
    expectDirection(lonePairPlacementPlanForAtom(molecule, "oxygen", [molecule, existing], 792, 612), Math.PI / 2);
  });

  it("fills the largest gaps on a two-bond ether oxygen", () => {
    const molecule = oxygen([-Math.PI / 4, Math.PI / 4]);
    expectDirection(lonePairPlacementPlanForAtom(molecule, "oxygen", [molecule], 792, 612), Math.PI);
    expectDirection(lonePairPlacementPlanForAtom(molecule, "oxygen", [molecule, anchoredMark(Math.PI)], 792, 612), 5 * Math.PI / 8);
  });

  it("counts both radical and charge marks, ignoring anchors on other atoms or molecules", () => {
    const molecule = oxygen([Math.PI]);
    const unrelated = { ...anchoredMark(-Math.PI / 2), anchor: { kind: "atom" as const, objectId: "other", atomId: "oxygen" } };
    const otherAtom = { ...anchoredMark(-Math.PI / 2), anchor: { kind: "atom" as const, objectId: "molecule", atomId: "neighbor-0" } };
    const objects = [molecule, anchoredMark(0, "charge"), anchoredMark(Math.PI / 2, "radical-dot"), unrelated, otherAtom];
    expectDirection(lonePairPlacementPlanForAtom(molecule, "oxygen", objects, 792, 612), -Math.PI / 2);
    expect(lonePairPlacementPlanForAtom(molecule, "oxygen", [...objects].reverse(), 792, 612))
      .toEqual(lonePairPlacementPlanForAtom(molecule, "oxygen", objects, 792, 612));
  });

  it("defaults an unbonded, unmarked atom to page-up and places the next pair opposite it", () => {
    const molecule = oxygen([]);
    expectDirection(lonePairPlacementPlanForAtom(molecule, "oxygen", [molecule], 792, 612), -Math.PI / 2);
    expectDirection(lonePairPlacementPlanForAtom(molecule, "oxygen", [molecule, anchoredMark(-Math.PI / 2)], 792, 612), Math.PI / 2);
  });

  it.each([0, Math.PI / 6, Math.PI, -7 * Math.PI / 2])("honors explicit direction %s with tangent rotation and asymmetric OH label clearance", direction => {
    const molecule = oxygen([], "OH", 48);
    const plan = lonePairPlacementPlanForAtom(molecule, "oxygen", [molecule, anchoredMark(direction)], 792, 612, direction)!;
    expectDirection(plan, direction);
    const label = moleculeLayoutLabelBoxes(molecule).find(label => label.atom === 0)!;
    const radians = plan.rotation * Math.PI / 180;
    const half = 9 * (Math.abs(Math.cos(radians)) + Math.abs(Math.sin(radians)));
    expect(plan.center.x - half < label.x + label.width && plan.center.x + half > label.x &&
      plan.center.y - half < label.y + label.height && plan.center.y + half > label.y).toBe(false);
    expect(Math.hypot(plan.center.x - 200, plan.center.y - 200)).toBeGreaterThan(24.3);
  });

  it("clears enlarged labels during gap search as well as explicit placement", () => {
    const molecule = oxygen([Math.PI], "O", 48);
    const plan = lonePairPlacementPlanForAtom(molecule, "oxygen", [molecule], 792, 612)!;
    expectDirection(plan, 0);
    const label = moleculeLayoutLabelBoxes(molecule)[0];
    expect(plan.center.x - 9).toBeGreaterThan(label.x + label.width);
  });

  it("refuses a missing atom, non-finite direction or a ray that cannot clear the label inside the page", () => {
    const molecule = oxygen([]);
    expect(lonePairPlacementPlanForAtom(molecule, "missing", [molecule], 792, 612)).toBeUndefined();
    expect(lonePairPlacementPlanForAtom(molecule, "oxygen", [molecule], 792, 612, NaN)).toBeUndefined();
    expect(lonePairPlacementPlanForAtom(molecule, "oxygen", [molecule], 792, 612, Infinity)).toBeUndefined();
    molecule.atoms[0].x = 5;
    expect(lonePairPlacementPlanForAtom(molecule, "oxygen", [molecule], 792, 612, Math.PI)).toBeUndefined();
  });
});
