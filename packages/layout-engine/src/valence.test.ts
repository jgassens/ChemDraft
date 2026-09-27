import { describe, expect, it } from "vitest";
import { DefaultNativeDrawingStyle, type MoleculeAtom, type MoleculeBond, type MoleculeObject } from "@chemdraft/chem-core";

import {
  atomBondOrderUsageMap,
  atomDisplayLabel,
  nativeAtomBondOrderUsage,
  nativeBondOrderResolution,
  planMoleculeAtomLabels
} from "./index";
import { aromaticFixtures, unresolvableAromaticRing } from "./testing";

// Aromatic bonds count at their Kekulé orders. A flat 1.5 per bond drew pyrrole's N–H as a bare N;
// a flat 1 made every aromatic carbon CH2. These pin the one implementation both paths use.

const visibleCarbons = (atoms: readonly MoleculeAtom[]): MoleculeAtom[] =>
  atoms.map((atom) => (atom.element === "C" ? { ...atom, labelVisible: true } : atom));

const hydrogensInLabel = (label: string | undefined): number => {
  const match = label?.match(/H(\d*)/);
  return match ? (match[1] ? Number(match[1]) : 1) : 0;
};

describe("aromatic bonds count at their Kekulé orders", () => {
  it.each(aromaticFixtures.map((fixture) => [fixture.name, fixture] as const))(
    "%s: heteroatom labels match the Kekulé structure",
    (_name, fixture) => {
      for (const [atomId, expected] of Object.entries(fixture.heteroatomLabels)) {
        const atom = fixture.atoms.find((candidate) => candidate.id === atomId)!;
        expect(atomDisplayLabel(atom, fixture.aromatic, DefaultNativeDrawingStyle, fixture.atoms), atomId).toBe(expected);
      }
    }
  );

  it.each(aromaticFixtures.map((fixture) => [fixture.name, fixture] as const))(
    "%s: every atom's usage and drawn H count equal the hand-written Kekulé form's",
    (_name, fixture) => {
      const atoms = visibleCarbons(fixture.atoms);
      const aromaticUsage = atomBondOrderUsageMap(atoms, fixture.aromatic);
      const kekuleUsage = atomBondOrderUsageMap(atoms, fixture.kekule);
      for (const atom of atoms) {
        expect(aromaticUsage.get(atom.id), atom.id).toBe(kekuleUsage.get(atom.id));
        expect(nativeAtomBondOrderUsage(atom.id, fixture.aromatic, atoms), atom.id).toBe(kekuleUsage.get(atom.id));
        expect(
          atomDisplayLabel(atom, fixture.aromatic, DefaultNativeDrawingStyle, atoms),
          atom.id
        ).toBe(atomDisplayLabel(atom, fixture.kekule, DefaultNativeDrawingStyle, atoms));
      }
      // Every ring atom ends up with a whole number of bonds: no 4.5 on a fused carbon.
      for (const value of aromaticUsage.values()) {
        expect(Number.isInteger(value)).toBe(true);
      }
      expect(nativeBondOrderResolution(atoms, fixture.aromatic).unresolvedAtomIds.size).toBe(0);
    }
  );

  it("draws the H count a chemist expects on each aromatic carbon", () => {
    const naphthalene = aromaticFixtures.find((fixture) => fixture.name === "naphthalene")!;
    const atoms = visibleCarbons(naphthalene.atoms);
    const hydrogens = atoms.map((atom) =>
      hydrogensInLabel(atomDisplayLabel(atom, naphthalene.aromatic, DefaultNativeDrawingStyle, atoms))
    );
    // a4 and a5 are the fusion carbons.
    expect(hydrogens).toEqual([1, 1, 1, 1, 0, 0, 1, 1, 1, 1]);
  });

  it("returns the input array untouched when there is no aromatic bond, so kekulized input counts as before", () => {
    for (const fixture of aromaticFixtures) {
      const resolution = nativeBondOrderResolution(fixture.atoms, fixture.kekule);
      expect(resolution.bonds).toBe(fixture.kekule);
      expect(resolution.kekuleOrders.size).toBe(0);
      expect(resolution.unresolvedAtomIds.size).toBe(0);
    }
  });

  it("reports each resolved aromatic bond's Kekulé order by bond id", () => {
    const benzene = aromaticFixtures.find((fixture) => fixture.name === "benzene")!;
    const orders = nativeBondOrderResolution(benzene.atoms, benzene.aromatic).kekuleOrders;
    expect([...orders.keys()].sort()).toEqual(benzene.aromatic.map((bond) => bond.id).sort());
    expect([...orders.values()].filter((order) => order === 2)).toHaveLength(3);
  });

  it("resolves a ring whose aromatic run is closed by an explicit double bond", () => {
    // One bond of a pasted benzene redrawn as double: the five aromatic bonds are a path, not a
    // ring, among themselves, but the ring is still there and still has a Kekulé pattern.
    const benzene = aromaticFixtures.find((fixture) => fixture.name === "benzene")!;
    const mixed = benzene.aromatic.map((bond, index): MoleculeBond => (index === 0 ? { ...bond, order: "double" } : bond));
    const resolution = nativeBondOrderResolution(benzene.atoms, mixed);
    expect(resolution.unresolvedAtomIds.size).toBe(0);
    const usage = atomBondOrderUsageMap(benzene.atoms, mixed);
    expect([...usage.values()]).toEqual([3, 3, 3, 3, 3, 3]);
  });
});

describe("aromatic rings with no Kekulé pattern", () => {
  it("counts their bonds as single, as the SMILES writer does, and names every atom as unresolved", () => {
    const { atoms, bonds } = unresolvableAromaticRing();
    const resolution = nativeBondOrderResolution(atoms, bonds);
    expect(resolution.unresolvedAromaticBondCount).toBe(5);
    expect([...resolution.unresolvedAtomIds].sort()).toEqual(atoms.map((atom) => atom.id).sort());
    expect(resolution.bonds.every((bond) => bond.order === "single")).toBe(true);
    expect([...atomBondOrderUsageMap(atoms, bonds).values()]).toEqual([2, 2, 2, 2, 2]);
  });

  it("names an aromatic bond outside any ring as unresolved too", () => {
    const atoms: MoleculeAtom[] = [
      { id: "p", element: "C", x: 0, y: 0, formalCharge: 0 },
      { id: "q", element: "C", x: 10, y: 0, formalCharge: 0 }
    ];
    const bonds: MoleculeBond[] = [{ id: "pq", fromAtomId: "p", toAtomId: "q", order: "aromatic" }];
    const resolution = nativeBondOrderResolution(atoms, bonds);
    expect(resolution.nonRingAromaticBondCount).toBe(1);
    expect([...resolution.unresolvedAtomIds].sort()).toEqual(["p", "q"]);
  });

  it("cannot judge a ring whose atoms were not supplied, and says so instead of guessing", () => {
    const benzene = aromaticFixtures.find((fixture) => fixture.name === "benzene")!;
    const resolution = nativeBondOrderResolution([], benzene.aromatic);
    expect(resolution.unresolvedAtomIds.size).toBe(6);
    expect(resolution.kekuleOrders.size).toBe(0);
  });
});

describe("one resolution per molecule", () => {
  const indole = aromaticFixtures.find((fixture) => fixture.name === "indole")!;

  it("serves every atom of a molecule from one resolution", () => {
    const first = nativeBondOrderResolution(indole.atoms, indole.aromatic);
    expect(nativeBondOrderResolution(indole.atoms, indole.aromatic)).toBe(first);

    const molecule = {
      id: "mol_indole",
      type: "molecule",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      style: {},
      structureFormat: "molfile-v2000",
      structure: "",
      atoms: [...indole.atoms],
      bonds: [...indole.aromatic],
      superatoms: [],
      rGroups: []
    } as MoleculeObject;
    const labels = planMoleculeAtomLabels(molecule);
    const resolved = nativeBondOrderResolution(molecule.atoms, molecule.bonds);
    // The planner's labels were served by this same cached resolution.
    expect(nativeBondOrderResolution(molecule.atoms, molecule.bonds)).toBe(resolved);
    expect(labels.find((plan) => plan.atom.id === "a0")?.label).toBe("NH");
  });

  it("re-resolves when a bond of the same array is edited in place", () => {
    const atoms = indole.atoms.map((atom) => ({ ...atom }));
    const bonds = indole.aromatic.map((bond) => ({ ...bond }));
    const before = nativeBondOrderResolution(atoms, bonds);
    expect(before.unresolvedAtomIds.size).toBe(0);
    bonds[0]!.order = "double";
    const after = nativeBondOrderResolution(atoms, bonds);
    expect(after).not.toBe(before);
    expect(after.bonds[0]!.order).toBe("double");
    atoms[0]!.element = "O";
    expect(nativeBondOrderResolution(atoms, bonds)).not.toBe(after);
  });

  it("stays fast on a large aromatic molecule: labels for 120 atoms do not re-run the search per atom", () => {
    const atoms: MoleculeAtom[] = [];
    const bonds: MoleculeBond[] = [];
    for (let ringIndex = 0; ringIndex < 20; ringIndex += 1) {
      const ids = Array.from({ length: 6 }, (_, index) => `r${ringIndex}_${index}`);
      ids.forEach((id, index) => atoms.push({ id, element: "C", x: ringIndex * 100 + index * 10, y: 0, formalCharge: 0 }));
      ids.forEach((id, index) => bonds.push({ id: `${id}_b`, fromAtomId: id, toAtomId: ids[(index + 1) % 6]!, order: "aromatic" }));
      if (ringIndex > 0) {
        bonds.push({ id: `link${ringIndex}`, fromAtomId: `r${ringIndex - 1}_3`, toAtomId: `r${ringIndex}_0`, order: "single" });
      }
    }
    const started = performance.now();
    const labels = atoms.map((atom) => atomDisplayLabel({ ...atom, labelVisible: true }, bonds, DefaultNativeDrawingStyle, atoms));
    expect(performance.now() - started).toBeLessThan(500);
    expect(labels.filter((label) => label === "CH")).toHaveLength(120 - 38);
  });
});
