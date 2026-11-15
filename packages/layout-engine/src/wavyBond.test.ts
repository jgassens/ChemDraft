import { describe, expect, it } from "vitest";
import { createEmptyDocument, MoleculeObjectSchema } from "@chemdraft/chem-core";
import { planPageSvgRender } from "./index";
import { elementFragments } from "./testing";

function molecule(element = "C", length = 60) {
  return MoleculeObjectSchema.parse({
    id: "wave", type: "molecule", x: 0, y: 0, width: 120, height: 100,
    structureFormat: "smiles", structure: "CC",
    atoms: [{ id: "a", element, x: 30, y: 50 }, { id: "b", element, x: 30 + length, y: 50 }],
    bonds: [{ id: "ab", fromAtomId: "a", toAtomId: "b", order: "single", display: { bondStyle: "wavy" } }]
  });
}
function paths(mol = molecule()) {
  const page = createEmptyDocument().pages[0]!;
  page.objects = [mol];
  return planPageSvgRender(page).fragments.flatMap(elementFragments)
    .filter((f) => f.tag === "path" && f.attrs["data-bond-style"] === "wavy");
}
function points(d: unknown) {
  const numbers = String(d).match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number);
  return numbers.flatMap((x, index) => index % 2 ? [] : [{ x, y: numbers[index + 1]! }]);
}

describe("shared wavy bond geometry", () => {
  it("draws smooth alternating cubics on the bond axis with a narrower stereo end", () => {
    const [path] = paths();
    expect(path!.attrs.fill).toBe("none");
    const d = String(path!.attrs.d);
    expect(d).not.toMatch(/NaN|Infinity/);
    const p = points(d);
    expect(p[0]).toEqual({ x: 30, y: 50 });
    expect(p.at(-1)!.x).toBeCloseTo(90);
    expect(p.at(-1)!.y).toBeCloseTo(50);
    expect(p.some(({ y }) => y < 49)).toBe(true);
    expect(p.some(({ y }) => y > 51)).toBe(true);
    expect(Math.abs(p[3]!.y - 50)).toBeLessThan(Math.abs(p.at(-10)!.y - 50));
    expect((d.match(/ C /g) ?? []).length).toBeGreaterThanOrEqual(8);
  });

  it("clips at visible heteroatom labels exactly as the plain bond does", () => {
    const mol = molecule("O");
    const wave = points(paths(mol)[0]!.attrs.d);
    const page = createEmptyDocument().pages[0]!;
    page.objects = [{ ...mol, bonds: mol.bonds.map(bond => ({ ...bond, display: undefined })) }];
    const plain = planPageSvgRender(page).fragments.flatMap(elementFragments)
      .find(f => f.tag === "line" && f.attrs["data-bond-id"] === "ab" && String(f.attrs.class).includes("native-bond-line"))!;
    expect(wave[0]!.x).toBeCloseTo(Number(plain.attrs.x1));
    expect(wave.at(-1)!.x).toBeCloseTo(Number(plain.attrs.x2));
    expect(wave[0]!.x).toBeGreaterThan(30);
    expect(wave.at(-1)!.x).toBeLessThan(90);
  });

  it("rotates with the bond and stays finite for short bonds", () => {
    const mol = molecule();
    const before = points(paths(mol)[0]!.attrs.d);
    const rotated = { ...mol, atoms: mol.atoms.map(a => ({ ...a, x: 80 - a.y, y: a.x + 20 })) };
    const after = points(paths(rotated)[0]!.attrs.d);
    after.forEach((p, i) => {
      expect(p.x).toBeCloseTo(80 - before[i]!.y);
      expect(p.y).toBeCloseTo(before[i]!.x + 20);
    });
    expect(String(paths(molecule("C", 0.01))[0]!.attrs.d)).not.toMatch(/NaN|Infinity/);
  });

  it("scales amplitude and wavelength with the stroke and drawing bond length", () => {
    const thin = { ...molecule(), style: { bondStrokeWidthPx: 0.4, bondLengthPx: 22 } };
    const thick = { ...molecule(), style: { bondStrokeWidthPx: 2, bondLengthPx: 44 } };
    const narrow = paths(thin)[0]!, broad = paths(thick)[0]!;
    const amplitude = (d: unknown) => Math.max(...points(d).map(p => Math.abs(p.y - 50)));
    expect(amplitude(broad.attrs.d)).toBeGreaterThan(amplitude(narrow.attrs.d));
    expect(String(narrow.attrs.d).split(" C ").length).toBeGreaterThan(String(broad.attrs.d).split(" C ").length);
    expect(broad.attrs["stroke-width"]).toBeGreaterThan(Number(narrow.attrs["stroke-width"]));
  });

  it("preserves wave phase across a deliberate crossing gap", () => {
    const wave = molecule();
    const front = { ...molecule(), id: "front", atoms: [
      { id: "a", element: "C", x: 60, y: 20, formalCharge: 0 },
      { id: "b", element: "C", x: 60, y: 80, formalCharge: 0 }
    ], bonds: [{ ...wave.bonds[0]!, display: undefined }] };
    const page = createEmptyDocument().pages[0]!;
    page.objects = [wave, front];
    const backRef = { objectId: wave.id, bondId: "ab" }, frontRef = { objectId: front.id, bondId: "ab" };
    page.crossings = [{ bonds: [backRef, frontRef], front: frontRef, clearancePx: 14 }];
    const fragments = planPageSvgRender(page).fragments.flatMap(elementFragments)
      .filter(f => f.tag === "path" && f.attrs["data-bond-style"] === "wavy");
    expect(fragments).toHaveLength(2);
    const left = points(fragments[0]!.attrs.d).at(-1)!, right = points(fragments[1]!.attrs.d)[0]!;
    expect(left.x).toBeLessThan(60); expect(right.x).toBeGreaterThan(60);
    expect(Math.abs(left.y - 50)).toBeGreaterThan(0.1);
    expect(Math.abs(right.y - 50)).toBeGreaterThan(0.1);
  });
});
