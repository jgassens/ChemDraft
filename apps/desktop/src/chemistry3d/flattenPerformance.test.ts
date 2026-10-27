import { expect, it } from "vitest";
import { cpus, loadavg } from "node:os";
import { ensureRdkit, resetRdkitForTesting } from "@chemdraft/rdkit-adapter";
import { installRealRdkitModuleLoader } from "@chemdraft/rdkit-adapter/testing";
import type { PluginEmbed3DResult, PluginFlatten3DResult } from "@chemdraft/plugin-api";
import { runChemistry3dJob } from "./protocol";
import { CBPQT, pegTtf } from "./perfFixtures";
import { closestHeavyContact } from "./model";

/** Node/WASM compute measurements, intentionally separate from WebView startup and queues. */
it.skipIf(process.env.CHEMDRAFT_PROFILE_FLATTEN_3D !== "1")("measures warm PEG2/PEG8 flatten with the vendored WASM", async () => {
  installRealRdkitModuleLoader();
  try {
    await ensureRdkit();
    console.log("flatten benchmark host", { node: process.version, platform: process.platform, arch: process.arch,
      cpu: cpus()[0]?.model, loadavg: loadavg() });
    for (const repeats of [2, 8]) {
      // Independently embedded, separated components are non-clashing. No force field or
      // arrangement search contaminates the flatten samples; geometry stays fixed per fixture.
      const embedded = await runChemistry3dJob({ method: "embed3d",
        request: { components: [{ smiles: CBPQT }, { smiles: pegTtf(repeats) }], seed: 42 } }) as PluginEmbed3DResult;
      expect(closestHeavyContact(embedded.model)).toBeGreaterThan(2.2);
      const job = { method: "flatten3d" as const, request: { model: embedded.model, view: "auto" as const }, provenance: embedded.method };
      await runChemistry3dJob(job); // warm code/JIT as well as WASM
      const samples = [];
      for (let n = 0; n < 7; n++) {
        const started = performance.now();
        const flat = await runChemistry3dJob(job) as PluginFlatten3DResult;
        samples.push(performance.now() - started);
        expect(flat.objects).toHaveLength(2);
      }
      const sorted = [...samples].sort((a, b) => a - b);
      console.log("warm flatten", JSON.stringify({ repeats, modelAtoms: embedded.model.atoms.length,
        nativeAtoms: embedded.model.atoms.filter(atom => !atom.addedHydrogen).length,
        ms: samples, min: sorted[0], median: sorted[3], max: sorted[6] }));
    }
  } finally { resetRdkitForTesting(); }
}, 120_000);
