import { describe, expect, it } from "vitest";
import { createEmptyDocument, type MoleculeBond, type MoleculeObject } from "@chemdraft/chem-core";
import { planPageSvgRender } from "./index";
import { elementFragments } from "./testing";

function molecule(order: MoleculeBond["order"] = "unknown"): MoleculeObject {
  return {
    id: "m", type: "molecule", x: 0, y: 0, width: 100, height: 100, rotation: 0,
    style: { bondColor: "#123456", bondIndicatorShowQuery: false },
    structureFormat: "smiles", structure: "", superatoms: [], rGroups: [],
    atoms: [
      { id: "a", element: "C", x: 30, y: 30, formalCharge: 0 },
      { id: "b", element: "C", x: 52, y: 30, formalCharge: 0 }
    ],
    bonds: [{ id: "ab", fromAtomId: "a", toAtomId: "b", order }]
  };
}

function fragments(object: MoleculeObject) {
  const page = createEmptyDocument().pages[0]!;
  page.objects = [object];
  return planPageSvgRender(page).fragments.flatMap(elementFragments);
}

function ink(object: MoleculeObject) {
  return fragments(object).filter(fragment =>
    String(fragment.attrs.class).split(" ").includes("native-bond-line"));
}

describe("unknown bond order geometry", () => {
  it.each([0, 37, 90, 180])("draws separated round dots at %s degrees, without changing chemistry", degrees => {
    const object = molecule();
    const angle = degrees * Math.PI / 180;
    object.atoms[1]!.x = 30 + 22 * Math.cos(angle);
    object.atoms[1]!.y = 30 + 22 * Math.sin(angle);
    const before = JSON.stringify(object);
    const rendered = ink(object);
    expect(rendered).toHaveLength(1);
    const { tag, attrs } = rendered[0]!;
    expect(tag).toBe("line");
    expect(attrs).toMatchObject({ "data-bond-order": "unknown", stroke: "#123456", "stroke-linecap": "round" });
    const [dash, spacing] = String(attrs["stroke-dasharray"]).split(" ").map(Number);
    expect(dash).toBe(0); // Zero-length strokes with round caps are dots, not ordinary dashes.
    expect(spacing).toBeGreaterThan(Number(attrs["stroke-width"]) * 2);
    expect(spacing).toBeLessThan(8); // Several dots remain visible on a normal 22-unit bond.
    expect([attrs.x1, attrs.y1, attrs.x2, attrs.y2]).toEqual([
      object.atoms[0]!.x, object.atoms[0]!.y, object.atoms[1]!.x, object.atoms[1]!.y
    ]);
    expect(JSON.stringify(object)).toBe(before);
  });

  it.each([undefined, "dashed", "wedge", "hashed", "bold"] as const)("keeps unknown distinct with retained display style %s", bondStyle => {
    const unknown = molecule();
    unknown.bonds[0]!.display = { bondStyle };
    const rendered = ink(unknown);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]!.attrs["stroke-linecap"]).toBe("round");
    expect(String(rendered[0]!.attrs["stroke-dasharray"])).toMatch(/^0 /);
    for (const order of ["single", "double", "triple", "aromatic"] as const) {
      const known = molecule(order);
      known.bonds[0]!.display = { bondStyle };
      expect(ink(known).some(fragment => String(fragment.attrs["stroke-dasharray"]).startsWith("0 "))).toBe(false);
    }
  });

  it("preserves dots under sketch effects and uses the same dots for shadow geometry", () => {
    const object = molecule();
    object.bonds[0]!.display = { bondStyle: "hashed" };
    object.style.visualEffects = [
      { kind: "sketch", color: "#123456", seed: 713, roughness: 1.25, bowing: 0.8, strokeWidth: 1.5 },
      { kind: "shadow", color: "#52616b", opacity: 0.28, offsetX: 4, offsetY: 4, blurPx: 2 }
    ];
    const planned = fragments(object);
    expect(ink(object)).toHaveLength(1);
    expect(ink(object)[0]!.attrs).toMatchObject({ "stroke-dasharray": "0 5", "stroke-linecap": "round" });
    expect(planned.some(fragment => fragment.attrs.class === "native-molecule-sketch")).toBe(false);
    const source = planned.find(fragment => fragment.attrs["data-molecule-effect-source"] === "true")!;
    expect(source).toBeDefined();
    const sourceInk = source.children.flatMap(elementFragments).filter(fragment => fragment.tag === "line");
    expect(sourceInk).toHaveLength(1);
    expect(sourceInk[0]!.attrs).toMatchObject({ "stroke-dasharray": "0 5", "stroke-linecap": "round" });
  });
});
