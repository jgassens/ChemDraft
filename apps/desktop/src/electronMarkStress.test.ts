import { describe, expect, it } from "vitest";
import { deserializeDocument, serializeDocument, type ElectronMarkObject, type MoleculeObject } from "@chemdraft/chem-core";
import { exportDocumentToSvg } from "@chemdraft/export-engine";
import { planPageSvgRender, type PageSvgElementFragment } from "@chemdraft/layout-engine";
import {
  applyChargeToolAtNativeAtom, applyElectronMarkStyleToSelection, createPhase4Document,
  insertNativeSingleBondMolecule, normalizeCommittedDocument, scaleDocumentObjectsAroundPoint,
  type NativeElectronMarkSpec
} from "./documentWorkflow";

const specs: NativeElectronMarkSpec[] = [
  { kind: "charge", charge: 1 }, { kind: "charge", charge: -1 },
  { kind: "charge", charge: 1, chargeStyle: "plain" }, { kind: "charge", charge: -1, chargeStyle: "plain" },
  { kind: "charge", charge: 1, radical: true }, { kind: "charge", charge: -1, radical: true },
  { kind: "radical-dot" }, { kind: "lone-pair" }
];

function descendants(fragment: PageSvgElementFragment): PageSvgElementFragment[] {
  return [fragment, ...fragment.children.flatMap(child => child.kind === "element" ? descendants(child) : [])];
}

describe("electron mark appearance stress", () => {
  it.each(specs)("preserves chemistry, anchor and native save round trips for %j", spec => {
    const base = insertNativeSingleBondMolecule(createPhase4Document("Electron mark stress"), { x: 300, y: 300 });
    const molecule = base.pages[0].objects[0] as MoleculeObject;
    let doc = normalizeCommittedDocument(applyChargeToolAtNativeAtom(base, spec,
      { kind: "atom", objectId: molecule.id, atomId: molecule.atoms[0].id, distanceToPointer: 0 }));
    const mark = doc.pages[0].objects.find(o => o.type === "electron-mark") as ElectronMarkObject;
    expect(mark).toBeDefined();
    const originalMolecule = doc.pages[0].objects.find(o => o.id === molecule.id);
    const originalAnchor = mark.anchor;
    for (let cycle = 0; cycle < 30; cycle++) {
      const size = [8, 108, 18, 36, 72][cycle % 5];
      const thickness = [0.5, 5.5, 1.5][cycle % 3];
      doc = normalizeCommittedDocument(applyElectronMarkStyleToSelection(doc, "size", size));
      doc = normalizeCommittedDocument(applyElectronMarkStyleToSelection(doc, "thickness", thickness));
      const current = doc.pages[0].objects.find(o => o.id === mark.id) as ElectronMarkObject;
      const center = { x: current.x + current.width / 2, y: current.y + current.height / 2 };
      doc = normalizeCommittedDocument(scaleDocumentObjectsAroundPoint(doc, [mark.id], center, 1.25, 1.25));
      const saved = serializeDocument(doc);
      const reopened = normalizeCommittedDocument(deserializeDocument(saved));
      expect(reopened.pages).toEqual(doc.pages);
      expect(reopened.pages[0].objects.find(o => o.id === molecule.id)).toEqual(originalMolecule);
      const reopenedMark = reopened.pages[0].objects.find(o => o.id === mark.id) as ElectronMarkObject;
      expect(reopenedMark.anchor).toEqual(originalAnchor);
      expect(reopenedMark.style.strokeWidth).toBe(thickness);
      expect(reopenedMark.width).toBeCloseTo(size * 1.25);
      expect(reopened.pages[0].objects).toHaveLength(2);
      expect(exportDocumentToSvg(reopened).contents).toContain("<svg");
      if (spec.kind === "lone-pair") {
        const plan = planPageSvgRender(reopened.pages[0]);
        const elements = plan.fragments.filter(fragment => fragment.attrs["data-object-id"] === mark.id).flatMap(descendants);
        const dots = elements.filter(child => child.tag === "circle");
        expect(dots).toHaveLength(2);
        if (dots[0].kind === "element" && dots[1].kind === "element") {
          const separation = Number(dots[1].attrs.cx) - Number(dots[0].attrs.cx);
          expect(separation).toBeGreaterThan(Number(dots[0].attrs.r) + Number(dots[1].attrs.r));
        }
      }
      if (spec.kind === "charge" && spec.radical) {
        const elements = planPageSvgRender(reopened.pages[0]).fragments.filter(fragment => fragment.attrs["data-object-id"] === mark.id).flatMap(descendants);
        const dot = elements.find(child => child.tag === "circle")!;
        const bar = elements.find(child => child.tag === "line")!;
        if (dot.kind === "element" && bar.kind === "element") {
          expect(Number(dot.attrs.cx) + Number(dot.attrs.r)).toBeLessThan(
            Number(bar.attrs.x1) - Number(bar.attrs["stroke-width"]) / 2);
        }
      }
      expect(planPageSvgRender(reopened.pages[0]).fragments.length).toBeGreaterThan(0);
      doc = reopened;
    }
  });
});
