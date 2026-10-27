import { expect, it } from "vitest";
import { depictSmilesOffThread } from "./depiction2d/client";
import { createEmptyDocument, moleculeToMolfileV2000 } from "@chemdraft/chem-core";
import { createSmilesMolecule } from "@chemdraft/document-workflow-core";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import { installRealRdkitModuleLoader } from "@chemdraft/rdkit-adapter/testing";
import { nativeBondOrderResolution } from "@chemdraft/layout-engine";

it("depicts SMILES off-thread in the Node host", async () => {
  const result = await depictSmilesOffThread("CCO");
  expect(result.depiction.atoms).toHaveLength(3);
});

it.each([
  ["30-carbon ring", `C1${"C".repeat(29)}1`],
  ["38-carbon ring", `C1${"C".repeat(37)}1`],
  ["60-carbon ring", `C1${"C".repeat(59)}1`],
  ["100-carbon ring", `C1${"C".repeat(99)}1`],
  ["36-crown-12", `O1CC${"OCC".repeat(11)}1`]
])("pastes %s through a worker within 3 s with identity kept", async (label, smiles) => {
  const started = performance.now();
  const { depiction } = await depictSmilesOffThread(smiles);
  const elapsedMs = performance.now() - started;
  console.info(JSON.stringify({ depiction: `paste ${label}`, elapsedMs }));
  expect(elapsedMs).toBeLessThan(3_000);
  const molecule = createSmilesMolecule(createEmptyDocument(), { x: 0, y: 0 }, depiction, smiles);
  if (molecule.type !== "molecule") throw new Error("Expected a molecule");
  installRealRdkitModuleLoader();
  const output = await computeStructureIdentifiers(moleculeToMolfileV2000(molecule, {
    fromDocFrame: true, kekuleBondOrders: nativeBondOrderResolution(molecule.atoms, molecule.bonds).kekuleOrders
  }).contents);
  const input = await computeStructureIdentifiers(smiles);
  expect(input?.smiles).toBeTruthy();
  expect(output?.smiles).toBe(input?.smiles);
});
