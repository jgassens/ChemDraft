import { describe, expect, it } from "vitest";
import {
  ChemDraftSyntheticStylePreset,
  createEmptyDocument,
  nativeDrawingStyleFromObjectStyle,
  stylePresetToObjectStyle,
  type DocumentObject,
  type DocumentPage,
  type GraphicObject,
  type MoleculeObject
} from "@chemdraft/chem-core";
import {
  atomDisplayLabel,
  atomDegrees,
  atomLabelAnchorOffset,
  atomLabelHaloWidthPx,
  averageDefinedDepthWeights,
  depthCuedLabelColor,
  depthCuedLabelScale,
  findNearestAtomAtPoint,
  findNearestBondHit,
  findNearestAtomHit,
  nativeMoleculeRings,
  nativeMoleculeRingAtPoint,
  planBondExtension,
  planNativeArtVisual,
  planPageSvgRender,
  planMoleculeAtomLabels,
  planFreeformBondExtension,
  ringInteriorDoubleBondSides,
  type BondExtensionPlanningInput,
  type PageSvgElementFragment,
  type PageSvgFragment
} from "./index";

const baseInput = {
  atoms: [
    { id: "atom_001", x: 160, y: 220 },
    { id: "atom_002", x: 240, y: 220 }
  ],
  bonds: [{ fromAtomId: "atom_001", toAtomId: "atom_002" }],
  bondLength: 80,
  hitRadius: 104,
  pageBounds: { x: 0, y: 0, width: 816, height: 1056 },
  objectBounds: { x: 152, y: 204, width: 96, height: 32 }
} satisfies Omit<BondExtensionPlanningInput, "clickPoint">;

describe("layout-engine molecule growth planning", () => {
  it("reports atom degrees from native molecule graph edges", () => {
    expect(atomDegrees(baseInput.atoms, baseInput.bonds)).toEqual(new Map([
      ["atom_001", 1],
      ["atom_002", 1]
    ]));
  });

  it("plans 120-degree growth from the nearest eligible atom", () => {
    const plan = planBondExtension({
      ...baseInput,
      clickPoint: { x: 300, y: 220 }
    });

    expect(plan?.sourceAtomId).toBe("atom_002");
    expect(plan?.terminalAtomId).toBe("atom_002");
    expect(plan?.neighborAtomIds).toEqual(["atom_001"]);
    expect(plan?.newAtomPoint.x).toBeCloseTo(280, 3);
    expect(plan?.newAtomPoint.y).toBeCloseTo(289.282, 3);
    expect(plan?.direction.x).toBeCloseTo(0.5, 3);
    expect(plan?.direction.y).toBeCloseTo(0.866, 3);
  });

  it("uses the click side to choose between the two 120-degree candidates", () => {
    const plan = planBondExtension({
      ...baseInput,
      clickPoint: { x: 282, y: 290 }
    });

    expect(plan?.terminalAtomId).toBe("atom_002");
    expect(plan?.newAtomPoint.x).toBeCloseTo(280, 3);
    expect(plan?.newAtomPoint.y).toBeCloseTo(289.282, 3);
  });

  it("lets subtle pointer movement steer terminal growth above or below the chain", () => {
    const upward = planBondExtension({
      ...baseInput,
      clickPoint: { x: 248, y: 212 }
    });
    const downward = planBondExtension({
      ...baseInput,
      clickPoint: { x: 248, y: 228 }
    });

    expect(upward?.sourceAtomId).toBe("atom_002");
    expect(downward?.sourceAtomId).toBe("atom_002");
    expect(upward?.newAtomPoint.x).toBeCloseTo(downward?.newAtomPoint.x ?? 0, 3);
    expect(upward?.newAtomPoint.y).toBeLessThan(220);
    expect(downward?.newAtomPoint.y).toBeGreaterThan(220);
  });

  it("lets explicit steering choose a soft-crowded terminal direction", () => {
    const upwardCrowded = planBondExtension({
      ...baseInput,
      atoms: [
        { id: "atom_001", x: 180, y: 100 },
        { id: "atom_002", x: 100, y: 100 },
        { id: "atom_soft_neighbor", x: 100, y: 176 }
      ],
      bonds: [{ fromAtomId: "atom_001", toAtomId: "atom_002" }],
      objectBounds: { x: 72, y: 92, width: 108, height: 84 },
      clickPoint: { x: 97, y: 108 }
    });

    expect(upwardCrowded?.sourceAtomId).toBe("atom_002");
    expect(upwardCrowded?.newAtomPoint.x).toBeCloseTo(60, 3);
    expect(upwardCrowded?.newAtomPoint.y).toBeCloseTo(169.282, 3);
  });

  it("targets an existing atom at the guided endpoint instead of placing a duplicate", () => {
    const duplicateEndpoint = planBondExtension({
      ...baseInput,
      atoms: [
        { id: "atom_001", x: 180, y: 100 },
        { id: "atom_002", x: 100, y: 100 },
        { id: "atom_duplicate_neighbor", x: 60, y: 169.282 }
      ],
      bonds: [{ fromAtomId: "atom_001", toAtomId: "atom_002" }],
      objectBounds: { x: 72, y: 92, width: 108, height: 84 },
      clickPoint: { x: 97, y: 108 }
    });

    expect(duplicateEndpoint?.sourceAtomId).toBe("atom_002");
    expect(duplicateEndpoint?.targetAtomId).toBe("atom_duplicate_neighbor");
    expect(duplicateEndpoint?.newAtomPoint.x).toBeCloseTo(60, 3);
    expect(duplicateEndpoint?.newAtomPoint.y).toBeCloseTo(169.282, 3);
  });

  it("keeps inward clicks on an atom from creating duplicate bonds over the neighbor", () => {
    const plan = planBondExtension({
      ...baseInput,
      clickPoint: { x: 210, y: 220 }
    });

    expect(plan?.terminalAtomId).toBe("atom_002");
    expect(plan?.newAtomPoint.x).toBeCloseTo(280, 3);
    expect(plan?.newAtomPoint.y).toBeCloseTo(289.282, 3);
  });

  it("offers ring closure when the selected 120-degree endpoint lands on an existing atom", () => {
    const bondLength = 80;
    const source = { id: "atom_006", x: 340, y: 230.718 };
    const closingDirection = { x: Math.cos(Math.PI / 3), y: Math.sin(Math.PI / 3) };
    const outwardDirection = { x: Math.cos(-Math.PI / 3), y: Math.sin(-Math.PI / 3) };
    const openCyclohexane = {
      atoms: [
        { id: "atom_001", x: 380, y: 300 },
        { id: "atom_002", x: 340, y: 369.282 },
        { id: "atom_003", x: 260, y: 369.282 },
        { id: "atom_004", x: 220, y: 300 },
        { id: "atom_005", x: 260, y: 230.718 },
        source
      ],
      bonds: [
        { fromAtomId: "atom_001", toAtomId: "atom_002" },
        { fromAtomId: "atom_002", toAtomId: "atom_003" },
        { fromAtomId: "atom_003", toAtomId: "atom_004" },
        { fromAtomId: "atom_004", toAtomId: "atom_005" },
        { fromAtomId: "atom_005", toAtomId: "atom_006" }
      ],
      bondLength,
      hitRadius: 12,
      maxBondsPerAtom: 4,
      preferredAtomId: "atom_006",
      pageBounds: baseInput.pageBounds
    };

    const closure = planBondExtension({
      ...openCyclohexane,
      clickPoint: {
        x: source.x + closingDirection.x * 6,
        y: source.y + closingDirection.y * 6
      }
    });
    const outward = planBondExtension({
      ...openCyclohexane,
      clickPoint: {
        x: source.x + outwardDirection.x * 6,
        y: source.y + outwardDirection.y * 6
      }
    });

    expect(closure).toMatchObject({
      sourceAtomId: "atom_006",
      targetAtomId: "atom_001",
      newAtomPoint: { x: 380, y: 300 }
    });
    expect(outward?.sourceAtomId).toBe("atom_006");
    expect(outward?.targetAtomId).toBeUndefined();
    expect(outward?.newAtomPoint.x).toBeCloseTo(source.x + outwardDirection.x * bondLength, 3);
    expect(outward?.newAtomPoint.y).toBeCloseTo(source.y + outwardDirection.y * bondLength, 3);
  });

  it("allows branching from non-terminal atoms while carbon valence is available", () => {
    const plan = planBondExtension({
      ...baseInput,
      atoms: [
        { id: "atom_001", x: 160, y: 220 },
        { id: "atom_002", x: 240, y: 220 },
        { id: "atom_003", x: 320, y: 220 }
      ],
      bonds: [
        { fromAtomId: "atom_001", toAtomId: "atom_002" },
        { fromAtomId: "atom_002", toAtomId: "atom_003" }
      ],
      objectBounds: { x: 152, y: 204, width: 176, height: 32 },
      clickPoint: { x: 240, y: 300 }
    });

    expect(plan?.sourceAtomId).toBe("atom_002");
    expect(plan?.neighborAtomIds).toEqual(["atom_001", "atom_003"]);
    expect(plan?.newAtomPoint.x).toBeCloseTo(240, 3);
    expect(plan?.newAtomPoint.y).toBeCloseTo(300, 3);
  });

  it("finds atom-level hover hits only when valence is available", () => {
    const hit = findNearestAtomHit({
      atoms: baseInput.atoms,
      bonds: baseInput.bonds,
      point: { x: 241, y: 222 },
      hitRadius: 16,
      maxBondsPerAtom: 4
    });

    expect(hit).toEqual({
      atomId: "atom_002",
      degree: 1,
      availableBonds: 3,
      distance: Math.sqrt(5)
    });

    expect(findNearestAtomHit({
      atoms: [{ id: "atom_001", x: 160, y: 220 }],
      bonds: [
        { fromAtomId: "atom_001", toAtomId: "atom_a" },
        { fromAtomId: "atom_001", toAtomId: "atom_b" },
        { fromAtomId: "atom_001", toAtomId: "atom_c" },
        { fromAtomId: "atom_001", toAtomId: "atom_d" }
      ],
      point: { x: 160, y: 220 },
      hitRadius: 16,
      maxBondsPerAtom: 4
    })).toBeUndefined();
  });

  it("finds nearest atoms without valence filtering for edit hit testing", () => {
    const hit = findNearestAtomAtPoint({
      atoms: baseInput.atoms,
      point: { x: 241, y: 222 },
      hitRadius: 16
    });

    expect(hit).toEqual({
      atomId: "atom_002",
      distance: Math.sqrt(5)
    });
  });

  it("finds bond-level hover hits and reports terminal endpoints", () => {
    const hit = findNearestBondHit({
      atoms: [
        { id: "atom_001", x: 160, y: 220 },
        { id: "atom_002", x: 240, y: 220 },
        { id: "atom_003", x: 320, y: 220 }
      ],
      bonds: [
        { id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002" },
        { id: "bond_002", fromAtomId: "atom_002", toAtomId: "atom_003" }
      ],
      point: { x: 202, y: 224 },
      hitRadius: 8
    });

    expect(hit).toMatchObject({
      bondId: "bond_001",
      fromAtomId: "atom_001",
      toAtomId: "atom_002",
      distance: 4,
      terminalAtomIds: ["atom_001"],
      nearestTerminalAtomId: "atom_001"
    });
  });

  it("rejects bond hover hits outside the line tolerance", () => {
    expect(findNearestBondHit({
      atoms: baseInput.atoms,
      bonds: [{ id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002" }],
      point: { x: 200, y: 245 },
      hitRadius: 8
    })).toBeUndefined();
  });

  it("rejects growth from atoms that already have four bonds", () => {
    expect(planBondExtension({
      ...baseInput,
      atoms: [
        { id: "atom_001", x: 160, y: 220 },
        { id: "atom_002", x: 240, y: 220 },
        { id: "atom_003", x: 200, y: 150 },
        { id: "atom_004", x: 200, y: 290 },
        { id: "atom_005", x: 120, y: 220 }
      ],
      bonds: [
        { fromAtomId: "atom_001", toAtomId: "atom_002" },
        { fromAtomId: "atom_001", toAtomId: "atom_003" },
        { fromAtomId: "atom_001", toAtomId: "atom_004" },
        { fromAtomId: "atom_001", toAtomId: "atom_005" }
      ],
      preferredAtomId: "atom_001",
      objectBounds: { x: 112, y: 134, width: 136, height: 172 },
      clickPoint: { x: 100, y: 220 }
    })).toBeUndefined();
  });

  it("rejects distant clicks that are outside the active molecule hit envelope", () => {
    expect(planBondExtension({
      ...baseInput,
      clickPoint: { x: 600, y: 600 }
    })).toBeUndefined();
  });

  it("clamps planned atoms to page bounds", () => {
    const plan = planBondExtension({
      ...baseInput,
      atoms: [
        { id: "atom_001", x: 736, y: 220 },
        { id: "atom_002", x: 808, y: 220 }
      ],
      objectBounds: { x: 728, y: 204, width: 88, height: 32 },
      clickPoint: { x: 815, y: 220 }
    });

    expect(plan?.newAtomPoint.x).toBe(816);
    expect(plan?.newAtomPoint.y).toBeCloseTo(289.282, 3);
  });

  it("plans free-angle growth at the default bond length before custom-length breakaway", () => {
    const plan = planFreeformBondExtension({
      atoms: baseInput.atoms,
      bonds: baseInput.bonds,
      sourceAtomId: "atom_002",
      endPoint: { x: 311, y: 247 },
      bondLength: 80,
      pageBounds: baseInput.pageBounds,
      maxBondsPerAtom: 4
    });

    expect(plan?.sourceAtomId).toBe("atom_002");
    expect(plan?.lengthMode).toBe("default");
    expect(Math.hypot((plan?.newAtomPoint.x ?? 0) - 240, (plan?.newAtomPoint.y ?? 0) - 220)).toBeCloseTo(80, 3);
    expect(plan?.newAtomPoint.x).toBeCloseTo(314.776, 3);
    expect(plan?.newAtomPoint.y).toBeCloseTo(248.436, 3);
    expect(plan?.direction.x).toBeCloseTo(0.935, 3);
    expect(plan?.direction.y).toBeCloseTo(0.355, 3);
  });

  it("breaks freeform growth into custom length only after a larger drag", () => {
    const plan = planFreeformBondExtension({
      atoms: baseInput.atoms,
      bonds: baseInput.bonds,
      sourceAtomId: "atom_002",
      endPoint: { x: 380, y: 280 },
      bondLength: 80,
      pageBounds: baseInput.pageBounds,
      customLengthBreakawayDistance: 112
    });

    expect(plan?.lengthMode).toBe("custom");
    expect(plan?.newAtomPoint).toEqual({ x: 380, y: 280 });
  });

  it("keeps freeform growth custom after breakaway so the bond can become shorter", () => {
    const plan = planFreeformBondExtension({
      atoms: baseInput.atoms,
      bonds: baseInput.bonds,
      sourceAtomId: "atom_002",
      endPoint: { x: 266, y: 222 },
      bondLength: 80,
      pageBounds: baseInput.pageBounds,
      customLengthBreakawayDistance: 112,
      forceCustomLength: true
    });

    expect(plan?.lengthMode).toBe("custom");
    expect(plan?.newAtomPoint).toEqual({ x: 266, y: 222 });
    expect(Math.hypot((plan?.newAtomPoint.x ?? 0) - 240, (plan?.newAtomPoint.y ?? 0) - 220)).toBeLessThan(80);
  });

  it("snaps custom freeform growth to an existing eligible atom", () => {
    const plan = planFreeformBondExtension({
      atoms: [
        ...baseInput.atoms,
        { id: "atom_003", x: 320, y: 272 }
      ],
      bonds: baseInput.bonds,
      sourceAtomId: "atom_002",
      endPoint: { x: 322, y: 271 },
      bondLength: 80,
      pageBounds: baseInput.pageBounds,
      maxBondsPerAtom: 4,
      forceCustomLength: true,
      snapHitRadius: 18
    });

    expect(plan).toMatchObject({
      sourceAtomId: "atom_002",
      targetAtomId: "atom_003",
      lengthMode: "custom",
      newAtomPoint: { x: 320, y: 272 }
    });
  });

  it("rejects freeform growth when the source atom is saturated or the drag is too short", () => {
    expect(planFreeformBondExtension({
      atoms: [
        { id: "atom_001", x: 160, y: 220 },
        { id: "atom_002", x: 240, y: 220 },
        { id: "atom_003", x: 160, y: 140 },
        { id: "atom_004", x: 160, y: 300 },
        { id: "atom_005", x: 80, y: 220 }
      ],
      bonds: [
        { fromAtomId: "atom_001", toAtomId: "atom_002" },
        { fromAtomId: "atom_001", toAtomId: "atom_003" },
        { fromAtomId: "atom_001", toAtomId: "atom_004" },
        { fromAtomId: "atom_001", toAtomId: "atom_005" }
      ],
      sourceAtomId: "atom_001",
      endPoint: { x: 210, y: 210 },
      bondLength: 80,
      pageBounds: baseInput.pageBounds,
      maxBondsPerAtom: 4
    })).toBeUndefined();

    expect(planFreeformBondExtension({
      atoms: baseInput.atoms,
      bonds: baseInput.bonds,
      sourceAtomId: "atom_002",
      endPoint: { x: 244, y: 222 },
      bondLength: 80,
      pageBounds: baseInput.pageBounds,
      minimumBondLength: 12
    })).toBeUndefined();
  });
});

const timestamp = "2026-06-06T00:00:00.000Z";

function pageWithObjects(objects: DocumentObject[]): DocumentPage {
  const page = createEmptyDocument({ now: timestamp }).pages[0];
  return {
    ...page,
    objects
  };
}

function moleculeObject(overrides: Partial<MoleculeObject> = {}): MoleculeObject {
  return {
    id: "mol_001",
    type: "molecule",
    x: 120,
    y: 120,
    width: 120,
    height: 120,
    rotation: 0,
    style: {
      ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
      source: "chemdraft-native-drawing"
    },
    structureFormat: "smiles",
    structure: "CC",
    atoms: [
      { id: "atom_001", element: "C", x: 140, y: 180, formalCharge: 0 },
      { id: "atom_002", element: "C", x: 220, y: 180, formalCharge: 0 }
    ],
    bonds: [
      { id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" }
    ],
    chemistry: {
      formula: "C2H6",
      atomCount: 2,
      bondCount: 1,
      totalCharge: 0,
      radicalCount: 0,
      isotopeLabels: [],
      stereochemistry: [],
      warnings: []
    },
    superatoms: [],
    rGroups: [],
    ...overrides
  };
}

function benzeneMolecule(overrides: Partial<MoleculeObject> = {}): MoleculeObject {
  return moleculeObject({
    id: "mol_benzene",
    structure: "c1ccccc1",
    x: 120,
    y: 120,
    width: 180,
    height: 120,
    atoms: [
      { id: "atom_001", element: "C", x: 140, y: 180, formalCharge: 0 },
      { id: "atom_002", element: "C", x: 180, y: 140, formalCharge: 0 },
      { id: "atom_003", element: "C", x: 240, y: 140, formalCharge: 0 },
      { id: "atom_004", element: "C", x: 280, y: 180, formalCharge: 0 },
      { id: "atom_005", element: "C", x: 240, y: 220, formalCharge: 0 },
      { id: "atom_006", element: "C", x: 180, y: 220, formalCharge: 0 }
    ],
    bonds: [
      { id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" },
      { id: "bond_002", fromAtomId: "atom_002", toAtomId: "atom_003", order: "double" },
      { id: "bond_003", fromAtomId: "atom_003", toAtomId: "atom_004", order: "single" },
      { id: "bond_004", fromAtomId: "atom_004", toAtomId: "atom_005", order: "double" },
      { id: "bond_005", fromAtomId: "atom_005", toAtomId: "atom_006", order: "single" },
      { id: "bond_006", fromAtomId: "atom_006", toAtomId: "atom_001", order: "double" }
    ],
    ...overrides
  });
}

function fusedAceneMolecule(ringCount: 2 | 3, overrides: Partial<MoleculeObject> = {}): MoleculeObject {
  const atoms = [
    { id: "atom_001", element: "C", x: 100, y: 180, formalCharge: 0 },
    { id: "atom_002", element: "C", x: 140, y: 110, formalCharge: 0 },
    { id: "atom_003", element: "C", x: 220, y: 110, formalCharge: 0 },
    { id: "atom_004", element: "C", x: 260, y: 180, formalCharge: 0 },
    { id: "atom_005", element: "C", x: 220, y: 250, formalCharge: 0 },
    { id: "atom_006", element: "C", x: 140, y: 250, formalCharge: 0 },
    { id: "atom_007", element: "C", x: 300, y: 80, formalCharge: 0 },
    { id: "atom_008", element: "C", x: 360, y: 140, formalCharge: 0 },
    { id: "atom_009", element: "C", x: 360, y: 220, formalCharge: 0 },
    { id: "atom_010", element: "C", x: 300, y: 280, formalCharge: 0 },
    ...(ringCount === 3 ? [
      { id: "atom_011", element: "C", x: 420, y: 80, formalCharge: 0 },
      { id: "atom_012", element: "C", x: 480, y: 140, formalCharge: 0 },
      { id: "atom_013", element: "C", x: 480, y: 220, formalCharge: 0 },
      { id: "atom_014", element: "C", x: 420, y: 280, formalCharge: 0 }
    ] : [])
  ];
  const bonds: MoleculeObject["bonds"] = [
    { id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" },
    { id: "bond_002", fromAtomId: "atom_002", toAtomId: "atom_003", order: "single" },
    { id: "bond_003", fromAtomId: "atom_003", toAtomId: "atom_004", order: "single" },
    { id: "bond_004", fromAtomId: "atom_004", toAtomId: "atom_005", order: "single" },
    { id: "bond_005", fromAtomId: "atom_005", toAtomId: "atom_006", order: "single" },
    { id: "bond_006", fromAtomId: "atom_006", toAtomId: "atom_001", order: "single" },
    { id: "bond_007", fromAtomId: "atom_003", toAtomId: "atom_007", order: "single" },
    { id: "bond_008", fromAtomId: "atom_007", toAtomId: "atom_008", order: "single" },
    { id: "bond_009", fromAtomId: "atom_008", toAtomId: "atom_009", order: "single" },
    { id: "bond_010", fromAtomId: "atom_009", toAtomId: "atom_010", order: "single" },
    { id: "bond_011", fromAtomId: "atom_010", toAtomId: "atom_004", order: "single" },
    ...(ringCount === 3 ? [
      { id: "bond_012", fromAtomId: "atom_008", toAtomId: "atom_011", order: "single" as const },
      { id: "bond_013", fromAtomId: "atom_011", toAtomId: "atom_012", order: "single" as const },
      { id: "bond_014", fromAtomId: "atom_012", toAtomId: "atom_013", order: "single" as const },
      { id: "bond_015", fromAtomId: "atom_013", toAtomId: "atom_014", order: "single" as const },
      { id: "bond_016", fromAtomId: "atom_014", toAtomId: "atom_009", order: "single" as const }
    ] : [])
  ];

  return moleculeObject({
    id: ringCount === 3 ? "mol_anthracene" : "mol_naphthalene",
    structure: ringCount === 3 ? "anthracene-fixture" : "naphthalene-fixture",
    x: 80,
    y: 60,
    width: ringCount === 3 ? 420 : 300,
    height: 240,
    atoms,
    bonds,
    ...overrides
  });
}

function elementFragments(fragment: PageSvgFragment): PageSvgElementFragment[] {
  if (fragment.kind === "text") {
    return [];
  }

  return [fragment, ...fragment.children.flatMap(elementFragments)];
}

function topLevelObjectRuns(fragments: readonly PageSvgElementFragment[]): string[] {
  return fragments.reduce<string[]>((runs, fragment) => {
    const objectId = String(fragment.attrs["data-object-id"] ?? "");
    if (objectId && runs[runs.length - 1] !== objectId) {
      runs.push(objectId);
    }
    return runs;
  }, []);
}

function visiblePrimitiveSignature(
  fragments: readonly PageSvgFragment[],
  inheritedAttrs: Record<string, unknown> = {}
): string[] {
  return fragments.flatMap((fragment) => {
    if (fragment.kind === "text") {
      return [];
    }

    const attrs = { ...inheritedAttrs, ...fragment.attrs };
    const className = String(attrs.class ?? "");
    const current = fragment.tag !== "g" &&
      className !== "native-bond-hit-target" &&
      className !== "native-bond-hover-decorator" &&
      className !== "native-atom-hit-target" &&
      className !== "native-crossing-hit-target"
      ? [[
          fragment.tag,
          attrs["data-object-id"],
          attrs["data-object-type"],
          attrs["data-bond-id"],
          attrs["data-bond-layer-id"],
          attrs.class,
          attrs.x1,
          attrs.y1,
          attrs.x2,
          attrs.y2,
          attrs.x,
          attrs.y,
          attrs["text-anchor"]
        ].filter((value) => value !== undefined && value !== "").join("|")]
      : [];

    return [
      ...current,
      ...visiblePrimitiveSignature(fragment.children, attrs)
    ];
  });
}

describe("layout-engine page SVG planner", () => {
  it("reports stable native molecule ring keys for benzene, naphthalene, and anthracene", () => {
    const benzeneRings = nativeMoleculeRings(benzeneMolecule());
    expect(benzeneRings).toHaveLength(1);
    expect(benzeneRings[0]).toMatchObject({
      ringKey: "bond_001|bond_002|bond_003|bond_004|bond_005|bond_006",
      bondIds: ["bond_001", "bond_002", "bond_003", "bond_004", "bond_005", "bond_006"]
    });
    expect(benzeneRings[0]?.area).toBeGreaterThan(0);
    expect(benzeneRings[0]?.center).toMatchObject({ x: 210, y: 180 });

    const naphthaleneRings = nativeMoleculeRings(fusedAceneMolecule(2));
    expect(naphthaleneRings).toHaveLength(2);
    expect(new Set(naphthaleneRings.map((ring) => ring.ringKey)).size).toBe(2);

    const anthraceneRings = nativeMoleculeRings(fusedAceneMolecule(3));
    expect(anthraceneRings).toHaveLength(3);
    expect(new Set(anthraceneRings.map((ring) => ring.ringKey)).size).toBe(3);
  });

  it("resolves the ring whose interior contains a point", () => {
    const molecule = benzeneMolecule();
    const ring = nativeMoleculeRings(molecule)[0]!;
    expect(nativeMoleculeRingAtPoint(molecule, ring.center)?.ringKey).toBe(ring.ringKey);
  });

  it("returns no ring when the point is outside every interior", () => {
    expect(nativeMoleculeRingAtPoint(benzeneMolecule(), { x: -1000, y: -1000 })).toBeUndefined();
  });

  it("picks the containing ring per interior in a fused system", () => {
    const molecule = fusedAceneMolecule(3);
    nativeMoleculeRings(molecule).forEach((ring) => {
      expect(nativeMoleculeRingAtPoint(molecule, ring.center)?.ringKey).toBe(ring.ringKey);
    });
  });

  it("keeps native molecule ring keys stable after moving, rotating, and scaling the object", () => {
    const molecule = fusedAceneMolecule(3);
    const before = nativeMoleculeRings(molecule).map((ring) => ring.ringKey);
    const transformed = {
      ...molecule,
      x: molecule.x + 34,
      y: molecule.y - 18,
      width: molecule.width * 1.8,
      height: molecule.height * 0.75,
      rotation: 37,
      transform: {
        rotationDegrees: 37,
        scaleX: 1.8,
        scaleY: 0.75,
        tiltXDegrees: 12,
        tiltYDegrees: -8
      }
    } satisfies MoleculeObject;

    expect(nativeMoleculeRings(transformed).map((ring) => ring.ringKey)).toEqual(before);
  });

  it("produces one globally ordered fragment stream for multiple molecules", () => {
    const page = pageWithObjects([
      moleculeObject({ id: "mol_back" }),
      moleculeObject({ id: "mol_front" })
    ]);

    const plan = planPageSvgRender(page);

    expect(topLevelObjectRuns(plan.fragments)).toEqual(["mol_back", "mol_front"]);
    expect(plan.fragments.map((fragment) => fragment.key)).not.toContain("object-mol_back");
    expect(plan.fragments.map((fragment) => fragment.key)).not.toContain("object-mol_front");
    expect(plan.fragments.every((fragment) => fragment.attrs["data-object-id"] !== undefined)).toBe(true);
    expect(plan.fragments.filter((fragment) => fragment.attrs["data-bond-layer-id"] === "bond_001")).toHaveLength(2);
  });

  it("keeps later bonds over earlier crossing bonds inside one molecule", () => {
    const crossingMolecule = moleculeObject({
      id: "mol_crossing",
      structure: "CC.CC",
      atoms: [
        { id: "atom_back_001", element: "C", x: 140, y: 180, formalCharge: 0 },
        { id: "atom_back_002", element: "C", x: 220, y: 180, formalCharge: 0 },
        { id: "atom_front_001", element: "C", x: 180, y: 140, formalCharge: 0 },
        { id: "atom_front_002", element: "C", x: 180, y: 220, formalCharge: 0 }
      ],
      bonds: [
        { id: "bond_back", fromAtomId: "atom_back_001", toAtomId: "atom_back_002", order: "single" },
        { id: "bond_front", fromAtomId: "atom_front_001", toAtomId: "atom_front_002", order: "single" }
      ]
    });

    const plan = planPageSvgRender(pageWithObjects([crossingMolecule]));
    const elements = plan.fragments.flatMap(elementFragments);
    const bondLayers = plan.fragments
      .filter((child) => child.attrs["data-bond-layer-id"]);
    const backLines = elements.filter((fragment) =>
      String(fragment.attrs.class).includes("native-bond-line") && fragment.attrs["data-bond-id"] === "bond_back"
    );
    const frontLines = elements.filter((fragment) =>
      String(fragment.attrs.class).includes("native-bond-line") && fragment.attrs["data-bond-id"] === "bond_front"
    );

    expect(bondLayers.map((child) => child.attrs["data-bond-layer-id"])).toEqual(["bond_back", "bond_front"]);
    expect(plan.crossings).toHaveLength(1);
    expect(plan.crossings[0].front).toEqual({ objectId: "mol_crossing", bondId: "bond_front" });
    expect(backLines).toHaveLength(2);
    expect(frontLines).toHaveLength(1);
    expect(elements.some((fragment) => fragment.attrs.class === "native-bond-knockout")).toBe(false);
  });

  it("does not plan a false whole-junction gap for bonds sharing one atom", () => {
    const geminalMolecule = moleculeObject({
      id: "mol_geminal",
      structure: "CC(C)C",
      atoms: [
        { id: "atom_center", element: "C", x: 180, y: 180, formalCharge: 0 },
        { id: "atom_left", element: "C", x: 140, y: 180, formalCharge: 0 },
        { id: "atom_up", element: "C", x: 200, y: 140, formalCharge: 0 },
        { id: "atom_right", element: "C", x: 220, y: 165, formalCharge: 0 }
      ],
      bonds: [
        { id: "bond_left", fromAtomId: "atom_left", toAtomId: "atom_center", order: "single" },
        { id: "bond_up", fromAtomId: "atom_center", toAtomId: "atom_up", order: "single" },
        { id: "bond_right", fromAtomId: "atom_center", toAtomId: "atom_right", order: "single" }
      ]
    });

    const plan = planPageSvgRender(pageWithObjects([geminalMolecule]));
    const elements = plan.fragments.flatMap(elementFragments);
    const upLine = elements.find((fragment) =>
      String(fragment.attrs.class).includes("native-bond-line") && fragment.attrs["data-bond-id"] === "bond_up"
    );
    const upKnockout = elements.find((fragment) =>
      fragment.attrs.class === "native-bond-knockout" && fragment.attrs["data-bond-id"] === "bond_up"
    );

    expect(plan.crossings).toHaveLength(0);
    expect(upLine).toMatchObject({ attrs: { x1: 180, y1: 180 } });
    expect(upKnockout).toBeUndefined();
  });

  it("resolves cross-object crossings with the later object as the default front bond", () => {
    const back = moleculeObject({
      id: "mol_back",
      atoms: [
        { id: "atom_001", element: "C", x: 140, y: 180, formalCharge: 0 },
        { id: "atom_002", element: "C", x: 220, y: 180, formalCharge: 0 }
      ],
      bonds: [{ id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" }]
    });
    const front = moleculeObject({
      id: "mol_front",
      atoms: [
        { id: "atom_001", element: "C", x: 180, y: 140, formalCharge: 0 },
        { id: "atom_002", element: "C", x: 180, y: 220, formalCharge: 0 }
      ],
      bonds: [{ id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" }]
    });

    const plan = planPageSvgRender(pageWithObjects([back, front]));
    const elements = plan.fragments.flatMap(elementFragments);
    const backFragment = plan.fragments.find((fragment) =>
      fragment.attrs["data-object-id"] === "mol_back" && fragment.attrs["data-bond-layer-id"] === "bond_001"
    );
    const backLines = backFragment ? elementFragments(backFragment).filter((fragment) =>
      String(fragment.attrs.class).includes("native-bond-line") && fragment.attrs["data-bond-id"] === "bond_001"
    ) : [];
    const crossingHit = elements.find((fragment) => fragment.attrs.class === "native-crossing-hit-target");
    const backHoverDecorators = backFragment ? elementFragments(backFragment).filter((fragment) =>
      fragment.attrs.class === "native-bond-hover-decorator" && fragment.attrs["data-bond-id"] === "bond_001"
    ) : [];

    expect(plan.crossings).toHaveLength(1);
    expect(plan.crossings[0]).toMatchObject({
      front: { objectId: "mol_front", bondId: "bond_001" },
      back: { objectId: "mol_back", bondId: "bond_001" },
      point: { x: 180, y: 180 }
    });
    expect(backLines).toHaveLength(2);
    expect(crossingHit).toMatchObject({
      attrs: {
        "data-hit-target": "crossing",
        "data-crossing-key": "mol_back::bond_001|mol_front::bond_001",
        cx: 180,
        cy: 180
      }
    });
    expect(backHoverDecorators).toHaveLength(2);
  });

  it("uses explicit crossing overrides to flip the local gap", () => {
    const back = moleculeObject({
      id: "mol_back",
      atoms: [
        { id: "atom_001", element: "C", x: 140, y: 180, formalCharge: 0 },
        { id: "atom_002", element: "C", x: 220, y: 180, formalCharge: 0 }
      ],
      bonds: [{ id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" }]
    });
    const front = moleculeObject({
      id: "mol_front",
      atoms: [
        { id: "atom_001", element: "C", x: 180, y: 140, formalCharge: 0 },
        { id: "atom_002", element: "C", x: 180, y: 220, formalCharge: 0 }
      ],
      bonds: [{ id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" }]
    });
    const crossings: DocumentPage["crossings"] = [{
      bonds: [
        { objectId: "mol_back", bondId: "bond_001" },
        { objectId: "mol_front", bondId: "bond_001" }
      ],
      front: { objectId: "mol_back", bondId: "bond_001" }
    }];
    const page = {
      ...pageWithObjects([back, front]),
      crossings
    };

    const plan = planPageSvgRender(page);
    const frontFragment = plan.fragments.find((fragment) =>
      fragment.attrs["data-object-id"] === "mol_front" && fragment.attrs["data-bond-layer-id"] === "bond_001"
    );
    const frontMoleculeLines = frontFragment ? elementFragments(frontFragment).filter((fragment) =>
      String(fragment.attrs.class).includes("native-bond-line") && fragment.attrs["data-bond-id"] === "bond_001"
    ) : [];

    expect(plan.crossings[0]).toMatchObject({
      front: { objectId: "mol_back", bondId: "bond_001" },
      back: { objectId: "mol_front", bondId: "bond_001" },
      hasOverride: true
    });
    expect(frontMoleculeLines).toHaveLength(2);
  });

  it("ignores endpoint touches instead of creating spurious crossing gaps", () => {
    const horizontal = moleculeObject({
      id: "mol_horizontal",
      atoms: [
        { id: "atom_001", element: "C", x: 140, y: 180, formalCharge: 0 },
        { id: "atom_002", element: "C", x: 180, y: 180, formalCharge: 0 }
      ]
    });
    const vertical = moleculeObject({
      id: "mol_vertical",
      atoms: [
        { id: "atom_001", element: "C", x: 180, y: 180, formalCharge: 0 },
        { id: "atom_002", element: "C", x: 180, y: 220, formalCharge: 0 }
      ]
    });

    expect(planPageSvgRender(pageWithObjects([horizontal, vertical])).crossings).toHaveLength(0);
  });

  it("preserves mixed object order across text, charge marks, arrows, and graphics", () => {
    const page = pageWithObjects([
      {
        id: "text_001",
        type: "text",
        x: 10,
        y: 20,
        width: 100,
        height: 40,
        rotation: 0,
        style: {},
        text: "hello",
        spans: []
      },
      {
        id: "charge_001",
        type: "electron-mark",
        x: 130,
        y: 20,
        width: 24,
        height: 24,
        rotation: 0,
        style: {},
        markKind: "charge",
        anchor: { kind: "point", point: { x: 142, y: 32 } },
        charge: -1
      },
      {
        id: "arrow_001",
        type: "reaction-arrow",
        x: 170,
        y: 20,
        width: 80,
        height: 24,
        rotation: 0,
        style: {},
        arrowKind: "forward",
        start: { kind: "point", point: { x: 170, y: 32 } },
        end: { kind: "point", point: { x: 250, y: 32 } },
        labels: []
      },
      {
        id: "graphic_001",
        type: "graphic",
        x: 270,
        y: 20,
        width: 60,
        height: 30,
        rotation: 0,
        style: {},
        graphicKind: "rect",
        data: {}
      }
    ]);

    const plan = planPageSvgRender(page);

    expect(topLevelObjectRuns(plan.fragments)).toEqual([
      "text_001",
      "charge_001",
      "arrow_001",
      "graphic_001"
    ]);
    expect(plan.fragments.filter((fragment) => fragment.attrs["data-object-id"] === "arrow_001")).toHaveLength(2);
    const arrowFragments = plan.fragments.filter((fragment) => fragment.attrs["data-object-id"] === "arrow_001");
    expect(arrowFragments.map((fragment) => fragment.tag)).toEqual(["line", "polygon"]);
    expect(arrowFragments.flatMap((fragment) => fragment.children)).toEqual([]);
  });

  it("skips group metadata while exporting grouped children", () => {
    const page = pageWithObjects([
      {
        id: "text_group_child",
        type: "text",
        x: 10,
        y: 20,
        width: 100,
        height: 40,
        rotation: 0,
        style: {},
        text: "grouped",
        spans: []
      },
      {
        id: "group_001",
        type: "group",
        x: 10,
        y: 20,
        width: 100,
        height: 40,
        rotation: 0,
        style: {},
        childObjectIds: ["text_group_child"]
      }
    ]);

    const plan = planPageSvgRender(page);

    expect(plan.fragments.some((fragment) => fragment.attrs["data-object-id"] === "group_001")).toBe(false);
    expect(plan.fragments.some((fragment) => fragment.attrs["data-object-id"] === "text_group_child")).toBe(true);
    expect(plan.warnings.some((warning) => warning.objectId === "group_001")).toBe(false);
  });

  it("keeps the visible primitive stream stable while flattening object wrappers", () => {
    const page = pageWithObjects([
      moleculeObject({
        id: "mol_snapshot",
        structure: "CC",
        atoms: [
          { id: "atom_001", element: "C", x: 120, y: 160, formalCharge: 0 },
          { id: "atom_002", element: "O", x: 164, y: 160, formalCharge: -1 }
        ],
        bonds: [{ id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "double", display: { doubleBondSide: "left" } }]
      }),
      {
        id: "text_snapshot",
        type: "text",
        x: 220,
        y: 160,
        width: 80,
        height: 32,
        rotation: 0,
        style: {},
        text: "N+",
        spans: []
      },
      {
        id: "charge_snapshot",
        type: "electron-mark",
        x: 320,
        y: 160,
        width: 18,
        height: 18,
        rotation: 0,
        style: {},
        markKind: "charge",
        anchor: { kind: "point", point: { x: 329, y: 169 } },
        charge: 1
      }
    ]);

    expect(visiblePrimitiveSignature(planPageSvgRender(page).fragments)).toMatchInlineSnapshot(`
      [
        "line|mol_snapshot|molecule|bond_001|bond_001|native-bond-line native-bond-double|120|162.4|157|162.4",
        "line|mol_snapshot|molecule|bond_001|bond_001|native-bond-line native-bond-double|120|157.6|157|157.6",
        "text|mol_snapshot|molecule|native-atom-label-run|0|0|middle",
        "text|mol_snapshot|molecule|native-atom-label-run|5.8500000000000005|-7.199999999999999|start",
        "text|text_snapshot|text|220|178|start",
        "tspan|text_snapshot|text|220|178|start",
        "text|charge_snapshot|electron-mark|329|169|middle",
      ]
    `);
  });

  it("plans atom-label visibility, implicit hydrogens, colors, and transparent backgrounds", () => {
    const molecule = moleculeObject({
      id: "mol_atom_labels",
      structure: "CC[H]",
      atoms: [
        { id: "atom_001", element: "C", x: 120, y: 160, formalCharge: 0 },
        { id: "atom_002", element: "C", x: 180, y: 160, formalCharge: 0 },
        { id: "atom_003", element: "C", x: 240, y: 160, formalCharge: 0 },
        { id: "atom_004", element: "H", x: 300, y: 160, formalCharge: 0 }
      ],
      bonds: [
        { id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" },
        { id: "bond_002", fromAtomId: "atom_002", toAtomId: "atom_003", order: "single" },
        { id: "bond_003", fromAtomId: "atom_003", toAtomId: "atom_004", order: "single" }
      ],
      style: {
        atomLabelShowTerminalCarbons: true,
        atomLabelHideImplicitHydrogens: false,
        atomLabelColor: "#111111",
        atomLabelColors: { atom_003: "#c75c12" },
        atomLabelBackgroundColor: "transparent",
        atomLabelFontStyle: "italic",
        atomLabelPlacement: "above",
        atomLabelAlignment: "left"
      }
    });

    const labels = new Map(planMoleculeAtomLabels(molecule).map((plan) => [plan.atom.id, plan]));

    expect(labels.get("atom_001")?.label).toBe("CH3");
    expect(labels.get("atom_002")).toBeUndefined();
    expect(labels.get("atom_003")?.label).toBe("CH2");
    expect(labels.get("atom_003")?.color).toBe("#c75c12");
    expect(labels.get("atom_003")?.backgroundVisible).toBe(false);
    expect(labels.get("atom_003")?.anchorOffset.y).toBeLessThan(0);
    expect(labels.get("atom_004")?.label).toBe("H");

    const fragments = planPageSvgRender(pageWithObjects([molecule])).fragments.flatMap(elementFragments);
    expect(fragments.some((fragment) => fragment.attrs.class === "native-atom-label-background")).toBe(false);
    expect(fragments.find((fragment) => fragment.attrs["data-atom-label"] === "CH2")?.attrs).toMatchObject({
      fill: "#c75c12",
      "font-style": "italic"
    });
  });

  it("resolves sparse atom-label style overrides per atom", () => {
    const molecule = moleculeObject({
      id: "mol_sparse_atom_labels",
      atoms: [
        { id: "atom_oh", element: "O", x: 120, y: 160, formalCharge: 0 },
        { id: "atom_nh", element: "N", x: 180, y: 160, formalCharge: 0 }
      ],
      bonds: [
        { id: "bond_001", fromAtomId: "atom_oh", toAtomId: "atom_nh", order: "single" }
      ],
      style: {
        atomLabelFontSizePx: 12,
        atomLabelFontWeight: 400,
        atomLabelFontStyle: "normal",
        atomLabelColor: "#111111",
        atomLabelBackgroundColor: "transparent",
        atomLabelPaddingPx: 1,
        atomLabelBondClearancePx: 2,
        atomLabelHideImplicitHydrogens: true,
        atomLabelFontSizes: { atom_oh: 20 },
        atomLabelFontWeights: { atom_oh: 700 },
        atomLabelFontStyles: { atom_oh: "italic" },
        atomLabelColors: { atom_oh: "#1f5fbf" },
        atomLabelBackgroundColors: { atom_oh: "#fff0c2" },
        atomLabelPaddings: { atom_oh: 6 },
        atomLabelBondClearances: { atom_oh: 9 },
        atomLabelPlacements: { atom_oh: "above" },
        atomLabelAlignments: { atom_oh: "left" }
      }
    });

    const labels = new Map(planMoleculeAtomLabels(molecule).map((plan) => [plan.atom.id, plan]));
    const oxygenLabel = labels.get("atom_oh");
    const nitrogenLabel = labels.get("atom_nh");

    expect(oxygenLabel).toMatchObject({
      label: "O",
      color: "#1f5fbf",
      backgroundColor: "#fff0c2",
      backgroundVisible: true,
      fontSizePx: 20,
      fontWeight: 700,
      fontStyle: "italic"
    });
    expect(oxygenLabel?.anchorOffset.y).toBeLessThan(0);
    expect(nitrogenLabel).toMatchObject({
      label: "N",
      color: "#111111",
      backgroundColor: "transparent",
      backgroundVisible: false,
      fontSizePx: 12,
      fontWeight: 400,
      fontStyle: "normal"
    });

    const fragments = planPageSvgRender(pageWithObjects([molecule])).fragments.flatMap(elementFragments);
    const labelGroups = fragments.filter((fragment) => fragment.attrs.class === "native-atom-label");
    expect(labelGroups.find((fragment) => fragment.attrs["data-atom-label"] === "O")?.attrs).toMatchObject({
      fill: "#1f5fbf",
      "font-size": 20,
      "font-weight": 700,
      "font-style": "italic"
    });
    expect(labelGroups.find((fragment) => fragment.attrs["data-atom-label"] === "N")?.attrs).toMatchObject({
      fill: "#111111",
      "font-size": 12,
      "font-weight": 400,
      "font-style": "normal"
    });
    // Per-atom backgrounds render as the label's glyph-hugging halo stroke, not an opaque rect:
    // the O override colors its halo (width tracks its 20px font), and N's "transparent"
    // background opts out of the knockout entirely.
    const oxygenAttrs = labelGroups.find((fragment) => fragment.attrs["data-atom-label"] === "O")?.attrs;
    expect(oxygenAttrs).toMatchObject({ stroke: "#fff0c2", "paint-order": "stroke" });
    expect(Number(oxygenAttrs?.["stroke-width"])).toBeCloseTo(20 * 0.3, 5);
    expect(labelGroups.find((fragment) => fragment.attrs["data-atom-label"] === "N")?.attrs.stroke).toBeUndefined();
    expect(fragments.filter((fragment) => fragment.attrs.class === "native-atom-label-background")).toHaveLength(0);
  });

  it("keeps explicit atom label offsets and chemically required labels ahead of molecule defaults", () => {
    const molecule = moleculeObject({
      atoms: [
        { id: "atom_001", element: "C", x: 120, y: 160, formalCharge: 0, labelOffset: { x: 8, y: -6 } },
        { id: "atom_002", element: "C", x: 180, y: 160, formalCharge: 1 },
        { id: "atom_003", element: "O", x: 240, y: 160, formalCharge: 0 },
        { id: "atom_004", element: "H", x: 300, y: 160, formalCharge: 0 }
      ],
      bonds: [
        { id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" },
        { id: "bond_002", fromAtomId: "atom_002", toAtomId: "atom_003", order: "single" },
        { id: "bond_003", fromAtomId: "atom_003", toAtomId: "atom_004", order: "single" }
      ],
      style: {
        atomLabelShowTerminalCarbons: false,
        atomLabelHideImplicitHydrogens: true,
        atomLabelPlacement: "below"
      }
    });
    const drawingStyle = nativeDrawingStyleFromObjectStyle(molecule.style);

    expect(atomDisplayLabel(molecule.atoms[0]!, molecule.bonds, drawingStyle, molecule.atoms)).toBeUndefined();
    expect(atomDisplayLabel(molecule.atoms[1]!, molecule.bonds, drawingStyle, molecule.atoms)).toBe("C+");
    expect(atomDisplayLabel(molecule.atoms[2]!, molecule.bonds, drawingStyle, molecule.atoms)).toBe("O");
    expect(atomDisplayLabel(molecule.atoms[3]!, molecule.bonds, drawingStyle, molecule.atoms)).toBe("H");
    expect(atomLabelAnchorOffset(molecule.atoms[0]!, "C", drawingStyle)).toEqual({ x: 8, y: -6 });
  });

  it("resolves native drawing styles per object", () => {
    const page = pageWithObjects([
      moleculeObject({
        id: "mol_red",
        style: {
          ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
          bondColors: { bond_001: "#ff0000" }
        }
      }),
      moleculeObject({
        id: "mol_blue",
        style: {
          ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
          bondColors: { bond_001: "#0000ff" }
        }
      })
    ]);

    const lineStrokes = planPageSvgRender(page).fragments
      .flatMap(elementFragments)
      .filter((fragment) => String(fragment.attrs.class).includes("native-bond-line"))
      .map((fragment) => fragment.attrs.stroke);

    expect(lineStrokes).toEqual(["#ff0000", "#0000ff"]);
  });

  it("resolves native bond drawing styles per selected bond override", () => {
    const page = pageWithObjects([
      moleculeObject({
        id: "mol_sparse_bonds",
        style: {
          ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
          bondColor: "#111111",
          bondStrokeWidthPx: 2,
          bondLineCap: "butt",
          bondColors: { bond_001: "#1f5fbf" },
          bondStrokeWidths: { bond_001: 7 },
          bondLineCaps: { bond_001: "round" }
        }
      })
    ]);

    const bondLines = planPageSvgRender(page).fragments
      .flatMap(elementFragments)
      .filter((fragment) => String(fragment.attrs.class).includes("native-bond-line"));
    const selectedBondLines = bondLines.filter((fragment) => fragment.attrs["data-bond-id"] === "bond_001");

    expect(selectedBondLines.length).toBeGreaterThan(0);
    expect(selectedBondLines.every((fragment) => fragment.attrs.stroke === "#1f5fbf")).toBe(true);
    expect(selectedBondLines.every((fragment) => fragment.attrs["stroke-width"] === 7)).toBe(true);
    expect(selectedBondLines.every((fragment) => fragment.attrs["stroke-linecap"] === "round")).toBe(true);
  });

  it("applies percent bond spacing and bold width in native molecule rendering", () => {
    const page = pageWithObjects([
      moleculeObject({
        id: "mol_percent_spacing",
        atoms: [
          { id: "atom_001", element: "C", x: 120, y: 160, formalCharge: 0 },
          { id: "atom_002", element: "O", x: 164, y: 160, formalCharge: 0 }
        ],
        bonds: [
          { id: "bond_double", fromAtomId: "atom_001", toAtomId: "atom_002", order: "double" }
        ],
        style: {
          ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
          bondLengthPx: 44,
          bondSpacingMode: "percent",
          bondSpacingPercent: 50,
          multipleBondGapPx: 3
        }
      }),
      moleculeObject({
        id: "mol_bold_width",
        atoms: [
          { id: "atom_003", element: "C", x: 220, y: 160, formalCharge: 0 },
          { id: "atom_004", element: "C", x: 276, y: 160, formalCharge: 0 }
        ],
        bonds: [
          { id: "bond_bold", fromAtomId: "atom_003", toAtomId: "atom_004", order: "single", display: { bondStyle: "bold" } }
        ],
        style: {
          ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
          bondBoldWidthPx: 7
        }
      })
    ]);

    const fragments = planPageSvgRender(page).fragments.flatMap(elementFragments);
    const doubleLines = fragments.filter((fragment) => fragment.attrs["data-bond-id"] === "bond_double");
    const boldLine = fragments.find((fragment) =>
      fragment.attrs["data-bond-id"] === "bond_bold" &&
      String(fragment.attrs.class).includes("native-bond-line")
    );

    expect(Math.abs(Number(doubleLines[0]?.attrs.y1) - Number(doubleLines[1]?.attrs.y1))).toBeCloseTo(22, 6);
    expect(boldLine?.attrs["stroke-width"]).toBe(7);
  });

  it("uses native hash spacing for hashed wedge density", () => {
    const page = pageWithObjects([
      moleculeObject({
        id: "mol_hash_spacing",
        atoms: [
          { id: "atom_001", element: "C", x: 120, y: 160, formalCharge: 0 },
          { id: "atom_002", element: "C", x: 216, y: 160, formalCharge: 0 }
        ],
        bonds: [
          { id: "bond_hash", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single", display: { bondStyle: "hashed" } }
        ],
        style: {
          ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
          bondHashSpacingPx: 4
        }
      })
    ]);

    const hashes = planPageSvgRender(page).fragments
      .flatMap(elementFragments)
      .filter((fragment) => fragment.attrs.class === "native-bond-hash");

    expect(hashes).toHaveLength(24);
  });

  it("uses bond margin width when trimming bonds away from atom labels", () => {
    const lowMargin = moleculeObject({
      id: "mol_margin_low",
      atoms: [
        { id: "atom_001", element: "C", x: 120, y: 160, formalCharge: 0 },
        { id: "atom_002", element: "O", x: 220, y: 160, formalCharge: 0 }
      ],
      bonds: [
        { id: "bond_margin", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" }
      ],
      style: {
        ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
        atomLabelBondClearancePx: 0,
        bondMarginWidthPx: 0
      }
    });
    const highMargin = {
      ...lowMargin,
      id: "mol_margin_high",
      style: {
        ...lowMargin.style,
        bondMarginWidthPx: 24
      }
    };
    const lowLine = planPageSvgRender(pageWithObjects([lowMargin])).fragments
      .flatMap(elementFragments)
      .find((fragment) =>
        String(fragment.attrs.class).includes("native-bond-line") &&
        fragment.attrs["data-bond-id"] === "bond_margin"
      );
    const highLine = planPageSvgRender(pageWithObjects([highMargin])).fragments
      .flatMap(elementFragments)
      .find((fragment) =>
        String(fragment.attrs.class).includes("native-bond-line") &&
        fragment.attrs["data-bond-id"] === "bond_margin"
      );

    expect(Number(highLine?.attrs.x2)).toBeLessThan(Number(lowLine?.attrs.x2) - 10);
  });

  it("renders molecule structure indicators from native and compatibility metadata", () => {
    const molecule = moleculeObject({
      id: "mol_indicators",
      atoms: [
        { id: "atom_001", element: "C", x: 120, y: 160, formalCharge: 0 },
        { id: "atom_002", element: "C", x: 180, y: 160, formalCharge: 0 },
        { id: "atom_003", element: "O", x: 180, y: 100, formalCharge: 0 },
        { id: "atom_004", element: "C", x: 180, y: 220, formalCharge: 0 }
      ],
      bonds: [
        { id: "bond_stereo", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single", display: { bondStyle: "wedge" } },
        { id: "bond_query", fromAtomId: "atom_002", toAtomId: "atom_003", order: "unknown" },
        { id: "bond_reaction", fromAtomId: "atom_002", toAtomId: "atom_004", order: "single" }
      ],
      style: {
        ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
        atomIndicatorShowQuery: true,
        atomIndicatorShowStereochemistry: true,
        atomIndicatorShowEnhancedStereochemistry: true,
        atomIndicatorShowAtomNumbers: true,
        bondIndicatorShowQuery: true,
        bondIndicatorShowStereochemistry: true,
        bondIndicatorShowReaction: true
      },
      compatibility: {
        sourceFormat: "cdxml",
        warnings: [],
        unknown: {
          atomQueryIds: ["atom_003"],
          enhancedStereoByAtomId: { atom_002: "or1" },
          reactionBondIds: ["bond_reaction"]
        }
      }
    });

    const fragments = planPageSvgRender(pageWithObjects([molecule])).fragments.flatMap(elementFragments);
    const atomIndicators = fragments.filter((fragment) => fragment.attrs["data-atom-indicator"]);
    const bondIndicators = fragments.filter((fragment) => fragment.attrs["data-bond-indicator"]);

    expect(atomIndicators.map((fragment) => fragment.attrs["data-atom-indicator"])).toEqual([
      "number", "number", "number", "number", "query", "stereochemistry", "enhanced-stereochemistry"
    ]);
    expect(atomIndicators.find((fragment) =>
      fragment.attrs["data-atom-indicator"] === "enhanced-stereochemistry"
    )?.children).toEqual([{ kind: "text", key: "atom-indicator-text-mol_indicators-enhanced-stereochemistry-atom_002", text: "OR1" }]);
    expect(bondIndicators.map((fragment) => fragment.attrs["data-bond-indicator"])).toEqual([
      "query", "stereochemistry", "reaction"
    ]);

    const disabled = {
      ...molecule,
      style: {
        ...molecule.style,
        atomIndicatorShowQuery: false,
        atomIndicatorShowStereochemistry: false,
        atomIndicatorShowEnhancedStereochemistry: false,
        atomIndicatorShowAtomNumbers: false,
        bondIndicatorShowQuery: false,
        bondIndicatorShowStereochemistry: false,
        bondIndicatorShowReaction: false
      }
    };
    const disabledFragments = planPageSvgRender(pageWithObjects([disabled])).fragments.flatMap(elementFragments);
    expect(disabledFragments.some((fragment) => fragment.attrs["data-atom-indicator"])).toBe(false);
    expect(disabledFragments.some((fragment) => fragment.attrs["data-bond-indicator"])).toBe(false);
  });

  it("never invents enhanced-stereo (ABS) or reaction (RXN) indicators without metadata", () => {
    // With the show flags ON, a drawn wedge stereocenter and a reaction-looking source format but
    // NO enhanced-stereo / reaction-bond metadata: enhanced stereo and reaction are chemical
    // assertions that come only from imported metadata — a bare wedge is not "ABS", and the
    // source-format string alone must not paint every bond "RXN".
    const molecule = moleculeObject({
      id: "mol_no_invented_indicators",
      atoms: [
        { id: "atom_001", element: "C", x: 120, y: 160, formalCharge: 0 },
        { id: "atom_002", element: "C", x: 180, y: 160, formalCharge: 0 },
        { id: "atom_003", element: "O", x: 180, y: 100, formalCharge: 0 }
      ],
      bonds: [
        { id: "bond_stereo", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single", display: { bondStyle: "wedge" } },
        { id: "bond_002", fromAtomId: "atom_002", toAtomId: "atom_003", order: "single" }
      ],
      style: {
        ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
        atomIndicatorShowEnhancedStereochemistry: true,
        bondIndicatorShowReaction: true
      },
      compatibility: { sourceFormat: "mdl-rxn", warnings: [], unknown: {} }
    });

    const fragments = planPageSvgRender(pageWithObjects([molecule])).fragments.flatMap(elementFragments);
    expect(fragments.some((fragment) => fragment.attrs["data-atom-indicator"] === "enhanced-stereochemistry")).toBe(false);
    expect(fragments.some((fragment) => fragment.attrs["data-bond-indicator"] === "reaction")).toBe(false);
  });

  it("renders explicit line graphics without fallback labels", () => {
    const page = pageWithObjects([
      {
        id: "graphic_line",
        type: "graphic",
        x: 20,
        y: 30,
        width: 80,
        height: 1,
        rotation: 0,
        style: {},
        graphicKind: "line",
        data: {
          lineStart: { x: 20, y: 30 },
          lineEnd: { x: 100, y: 30 }
        }
      }
    ]);

    const fragments = planPageSvgRender(page).fragments.flatMap(elementFragments);
    expect(fragments.map((fragment) => fragment.tag)).toEqual(["line"]);
    expect(fragments[0]?.attrs).toMatchObject({
      "data-object-id": "graphic_line",
      class: "graphic-glyph-stroke",
      x1: 20,
      y1: 30,
      x2: 100,
      y2: 30
    });
  });

  it("renders shared visual effect fragments for native molecule graphs", () => {
    const page = pageWithObjects([
      moleculeObject({
        id: "mol_effects",
        structure: "CO",
        atoms: [
          { id: "atom_001", element: "C", x: 140, y: 180, formalCharge: 0 },
          { id: "atom_002", element: "O", x: 220, y: 180, formalCharge: 0 }
        ],
        style: {
          ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
          source: "chemdraft-native-drawing",
          visualEffects: [
            { kind: "shadow", color: "#52616b", opacity: 0.28, offsetX: 6, offsetY: 6, blurPx: 3 },
            { kind: "glow", color: "#fdd835", opacity: 0.42, blurPx: 7, spreadPx: 1.2 },
            { kind: "sketch", color: "#111111", seed: 713, roughness: 1.25, bowing: 0.8, strokeWidth: 1.5 }
          ]
        }
      })
    ]);

    const fragments = planPageSvgRender(page).fragments.flatMap(elementFragments);
    const effectFilter = fragments.find((fragment) =>
      fragment.tag === "filter" && fragment.attrs.id === "molecule-effects-mol_effects"
    );
    expect(effectFilter?.attrs).toMatchObject({
      filterUnits: "userSpaceOnUse"
    });
    expect(Number(effectFilter?.attrs.x)).toBeLessThan(120);
    expect(Number(effectFilter?.attrs.y)).toBeLessThan(120);
    expect(fragments.some((fragment) =>
      fragment.tag === "feFlood" && fragment.attrs["flood-color"] === "#fdd835"
    )).toBe(true);
    expect(fragments.find((fragment) =>
      fragment.attrs["data-molecule-effect-source"] === "true"
    )?.attrs.filter).toBe("url(#molecule-effects-mol_effects)");
    expect(fragments.some((fragment) => fragment.key.startsWith("molecule-effect-source-label-"))).toBe(false);
    expect(fragments.some((fragment) =>
      fragment.attrs.class === "native-molecule-sketch" &&
      fragment.attrs["data-molecule-effect"] === "sketch"
    )).toBe(true);
    expect(fragments.some((fragment) => String(fragment.attrs.class).includes("native-bond-line"))).toBe(true);
    expect(fragments.some((fragment) => fragment.attrs.class === "native-atom-label")).toBe(true);
  });

  it("renders molecule fill underlays and stroke opacity from art style metadata", () => {
    const page = pageWithObjects([
      moleculeObject({
        id: "mol_fill",
        structure: "C1CCCCC1",
        atoms: [
          { id: "atom_001", element: "C", x: 140, y: 180, formalCharge: 0 },
          { id: "atom_002", element: "C", x: 180, y: 140, formalCharge: 0 },
          { id: "atom_003", element: "C", x: 240, y: 140, formalCharge: 0 },
          { id: "atom_004", element: "C", x: 280, y: 180, formalCharge: 0 },
          { id: "atom_005", element: "C", x: 240, y: 220, formalCharge: 0 },
          { id: "atom_006", element: "C", x: 180, y: 220, formalCharge: 0 }
        ],
        bonds: [
          { id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" },
          { id: "bond_002", fromAtomId: "atom_002", toAtomId: "atom_003", order: "single" },
          { id: "bond_003", fromAtomId: "atom_003", toAtomId: "atom_004", order: "single" },
          { id: "bond_004", fromAtomId: "atom_004", toAtomId: "atom_005", order: "single" },
          { id: "bond_005", fromAtomId: "atom_005", toAtomId: "atom_006", order: "single" },
          { id: "bond_006", fromAtomId: "atom_006", toAtomId: "atom_001", order: "single" }
        ],
        style: {
          ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
          fillPaint: {
            kind: "linear-gradient",
            units: "object",
            x1: 0,
            y1: 0,
            x2: 1,
            y2: 1,
            stops: [
              { offset: 0, color: "#1d7f68" },
              { offset: 1, color: "#ffffff" }
            ]
          },
          fillOpacity: 0.44,
          strokeOpacity: 0.58
        }
      })
    ]);

    const fragments = planPageSvgRender(page).fragments.flatMap(elementFragments);
    const fill = fragments.find((fragment) => fragment.attrs["data-molecule-fill"] === "true");
    const ringKey = "bond_001|bond_002|bond_003|bond_004|bond_005|bond_006";
    expect(fill?.tag).toBe("path");
    expect(fill?.attrs["data-molecule-fill-ring"]).toBe("true");
    expect(fill?.attrs["data-ring-key"]).toBe(ringKey);
    expect(fill?.attrs.fill).toBe(`url(#molecule-fill-mol_fill-${ringKey.replaceAll("|", "_")})`);
    expect(fill?.attrs["fill-opacity"]).toBe(0.44);
    expect(fill?.attrs.d).toBe("M 140 180 L 180 140 L 240 140 L 280 180 L 240 220 L 180 220 Z");
    expect(fragments.some((fragment) =>
      fragment.tag === "linearGradient" && fragment.attrs.id === `molecule-fill-mol_fill-${ringKey.replaceAll("|", "_")}`
    )).toBe(true);
    expect(fragments.find((fragment) =>
      String(fragment.attrs.class).includes("native-bond-line")
    )?.attrs["stroke-opacity"]).toBe(0.58);
  });

  it("fills fused molecule rings as separate ring interiors instead of an expanded outer hull", () => {
    const page = pageWithObjects([
      fusedAceneMolecule(2, {
        id: "mol_fused_fill",
        style: {
          ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
          fillPaint: { kind: "solid", color: "#d02626" }
        }
      })
    ]);

    const fragments = planPageSvgRender(page).fragments.flatMap(elementFragments);
    const fills = fragments.filter((fragment) => fragment.attrs["data-molecule-fill-ring"] === "true");
    const pathD = fills.map((fill) => String(fill.attrs.d ?? ""));
    const pathNumbers = pathD.flatMap((path) => [...path.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0])));

    expect(fills).toHaveLength(2);
    expect(new Set(fills.map((fill) => fill.attrs["data-ring-key"])).size).toBe(2);
    expect(pathD).toContain("M 100 180 L 140 110 L 220 110 L 260 180 L 220 250 L 140 250 Z");
    expect(pathD.some((path) => path.startsWith("M 220 110") && path.includes("L 300 80"))).toBe(true);
    expect(fills.every((fill) => fill.attrs.fill === "#d02626")).toBe(true);
    expect(pathNumbers.every((value) => value >= 80 && value <= 360)).toBe(true);
  });

  it("renders anthracene ring fills as independently styleable paths", () => {
    const base = fusedAceneMolecule(3);
    const ringKeys = nativeMoleculeRings(base).map((ring) => ring.ringKey);
    const page = pageWithObjects([
      {
        ...base,
        id: "mol_ring_styles",
        style: {
          ...base.style,
          fillPaint: { kind: "solid", color: "#f8faf9" },
          ringStyles: {
            [ringKeys[0]!]: { fillColor: "#ff0000", fillOpacity: 0.25 },
            [ringKeys[1]!]: { fillColor: "#00ff00", fillOpacity: 0.5 },
            [ringKeys[2]!]: { fillColor: "#0000ff", fillOpacity: 0.75 }
          }
        }
      }
    ]);

    const fills = planPageSvgRender(page).fragments
      .flatMap(elementFragments)
      .filter((fragment) => fragment.attrs["data-molecule-fill-ring"] === "true");

    expect(fills).toHaveLength(3);
    expect(fills.map((fill) => fill.attrs["data-ring-key"])).toEqual(ringKeys);
    expect(fills.map((fill) => fill.attrs.fill)).toEqual(["#ff0000", "#00ff00", "#0000ff"]);
    expect(fills.map((fill) => fill.attrs["fill-opacity"])).toEqual([0.25, 0.5, 0.75]);
  });

  it("fills macrocycle interiors even when the ring is larger than small aromatic scaffolds", () => {
    const atomCount = 16;
    const center = { x: 240, y: 220 };
    const radius = 90;
    const atoms = Array.from({ length: atomCount }, (_, index) => {
      const angle = (Math.PI * 2 * index) / atomCount;
      return {
        id: `atom_${String(index + 1).padStart(3, "0")}`,
        element: "C",
        x: Number((center.x + Math.cos(angle) * radius).toFixed(3)),
        y: Number((center.y + Math.sin(angle) * radius).toFixed(3)),
        formalCharge: 0
      };
    });
    const bonds = atoms.map((atom, index) => ({
      id: `bond_${String(index + 1).padStart(3, "0")}`,
      fromAtomId: atom.id,
      toAtomId: atoms[(index + 1) % atomCount]!.id,
      order: "single" as const
    }));
    const page = pageWithObjects([
      moleculeObject({
        id: "mol_macro_fill",
        x: 140,
        y: 120,
        width: 200,
        height: 200,
        structure: "macrocycle-sp3",
        atoms,
        bonds,
        style: {
          ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
          fillPaint: { kind: "solid", color: "#d02626" }
        }
      })
    ]);

    const fragments = planPageSvgRender(page).fragments.flatMap(elementFragments);
    const fill = fragments.find((fragment) => fragment.attrs["data-molecule-fill"] === "true");
    const pathD = String(fill?.attrs.d ?? "");

    expect(fill?.tag).toBe("path");
    expect((pathD.match(/M /g) ?? [])).toHaveLength(1);
    expect((pathD.match(/ L /g) ?? [])).toHaveLength(atomCount - 1);
    expect(pathD).toContain("330 220");
    expect(pathD).toContain("150 220");
  });

  it("does not invent molecule fills for acyclic chains", () => {
    const page = pageWithObjects([
      moleculeObject({
        id: "mol_chain_fill",
        style: {
          ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
          fillPaint: { kind: "solid", color: "#d02626" }
        }
      })
    ]);

    const fragments = planPageSvgRender(page).fragments.flatMap(elementFragments);

    expect(fragments.find((fragment) => fragment.attrs["data-molecule-fill"] === "true")).toBeUndefined();
  });

  it("renders styled native art graphics as exportable shape primitives", () => {
    const page = pageWithObjects([
      {
        id: "art_arc",
        type: "graphic",
        x: 40,
        y: 60,
        width: 58,
        height: 58,
        rotation: 0,
        style: {
          strokeColor: "#1d7f68",
          strokeWidth: 2,
          strokeDasharray: "3 4"
        },
        graphicKind: "path",
        data: {
          artPathKind: "arc",
          arcSweepRadians: Math.PI * 1.5,
          artToolId: "arc270Dashed"
        }
      },
      {
        id: "art_ellipse",
        type: "graphic",
        x: 120,
        y: 60,
        width: 72,
        height: 34,
        rotation: 0,
        style: {
          strokeColor: "#111111",
          fillColor: "#b3261e",
          strokeWidth: 1.5,
          fillMode: "gloss",
          fillOpacity: 0.48,
          tiltXDegrees: 18,
          tiltYDegrees: -12
        },
        graphicKind: "ellipse",
        data: {
          artToolId: "ellipseGloss"
        }
      },
      {
        id: "art_rect",
        type: "graphic",
        x: 210,
        y: 60,
        width: 72,
        height: 40,
        rotation: 0,
        style: {
          strokeColor: "#111111",
          fillColor: "#f8faf9",
          strokeWidth: 2,
          effect: "shadow"
        },
        graphicKind: "rect",
        data: {
          cornerRadiusPx: 7,
          artToolId: "roundedRectShadow"
        }
      }
    ]);

    const plan = planPageSvgRender(page);
    const fragments = plan.fragments.flatMap(elementFragments);

    const svgDefinitionTags = new Set([
      "defs",
      "radialGradient",
      "stop",
      "filter",
      "feMorphology",
      "feGaussianBlur",
      "feOffset",
      "feFlood",
      "feComposite",
      "feMerge",
      "feMergeNode"
    ]);
    const visibleFragments = fragments.filter((fragment) =>
      !svgDefinitionTags.has(fragment.tag) &&
      fragment.attrs.class !== "graphic-glyph-effect-source" &&
      fragment.attrs["data-graphic-effect"] === undefined
    );
    const ellipsePath = visibleFragments.find((fragment) => fragment.attrs["data-object-id"] === "art_ellipse");
    const glossGradient = fragments.find((fragment) => fragment.tag === "radialGradient");
    const glossStops = fragments.filter((fragment) => fragment.tag === "stop");
    const shadowLayers = fragments.filter((fragment) => fragment.attrs["data-graphic-effect"] === "shadow");

    expect(visibleFragments.map((fragment) => fragment.tag)).toEqual(["path", "path", "rect"]);
    expect(visibleFragments[0]?.attrs).toMatchObject({
      "data-object-id": "art_arc",
      class: "graphic-glyph-stroke graphic-glyph-path",
      stroke: "#1d7f68",
      "stroke-dasharray": "3 4",
      "stroke-linejoin": "round"
    });
    expect(String(visibleFragments[0]?.attrs.d)).toContain("A 25 25 0 1 1");
    expect(ellipsePath?.attrs).toMatchObject({
      "data-object-id": "art_ellipse",
      class: "graphic-glyph-stroke graphic-glyph-projected-shape",
      fill: "url(#graphic-gloss-art_ellipse)",
      stroke: "#111111"
    });
    expect(ellipsePath?.attrs["fill-opacity"]).toBeUndefined();
    expect(glossGradient?.attrs).toMatchObject({
      id: "graphic-gloss-art_ellipse",
      gradientUnits: "userSpaceOnUse"
    });
    expect(String(glossGradient?.attrs.gradientTransform)).toContain("matrix(");
    expect(glossStops.map((fragment) => fragment.attrs["stop-color"])).toEqual([
      "#f6e5e4",
      "#dfa4a1",
      "#b3261e",
      "#4f110d"
    ]);
    expect(glossStops.every((fragment) => fragment.attrs["stop-opacity"] === 0.48)).toBe(true);
    expect(visibleFragments[2]?.attrs).toMatchObject({
      "data-object-id": "art_rect",
      fill: "#f8faf9",
      rx: 7,
      ry: 7
    });
    expect(shadowLayers).toHaveLength(3);
    expect(shadowLayers[0]?.attrs).toMatchObject({
      "data-graphic-effect": "shadow",
      fill: "#52616b",
      stroke: "#52616b",
      transform: "translate(6 6)"
    });
    expect(plan.warnings.map((warning) => warning.code)).toEqual([]);
  });

  it("exports native graphic paint plans as SVG gradients and stroke metadata", () => {
    const page = pageWithObjects([
      {
        id: "art_gradient_rect",
        type: "graphic",
        x: 50,
        y: 70,
        width: 120,
        height: 80,
        rotation: 0,
        style: {
          opacity: 0.82,
          fillPaint: {
            kind: "linear-gradient",
            units: "object",
            x1: 0,
            y1: 0,
            x2: 1,
            y2: 0.5,
            stops: [
              { offset: 1, color: "#1648ff", opacity: 0.35 },
              { offset: 0, color: "#ffffff" }
            ]
          },
          strokePaint: {
            kind: "solid",
            color: "#1d7",
            opacity: 0.6
          },
          strokeWidth: 4,
          strokeLineCap: "square",
          strokeLineJoin: "bevel",
          strokeMiterLimit: 8
        },
        graphicKind: "rect",
        data: {
          cornerRadiusPx: 10
        }
      },
      {
        id: "art_gradient_line",
        type: "graphic",
        x: 200,
        y: 90,
        width: 80,
        height: 1,
        rotation: 0,
        style: {
          strokePaint: {
            kind: "linear-gradient",
            units: "object",
            x1: 0,
            y1: 0,
            x2: 1,
            y2: 0,
            stops: [
              { offset: 0, color: "#111111" },
              { offset: 1, color: "#b3261e", opacity: 0.7 }
            ]
          },
          strokeWidth: 3,
          strokeLineCap: "round",
          fillPaint: { kind: "none" }
        },
        graphicKind: "line",
        data: {
          lineStart: { x: 200, y: 90 },
          lineEnd: { x: 280, y: 90 }
        }
      }
    ]);

    const fragments = planPageSvgRender(page).fragments.flatMap(elementFragments);
    const rect = fragments.find((fragment) => fragment.attrs["data-object-id"] === "art_gradient_rect" && fragment.tag === "rect");
    const line = fragments.find((fragment) => fragment.attrs["data-object-id"] === "art_gradient_line" && fragment.tag === "line");
    const rectFillGradient = fragments.find((fragment) => fragment.attrs.id === "graphic-fill-art_gradient_rect");
    const lineStrokeGradient = fragments.find((fragment) => fragment.attrs.id === "graphic-stroke-art_gradient_line");
    const rectFillStops = fragments.filter((fragment) => String(fragment.key).startsWith("graphic-fill-art_gradient_rect-stop-"));
    const lineStrokeStops = fragments.filter((fragment) => String(fragment.key).startsWith("graphic-stroke-art_gradient_line-stop-"));

    expect(rect?.attrs).toMatchObject({
      "data-object-id": "art_gradient_rect",
      fill: "url(#graphic-fill-art_gradient_rect)",
      stroke: "#11dd77",
      "stroke-opacity": 0.6,
      "stroke-linecap": "square",
      "stroke-linejoin": "bevel",
      "stroke-miterlimit": 8,
      rx: 10,
      ry: 10
    });
    expect(fragments.find((fragment) => fragment.attrs["data-object-id"] === "art_gradient_rect")?.attrs.opacity).toBe(0.82);
    expect(rectFillGradient?.attrs).toMatchObject({
      id: "graphic-fill-art_gradient_rect",
      x1: 50,
      y1: 70,
      x2: 170,
      y2: 110,
      gradientUnits: "userSpaceOnUse"
    });
    expect(rectFillStops.map((stop) => stop.attrs)).toEqual([
      { offset: "0%", "stop-color": "#ffffff", "stop-opacity": undefined },
      { offset: "100%", "stop-color": "#1648ff", "stop-opacity": 0.35 }
    ]);

    expect(line?.attrs).toMatchObject({
      "data-object-id": "art_gradient_line",
      stroke: "url(#graphic-stroke-art_gradient_line)",
      "stroke-linecap": "round"
    });
    expect(lineStrokeGradient?.attrs).toMatchObject({
      id: "graphic-stroke-art_gradient_line",
      x1: 200,
      y1: 90,
      x2: 280,
      y2: 90,
      gradientUnits: "userSpaceOnUse"
    });
    expect(lineStrokeStops.map((stop) => stop.attrs)).toEqual([
      { offset: "0%", "stop-color": "#111111", "stop-opacity": undefined },
      { offset: "100%", "stop-color": "#b3261e", "stop-opacity": 0.7 }
    ]);
  });

  it("renders circular arc graphics from radian start and sweep metadata", () => {
    const page = pageWithObjects([
      {
        id: "art_open_arc",
        type: "graphic",
        x: 40,
        y: 60,
        width: 58,
        height: 58,
        rotation: 0,
        style: {
          strokeColor: "#111111",
          strokeWidth: 2,
          fillColor: "#ff0000",
          fillPaint: { kind: "solid", color: "#ff0000", opacity: 0.4 },
          fillOpacity: 0.5
        },
        graphicKind: "path",
        data: {
          artPathKind: "arc",
          arcStartRadians: 0,
          arcSweepRadians: Math.PI * 1.5
        }
      }
    ]);

    const fragments = planPageSvgRender(page).fragments.flatMap(elementFragments);

    expect(fragments[0]?.attrs.d).toBe("M 94 89 A 25 25 0 1 1 69 64");
    expect(fragments[0]?.attrs.fill).toBe("none");
  });

  it("exports open-stroke native graphics without stale fill paint", () => {
    const page = pageWithObjects([
      {
        id: "art_line",
        type: "graphic",
        x: 40,
        y: 60,
        width: 82,
        height: 46,
        rotation: 0,
        style: {
          strokeColor: "#111111",
          strokeWidth: 6,
          strokeDasharray: "0 6",
          strokeLineCap: "round",
          fillColor: "#ff0000",
          fillPaint: { kind: "solid", color: "#ff0000", opacity: 0.5 },
          fillOpacity: 0.4
        },
        graphicKind: "path",
        data: {
          artPathKind: "line"
        }
      },
      {
        id: "art_wavy",
        type: "graphic",
        x: 140,
        y: 60,
        width: 82,
        height: 46,
        rotation: 0,
        style: {
          strokeColor: "#1648ff",
          strokeWidth: 2,
          fillColor: "#ff0000",
          fillPaint: { kind: "solid", color: "#ff0000", opacity: 0.5 }
        },
        graphicKind: "path",
        data: {
          artPathKind: "wavy"
        }
      }
    ]);

    const fragments = planPageSvgRender(page).fragments.flatMap(elementFragments);
    const line = fragments.find((fragment) => fragment.attrs["data-object-id"] === "art_line");
    const wavy = fragments.find((fragment) => fragment.attrs["data-object-id"] === "art_wavy");

    expect(line?.attrs).toMatchObject({
      fill: "none",
      stroke: "#111111",
      "stroke-width": 6,
      "stroke-dasharray": "0 6",
      "stroke-linecap": "round"
    });
    expect(line?.attrs["fill-opacity"]).toBeUndefined();
    expect(wavy?.attrs).toMatchObject({
      fill: "none",
      stroke: "#1648ff"
    });
    expect(wavy?.attrs["fill-opacity"]).toBeUndefined();
  });

  it("plans native art projection bounds and gloss gradients from the same object transform", () => {
    const sphere = {
      id: "gloss_sphere",
      type: "graphic",
      x: 120,
      y: 160,
      width: 48,
      height: 48,
      rotation: 0,
      style: {
        fillColor: "#1648ff",
        fillMode: "gloss",
        strokeColor: "#1648ff"
      },
      graphicKind: "ellipse",
      data: {}
    } satisfies GraphicObject;

    const unrotated = planNativeArtVisual(sphere, { coordinateSpace: "local" });
    const rotated = planNativeArtVisual({ ...sphere, rotation: 90 }, { coordinateSpace: "local" });
    const tilted = planNativeArtVisual({
      ...sphere,
      style: {
        ...sphere.style,
        tiltXDegrees: 24
      }
    }, { coordinateSpace: "local" });

    expect(unrotated.frameBounds).toEqual({ x: 0, y: 0, width: 48, height: 48 });
    expect(rotated.frameBounds).toEqual({ x: 0, y: 0, width: 48, height: 48 });
    expect(unrotated.glossGradient?.gradientTransform).toBeUndefined();
    expect(rotated.glossGradient?.gradientTransform).toBeUndefined();
    expect(rotated.projectedShapePathD).toBeUndefined();
    expect(tilted.glossGradient?.gradientTransform).toContain("matrix(");
    expect(tilted.projectedShapePathD).toContain("M ");
  });

  it("plans projected path frames from the visible generated path geometry", () => {
    const line = {
      id: "path_line_bounds",
      type: "graphic",
      x: 120,
      y: 160,
      width: 82,
      height: 46,
      rotation: 0,
      style: {
        strokeColor: "#111111",
        strokeWidth: 2,
        tiltYDegrees: 35
      },
      graphicKind: "path",
      data: {
        artPathKind: "line"
      }
    } satisfies GraphicObject;

    const plan = planNativeArtVisual(line, { coordinateSpace: "local" });

    expect(plan.frameBounds).not.toEqual({ x: 0, y: 0, width: 82, height: 46 });
    expect(plan.projectionTransform).toContain("matrix(");
  });

  it("exports native bent graphic paths through the explicit middle handle", () => {
    const page = pageWithObjects([
      {
        id: "art_bent_line",
        type: "graphic",
        x: 94,
        y: 84,
        width: 132,
        height: 92,
        rotation: 0,
        style: {
          strokeColor: "#111111",
          strokeWidth: 2
        },
        graphicKind: "path",
        data: {
          artPathKind: "quadratic",
          lineStart: { x: 100, y: 170 },
          pathControlPoint: { x: 160, y: 90 },
          lineEnd: { x: 220, y: 170 }
        }
      }
    ]);

    const fragments = planPageSvgRender(page).fragments.flatMap(elementFragments);
    expect(fragments[0]?.attrs).toMatchObject({
      "data-object-id": "art_bent_line",
      class: "graphic-glyph-stroke graphic-glyph-path",
      d: "M 100 170 Q 160 10 220 170"
    });

    const midpointY = 0.25 * 170 + 0.5 * 10 + 0.25 * 170;
    expect(midpointY).toBe(90);
  });

  it("renders flattened depth cues as a grey-to-black bond color ramp", () => {
    const page = pageWithObjects([
      moleculeObject({
        id: "mol_depth",
        atoms: [
          { id: "atom_001", element: "C", x: 140, y: 180, formalCharge: 0 },
          { id: "atom_002", element: "C", x: 180, y: 180, formalCharge: 0 },
          { id: "atom_003", element: "C", x: 220, y: 180, formalCharge: 0 },
          { id: "atom_004", element: "C", x: 260, y: 180, formalCharge: 0 }
        ],
        bonds: [
          { id: "bond_far", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single", display: { depthWeight: 0 } },
          { id: "bond_mid", fromAtomId: "atom_002", toAtomId: "atom_003", order: "single", display: { depthWeight: 0.5 } },
          { id: "bond_near", fromAtomId: "atom_003", toAtomId: "atom_004", order: "single", display: { depthWeight: 1 } }
        ]
      })
    ]);

    const lines = planPageSvgRender(page).fragments
      .flatMap(elementFragments)
      .filter((fragment) => String(fragment.attrs.class).includes("native-bond-line"));

    expect(lines.map((fragment) => fragment.attrs["data-bond-id"])).toEqual(["bond_far", "bond_mid", "bond_near"]);
    expect(lines.map((fragment) => fragment.attrs.stroke)).toEqual(["#969696", "#4b4b4b", "#000000"]);
    expect(lines.map((fragment) => fragment.attrs["stroke-width"])).toEqual([1.2, 2, 2.8]);
  });
});

describe("ring-interior double bond side", () => {
  // Regular hexagon centred on (100,100), radius 40, Kekulé doubles on 001-002 / 003-004 /
  // 005-006, plus a FAR exocyclic substituent on atom_001. The old substituent-mass heuristic
  // is dominated by the distant substituent and flips the 001-002 inner line OUTSIDE; the
  // ring-interior rule must keep it inside (toward the centroid) regardless.
  function benzeneWithFarSubstituent(): MoleculeObject {
    return moleculeObject({
      id: "benzene",
      structure: "c1ccccc1",
      atoms: [
        { id: "atom_001", element: "C", x: 140, y: 100, formalCharge: 0 },
        { id: "atom_002", element: "C", x: 120, y: 134.64, formalCharge: 0 },
        { id: "atom_003", element: "C", x: 80, y: 134.64, formalCharge: 0 },
        { id: "atom_004", element: "C", x: 60, y: 100, formalCharge: 0 },
        { id: "atom_005", element: "C", x: 80, y: 65.36, formalCharge: 0 },
        { id: "atom_006", element: "C", x: 120, y: 65.36, formalCharge: 0 },
        { id: "atom_007", element: "O", x: 300, y: 100, formalCharge: 0 }
      ],
      bonds: [
        { id: "bond_12", fromAtomId: "atom_001", toAtomId: "atom_002", order: "double" },
        { id: "bond_23", fromAtomId: "atom_002", toAtomId: "atom_003", order: "single" },
        { id: "bond_34", fromAtomId: "atom_003", toAtomId: "atom_004", order: "double" },
        { id: "bond_45", fromAtomId: "atom_004", toAtomId: "atom_005", order: "single" },
        { id: "bond_56", fromAtomId: "atom_005", toAtomId: "atom_006", order: "double" },
        { id: "bond_61", fromAtomId: "atom_006", toAtomId: "atom_001", order: "single" },
        { id: "bond_17", fromAtomId: "atom_001", toAtomId: "atom_007", order: "single" }
      ]
    });
  }

  // Given a ring double bond, which geometric side ("left" = +normal) faces the ring centroid.
  function interiorSideOf(molecule: MoleculeObject, bondId: string): "left" | "right" {
    const bond = molecule.bonds.find((candidate) => candidate.id === bondId)!;
    const from = molecule.atoms.find((atom) => atom.id === bond.fromAtomId)!;
    const to = molecule.atoms.find((atom) => atom.id === bond.toAtomId)!;
    const len = Math.hypot(to.x - from.x, to.y - from.y);
    const nx = -(to.y - from.y) / len;
    const ny = (to.x - from.x) / len;
    const centroid = { x: 100, y: 100 };
    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    return (centroid.x - midX) * nx + (centroid.y - midY) * ny >= 0 ? "left" : "right";
  }

  it("points every ring double bond's inner line toward the ring interior", () => {
    const molecule = benzeneWithFarSubstituent();
    const sides = ringInteriorDoubleBondSides(molecule);
    for (const bondId of ["bond_12", "bond_34", "bond_56"]) {
      expect(sides.get(bondId)).toBe(interiorSideOf(molecule, bondId));
    }
  });

  it("keeps the inner line inside even when a far exocyclic substituent would flip a neighbor-mass heuristic", () => {
    const molecule = benzeneWithFarSubstituent();
    // Sanity: the far substituent really does out-mass the ring neighbours for bond_12, i.e.
    // the OLD neighbor-sum would have chosen the opposite (outside) side.
    const bond = molecule.bonds.find((candidate) => candidate.id === "bond_12")!;
    const from = molecule.atoms.find((atom) => atom.id === bond.fromAtomId)!;
    const to = molecule.atoms.find((atom) => atom.id === bond.toAtomId)!;
    const len = Math.hypot(to.x - from.x, to.y - from.y);
    const nx = -(to.y - from.y) / len;
    const ny = (to.x - from.x) / len;
    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    const neighborIds = ["atom_006", "atom_003", "atom_007"]; // ring neighbours + substituent
    const neighborScore = neighborIds.reduce((sum, atomId) => {
      const atom = molecule.atoms.find((candidate) => candidate.id === atomId)!;
      return sum + (atom.x - midX) * nx + (atom.y - midY) * ny;
    }, 0);
    const neighborSide = neighborScore >= 0 ? "left" : "right";
    expect(neighborSide).not.toBe(interiorSideOf(molecule, "bond_12"));
    // The ring-interior rule ignores that and stays inside.
    expect(ringInteriorDoubleBondSides(molecule).get("bond_12")).toBe(interiorSideOf(molecule, "bond_12"));
  });

  it("does not assign a side to non-ring (chain) double bonds", () => {
    const molecule = moleculeObject({
      id: "acrolein",
      structure: "C=CC=O",
      atoms: [
        { id: "atom_001", element: "C", x: 100, y: 100, formalCharge: 0 },
        { id: "atom_002", element: "C", x: 140, y: 100, formalCharge: 0 },
        { id: "atom_003", element: "C", x: 180, y: 100, formalCharge: 0 }
      ],
      bonds: [
        { id: "bond_12", fromAtomId: "atom_001", toAtomId: "atom_002", order: "double" },
        { id: "bond_23", fromAtomId: "atom_002", toAtomId: "atom_003", order: "single" }
      ]
    });
    expect(ringInteriorDoubleBondSides(molecule).size).toBe(0);
  });
});

describe("atom-label depth cueing", () => {
  it("averages only the defined incident bond weights", () => {
    expect(averageDefinedDepthWeights([0.2, 0.8])).toBeCloseTo(0.5);
    expect(averageDefinedDepthWeights([undefined, 0.6])).toBeCloseTo(0.6);
  });

  it("returns undefined when no incident bond is depth-cued (planar view)", () => {
    expect(averageDefinedDepthWeights([])).toBeUndefined();
    expect(averageDefinedDepthWeights([undefined, undefined])).toBeUndefined();
  });

  it("fades a far label toward grey and keeps a near label at its base colour", () => {
    // weight 0 = farthest → the fixed far-grey; weight 1 = nearest → unchanged base.
    expect(depthCuedLabelColor("#111111", 0)).toBe("#7d7d7d");
    expect(depthCuedLabelColor("#111111", 1)).toBe("#111111");
    // A mid-depth label sits between the two, still darker than the bond fog (150).
    const mid = depthCuedLabelColor("#111111", 0.5);
    expect(mid).not.toBe("#111111");
    expect(mid).not.toBe("#7d7d7d");
  });

  it("passes the colour through unchanged when there is no depth cue", () => {
    expect(depthCuedLabelColor("#b3261e", undefined)).toBe("#b3261e");
  });

  it("scales labels gently by depth (0.92 far … 1.08 near), no scale when uncued", () => {
    expect(depthCuedLabelScale(0)).toBeCloseTo(0.92);
    expect(depthCuedLabelScale(1)).toBeCloseTo(1.08);
    expect(depthCuedLabelScale(undefined)).toBe(1);
  });

  it("sizes the knockout halo from the label font size", () => {
    expect(atomLabelHaloWidthPx({ atomLabelFontSizePx: 15 } as never)).toBeCloseTo(4.5);
  });
});
