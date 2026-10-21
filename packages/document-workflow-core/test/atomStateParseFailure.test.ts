import { afterEach, expect, it } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";
import type { ExportWarning } from "@chemdraft/export-engine";
import { resetRdkitForTesting, setRdkitModuleLoader, type RdkitMinimalModule } from "../../rdkit-adapter/src/conformer";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import { moleculeSmiles } from "../src/moleculeSmiles";

afterEach(() => { resetRdkitForTesting(); });

it.each(["null reparse", "missing JSON binding", "malformed JSON", "missing output order", "malformed output order", "invalid output order"])(
  "warns on %s even without drawn radicals or strict verification", async (failure) => {
    const molecule: MoleculeObject = {
      id: "mol", type: "molecule", x: 0, y: 0, width: 20, height: 20, rotation: 0,
      style: {}, structureFormat: "molfile-v2000", structure: "", superatoms: [], rGroups: [],
      atoms: [{ id: "a", element: "C", x: 0, y: 0, formalCharge: 0 }], bonds: []
    };
    const json = JSON.stringify({
      defaults: { atom: { z: 6, chg: 0, isotope: 0, nRad: 0, impHs: 4 } },
      molecules: [{ atoms: [{}], bonds: [] }]
    });
    setRdkitModuleLoader(async () => ({
      get_mol: (input: string) => input === "C"
        ? failure === "null reparse" ? null : {
          delete() {},
          ...(failure === "missing JSON binding" ? {} : {
            get_json: () => failure === "malformed JSON" ? "invalid" : json
          })
        }
        : {
          delete() {}, get_smiles: () => "C",
          ...(failure === "missing output order" ? {} : {
            get_prop: () => failure === "malformed output order" ? "invalid"
              : failure === "invalid output order" ? "[-1]" : "[0]"
          })
        }
    }) as unknown as RdkitMinimalModule);

    const identifiers = await computeStructureIdentifiers("molblock", { includeAtomStates: true });
    expect(identifiers).toEqual({ smiles: "C", smilesAtomStates: [] });
    expect(await computeStructureIdentifiers("molblock")).toEqual({ smiles: "C" });
    const warnings: ExportWarning[] = [];
    expect(await moleculeSmiles(molecule, 0, warnings, computeStructureIdentifiers)).toBe("C");
    expect(warnings).toEqual([expect.objectContaining({
      code: "export.smiles_atom_state_unverified", objectId: "mol", severity: "warning"
    })]);
  }
);
