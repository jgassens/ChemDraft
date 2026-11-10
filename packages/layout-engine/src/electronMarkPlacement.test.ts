import { describe, expect, it } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";
import { electronMarkPlacementPointForAtom, moleculeLayoutLabelBoxes } from "./index";

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
