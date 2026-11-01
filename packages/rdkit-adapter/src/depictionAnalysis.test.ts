import { afterEach, expect, it, vi } from "vitest";
import { depictionFor } from "./ionization";

afterEach(() => vi.unstubAllGlobals());

it("does not infer depiction policy from a JSDOM window installed by an overlapping PDF export", () => {
  vi.stubGlobal("window", { document: {} });
  const set_new_coords = vi.fn().mockReturnValue(true);
  depictionFor({ set_new_coords, get_molblock: () => "" }, {
    atoms: [], bonds: [], descriptors: {}
  });
  expect(set_new_coords).toHaveBeenCalledExactlyOnceWith(true);
});

it("guards the separate analysis CoordGen path using RDKit ring information", () => {
  const set_new_coords = vi.fn().mockReturnValue(true);
  depictionFor({ set_new_coords, get_molblock: () => "", get_json: () => JSON.stringify({ molecules: [{
    extensions: [{ name: "rdkitRepresentation", atomRings: [Array(100).fill(0)] }]
  }] }) }, { atoms: [], bonds: [], descriptors: {} });
  expect(set_new_coords).toHaveBeenCalledExactlyOnceWith(false);
});
