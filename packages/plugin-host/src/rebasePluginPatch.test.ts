import { applyPatch, createEmptyDocument, type BracketObject, type DocumentObject, type DocumentPatch } from "@chemdraft/chem-core";
import { ProposedDocumentPatchSchema } from "@chemdraft/plugin-api";
import { describe, expect, it } from "vitest";
import { rebasePluginPatch } from "./rebasePluginPatch";

const bracket = (id: string, pairId: string, side: "open" | "close"): BracketObject => ({
  id, type: "bracket", bracketKind: "square", pairId, side, repeatUnit: true, bracketUsage: "sru",
  ...(side === "close" ? { label: "n" } : {}), containedObjectIds: [],
  x: 100, y: 100, width: 10, height: 100, rotation: 0, style: {}
});

describe("shared plugin insertion rebasing", () => {
  it("allocates pair ids even without object-id collisions and reserves later pair names", () => {
    let document = createEmptyDocument();
    const pageId = document.pages[0].id;
    document = applyPatch(document, { op: "batch", patches: [bracket("old-open", "pair", "open"),
      bracket("old-close", "pair", "close")].map(object => ({ op: "addObject", pageId, object })) });
    const objects = [bracket("new-open", "pair", "open"), bracket("new-close", "pair", "close"),
      bracket("next-open", "pair_003", "open"), bracket("next-close", "pair_003", "close")];
    const proposed = ProposedDocumentPatchSchema.parse({ reason: "Pairs", patch: { op: "batch", patches: [
      ...objects.map(object => ({ op: "addObject", pageId, object })),
      { op: "updateObject", objectId: "new-close", changes: { pairId: "pair", label: "m" } }
    ] } });
    const rebased = rebasePluginPatch(document, proposed);
    const result = applyPatch(document, rebased.patch);
    const inserted = result.pages[0].objects.filter((object): object is BracketObject =>
      object.type === "bracket" && object.id.startsWith("new-"));
    expect(inserted).toHaveLength(2);
    expect(inserted[0].pairId).not.toBe("pair");
    expect(inserted[0].pairId).not.toBe("pair_003");
    expect(inserted[1]).toMatchObject({ pairId: inserted[0].pairId, repeatUnit: true, label: "m" });
    expect(result.pages[0].objects.slice(0, 2)).toEqual(document.pages[0].objects);
    if (proposed.patch.op !== "batch") throw new Error("Expected batch");
    expect(proposed.patch.patches[0]).toMatchObject({ object: { pairId: "pair" } });
  });

  it("remaps live preserved CDXML membership and step references while retaining source and local ids", () => {
    const empty = createEmptyDocument();
    const pageId = empty.pages[0].id;
    const molecule = { id: "mol", type: "molecule", x: 100, y: 100, width: 30, height: 10,
      rotation: 0, style: {}, structureFormat: "smiles", structure: "CC", atoms: [], bonds: [], superatoms: [], rGroups: [] } as const;
    const document = applyPatch(empty, { op: "addObject", pageId, object: { ...molecule, atoms: [], bonds: [], superatoms: [], rGroups: [] } });
    const unknown = {
      cdxmlBracketMembership: JSON.stringify(["mol"]), cdxmlBracketMemberObjectIds: ["mol"],
      cdxmlBracketMembers: [{ objectId: "mol", atomId: "mol", sourceId: "mol" }],
      cdxmlBracketCrossings: [{ ref: { objectId: "mol", bondId: "mol" }, attributes: { BondID: "mol" } }],
      cdxmlStepReferences: { ReactionStepReactants: ["mol"], opaque: "mol" },
      cdxmlBracketAtomSnapshots: [{ sourceId: "mol", atomId: "mol", element: "C", incidentBonds: [] }],
      opaque: { objectId: "mol" }
    };
    const object: DocumentObject = { ...bracket("open", "pair", "open"), containedObjectIds: ["mol"],
      compatibility: { originalId: "mol", warnings: [], unknown } };
    const proposed = ProposedDocumentPatchSchema.parse({ reason: "References", patch: { op: "batch", patches: [
      { op: "addObject", pageId, object: molecule }, { op: "addObject", pageId, object },
      { op: "updateObject", objectId: "open", changes: { compatibility: object.compatibility } }
    ] } });
    const rebased = rebasePluginPatch(document, proposed);
    if (rebased.patch.op !== "batch") throw new Error("Expected batch");
    const first = rebased.patch.patches[0];
    if (first.op !== "addObject") throw new Error("Expected insertion");
    const id = first.object.id;
    expect(id).not.toBe("mol");
    const expected = { originalId: "mol", warnings: [], unknown: { ...unknown,
      cdxmlBracketMembership: JSON.stringify([id]), cdxmlBracketMemberObjectIds: [id],
      cdxmlBracketMembers: [{ objectId: id, atomId: "mol", sourceId: "mol" }],
      cdxmlBracketCrossings: [{ ref: { objectId: id, bondId: "mol" }, attributes: { BondID: "mol" } }],
      cdxmlStepReferences: { ReactionStepReactants: [id], opaque: "mol" }
    } };
    expect(rebased.patch.patches[1]).toMatchObject({ object: { compatibility: expected } });
    expect(rebased.patch.patches[2]).toMatchObject({ changes: { compatibility: expected } });
    expect(object.compatibility?.unknown).toEqual(unknown);
  });

  it("checks removals within one atomic draft without stripping transient bracket metadata", () => {
    const document = createEmptyDocument();
    const pageId = document.pages[0].id;
    const patches: DocumentPatch[] = [bracket("open", "pair", "open"), bracket("close", "pair", "close")]
      .map(object => ({ op: "addObject", pageId, object }));
    patches.push({ op: "removeObject", objectId: "close" });
    let inspected = false;
    expect(() => applyPatch(document, { op: "batch", patches }, { beforeRemoveObjects: (draft, ids) => {
      inspected = true;
      expect(ids).toEqual(["close"]);
      expect(draft.pages[0].objects).toEqual([bracket("open", "pair", "open"), bracket("close", "pair", "close")]);
      throw new Error("Refused by host");
    } })).toThrow("Refused by host");
    expect(inspected).toBe(true);
    expect(document.pages[0].objects).toEqual([]);
  });
});
