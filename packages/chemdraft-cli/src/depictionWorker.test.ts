import { spawn } from "node:child_process";
import { beforeAll, expect, it } from "vitest";
import { createDepictionWorkerClient } from "@chemdraft/rdkit-adapter";
import { createNodeDepictionWorker } from "./depictionClient";
import { buildSmilesDocument, currentMoleculeIdentityMolfile } from "./document";
import { installIsotopeTestEngine } from "./isotopes.testUtils";

beforeAll(installIsotopeTestEngine);

it.each(["C1CCC2CCCCC2C1", "C[C@H](F)Cl", `C1${"C".repeat(99)}1`])(
  "depicts %s with identical molfile bytes through cold and warm workers", async (smiles) => {
    const worker = createNodeDepictionWorker();
    const depict = createDepictionWorkerClient(() => worker);
    try {
      const cold = await depict(smiles), warm = await depict(smiles);
      expect(cold.warnings).toEqual([]);
      expect(warm.warnings).toEqual([]);
      expect(warm.molfile).toBe(cold.molfile);
      expect(warm.engine).toBe(cold.engine);
    } finally { worker.terminate(); }
  }, 30_000
);

it("keeps >=100/100 graphs in V2000 and preserves unspecified E/Z when rechecking the CTAB", async () => {
  const result = await buildSmilesDocument(`C1${"C".repeat(96)}C=CC1`);
  expect(result.molecule.atoms.length).toBeGreaterThanOrEqual(100);
  expect(result.molecule.bonds.length).toBeGreaterThanOrEqual(100);
  expect(result.unspecifiedDoubleBonds).toBe(1);
  expect(result.molecule.structureFormat).toBe("molfile-v2000");
  const warnings: string[] = [];
  const current = await currentMoleculeIdentityMolfile(result.molecule, warnings);
  expect(current.format).toBe("molfile-v2000");
  expect(current.contents).toBe(result.molecule.structure);
  expect(warnings).toContain("E/Z unspecified for 1 double bond(s); the 2D drawing necessarily shows one geometry");
  expect(warnings.some((warning) => warning.includes("could not be verified"))).toBe(false);
}, 30_000);

it("preserves legacy unspecified E/Z (stored molfile marker, no native flag) when rechecking the CTAB", async () => {
  const result = await buildSmilesDocument(`C1${"C".repeat(96)}C=CC1`);
  expect(result.molecule.atoms.length).toBeGreaterThanOrEqual(100);
  expect(result.molecule.bonds.length).toBeGreaterThanOrEqual(100);
  expect(result.unspecifiedDoubleBonds).toBe(1);
  expect(result.molecule.structureFormat).toBe("molfile-v2000");
  // Simulate a document predating native either flags. New SMILES builds keep the
  // stored graph consistent; this compatibility guard is specifically for old records.
  const legacyMolecule = {
    ...result.molecule,
    structure: result.identityMolfile,
    bonds: result.molecule.bonds.map((bond) => {
      const legacy = { ...bond };
      delete legacy.stereo;
      return legacy;
    })
  };
  const warnings: string[] = [];
  const current = await currentMoleculeIdentityMolfile(legacyMolecule, warnings);
  expect(current.format).toBe("molfile-v2000");
  expect(current.contents).toBe(legacyMolecule.structure);
  expect(warnings).toContain("E/Z unspecified for 1 double bond(s); the 2D drawing necessarily shows one geometry");
  expect(warnings.some((warning) => warning.includes("could not be verified"))).toBe(false);
}, 30_000);

it("a Node depiction command exits promptly after its result despite the 60 s idle lifetime", async () => {
  const entry = new URL("./depictionClient.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import {depictSmilesWithDeadline} from ${JSON.stringify(entry)}; await depictSmilesWithDeadline('CCO'); console.log('finished');`
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let finishedAt: number | undefined;
  let output = "", errors = "";
  child.stdout.on("data", (data) => { output += String(data); if (output.includes("finished")) finishedAt = performance.now(); });
  child.stderr.on("data", (data) => { errors += String(data); });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Node depiction failed to exit: ${errors}`)); }, 15_000);
      child.on("exit", (code) => { clearTimeout(timer); resolve(code); });
      child.on("error", reject);
    });
    expect(code, errors).toBe(0);
    expect(finishedAt).toBeDefined();
    expect(performance.now() - finishedAt!).toBeLessThan(1_000);
  } finally { child.kill(); }
}, 20_000);
