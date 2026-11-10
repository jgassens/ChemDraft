import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { createNameDictionary, nameDictionaryUrl, resolveChemicalName } from "./nameDictionary";

const loadText = () => readFile(nameDictionaryUrl).then(bytes => gunzipSync(bytes).toString("utf8"));
const miss = async () => ({ failureReason: "OPSIN could not parse the supplied name" });

describe("offline name resolution", () => {
  it("uses OPSIN first and loads the dictionary only on a parse miss, once", async () => {
    const load = vi.fn(loadText);
    const dictionary = createNameDictionary(load);
    expect(load).not.toHaveBeenCalled();
    expect(await resolveChemicalName("ethanol", async () => ({ smiles: "CCO" }), dictionary))
      .toMatchObject({ smiles: "CCO", source: "opsin" });
    expect(load).not.toHaveBeenCalled();
    expect(await resolveChemicalName("Prozac", miss, dictionary)).toMatchObject({
      source: "dictionary", matchedName: "Prozac",
      smiles: "CNCCC(C1=CC=CC=C1)OC2=CC=C(C=C2)C(F)(F)F"
    });
    expect(await resolveChemicalName("CAS RN: [64-17-5]", miss, dictionary))
      .toMatchObject({ source: "dictionary", matchedCas: "64-17-5", smiles: "CCO" });
    expect(load).toHaveBeenCalledTimes(1);
    expect(await dictionary("64-17-6")).toBeUndefined();
    expect(await dictionary("p r o-z a c")).toMatchObject({ matchedName: "Prozac" });
    expect(await resolveChemicalName("no-such-chemical-name-xyz", miss, dictionary)).toMatchObject({
      failureReason: expect.stringContaining("OPSIN and the offline Wikidata dictionary could not interpret chemical name")
    });
  });

  it("does not turn engine failure into a dictionary match", async () => {
    const load = vi.fn(loadText);
    await expect(resolveChemicalName("Prozac", async () => { throw new Error("JVM failed"); }, createNameDictionary(load)))
      .rejects.toThrow("JVM failed");
    expect(load).not.toHaveBeenCalled();
  });
});
