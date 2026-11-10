import { expect, it } from "vitest";
import { type MoleculeObject, moleculeToMolfileV2000 } from "@chemdraft/chem-core";
import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import { molfileCoordinateScale } from "@chemdraft/layout-engine";
import { createPhase4Document, copyAsMolfile, createNativeMolfileMolecule } from "./documentWorkflow";

function chain(id: string, x: number, lengths: number[]): MoleculeObject {
  let currentX = x;
  return {
    id, type: "molecule", x, y: 100, width: lengths.reduce((a, b) => a + b, 0), height: 0,
    rotation: 0, style: {}, structureFormat: "unknown", structure: "", superatoms: [], rGroups: [],
    atoms: [{ id: "a0", element: "C", x, y: 100, formalCharge: 0 },
      ...lengths.map((length, i) => ({ id: `a${i + 1}`, element: "C", x: currentX += length, y: 100, formalCharge: 0 }))],
    bonds: lengths.map((_, i) => ({ id: `b${i}`, fromAtomId: `a${i}`, toAtomId: `a${i + 1}`, order: "single" }))
  };
}

it.each(["v2000", "v3000"] as const)("Copy As %s applies one scale to a multi-molecule selection", flavor => {
  const document = createPhase4Document("units");
  document.pages[0]!.objects = [chain("first", 100, [22]), chain("second", 320, [44])];
  document.selection.objectIds = ["first", "second"];
  const before = structuredClone(document);
  const graph = parseMolfileGraph(copyAsMolfile(document, flavor)!);
  expect(molfileCoordinateScale(graph.atoms, graph.bonds, 1.5, 22).medianBondLength).toBeCloseTo(1.5, 4);
  expect(graph.atoms[1]!.x - graph.atoms[0]!.x).toBeCloseTo(1, 4);
  expect(graph.atoms[3]!.x - graph.atoms[2]!.x).toBeCloseTo(2, 4);
  expect(graph.atoms[2]!.x - graph.atoms[0]!.x).toBeCloseTo(220 * 1.5 / 33, 3);
  expect(document).toEqual(before);
});

it.each([22, 28, 37])("export and MOL paste restore size at document bond length %s", length => {
  const document = createPhase4Document("round trip");
  document.styles.drawing = { bondLengthPx: length };
  const source = chain("source", 100, [length, length]);
  document.pages[0]!.objects = [source];
  for (const flavor of ["v2000", "v3000"] as const) {
    const contents = copyAsMolfile(document, flavor)!;
    const imported = createNativeMolfileMolecule(document, { x: 300, y: 300 }, contents,
      flavor === "v2000" ? "molfile-v2000" : "molfile-v3000");
    expect(molfileCoordinateScale(imported.atoms, imported.bonds, length, 1.5).medianBondLength).toBeCloseTo(length, 3);
    for (let i = 1; i < source.atoms.length; i++) {
      expect(imported.atoms[i]!.x - imported.atoms[0]!.x).toBeCloseTo(source.atoms[i]!.x - source.atoms[0]!.x, 3);
    }
    expect((imported.atoms[0]!.x + imported.atoms[2]!.x) / 2).toBeCloseTo(300, 3);
  }
});

it("MOL paste uses the median even for legacy drawing units and an outlier bond", () => {
  const document = createPhase4Document("median");
  document.styles.drawing = { bondLengthPx: 28 };
  const raw = moleculeToMolfileV2000(chain("legacy", 100, [22, 22, 220]), { kekuleBondOrders: new Map() }).contents;
  const imported = createNativeMolfileMolecule(document, { x: 300, y: 300 }, raw, "molfile-v2000");
  expect(imported.atoms[1]!.x - imported.atoms[0]!.x).toBeCloseTo(28, 4);
  expect(imported.atoms[3]!.x - imported.atoms[2]!.x).toBeCloseTo(280, 4);
});

it("bondless Copy As and paste use the document nominal bond length", () => {
  const document = createPhase4Document("bondless");
  document.styles.drawing = { bondLengthPx: 28 };
  const source = { ...chain("atoms", 100, [28]), bonds: [] };
  document.pages[0]!.objects = [source];
  const contents = copyAsMolfile(document, "v2000")!;
  const graph = parseMolfileGraph(contents);
  expect(graph.atoms[1]!.x - graph.atoms[0]!.x).toBeCloseTo(1.5, 4);
  const imported = createNativeMolfileMolecule(document, { x: 300, y: 300 }, contents, "molfile-v2000");
  expect(imported.atoms[1]!.x - imported.atoms[0]!.x).toBeCloseTo(28, 3);
});
