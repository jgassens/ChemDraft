import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ChemDraftDocumentSchema, MoleculeBondSchema, MoleculeBondDisplaySchema } from "./schemas";
import { createEmptyDocument, deserializeDocument, migrateDocument, serializeDocument } from "./document";
import { snapshotChemicalIdentity, diffChemicalIdentity } from "./identity";
import { CORPUS } from "./corpus";
import baseline from "../../fixtures/open-double-bonds/serializer-baseline.json";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

describe("open double-bond storage", () => {
  it("retains v1, stores only an explicit either, and rejects other bond orders specifically", () => {
    const bond = { id: "b", fromAtomId: "a", toAtomId: "c", order: "double" };
    expect(MoleculeBondSchema.parse({ ...bond, stereo: "either" })).toMatchObject({ stereo: "either" });
    expect(MoleculeBondSchema.parse(bond)).not.toHaveProperty("stereo");
    expect(MoleculeBondSchema.parse({ ...bond, stereo: undefined })).not.toHaveProperty("stereo");
    for (const order of ["single", "triple", "aromatic", "unknown"]) {
      const result = MoleculeBondSchema.safeParse({ ...bond, order, stereo: "either" });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({
        path: ["stereo"], message: 'Bond stereo "either" is valid only for a double bond.'
      }));
    }
    const document = deserializeDocument(read("packages/fixtures/open-double-bonds/open.json"));
    expect(document.schema).toBe("chemdraft.document.v1");
    expect(serializeDocument(document)).toContain('"stereo": "either"');
  });

  it("matches TODAY's pre-change serializer for every existing JSON fixture and corpus document", () => {
    for (const [path, expected] of Object.entries(baseline)) {
      let input: string;
      if (path.startsWith("corpus:")) {
        const entry = CORPUS.find((item) => `corpus:${item.id}` === path)!;
        const doc = createEmptyDocument({ now: "2026-10-27T00:00:00.000Z" });
        doc.pages[0]!.objects.push(entry.mol);
        input = JSON.stringify(doc);
      } else input = read(path);
      const loaded = deserializeDocument(input);
      const saved = serializeDocument(loaded);
      expect(createHash("sha256").update(saved).digest("hex"), path).toBe(expected);
      expect(saved).not.toContain('"stereo"');
    }
  });

  it("never backfills a legacy graph whose stored molfile disagrees with geometry", () => {
    const doc = deserializeDocument(read("packages/fixtures/open-double-bonds/open.json"));
    const mol = doc.pages[0]!.objects[0]!;
    if (mol.type !== "molecule") throw new Error("Expected molecule");
    mol.bonds.forEach((bond) => { delete bond.stereo; });
    const legacy = serializeDocument(doc);
    expect(serializeDocument(deserializeDocument(legacy))).toBe(legacy);
    expect(deserializeDocument(legacy).pages[0]!.objects[0]).toEqual(mol);
  });

  it("includes either intent in coordinate-independent graph identity", () => {
    const doc = deserializeDocument(read("packages/fixtures/open-double-bonds/open.json"));
    const mol = doc.pages[0]!.objects[0]!;
    if (mol.type !== "molecule") throw new Error("Expected molecule");
    const before = snapshotChemicalIdentity(mol);
    const geometryDefined = { ...mol, bonds: mol.bonds.map(({ stereo: _stereo, ...bond }) => bond) };
    expect(diffChemicalIdentity(before, snapshotChemicalIdentity(geometryDefined)).verdict).toBe("changed");
    expect(snapshotChemicalIdentity({ ...mol, atoms: mol.atoms.map((a) => ({ ...a, x: a.x + 40 })) }).graph)
      .toEqual(before.graph);
  });

  it("the pre-change strict bond schema rejects either with the existing newer-version explanation", () => {
    const doc = deserializeDocument(read("packages/fixtures/open-double-bonds/open.json"));
    // Exactly the old strict shape: no stereo key and no new refinement/transform.
    const oldBond = z.object({ id: z.string(), fromAtomId: z.string(), toAtomId: z.string(),
      order: z.enum(["single", "double", "triple", "aromatic", "unknown"]).default("single"),
      display: MoleculeBondDisplaySchema.optional() }).strict();
    const oldDocument = ChemDraftDocumentSchema.superRefine((candidate, ctx) => {
      candidate.pages.forEach((page, p) => page.objects.forEach((obj, o) => {
        if (obj.type !== "molecule") return;
        obj.bonds.forEach((bond, b) => {
          const result = oldBond.safeParse(bond);
          if (!result.success) result.error.issues.forEach((issue) => ctx.addIssue({ ...issue,
            path: ["pages", p, "objects", o, "bonds", b, ...issue.path] }));
        });
      }));
    });
    const spy = vi.spyOn(ChemDraftDocumentSchema, "safeParse").mockImplementation(oldDocument.safeParse.bind(oldDocument));
    try {
      expect(() => migrateDocument(doc)).toThrow("The file may have been saved by a newer version of ChemDraft.");
    } finally { spy.mockRestore(); }
  });
});
