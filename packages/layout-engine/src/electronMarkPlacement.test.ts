import { describe, expect, it } from "vitest";
import type { DocumentObject, ElectronMarkObject, MoleculeObject } from "@chemdraft/chem-core";
import { electronMarkPlacementPointForAtom, moleculeLayoutLabelBoxes, nativeChargePlacementPointForAtom,
  nativeRadicalPlacementPointForAtom, transformPointForObject } from "./index";

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
    const localCenter = transformPointForObject({ ...molecule, rotation: -rotation }, first);
    const existingSearch = electronMarkPlacementPointForAtom(molecule, "atom", [molecule, {
      ...mark, markKind: "charge", x: localCenter.x - 9, y: localCenter.y - 9
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
