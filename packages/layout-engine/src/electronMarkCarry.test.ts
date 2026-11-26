// The one placement rule for marks a redrawn molecule carries (Spin 3D overlay, flatten, typed
// rotations, Interactive 3D, 3D clean-up): keep the 2D offset from the atom; if that spot lands on
// another atom or a bond, turn about the atom, at the same distance, to the nearest free side.
import { describe, expect, it } from "vitest";
import { createEmptyDocument, type ElectronMarkObject } from "@chemdraft/chem-core";
import {
  carriedElectronMarkInkRadius, carriedElectronMarkSvgTransform, carryElectronMarksToRedrawnMolecule, carryElectronMarksWithAtoms,
  carriedMarkLabelDepth, electronMarkInkRadius, planPageSvgRender, type ElectronMarkCarryEntry, type ElectronMarkCarryMolecule, type PageSvgFragment
} from "./index";

const size = { width: 18, height: 18 };
const ink = carriedElectronMarkInkRadius(size);

function segmentDistance(point: { x: number; y: number }, from: { x: number; y: number }, to: { x: number; y: number }) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const t = Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - from.x - t * dx, point.y - from.y - t * dy);
}

describe("carryElectronMarksWithAtoms", () => {
  it("keeps the offset when the carried spot is free", () => {
    const atoms = [{ id: "a", x: 0, y: 0 }, { id: "b", x: -30, y: 0 }];
    const [placed] = carryElectronMarksWithAtoms(atoms, [{ fromAtomId: "a", toAtomId: "b" }], [{ atomId: "a", offset: { x: 15, y: -15 }, ...size }]);
    expect(placed).toEqual({ center: { x: 15, y: -15 }, turn: 0 });
  });

  it("turns, at the same distance, off a spot another atom has moved next to", () => {
    // After the move another atom sits just past the mark: kept, it would read as that atom's.
    const atoms = [{ id: "a", x: 0, y: 0 }, { id: "b", x: 30, y: 4 }];
    const [placed] = carryElectronMarksWithAtoms(atoms, [], [{ atomId: "a", offset: { x: 22, y: 0 }, ...size }]);
    expect(placed!.turn).not.toBe(0);
    expect(Math.hypot(placed!.center.x, placed!.center.y)).toBeCloseTo(22, 9);
    expect(Math.hypot(placed!.center.x - 30, placed!.center.y - 4)).toBeGreaterThanOrEqual(22);
    // The nearest free side: b sits just below the kept spot's line, so the mark turns up (negative y), and only as far as needed.
    expect(placed!.center.y).toBeLessThan(0);
    expect(Math.abs(placed!.turn)).toBeLessThanOrEqual(Math.PI / 2);
  });

  it("turns off a bond that now runs under the mark", () => {
    const atoms = [{ id: "a", x: 0, y: 0 }, { id: "c", x: 0, y: 40 }];
    const bonds = [{ fromAtomId: "a", toAtomId: "c" }];
    const [placed] = carryElectronMarksWithAtoms(atoms, bonds, [{ atomId: "a", offset: { x: 0, y: 22 }, ...size }]);
    expect(placed!.turn).not.toBe(0);
    expect(Math.hypot(placed!.center.x, placed!.center.y)).toBeCloseTo(22, 9);
    expect(segmentDistance(placed!.center, atoms[0]!, atoms[1]!)).toBeGreaterThan(ink);
  });

  it("keeps two turning marks off each other", () => {
    const atoms = [{ id: "a", x: 0, y: 0 }, { id: "c", x: 0, y: 40 }];
    const bonds = [{ fromAtomId: "a", toAtomId: "c" }];
    const [first, second] = carryElectronMarksWithAtoms(atoms, bonds, [
      { atomId: "a", offset: { x: 0, y: 22 }, ...size }, { atomId: "a", offset: { x: 0.5, y: 22 }, ...size }
    ]);
    expect(Math.hypot(first!.center.x - second!.center.x, first!.center.y - second!.center.y)).toBeGreaterThan(2 * ink);
  });

  it("leaves a mark drawn on its atom, and skips one whose atom is gone", () => {
    const atoms = [{ id: "a", x: 5, y: 5 }];
    expect(carryElectronMarksWithAtoms(atoms, [], [
      { atomId: "a", offset: { x: 0, y: 0 }, ...size }, { atomId: "gone", offset: { x: 10, y: 0 }, ...size }
    ])).toEqual([{ center: { x: 5, y: 5 }, turn: 0 }, undefined]);
  });
});

function molecule(atoms: ElectronMarkCarryMolecule["atoms"], rotation = 0, bonds: ElectronMarkCarryMolecule["bonds"] = []): ElectronMarkCarryMolecule {
  return { atoms, bonds, x: 0, y: 0, width: 100, height: 100, rotation };
}

describe("carryElectronMarksToRedrawnMolecule", () => {
  const charge: ElectronMarkCarryEntry = { atomId: "a", mark: { id: "m", markKind: "charge", x: 21, y: 1, ...size, rotation: 0 } };

  it("holds the mark's page offset from its atom when the molecule moves", () => {
    const before = molecule([{ id: "a", x: 10, y: 10 }, { id: "b", x: -20, y: 10 }]);
    const after = molecule([{ id: "a", x: 60, y: 40 }, { id: "b", x: 30, y: 40 }]);
    expect(carryElectronMarksToRedrawnMolecule(before, after, [charge]).get("m")).toEqual({
      markId: "m", atomId: "a", x: 71, y: 31, rotation: 0, turnDegrees: 0
    });
  });

  it("reads the page offset in a rotated molecule's own frame", () => {
    const before = molecule([{ id: "a", x: 10, y: 10 }]);
    // Redrawn turned a quarter about its centre (50, 50): atom a draws on the page at (90, 10).
    const after = molecule([{ id: "a", x: 10, y: 10 }], 90);
    const placed = carryElectronMarksToRedrawnMolecule(before, after, [charge]).get("m")!;
    // The mark's centre stays 20 px to the right of its atom on the page.
    expect(placed.x + 9).toBeCloseTo(110, 9);
    expect(placed.y + 9).toBeCloseTo(10, 9);
  });

  it("turns a lone pair with it, and keeps every other mark's own rotation", () => {
    const before = molecule([{ id: "a", x: 0, y: 0 }]);
    const after = molecule([{ id: "a", x: 0, y: 0 }, { id: "b", x: 30, y: 4 }]);
    const lonePair: ElectronMarkCarryEntry = { atomId: "a", mark: { id: "lp", markKind: "lone-pair", x: 13, y: -9, ...size, rotation: 90 } };
    const radical: ElectronMarkCarryEntry = { atomId: "a", mark: { id: "r", markKind: "radical-dot", x: 13, y: -9, ...size, rotation: 30 } };
    const placements = carryElectronMarksToRedrawnMolecule(before, after, [lonePair]);
    const turned = placements.get("lp")!;
    expect(turned.turnDegrees).not.toBe(0);
    expect(turned.rotation).toBeCloseTo(((90 + turned.turnDegrees) % 360 + 360) % 360, 9);
    const kept = carryElectronMarksToRedrawnMolecule(before, after, [radical]).get("r")!;
    expect(kept.turnDegrees).not.toBe(0);
    expect(kept.rotation).toBe(30);
  });

  it("paints the stored drawing at the placement: a move, plus a turn about its centre when it turned", () => {
    const mark = { id: "m", markKind: "lone-pair" as const, x: 10, y: 20, ...size, rotation: 350 };
    expect(carriedElectronMarkSvgTransform(mark, { x: 15, y: 18, rotation: 350 })).toBe("translate(5 -2)");
    expect(carriedElectronMarkSvgTransform(mark, { x: 15, y: 18, rotation: 20 })).toBe("translate(5 -2) rotate(30 19 29)");
  });
});

/** The ink of a mark as the page renderer draws it: each circle's radius plus half its stroke, about the mark's centre. */
function renderedCircleReach(mark: ElectronMarkObject): number {
  const center = { x: mark.x + mark.width / 2, y: mark.y + mark.height / 2 };
  let reach = 0;
  const visit = (fragment: PageSvgFragment) => {
    if (fragment.kind !== "element") return;
    if (fragment.tag === "circle") {
      const stroke = fragment.attrs.stroke && fragment.attrs.stroke !== "none" ? Number(fragment.attrs["stroke-width"]) / 2 : 0;
      reach = Math.max(reach, Math.hypot(Number(fragment.attrs.cx) - center.x, Number(fragment.attrs.cy) - center.y) +
        Number(fragment.attrs.r) + stroke);
    }
    fragment.children.forEach(visit);
  };
  planPageSvgRender({ ...createEmptyDocument().pages[0], objects: [mark] }).fragments.forEach(visit);
  return reach;
}

function chargeMark(charge: number, extra: Partial<ElectronMarkObject> = {}): ElectronMarkObject {
  return {
    id: "q", type: "electron-mark", markKind: "charge", charge, x: 13, y: -9, ...size, rotation: 0, style: {},
    anchor: { kind: "atom", objectId: "mol", atomId: "a" }, ...extra
  } as ElectronMarkObject;
}

describe("a carried charge keeps clear by the ink the renderer draws", () => {
  it("a 2+ is drawn in a larger circle than a single charge, and its ink radius is that circle's", () => {
    const single = chargeMark(-1), double = chargeMark(2);
    expect(electronMarkInkRadius(single)).toBeCloseTo(renderedCircleReach(single), 9);
    expect(electronMarkInkRadius(double)).toBeCloseTo(renderedCircleReach(double), 9);
    // The footprint this rule used for every mark is smaller than the 2+'s circle.
    expect(electronMarkInkRadius(double)).toBeGreaterThan(carriedElectronMarkInkRadius(size) + 1.5);
    // A heavier stroke draws a wider circle.
    const heavy = chargeMark(2, { style: { strokeWidth: 3 } });
    expect(electronMarkInkRadius(heavy)).toBeCloseTo(renderedCircleReach(heavy), 9);
    expect(electronMarkInkRadius(heavy)).toBeGreaterThan(electronMarkInkRadius(double));
  });

  it("a plain radical ion reaches as far as its sign's bar", () => {
    const radicalIon = chargeMark(-1, { radical: true });
    const center = { x: radicalIon.x + 9, y: radicalIon.y + 9 };
    let barEnd = 0;
    const visit = (fragment: PageSvgFragment) => {
      if (fragment.kind !== "element") return;
      if (fragment.tag === "line") {
        barEnd = Math.max(barEnd, Math.hypot(Number(fragment.attrs.x2) - center.x, Number(fragment.attrs.y2) - center.y) +
          Number(fragment.attrs["stroke-width"]) / 2);
      }
      fragment.children.forEach(visit);
    };
    planPageSvgRender({ ...createEmptyDocument().pages[0], objects: [radicalIon] }).fragments.forEach(visit);
    expect(barEnd).toBeGreaterThan(0);
    expect(electronMarkInkRadius(radicalIon)).toBeCloseTo(barEnd, 9);
  });

  it("a bond line 8 px from the mark's centre leaves a -1 where it was carried and turns a 2+ off it", () => {
    // A long bond between two far atoms runs 8 px under the spot a's mark is carried to.
    const atoms = [{ id: "a", x: 0, y: 0 }, { id: "c", x: -100, y: 8 }, { id: "d", x: 200, y: 8 }];
    const drawn = molecule(atoms, 0, [{ fromAtomId: "c", toAtomId: "d" }]);
    const single = carryElectronMarksToRedrawnMolecule(drawn, drawn, [{ atomId: "a", mark: chargeMark(-1) }]).get("q")!;
    expect(single.turnDegrees).toBe(0);
    const double = carryElectronMarksToRedrawnMolecule(drawn, drawn, [{ atomId: "a", mark: chargeMark(2) }]).get("q")!;
    expect(double.turnDegrees).not.toBe(0);
    const center = { x: double.x + 9, y: double.y + 9 };
    expect(Math.hypot(center.x, center.y)).toBeCloseTo(22, 9);
    expect(segmentDistance(center, atoms[1]!, atoms[2]!)).toBeGreaterThanOrEqual(electronMarkInkRadius(chargeMark(2)) + 1 - 1e-9);
  });
});

describe("other molecules on the page are obstacles too", () => {
  const charge: ElectronMarkCarryEntry = { atomId: "a", mark: { id: "m", markKind: "charge", x: 13, y: -9, ...size, rotation: 0 } };
  const drawn = molecule([{ id: "a", x: 0, y: 0 }, { id: "b", x: -30, y: 0 }], 0, [{ fromAtomId: "a", toAtomId: "b" }]);

  it("keeps the offset when the other molecule is out of the way, and turns off its atom when it is not", () => {
    const far = { ...molecule([{ id: "x", x: 300, y: 300 }]), x: 290, y: 290, width: 20, height: 20 };
    expect(carryElectronMarksToRedrawnMolecule(drawn, drawn, [charge], [far]).get("m")!.turnDegrees).toBe(0);
    // Another molecule's atom 3 px past the spot the mark is carried to: kept, the mark would read as that atom's.
    const near = { ...molecule([{ id: "x", x: 24, y: 2 }]), x: 14, y: -8, width: 20, height: 20 };
    const placed = carryElectronMarksToRedrawnMolecule(drawn, drawn, [charge], [near]).get("m")!;
    expect(placed.turnDegrees).not.toBe(0);
    const center = { x: placed.x + 9, y: placed.y + 9 };
    expect(Math.hypot(center.x, center.y)).toBeCloseTo(22, 9);
    expect(Math.hypot(center.x - 24, center.y - 2)).toBeGreaterThanOrEqual(22);
  });

  it("turns off another molecule's bond whose atoms are far away", () => {
    // A long bond runs straight through the carried spot; both of its atoms are far from it.
    const crossing = { ...molecule([{ id: "x", x: 22, y: -80 }, { id: "y", x: 22, y: 80 }], 0, [{ fromAtomId: "x", toAtomId: "y" }]),
      x: 12, y: -90, width: 20, height: 180 };
    const placed = carryElectronMarksToRedrawnMolecule(drawn, drawn, [charge], [crossing]).get("m")!;
    expect(placed.turnDegrees).not.toBe(0);
    const center = { x: placed.x + 9, y: placed.y + 9 };
    expect(Math.abs(center.x - 22)).toBeGreaterThanOrEqual(electronMarkInkRadius(charge.mark) + 1 - 1e-9);
  });

  it("reads another molecule turned on the page in its own frame", () => {
    // Stored with its atom at (24, 42) in a frame turned a quarter about (22, 22): on the page it sits at (2, 24) ...
    const turned = { ...molecule([{ id: "x", x: 24, y: 42 }], 90), x: 12, y: 12, width: 20, height: 20 };
    // ... beside the spot a mark carried 22 px below `a` lands on, so that mark turns, and one carried to the right does not.
    const below: ElectronMarkCarryEntry = { atomId: "a", mark: { id: "m", markKind: "charge", x: -9, y: 13, ...size, rotation: 0 } };
    expect(carryElectronMarksToRedrawnMolecule(drawn, drawn, [below], [turned]).get("m")!.turnDegrees).not.toBe(0);
    expect(carryElectronMarksToRedrawnMolecule(drawn, drawn, [charge], [turned]).get("m")!.turnDegrees).toBe(0);
  });
});

describe("atom labels' letters are obstacles", () => {
  const charge: ElectronMarkCarryEntry = { atomId: "a", mark: { id: "m", markKind: "charge", x: 13, y: -9, ...size, rotation: 0 } };

  it("turns a mark off its own molecule's label letters, as the redrawn molecule draws them", () => {
    const drawn = molecule([{ id: "a", x: 0, y: 0 }]);
    // The redrawn molecule draws a label whose letters run under the carried spot (22, 0).
    const redrawn = { ...drawn, labelBoxes: [{ atomId: "a", x: 14, y: -6, width: 16, height: 12 }] };
    expect(carryElectronMarksToRedrawnMolecule(drawn, drawn, [charge]).get("m")!.turnDegrees).toBe(0);
    const placed = carryElectronMarksToRedrawnMolecule(drawn, redrawn, [charge]).get("m")!;
    expect(placed.turnDegrees).not.toBe(0);
    const center = { x: placed.x + 9, y: placed.y + 9 };
    expect(Math.hypot(center.x, center.y)).toBeCloseTo(22, 9);
    // Clear of the box by its ink and a pixel of air.
    const dx = Math.max(0, 14 - center.x, center.x - 30), dy = Math.max(0, -6 - center.y, center.y - 6);
    expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(electronMarkInkRadius(charge.mark) + 1 - 1e-9);
  });

  it("leaves a mark as deep in its own label as it was drawn, and turns one the redrawn label runs deeper under", () => {
    // Drawn just touching its atom's label (the charge tool leaves a '+' so on "H3N"), then moved.
    const label = (dx: number) => [{ atomId: "a", x: dx + 2, y: 2, width: 30, height: 12 }];
    const drawn = { ...molecule([{ id: "a", x: 0, y: 0 }]), labelBoxes: label(0) };
    const above: ElectronMarkCarryEntry = { atomId: "a", mark: { id: "m", markKind: "charge", x: 4, y: -13, ...size, rotation: 0 } };
    const center = { x: 13, y: -4 };
    expect(carriedMarkLabelDepth(center, electronMarkInkRadius(above.mark), label(0)[0]!)).toBeGreaterThan(0);
    const moved = { ...molecule([{ id: "a", x: 50, y: 30 }]), labelBoxes: label(50).map(box => ({ ...box, y: box.y + 30 })) };
    expect(carryElectronMarksToRedrawnMolecule(drawn, moved, [above]).get("m")).toMatchObject({ x: 54, y: 17, turnDegrees: 0 });
    // The same label redrawn reaching up under the mark: it turns.
    const deeper = { ...moved, labelBoxes: [{ atomId: "a", x: 52, y: 28, width: 30, height: 12 }] };
    expect(carryElectronMarksToRedrawnMolecule(drawn, moved, [above]).get("m")!.turnDegrees).toBe(0);
    expect(carryElectronMarksToRedrawnMolecule(drawn, deeper, [above]).get("m")!.turnDegrees).not.toBe(0);
  });

  it("turns a mark off another molecule's label, turned with that molecule", () => {
    const drawn = molecule([{ id: "a", x: 0, y: 0 }]);
    // Atoms far away; its label box, stored about (22, 44) in a frame turned a quarter about (22, 22), draws across (0, 22) on the page.
    const other = { ...molecule([{ id: "x", x: 22, y: 100 }], 90), x: 12, y: 12, width: 20, height: 20,
      labelBoxes: [{ atomId: "x", x: 14, y: 34, width: 16, height: 20 }] };
    const below: ElectronMarkCarryEntry = { atomId: "a", mark: { id: "m", markKind: "charge", x: -9, y: 13, ...size, rotation: 0 } };
    const placed = carryElectronMarksToRedrawnMolecule(drawn, drawn, [below], [other]).get("m")!;
    expect(placed.turnDegrees).not.toBe(0);
    expect(carryElectronMarksToRedrawnMolecule(drawn, drawn, [charge], [other]).get("m")!.turnDegrees).toBe(0);
  });
});
