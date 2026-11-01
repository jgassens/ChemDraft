import { afterEach, describe, expect, it, vi } from "vitest";
import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import { perceiveStereoCentersFromMolfile } from "@chemdraft/ocl-adapter";
import { buildSmilesDocument, canonicalSmiles, currentMoleculeIdentityMolfile, depictSmilesInWorker, renderSmilesToAssets } from "./document";
import { depictSmilesWithDeadline } from "./depictionClient";
import { perceiveDoubleBondStereo } from "./commands/stereo";

vi.mock("./depictionClient", () => ({ depictSmilesWithDeadline: vi.fn() }));
vi.setConfig({ testTimeout: 60_000 });
afterEach(() => vi.mocked(depictSmilesWithDeadline).mockReset());

const eitherIndices = (bonds: readonly { stereo?: string }[]) =>
  bonds.flatMap((bond, index) => bond.stereo === "either" ? [index] : []);

describe.each(["rdkit", "ocl"] as const)("%s SMILES/native storage", (engine) => {
  it("keeps native and stored stereo consistent by default", async () => {
    const smiles = "CC=CC/C=C/C[C@H](F)Cl";
    const depicted = await depictSmilesInWorker(smiles, () => undefined, {
      standardOnly: true,
      ...(engine === "ocl" ? { rdkitLoadFailure: "test fallback" } : {})
    });
    expect(depicted.engine).toBe(engine);
    expect(depicted.unspecifiedDoubleBondIndices).toEqual([1]);
    vi.mocked(depictSmilesWithDeadline).mockResolvedValue(depicted);
    const built = await buildSmilesDocument(smiles, { bondLength: 40 });
    const expected = [1];
    expect(eitherIndices(built.molecule.bonds)).toEqual(expected);
    expect(eitherIndices(parseMolfileGraph(built.molecule.structure).bonds)).toEqual(expected);
    expect(built.molecule.structure).toContain("  2  3  2  3");
    expect(built.molecule.structure).toBe(built.identityMolfile);
    expect(await canonicalSmiles(built.molecule.structure, "stored")).toBe(await canonicalSmiles(smiles, "input"));
    expect(perceiveStereoCentersFromMolfile(built.molecule.structure)).toEqual(perceiveStereoCentersFromMolfile(depicted.molfile));
    const specified = (bonds: Awaited<ReturnType<typeof perceiveDoubleBondStereo>>) =>
      bonds.filter((bond) => bond.bondIndex !== 1);
    expect(specified(await perceiveDoubleBondStereo(built.molecule.structure)))
      .toEqual(specified(await perceiveDoubleBondStereo(depicted.molfile)));
    expect(specified(await perceiveDoubleBondStereo(built.molecule.structure))).toEqual([{ bondIndex: 4, descriptor: "E" }]);
    expect(await canonicalSmiles(built.identityMolfile, "identity")).toBe(await canonicalSmiles(smiles, "input"));
    const rendered = await renderSmilesToAssets(smiles);
    expect(eitherIndices(rendered.molecule.bonds)).toEqual(expected);
    expect(eitherIndices(parseMolfileGraph(rendered.molecule.structure).bonds)).toEqual(expected);
    expect(rendered.molecule.structure).toContain("  2  3  2  3");
  });
});

it("keeps V3000 dative/native storage consistent by default", async () => {
  const smiles = "N->[Cu+2].CC=CC";
  const depicted = await depictSmilesInWorker(smiles, () => undefined, { standardOnly: true });
  expect(depicted.dativeBondIndices).toHaveLength(1);
  vi.mocked(depictSmilesWithDeadline).mockResolvedValue(depicted);
  const built = await buildSmilesDocument(smiles);
  expect(built.molecule.structureFormat).toBe("molfile-v3000");
  const expected = depicted.unspecifiedDoubleBondIndices;
  expect(expected).toHaveLength(1);
  expect(eitherIndices(built.molecule.bonds)).toEqual(expected);
  expect(eitherIndices(parseMolfileGraph(built.molecule.structure).bonds)).toEqual(expected);
  expect(built.molecule.structure).toMatch(/M  V30 \d+ 2 \d+ \d+ CFG=2\b/);
  expect(built.molecule.structure).toBe(built.identityMolfile);
  expect(await canonicalSmiles(built.identityMolfile, "identity")).toBe(await canonicalSmiles(smiles, "input"));
});

it.each([
  ["CC=CC", 1],
  ["C/C=C/C", 0],
  ["C/C=C/CC=CC", 1]
] as const)("reports only native open double bonds when rechecking %s", async (smiles, count) => {
  const depicted = await depictSmilesInWorker(smiles, () => undefined, { standardOnly: true });
  vi.mocked(depictSmilesWithDeadline).mockResolvedValue(depicted);
  const built = await buildSmilesDocument(smiles, { bondLength: 40 });
  const warnings: string[] = [];
  await currentMoleculeIdentityMolfile(built.molecule, warnings);
  const expected = `E/Z unspecified for ${count} double bond(s); the 2D drawing necessarily shows one geometry`;
  if (count === 0) expect(warnings).not.toContain(expected);
  else expect(warnings).toContain(expected);
});
