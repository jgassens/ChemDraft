import { describe, expect, it } from "vitest";
import type { DocumentObject, ElectronMarkObject, MoleculeObject } from "@chemdraft/chem-core";
import { electronMarkPlacementPointForAtom, lonePairDragDirection, lonePairPlacementPlanForAtom, moleculeLayoutLabelBoxes, nativeChargePlacementPointForAtom, nativeRadicalPlacementPointForAtom, transformPointForObject } from "./index";

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
describe("repeated radical placement", () => {
  it.each([
    { name: "bonded repro", element: "C", neighbors: [[189, 181], [189, 219]] },
    { name: "unbonded atom", element: "C", neighbors: [] },
    { name: "terminal atom", element: "C", neighbors: [[178, 200]] },
    { name: "three bonds", element: "C", neighbors: [[178, 200], [211, 181], [211, 219]] },
    { name: "labeled heteroatom", element: "N", neighbors: [[189, 181], [189, 219]] }
  ])("keeps two and three dots clear on a $name and preserves its first placement", ({ element, neighbors }) => {
    const molecule: MoleculeObject = { id: "molecule", type: "molecule", x: 178, y: 181, width: 33, height: 38,
      rotation: 0, style: {}, structureFormat: "smiles", structure: "", atoms: [
        { id: "atom", element, formalCharge: 0, x: 200, y: 200 },
        ...neighbors.map(([x, y], index) => ({ id: `neighbor_${index}`, element: "C", formalCharge: 0, x, y }))
      ], bonds: neighbors.map((_, index) => ({ id: `bond_${index}`, fromAtomId: "atom", toAtomId: `neighbor_${index}`, order: "single" })),
      superatoms: [], rGroups: [] };
    const objects: DocumentObject[] = [molecule];
    const first = nativeRadicalPlacementPointForAtom(molecule, "atom", objects, 792, 612)!;
    expect(first).toEqual(nativeChargePlacementPointForAtom(molecule, "atom", objects, 792, 612));
    // The charge-tool oracle in the desktop suite freezes HEAD's first-dot arithmetic.
    const centers = [first];
    for (let index = 0; index < 3; index++) {
      const point = index === 0 ? first : nativeRadicalPlacementPointForAtom(molecule, "atom", objects, 792, 612)!;
      if (index > 0) centers.push(point);
      objects.push({ id: `dot_${index}`, type: "electron-mark", markKind: "radical-dot",
        x: point.x - 9, y: point.y - 9, width: 18, height: 18, rotation: 0, style: {},
        anchor: { kind: "atom", objectId: molecule.id, atomId: "atom" } });
    }
    for (let index = 1; index < centers.length; index++) for (const earlier of centers.slice(0, index)) {
      const point = centers[index];
      expect(Math.hypot(point.x - earlier.x, point.y - earlier.y), `dot ${index + 1} centre distance`).toBeGreaterThanOrEqual(4.2);
      expect(Math.abs(point.x - earlier.x) >= 18 || Math.abs(point.y - earlier.y) >= 18,
        `dot ${index + 1} frame must not overlap`).toBe(true);
    }
  });

  it.each([0, 65])("searches an outer ring when every first-ring frame is occupied (rotation %s)", rotation => {
    const molecule: MoleculeObject = { id: "molecule", type: "molecule", x: 200, y: 200, width: 0, height: 0,
      rotation, style: {}, structureFormat: "smiles", structure: "", atoms: [
        { id: "atom", element: "C", formalCharge: 0, x: 200, y: 200 }
      ], bonds: [], superatoms: [], rGroups: [] };
    const marks: ElectronMarkObject[] = Array.from({ length: 16 }, (_, index) => {
      const angle = -Math.PI + index * Math.PI / 8;
      const center = transformPointForObject(molecule, { x: 200 + 24.3 * Math.cos(angle), y: 200 + 24.3 * Math.sin(angle) });
      return { id: `dot_${index}`, type: "electron-mark", markKind: "radical-dot", x: center.x - 9, y: center.y - 9,
        width: 18, height: 18, rotation: 0, style: {}, anchor: { kind: "atom", objectId: molecule.id, atomId: "atom" } };
    });
    const point = nativeRadicalPlacementPointForAtom(molecule, "atom", [molecule, ...marks], 792, 612)!;
    expect(point).toBeDefined();
    expect(Math.hypot(point.x - 200, point.y - 200)).toBeGreaterThan(24.3 + 1e-8);
    for (const mark of marks) {
      expect(Math.abs(point.x - mark.x - 9) >= 20 || Math.abs(point.y - mark.y - 9) >= 20).toBe(true);
    }
  });

  it.each([0, 65])("clears final clamped frames at a page corner (rotation %s)", rotation => {
    const molecule: MoleculeObject = { id: "molecule", type: "molecule", x: 9, y: 9, width: 0, height: 0,
      rotation, style: {}, structureFormat: "smiles", structure: "", atoms: [
        { id: "atom", element: "N", formalCharge: 0, x: 9, y: 9 }
      ], bonds: [], superatoms: [], rGroups: [] };
    const objects: DocumentObject[] = [molecule];
    for (let index = 0; index < 3; index++) {
      const point = nativeRadicalPlacementPointForAtom(molecule, "atom", objects, 792, 612)!;
      expect(point).toBeDefined();
      const center = { x: Math.max(9, Math.min(point.x, 783)), y: Math.max(9, Math.min(point.y, 603)) };
      for (const object of objects) if (object.type === "electron-mark") {
        expect(Math.abs(center.x - object.x - 9) >= 20 || Math.abs(center.y - object.y - 9) >= 20).toBe(true);
      }
      objects.push({ id: `dot_${index}`, type: "electron-mark", markKind: "radical-dot",
        x: center.x - 9, y: center.y - 9, width: 18, height: 18, rotation: 0, style: {},
        anchor: { kind: "atom", objectId: molecule.id, atomId: "atom" } });
    }
  });

  it.each([0, 65])("uses the charge tool's existing open-angle search at rotation %s", rotation => {
    const molecule: MoleculeObject = { id: "molecule", type: "molecule", x: 200, y: 200, width: 0, height: 0,
      rotation, style: {}, structureFormat: "smiles", structure: "", atoms: [
        { id: "atom", element: "C", formalCharge: 0, x: 200, y: 200 }
      ], bonds: [], superatoms: [], rGroups: [] };
    const first = nativeRadicalPlacementPointForAtom(molecule, "atom", [molecule], 792, 612)!;
    expect(first).toEqual(nativeChargePlacementPointForAtom(molecule, "atom", [molecule], 792, 612));
    const mark: ElectronMarkObject = { id: "first", type: "electron-mark", markKind: "radical-dot",
      x: first.x - 9, y: first.y - 9, width: 18, height: 18, rotation: 0, style: {},
      anchor: { kind: "atom", objectId: molecule.id, atomId: "atom" } };
    const second = nativeRadicalPlacementPointForAtom(molecule, "atom", [molecule, mark], 792, 612)!;
    const existingSearch = electronMarkPlacementPointForAtom(molecule, "atom", [molecule, {
      ...mark, markKind: "charge"
    }],
      792, 612, { avoidLabelOverlap: false })!;
    expect(second).toEqual(transformPointForObject(molecule, existingSearch));
    expect(Math.abs(second.x - first.x) >= 18 || Math.abs(second.y - first.y) >= 18).toBe(true);
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

function expectDirection(plan: ReturnType<typeof lonePairPlacementPlanForAtom>, angle: number,
  atom = { x: 200, y: 200 }) {
  expect(plan).toBeDefined();
  const dx = plan!.center.x - atom.x, dy = plan!.center.y - atom.y;
  const radius = Math.hypot(dx, dy);
  expect(dx / radius).toBeCloseTo(Math.cos(angle), 10);
  expect(dy / radius).toBeCloseTo(Math.sin(angle), 10);
  const rotation = plan!.rotation * Math.PI / 180;
  expect(Math.cos(rotation) * dx / radius + Math.sin(rotation) * dy / radius).toBeCloseTo(0, 10);
  expect(plan!.rotation).toBeGreaterThanOrEqual(0);
  expect(plan!.rotation).toBeLessThan(360);
}

describe("lone-pair placement plans", () => {
  it.each([0, 90, 45, 180])("places a page-right pair on an off-center atom and clears its label at %s°", rotation => {
    const molecule = oxygen([], "OH", 72);
    molecule.atoms[0].y = 150;
    const rotated = { ...molecule, rotation };
    const atom = transformPointForObject(rotated, molecule.atoms[0]);
    const plan = lonePairPlacementPlanForAtom(rotated, "oxygen", [rotated], 792, 612, 0);
    expectDirection(plan, 0, atom);

    // A common rotation of the mark and label preserves the required clearance.
    const local = lonePairPlacementPlanForAtom(molecule, "oxygen", [molecule], 792, 612, -rotation * Math.PI / 180)!;
    const expected = transformPointForObject(rotated, local.center);
    expect(plan!.center.x).toBeCloseTo(expected.x, 10);
    expect(plan!.center.y).toBeCloseTo(expected.y, 10);
    expect(plan!.center.x - atom.x).toBeGreaterThan(24.3);
  });

  it.each([0, 90, 45, 180])("finds gaps between a rotated bond and a page-space mark at %s°", rotation => {
    const molecule = { ...oxygen([Math.PI]), rotation };
    for (const atom of molecule.atoms) atom.y -= 50;
    const atom = transformPointForObject(molecule, molecule.atoms[0]);
    const turn = rotation * Math.PI / 180;
    const first = lonePairPlacementPlanForAtom(molecule, "oxygen", [molecule], 792, 612);
    expectDirection(first, turn, atom);

    const occupied = turn - Math.PI / 2;
    const mark = { ...anchoredMark(occupied, "radical-dot"),
      x: atom.x + 35 * Math.cos(occupied) - 9, y: atom.y + 35 * Math.sin(occupied) - 9 };
    const second = lonePairPlacementPlanForAtom(molecule, "oxygen", [molecule, mark], 792, 612);
    expectDirection(second, turn + Math.PI / 4, atom);
  });

  it("checks the page edge after rotation", () => {
    const molecule = { ...oxygen([Math.PI / 2]), rotation: 90 };
    for (const atom of molecule.atoms) atom.y -= 50;
    expect(lonePairPlacementPlanForAtom(molecule, "oxygen", [molecule], 271, 612, 0)).toBeUndefined();
    expectDirection(lonePairPlacementPlanForAtom(molecule, "oxygen", [molecule], 271, 612, Math.PI),
      Math.PI, { x: 250, y: 200 });
  });

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

  it("tries the next-largest gap when the largest bisector cannot clear the label inside the page", () => {
    const molecule = oxygen([3 * Math.PI / 4, 5 * Math.PI / 4], "O", 48);
    expectDirection(lonePairPlacementPlanForAtom(molecule, "oxygen", [molecule], 210, 612), Math.PI);
    // The same off-page ray is refused when the user explicitly chooses it.
    expect(lonePairPlacementPlanForAtom(molecule, "oxygen", [molecule], 210, 612, 0)).toBeUndefined();
  });

  it("preserves smallest-positive-bisector tie order when falling back at a page edge", () => {
    const molecule = oxygen([0, 2 * Math.PI / 3, 4 * Math.PI / 3]);
    expectDirection(lonePairPlacementPlanForAtom(molecule, "oxygen", [molecule], 210, 612), Math.PI);
  });

  it("refuses automatic placement when none of the gap bisectors fits inside the page", () => {
    const molecule = oxygen([-Math.PI / 4, Math.PI / 4]);
    expect(lonePairPlacementPlanForAtom(molecule, "oxygen", [molecule], 200, 200)).toBeUndefined();
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


describe("mixed charge and radical placement", () => {
  it.each([0, 65])("clears the existing mark in both creation orders at rotation %s", rotation => {
    for (const firstKind of ["charge", "radical-dot"] as const) {
      for (const coordinate of [9, 200]) for (const size of [18, 48]) {
        const molecule: MoleculeObject = { id: "molecule", type: "molecule",
          x: coordinate, y: coordinate, width: 0, height: 0, rotation, style: {},
          structureFormat: "smiles", structure: "", atoms: [
            { id: "nitrogen", element: "N", formalCharge: 1, x: coordinate, y: coordinate }
          ], bonds: [], superatoms: [], rGroups: [] };
        const firstPoint = nativeChargePlacementPointForAtom(molecule, "nitrogen", [molecule], 792, 612)!;
        const half = size / 2;
        const first: ElectronMarkObject = { id: "existing", type: "electron-mark", markKind: firstKind,
          ...(firstKind === "charge" ? { charge: 1 } : {}),
          x: Math.max(half, Math.min(firstPoint.x, 792 - half)) - half,
          y: Math.max(half, Math.min(firstPoint.y, 612 - half)) - half,
          width: size, height: size, rotation: 37, style: {},
          anchor: { kind: "atom", objectId: molecule.id, atomId: "nitrogen" } };
        const objects = [molecule, first];
        const before = JSON.stringify(objects);
        const place = firstKind === "charge" ? nativeRadicalPlacementPointForAtom : nativeChargePlacementPointForAtom;
        const next = place(molecule, "nitrogen", objects, 792, 612)!;
        expect(next).toBeDefined();
        const center = { x: Math.max(9, Math.min(next.x, 783)), y: Math.max(9, Math.min(next.y, 603)) };
        const rotatedHalf = half * (Math.abs(Math.cos(37 * Math.PI / 180)) + Math.abs(Math.sin(37 * Math.PI / 180)));
        expect(Math.abs(center.x - first.x - half) >= 9 + rotatedHalf + 2 - 1e-8 ||
          Math.abs(center.y - first.y - half) >= 9 + rotatedHalf + 2 - 1e-8,
          `${firstKind} first, size ${size}, coordinate ${coordinate}`).toBe(true);
        expect(JSON.stringify(objects)).toBe(before);
      }
    }
  });
});
