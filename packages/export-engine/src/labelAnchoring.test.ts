// A group label is exported exactly as the canvas draws it (docs/plans/PLANS.md, label anchoring): turned round
// for a bond on its right ("MeO"), with the atom it bonds to on the atom. The SVG is serialized from
// the canvas's own plan (`planPageSvgRender`), and the PDF is drawn from that SVG.

import { applyPatch, createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { atomLabelGlyphBoxes, elementFragments } from "@chemdraft/layout-engine/testing";
import { planMoleculeAtomLabels, planPageSvgRender } from "@chemdraft/layout-engine";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { exportDocumentToSvg } from "./svg";

const timestamp = "2026-10-10T00:00:00.000Z";

function methoxy(carbonX: number): MoleculeObject {
  return {
    id: "mol_ome", type: "molecule", x: 80, y: 120, width: 120, height: 40, rotation: 0,
    style: { source: "chemdraft-native-drawing" },
    structureFormat: "smiles", structure: "", superatoms: [], rGroups: [],
    atoms: [
      { id: "ome", element: "OMe", x: 140, y: 140, formalCharge: 0, labelLiteral: true },
      { id: "c1", element: "C", x: carbonX, y: 140, formalCharge: 0 },
      { id: "c2", element: "C", x: carbonX + (carbonX - 140), y: 160, formalCharge: 0 }
    ],
    bonds: [
      { id: "b1", fromAtomId: "ome", toAtomId: "c1", order: "single" },
      { id: "b2", fromAtomId: "c1", toAtomId: "c2", order: "single" }
    ]
  };
}

describe("group labels export as the canvas draws them", () => {
  it("exports isotope superscripts and D/T using the canvas label geometry", () => {
    const molecule = methoxy(180);
    molecule.atoms = [
      { id: "ome", element: "C", isotope: 13, x: 140, y: 140, formalCharge: 0 },
      { id: "c1", element: "D", x: 180, y: 140, formalCharge: 0 },
      { id: "c2", element: "T", x: 100, y: 140, formalCharge: 0 }
    ];
    molecule.bonds[1]!.fromAtomId = "ome";
    const document = applyPatch(createEmptyDocument({ now: timestamp }), {
      op: "addObject", pageId: "page_001", object: molecule
    });
    const svg = exportDocumentToSvg(document).contents;
    const parsed = new JSDOM(svg, { contentType: "image/svg+xml" }).window.document;
    const canvas = planPageSvgRender(document.pages[0]!).fragments.flatMap(elementFragments);
    for (const text of ["13CH2", "D", "T"]) {
      expect(svg).toContain(`data-atom-label="${text}"`);
      const label = canvas.find((fragment) => fragment.attrs["data-atom-label"] === text)!;
      const runs = label.children.flatMap(elementFragments)
        .filter((fragment) => fragment.attrs.class === "native-atom-label-run");
      const exportedRuns = [...parsed.querySelectorAll(`[data-atom-label="${text}"] [data-atom-label-run]`)];
      expect(exportedRuns).toHaveLength(runs.length);
      runs.forEach((run, index) => {
        expect(Number(exportedRuns[index]!.getAttribute("x"))).toBeCloseTo(Number(run.attrs.x), 3);
        expect(Number(exportedRuns[index]!.getAttribute("y"))).toBeCloseTo(Number(run.attrs.y), 3);
      });
      if (text === "13CH2") {
        expect(runs[0]!.children).toMatchObject([{ text: "13" }]);
        expect(Number(runs[0]!.attrs.y)).toBeLessThan(Number(runs[1]!.attrs.y));
      }
    }
  });

  it("exports HO/OH and H2N/NH2 with the shared layout's exact advance-box gaps", () => {
    // The left end's bond leaves to the right, so its hydrogen group leads the element.
    const chain = (id: string, element: string): MoleculeObject => ({
      id, type: "molecule", x: 90, y: 130, width: 125, height: 40, rotation: 0,
      style: { source: "chemdraft-native-drawing" },
      structureFormat: "smiles", structure: "", superatoms: [], rGroups: [],
      atoms: [
        { id: `${id}_x1`, element, x: 100, y: 140, formalCharge: 0 },
        { id: `${id}_c1`, element: "C", x: 135, y: 160, formalCharge: 0 },
        { id: `${id}_c2`, element: "C", x: 170, y: 140, formalCharge: 0 },
        { id: `${id}_x2`, element, x: 205, y: 160, formalCharge: 0 }
      ],
      bonds: [
        { id: `${id}_b1`, fromAtomId: `${id}_x1`, toAtomId: `${id}_c1`, order: "single" },
        { id: `${id}_b2`, fromAtomId: `${id}_c1`, toAtomId: `${id}_c2`, order: "single" },
        { id: `${id}_b3`, fromAtomId: `${id}_c2`, toAtomId: `${id}_x2`, order: "single" }
      ]
    });
    for (const [element, leading, trailing] of [["O", "HO", "OH"], ["N", "H2N", "NH2"]] as const) {
      const molecule = chain(`mol_${element}`, element);
      const document = applyPatch(createEmptyDocument({ now: timestamp }), { op: "addObject", pageId: "page_001", object: molecule });
      const svg = exportDocumentToSvg(document).contents;
      const parsed = new JSDOM(svg, { contentType: "image/svg+xml" }).window.document;
      const plans = planMoleculeAtomLabels(molecule);
      const gapEm = (boxes: ReturnType<typeof atomLabelGlyphBoxes>, label: string, fontSize: number) => {
        const symbol = boxes.find((box) => box.text === element)!;
        // H2 is one hydrogen group; its count's advance edge touches N in H2N.
        const hydrogens = boxes.filter((box) => box !== symbol);
        const left = Math.min(...hydrogens.map((box) => box.left));
        const right = Math.max(...hydrogens.map((box) => box.right));
        return (label.startsWith("H") ? symbol.left - right : left - symbol.right) / fontSize;
      };
      const exportedGapEm = (label: string) => {
        const plan = plans.find((candidate) => candidate.label === label)!;
        const exported = [...parsed.querySelectorAll(`[data-atom-label="${label}"] [data-atom-label-run]`)];
        expect(exported.map((run) => run.textContent)).toEqual(plan.layout.runs.map((run) => run.text));
        // The SVG carries the shared layout's run positions, as the canvas draws them.
        exported.forEach((run, index) => {
          expect(Number(run.getAttribute("x"))).toBeCloseTo(plan.layout.runs[index]!.x, 3);
          expect(run.getAttribute("text-anchor")).toBe(plan.layout.runs[index]!.textAnchor);
        });
        const boxes = atomLabelGlyphBoxes(exported.map((run, index) => ({
          ...plan.layout.runs[index]!,
          x: Number(run.getAttribute("x")),
          textAnchor: run.getAttribute("text-anchor") as "start" | "middle" | "end"
        })), plan.drawingStyle);
        const layoutBoxes = atomLabelGlyphBoxes(plan.layout.runs, plan.drawingStyle);
        const exportedGap = gapEm(boxes, label, plan.fontSizePx);
        const layoutGap = gapEm(layoutBoxes, label, plan.fontSizePx);
        expect(Math.abs(exportedGap - layoutGap), `${label}: SVG versus layout gap in em`).toBeLessThanOrEqual(1e-6);
        return exportedGap;
      };
      expect(Math.abs(exportedGapEm(leading) - exportedGapEm(trailing))).toBeLessThanOrEqual(1e-6);
    }
  });

  it.each([
    ["left", 100, "OMe", "start"],
    ["right", 180, "MeO", "end"]
  ] as const)("OMe with its bond on the %s exports as %s, anchored at its %s", (_side, carbonX, drawn, textAnchor) => {
    const document = applyPatch(
      createEmptyDocument({ title: "Anchored Label", now: timestamp }),
      { op: "addObject", pageId: "page_001", object: methoxy(carbonX) },
      { now: timestamp }
    );
    const svg = exportDocumentToSvg(document).contents;
    expect(svg).toContain(`data-atom-label="${drawn}"`);
    expect(svg).not.toContain(`data-atom-label="${drawn === "OMe" ? "MeO" : "OMe"}"`);

    // The same runs the canvas plans, at the same place.
    const label = planPageSvgRender(document.pages[0]!).fragments.flatMap(elementFragments)
      .find((fragment) => fragment.attrs["data-atom-label"] === drawn)!;
    const run = label.children.flatMap(elementFragments).find((fragment) => fragment.tag === "text")!;
    expect(run.attrs["text-anchor"]).toBe(textAnchor);
    expect(svg).toMatch(new RegExp(`<text[^>]*x="${run.attrs.x}"[^>]*text-anchor="${textAnchor}"|<text[^>]*text-anchor="${textAnchor}"[^>]*x="${run.attrs.x}"`));
  });
});
