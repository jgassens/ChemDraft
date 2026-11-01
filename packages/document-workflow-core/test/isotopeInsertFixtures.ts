import { expect } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";
import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import { isotopeFixtures } from "../src/isotopes.fixtures";

export const isotopeInsertSmiles = [
  ...isotopeFixtures.map(fixture => fixture.smiles),
  "[13CH4]",
  "[3H]C1C(c2ccccc2)ON=C1c1ccccc1",
  "[3H]C1(CC(=NO1)c1ccccc1)c1ccccc1"
];
export const isotopeReactions = [2, 3].flatMap(mass => [
  { reactants: ["[O-][N+]#Cc1ccccc1", `[${mass}H]/C=C/c1ccccc1`],
    products: [`[${mass}H]C1C(c2ccccc2)ON=C1c1ccccc1`] },
  { reactants: ["[O-][N+]#Cc1ccccc1", `[${mass}H]C(=C)c1ccccc1`],
    products: [`[${mass}H]C1(CC(=NO1)c1ccccc1)c1ccccc1`] }
]);

/** Compare explicit atom counts and the isotope's carbon neighbourhood as well as full identity. */
export function expectIsotopeGraph(molecule: MoleculeObject, sourceMolfile: string): void {
  const source = parseMolfileGraph(sourceMolfile);
  expect(molecule.atoms).toHaveLength(source.atoms.length);
  expect(molecule.bonds).toHaveLength(source.bonds.length);
  const signature = (graph: Pick<MoleculeObject, "atoms" | "bonds">) => {
    const neighbors = (id: string) => graph.bonds.flatMap(bond => {
      const other = bond.fromAtomId === id ? bond.toAtomId
        : bond.toAtomId === id ? bond.fromAtomId : undefined;
      return other ? [graph.atoms.find(atom => atom.id === other)!] : [];
    });
    return graph.atoms.filter(atom => atom.isotope || atom.element === "D" || atom.element === "T")
      .map(atom => {
        if (atom.element === "D" || atom.element === "T") {
          expect(atom.isotope).toBeUndefined();
          expect(neighbors(atom.id).map(other => other.element)).toEqual(["C"]);
        }
        return { element: atom.element, isotope: atom.isotope,
          attached: neighbors(atom.id).map(other => ({ element: other.element,
            neighbors: neighbors(other.id).map(next => next.element).sort() })) };
      });
  };
  expect(signature(molecule)).toEqual(signature(source));
}
