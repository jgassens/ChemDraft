import { beforeAll, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, DocumentStylePreset, type MoleculeObject } from "@chemdraft/chem-core";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import { compositionFromRdkitJson, ensureRdkit } from "../../rdkit-adapter/src/index";
import { structureTemplates, type StructureTemplate } from "../../template-library/src/index";
import { moleculeSmiles } from "../src/moleculeSmiles";
import {
  normalizeStructureTemplateName as normalize,
  resolveStructureTemplateName,
  structureTemplateForSmiles,
  structureTemplateMolecule
} from "../src/structureTemplates";

// Test-only registry extension exercises the real matcher before stereo-bearing families ship.
vi.mock("@chemdraft/template-library", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chemdraft/template-library")>();
  return { ...actual, structureTemplates: [...actual.structureTemplates, {
    id: "test-stereo", name: "Test stereo", synonyms: [], family: "cyclodextrins",
    category: "supramolecular", smiles: "F[C@H](Cl)Br", formula: "CHBrClF", charge: 0,
    source: { database: "PubChem", cid: null }, note: "Test-only stereochemical fixture.",
    layout: {
      atoms: [
        { element: "F", x: -1, y: 0 }, { element: "C", x: 0, y: 0 },
        { element: "Cl", x: 0.5, y: 0.866 }, { element: "Br", x: 0.5, y: -0.866 }
      ],
      bonds: [[1, 0, 1, "hash"], [1, 2, 1], [1, 3, 1]]
    }
  }] };
});

beforeAll(async () => { installNodeRdkitModuleLoader(); await ensureRdkit(); }, 60_000);

async function canonicalize(input: string): Promise<string | null> {
  const rdkit = await ensureRdkit();
  const mol = rdkit.get_mol(input);
  if (!mol) return null;
  try { return mol.get_smiles(); } finally { mol.delete(); }
}

function meanBondLength(molecule: MoleculeObject): number {
  const atoms = new Map(molecule.atoms.map((atom) => [atom.id, atom]));
  return molecule.bonds.reduce((sum, bond) => {
    const a = atoms.get(bond.fromAtomId)!, b = atoms.get(bond.toAtomId)!;
    return sum + Math.hypot(a.x - b.x, a.y - b.y);
  }, 0) / molecule.bonds.length;
}

describe("structure template spelling", () => {
  it.each([
    ["Β–cyclodextrin", "betacyclodextrin"], ["β cyclodextrin", "betacyclodextrin"],
    ["ALPHA-cyclodextrin", "alphacyclodextrin"], ["Α / ɑ / α", "alpha/alpha/alpha"],
    ["Γ δ Δ", "gammadeltadelta"], ["cucurbit[7]uril", "cucurbit7uril"],
    ["1,4-dimethoxy", "14dimethoxy"], ["4,1-dimethoxy", "41dimethoxy"],
    ["１８ − crown—6", "18crown6"], ["{(O′’'ʼ)}", "o"]
  ])("normalizes %s exactly", (input, expected) => expect(normalize(input)).toBe(expected));

  it.each(["18-CROWN-6", "18 crown 6", "18C6", "18–crown—6"])("resolves %s", (input) => {
    expect(resolveStructureTemplateName(input)?.id).toBe("18-crown-6");
  });
  it.each(["[2.2.2]cryptand", "Cryptand[2.2.2]", "2.2.2-Cryptand"])("resolves %s", (input) => {
    expect(resolveStructureTemplateName(input)?.id).toBe("2-2-2-cryptand");
  });
  it("never guesses a near miss", () => expect(resolveStructureTemplateName("18-crown-5")).toBeUndefined());
  it("resolves every registered name and synonym", () => {
    for (const entry of structureTemplates) {
      for (const name of [entry.name, ...entry.synonyms]) {
        expect(resolveStructureTemplateName(name)?.id, name).toBe(entry.id);
      }
    }
  });
});

describe("native structure templates", () => {
  it.each(structureTemplates.map((entry) => [entry.id, entry] as const))(
    "%s: document bond length, identity, formula and charge survive native construction",
    async (_id, entry) => {
      const document = createEmptyDocument();
      const before = structuredClone(entry);
      const centre = { x: 350, y: 400 };
      const molecule = structureTemplateMolecule(entry, { document, centre });
      let layoutScale = DocumentStylePreset.drawing.bondLengthPx;
      if (entry.projection === "perspective") {
        // Perspective templates scale by their longest non-stretched bond.
        const ordinaryBonds = entry.layout.bonds.filter(([a, b]) =>
          !entry.layout.stretchedBonds?.some(([c, d]) => a === c && b === d || a === d && b === c));
        const longestLayoutBond = Math.max(...ordinaryBonds.map(([a, b]) => {
          const from = entry.layout.atoms[a]!, to = entry.layout.atoms[b]!;
          return Math.hypot(to.x - from.x, to.y - from.y);
        }));
        const longestDocumentBond = Math.max(...ordinaryBonds.map(([a, b]) => {
          const from = molecule.atoms[a]!, to = molecule.atoms[b]!;
          return Math.hypot(to.x - from.x, to.y - from.y);
        }));
        expect(longestDocumentBond).toBeCloseTo(DocumentStylePreset.drawing.bondLengthPx, 9);
        layoutScale /= longestLayoutBond;
      } else {
        expect(meanBondLength(molecule)).toBeCloseTo(DocumentStylePreset.drawing.bondLengthPx, 6);
      }
      expect(molecule.style.bondLengthPx).toBe(DocumentStylePreset.drawing.bondLengthPx);
      for (const axis of ["x", "y"] as const) {
        const values = molecule.atoms.map((atom) => atom[axis]);
        expect((Math.min(...values) + Math.max(...values)) / 2).toBeCloseTo(centre[axis], 9);
      }
      expect(molecule.atoms[0]!.y - centre.y).toBeCloseTo(-entry.layout.atoms[0]!.y * layoutScale, 2);
      const warnings: Parameters<typeof moleculeSmiles>[2] = [];
      const smiles = await moleculeSmiles(molecule, 0, warnings, computeStructureIdentifiers);
      expect(warnings).toEqual([]);
      expect(await canonicalize(smiles)).toBe(await canonicalize(entry.smiles));
      const rdkit = await ensureRdkit();
      const parsed = rdkit.get_mol(smiles)!;
      try {
        const composition = compositionFromRdkitJson(JSON.parse(parsed.get_json()));
        expect(composition.formula).toBe(entry.formula);
        expect(composition.formalCharge).toBe(entry.charge);
      } finally { parsed.delete(); }
      expect(molecule.atoms.every((atom) => atom.hydrogenCount === undefined && !atom.labelLiteral)).toBe(true);
      expect(molecule.style.source).toBe(`structure-template:${entry.id}`);
      expect(document.pages[0]!.objects).toEqual([]);
      expect(entry).toEqual(before);
      expect((await structureTemplateForSmiles(entry.smiles, canonicalize))?.id).toBe(entry.id);
    }
  );

  it("uses an explicit target drawing style and retains centres outside page margins", () => {
    const molecule = structureTemplateMolecule(structureTemplates[0]!, {
      document: createEmptyDocument(), centre: { x: 0, y: 0 }, style: { bondLengthPx: 31, bondColor: "#123456" }
    });
    expect(meanBondLength(molecule)).toBeCloseTo(31, 9);
    expect(molecule.style.bondColor).toBe("#123456");
    expect(Math.min(...molecule.atoms.map((atom) => atom.x)) + Math.max(...molecule.atoms.map((atom) => atom.x))).toBeCloseTo(0, 9);
  });

  it("preserves charges and directed wedge/hash display in the shared builder", () => {
    const original = structureTemplates[0]!;
    const fixture: StructureTemplate = { ...original, layout: {
      atoms: original.layout.atoms.map((atom, index) => index === 2 ? { ...atom, charge: 1 } : atom),
      bonds: original.layout.bonds.map(([a, b, order], index) => [a, b, order, index % 2 ? "hash" : "wedge"])
    } };
    const molecule = structureTemplateMolecule(fixture, { document: createEmptyDocument(), centre: { x: 300, y: 300 } });
    expect(molecule.atoms[2]!.formalCharge).toBe(1);
    molecule.bonds.forEach((bond, index) => {
      expect(bond.fromAtomId).toBe(`a${fixture.layout.bonds[index]![0]}`);
      expect(bond.display?.bondStyle).toBe(index % 2 ? "hashed" : "wedge");
    });
  });
});

/** Reuse with each future stereo-bearing family; also refuses unspecified stereo. */
async function expectStereoMismatch(identity: string, different: string, expectedId: string) {
  expect((await structureTemplateForSmiles(identity, canonicalize))?.id).toBe(expectedId);
  expect(await canonicalize(identity)).not.toBe(await canonicalize(different));
  expect(await structureTemplateForSmiles(different, canonicalize)).toBeUndefined();
}

describe("exact isomeric matching", () => {
  it("does not canonicalize the host catalog for an ordinary small molecule", async () => {
    const canonical = vi.fn(canonicalize);
    expect(await structureTemplateForSmiles("CCO", canonical)).toBeUndefined();
    expect(canonical).toHaveBeenCalledExactlyOnceWith("CCO");
  });

  it("matches a reordered equivalent SMILES", async () => {
    expect((await structureTemplateForSmiles("O1CCOCCOCCOCCOCCOCC1", canonicalize))?.id).toBe("18-crown-6");
  });
  it("refuses a protonated cryptand", async () => {
    const cryptand = structureTemplates.find((entry) => entry.id === "2-2-2-cryptand")!;
    expect(await structureTemplateForSmiles(cryptand.smiles.replace("N2", "[NH+]2"), canonicalize)).toBeUndefined();
  });
  it("refuses opposite or absent stereochemistry", async () => {
    await expectStereoMismatch("F[C@H](Cl)Br", "F[C@@H](Cl)Br", "test-stereo");
    await expectStereoMismatch("F[C@H](Cl)Br", "FC(Cl)Br", "test-stereo");
  });
  it("caches template canonical forms per function, including concurrent calls", async () => {
    const canonical = vi.fn(canonicalize);
    await Promise.all([structureTemplateForSmiles("CC", canonical), structureTemplateForSmiles("CO", canonical)]);
    const firstCount = canonical.mock.calls.length;
    await structureTemplateForSmiles("CN", canonical);
    expect(canonical.mock.calls.length).toBe(firstCount + 1);
    const other = vi.fn(canonicalize);
    await structureTemplateForSmiles("CC", other);
    expect(other.mock.calls.length).toBe(firstCount - 1);
    expect(await structureTemplateForSmiles("invalid", canonical)).toBeUndefined();
  });
});
