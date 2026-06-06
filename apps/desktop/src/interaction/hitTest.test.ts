import { describe, it, expect } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";

import { createPhase4Document, insertNativeSingleBondMolecule } from "../documentWorkflow";
import { hitTestDocument } from "./hitTest";

function singleBondMolecule() {
  const document = insertNativeSingleBondMolecule(createPhase4Document("hit-test"), { x: 200, y: 220 });
  const molecule = document.pages[0].objects[0];
  if (molecule.type !== "molecule") {
    throw new Error("expected a molecule fixture");
  }
  return { document, molecule: molecule as MoleculeObject };
}

describe("hitTestDocument (geometric source of truth)", () => {
  it("returns the atom exactly under the pointer", () => {
    const { document, molecule } = singleBondMolecule();
    const atom = molecule.atoms[0];

    const hit = hitTestDocument(document, { x: atom.x, y: atom.y });
    expect(hit).toMatchObject({ kind: "atom", atomId: atom.id, objectId: molecule.id });
    expect(hit?.distanceToPointer).toBeCloseTo(0);
  });

  it("picks the geometrically nearest atom, never whichever is listed/stacked first", () => {
    const { document, molecule } = singleBondMolecule();
    const far = molecule.atoms[1];

    const hit = hitTestDocument(document, { x: far.x + 1, y: far.y });
    expect(hit).toMatchObject({ kind: "atom", atomId: far.id });
    expect(hit?.distanceToPointer).toBeCloseTo(1);
  });

  it("reports a real, non-zero distance for bond hits (regression: used to be 0)", () => {
    const { document, molecule } = singleBondMolecule();
    const [a0, a1] = molecule.atoms;
    const midpoint = { x: (a0.x + a1.x) / 2, y: (a0.y + a1.y) / 2 };
    const offset = 2; // perpendicular to the horizontal bond, inside the 4px bond radius

    const hit = hitTestDocument(document, { x: midpoint.x, y: midpoint.y + offset });
    expect(hit?.kind).toBe("bond");
    // The old DOM-hinted bond path hard-coded distanceToPointer: 0, which corrupted the
    // cross-object sort. It must now be the true perpendicular distance.
    expect(hit?.distanceToPointer).toBeCloseTo(offset, 5);
    expect(hit?.distanceToPointer).toBeGreaterThan(0);
  });

  it("returns undefined over empty canvas", () => {
    const { document } = singleBondMolecule();
    expect(hitTestDocument(document, { x: 24, y: 24 })).toBeUndefined();
  });

  it("prefers the nearer molecule when two overlap, tie-broken by top layer", () => {
    const base = insertNativeSingleBondMolecule(createPhase4Document("overlap"), { x: 200, y: 220 });
    const document = insertNativeSingleBondMolecule(base, { x: 200, y: 220 });
    const [lower, upper] = document.pages[0].objects;
    if (lower.type !== "molecule" || upper.type !== "molecule") {
      throw new Error("expected two molecules");
    }

    // Exact overlap on the shared bond midpoint resolves to the top-most layer.
    const hit = hitTestDocument(document, { x: 200, y: 220 });
    expect(hit?.objectId).toBe(upper.id);
  });
});
