import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deserializeDocument, moleculeToMolfileV2000, serializeDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { inspectClipboardPayload, parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import { compositionFromRdkitJson, type RdkitJson } from "../../../packages/rdkit-adapter/src/composition";
import { ensureRdkit, resetRdkitForTesting, type RdkitJsMol } from "../../../packages/rdkit-adapter/src/conformer";
import { installRealRdkitModuleLoader } from "../../../packages/rdkit-adapter/src/testing";
import { applyClipboardPastePayload, copyAsMolfile, createPhase4Document, insertNativeMolfileMolecule } from "./documentWorkflow";

describe("large V2000 molfile paste/import round trip", () => {
  beforeAll(installRealRdkitModuleLoader);
  afterAll(resetRdkitForTesting);

  it("preserves canonical SMILES, formula, charge, and 266/267 counts through paste, copy, and import", async () => {
    const rdkit = await ensureRdkit();
    const source = rdkit.get_mol(`C12CC2${"C".repeat(263)}1`)!;
    expect(source).not.toBeNull();
    function identity(molecule: RdkitJsMol) {
      const json = JSON.parse((molecule as RdkitJsMol & { get_json(): string }).get_json()) as RdkitJson;
      const composition = compositionFromRdkitJson(json);
      return {
        smiles: molecule.get_smiles!(),
        formula: composition.formula,
        charge: composition.formalCharge,
        atoms: json.molecules[0]!.atoms.length,
        bonds: json.molecules[0]!.bonds.length
      };
    }
    try {
      const expected = identity(source);
      expect(expected).toMatchObject({ formula: "C266H530", charge: 0, atoms: 266, bonds: 267 });
      const molfile = source.get_molblock!();
      expect(molfile.split("\n")[3]?.slice(0, 6)).toBe("266267");
      const payload = inspectClipboardPayload({
        types: ["chemical/x-mdl-molfile"],
        textItems: [{ type: "chemical/x-mdl-molfile", text: molfile }]
      });
      const pasted = applyClipboardPastePayload(createPhase4Document("Large MOL"), payload, { x: 260, y: 260 });
      expect(pasted.status).toBe("Pasted editable MOL V2000 structure");
      expect(pasted.selectedObjectId).toBeTruthy();
      const restored = deserializeDocument(serializeDocument(pasted.document));
      const copied = copyAsMolfile(restored, "v2000");
      if (!copied) throw new Error("Copy As MOL did not return the pasted molecule.");
      const imported = insertNativeMolfileMolecule(createPhase4Document("Reimported MOL"), { x: 260, y: 260 }, copied, "molfile-v2000");
      const molecule = imported.pages[0]!.objects.find((object): object is MoleculeObject => object.type === "molecule")!;
      expect(molecule.atoms).toHaveLength(266);
      expect(molecule.bonds).toHaveLength(267);
      const rewritten = moleculeToMolfileV2000(molecule, { fromDocFrame: true, kekuleBondOrders: new Map() }).contents;
      const graph = parseMolfileGraph(rewritten);
      expect(graph.atoms).toHaveLength(266);
      expect(graph.bonds).toHaveLength(267);
      for (const contents of [copied, rewritten]) {
        const reparsed = rdkit.get_mol(contents);
        expect(reparsed).not.toBeNull();
        try { expect(identity(reparsed!)).toEqual(expected); }
        finally { reparsed?.delete(); }
      }
    } finally {
      source.delete();
    }
  }, 30_000);
});
