// A group label meets its bond at the atom it bonds to (PLANS.md, label anchoring): "OMe" with its
// O on the atom, drawn "MeO" with the bond on its right. Display only: the stored label is never
// touched. The stress cases below check, for each label and bond direction, what is drawn, which
// character sits on the atom, and where the bond stops against the label's box, against the old
// centred layout. (The numbers are in PR #97's body.)

import { describe, expect, it } from "vitest";
import {
  ChemDraftSyntheticStylePreset,
  createEmptyDocument,
  nativeDrawingStyleFromObjectStyle,
  stylePresetToObjectStyle,
  type MoleculeAtom,
  type MoleculeObject
} from "@chemdraft/chem-core";

import {
  atomLabelLayout,
  nativeGroupLabelDisplay,
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
