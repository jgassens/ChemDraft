// RC7 hands-on (Windows, 125%): typing N+ on an ethane end carbon drew the red valence badge
// ("N has 1 of 4 bonds.") exactly over the "+". The badge now sits clear of the atom's whole label,
// its charge glyph included, and of a floating charge mark, as the canvas renders it; it is still
// canvas chrome that no export draws.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
import { exportDocumentToSvg } from "@chemdraft/export-engine";
import { atomProblemBadgeRadiusPx, inverseTransformPointForObject, moleculeLayoutLabelBoxes, planMoleculeAtomLabels } from "@chemdraft/layout-engine";
import {
  applyChargeToolAtNativeAtom,
  applySingleBondToolAtPoint,
  commitNativeAtomLabelTarget,
  createPhase4Document,
  insertNativeSingleBondMolecule,
  nativeAtomHitRadiusPx,
  nativeMoleculeInvalidAtomStates,
  reconcileNativeChargeMarks
} from "./documentWorkflow";
import { MainWindow } from "./MainWindow";

type Box = { x: number; y: number; width: number; height: number };
const intersects = (a: Box, b: Box) => Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x)
  && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);

function molecule(document: ChemDraftDocument): MoleculeObject {
  const object = document.pages[0]!.objects.find((candidate): candidate is MoleculeObject => candidate.type === "molecule");
  if (!object) throw new Error("Expected a molecule.");
  return object;
}

function ethane(): ChemDraftDocument {
  return insertNativeSingleBondMolecule(createPhase4Document("Badge placement"), { x: 300, y: 300 });
}

/** Type `label` on the ethane's end carbon, the way the label editor commits it. */
function typeOnEnd(document: ChemDraftDocument, label: string): ChemDraftDocument {
  const object = molecule(document);
  const end = object.atoms[object.atoms.length - 1]!;
  return commitNativeAtomLabelTarget(document, { kind: "atom", objectId: object.id, atomId: end.id, distanceToPointer: 0 } as never,
    label, { literal: true, replaceElement: true }).document;
}

/** Every rendered badge's drawn box (ring plus half its 1.5 px stroke), in the molecule's frame. */
function renderedBadges(document: ChemDraftDocument): Map<string, Box> {
  const object = molecule(document);
  const markup = renderToStaticMarkup(createElement(MainWindow, { initialDocument: document, initialPaletteMode: "hidden", nativePalette: true }));
  const badges = new Map<string, Box>();
  for (const match of markup.matchAll(/<g class="native-atom-invalid-marker"[^>]*data-invalid-atom-id="([^"]+)"[\s\S]*?<circle class="native-atom-invalid-ring" cx="([^"]+)" cy="([^"]+)" r="([^"]+)"/g)) {
    const half = Number(match[4]) + 0.75;
    badges.set(match[1]!, { x: Number(match[2]) + object.x - half, y: Number(match[3]) + object.y - half, width: half * 2, height: half * 2 });
  }
  return badges;
}

function labelBox(object: MoleculeObject, atomId: string): Box | undefined {
  const index = object.atoms.findIndex(atom => atom.id === atomId);
  return moleculeLayoutLabelBoxes(object).find(box => box.atom === index);
}

describe("atom problem badge placement", () => {
  it.each([
    ["N+", "N+"],
    ["O-", "O-"],
    ["NH3+", undefined]
  ])("typed %s on an ethane end: the badge clears the label and its charge", (typed, drawn) => {
    const document = typeOnEnd(ethane(), typed);
    const object = molecule(document);
    const end = object.atoms[object.atoms.length - 1]!;
    const plan = planMoleculeAtomLabels(object).find(candidate => candidate.atom.id === end.id)!;
    if (drawn) expect(plan.label).toBe(drawn);
    expect(plan.layout.runs.some(run => run.script === "superscript" && /[+\u2212-]/.test(run.text))).toBe(true);
    const invalid = nativeMoleculeInvalidAtomStates(object).filter(state => !state.warningSuppressed).map(state => state.atomId);
    const badges = renderedBadges(document);
    expect([...badges.keys()]).toEqual(invalid);
    const label = labelBox(object, end.id)!;
    for (const [atomId, badge] of badges) {
      const ownLabel = labelBox(object, atomId);
      if (ownLabel) expect(intersects(badge, ownLabel)).toBe(false);
      expect(intersects(badge, label)).toBe(false);
    }
    if (typed === "N+") {
      // The report's case: "N has 1 of 4 bonds." is badged, and the old (+9, -9) spot covered the "+".
      expect(badges.has(end.id)).toBe(true);
      const half = atomProblemBadgeRadiusPx + 0.75;
      expect(intersects({ x: end.x + 9 - half, y: end.y - 9 - half, width: half * 2, height: half * 2 }, label)).toBe(true);
    }
  });

  it("a charge mark on an over-bonded carbon: the badge clears the mark and the carbon's label", () => {
    const grow = (document: ChemDraftDocument, angleDegrees: number) => {
      const atom = molecule(document).atoms.find(candidate => candidate.id === "atom_001")!;
      const steer = nativeAtomHitRadiusPx * 0.65;
      return applySingleBondToolAtPoint(document, {
        x: atom.x + Math.cos(angleDegrees * Math.PI / 180) * steer,
        y: atom.y + Math.sin(angleDegrees * Math.PI / 180) * steer
      });
    };
    // Four bonds on atom_001, then a ⊕ from the charge tool: "C has 4 of 3 bonds."
    const fourBonds = [-120, 120, 180].reduce(grow, ethane());
    const object = molecule(fourBonds);
    const charged = reconcileNativeChargeMarks(applyChargeToolAtNativeAtom(fourBonds, 1, { kind: "atom", objectId: object.id, atomId: "atom_001", distanceToPointer: 0 } as never));
    const chargedMolecule = molecule(charged);
    const mark = charged.pages[0]!.objects.find(candidate => candidate.type === "electron-mark")!;
    expect(mark).toBeDefined();
    const carbon = chargedMolecule.atoms.find(atom => atom.id === "atom_001")!;
    expect(carbon.formalCharge).toBe(1);
    expect(carbon.markCharge).toBe(1);
    const badges = renderedBadges(charged);
    const badge = badges.get("atom_001")!;
    expect(badge).toBeDefined();
    const markCentre = inverseTransformPointForObject(chargedMolecule, { x: mark.x + mark.width / 2, y: mark.y + mark.height / 2 });
    expect(intersects(badge, { x: markCentre.x - mark.width / 2, y: markCentre.y - mark.height / 2, width: mark.width, height: mark.height })).toBe(false);
    const ownLabel = labelBox(chargedMolecule, "atom_001");
    if (ownLabel) expect(intersects(badge, ownLabel)).toBe(false);
  });

  it("no export draws the badge", () => {
    const document = typeOnEnd(ethane(), "N+");
    expect(renderedBadges(document).size).toBeGreaterThan(0);
    const svg = exportDocumentToSvg(document).contents;
    expect(svg).not.toContain("native-atom-invalid");
    expect(svg).not.toContain("data-invalid-atom-id");
  });
});
