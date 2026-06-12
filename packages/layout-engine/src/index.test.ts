import { describe, expect, it } from "vitest";
import {
  ChemDraftSyntheticStylePreset,
  createEmptyDocument,
  stylePresetToObjectStyle,
  type DocumentObject,
  type DocumentPage,
  type MoleculeObject
} from "@chemdraft/chem-core";
import {
  atomDegrees,
  findNearestAtomAtPoint,
  findNearestBondHit,
  findNearestAtomHit,
  planBondExtension,
  planPageSvgRender,
  planFreeformBondExtension,
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
        "rect|mol_snapshot|molecule|native-atom-label-background|157.35|143.936",
        "text|mol_snapshot|molecule|native-atom-label-run|0|0|middle",
        "text|mol_snapshot|molecule|native-atom-label-run|5.8500000000000005|-7.199999999999999|start",
        "text|text_snapshot|text|220|178|start",
        "tspan|text_snapshot|text|220|178|start",
        "text|charge_snapshot|electron-mark|329|169|middle",
      ]
    `);
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
