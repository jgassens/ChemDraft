import { describe, expect, it } from "vitest";
import { createEmptyDocument, type DocumentObject, type TextObject } from "@chemdraft/chem-core";
import { resolveArrowAttachments, withArrowAttachmentIds } from "./arrowAttachments";

const base = { x: 40, y: 60, width: 80, height: 24, rotation: 0, style: {} };
const attachment = { kind: "conditions" as const, parentObjectId: "arrow", side: "above" as const,
  frame: { origin: { x: 100, y: 100 }, tangent: { x: 1, y: 0 }, normal: { x: 0, y: -1 } },
  offset: { x: 0, y: 30 } };
const label: TextObject = { ...base, id: "label", type: "text", text: "THF", spans: [], arrowAttachment: attachment };

describe("conditions lifecycle guards", () => {
  it("never expands an arrow operation to a crafted non-text object or another attachment kind", () => {
    const molecule = { ...base, id: "molecule", type: "molecule", structureFormat: "smiles", structure: "C",
      atoms: [], bonds: [], superatoms: [], rGroups: [], arrowAttachment: attachment } as DocumentObject;
    const foreign = { ...label, id: "foreign", arrowAttachment: { ...attachment, kind: "other" } } as unknown as TextObject;
    expect(withArrowAttachmentIds([molecule, foreign, label], ["arrow"])).toEqual(["arrow", "label"]);
  });

  it("reconciles only conditions text, even when invalid objects bypass loading", () => {
    const molecule = { ...base, id: "molecule", type: "molecule", structureFormat: "smiles", structure: "C",
      atoms: [], bonds: [], superatoms: [], rGroups: [], arrowAttachment: attachment } as DocumentObject;
    const foreign = { ...label, id: "foreign", arrowAttachment: { ...attachment, kind: "other" } } as unknown as TextObject;
    const page = { ...createEmptyDocument().pages[0], objects: [molecule, foreign, label] };
    const resolved = resolveArrowAttachments(page);
    expect(resolved.objects[0]).toBe(molecule);
    expect(resolved.objects[1]).toBe(foreign);
    expect(resolved.objects[2]).not.toHaveProperty("arrowAttachment");
    const invalidOnly = { ...page, objects: [molecule, foreign] };
    expect(resolveArrowAttachments(invalidOnly)).toBe(invalidOnly);
  });
});
