// A group label meets its bond at the atom it bonds to (PLANS.md, label anchoring): "OMe" with its
// O on the atom, drawn "MeO" with the bond on its right. Display only: the stored label is never
// touched. The stress cases below check, for each label and bond direction, what is drawn, which
// character sits on the atom, and where the bond stops against the label's box, against the old
// centred layout. (The numbers are in PR #97's body.)

import { describe, expect, it } from "vitest";
import {
  ChemDraftSyntheticStylePreset,
  createEmptyDocument,
  drawnLabelBondSide,
  nativeDrawingStyleFromObjectStyle,
  stylePresetToObjectStyle,
  type MoleculeAtom,
  type MoleculeObject
} from "@chemdraft/chem-core";

import {
  atomDisplayLabelPlacement,
  atomLabelLayout,
  nativeGroupLabelDisplay,
  planBondExtension,
  planMoleculeAtomLabels,
  planPageSvgRender
} from "./index";
import { elementFragments } from "./testing";

describe("how a group label is drawn the way round its bond reads", () => {
  it.each([
    // [label, bond side, drawn text, anchor side, anchor length]
    ["OMe", "left", "OMe", "start", 1],
    ["OMe", "right", "MeO", "end", 1],
    ["MeO", "left", "OMe", "start", 1],
    ["CO2Me", "left", "CO2Me", "start", 1],
    ["CO2Me", "right", "MeO2C", "end", 1],
    ["COOMe", "right", "MeOOC", "end", 1],
    ["CO2H", "right", "HO2C", "end", 1],
    ["CF3", "right", "F3C", "end", 1],
    ["NHBoc", "left", "NHBoc", "start", 1],
    ["NHBoc", "right", "BocHN", "end", 1],
    ["NMe2", "right", "Me2N", "end", 1],
    ["CH2Ph", "right", "PhH2C", "end", 1],
    // A substituent that spells the atom it bonds by turns with the label, so that atom still
    // faces the head: "MeOH2C", never "OMeH2C".
    ["CH2OMe", "left", "CH2OMe", "start", 1],
    ["CH2OMe", "right", "MeOH2C", "end", 1],
    ["MeOH2C", "left", "CH2OMe", "start", 1],
    ["CH2CO2Me", "right", "MeO2CH2C", "end", 1],
    ["SiMe3", "left", "SiMe3", "start", 2],
    ["SiMe3", "right", "Me3Si", "end", 2],
    ["SCN", "left", "SCN", "start", 1],
    // No spelling of its own atom: the letter nearest the bond sits on the atom.
    ["Ph", "left", "Ph", "start", 1],
    ["Ph", "right", "Ph", "end", 1],
    ["TMS", "right", "TMS", "end", 1],
    // Its reversal would read as another group ("MeOC"), so it stays as typed.
    ["COMe", "right", "COMe", "end", 1]
  ] as const)("%s with its bond on the %s: drawn %s, %s %d on the atom", (label, side, text, anchorSide, length) => {
    expect(nativeGroupLabelDisplay(label, side)).toEqual({ text, anchor: { side: anchorSide, length } });
  });

  it.each([
    ["SCN", "right", "cyano with its bond on the right reads as a bare formula, and is never drawn CNS"],
    ["CH2CN", "right", "the same for a cyano composite"],
    ["Ome", "left", "unrecognised text is not a group"],
    ["CONH2", "left", "a bare formula is not a group"],
    ["CH2NMe2", "left", "two heavy atoms (NMe2 is no table abbreviation) are not one group"],
    ["CH2NMe2", "right", "the same with its bond on the right"]
  ] as const)("%s with its bond on the %s keeps the centred layout: %s", (label, side, _why) => {
    expect(nativeGroupLabelDisplay(label, side)).toBeUndefined();
  });
});

describe("a group label on a ring vertex points out of the ring", () => {
  const style = { ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset), source: "chemdraft-native-drawing" as const };
  const radius = 30;
  /** A hexagon, "vertical-sided" (a vertex at the top) or "flat-topped", with `label` on vertex `at`. */
  function ring(orientation: "vertical-sided" | "flat-topped", at: number, label: string, literal = true): MoleculeObject {
    const start = orientation === "vertical-sided" ? -90 : 0;
    const atoms: MoleculeAtom[] = Array.from({ length: 6 }, (_, index) => {
      const angle = ((start + 60 * index) * Math.PI) / 180;
      return {
        id: `v${index}`, element: index === at ? label : "C",
        x: 300 + radius * Math.cos(angle), y: 300 + radius * Math.sin(angle), formalCharge: 0,
        ...(index === at && literal ? { labelLiteral: true } : {})
      };
    });
    return {
      id: "ring", type: "molecule", x: 260, y: 260, width: 80, height: 80, rotation: 0, style,
      structureFormat: "smiles", structure: "", superatoms: [], rGroups: [], atoms,
      bonds: atoms.map((atom, index) => ({ id: `b${index}`, fromAtomId: atom.id, toAtomId: atoms[(index + 1) % 6]!.id, order: "single" as const }))
    };
  }
  const planAt = (molecule: MoleculeObject, at: number) =>
    planMoleculeAtomLabels(molecule).find((plan) => plan.atom.id === `v${at}`)!;

  it.each([[0, "OMe", "start"], [3, "MeO", "end"]] as const)(
    "an OMe substituent grown from cyclohexane vertex %d draws %s with its O on the attachment",
    (at, text, anchorSide) => {
      const original = ring("flat-topped", at, "C", false);
      const source = original.atoms[at]!;
      const drawingStyle = nativeDrawingStyleFromObjectStyle(original.style);
      const extension = planBondExtension({ atoms: original.atoms, bonds: original.bonds,
        clickPoint: source, preferredAtomId: source.id, bondLength: drawingStyle.bondLengthPx,
        hitRadius: 8, targetBondAngleDegrees: drawingStyle.chainAngleDegrees,
        pageBounds: { x: 0, y: 0, width: 792, height: 612 } });
      expect(extension).toBeDefined();
      const direction = at === 0 ? 1 : -1;
      const substituent: MoleculeAtom = { id: "OMe", element: "OMe", labelLiteral: true,
        formalCharge: 0, ...extension!.newAtomPoint };
      expect((substituent.x - source.x) * direction).toBeGreaterThan(0);
      const molecule: MoleculeObject = { ...original,
        atoms: [...original.atoms, substituent],
        bonds: [...original.bonds, { id: "attachment", fromAtomId: source.id, toAtomId: substituent.id, order: "single" }] };
      const plan = planMoleculeAtomLabels(molecule).find(candidate => candidate.atom.id === substituent.id)!;
      expect(molecule.atoms.slice(0, 6)).toEqual(original.atoms);
      expect(molecule.bonds.slice(0, 6)).toEqual(original.bonds);
      expect(plan.atom).toBe(substituent);
      expect(plan.label).toBe(text);
      expect(plan.labelAnchor).toEqual({ side: anchorSide, length: 1 });
      expect(plan.anchor).toEqual({ x: substituent.x, y: substituent.y });
      const run = plan.layout.runs[0]!;
      expect(run.text).toBe(text);
      expect(run.textAnchor).toBe(anchorSide);
      const glyph = drawingStyle.atomLabelFontSizePx * 0.62;
      const oxygenLeft = anchorSide === "start" ? run.x : run.x - glyph;
      expect(oxygenLeft).toBeLessThanOrEqual(0);
      expect(oxygenLeft + glyph).toBeGreaterThanOrEqual(0);
      const box = plan.layout.bounds;
      expect(at === 0 ? box.x + box.width : -box.x).toBeGreaterThan(glyph * 2);
      const line = planPageSvgRender({ ...createEmptyDocument().pages[0]!, objects: [molecule] })
        .fragments.flatMap(elementFragments)
        .find(fragment => String(fragment.attrs.class).includes("native-bond-line") && fragment.attrs["data-bond-id"] === "attachment")!;
      const endX = Number(line.attrs.x2);
      expect((substituent.x - endX) * direction).toBeGreaterThanOrEqual(glyph / 2);
      expect((endX - source.x) * direction).toBeGreaterThan(0);
    }
  );

  // The side each vertex's bonds pull to; "tie" for the top and bottom of a vertical-sided ring.
  const sides = {
    "vertical-sided": ["tie", "left", "left", "tie", "right", "right"],
    "flat-topped": ["left", "left", "right", "right", "right", "left"]
  } as const;
  const drawnFor = (label: "OMe" | "NMe", side: "left" | "right" | "tie") =>
    side === "right" ? { text: label === "OMe" ? "MeO" : "MeN", anchor: "end" } : { text: label, anchor: "start" };

  it.each((["vertical-sided", "flat-topped"] as const).flatMap((orientation) =>
    (["OMe", "NMe"] as const).flatMap((label) => [0, 1, 2, 3, 4, 5].map((at) => [label, at, orientation] as const))
  ))("%s on vertex %d of a %s ring", (label, at, orientation) => {
    const molecule = ring(orientation, at, label);
    const plan = planAt(molecule, at);
    const expected = drawnFor(label, sides[orientation][at]!);
    expect({ text: plan.label, anchor: plan.labelAnchor?.side }).toEqual(expected);
    // Display only: the planned atom is the stored one, with no recorded side added.
    expect(plan.atom).toBe(molecule.atoms[at]);
    expect(plan.atom.labelBondSide).toBeUndefined();
  });

  it("keeps a label as typed where its bonds pull neither way (the top of a vertical-sided ring)", () => {
    expect({ text: planAt(ring("vertical-sided", 0, "MeO"), 0).label, anchor: planAt(ring("vertical-sided", 0, "MeO"), 0).labelAnchor?.side })
      .toEqual({ text: "MeO", anchor: "end" });
    expect({ text: planAt(ring("vertical-sided", 3, "OMe"), 3).label, anchor: planAt(ring("vertical-sided", 3, "OMe"), 3).labelAnchor?.side })
      .toEqual({ text: "OMe", anchor: "start" });
  });

  it("leaves element labels as they were: a typed NH, and a ring N drawn with its H", () => {
    // Vertex 5 of a vertical-sided ring pulls right, which would turn a group label.
    const typed = planAt(ring("vertical-sided", 5, "NH"), 5);
    expect({ label: typed.label, anchor: typed.labelAnchor }).toEqual({ label: "NH", anchor: undefined });
    const element = planAt(ring("vertical-sided", 5, "N", false), 5);
    expect({ label: element.label, anchor: element.labelAnchor }).toEqual({ label: "NH", anchor: undefined });
  });

  it.each([0, 30, 60, 89.99, 90, 90.01, 120, 180, 240, 270, 300, 330])(
    "a one-bond label keeps chem-core's side test exactly: bond at %d°",
    (degrees) => {
      const radians = (degrees * Math.PI) / 180;
      const atom: MoleculeAtom = { id: "L", element: "OMe", x: 300, y: 300, formalCharge: 0, labelLiteral: true };
      const neighbour: MoleculeAtom = { id: "c", element: "C", x: 300 + 30 * Math.cos(radians), y: 300 - 30 * Math.sin(radians), formalCharge: 0 };
      const molecule: MoleculeObject = {
        id: "one", type: "molecule", x: 260, y: 260, width: 80, height: 80, rotation: 0, style,
        structureFormat: "smiles", structure: "", superatoms: [], rGroups: [], atoms: [atom, neighbour],
        bonds: [{ id: "b", fromAtomId: "L", toAtomId: "c", order: "single" }]
      };
      const plan = planMoleculeAtomLabels(molecule).find((candidate) => candidate.atom.id === "L")!;
      expect(plan.labelAnchor?.side).toBe(drawnLabelBondSide(atom, [neighbour]) === "right" ? "end" : "start");
    }
  );
});

describe("label anchoring stress: OMe, CO2Me, NHBoc, Ph and TMS at four bond directions", () => {
  const style = { ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset), source: "chemdraft-native-drawing" as const };
  const drawingStyle = nativeDrawingStyleFromObjectStyle(style);
  const bondLength = 40;
  const directions = {
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 }
  } as const;

  /** The label on L, bonded to a carbon chain that runs off in `direction`. */
  function labelled(label: string, direction: { x: number; y: number }): MoleculeObject {
    const at = (steps: number): Pick<MoleculeAtom, "x" | "y"> => ({ x: 300 + direction.x * bondLength * steps, y: 300 + direction.y * bondLength * steps });
    return {
      id: "mol", type: "molecule", x: 200, y: 200, width: 200, height: 200, rotation: 0, style,
      structureFormat: "smiles", structure: "", superatoms: [], rGroups: [],
      atoms: [
        { id: "L", element: label, ...at(0), formalCharge: 0, labelLiteral: true },
        { id: "c1", element: "C", ...at(1), formalCharge: 0 },
        { id: "c2", element: "C", ...at(2), formalCharge: 0 }
      ],
      bonds: [
        { id: "b1", fromAtomId: "L", toAtomId: "c1", order: "single" },
        { id: "b2", fromAtomId: "c1", toAtomId: "c2", order: "single" }
      ]
    };
  }

  /** How far along `direction` from the atom a box (relative to the atom) reaches. */
  function boxReach(box: { x: number; y: number; width: number; height: number }, direction: { x: number; y: number }): number {
    const along = (low: number, high: number, d: number) => d > 0.0001 ? high / d : d < -0.0001 ? low / d : Number.POSITIVE_INFINITY;
    return Math.min(along(box.x, box.x + box.width, direction.x), along(box.y, box.y + box.height, direction.y));
  }

  it.each(
    ["OMe", "CO2Me", "NHBoc", "Ph", "TMS"].flatMap((label) =>
      (Object.keys(directions) as (keyof typeof directions)[]).map((direction) => [label, direction] as const))
  )("%s with its bond going %s", (label, directionName) => {
    const direction = directions[directionName];
    const molecule = labelled(label, direction);
    const plan = planMoleculeAtomLabels(molecule).find((candidate) => candidate.atom.id === "L")!;
    // Display only: the planned atom is the stored one, label and all.
    expect(plan.atom).toBe(molecule.atoms[0]);
    expect(plan.atom.element).toBe(label);

    const box = {
      x: plan.anchorOffset.x + plan.layout.bounds.x,
      y: plan.anchorOffset.y + plan.layout.bounds.y,
      width: plan.layout.bounds.width,
      height: plan.layout.bounds.height
    };
    const bondLine = planPageSvgRender({ ...createEmptyDocument({ now: "2026-10-10T00:00:00.000Z" }).pages[0]!, objects: [molecule] })
      .fragments.flatMap(elementFragments)
      .find((fragment) => String(fragment.attrs.class).includes("native-bond-line") && fragment.attrs["data-bond-id"] === "b1")!;
    const ends = [
      { x: Number(bondLine.attrs.x1), y: Number(bondLine.attrs.y1) },
      { x: Number(bondLine.attrs.x2), y: Number(bondLine.attrs.y2) }
    ];
    const bondEnd = Math.min(...ends.map((end) => Math.hypot(end.x - 300, end.y - 300)));
    const reach = boxReach(box, direction);
    // The bond stops at or past the label's edge: never drawn into the text.
    expect(bondEnd).toBeGreaterThanOrEqual(reach - 0.001);

    // The character on the atom spans x = 0: the O of OMe, the C of CO2Me, the N of NHBoc, and the
    // bond-end letter of Ph and TMS. (The centred layout put the middle of the whole label there.)
    const fontSize = drawingStyle.atomLabelFontSizePx;
    const glyph = fontSize * 0.62;
    const anchorSide = plan.labelAnchor?.side;
    expect(anchorSide).toBe(directionName === "right" ? "end" : "start");
    const anchorRun = anchorSide === "end" ? plan.layout.runs.filter((run) => run.script === "normal").at(-1)! : plan.layout.runs[0]!;
    const glyphLeft = anchorRun.textAnchor === "end"
      ? anchorRun.x - glyph
      : anchorRun.textAnchor === "middle" ? anchorRun.x - (anchorRun.text.length * glyph) / 2 : anchorRun.x;
    expect(glyphLeft).toBeLessThanOrEqual(0);
    expect(glyphLeft + glyph).toBeGreaterThanOrEqual(0);

    // And the bond reaches the label at least as far as the centred label let it: much farther along
    // a horizontal bond (36.4 px → 7.4 px for CO2Me with its bond on the right), the same up or down.
    const centredReach = boxReach(atomLabelLayout(label, drawingStyle).bounds, direction);
    expect(bondEnd).toBeLessThanOrEqual(
      Math.max(centredReach, drawingStyle.atomLabelBondClearancePx, drawingStyle.bondMarginWidthPx) + 0.001
    );
  });
});

describe("a cyano label recorded with its bond on the left, drawn with it on the right", () => {
  it.each([
    // [label, drawn text]: the C (or the head carrying it) meets the bond at the label's right end.
    ["CN", "NC"],
    ["SCN", "NCS"],
    ["OCN", "NCO"]
  ] as const)("%s is drawn %s, its attachment on the atom", (label, text) => {
    expect(nativeGroupLabelDisplay(label, "right", "left")).toEqual({ text, anchor: { side: "end", length: 1 } });
  });

  it.each(["CH2CN", "NMeCN"])("%s has no unambiguous turned text, so it is not drawn as a group", label => {
    expect(nativeGroupLabelDisplay(label, "right", "left")).toBeUndefined();
  });

  it("reads with the drawn side when no reading side is given, as before", () => {
    expect(nativeGroupLabelDisplay("CN", "right")).toBeUndefined();
    expect(nativeGroupLabelDisplay("CN", "left", "left")).toEqual({ text: "CN", anchor: { side: "start", length: 1 } });
  });

  const atoms = (record?: MoleculeAtom["labelBondSide"]): MoleculeAtom[] => [
    { id: "label", element: "CN", x: 0, y: 0, formalCharge: 0, labelLiteral: true, ...(record ? { labelBondSide: record } : {}) },
    { id: "ring", element: "C", x: 30, y: 0, formalCharge: 0 }
  ];
  const bonds = [{ id: "b", fromAtomId: "ring", toAtomId: "label", order: "single" as const }];

  it("draws a recorded-left CN whose bond lies on its right as NC", () => {
    const molecule = atoms({ side: "left", atomId: "ring" });
    expect(atomDisplayLabelPlacement(molecule[0]!, bonds, undefined, molecule)).toEqual({
      label: "NC", anchor: { side: "end", length: 1 }
    });
  });

  it("ignores a record for another atom and reads the drawn side, as the chemistry does", () => {
    const molecule = atoms({ side: "left", atomId: "elsewhere" });
    expect(atomDisplayLabelPlacement(molecule[0]!, bonds, undefined, molecule)).toEqual({ label: "CN" });
  });
});
