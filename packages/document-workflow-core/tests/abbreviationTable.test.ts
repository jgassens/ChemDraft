// The abbreviation table's data against the element table, the native valence model, and RDKit's own
// reading of each entry's SMILES. The table lives in template-library (data only); the checks that need
// element knowledge or an engine live here.

import { beforeAll, describe, expect, it } from "vitest";
import { compositionFromRdkitJson, ensureRdkit, type RdkitJson } from "@chemdraft/rdkit-adapter";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import {
  abbreviationDefinitions,
  abbreviationElementCounts,
  abbreviationSpellings,
  isGenericAtomLabel
} from "@chemdraft/template-library";

import {
  nativeAtomLabelReading,
  nativeElementFromAtomLabel,
  nativeImplicitHydrogenCount,
  nativeLabelGroupVerdict,
  nativeSingleHeavyElementLabelValence,
  type NativeElementSymbol
} from "../src/index";

interface RdkitMol {
  get_smiles(): string;
  get_json(): string;
  delete(): void;
}

let rdkit: { get_mol(input: string): RdkitMol | null };

beforeAll(async () => {
  installNodeRdkitModuleLoader();
  rdkit = (await ensureRdkit()) as unknown as typeof rdkit;
}, 60_000);

function rdkitFormula(smiles: string): string {
  const mol = rdkit.get_mol(smiles);
  if (!mol) throw new Error(`RDKit could not parse ${smiles}`);
  try {
    return compositionFromRdkitJson(JSON.parse(mol.get_json()) as RdkitJson).formula;
  } finally {
    mol.delete();
  }
}

function hill(counts: ReadonlyMap<string, number>): string {
  const symbols = [...counts.keys()];
  const ordered = counts.has("C")
    ? ["C", ...(counts.has("H") ? ["H"] : []), ...symbols.filter((symbol) => symbol !== "C" && symbol !== "H").sort()]
    : symbols.sort();
  return ordered.map((symbol) => `${symbol}${counts.get(symbol) === 1 ? "" : counts.get(symbol)}`).join("");
}

describe("the abbreviation table against the element table", () => {
  it.each(abbreviationSpellings.map((spelling) => [spelling]))("%s reads as a group and as nothing else", (spelling) => {
    // Elements win over the table, so a spelling that is also an element could never be reached.
    // nativeElementFromAtomLabel ignores case: "CN" would be copernicium, which is why cyano is absent.
    expect(nativeElementFromAtomLabel(spelling)).toBeUndefined();
    expect(nativeSingleHeavyElementLabelValence(spelling)).toBeUndefined();
    expect(isGenericAtomLabel(spelling)).toBe(false);
    expect(nativeAtomLabelReading(spelling).kind).toBe("group");
  });

  it.each(abbreviationDefinitions.map((definition) => [definition.label, definition] as const))(
    "%s states the hydrogens the valence model gives it, and fills with its one bond",
    (_label, definition) => {
      definition.atoms.forEach((groupAtom, index) => {
        expect(nativeElementFromAtomLabel(groupAtom.element)).toBe(groupAtom.element);
        if (index === 0) return;
        const used = definition.bonds
          .filter(([from, to]) => from === index || to === index)
          .reduce((sum, [, , order]) => sum + order, 0);
        expect(groupAtom.hydrogens).toBe(
          nativeImplicitHydrogenCount(groupAtom.element as NativeElementSymbol, used, groupAtom.charge ?? 0)
        );
      });
      const reading = nativeAtomLabelReading(definition.label);
      if (reading.kind !== "group") throw new Error("not a group");
      expect(nativeLabelGroupVerdict(reading.group, definition.attachmentCount, 0).valid).toBe(true);
      expect(nativeLabelGroupVerdict(reading.group, definition.attachmentCount + 1, 0).valid).toBe(false);
    }
  );
});

describe("the abbreviation table against RDKit", () => {
  it.each(abbreviationDefinitions.map((definition) => [definition.label, definition] as const))(
    "%s: the stated atoms and hydrogens are the SMILES RDKit reads",
    (_label, definition) => {
      // Cap the attachment with a methyl so the group is a whole molecule RDKit can read.
      const counts = abbreviationElementCounts(definition);
      counts.set("C", (counts.get("C") ?? 0) + 1);
      counts.set("H", (counts.get("H") ?? 0) + 3);
      expect(hill(counts)).toBe(rdkitFormula(`C${definition.smiles.slice(1)}`));
      // The group's net charge is what its atoms state.
      const charge = definition.atoms.reduce((sum, atom) => sum + (atom.charge ?? 0), 0);
      expect(charge).toBe(0);
    }
  );
});
