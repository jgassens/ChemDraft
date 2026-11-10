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

// Preserve full identity comparisons; never accept a different anomer or stereoisomer.
const commonNames = [
  ["aspirin", "BSYNRYMUTXBXSQ-UHFFFAOYSA-N"],
  ["Aspirin", "BSYNRYMUTXBXSQ-UHFFFAOYSA-N"],
  ["ibuprofen", "HEFNNWSXXWATRW-UHFFFAOYSA-N"],
  ["caffeine", "RYYVLZVUVIJVGH-UHFFFAOYSA-N"],
  ["morphine", "BQJCRHHNABKAKU-KBQPJGBKSA-N"],
  ["penicillin G", "JGSARLDLIJGVTE-MBNYWOFBSA-N"],
  ["paracetamol", "RZVAJINKPMORJF-UHFFFAOYSA-N"],
  ["acetaminophen", "RZVAJINKPMORJF-UHFFFAOYSA-N"],
  ["Tylenol", "RZVAJINKPMORJF-UHFFFAOYSA-N"],
  ["sucrose", "CZMRCDWAGMRECN-UGDNZRGBSA-N"],
  ["cholesterol", "HVYWMOMLDIMFJA-DPAQBDIFSA-N"],
  ["dopamine", "VYFYYTLLBUKUHU-UHFFFAOYSA-N"],
  ["serotonin", "QZAYGJVTTNCVMB-UHFFFAOYSA-N"],
  ["epinephrine", "UCTWMZQNUQWSLP-VIFPVBQESA-N"],
  ["codeine", "OROGSEYTTFOCAN-DNJOTXNNSA-N"],
  ["quinine", "LOUPRKONTZGTKE-WZBLMQSHSA-N"],
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

  // OPSIN resolves these first, without stereochemistry; the accuracy gate excludes
  // them from the dictionary rather than supplying a conflicting stereo identity.
  it.each(["nicotine", "adrenaline", "menthol"])("does not supply OPSIN-first name %s from the dictionary", async name => {
    expect(await dictionary(name)).toBeUndefined();
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
