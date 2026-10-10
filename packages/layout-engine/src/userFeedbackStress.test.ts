import { describe, expect, it } from "vitest";
import { createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { planPageSvgRender } from "./index";
import { elementFragments } from "./testing";

const ATOMS = 240;
const LENGTH = 60;

function chain(cumulene: boolean): MoleculeObject {
  return {
    id: "stress-chain", type: "molecule", x: 0, y: 0, width: ATOMS * LENGTH, height: 100,
    rotation: 0, style: {}, structureFormat: "smiles", structure: "", superatoms: [], rGroups: [],
    atoms: Array.from({ length: ATOMS }, (_, i) => ({
      id: `a${i}`, element: "C", x: 40 + i * LENGTH, y: cumulene ? 60 : 60 + (i % 2) * 20, formalCharge: 0
    })),
    bonds: Array.from({ length: ATOMS - 1 }, (_, i) => ({
      id: `b${i}`, fromAtomId: `a${i}`, toAtomId: `a${i + 1}`,
      order: cumulene || i % 2 === 0 ? "double" : "single",
      ...(cumulene || i % 2 === 0 ? { display: { doubleBondSide: "center" as const } } : {})
    }))
  };
}

function render(molecule: MoleculeObject) {
  const page = { ...createEmptyDocument().pages[0], objects: [molecule] };
  return planPageSvgRender(page).fragments.flatMap(elementFragments);
}

describe("user feedback geometry stress", () => {
  it("A6: renders 240-atom centered polyene and cumulene without invalid or collapsed segments", () => {
    const started = performance.now();
    let segments = 0;
    for (const cumulene of [false, true]) {
      const molecule = chain(cumulene);
      const before = JSON.stringify(molecule);
      const fragments = render(molecule);
      expect(JSON.stringify(fragments)).not.toMatch(/NaN|Infinity/);
      const lines = fragments.filter(f => f.tag === "line" && String(f.attrs.class).startsWith("native-bond-line"));
      expect(lines).toHaveLength(molecule.bonds.reduce((n, b) => n + (b.order === "double" ? 2 : 1), 0));
      for (const line of lines) {
        const values = [line.attrs.x1, line.attrs.y1, line.attrs.x2, line.attrs.y2].map(Number);
        expect(values.every(Number.isFinite)).toBe(true);
        expect(Math.hypot(values[2] - values[0], values[3] - values[1])).toBeGreaterThan(1e-8);
      }
      segments += lines.length;
      expect(JSON.stringify(molecule)).toBe(before);
    }
    const elapsed = performance.now() - started;
    console.info(`[stress A6] molecules=2 atoms=480 doubleBonds=359 segments=${segments} ms=${elapsed.toFixed(1)} PASS`);
  }, 120000);

  it("E: deterministically sketches 239 hashed/dashed/wedge bonds without full-length hash or dash strokes", () => {
    const molecule = chain(true);
    molecule.bonds = molecule.bonds.map((b, i) => ({ ...b, order: "single", display: {
      bondStyle: (["hashed", "dashed", "wedge"] as const)[i % 3]
    } }));
    molecule.style = { visualEffects: [{ kind: "sketch", color: "#111111", seed: 17, roughness: 0, bowing: 0 }] };
    const before = JSON.stringify(molecule);
    const started = performance.now();
    const first = render(molecule);
    const firstMs = performance.now() - started;
    const secondStart = performance.now();
    // A fresh graph bypasses the planner's object-identity cache on the second run.
    const second = render(structuredClone(molecule));
    const secondMs = performance.now() - secondStart;
    expect(second).toEqual(first);
    let strokes = 0;
    let shortStrokes = 0;
    for (const fragment of first.filter(f => f.attrs.class === "native-molecule-sketch")) {
      for (const part of String(fragment.attrs.d).split("M").filter(p => p.trim())) {
        const numbers = part.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number);
        expect(numbers.every(Number.isFinite)).toBe(true);
        const x1 = numbers[0], y1 = numbers[1];
        const x2 = numbers[numbers.length - 2], y2 = numbers[numbers.length - 1];
        // Zero jitter makes the midpoint identify the source bond; wedge outlines may be long.
        const index = Math.min(ATOMS - 2, Math.max(0, Math.floor(((x1 + x2) / 2 - 40) / LENGTH)));
        if (molecule.bonds[index].display?.bondStyle !== "wedge") {
          expect(Math.hypot(x2 - x1, y2 - y1)).toBeLessThan(LENGTH * 0.9);
          shortStrokes++;
        }
        strokes++;
      }
    }
    expect(shortStrokes).toBeGreaterThan(160);
    expect(JSON.stringify(molecule)).toBe(before);
    console.info(`[stress E] atoms=240 bonds=239 hashed=80 dashed=80 wedge=79 strokes=${strokes} shortStrokes=${shortStrokes} renderMs=${firstMs.toFixed(1)} repeatMs=${secondMs.toFixed(1)} PASS`);
  }, 120000);
});
