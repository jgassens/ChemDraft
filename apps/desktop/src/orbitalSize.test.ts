import { describe, expect, it } from "vitest";
import { applyPatches, type ChemDraftDocument, type GraphicObject, type MoleculeObject } from "@chemdraft/chem-core";
import { exportDocumentToCdxml, exportDocumentToSvg } from "@chemdraft/export-engine";
import {
  createNativeArtGraphicObject,
  createNativeSavePayload,
  createPhase4Document,
  insertNativeArtGraphicObject,
  insertNativeSingleBondMolecule,
  nativeArtToolForCommand,
  nativeOrbitalAnchorPoint,
  openNativeDocument
} from "./documentWorkflow";
import { ORBITAL_LOBE_LENGTH_IN_BOND_LENGTHS } from "./orbitalSize";

type Point = { x: number; y: number };
type PathNode = { point: Point; inControl?: Point; outControl?: Point };

const orbitalTools = ["tool.lobe", "tool.shadedLobe", "tool.pOrbital", "tool.sOrbital"] as const;
const bondLengths = [22, 36] as const;

function documentWithBondLength(bondLengthPx: number): ChemDraftDocument {
  const document = createPhase4Document(`Orbitals at ${bondLengthPx}`);
  return { ...document, styles: { ...document.styles, drawing: { bondLengthPx } } };
}

function withBond(bondLengthPx: number): { document: ChemDraftDocument; molecule: MoleculeObject } {
  const document = insertNativeSingleBondMolecule(documentWithBondLength(bondLengthPx), { x: 300, y: 300 });
  const molecule = document.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule")!;
  return { document, molecule };
}

function measuredBondLength(molecule: MoleculeObject): number {
  const [a, b] = molecule.atoms;
  return Math.hypot(a!.x - b!.x, a!.y - b!.y);
}

/** Dense sampling, independent of the exact-extreme helper in orbitalSize.ts. */
function sampledOutlineYRange(nodes: readonly PathNode[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  nodes.forEach((node, index) => {
    const next = nodes[(index + 1) % nodes.length]!;
    const p = [node.point.y, (node.outControl ?? node.point).y, (next.inControl ?? next.point).y, next.point.y];
    for (let step = 0; step <= 2000; step += 1) {
      const t = step / 2000;
      const u = 1 - t;
      const y = u * u * u * p[0]! + 3 * u * u * t * p[1]! + 3 * u * t * t * p[2]! + t * t * t * p[3]!;
      min = Math.min(min, y);
      max = Math.max(max, y);
    }
  });
  return { min, max };
}

/** Nucleus to the far end of one drawn lobe along the (unrotated) axis; an s orbital's diameter. */
function drawnLobeLength(object: GraphicObject): number {
  if (object.graphicKind === "ellipse") {
    expect(object.width).toBeCloseTo(object.height, 9);
    return object.width;
  }
  const { min, max } = sampledOutlineYRange(object.data.pathNodes ?? []);
  if (object.data.artToolId === "pOrbital") {
    const nucleusY = object.y + object.height / 2;
    expect(nucleusY - min).toBeCloseTo(max - nucleusY, 4);
    return nucleusY - min;
  }
  return object.y + object.height - min;
}

describe("orbital size follows the document bond length", () => {
  it("has one tunable constant: one lobe is 0.8 bond lengths", () => {
    expect(ORBITAL_LOBE_LENGTH_IN_BOND_LENGTHS).toBe(0.8);
  });

  it.each(bondLengths)("places a p orbital on an atom with lobe length 0.8 L at L = %d", (bondLengthPx) => {
    const { document, molecule } = withBond(bondLengthPx);
    expect(measuredBondLength(molecule)).toBeCloseTo(bondLengthPx, 6);
    const atom = molecule.atoms[0]!;
    const placed = insertNativeArtGraphicObject(document, atom, "tool.pOrbital");
    const orbital = placed.pages[0].objects.find((object): object is GraphicObject => object.type === "graphic")!;

    expect(drawnLobeLength(orbital)).toBeCloseTo(0.8 * bondLengthPx, 3);
    const { min, max } = sampledOutlineYRange(orbital.data.pathNodes ?? []);
    expect(max - min).toBeCloseTo(1.6 * bondLengthPx, 3);
    // Still centred on the atom, and the molecule is untouched.
    expect(nativeOrbitalAnchorPoint(orbital)!.x).toBeCloseTo(atom.x, 7);
    expect(nativeOrbitalAnchorPoint(orbital)!.y).toBeCloseTo(atom.y, 7);
    expect(placed.pages[0].objects.find((object) => object.id === molecule.id)).toEqual(molecule);
  });

  it.each(orbitalTools)("scales %s with the bond length, keeping its proportions", (commandId) => {
    const definition = nativeArtToolForCommand(commandId)!;
    const [small, large] = bondLengths.map((bondLengthPx) => {
      const object = createNativeArtGraphicObject(documentWithBondLength(bondLengthPx), { x: 300, y: 300 }, commandId)!;
      expect(drawnLobeLength(object)).toBeCloseTo(0.8 * bondLengthPx, 3);
      expect(object.width / object.height).toBeCloseTo(definition.width / definition.height, 9);
      return object;
    });
    expect(large!.width / small!.width).toBeCloseTo(bondLengths[1] / bondLengths[0], 9);
    expect(large!.height / small!.height).toBeCloseTo(bondLengths[1] / bondLengths[0], 9);
  });

  it("makes an s orbital's diameter equal one p lobe's length", () => {
    for (const bondLengthPx of bondLengths) {
      const document = documentWithBondLength(bondLengthPx);
      const s = createNativeArtGraphicObject(document, { x: 200, y: 200 }, "tool.sOrbital")!;
      const p = createNativeArtGraphicObject(document, { x: 300, y: 300 }, "tool.pOrbital")!;
      expect(s.width).toBeCloseTo(drawnLobeLength(p), 3);
    }
  });

  it("keeps single lobes tip-on-atom and s orbitals centred at every bond length", () => {
    for (const bondLengthPx of bondLengths) {
      const { document, molecule } = withBond(bondLengthPx);
      const atom = molecule.atoms[0]!;
      for (const commandId of orbitalTools) {
        const object = createNativeArtGraphicObject(document, atom, commandId)!;
        expect(nativeOrbitalAnchorPoint(object)!.x).toBeCloseTo(atom.x, 7);
        expect(nativeOrbitalAnchorPoint(object)!.y).toBeCloseTo(atom.y, 7);
      }
    }
  });

  it("still places every orbital on empty canvas", () => {
    for (const commandId of orbitalTools) {
      const placed = insertNativeArtGraphicObject(documentWithBondLength(22), { x: 400, y: 320 }, commandId);
      const object = placed.pages[0].objects.find((candidate): candidate is GraphicObject => candidate.type === "graphic")!;
      expect(placed.selection.objectIds).toEqual([object.id]);
      expect(drawnLobeLength(object)).toBeCloseTo(17.6, 3);
    }
  });

  it("does not resize orbitals already saved in a document when it is opened", () => {
    // Orbitals at the pre-1.2.3 fixed size (the tool's design units), as earlier builds saved them.
    let document = documentWithBondLength(30);
    for (const [index, commandId] of orbitalTools.entries()) {
      const tool = nativeArtToolForCommand(commandId)!;
      const x = 100 + index * 80;
      const y = 100;
      const offset = (point: Point) => ({ x: point.x + x, y: point.y + y });
      const legacy: GraphicObject = {
        id: `legacy_${tool.id}`,
        type: "graphic",
        x,
        y,
        width: tool.width,
        height: tool.height,
        rotation: 15,
        style: { ...tool.style, source: "chemdraft-native-art", artToolCommandId: tool.commandId },
        compatibility: { sourceFormat: "chemdraft-native", warnings: [], unknown: {} },
        graphicKind: tool.graphicKind,
        data: {
          ...tool.data,
          ...(tool.data.pathNodes ? {
            pathNodes: tool.data.pathNodes.map((node) => ({
              point: offset(node.point),
              ...(node.inControl ? { inControl: offset(node.inControl) } : {}),
              ...(node.outControl ? { outControl: offset(node.outControl) } : {})
            }))
          } : {}),
          artToolId: tool.id
        }
      };
      document = applyPatches(document, [{ op: "addObject", pageId: document.pages[0].id, object: legacy }]);
    }
    const saved = createNativeSavePayload(document).contents;
    const opened = openNativeDocument(saved).document!;

    expect(opened).toEqual(document);
    expect(createNativeSavePayload(opened).contents).toBe(saved);
    const sizes = opened.pages[0].objects.map((object) => [object.id, object.width, object.height]);
    expect(sizes).toEqual([
      ["legacy_lobe", 40, 60],
      ["legacy_shadedLobe", 40, 60],
      ["legacy_pOrbital", 40, 120],
      ["legacy_sOrbital", 48, 48]
    ]);
  });

  it("exports a newly placed orbital with the geometry the canvas draws", () => {
    const { document, molecule } = withBond(30);
    let placed = insertNativeArtGraphicObject(document, molecule.atoms[0]!, "tool.pOrbital");
    placed = insertNativeArtGraphicObject(placed, { x: 120, y: 140 }, "tool.sOrbital");
    const [p, s] = placed.pages[0].objects.filter((object): object is GraphicObject => object.type === "graphic");

    // SVG (and PDF, which is rendered from the SVG) draws the stored, scaled outline.
    const svg = exportDocumentToSvg(placed).contents;
    const pathD = svg.match(new RegExp(`<path data-object-id="${p!.id}"[^>]* d="([^"]+)"`))?.[1];
    expect(pathD).toBeDefined();
    const ys = [...pathD!.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0])).filter((_, index) => index % 2 === 1);
    const nodeYs = p!.data.pathNodes!.flatMap((node) => [node.point.y, node.inControl!.y, node.outControl!.y]);
    expect(Math.min(...ys)).toBeCloseTo(Math.min(...nodeYs), 3);
    expect(Math.max(...ys)).toBeCloseTo(Math.max(...nodeYs), 3);
    expect(svg).toContain(`transform="rotate(${Number(p!.rotation.toFixed(3))}`);
    expect(svg).toMatch(new RegExp(`<ellipse data-object-id="${s!.id}"[^>]* cx="120" cy="140"`));

    // CDXML carries the same outline, in points (0.75 per page unit).
    const cdxml = exportDocumentToCdxml(placed).contents;
    const curvePoints = cdxml.match(/<curve [^>]*CurvePoints="([^"]+)"/)?.[1]?.split(" ").map(Number);
    expect(curvePoints).toBeDefined();
    const curveYs = curvePoints!.filter((_, index) => index % 2 === 1);
    expect(Math.max(...curveYs) - Math.min(...curveYs)).toBeCloseTo((Math.max(...nodeYs) - Math.min(...nodeYs)) * 0.75, 2);
    const ovalBox = cdxml.match(/GraphicType="Oval" BoundingBox="([^"]+)"/)?.[1]?.split(" ").map(Number);
    expect(ovalBox![2]! - ovalBox![0]!).toBeCloseTo(s!.width * 0.75, 3);
  });
});
