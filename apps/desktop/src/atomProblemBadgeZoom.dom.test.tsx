// @vitest-environment jsdom
// RC8 review: the valence badge's ring has a 1.5 px non-scaling stroke, so at 25% its outer edge sits
// 3 page px past the radius. The badge is placed for the view's zoom: the memoized molecule view must
// re-place it when the zoom changes, and at 25%, 100% and 400% the drawn ring clears the label and a
// floating charge mark by the clearance.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
import { atomProblemBadgeKeepOutPx, atomProblemBadgeRadiusPx, inverseTransformPointForObject, moleculeLayoutLabelBoxes } from "@chemdraft/layout-engine";
import { MainWindow } from "./MainWindow";
import {
  applyChargeToolAtNativeAtom,
  applySingleBondToolAtPoint,
  commitNativeAtomLabelTarget,
  createPhase4Document,
  insertNativeSingleBondMolecule,
  nativeAtomHitRadiusPx,
  reconcileNativeChargeMarks
} from "./documentWorkflow";
import { documentZoomCommandId } from "./documentZoom";
import { MemoryStorage } from "./testSupport/memoryStorage";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));

type Box = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  window.history.replaceState(null, "", "/?agentBridge=1");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); delete window.__CHEMDRAFT_AGENT__;
  window.history.replaceState(null, "", "/");
});

function molecule(document: ChemDraftDocument): MoleculeObject {
  return document.pages[0]!.objects.find((candidate): candidate is MoleculeObject => candidate.type === "molecule")!;
}

function ethane(): ChemDraftDocument {
  return insertNativeSingleBondMolecule(createPhase4Document("Badge zoom"), { x: 300, y: 300 });
}

function typedNPlus(): ChemDraftDocument {
  const document = ethane();
  const object = molecule(document);
  const end = object.atoms[object.atoms.length - 1]!;
  return commitNativeAtomLabelTarget(document, { kind: "atom", objectId: object.id, atomId: end.id, distanceToPointer: 0 } as never,
    "N+", { literal: true, replaceElement: true }).document;
}

function chargedCarbon(): ChemDraftDocument {
  const grow = (document: ChemDraftDocument, angleDegrees: number) => {
    const atom = molecule(document).atoms.find(candidate => candidate.id === "atom_001")!;
    const steer = nativeAtomHitRadiusPx * 0.65;
    return applySingleBondToolAtPoint(document, {
      x: atom.x + Math.cos(angleDegrees * Math.PI / 180) * steer,
      y: atom.y + Math.sin(angleDegrees * Math.PI / 180) * steer
    });
  };
  const fourBonds = [-120, 120, 180].reduce(grow, ethane());
  return reconcileNativeChargeMarks(applyChargeToolAtNativeAtom(fourBonds, 1,
    { kind: "atom", objectId: molecule(fourBonds).id, atomId: "atom_001", distanceToPointer: 0 } as never));
}

async function render(initialDocument: ChemDraftDocument) {
  await act(async () => root.render(createElement(MainWindow, { initialDocument, initialActiveToolCommandId: "tool.select",
    initialPaletteMode: "hidden", initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: true })));
}

async function zoomTo(percent: 25 | 100 | 400) {
  await act(async () => { await window.__CHEMDRAFT_AGENT__!.command(documentZoomCommandId(percent)); });
}

/** The rendered badge centre of `atomId`, in the molecule's frame. */
function badgeCentre(object: MoleculeObject, atomId: string): Point {
  const ring = container.querySelector<SVGCircleElement>(
    `.native-atom-invalid-marker[data-invalid-atom-id="${atomId}"] .native-atom-invalid-ring`);
  expect(ring).not.toBeNull();
  expect(Number(ring!.getAttribute("r"))).toBe(atomProblemBadgeRadiusPx);
  return { x: Number(ring!.getAttribute("cx")) + object.x, y: Number(ring!.getAttribute("cy")) + object.y };
}

const gap = (centre: Point, box: Box) => Math.hypot(
  Math.max(box.x - centre.x, 0, centre.x - (box.x + box.width)),
  Math.max(box.y - centre.y, 0, centre.y - (box.y + box.height)));

/** The page-px distance the ring's stroke reaches past the centre at `zoom`. */
const drawnReach = (zoom: number) => atomProblemBadgeRadiusPx + 0.75 / zoom;

describe("atom problem badge across zoom", () => {
  it("typed N+: re-placed when the zoom changes, and clear of the label at 25%, 100% and 400%", async () => {
    const document = typedNPlus();
    const object = molecule(document);
    const end = object.atoms[object.atoms.length - 1]!;
    const label = moleculeLayoutLabelBoxes(object).find(box => box.atom === object.atoms.length - 1)!;
    expect(label).toBeDefined();
    await render(document);
    const centres = new Map<number, Point>();
    for (const percent of [100, 25, 400, 100] as const) {
      await zoomTo(percent);
      const zoom = percent / 100;
      const centre = badgeCentre(object, end.id);
      expect(gap(centre, label)).toBeGreaterThan(drawnReach(zoom));
      expect(gap(centre, label)).toBeGreaterThanOrEqual(atomProblemBadgeKeepOutPx(zoom) - 1e-9);
      if (centres.has(percent)) expect(centre).toEqual(centres.get(percent));
      centres.set(percent, centre);
    }
    // The memoized view did not keep the 100% spot at 25%: there it is farther out.
    expect(gap(centres.get(25)!, label)).toBeGreaterThan(gap(centres.get(100)!, label));
    expect(gap(centres.get(100)!, label)).toBeLessThan(atomProblemBadgeKeepOutPx(0.25));
  });

  it("a charge mark on an over-bonded carbon: clear of the mark at 25%, 100% and 400%", async () => {
    const document = chargedCarbon();
    const object = molecule(document);
    const mark = document.pages[0]!.objects.find(candidate => candidate.type === "electron-mark")!;
    const markCentre = inverseTransformPointForObject(object, { x: mark.x + mark.width / 2, y: mark.y + mark.height / 2 });
    const markBox = { x: markCentre.x - mark.width / 2, y: markCentre.y - mark.height / 2, width: mark.width, height: mark.height };
    const ownLabel = moleculeLayoutLabelBoxes(object).find(box => box.atom === object.atoms.findIndex(atom => atom.id === "atom_001"));
    await render(document);
    for (const percent of [25, 100, 400] as const) {
      await zoomTo(percent);
      const zoom = percent / 100;
      const centre = badgeCentre(object, "atom_001");
      expect(gap(centre, markBox)).toBeGreaterThanOrEqual(atomProblemBadgeKeepOutPx(zoom) - 1e-9);
      expect(gap(centre, markBox)).toBeGreaterThan(drawnReach(zoom));
      if (ownLabel) expect(gap(centre, ownLabel)).toBeGreaterThan(drawnReach(zoom));
    }
  });
});
