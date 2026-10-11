// A group label is exported exactly as the canvas draws it (PLANS.md, label anchoring): turned round
// for a bond on its right ("MeO"), with the atom it bonds to on the atom. The SVG is serialized from
// the canvas's own plan (`planPageSvgRender`), and the PDF is drawn from that SVG.

import { applyPatch, createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { elementFragments } from "@chemdraft/layout-engine/testing";
import { planPageSvgRender } from "@chemdraft/layout-engine";
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
