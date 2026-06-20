import { describe, expect, it } from "vitest";
import {
  diffPerceptions,
  perceiveStereoWithOracle,
  type StereoPerception,
  type StereoPerceptionEngine
} from "./oracle";
import type { MoleculeObject } from "./schemas";

function sampleMolecule(): MoleculeObject {
  return {
    id: "mol_1",
    type: "molecule",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    style: {},
    structureFormat: "molfile-v3000",
    structure: "ORIGINAL",
    atoms: [
      { id: "a0", element: "C", x: 0, y: 0, formalCharge: 0 },
      { id: "a1", element: "F", x: 1, y: 0, formalCharge: 0 }
    ],
    bonds: [{ id: "b1", fromAtomId: "a0", toAtomId: "a1", order: "single", display: { bondStyle: "wedge" } }],
    superatoms: [],
    rGroups: []
  };
}

/**
 * A deliberately HOSTILE engine: it scribbles all over whatever molecule and
 * coordinates it is handed, exactly like RDKit's `AssignStereochemistryFrom3D`
 * with `replaceExistingTags=True` would. If the oracle's clone barrier leaks, the
 * caller's molecule will show this damage.
 */
const mutatingEngine: StereoPerceptionEngine = {
  name: "hostile-mock",
  perceiveFrom3D(molCopy, coords3dCopy): StereoPerception {
    molCopy.structure = "CORRUPTED";
    molCopy.atoms[0].element = "XX";
    molCopy.atoms[0].formalCharge = 99;
    if (molCopy.bonds[0].display) molCopy.bonds[0].display.bondStyle = "hashed";
    molCopy.bonds.push({ id: "bInjected", fromAtomId: "a0", toAtomId: "a1", order: "triple" });
    coords3dCopy[0] = 99999;
    return { centers: [{ atomId: "a0", descriptor: "R" }], notes: ["hostile mock ran"] };
  }
};

describe("Phase 1C oracle — non-mutation discipline barrier", () => {
  it("a hostile engine that corrupts its copy leaves the caller's molecule byte-for-byte intact", () => {
    const original = sampleMolecule();
    const pristine = structuredClone(original);
    const coords = [0, 0, 0, 1, 0, 0];
    const pristineCoords = [...coords];

    const result = perceiveStereoWithOracle(mutatingEngine, original, coords);

    // The engine ran and returned its perception...
    expect(result.engine).toBe("hostile-mock");
    expect(result.perception.centers[0]).toEqual({ atomId: "a0", descriptor: "R" });

    // ...but the caller's molecule and coordinates are completely untouched.
    expect(original).toEqual(pristine);
    expect(original.structure).toBe("ORIGINAL");
    expect(original.atoms[0].element).toBe("C");
    expect(original.atoms[0].formalCharge).toBe(0);
    expect(original.bonds).toHaveLength(1);
    expect(original.bonds[0].display?.bondStyle).toBe("wedge");
    expect(coords).toEqual(pristineCoords);
  });

  it("accepts a read-only ArrayLike (e.g. Float64Array) for coordinates without aliasing it", () => {
    const original = sampleMolecule();
    const coords = new Float64Array([0, 0, 0, 1, 0, 0]);
    perceiveStereoWithOracle(mutatingEngine, original, coords);
    expect(coords[0]).toBe(0); // not mutated through the oracle copy
  });
});

describe("Phase 1C oracle — perception diff", () => {
  const perc = (centers: StereoPerception["centers"]): StereoPerception => ({ centers, notes: [] });

  it("flags an inverted center", () => {
    const d = diffPerceptions(perc([{ atomId: "a0", descriptor: "R" }]), perc([{ atomId: "a0", descriptor: "S" }]));
    expect(d.identical).toBe(false);
    expect(d.invertedCenters).toEqual(["a0"]);
  });

  it("flags a lost specification (R → unspecified)", () => {
    const d = diffPerceptions(
      perc([{ atomId: "a0", descriptor: "R" }]),
      perc([{ atomId: "a0", descriptor: "unspecified" }])
    );
    expect(d.lostCenters).toEqual(["a0"]);
    expect(d.identical).toBe(false);
  });

  it("flags a newly-invented specification (unspecified → S)", () => {
    const d = diffPerceptions(
      perc([{ atomId: "a0", descriptor: "unspecified" }]),
      perc([{ atomId: "a0", descriptor: "S" }])
    );
    expect(d.gainedCenters).toEqual(["a0"]);
    expect(d.identical).toBe(false);
  });

  it("reports identical when descriptors are preserved", () => {
    const d = diffPerceptions(
      perc([{ atomId: "a0", descriptor: "R" }, { atomId: "a1", descriptor: "S" }]),
      perc([{ atomId: "a0", descriptor: "R" }, { atomId: "a1", descriptor: "S" }])
    );
    expect(d.identical).toBe(true);
  });
});
