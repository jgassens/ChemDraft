import { beforeAll, describe, expect, it } from "vitest";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import { ensureRdkit } from "../../rdkit-adapter/src/index";
import { cyclodextrinsTemplates } from "../../template-library/src/structureTemplates/cyclodextrins";
import { resolveStructureTemplateName, structureTemplateForSmiles } from "../src/structureTemplates";

beforeAll(async () => { installNodeRdkitModuleLoader(); await ensureRdkit(); }, 60_000);

async function canonicalize(input: string): Promise<string | null> {
  const rdkit = await ensureRdkit();
  const molecule = rdkit.get_mol(input);
  if (!molecule) return null;
  try { return molecule.get_smiles(); } finally { molecule.delete(); }
}

describe("cyclodextrin stereochemical identity", () => {
  it("ships the six-, seven- and eight-glucose homologues", () => {
    expect(cyclodextrinsTemplates.map((entry) => entry.id)).toEqual([
      "alpha-cyclodextrin", "beta-cyclodextrin", "gamma-cyclodextrin"
    ]);
  });

  it.each(cyclodextrinsTemplates.map((entry) => [entry.id, entry] as const))(
    "%s: matches the identity but refuses a single inverted stereocentre",
    async (id, entry) => {
      const inverted = entry.smiles.replace(/@@?/, (stereo) => stereo === "@@" ? "@" : "@@");
      expect((await structureTemplateForSmiles(entry.smiles, canonicalize))?.id).toBe(id);
      const identity = await canonicalize(entry.smiles), different = await canonicalize(inverted);
      expect(identity).not.toBeNull();
      expect(different).not.toBeNull();
      expect(different).not.toBe(identity);
      expect(await structureTemplateForSmiles(inverted, canonicalize)).toBeUndefined();
    }
  );

  it.each(cyclodextrinsTemplates.map((entry) => [entry.id, entry] as const))(
    "%s: refuses unspecified stereochemistry",
    async (_id, entry) => {
      const unspecified = entry.smiles.replace(/@/g, "");
      expect(await canonicalize(unspecified)).not.toBeNull();
      expect(await canonicalize(unspecified)).not.toBe(await canonicalize(entry.smiles));
      expect(await structureTemplateForSmiles(unspecified, canonicalize)).toBeUndefined();
    }
  );

  it.each(cyclodextrinsTemplates.map((entry, index) => [entry.id, entry, index + 6] as const))(
    "%s: explicitly encodes all five stereocentres per glucose on substituent bonds",
    (_id, entry, units) => {
      const stereoBonds = entry.layout.bonds.filter((bond) => bond[3] !== undefined);
      expect(stereoBonds).toHaveLength(units * 5);
      expect(new Set(stereoBonds.map(([from]) => from)).size).toBe(units * 5);
      // A substituent bond is not part of a six-membered glucopyranose ring. Removing it
      // cannot leave a five-edge path back to its origin (unlike a wedged chair edge).
      for (const [from, to] of stereoBonds) {
        expect(entry.layout.atoms[from]?.element).toBe("C");
        let frontier = new Set([from]);
        for (let depth = 0; depth < 5; depth += 1) {
          const next = new Set<number>();
          for (const [a, b] of entry.layout.bonds) {
            if ((a === from && b === to) || (a === to && b === from)) continue;
            if (frontier.has(a)) next.add(b);
            if (frontier.has(b)) next.add(a);
          }
          frontier = next;
        }
        expect(frontier.has(to), `stereo bond ${from}-${to} must leave its chair`).toBe(false);
      }
    }
  );
});

describe("cyclodextrin names", () => {
  const spellings = [
    ["alpha", "α", "Α", "cyclomaltohexaose"],
    ["beta", "β", "Β", "cyclomaltoheptaose"],
    ["gamma", "γ", "Γ", "cyclomaltooctaose"]
  ] as const;
  it.each(spellings.flatMap(([word, greek, capital, alternate]) => [
    `${word}-cyclodextrin`, `${greek}-cyclodextrin`, `${capital}-CYCLODEXTRIN`,
    `${word} cyclodextrin`, alternate, `${greek}-CD`, `${word}-CD`
  ].map((name) => [name, `${word}-cyclodextrin`] as const)))(
    "resolves %s to %s", (name, id) => expect(resolveStructureTemplateName(name)?.id).toBe(id)
  );
});
