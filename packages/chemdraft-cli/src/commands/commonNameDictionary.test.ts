import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import { describe, expect, it, vi } from "vitest";
import { createNameDictionary, nameDictionaryUrl, resolveChemicalName } from "../../../document-workflow-core/src/nameDictionary";

installNodeRdkitModuleLoader();
// Integration can verify a staged candidate without touching the committed asset.
const dictionary = createNameDictionary(async () => gunzipSync(await readFile(
  process.env.CHEMDRAFT_NAME_DICTIONARY_CANDIDATE ?? nameDictionaryUrl
)).toString("utf8"));

// These assertions deliberately remain active until the conductor regenerates the committed
// snapshot. Missing in EVERY column on 2026-10-27: aspirin/Aspirin, nicotine, penicillin G,
// acetaminophen, sucrose, serotonin, adrenaline, epinephrine, quinine and menthol.
// All other names below should already pass with exact column-5 fallback enabled.
// Menthol is the stereo-unspecified compound. Glucose's absence is tested separately.
// Never accept a different anomer/stereoisomer merely to make regeneration pass.
const commonNames = [
  ["aspirin", "BSYNRYMUTXBXSQ-UHFFFAOYSA-N"],
  ["Aspirin", "BSYNRYMUTXBXSQ-UHFFFAOYSA-N"],
  ["ibuprofen", "HEFNNWSXXWATRW-UHFFFAOYSA-N"],
  ["caffeine", "RYYVLZVUVIJVGH-UHFFFAOYSA-N"],
  ["nicotine", "SNICXCGAKADSCV-JTQLQIEISA-N"],
  ["morphine", "BQJCRHHNABKAKU-KBQPJGBKSA-N"],
  ["penicillin G", "JGSARLDLIJGVTE-MBNYWOFBSA-N"],
  ["paracetamol", "RZVAJINKPMORJF-UHFFFAOYSA-N"],
  ["acetaminophen", "RZVAJINKPMORJF-UHFFFAOYSA-N"],
  ["Tylenol", "RZVAJINKPMORJF-UHFFFAOYSA-N"],
  ["sucrose", "CZMRCDWAGMRECN-UGDNZRGBSA-N"],
  ["cholesterol", "HVYWMOMLDIMFJA-DPAQBDIFSA-N"],
  ["dopamine", "VYFYYTLLBUKUHU-UHFFFAOYSA-N"],
  ["serotonin", "QZAYGJVTTNCVMB-UHFFFAOYSA-N"],
  ["adrenaline", "UCTWMZQNUQWSLP-VIFPVBQESA-N"],
  ["epinephrine", "UCTWMZQNUQWSLP-VIFPVBQESA-N"],
  ["codeine", "OROGSEYTTFOCAN-DNJOTXNNSA-N"],
  ["quinine", "LOUPRKONTZGTKE-WZBLMQSHSA-N"],
  ["menthol", "NOOLISFMXDJSKH-UHFFFAOYSA-N"],
  ["vanillin", "MWOOGOJBHIARFG-UHFFFAOYSA-N"]
] as const;

describe("common names in the committed offline dictionary", () => {
  it.each(["glucose", "D-glucose"])("refuses %s: the selected source has no stereochemically supported representative", async name => {
    // The 2026-11-09 cached SMILES+Wikipedia selection has neither name, nor
    // WQZGKKKJIJFFOK-GASJEMHNSA-N (D-glucopyranose, no anomeric stereo), nor
    // GZCGUPFRVQAUEE-SLPGGIOYSA-N (open-chain D-glucose). Its glucopyranose
    // rows are WQZGKKKJIJFFOK-UHFFFAOYSA-N: ALL stereocentres unspecified.
    // Assigning these names to that row would discard D stereo. OPSIN itself
    // reads glucose/D-glucose as the open chain, so it cannot confirm a ring.
    expect(await dictionary(name)).toBeUndefined();
    expect(await resolveChemicalName(name, async () => ({ failureReason: "Synthetic OPSIN parse miss" }), dictionary))
      .toMatchObject({ source: "opsin", failureReason: expect.stringContaining("OPSIN and the offline Wikidata dictionary could not interpret") });
  });

  it.each(commonNames)("resolves %s through the shared fallback to %s", async (name, inchiKey) => {
    const opsin = vi.fn(async () => ({ failureReason: "Synthetic OPSIN parse miss" }));
    const result = await resolveChemicalName(name, opsin, dictionary);
    expect(opsin).toHaveBeenCalledExactlyOnceWith(name);
    expect(result).toMatchObject({ source: "dictionary", smiles: expect.any(String) });
    const identifiers = await computeStructureIdentifiers(result.smiles!);
    expect(identifiers?.inchiKey).toBe(inchiKey);
  });
});
