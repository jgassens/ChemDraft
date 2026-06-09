import { describe, expect, it } from "vitest";
import { flattenPerspectiveFrom3D, type ViewMatrix } from "./perspective";
import type { MoleculeAtom, MoleculeBond, MoleculeObject } from "./schemas";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

type AtomSpec = { id: string; element: string; x: number; y: number };
type BondSpec = {
  id: string;
  from: string;
  to: string;
  order?: MoleculeBond["order"];
  style?: "wedge" | "hashed";
};

function molecule(atoms: AtomSpec[], bonds: BondSpec[]): MoleculeObject {
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
    structure: "MOCK",
    atoms: atoms.map(
      ({ id, element, x, y }): MoleculeAtom => ({ id, element, x, y, formalCharge: 0 })
    ),
    bonds: bonds.map(
      ({ id, from, to, order = "single", style }): MoleculeBond => ({
        id,
        fromAtomId: from,
        toAtomId: to,
        order,
        ...(style ? { display: { bondStyle: style } } : {})
      })
    ),
    superatoms: [],
    rGroups: []
  };
}

const IDENTITY: ViewMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// Squash y → 0: every atom projects onto the x-axis (edge-on for any center).
const Y_SQUASH: ViewMatrix = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function stereoBonds(mol: MoleculeObject): MoleculeBond[] {
  return mol.bonds.filter(
    (bond) => bond.display?.bondStyle === "wedge" || bond.display?.bondStyle === "hashed"
  );
}

/** Independent reimplementation of the 4-substituent parity sign (cross-check). */
function parity4Sign(p: ReadonlyArray<readonly [number, number, number]>): number {
  const [n1, n2, n3, n4] = p;
  const a = [n2[0] - n1[0], n2[1] - n1[1], n2[2] - n1[2]];
  const b = [n3[0] - n1[0], n3[1] - n1[1], n3[2] - n1[2]];
  const c = [n4[0] - n1[0], n4[1] - n1[1], n4[2] - n1[2]];
  const det =
    a[0] * (b[1] * c[2] - b[2] * c[1]) -
    a[1] * (b[0] * c[2] - b[2] * c[0]) +
    a[2] * (b[0] * c[1] - b[1] * c[0]);
  return Math.sign(det);
}

/**
 * A single tetrahedral stereocenter C(a0) bonded to F, Cl, Br, I, built from a
 * tetrahedron of the requested handedness. The original 2D is the orthographic
 * projection (drop z); the drawn wedge sits on bond a0→a1.
 */
function chiralCenter(handedness: 1 | -1, drawnStyle: "wedge" | "hashed" = "wedge") {
  // Alternating cube vertices = regular tetrahedron; this id-order has parity +1.
  const verts: Array<[number, number, number]> =
    handedness === 1
      ? [
          [1, 1, 1],
          [-1, -1, 1],
          [-1, 1, -1],
          [1, -1, -1]
        ]
      : [
          [1, 1, 1],
          [-1, -1, 1],
          [1, -1, -1],
          [-1, 1, -1]
        ];
  const coords3d = [0, 0, 0, ...verts.flat()];
  const mol = molecule(
    [
      { id: "a0", element: "C", x: 0, y: 0 },
      { id: "a1", element: "F", x: verts[0][0], y: verts[0][1] },
      { id: "a2", element: "Cl", x: verts[1][0], y: verts[1][1] },
      { id: "a3", element: "Br", x: verts[2][0], y: verts[2][1] },
      { id: "a4", element: "I", x: verts[3][0], y: verts[3][1] }
    ],
    [
      { id: "b1", from: "a0", to: "a1", style: drawnStyle },
      { id: "b2", from: "a0", to: "a2" },
      { id: "b3", from: "a0", to: "a3" },
      { id: "b4", from: "a0", to: "a4" }
    ]
  );
  return { mol, coords3d };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("flattenPerspectiveFrom3D — input contract", () => {
  it("throws when coords3d length does not match atomCount*3", () => {
    const { mol } = chiralCenter(1);
    expect(() => flattenPerspectiveFrom3D(mol, [0, 0, 0], IDENTITY)).toThrow(/coords3d length/);
  });

  it("throws when viewMatrix is not 4×4", () => {
    const { mol, coords3d } = chiralCenter(1);
    expect(() => flattenPerspectiveFrom3D(mol, coords3d, [1, 0, 0, 1])).toThrow(/16 elements/);
  });
});

describe("flattenPerspectiveFrom3D — achiral / no specified stereo", () => {
  it("commits a flat formaldehyde-like fragment with no wedges and no crossings", () => {
    const mol = molecule(
      [
        { id: "a0", element: "C", x: 0, y: 0 },
        { id: "a1", element: "O", x: 0, y: 1 },
        { id: "a2", element: "H", x: -1, y: -1 },
        { id: "a3", element: "H", x: 1, y: -1 }
      ],
      [
        { id: "b1", from: "a0", to: "a1", order: "double" },
        { id: "b2", from: "a0", to: "a2" },
        { id: "b3", from: "a0", to: "a3" }
      ]
    );
    const coords3d = [0, 0, 0, 0, 1, 0, -1, -1, 0, 1, -1, 0];
    const result = flattenPerspectiveFrom3D(mol, coords3d, IDENTITY);
    expect(result.status).toBe("committed");
    expect(stereoBonds(result.mol2dProjected as MoleculeObject)).toHaveLength(0);
    expect(result.crossings).toHaveLength(0);
    expect(result.stereoCenters).toHaveLength(0);
  });
});

describe("flattenPerspectiveFrom3D — single stereocenter", () => {
  it("commits and places exactly one encoding-sound wedge (handedness +1)", () => {
    const { mol, coords3d } = chiralCenter(1);
    const result = flattenPerspectiveFrom3D(mol, coords3d, IDENTITY);
    expect(result.status).toBe("committed");
    const projected = result.mol2dProjected as MoleculeObject;
    const wedges = stereoBonds(projected);
    expect(wedges).toHaveLength(1);
    // Narrow end (fromAtomId) must be the stereocenter.
    expect(wedges[0]?.fromAtomId).toBe("a0");
    expect(result.stereoCenters).toHaveLength(1);
    expect(result.stereoCenters[0]).toMatchObject({ atomId: "a0", status: "encoded" });
    expect(result.stereoCenters[0]?.referenceParitySign).not.toBe(0);
  });

  it("commits for the opposite enantiomer too (handedness -1)", () => {
    const { mol, coords3d } = chiralCenter(-1);
    const result = flattenPerspectiveFrom3D(mol, coords3d, IDENTITY);
    expect(result.status).toBe("committed");
    expect(stereoBonds(result.mol2dProjected as MoleculeObject)).toHaveLength(1);
    expect(result.stereoCenters[0]?.referenceParitySign).not.toBe(0);
  });

  it("preserves the chemical graph (no atom/bond/charge/connectivity drift)", () => {
    const { mol, coords3d } = chiralCenter(1);
    const result = flattenPerspectiveFrom3D(mol, coords3d, IDENTITY);
    expect(result.status).toBe("committed");
    const diff = result.stereoDiff;
    expect(diff).toBeDefined();
    expect(diff?.atomCountDelta).toBe(0);
    expect(diff?.bondCountDelta).toBe(0);
    expect(diff?.atomMultisetChanged).toBe(false);
    expect(diff?.bondOrderMultisetChanged).toBe(false);
    expect(diff?.netChargeDelta).toBe(0);
    expect(diff?.connectivityChanged).toBe(false);
  });

  it("REFUSES when the 3D conformer handedness contradicts the drawn wedge", () => {
    // +1 coordinates but a hashed drawn marker encodes the opposite center.
    const { mol, coords3d } = chiralCenter(1, "hashed");
    const result = flattenPerspectiveFrom3D(mol, coords3d, IDENTITY);
    expect(result.status).toBe("refused");
    expect(result.mol2dProjected).toBeUndefined();
    expect(result.stereoCenters[0]?.status).toBe("conformer-mismatch");
    expect(result.refusalReasons.join(" ")).toMatch(/contradicts the drawn wedge/);
  });

  it("REFUSES a specified center viewed edge-on (no legible sound wedge)", () => {
    const { mol, coords3d } = chiralCenter(1);
    const result = flattenPerspectiveFrom3D(mol, coords3d, Y_SQUASH);
    expect(result.status).toBe("refused");
    expect(result.stereoCenters[0]?.status).toBe("edge-on");
    expect(result.refusalReasons.join(" ")).toMatch(/edge-on/);
  });
});

describe("flattenPerspectiveFrom3D — unspecified stereo is never invented", () => {
  it("leaves an unspecified center plain even though the 3D has a handedness", () => {
    const { mol, coords3d } = chiralCenter(1);
    // Strip the drawn wedge → no specified stereo in the original.
    const unspecified: MoleculeObject = {
      ...mol,
      bonds: mol.bonds.map((bond) => ({ ...bond, display: undefined }))
    };
    const result = flattenPerspectiveFrom3D(unspecified, coords3d, IDENTITY);
    expect(result.status).toBe("committed");
    expect(stereoBonds(result.mol2dProjected as MoleculeObject)).toHaveLength(0);
    expect(result.stereoCenters).toHaveLength(0);
  });
});

describe("flattenPerspectiveFrom3D — vicinal centers share a bond (CSP)", () => {
  it("encodes both adjacent stereocenters on distinct bonds (no bond claimed twice)", () => {
    // Staggered ethane-like dimer: C1(a0)–C2(a3), each C also bonded to F/Cl/Br.
    const coords: Record<string, [number, number, number]> = {
      a0: [0, 0, 0], // C1
      a1: [-0.333, 0, 0.943], // F on C1
      a2: [-0.333, -0.816, -0.471], // Cl on C1
      a3: [1.5, 0, 0], // C2
      a4: [-0.333, 0.816, -0.471], // Br on C1
      a5: [1.833, -0.816, 0.471], // F on C2
      a6: [1.833, 0, -0.943], // Cl on C2
      a7: [1.833, 0.816, 0.471] // Br on C2
    };
    const order = ["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7"];
    const coords3d = order.flatMap((id) => coords[id]);
    const elements: Record<string, string> = {
      a0: "C",
      a1: "F",
      a2: "Cl",
      a3: "C",
      a4: "Br",
      a5: "F",
      a6: "Cl",
      a7: "Br"
    };
    const atoms: AtomSpec[] = order.map((id) => ({
      id,
      element: elements[id],
      x: coords[id][0],
      y: coords[id][1] // 2D = orthographic projection (drop z)
    }));

    const bondIdFor: Record<string, string> = {
      "a0-a1": "b01",
      "a0-a2": "b02",
      "a0-a3": "b03", // shared C1–C2 bond
      "a0-a4": "b04",
      "a3-a5": "b35",
      "a3-a6": "b36",
      "a3-a7": "b37"
    };

    // Author each center's drawn wedge on its most out-of-plane neighbor, with the
    // style that matches the 3D handedness (independent parity4 cross-check).
    const authorWedge = (
      center: string,
      neighborIdsSorted: string[]
    ): { bondId: string; style: NonNullable<BondSpec["style"]> } => {
      const conformerSign = parity4Sign(neighborIdsSorted.map((id) => coords[id]));
      const wedgeNeighbor = [...neighborIdsSorted].sort(
        (a, b) =>
          Math.abs(coords[b][2] - coords[center][2]) - Math.abs(coords[a][2] - coords[center][2])
      )[0];
      const drawn = (z: number) =>
        parity4Sign(
          neighborIdsSorted.map((id) =>
            id === wedgeNeighbor
              ? ([coords[id][0], coords[id][1], z] as [number, number, number])
              : ([coords[id][0], coords[id][1], 0] as [number, number, number])
          )
        );
      return {
        bondId: bondIdFor[`${center}-${wedgeNeighbor}`],
        style: drawn(1) === conformerSign ? "wedge" : "hashed"
      };
    };

    const c1 = authorWedge("a0", ["a1", "a2", "a3", "a4"]);
    const c2 = authorWedge("a3", ["a0", "a5", "a6", "a7"]);
    const drawnStyleByBond: Record<string, NonNullable<BondSpec["style"]>> = {
      [c1.bondId]: c1.style,
      [c2.bondId]: c2.style
    };

    const bonds: BondSpec[] = (
      [
        { id: "b01", from: "a0", to: "a1" },
        { id: "b02", from: "a0", to: "a2" },
        { id: "b03", from: "a0", to: "a3" },
        { id: "b04", from: "a0", to: "a4" },
        { id: "b35", from: "a3", to: "a5" },
        { id: "b36", from: "a3", to: "a6" },
        { id: "b37", from: "a3", to: "a7" }
      ] as BondSpec[]
    ).map((bond) => (drawnStyleByBond[bond.id] ? { ...bond, style: drawnStyleByBond[bond.id] } : bond));

    const mol = molecule(atoms, bonds);
    const result = flattenPerspectiveFrom3D(mol, coords3d, IDENTITY);

    expect(result.status).toBe("committed");
    const encoded = result.stereoCenters.filter((c) => c.status === "encoded");
    expect(encoded.map((c) => c.atomId).sort()).toEqual(["a0", "a3"]);
    const wedgeBondIds = encoded.map((c) => c.wedgeBondId);
    // No bond claimed by two centers.
    expect(new Set(wedgeBondIds).size).toBe(2);
    expect(stereoBonds(result.mol2dProjected as MoleculeObject)).toHaveLength(2);
  });
});

describe("flattenPerspectiveFrom3D — E/Z double bonds", () => {
  it("never wedges a double bond and warns when it is viewed edge-on", () => {
    // Substituent on a0 projects nearly collinear with the C=C axis.
    const mol = molecule(
      [
        { id: "a0", element: "C", x: 0, y: 0 },
        { id: "a1", element: "C", x: 2, y: 0 },
        { id: "a2", element: "Cl", x: -0.95, y: 0.08 },
        { id: "a3", element: "Cl", x: 2.95, y: -0.08 }
      ],
      [
        { id: "b1", from: "a0", to: "a1", order: "double" },
        { id: "b2", from: "a0", to: "a2" },
        { id: "b3", from: "a1", to: "a3" }
      ]
    );
    const coords3d = [0, 0, 0, 2, 0, 0, -0.95, 0.08, 0, 2.95, -0.08, 0];
    const result = flattenPerspectiveFrom3D(mol, coords3d, IDENTITY);
    expect(result.status).toBe("committed");
    expect(stereoBonds(result.mol2dProjected as MoleculeObject)).toHaveLength(0);
    expect(result.warnings.some((w) => w.code === "ez-edge-on")).toBe(true);
  });
});

describe("flattenPerspectiveFrom3D — over/under crossings from depth", () => {
  it("bakes a CrossingOverride with the nearer-z bond as front", () => {
    // bond1 (a0–a1) at z=0; bond2 (a2–a3) at z=1 crosses it → bond2 is front.
    const mol = molecule(
      [
        { id: "a0", element: "C", x: 0, y: 0 },
        { id: "a1", element: "C", x: 2, y: 2 },
        { id: "a2", element: "C", x: 0, y: 2 },
        { id: "a3", element: "C", x: 2, y: 0 }
      ],
      [
        { id: "b1", from: "a0", to: "a1" },
        { id: "bridge", from: "a1", to: "a2" }, // connectivity; shares atoms → not a crossing
        { id: "b2", from: "a2", to: "a3" }
      ]
    );
    const coords3d = [0, 0, 0, 2, 2, 0, 0, 2, 1, 2, 0, 1];
    const result = flattenPerspectiveFrom3D(mol, coords3d, IDENTITY);
    expect(result.status).toBe("committed");
    expect(result.crossings).toHaveLength(1);
    const crossing = result.crossings[0];
    expect(crossing.front.bondId).toBe("b2"); // the z=1 bond is nearer the viewer
    expect(crossing.bonds.map((b) => b.bondId).sort()).toEqual(["b1", "b2"]);
    expect(crossing.front.objectId).toBe("mol_1");
  });

  it("raises the cyclic-depth (Escher) canary on inconsistent pairwise fronts", () => {
    // Three bonds, three distinct crossings, depths engineered so A>B>C>A.
    const mol = molecule(
      [
        { id: "a0", element: "C", x: -5, y: 0 },
        { id: "a1", element: "C", x: 5, y: 2 },
        { id: "a2", element: "C", x: -5, y: 2 },
        { id: "a3", element: "C", x: 5, y: 0 },
        { id: "a4", element: "C", x: -5, y: 1.5 },
        { id: "a5", element: "C", x: 5, y: 1.5 }
      ],
      [
        { id: "A", from: "a0", to: "a1" },
        { id: "B", from: "a2", to: "a3" },
        { id: "C", from: "a4", to: "a5" }
      ]
    );
    // z per endpoint: A flat(0), B flat(-1), C steep gradient (-4 → +2).
    const coords3d = [
      -5, 0, 0, 5, 2, 0, // A
      -5, 2, -1, 5, 0, -1, // B
      -5, 1.5, -4, 5, 1.5, 2 // C
    ];
    const result = flattenPerspectiveFrom3D(mol, coords3d, IDENTITY);
    expect(result.status).toBe("committed");
    expect(result.crossings).toHaveLength(3);
    expect(result.warnings.some((w) => w.code === "cyclic-depth")).toBe(true);
  });
});
