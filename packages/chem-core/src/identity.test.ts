import { describe, expect, it } from "vitest";
import {
  diffChemicalIdentity,
  snapshotChemicalIdentity,
  type CanonicalChemicalIdentity
} from "./identity";
import type { MoleculeAtom, MoleculeBond, MoleculeObject } from "./schemas";

type AtomSpec = { id: string; element: string; formalCharge?: number };
type BondSpec = {
  id: string;
  from: string;
  to: string;
  order?: MoleculeBond["order"];
  style?: "wedge" | "hashed" | "bold" | "dashed";
};

function atom({ id, element, formalCharge = 0 }: AtomSpec): MoleculeAtom {
  return { id, element, x: 0, y: 0, formalCharge };
}

function bond({ id, from, to, order = "single", style }: BondSpec): MoleculeBond {
  return {
    id,
    fromAtomId: from,
    toAtomId: to,
    order,
    ...(style ? { display: { bondStyle: style } } : {})
  };
}

function molecule(
  atoms: AtomSpec[],
  bonds: BondSpec[],
  overrides: Partial<MoleculeObject> = {}
): MoleculeObject {
  return {
    id: "mol_1",
    type: "molecule",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    style: {},
    structureFormat: "molfile-v3000",
    structure: "",
    atoms: atoms.map(atom),
    bonds: bonds.map(bond),
    superatoms: [],
    rGroups: [],
    ...overrides
  };
}

// A pseudo-chiral center: C bonded to four distinct halogens, one bond wedged.
function chiralCenter(wedgeStyle?: "wedge" | "hashed"): MoleculeObject {
  return molecule(
    [
      { id: "a0", element: "C" },
      { id: "a1", element: "F" },
      { id: "a2", element: "Cl" },
      { id: "a3", element: "Br" },
      { id: "a4", element: "I" }
    ],
    [
      { id: "b0", from: "a0", to: "a1", style: wedgeStyle },
      { id: "b1", from: "a0", to: "a2" },
      { id: "b2", from: "a0", to: "a3" },
      { id: "b3", from: "a0", to: "a4" }
    ]
  );
}

const matchingCanonicalizer = (value: string) => (): CanonicalChemicalIdentity => ({
  canonicalString: value,
  engine: "stub"
});

describe("snapshotChemicalIdentity (graph layer)", () => {
  it("captures coordinate-independent graph invariants", () => {
    const snap = snapshotChemicalIdentity(chiralCenter("wedge"));
    expect(snap.graph.atomCount).toBe(5);
    expect(snap.graph.bondCount).toBe(4);
    expect(snap.graph.atomMultiset).toEqual(["Br:0", "C:0", "Cl:0", "F:0", "I:0"]);
    expect(snap.graph.bondOrderMultiset).toEqual(["single", "single", "single", "single"]);
    expect(snap.graph.netCharge).toBe(0);
    expect(snap.graph.stereoMarkers).toHaveLength(1);
    expect(snap.graph.stereoMarkers[0]?.style).toBe("wedge");
    expect(snap.graph.isotopeRadicalSource).toBe("none");
    expect(snap.canonical).toBeUndefined();
  });

  it("ignores atom coordinates (identity is graph, not geometry)", () => {
    const a = chiralCenter("wedge");
    const moved: MoleculeObject = {
      ...a,
      atoms: a.atoms.map((atomValue) => ({ ...atomValue, x: atomValue.x + 50, y: atomValue.y - 17 }))
    };
    expect(snapshotChemicalIdentity(moved).graph.connectivitySignature).toBe(
      snapshotChemicalIdentity(a).graph.connectivitySignature
    );
  });

  it("treats bold/dashed as non-stereo and wedge/hashed as stereo markers", () => {
    const withBold = molecule(
      [
        { id: "a0", element: "C" },
        { id: "a1", element: "O" }
      ],
      [{ id: "b0", from: "a0", to: "a1", style: "bold" }]
    );
    expect(snapshotChemicalIdentity(withBold).graph.stereoMarkers).toHaveLength(0);
  });

  it("records isotope/radical from chemistry metadata with provenance", () => {
    const labeled = chiralCenter("wedge");
    labeled.chemistry = {
      isotopeLabels: ["13C"],
      stereochemistry: [],
      radicalCount: 1,
      warnings: []
    } as MoleculeObject["chemistry"];
    const snap = snapshotChemicalIdentity(labeled);
    expect(snap.graph.isotopeLabels).toEqual(["13C"]);
    expect(snap.graph.radicalCount).toBe(1);
    expect(snap.graph.isotopeRadicalSource).toBe("metadata");
  });
});

describe("diffChemicalIdentity", () => {
  it("identical achiral molecule → identical (nothing to perceive)", () => {
    const achiral = molecule(
      [
        { id: "a0", element: "C" },
        { id: "a1", element: "O" }
      ],
      [{ id: "b0", from: "a0", to: "a1" }]
    );
    const diff = diffChemicalIdentity(
      snapshotChemicalIdentity(achiral),
      snapshotChemicalIdentity(achiral)
    );
    expect(diff.verdict).toBe("identical");
  });

  it("identical molecule WITH stereo but NO engine → indeterminate (honest non-guarantee)", () => {
    const diff = diffChemicalIdentity(
      snapshotChemicalIdentity(chiralCenter("wedge")),
      snapshotChemicalIdentity(chiralCenter("wedge"))
    );
    expect(diff.verdict).toBe("indeterminate");
    expect(diff.perceivedStereoComparable).toBe(false);
  });

  it("identical molecule WITH stereo and matching engine canonical → identical", () => {
    const opts = { canonicalize: matchingCanonicalizer("C[C@](F)(Cl)Br") };
    const diff = diffChemicalIdentity(
      snapshotChemicalIdentity(chiralCenter("wedge"), opts),
      snapshotChemicalIdentity(chiralCenter("wedge"), opts)
    );
    expect(diff.verdict).toBe("identical");
    expect(diff.perceivedStereoComparable).toBe(true);
    expect(diff.canonicalChanged).toBe(false);
  });

  it("differing engine canonical → changed even when graph matches", () => {
    const diff = diffChemicalIdentity(
      snapshotChemicalIdentity(chiralCenter("wedge"), { canonicalize: matchingCanonicalizer("R") }),
      snapshotChemicalIdentity(chiralCenter("wedge"), { canonicalize: matchingCanonicalizer("S") })
    );
    expect(diff.verdict).toBe("changed");
    expect(diff.canonicalChanged).toBe(true);
  });

  it("inverted tetrahedral center (wedge → hashed) → changed", () => {
    const diff = diffChemicalIdentity(
      snapshotChemicalIdentity(chiralCenter("wedge")),
      snapshotChemicalIdentity(chiralCenter("hashed"))
    );
    expect(diff.verdict).toBe("changed");
    expect(diff.stereoMarkers.directionOrStyleFlipped).toBe(1);
  });

  it("known → unknown stereo (wedge removed) → changed", () => {
    const diff = diffChemicalIdentity(
      snapshotChemicalIdentity(chiralCenter("wedge")),
      snapshotChemicalIdentity(chiralCenter(undefined))
    );
    expect(diff.verdict).toBe("changed");
    expect(diff.stereoMarkers.becameUnspecified).toBe(1);
  });

  it("unspecified → specified stereo (wedge added) → changed", () => {
    const diff = diffChemicalIdentity(
      snapshotChemicalIdentity(chiralCenter(undefined)),
      snapshotChemicalIdentity(chiralCenter("wedge"))
    );
    expect(diff.verdict).toBe("changed");
    expect(diff.stereoMarkers.becameSpecified).toBe(1);
  });

  it("atom/bond count drift → changed", () => {
    const fewer = molecule(
      [
        { id: "a0", element: "C" },
        { id: "a1", element: "F" },
        { id: "a2", element: "Cl" },
        { id: "a3", element: "Br" }
      ],
      [
        { id: "b0", from: "a0", to: "a1" },
        { id: "b1", from: "a0", to: "a2" },
        { id: "b2", from: "a0", to: "a3" }
      ]
    );
    const diff = diffChemicalIdentity(
      snapshotChemicalIdentity(chiralCenter("wedge")),
      snapshotChemicalIdentity(fewer)
    );
    expect(diff.verdict).toBe("changed");
    expect(diff.atomCountDelta).toBe(-1);
    expect(diff.bondCountDelta).toBe(-1);
  });

  it("rewired connectivity (same counts & order multiset) → changed via WL signature", () => {
    const star = molecule(
      [
        { id: "a0", element: "C" },
        { id: "a1", element: "F" },
        { id: "a2", element: "Cl" },
        { id: "a3", element: "Br" }
      ],
      [
        { id: "b0", from: "a0", to: "a1" },
        { id: "b1", from: "a0", to: "a2" },
        { id: "b2", from: "a0", to: "a3" }
      ]
    );
    const chain = molecule(
      [
        { id: "a0", element: "C" },
        { id: "a1", element: "F" },
        { id: "a2", element: "Cl" },
        { id: "a3", element: "Br" }
      ],
      [
        { id: "b0", from: "a0", to: "a1" },
        { id: "b1", from: "a1", to: "a2" },
        { id: "b2", from: "a2", to: "a3" }
      ]
    );
    const diff = diffChemicalIdentity(
      snapshotChemicalIdentity(star),
      snapshotChemicalIdentity(chain)
    );
    expect(diff.connectivityChanged).toBe(true);
    expect(diff.verdict).toBe("changed");
  });

  it("charge change → changed (net charge + multiset)", () => {
    const cation = chiralCenter("wedge");
    cation.atoms = cation.atoms.map((a) => (a.id === "a0" ? { ...a, formalCharge: 1 } : a));
    const diff = diffChemicalIdentity(
      snapshotChemicalIdentity(chiralCenter("wedge")),
      snapshotChemicalIdentity(cation)
    );
    expect(diff.verdict).toBe("changed");
    expect(diff.netChargeDelta).toBe(1);
    expect(diff.atomMultisetChanged).toBe(true);
  });

  it("isotope / radical change → changed; preserved metadata → no delta", () => {
    const base = chiralCenter("wedge");
    base.chemistry = { isotopeLabels: [], stereochemistry: [], radicalCount: 0, warnings: [] } as MoleculeObject["chemistry"];
    const labeled = chiralCenter("wedge");
    labeled.chemistry = { isotopeLabels: ["13C"], stereochemistry: [], radicalCount: 1, warnings: [] } as MoleculeObject["chemistry"];

    const changed = diffChemicalIdentity(
      snapshotChemicalIdentity(base),
      snapshotChemicalIdentity(labeled)
    );
    expect(changed.verdict).toBe("changed");
    expect(changed.isotopeLabelsChanged).toBe(true);
    expect(changed.radicalCountDelta).toBe(1);

    const preserved = diffChemicalIdentity(
      snapshotChemicalIdentity(labeled),
      snapshotChemicalIdentity(labeled)
    );
    expect(preserved.isotopeLabelsChanged).toBe(false);
    expect(preserved.radicalCountDelta).toBe(0);
  });
});
