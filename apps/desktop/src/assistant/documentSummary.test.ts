import { describe, expect, it } from "vitest";
import { documentSummary, SUMMARY_MAX_BYTES } from "./documentSummary";
import { recordAssistantInsertions } from "./AssistantToolContext";
import { testContext } from "./tools/testContext";

describe("assistant summary", () => {
  it("marks scope from Send plus inserted ids, never the live selection", async () => {
    const { context, molecule, text } = testContext();
    context.getDocument()!.selection.objectIds = [text.id];
    let result = await documentSummary(context);
    expect(result.objects.map(object => [object.id, object.inScope])).toEqual([[molecule.id, true], [text.id, false]]);
    recordAssistantInsertions(context, [text.id]);
    result = await documentSummary(context);
    expect(result.objects.every(object => object.inScope)).toBe(true);
    expect(result.selection.objectIds).toEqual([molecule.id]);
  });
  it("caps objects, text, title, pages and bytes", async () => {
    const { context, text } = testContext(false);
    const document = context.getDocument()!;
    document.title = "Title".repeat(1000);
    document.pages[0]!.objects = Array.from({ length: 501 }, (_, index) => ({ ...text, id: `id_${index}`, text: "caption".repeat(3000) }));
    const result = await documentSummary(context, { maxObjects: 500 });
    expect(result.truncated).toBe(true);
    expect(result.objects.length).toBeLessThan(500);
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
    expect(result.counts.text).toBe(501);
    expect(result.objects.every(object => object.inScope === false)).toBe(true);
  });
  it("bounds large page lists and imported selection ids", async () => {
    const { context } = testContext(false);
    const document = context.getDocument()!;
    const page = document.pages[0]!;
    document.pages = Array.from({ length: 400 }, (_, index) => ({ ...page, id: `${index}_${"x".repeat(1000)}`, objects: [] }));
    context.getSelectionAtSend = () => Array.from({ length: 500 }, (_, index) => `${index}_${"id".repeat(500)}`);
    const result = await documentSummary(context);
    expect(result.truncated).toBe(true);
    expect(result.pages.length).toBeLessThan(400);
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
  });
  it("enforces the requested object cap and skips chemistry when requested", async () => {
    const { context } = testContext();
    const result = await documentSummary(context, { maxObjects: 1, includeSmiles: false });
    expect(result.objects).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(context.chemistry.inspectStructure).not.toHaveBeenCalled();
  });
  it("reports an empty fixed selection", async () => {
    const { context } = testContext(false);
    expect(await documentSummary(context, { objectIds: context.getSelectionAtSend() })).toMatchObject({ empty: true, objects: [] });
  });
  it("returns chemistry failure warnings without inventing SMILES", async () => {
    const { context } = testContext();
    context.chemistry.inspectStructure = async () => ({ valid: false, reason: "RDKit unavailable" });
    const result = await documentSummary(context);
    expect(result.objects[0]).toMatchObject({ warnings: ["RDKit unavailable"] });
    expect(result.objects[0]).not.toHaveProperty("smiles");
  });
});
