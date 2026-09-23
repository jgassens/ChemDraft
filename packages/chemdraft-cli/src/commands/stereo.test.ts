import { describe, expect, it } from "vitest";

import { runStereoCommand } from "./stereo";

async function inspect(smiles: string) {
  const stdout: string[] = [];
  const result = await runStereoCommand(["--smiles", smiles], {
    stdout: (line) => stdout.push(line),
    stderr: () => undefined
  });
  return { result, output: JSON.parse(stdout[0]!) as Record<string, any> };
}

describe("chemdraft stereo", () => {
  it("reports L-alanine as S", async () => {
    const { result, output } = await inspect("C[C@H](N)C(=O)O");
    expect(result).toBe(0);
    expect(output.stereoCenters).toEqual([{ atomIndex: 1, element: "C", descriptor: "S" }]);
    expect(output.specifiedCount).toBe(1);
    expect(output.unspecifiedCount).toBe(0);
  });

  it("reports D-alanine as R", async () => {
    const { output } = await inspect("C[C@@H](N)C(=O)O");
    expect(output.stereoCenters[0]).toMatchObject({ atomIndex: 1, descriptor: "R" });
  });

  it("reports a flat alanine center as unspecified", async () => {
    const { output } = await inspect("CC(N)C(=O)O");
    expect(output.stereoCenters[0]).toMatchObject({ atomIndex: 1, descriptor: "unspecified" });
    expect(output.unspecifiedCount).toBe(1);
    expect(output.warnings).toContain("1 stereocentre(s) left unspecified");
  });

  it("reports allene axial stereochemistry as unrepresentable", async () => {
    const { output } = await inspect("CC=C=CC");
    expect(output.unrepresentable.alleneAtoms.length).toBeGreaterThan(0);
  });

  it("returns a named failed JSON result for bad SMILES", async () => {
    const { result, output } = await inspect("not a smiles");
    expect(result).toBe(1);
    expect(output).toMatchObject({ name: "structure", smiles: "not a smiles", ok: false });
    expect(output.error).toEqual(expect.any(String));
  });
});
