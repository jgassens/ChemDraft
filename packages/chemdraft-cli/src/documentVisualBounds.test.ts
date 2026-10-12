// The CLI's render bounds follow the drawn label (PLANS.md, label anchoring): a group label anchored
// on its atom ("MeO" with its bond on the right) reaches the other way from its atom than the old
// centred label did, and the rendered image must still hold all of it.

import { createEmptyDocument, nativeDrawingStyleFromObjectStyle, type ChemDraftDocument } from "@chemdraft/chem-core";
import { atomLabelLayout, planMoleculeAtomLabels } from "@chemdraft/layout-engine";
import { describe, expect, it } from "vitest";

import { documentVisualBounds } from "./document";

function methoxyDocument(carbonX: number): ChemDraftDocument {
  const document = createEmptyDocument({ title: "Label Bounds", now: "2026-10-10T00:00:00.000Z" });
  return {
    ...document,
    pages: [{
      ...document.pages[0]!,
      objects: [{
        id: "mol", type: "molecule", x: 200, y: 280, width: 120, height: 40, rotation: 0,
        style: { source: "chemdraft-native-drawing" },
        structureFormat: "smiles", structure: "", superatoms: [], rGroups: [],
        atoms: [
          { id: "ome", element: "OMe", x: 260, y: 300, formalCharge: 0, labelLiteral: true },
          { id: "c1", element: "C", x: carbonX, y: 300, formalCharge: 0 }
        ],
        bonds: [{ id: "b1", fromAtomId: "ome", toAtomId: "c1", order: "single" }]
      }]
    }]
  };
}

describe("CLI render bounds hold an anchored group label", () => {
  it.each([false, true])("ignores nested invisible group frames (includeObjectFrames=%s)", (includeObjectFrames) => {
    const document = methoxyDocument(300);
    const page = document.pages[0]!;
    page.objects.push({
      id: "caption", type: "text", text: "Label", spans: [],
      x: 220, y: 350, width: 80, height: 20, rotation: 0, style: {}
    });
    const expected = documentVisualBounds(document, includeObjectFrames);
    page.objects.push({
      id: "inner", type: "group", childObjectIds: ["mol", "caption"],
      x: 200, y: 280, width: 120, height: 90, rotation: 0, style: {}
    }, {
      // A stale outer wrapper must not change the crop either.
      id: "outer", type: "group", childObjectIds: ["inner", "caption"],
      x: -1000, y: -1000, width: 2000, height: 2000, rotation: 0, style: {}
    });
    expect(documentVisualBounds(document, includeObjectFrames)).toEqual(expected);
  });

  it.each([
    ["right", 300, "MeO"],
    ["left", 220, "OMe"]
  ] as const)("OMe with its bond on the %s (carbon at x=%d), drawn %s", (side, carbonX, drawn) => {
    const document = methoxyDocument(carbonX);
    const molecule = document.pages[0]!.objects[0]!;
    if (molecule.type !== "molecule") throw new Error("Expected the molecule.");
    const plan = planMoleculeAtomLabels(molecule).find((candidate) => candidate.atom.id === "ome")!;
    expect(plan.label).toBe(drawn);
    const left = plan.anchor.x + plan.layout.bounds.x;
    const right = left + plan.layout.bounds.width;
    const bounds = documentVisualBounds(document);
    expect(bounds.minX).toBeLessThanOrEqual(left + 0.001);
    expect(bounds.maxX).toBeGreaterThanOrEqual(right - 0.001);
    // It reaches away from its bond, unlike the old centred label.
    const centred = atomLabelLayout("OMe", nativeDrawingStyleFromObjectStyle(molecule.style)).bounds;
    if (side === "right") expect(left).toBeLessThan(260 + centred.x);
    else expect(right).toBeGreaterThan(260 + centred.x + centred.width);
  });
});
