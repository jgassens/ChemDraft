import { describe, expect, it } from "vitest";
import {
  atomDegrees,
  findNearestAtomAtPoint,
  findNearestBondHit,
  findNearestAtomHit,
  planBondExtension,
  planFreeformBondExtension,
  type BondExtensionPlanningInput
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
