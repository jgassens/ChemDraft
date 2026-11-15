import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { createNameDictionary, nameDictionaryUrl, resolveChemicalName } from "./nameDictionary";

const loadText = () => readFile(nameDictionaryUrl).then(bytes => gunzipSync(bytes).toString("utf8"));
const miss = async () => ({ failureReason: "OPSIN could not parse the supplied name" });

describe("offline name resolution", () => {
  it("accepts exact column-5 names only after an OPSIN miss, without fuzzy matching", async () => {
    const dictionary = createNameDictionary(async () =>
      "CC(=O)Oc1ccccc1C(=O)O\t!ASA\t50-78-2\tBSYNRYMUTXBXSQ-UHFFFAOYSA-N\tacetylsalicylic acid|Aspirin\n");
    expect(await resolveChemicalName("acetylsalicylic acid", miss, dictionary)).toMatchObject({
      source: "dictionary", matchedName: "acetylsalicylic acid", smiles: "CC(=O)Oc1ccccc1C(=O)O"
    });
    expect(await resolveChemicalName("aspirin", async () => ({ smiles: "OPSIN result" }), dictionary))
      .toMatchObject({ source: "opsin", smiles: "OPSIN result" });
    expect(await dictionary("ASPIRIN")).toMatchObject({ matchedName: "Aspirin" });
    expect(await dictionary("ASA")).toMatchObject({ matchedName: "ASA" });
    expect(await dictionary("aspirin typo")).toBeUndefined();
  });

  it("rejects cross-compound name collisions in either column, in either row order", async () => {
    const rows = [
      "CCO\tethanol|shared name\t64-17-5\tLFQSCWFLJHTTHZ-UHFFFAOYSA-N\tcolumn five collision|alcohol",
      "O\twater|column five collision\t7732-18-5\tXLYOFNOQVPJJNP-UHFFFAOYSA-N\tShared name|alcohol",
      "CCO\tSHARED NAME\t\tLFQSCWFLJHTTHZ-UHFFFAOYSA-N\t"
    ];
    for (const ordered of [rows, [...rows].reverse()]) {
      const dictionary = createNameDictionary(async () => ordered.join("\n"));
      for (const name of ["shared name", "column five collision", "alcohol"]) expect(await dictionary(name)).toBeUndefined();
      expect(await dictionary("ethanol")).toMatchObject({ smiles: "CCO" });
    }
  });

  it("allows duplicate names for the same InChIKey with differently written SMILES", async () => {
    const dictionary = createNameDictionary(async () => [
      "CCO\tethanol\t\tLFQSCWFLJHTTHZ-UHFFFAOYSA-N\talcohol",
      "OCC\t\t\tLFQSCWFLJHTTHZ-UHFFFAOYSA-N\tAlcohol"
    ].join("\n"));
    expect(await dictionary("alcohol")).toMatchObject({ smiles: "CCO" });
  });

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
    expect(await dictionary("p r o z a c")).toMatchObject({ matchedName: "Prozac" });
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

  it("keeps primed locants separate while folding case, whitespace and dashes", async () => {
    const names = ["N'-Methylnicotinamide", "N-methylnicotinamide", "N''-methyl", "N'-methyl",
      "1'-methyl", "1-methyl", "2'-methyl", "2-methyl", "alpha-name", "beta-name", "α-name", "β-name",
      "(+)-name", "(-)-name"];
    const dictionary = createNameDictionary(async () => names.map((name, i) =>
      `synthetic-${i}\t${name}\t\tidentity-${i}\t`).join("\n"));
    for (const [i, name] of names.entries()) {
      expect(await dictionary(name)).toMatchObject({ smiles: `synthetic-${i}` });
      expect(await dictionary(` ${name.toUpperCase().replace(/-/g, " - ")} `)).toMatchObject({ smiles: `synthetic-${i}` });
    }
  });

  it("folds dash, prime and dot typography without dropping primed locants", async () => {
    const dictionary = createNameDictionary(async () => [
      "beta\tbeta-carotene\t\tidentity-beta\t",
      "primed\tN'-methylnicotinamide\t\tidentity-primed\t",
      "unprimed\tN-methylnicotinamide\t\tidentity-unprimed\t",
      "one-prime\t1'-\t\tidentity-one-prime\t",
      "one\t1-\t\tidentity-one\t",
      "double-prime\t1''-\t\tidentity-double-prime\t",
      "dot\tname·hydrate\t\tidentity-dot\t"
    ].join("\n"));
    for (const name of ["beta-carotene", "betacarotene", "beta–carotene"]) {
      expect(await dictionary(name)).toMatchObject({ smiles: "beta" });
    }
    for (const dash of ["-", "‐", "‑", "‒", "–", "—", "―", "−", "﹣", "－"]) {
      expect(await dictionary(`N${dash}methyl nicotinamide`)).toMatchObject({ smiles: "unprimed" });
    }
    for (const prime of ["'", "’", "ʼ", "′", "‘", "\u0060"]) {
      expect(await dictionary(`N${prime}-methylnicotinamide`)).toMatchObject({ smiles: "primed" });
      expect(await dictionary(`1${prime}-`)).toMatchObject({ smiles: "one-prime" });
      for (const second of ["'", "’", "ʼ", "′", "‘", "\u0060"]) {
        expect(await dictionary(`1${prime}${second}-`)).toMatchObject({ smiles: "double-prime" });
      }
    }
    expect(await dictionary("1-")).toMatchObject({ smiles: "one" });
    expect(await dictionary("1″-")).toMatchObject({ smiles: "double-prime" });
    for (const dot of [".", "•", "∙", "⋅", "·"]) {
      expect(await dictionary(`name${dot}hydrate`)).toMatchObject({ smiles: "dot" });
    }
  });

  it("refuses collisions created by deleting hyphens, across columns and row orders", async () => {
    const rows = [
      "CCO\tfirst-name\t\tLFQSCWFLJHTTHZ-UHFFFAOYSA-N\t",
      "O\twater\t\tXLYOFNOQVPJJNP-UHFFFAOYSA-N\tfirstname",
      "OCC\tFIRST–NAME\t\tLFQSCWFLJHTTHZ-UHFFFAOYSA-N\t"
    ];
    for (const ordered of [rows, [...rows].reverse()]) {
      const dictionary = createNameDictionary(async () => ordered.join("\n"));
      for (const name of ["first-name", "firstname", "first–name"]) expect(await dictionary(name)).toBeUndefined();
      expect(await dictionary("water")).toMatchObject({ smiles: "O" });
    }
  });
});
