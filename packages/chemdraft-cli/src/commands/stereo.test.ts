import { describe, expect, it, vi } from "vitest";

import { perceiveDoubleBondStereo, runStereoCommand } from "./stereo";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import * as documentWorkflow from "../document";

vi.setConfig({ testTimeout: 60_000 });

async function inspect(smiles: string) {
  const stdout: string[] = [];
  const result = await runStereoCommand(["--smiles", smiles], {
    stdout: (line) => stdout.push(line),
    stderr: () => undefined
  });
  return { result, output: JSON.parse(stdout[0]!) as Record<string, any> };
}

describe("chemdraft stereo", () => {
  it.each(["CC=O", "CC=C(C)C", "C1CC=CCC1"])("warns about a stale either marker on non-stereogenic %s", async (smiles) => {
    const depicted = await documentWorkflow.depictSmiles(smiles);
    const lines = depictSmiles2D(smiles).molfile.split("\n");
    const counts = lines.findIndex((line) => line.includes("V2000"));
    const bondStart = counts + 1 + Number(lines[counts]!.slice(0, 3));
    const bondIndex = lines.slice(bondStart).findIndex((line) => Number(line.slice(6, 9)) === 2);
    const line = lines[bondStart + bondIndex]!;
    lines[bondStart + bondIndex] = `${line.slice(0, 9)}  3${line.slice(12)}`;
    const molfile = lines.join("\n");
    const warnings: string[] = [];
    expect(await perceiveDoubleBondStereo(molfile, warnings)).toEqual([]);
    expect(warnings).toEqual([`Double bond ${bondIndex + 1} carries an either marker but is not stereogenic.`]);
    const spy = vi.spyOn(documentWorkflow, "depictSmiles").mockResolvedValue({ ...depicted, molfile });
    try {
      const { result, output } = await inspect(smiles);
      expect(result).toBe(0);
      expect(output.doubleBonds).toEqual([]);
      expect(output.specifiedCount).toBe(0);
      expect(output.unspecifiedCount).toBe(0);
      expect(output.warnings).toContain(warnings[0]);
    } finally { spy.mockRestore(); }
  });

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

  it.each([
    ["C/C=C/C", "E"],
    ["C/C=C\\C", "Z"]
  ] as const)("reports alkene geometry for %s as %s", async (smiles, descriptor) => {
    const { output } = await inspect(smiles);
    expect(output.doubleBonds).toEqual([{ bondIndex: 1, descriptor }]);
    expect(output.specifiedCount).toBe(1);
    expect(output.unspecifiedCount).toBe(0);
  });

  it("counts an unspecified stereogenic double bond and warns", async () => {
    const { output } = await inspect("CC=CC");
    expect(output.doubleBonds).toEqual([{ bondIndex: 1, descriptor: "unspecified" }]);
    expect(output.specifiedCount).toBe(0);
    expect(output.unspecifiedCount).toBe(1);
    expect(output.warnings).toContain("1 stereogenic double bond(s) left unspecified");
  });

  it("reports both R/S centres in meso and unsymmetrical two-centre structures", async () => {
    const meso = await inspect("O=C(O)[C@H](O)[C@H](O)C(=O)O");
    expect(meso.output.stereoCenters.map((center: { descriptor: string }) => center.descriptor))
      .toEqual(["R", "S"]);
    expect(meso.output.specifiedCount).toBe(2);

    const twoCentre = await inspect("C[C@H](O)[C@H](F)Cl");
    expect(twoCentre.output.stereoCenters).toEqual([
      { atomIndex: 1, element: "C", descriptor: "S" },
      { atomIndex: 3, element: "C", descriptor: "R" }
    ]);
    expect(twoCentre.output.specifiedCount).toBe(2);
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
  }, 60_000);

  it("rejects the reviewer's whitespace-only SMILES instead of reporting ok:true", async () => {
    const { result, output } = await inspect("   ");
    expect(result).toBe(1);
    expect(output).toMatchObject({ name: "structure", smiles: "   ", ok: false });
    expect(output.error).toContain("input is empty");
  }, 60_000);
});
