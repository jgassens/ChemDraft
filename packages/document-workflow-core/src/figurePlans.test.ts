import { createEmptyDocument } from "@chemdraft/chem-core";
import { moleculeInkBounds } from "@chemdraft/layout-engine";
import { expect, it } from "vitest";
import { planFigureReaction } from "./figurePlans";
import { createSmilesMolecule } from "./molecule";

it("lays out two reaction steps without rows using one bond length between steps", () => {
  const document = createEmptyDocument();
  const molecule = createSmilesMolecule(document, { x: 100, y: 100 }, {
    atoms: [{ element: "C", x: 0, y: 0, charge: 0 }], bonds: []
  }, "C");
  const reactants = ["first-reactant", "second-reactant"].map(id => ({ ...molecule, id }));
  const products = ["first-product", "second-product"].map(id => ({ ...molecule, id }));
  const bondLength = 22;
  let id = 0;
  const { objects, placements } = planFigureReaction(reactants.map((reactant, index) => ({
    reactants: [reactant], products: [products[index]!], arrowKind: "forward"
  })), {
    anchor: { x: 100, y: 130 }, bondLength, textStyle: {},
    compoundNumbers: new Map(), nextId: kind => `${kind}-${++id}`
  });

  const firstProduct = moleculeInkBounds(placements.get(products[0]!.id)!);
  const nextReactant = moleculeInkBounds(placements.get(reactants[1]!.id)!);
  expect(placements.size).toBe(4);
  expect(objects.filter(object => object.type === "reaction")).toHaveLength(2);
  expect(nextReactant.y).toBeCloseTo(firstProduct.y);
  expect(nextReactant.x - (firstProduct.x + firstProduct.width)).toBeCloseTo(bondLength);
});
