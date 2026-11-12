import { describe, expect, it } from "vitest";
import { molfileCoordinateScale } from "./molfileCoordinateScale";

function chain(lengths: number[]) {
  let x = 0;
  const atoms = [{ id: "a0", x, y: 0 }, ...lengths.map((length, i) => ({ id: `a${i + 1}`, x: x += length, y: 0 }))];
  const bonds = lengths.map((_, i) => ({ fromAtomId: `a${i}`, toAtomId: `a${i + 1}` }));
  return { atoms, bonds };
}

describe("molfileCoordinateScale", () => {
  it.each([
    { lengths: [22, 22, 220], median: 22 },
    { lengths: [10, 20, 30, 200], median: 25 }
  ])("uses the odd/even median, resisting an outlier: $lengths", ({ lengths, median }) => {
    const { atoms, bonds } = chain(lengths);
    const before = structuredClone({ atoms, bonds });
    expect(molfileCoordinateScale(atoms, bonds, 1.5, 28)).toEqual({ medianBondLength: median, scale: 1.5 / median });
    expect({ atoms, bonds }).toEqual(before);
  });

  it("ignores zero and dangling bonds and includes every valid disconnected bond", () => {
    const { atoms, bonds } = chain([0, 22]);
    atoms.push({ id: "b0", x: 300, y: 0 }, { id: "b1", x: 328, y: 0 });
    bonds.push({ fromAtomId: "missing", toAtomId: "a0" }, { fromAtomId: "b0", toAtomId: "b1" });
    expect(molfileCoordinateScale(atoms, bonds, 1.5, 28).medianBondLength).toBe(25);
  });

  it.each([{ lengths: [] }, { lengths: [0] }])("uses an explicit fallback for bondless or degenerate input: $lengths", ({ lengths }) => {
    const { atoms, bonds } = chain(lengths);
    atoms.push({ id: "isolated", x: 500, y: 100 });
    expect(molfileCoordinateScale(atoms, bonds, 1.5, 28)).toEqual({ medianBondLength: undefined, scale: 1.5 / 28 });
  });

  it.each([NaN, Infinity, -Infinity])("rejects non-finite atom coordinates (%s)", x => {
    expect(() => molfileCoordinateScale([{ id: "bad", x, y: 0 }], [], 1.5, 22)).toThrow("atom bad has non-finite coordinates");
  });

  it.each([0, -1, Infinity, NaN])("rejects invalid target/fallback lengths (%s)", length => {
    expect(() => molfileCoordinateScale([], [], length, 22)).toThrow("finite positive");
    expect(() => molfileCoordinateScale([], [], 1.5, length)).toThrow("finite positive");
  });
});
