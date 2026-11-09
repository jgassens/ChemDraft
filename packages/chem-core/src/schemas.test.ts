import { describe, expect, it } from "vitest";
import { createEmptyDocument, deserializeDocument } from "./document";
import { ChemDraftDocumentSchema, TextObjectSchema } from "./schemas";

const attachment = {
  kind: "conditions", parentObjectId: "arrow", side: "above",
  frame: { origin: { x: 100, y: 100 }, tangent: { x: 1, y: 0 }, normal: { x: 0, y: -1 } },
  offset: { x: 0, y: 30 }
};
const base = { id: "object", x: 0, y: 0, width: 20, height: 20, rotation: 0, style: {} };

describe("conditions attachment schema", () => {
  it("accepts conditions only on text, without adding a field to legacy text", () => {
    const text = { ...base, type: "text", text: "THF", spans: [] };
    expect(TextObjectSchema.parse({ ...text, arrowAttachment: attachment })).toHaveProperty("arrowAttachment", attachment);
    expect(TextObjectSchema.parse(text)).not.toHaveProperty("arrowAttachment");
  });

  it("rejects a molecule attachment using the existing strict unknown-field convention", () => {
    const document = createEmptyDocument();
    const molecule = { ...base, type: "molecule", structureFormat: "smiles", structure: "C" };
    expect(ChemDraftDocumentSchema.safeParse({ ...document, pages: [{ ...document.pages[0], objects: [molecule] }] }).success).toBe(true);
    const crafted = { ...document, pages: [{ ...document.pages[0], objects: [{ ...molecule, arrowAttachment: attachment }] }] };
    const result = ChemDraftDocumentSchema.safeParse(crafted);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({
      code: "unrecognized_keys", keys: ["arrowAttachment"], path: ["pages", 0, "objects", 0]
    }));
    expect(() => deserializeDocument(JSON.stringify(crafted))).toThrow("newer version of ChemDraft");
  });
});
