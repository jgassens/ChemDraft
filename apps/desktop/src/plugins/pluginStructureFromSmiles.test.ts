/**
 * The plugin layout capability, against the real depiction engine.
 *
 * What matters here is not that a molecule comes back — it is that the object a PLUGIN gets is the
 * same object PASTING the same SMILES produces. Two paths that build molecules differently would
 * eventually disagree about bond lengths, double-bond sides, or geometry, and the disagreement would
 * only show up as a drawing that looks subtly wrong.
 */
import { describe, expect, it } from "vitest";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";

import {
  createPhase4Document,
  createSmilesMolecule,
  insertSmilesMolecule,
  SMILES_PASTE_SOURCE,
  type PastedStructureDepiction
} from "../documentWorkflow";

const SMILES = "CC(=O)Oc1ccccc1C(=O)O"; // aspirin

function depiction(smiles: string): PastedStructureDepiction {
  const drawn = depictSmiles2D(smiles);
  return {
    atoms: drawn.atoms.map((atom) => ({
      element: atom.element,
      x: atom.x,
      y: atom.y,
      charge: atom.charge
    })),
    bonds: drawn.bonds.map((bond) => ({
      from: bond.from,
      to: bond.to,
      order: bond.order === "aromatic" || bond.order === "unknown" ? "single" : bond.order,
      wedge: bond.wedge
    }))
  };
}

describe("createSmilesMolecule", () => {
  it("builds the same geometry the paste path inserts", () => {
    const document = createPhase4Document();
    const point = { x: 200, y: 200 };
    const built = createSmilesMolecule(document, point, depiction(SMILES), SMILES);
    const pasted = insertSmilesMolecule(document, point, depiction(SMILES), SMILES);

    const inserted = pasted.pages[0]!.objects.find((object) => object.type === "molecule");
    expect(inserted).toBeDefined();
    if (built.type !== "molecule" || inserted?.type !== "molecule") throw new Error("expected molecules");

    // Atom-for-atom, including coordinates: the shared builder is what guarantees this, and a future
    // divergence between the two paths fails here rather than in a drawing someone notices later.
    expect(built.atoms).toEqual(inserted.atoms);
    expect(built.bonds).toEqual(inserted.bonds);
    expect(built.structure).toBe(inserted.structure);
    expect(built.atoms.length).toBe(13);
  });

  it("records where the structure came from instead of claiming it was pasted", () => {
    // Provenance, not decoration: a structure inserted from a converted name did not come from the
    // clipboard, and the compatibility record is what a reader inspects to find out.
    const document = createPhase4Document();
    const built = createSmilesMolecule(document, { x: 100, y: 100 }, depiction(SMILES), SMILES, {
      objectIdPrefix: "mol_plugin",
      styleSource: "plugin-smiles",
      warningCode: "plugin.smiles_imported",
      warningMessage: "Generated an editable 2D structure from SMILES supplied by Name to Structure."
    });

    expect(built.id.startsWith("mol_plugin")).toBe(true);
    if (built.type !== "molecule") throw new Error("expected a molecule");
    expect(built.style?.source).toBe("plugin-smiles");
    expect(built.compatibility?.warnings?.[0]?.code).toBe("plugin.smiles_imported");
    expect(built.compatibility?.warnings?.[0]?.message).toContain("Name to Structure");

    const pasted = createSmilesMolecule(document, { x: 100, y: 100 }, depiction(SMILES), SMILES);
    if (pasted.type !== "molecule") throw new Error("expected a molecule");
    expect(pasted.style?.source).toBe(SMILES_PASTE_SOURCE.styleSource);
    expect(pasted.compatibility?.warnings?.[0]?.message).toContain("pasted SMILES");
  });

  it("refuses to build a molecule with no atoms rather than returning an empty object", () => {
    const document = createPhase4Document();
    expect(() => createSmilesMolecule(document, { x: 0, y: 0 }, { atoms: [], bonds: [] }, "")).toThrow(
      /no atoms/
    );
  });
});
