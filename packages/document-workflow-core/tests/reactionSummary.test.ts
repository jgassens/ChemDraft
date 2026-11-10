import { describe, expect, it } from "vitest";
import { createEmptyDocument, deserializeDocument, serializeDocument, type ReactionObject } from "@chemdraft/chem-core";
import { documentInventory, documentReactionSummary } from "../src/index";

function reaction(id: string, reactant: string, product: string): ReactionObject {
  return {
    id, type: "reaction", x: 0, y: 0, width: 200, height: 60, rotation: 0, style: {},
    components: [{ role: "reactant", objectId: reactant }, { role: "product", objectId: product }],
    conditionsTextObjectIds: ["conditions"], arrowObjectIds: [`${id}_arrow`], plusObjectIds: [], mappingState: "absent"
  };
}

describe("native reaction summary", () => {
  it("exposes ordered roles and shared intermediate ids through the document inventory", () => {
    const document = createEmptyDocument();
    const first = reaction("first", "a", "intermediate");
    document.pages[0].objects = [
      first, reaction("second", "intermediate", "b"),
      { id: "conditions", type: "text", text: "25 °C", spans: [], x: 0, y: 0, width: 30, height: 20, rotation: 0, style: {} }
    ];
    first.components.push({ role: "agent", objectId: "catalyst" });
    const steps = documentReactionSummary(document);
    expect(steps.map(step => step.reactionId)).toEqual(["first", "second"]);
    expect(steps[0].components).toEqual([
      { role: "reactant", objectId: "a" }, { role: "product", objectId: "intermediate" }, { role: "agent", objectId: "catalyst" }
    ]);
    expect(steps[1].components[0].objectId).toBe(steps[0].components[1].objectId);
    expect(steps[0].conditions).toEqual([{ objectId: "conditions", text: "25 °C" }]);
    expect(documentInventory(document).reactions).toEqual(steps);
    expect(documentReactionSummary(deserializeDocument(serializeDocument(document)))).toEqual(steps);
  });

  it("reads older native reactions without the optional arrow and plus links", () => {
    const document = createEmptyDocument();
    const older = reaction("older", "a", "b");
    delete older.arrowObjectIds;
    delete older.plusObjectIds;
    document.pages[0].objects.push(older);
    expect(documentReactionSummary(document)[0]).toMatchObject({ arrowObjectIds: [], plusObjectIds: [] });
    const restored = deserializeDocument(serializeDocument(document));
    expect(restored.pages[0].objects[0]).not.toHaveProperty("arrowObjectIds");
  });

  it("returns detached summary arrays so callers cannot mutate native roles", () => {
    const document = createEmptyDocument();
    const step = reaction("r", "a", "b");
    document.pages[0].objects.push(step);
    const result = documentReactionSummary(document)[0];
    result.components[0].role = "agent";
    result.arrowObjectIds.push("unrelated");
    expect(step.components[0].role).toBe("reactant");
    expect(step.arrowObjectIds).toEqual(["r_arrow"]);
  });
});
