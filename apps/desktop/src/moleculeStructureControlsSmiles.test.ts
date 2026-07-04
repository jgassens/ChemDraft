import { beforeAll, describe, expect, it } from "vitest";
import {
  createEmptyDocument,
  stylePresetToObjectStyle,
  ChemDraftSyntheticStylePreset,
  type ChemDraftDocument,
  type MoleculeAtom,
  type MoleculeBond,
  type MoleculeObject
} from "@chemdraft/chem-core";
import { depictSmiles2D, ensureOclResources, type Depiction2D } from "@chemdraft/ocl-adapter";
import { planPageSvgRender, type PageSvgElementFragment, type PageSvgFragment } from "@chemdraft/layout-engine";

import {
  applyMoleculeTargetBondLength,
  createPhase4Document,
  insertSmilesMolecule,
  previewNativeMoleculeBondGrowth,
  type PastedStructureDepiction
} from "./documentWorkflow";

const USER_SMILES = [
  "C[C@@H]1C[C@H]2[C@@H](C[C@]3([C@H](O2)C[C@H]4[C@H](O3)C(=CC(=O)O4)C)C)O[C@@H]5[C@@H]1O[C@H]6C[C@@H]7[C@](C[C@@H]8[C@@](O7)(C/C=C\\[C@@H]9[C@@H](O8)C[C@@H]1[C@@H](O9)C[C@@H]2[C@@](O1)([C@H](C[C@H](O2)CC(=C)C=O)O)C)C)(O[C@@]6(CC5)C)C",
  "CC1=C2[C@H](C(=O)[C@@]3([C@H](C[C@@H]4[C@]([C@H]3[C@@H]([C@@](C2(C)C)(C[C@@H]1OC(=O)[C@@H]([C@H](C5=CC=CC=C5)NC(=O)C6=CC=CC=C6)O)O)OC(=O)C7=CC=CC=C7)(CO4)OC(=O)C)O)C)OC(=O)C"
] as const;

function toPasted(depiction: Depiction2D): PastedStructureDepiction {
  return {
    atoms: depiction.atoms.map((atom) => ({ element: atom.element, x: atom.x, y: atom.y, charge: atom.charge })),
    bonds: depiction.bonds.map((bond) => ({
      from: bond.from,
      to: bond.to,
      order: bond.order === "aromatic" || bond.order === "unknown" ? "single" : bond.order,
      wedge: bond.wedge
    }))
  };
}

function pasteSmilesDocument(smiles: string): { document: ChemDraftDocument; molecule: MoleculeObject } {
  const document = insertSmilesMolecule(
    createPhase4Document("Structure controls stress"),
    { x: 240, y: 260 },
    toPasted(depictSmiles2D(smiles)),
    smiles
  );
  const molecule = document.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule");
  if (!molecule) {
    throw new Error("Expected pasted molecule.");
  }
  return { document, molecule };
}

function pageFragments(molecule: MoleculeObject): PageSvgElementFragment[] {
  const page = createEmptyDocument({ now: "2026-06-24T00:00:00.000Z" }).pages[0];
  return planPageSvgRender({ ...page, objects: [molecule] }).fragments.flatMap(elementFragments);
}

function elementFragments(fragment: PageSvgFragment): PageSvgElementFragment[] {
  if (fragment.kind === "text") {
    return [];
  }
  return [fragment, ...fragment.children.flatMap(elementFragments)];
}

function styledMolecule(molecule: MoleculeObject, style: Record<string, unknown>): MoleculeObject {
  return {
    ...molecule,
    style: {
      ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
      ...molecule.style,
      ...style
    }
  };
}

function withBondDisplay(
  molecule: MoleculeObject,
  bondId: string,
  bondStyle: NonNullable<NonNullable<MoleculeBond["display"]>["bondStyle"]>
): MoleculeObject {
  return {
    ...molecule,
    bonds: molecule.bonds.map((bond) =>
      bond.id === bondId
        ? { ...bond, display: { ...(bond.display ?? {}), bondStyle } }
        : bond
    )
  };
}

function bondLines(molecule: MoleculeObject, bondId: string): PageSvgElementFragment[] {
  return pageFragments(molecule).filter((fragment) =>
    String(fragment.attrs.class).includes("native-bond-line") &&
    fragment.attrs["data-bond-id"] === bondId
  );
}

function lineLength(fragment: PageSvgElementFragment): number {
  return Math.hypot(
    Number(fragment.attrs.x2) - Number(fragment.attrs.x1),
    Number(fragment.attrs.y2) - Number(fragment.attrs.y1)
  );
}

function midpoint(fragment: PageSvgElementFragment): { x: number; y: number } {
  return {
    x: (Number(fragment.attrs.x1) + Number(fragment.attrs.x2)) / 2,
    y: (Number(fragment.attrs.y1) + Number(fragment.attrs.y2)) / 2
  };
}

function midpointDistance(left: PageSvgElementFragment, right: PageSvgElementFragment): number {
  const a = midpoint(left);
  const b = midpoint(right);
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function medianBondLength(molecule: MoleculeObject): number {
  const atomById = new Map(molecule.atoms.map((atom) => [atom.id, atom]));
  const lengths = molecule.bonds
    .map((bond) => {
      const from = atomById.get(bond.fromAtomId);
      const to = atomById.get(bond.toAtomId);
      return from && to ? Math.hypot(to.x - from.x, to.y - from.y) : undefined;
    })
    .filter((value): value is number => value !== undefined && Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  return lengths[Math.floor(lengths.length / 2)] ?? 0;
}

function firstBond(molecule: MoleculeObject): MoleculeBond {
  const bond = molecule.bonds[0];
  if (!bond) {
    throw new Error("Expected at least one bond.");
  }
  return bond;
}

function firstPlainBond(molecule: MoleculeObject): MoleculeBond {
  const bond = molecule.bonds.find((candidate) => !candidate.display?.bondStyle) ?? molecule.bonds[0];
  if (!bond) {
    throw new Error("Expected at least one bond.");
  }
  return bond;
}

function firstCarbonDoubleBond(molecule: MoleculeObject): MoleculeBond {
  const atomById = new Map(molecule.atoms.map((atom) => [atom.id, atom]));
  const bond = molecule.bonds.find((candidate) => {
    const from = atomById.get(candidate.fromAtomId);
    const to = atomById.get(candidate.toAtomId);
    return candidate.order === "double" && from?.element === "C" && to?.element === "C";
  }) ?? molecule.bonds.find((candidate) => candidate.order === "double");
  if (!bond) {
    throw new Error("Expected a double bond in the stress molecule.");
  }
  return bond;
}

function firstSingleHeteroBond(molecule: MoleculeObject): MoleculeBond {
  const atomById = new Map(molecule.atoms.map((atom) => [atom.id, atom]));
  const bond = molecule.bonds.find((candidate) => {
    const from = atomById.get(candidate.fromAtomId);
    const to = atomById.get(candidate.toAtomId);
    return candidate.order === "single" &&
      !candidate.display?.bondStyle &&
      from &&
      to &&
      (from.element !== "C" || to.element !== "C");
  });
  if (!bond) {
    throw new Error("Expected a single bond adjacent to a heteroatom.");
  }
  return bond;
}

function firstTerminalAtom(molecule: MoleculeObject): MoleculeAtom {
  const degree = new Map<string, number>();
  for (const bond of molecule.bonds) {
    degree.set(bond.fromAtomId, (degree.get(bond.fromAtomId) ?? 0) + 1);
    degree.set(bond.toAtomId, (degree.get(bond.toAtomId) ?? 0) + 1);
  }
  const atom = molecule.atoms.find((candidate) => (degree.get(candidate.id) ?? 0) === 1);
  if (!atom) {
    throw new Error("Expected a terminal atom.");
  }
  return atom;
}

function forceCrossing(molecule: MoleculeObject): { molecule: MoleculeObject; backBondId: string; frontBondId: string } {
  const pair = molecule.bonds.flatMap((left, leftIndex) =>
    molecule.bonds.slice(leftIndex + 1).map((right) => [left, right] as const)
  ).find(([left, right]) => {
    const ids = new Set([left.fromAtomId, left.toAtomId, right.fromAtomId, right.toAtomId]);
    return ids.size === 4;
  });
  if (!pair) {
    throw new Error("Expected two disjoint bonds.");
  }

  const [backBond, frontBond] = pair;
  const positions = new Map<string, { x: number; y: number }>([
    [backBond.fromAtomId, { x: 120, y: 120 }],
    [backBond.toAtomId, { x: 220, y: 220 }],
    [frontBond.fromAtomId, { x: 120, y: 220 }],
    [frontBond.toAtomId, { x: 220, y: 120 }]
  ]);

  return {
    molecule: {
      ...molecule,
      atoms: molecule.atoms.map((atom) => positions.has(atom.id) ? { ...atom, ...positions.get(atom.id)! } : atom)
    },
    backBondId: backBond.id,
    frontBondId: frontBond.id
  };
}

function textFor(fragment: PageSvgElementFragment): string {
  return fragment.children.map((child) => child.kind === "text" ? child.text : "").join("");
}

beforeAll(async () => {
  await ensureOclResources();
});

describe("Structure controls on the user's two SMILES", () => {
  it.each(USER_SMILES)("wires every Structure control to real behavior for %#", (smiles) => {
    const { document, molecule } = pasteSmilesDocument(smiles);
    expect(molecule.atoms.length).toBeGreaterThan(20);
    expect(molecule.bonds.length).toBeGreaterThan(20);

    const scaledDocument = applyMoleculeTargetBondLength(document, [molecule.id], 36);
    const scaled = scaledDocument.pages[0].objects.find((object): object is MoleculeObject => object.id === molecule.id && object.type === "molecule");
    if (!scaled) {
      throw new Error("Expected scaled molecule.");
    }
    expect(medianBondLength(scaled)).toBeCloseTo(36, 1);
    expect(scaled.style.bondLengthPx).toBe(36);

    const terminal = firstTerminalAtom(molecule);
    const chain90 = previewNativeMoleculeBondGrowth(
      styledMolecule(molecule, { chainAngleDegrees: 90 }),
      terminal,
      816,
      1056
    );
    const chain120 = previewNativeMoleculeBondGrowth(
      styledMolecule(molecule, { chainAngleDegrees: 120 }),
      terminal,
      816,
      1056
    );
    expect(chain90?.candidateDirections[1]).not.toEqual(chain120?.candidateDirections[1]);

    const normalBond = firstPlainBond(molecule);
    const lineWidthLine = bondLines(styledMolecule(molecule, { bondStrokeWidthPx: 5.5 }), normalBond.id)
      .find((fragment) => String(fragment.attrs.class).includes("native-bond-line"));
    expect(lineWidthLine?.attrs["stroke-width"]).toBe(5.5);
    expect(lineWidthLine?.attrs.stroke).toBe("#000000");

    const coloredLine = bondLines(styledMolecule(molecule, { bondColor: "#d02626" }), normalBond.id)[0];
    expect(coloredLine?.attrs.stroke).toBe("#d02626");

    const roundCapLine = bondLines(styledMolecule(molecule, { bondLineCap: "round" }), normalBond.id)[0];
    expect(roundCapLine?.attrs["stroke-linecap"]).toBe("round");

    const boldMolecule = withBondDisplay(styledMolecule(molecule, { bondBoldWidthPx: 9 }), normalBond.id, "bold");
    const boldLine = bondLines(boldMolecule, normalBond.id)[0];
    expect(boldLine?.attrs["stroke-width"]).toBe(9);

    const doubleBond = firstCarbonDoubleBond(molecule);
    const percentLines = bondLines(styledMolecule(molecule, {
      bondLengthPx: 40,
      bondSpacingMode: "percent",
      bondSpacingPercent: 50
    }), doubleBond.id);
    expect(percentLines).toHaveLength(2);
    expect(midpointDistance(percentLines[0]!, percentLines[1]!)).toBeCloseTo(20, 1);

    const absoluteLines = bondLines(styledMolecule(molecule, {
      bondSpacingMode: "absolute",
      multipleBondGapPx: 13
    }), doubleBond.id);
    expect(absoluteLines).toHaveLength(2);
    expect(midpointDistance(absoluteLines[0]!, absoluteLines[1]!)).toBeCloseTo(13, 1);

    const insetLines = bondLines(styledMolecule(molecule, {
      bondSpacingMode: "absolute",
      doubleBondInsetPx: 12
    }), doubleBond.id);
    const primary = insetLines.find((fragment) => fragment.attrs["data-bond-segment"] === "primary");
    const secondary = insetLines.find((fragment) => fragment.attrs["data-bond-segment"] === "secondary");
    expect(primary && secondary ? lineLength(primary) - lineLength(secondary) : 0).toBeGreaterThan(4);

    const heteroBond = firstSingleHeteroBond(molecule);
    const lowMarginLength = lineLength(bondLines(styledMolecule(molecule, {
      atomLabelBondClearancePx: 0,
      bondMarginWidthPx: 0
    }), heteroBond.id)[0]!);
    const highMarginLength = lineLength(bondLines(styledMolecule(molecule, {
      atomLabelBondClearancePx: 0,
      bondMarginWidthPx: 24
    }), heteroBond.id)[0]!);
    expect(highMarginLength).toBeLessThan(lowMarginLength);

    const hashed = withBondDisplay(styledMolecule(molecule, { bondHashSpacingPx: 4 }), normalBond.id, "hashed");
    const hashMarks = pageFragments(hashed).filter((fragment) => fragment.attrs.class === "native-bond-hash");
    expect(hashMarks.length).toBeGreaterThan(10);

    const crossingFixture = forceCrossing(molecule);
    const lowClearance = planPageSvgRender({
      ...createEmptyDocument({ now: "2026-06-24T00:00:00.000Z" }).pages[0],
      objects: [styledMolecule(crossingFixture.molecule, { bondOverlapClearancePx: 4 })]
    }).crossings[0]?.clearancePx;
    const highClearance = planPageSvgRender({
      ...createEmptyDocument({ now: "2026-06-24T00:00:00.000Z" }).pages[0],
      objects: [styledMolecule(crossingFixture.molecule, { bondOverlapClearancePx: 24 })]
    }).crossings[0]?.clearancePx;
    expect(lowClearance).toBe(7);
    expect(highClearance ?? 0).toBeGreaterThan((lowClearance ?? 0) + 10);

    const atomNumbered = pageFragments(styledMolecule(molecule, { atomIndicatorShowAtomNumbers: true }))
      .filter((fragment) => fragment.attrs["data-atom-indicator"] === "number");
    expect(atomNumbered).toHaveLength(molecule.atoms.length);

    const atomStereo = pageFragments(styledMolecule(molecule, { atomIndicatorShowStereochemistry: true }))
      .filter((fragment) => fragment.attrs["data-atom-indicator"] === "stereochemistry");
    const atomEnhanced = pageFragments(styledMolecule(molecule, { atomIndicatorShowEnhancedStereochemistry: true }))
      .filter((fragment) => fragment.attrs["data-atom-indicator"] === "enhanced-stereochemistry");
    const bondStereo = pageFragments(styledMolecule(molecule, { bondIndicatorShowStereochemistry: true }))
      .filter((fragment) => fragment.attrs["data-bond-indicator"] === "stereochemistry");
    expect(atomStereo.length).toBeGreaterThan(0);
    expect(atomEnhanced.map(textFor)).toContain("ABS");
    expect(bondStereo.length).toBeGreaterThan(0);

    const ordinaryIndicators = pageFragments(styledMolecule(molecule, {
      atomIndicatorShowQuery: true,
      bondIndicatorShowQuery: true,
      bondIndicatorShowReaction: true
    }));
    expect(ordinaryIndicators.some((fragment) => fragment.attrs["data-atom-indicator"] === "query")).toBe(false);
    expect(ordinaryIndicators.some((fragment) => fragment.attrs["data-bond-indicator"] === "query")).toBe(false);
    expect(ordinaryIndicators.some((fragment) => fragment.attrs["data-bond-indicator"] === "reaction")).toBe(false);

    const metadataMarked = styledMolecule({
      ...molecule,
      compatibility: {
        ...(molecule.compatibility ?? { warnings: [] }),
        unknown: {
          ...(molecule.compatibility?.unknown ?? {}),
          atomQueryIds: [molecule.atoms[0]!.id],
          bondQueryIds: [molecule.bonds[0]!.id],
          reactionBondIds: [molecule.bonds[1]!.id]
        }
      }
    }, {
      atomIndicatorShowQuery: true,
      bondIndicatorShowQuery: true,
      bondIndicatorShowReaction: true
    });
    const metadataIndicators = pageFragments(metadataMarked);
    expect(metadataIndicators.some((fragment) => fragment.attrs["data-atom-indicator"] === "query")).toBe(true);
    expect(metadataIndicators.some((fragment) => fragment.attrs["data-bond-indicator"] === "query")).toBe(true);
    expect(metadataIndicators.some((fragment) => fragment.attrs["data-bond-indicator"] === "reaction")).toBe(true);
  });
});
