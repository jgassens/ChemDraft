// A group label is exported exactly as the canvas draws it (PLANS.md, label anchoring): turned round
// for a bond on its right ("MeO"), with the atom it bonds to on the atom. The SVG is serialized from
// the canvas's own plan (`planPageSvgRender`), and the PDF is drawn from that SVG.

import { applyPatch, createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { elementFragments } from "@chemdraft/layout-engine/testing";
import { planPageSvgRender } from "@chemdraft/layout-engine";
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
