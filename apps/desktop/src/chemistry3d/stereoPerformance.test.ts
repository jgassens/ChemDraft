import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ensureRdkit, resetRdkitForTesting } from "@chemdraft/rdkit-adapter";
import { installRealRdkitModuleLoader } from "@chemdraft/rdkit-adapter/testing";
import type { PluginMinimize3DResult } from "@chemdraft/plugin-api";
import { assertComponentStereo } from "./stereo";
import { embed3dInWorker, flatten3dInWorker } from "./engine";
import { chemistry3dMethod } from "./method";

// Seed-42 CBPQT4+/four-arm PEG2-TTF, guest centred on host, MMFF94s/interfragment=true,
// converged in the first 1000-step pass (548.207896 kcal/mol; closest contact 2.668323 A).
const fixture = JSON.parse(readFileSync(new URL("./fixtures/peg2-minimized.json", import.meta.url), "utf8")) as PluginMinimize3DResult;
beforeAll(() => { installRealRdkitModuleLoader(); });
afterAll(() => resetRdkitForTesting());

it("does not build or perceive explicit-H geometry when RDKit reports no specified stereo", async () => {
  const rdkit = await ensureRdkit();
  const parse = vi.spyOn(rdkit, "get_mol");
  try {
    fixture.model.components.forEach((_, index) => assertComponentStereo(rdkit, fixture.model, index, "flatten3d input"));
    // One signed-intent parse per component, independent of the size of its explicit-H model.
    // The old eager guard made three parses per component, including expensive 3D perception.
    expect(parse.mock.calls.map(([input]) => input)).toEqual(fixture.model.components.map(component => component.smiles));
  } finally { parse.mockRestore(); }
});

it.each(["C[C@H](F)Cl", "C/C=C/C", "[H]/C(Cl)=C(/F)Br"])(
  "still checks full 3D geometry for specified stereo, including explicit input H: %s", async smiles => {
    const embedded = await embed3dInWorker({ components: [{ smiles }], seed: 42 });
    const rdkit = await ensureRdkit();
    const parse = vi.spyOn(rdkit, "get_mol");
    try {
      assertComponentStereo(rdkit, embedded.model, 0, "flatten3d input");
      expect(parse).toHaveBeenCalledTimes(3);
      expect(parse.mock.calls[2][0]).toContain("3D");
    } finally { parse.mockRestore(); }
  }
);

it("keeps the complete PEG2 flatten result byte-identical to the eager stereo guard", async () => {
  let uuid = 0;
  const ids = vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(
    () => String(++uuid).padStart(36, "0") as ReturnType<Crypto["randomUUID"]>
  );
  try {
    const flat = await flatten3dInWorker({ model: fixture.model, view: "auto" }, chemistry3dMethod(fixture.method.seed));
    // Captured before the optimization, with only random molecule ids made deterministic.
    // Includes every object field, molfile byte, depth, method field and warning in order.
    expect(createHash("sha256").update(JSON.stringify(flat)).digest("hex"))
      .toBe("bc812e136619b9e0f0fdc92df49a3db196b1abb4428524eb3972aa391661b640");
  } finally { ids.mockRestore(); }
});
