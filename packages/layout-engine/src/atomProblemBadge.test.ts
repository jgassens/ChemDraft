// atomProblemBadgeCentre: the red "!" badge on an atom with a valence problem never covers the atom's
// label or its charge, isotope or hydrogen marks, nor a floating electron mark beside the atom, and
// takes a side free of bonds where there is one (RC7 hands-on: the badge sat exactly on N+'s "+").

import { describe, expect, it } from "vitest";
import type { MoleculeAtom, MoleculeBond, MoleculeObject } from "@chemdraft/chem-core";

import {
  atomProblemBadgeCentre,
  atomProblemBadgeClearancePx,
  atomProblemBadgeRadiusPx,
  distanceToSegment,
  inverseTransformPointForObject,
  moleculeLayoutLabelBoxes,
  planMoleculeAtomLabels,
  type LayoutBounds,
  type LayoutPoint
} from "./index";

const ring = atomProblemBadgeRadiusPx;

/** The badge's drawn box (ring radius plus its 0.75 px half stroke) around a centre. */
function badgeBox(centre: LayoutPoint): LayoutBounds {
  const half = ring + 0.75;
  return { x: centre.x - half, y: centre.y - half, width: half * 2, height: half * 2 };
}

const intersects = (a: LayoutBounds, b: LayoutBounds) => Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x)
  && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);

/** Ethane drawn as a zig-zag stick, its end atom `b` replaced by `end`; `b` sits up and to the right of `a`. */
function ethane(end: Partial<MoleculeAtom>, options: { rotation?: number; bondFrom?: LayoutPoint; extraAtoms?: MoleculeAtom[]; extraBonds?: MoleculeBond[] } = {}): MoleculeObject {
  const from = options.bondFrom ?? { x: 30, y: 50 };
  return {
    id: "m", type: "molecule", x: 0, y: 0, width: 100, height: 100, rotation: options.rotation ?? 0,
    style: {}, structureFormat: "smiles", structure: "", superatoms: [], rGroups: [],
    atoms: [
      { id: "a", element: "C", x: from.x, y: from.y, formalCharge: 0 },
      { id: "b", element: "C", x: 56, y: 35, formalCharge: 0, ...end },
      ...(options.extraAtoms ?? [])
    ],
    bonds: [{ id: "ab", fromAtomId: "a", toAtomId: "b", order: "single" }, ...(options.extraBonds ?? [])]
  };
}

function labelOf(molecule: MoleculeObject, atomId: string): { text: string; box: LayoutBounds } {
  const index = molecule.atoms.findIndex(atom => atom.id === atomId);
  const plan = planMoleculeAtomLabels(molecule).find(candidate => candidate.atom.id === atomId)!;
  return { text: plan.label, box: moleculeLayoutLabelBoxes(molecule).find(box => box.atom === index)! };
}

describe("atomProblemBadgeCentre", () => {
  // The labels the RC7 report and the task name: a typed N+ on an ethane end (a literal label, so no
  // hydrogens: "N has 1 of 4 bonds."), an O-, the auto-hydrogen NH3+, and an isotope-labelled carbon.
  it.each([
    ["typed N+", { element: "N", formalCharge: 1, labelLiteral: true }, ["N+"]],
    ["O-", { element: "O", formalCharge: -1 }, ["O-"]],
    // Bonded from the right, the hydrogens lead: H3N+.
    ["NH3+", { element: "N", formalCharge: 1 }, ["NH3+", "H3N+"]],
    ["13C carbanion", { element: "C", formalCharge: -1, isotope: 13 }, ["13CH2-"]]
  ] as const)("keeps the badge off the whole %s label, its charge glyph included", (_name, end, texts) => {
    for (const bondFrom of [{ x: 30, y: 50 }, { x: 82, y: 50 }, { x: 56, y: 61 }, { x: 56, y: 9 }]) {
      const molecule = ethane(end, { bondFrom });
      const label = labelOf(molecule, "b");
      expect(texts).toContain(label.text.replace(/\u2212/g, "-"));
      const centre = atomProblemBadgeCentre(molecule, "b")!;
      expect(intersects(badgeBox(centre), label.box)).toBe(false);
      // Clear by the full clearance, not just a hair.
      const dx = Math.max(label.box.x - centre.x, 0, centre.x - (label.box.x + label.box.width));
      const dy = Math.max(label.box.y - centre.y, 0, centre.y - (label.box.y + label.box.height));
      expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(ring + atomProblemBadgeClearancePx - 1e-9);
      // A terminal atom always has a bond-free side: the badge takes one.
      const bond = molecule.atoms[0]!;
      expect(distanceToSegment(centre, bond, molecule.atoms[1]!)).toBeGreaterThanOrEqual(ring + atomProblemBadgeClearancePx);
    }
  });

  it("places the N+ badge clear of the superscript + that the old fixed (+9, -9) offset covered", () => {
    const molecule = ethane({ element: "N", formalCharge: 1, labelLiteral: true });
    const plan = planMoleculeAtomLabels(molecule).find(candidate => candidate.atom.id === "b")!;
    const plus = plan.layout.runs.find(run => run.text === "+")!;
    expect(plus.script).toBe("superscript");
    const atom = molecule.atoms[1]!;
    // The regression: the old badge at the atom plus (9, -9) sat on the "+" glyph.
    const label = labelOf(molecule, "b").box;
    expect(intersects(badgeBox({ x: atom.x + 9, y: atom.y - 9 }), label)).toBe(true);
    expect(intersects(badgeBox(atomProblemBadgeCentre(molecule, "b")!), label)).toBe(false);
  });

  it("keeps the badge off a floating charge mark on an unlabelled carbon, and off its bonds", () => {
    // A carbon with four bonds and a floating ⊕ (the charge mark's contribution is markCharge, so no
    // sign is drawn in the label): "C has 4 of 3 bonds." The mark sits where the badge used to go.
    const centreAtom: MoleculeAtom = { id: "c", element: "C", x: 50, y: 50, formalCharge: 1, markCharge: 1 };
    const neighbours: MoleculeAtom[] = [[50, 24], [72.5, 63], [27.5, 63], [76, 50]].map(([x, y], index) =>
      ({ id: `n${index}`, element: "C", x: x!, y: y!, formalCharge: 0 }));
    const molecule: MoleculeObject = {
      id: "m", type: "molecule", x: 0, y: 0, width: 100, height: 100, rotation: 0,
      style: {}, structureFormat: "smiles", structure: "", superatoms: [], rGroups: [],
      atoms: [centreAtom, ...neighbours],
      bonds: neighbours.map(neighbour => ({ id: `b-${neighbour.id}`, fromAtomId: "c", toAtomId: neighbour.id, order: "single" as const }))
    };
    const mark = { x: 55, y: 34, width: 10, height: 10 };
    const label = moleculeLayoutLabelBoxes(molecule).find(box => box.atom === 0);
    const centre = atomProblemBadgeCentre(molecule, "c", { marks: [mark] })!;
    expect(intersects(badgeBox(centre), mark)).toBe(false);
    if (label) expect(intersects(badgeBox(centre), label)).toBe(false);
    // The fixed (+9, -9) offset covered the mark.
    expect(intersects(badgeBox({ x: 59, y: 41 }), mark)).toBe(true);
    // Bond-free sides exist between the four bonds: the badge takes one.
    for (const neighbour of neighbours) {
      expect(distanceToSegment(centre, centreAtom, neighbour)).toBeGreaterThanOrEqual(ring + atomProblemBadgeClearancePx);
    }
  });

  it("keeps the historical upper-right spot for an unlabelled atom with room there", () => {
    // Five bonds on a carbon, none to the upper right: no label, no mark, so nothing moves the badge.
    const centreAtom: MoleculeAtom = { id: "c", element: "C", x: 50, y: 50, formalCharge: 0 };
    const neighbours: MoleculeAtom[] = [[24, 50], [76, 50], [50, 76], [32, 32], [32, 68]].map(([x, y], index) =>
      ({ id: `n${index}`, element: "C", x: x!, y: y!, formalCharge: 0 }));
    const molecule: MoleculeObject = {
      id: "m", type: "molecule", x: 0, y: 0, width: 100, height: 100, rotation: 0,
      style: {}, structureFormat: "smiles", structure: "", superatoms: [], rGroups: [],
      atoms: [centreAtom, ...neighbours],
      bonds: neighbours.map(neighbour => ({ id: `b-${neighbour.id}`, fromAtomId: "c", toAtomId: neighbour.id, order: "single" as const }))
    };
    expect(moleculeLayoutLabelBoxes(molecule).some(box => box.atom === 0)).toBe(false);
    const centre = atomProblemBadgeCentre(molecule, "c")!;
    expect(centre.x).toBeCloseTo(59, 6);
    expect(centre.y).toBeCloseTo(41, 6);
  });

  it("reads a mark's page frame in the frame of a rotated molecule", () => {
    const molecule = ethane({ element: "C", formalCharge: 1, markCharge: 1 }, { rotation: 90 });
    // A mark whose page frame, taken back into the molecule frame, sits just above-right of the atom.
    const local = { x: 63, y: 24 };
    const rotationCentre = { x: molecule.x + molecule.width / 2, y: molecule.y + molecule.height / 2 };
    const radians = (molecule.rotation * Math.PI) / 180;
    const page = {
      x: rotationCentre.x + (local.x - rotationCentre.x) * Math.cos(radians) - (local.y - rotationCentre.y) * Math.sin(radians),
      y: rotationCentre.y + (local.x - rotationCentre.x) * Math.sin(radians) + (local.y - rotationCentre.y) * Math.cos(radians)
    };
    expect(inverseTransformPointForObject(molecule, page).x).toBeCloseTo(local.x, 6);
    const mark = { x: page.x - 5, y: page.y - 5, width: 10, height: 10, rotation: 90 };
    const centre = atomProblemBadgeCentre(molecule, "b", { marks: [mark] })!;
    expect(intersects(badgeBox(centre), { x: local.x - 5, y: local.y - 5, width: 10, height: 10 })).toBe(false);
    expect(intersects(badgeBox(centre), labelOf(molecule, "b").box)).toBe(false);
  });

  it("is undefined for an atom the molecule does not have", () => {
    expect(atomProblemBadgeCentre(ethane({}), "missing")).toBeUndefined();
  });
});
