import { afterEach, describe, expect, it, vi } from "vitest";
import { ASSISTANT_TOOLS, callAssistantTool, listAssistantTools } from "./assistantTools";
import { toolJsonSchema, toolSchemas, type AssistantToolName } from "./tools/schemas";
import { testContext } from "./tools/testContext";

const validInputs: Record<AssistantToolName, unknown> = {
  list_commands: {}, run_command: { id: "layout.rotate90" },
  get_document: {}, get_selection: {}, get_structure: { objectId: "mol", format: "smiles" },
  render: { target: "document" }, name_to_structure: { name: "ethane" }, validate_smiles: { smiles: "CC" },
  structure_to_name: { objectId: "mol" }, insert_structures: { items: [{ kind: "molecule", smiles: "CC" }] },
  insert_reaction: { reactants: ["CC"], products: ["CC"] }, insert_text: { text: "caption" },
  edit_structure: { objectId: "mol", smiles: "CC" }, delete_objects: { objectIds: ["mol"] },
  style_objects: { objectIds: ["mol"], style: { color: "#112233" } }, move_objects: { objectIds: ["mol"], to: { arrange: "row" } }
};
afterEach(() => vi.useRealTimers());
describe("assistant catalog and schema mirrors", () => {
  it("ships every name in the amended table with its Zod-derived JSON schema", () => {
    expect(ASSISTANT_TOOLS.map(tool => tool.name).sort()).toEqual(Object.keys(validInputs).sort());
    expect(new Set(ASSISTANT_TOOLS.map(tool => tool.name)).size).toBe(16);
    for (const tool of ASSISTANT_TOOLS) {
      expect(tool.inputSchema).toEqual(toolJsonSchema(tool.name));
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(toolSchemas[tool.name].safeParse(validInputs[tool.name]).success).toBe(true);
      expect(toolSchemas[tool.name].safeParse({ ...(validInputs[tool.name] as object), surprise: true }).success).toBe(false);
      expect(tool.permissions.length).toBeGreaterThan(0);
      expect(tool.timeoutMs).toBeGreaterThan(0);
    }
  });
  it("exposes the numeric and size caps in the wire schemas", () => {
    const properties = (name: AssistantToolName) => toolJsonSchema(name).properties as Record<string, Record<string, unknown>>;
    expect(properties("get_document").maxObjects).toMatchObject({ maximum: 500, default: 200 });
    expect(properties("validate_smiles").smiles).toMatchObject({ maxLength: 5000 });
    expect(properties("name_to_structure").name).toMatchObject({ maxLength: 2000 });
    expect(properties("insert_text").text).toMatchObject({ maxLength: 2000 });
    expect(properties("insert_structures").items).toMatchObject({ minItems: 1, maxItems: 24 });
    expect(properties("insert_reaction").reactants).toMatchObject({ maxItems: 6 });
    expect(properties("insert_reaction").products).toMatchObject({ maxItems: 6 });
    expect(properties("render").maxDimensionPx).toMatchObject({ minimum: 256, maximum: 2048, default: 1568 });
    for (const name of ["delete_objects", "style_objects", "move_objects"] as const) {
      expect(properties(name).objectIds).toMatchObject({ minItems: 1, maxItems: 100 });
    }
  });
  it("advertises the strict group variant with the same label limits as its Zod mirror", () => {
    const schema = toolJsonSchema("insert_structures") as { properties: { items: { items: { anyOf: unknown[] } } } };
    expect(schema.properties.items.items.anyOf).toContainEqual(expect.objectContaining({
      type: "object", additionalProperties: false, required: ["kind", "label"],
      properties: { kind: { type: "string", const: "group" }, label: expect.objectContaining({ type: "string", minLength: 1, maxLength: 80 }) }
    }));
    for (const label of ["CH3", "Ph", "Boc", "OTs"]) {
      expect(toolSchemas.insert_structures.safeParse({ items: [{ kind: "group", label }] }).success).toBe(true);
    }
    for (const item of [{ kind: "group", label: "" }, { kind: "group", label: "x".repeat(81) },
      { kind: "group", label: "Ph", smiles: "C" }, { kind: "group" }]) {
      expect(toolSchemas.insert_structures.safeParse({ items: [item] }).success).toBe(false);
    }
  });
  it("advertises offset moves with the same finite bounds as Zod", () => {
    const schema = toolJsonSchema("move_objects") as { properties: { to: { anyOf: unknown[] } } };
    expect(schema.properties.to.anyOf).toContainEqual({
      type: "object", additionalProperties: false, required: ["by"],
      properties: { by: { type: "object", additionalProperties: false, required: ["dx", "dy"], properties: {
        dx: { type: "number", minimum: -5000, maximum: 5000 }, dy: { type: "number", minimum: -5000, maximum: 5000 }
      } } }
    });
    for (const by of [{ dx: -5000, dy: 5000 }, { dx: 100, dy: 0 }]) {
      expect(toolSchemas.move_objects.safeParse({ objectIds: ["mol"], to: { by } }).success).toBe(true);
    }
  });
  it.each([
    ["list_commands", { category: "all" }], ["run_command", { id: "" }],
    ["run_command", { id: "layout.rotate90", args: { objectIds: ["outside"] } }],
    ["get_document", { maxObjects: 501 }], ["get_document", { maxObjects: 0 }],
    ["get_structure", { objectId: "x", format: "xyz" }],
    ["render", { target: "document", maxDimensionPx: 2049 }],
    ["render", { target: "objects", objectIds: Array(51).fill("x") }],
    ["name_to_structure", { name: "x".repeat(2001) }], ["validate_smiles", { smiles: "C".repeat(5001) }],
    ["structure_to_name", { objectId: "" }],
    ["insert_structures", { items: Array(25).fill({ kind: "molecule", smiles: "C" }) }],
    ["insert_structures", { items: [] }],
    ["insert_reaction", { reactants: Array(7).fill("C"), products: ["C"] }],
    ["insert_reaction", { reactants: ["C"], products: ["C"], reagents: Array(4).fill("x") }],
    ["insert_reaction", { reactants: ["C"], products: ["C"], conditions: Array(4).fill("x") }],
    ["insert_text", { text: "x".repeat(2001) }], ["edit_structure", { objectId: "x", smiles: "C".repeat(5001) }],
    ["delete_objects", { objectIds: Array(101).fill("x") }],
    ["style_objects", { objectIds: Array(101).fill("x"), style: {} }],
    ["move_objects", { objectIds: Array(101).fill("x"), to: { arrange: "row" } }]
  ] as [AssistantToolName, unknown][])("enforces %s caps", (name, input) => {
    expect(toolSchemas[name].safeParse(input).success).toBe(false);
  });
  it("has read-only and idempotent hints on every read and chemistry tool", () => {
    for (const tool of listAssistantTools()) expect(tool.annotations).toEqual({
      readOnlyHint: !["run_command", "insert_structures", "insert_reaction", "insert_text", "edit_structure", "delete_objects", "style_objects", "move_objects"].includes(tool.name),
      idempotentHint: !["run_command", "insert_structures", "insert_reaction", "insert_text", "edit_structure", "delete_objects", "style_objects", "move_objects"].includes(tool.name)
    });
  });
});
describe("assistant calls", () => {
  it("checks permissions, pinned-tab lifetime, unknown tools and schemas before any effect", async () => {
    const { context, close } = testContext();
    expect((await callAssistantTool(context, "unknown", {})).isError).toBe(true);
    expect((await callAssistantTool(context, "insert_text", { text: "x", x: 42 })).isError).toBe(true);
    context.plugin.permissions = ["document.read"];
    expect((await callAssistantTool(context, "insert_text", { text: "x" })).isError).toBe(true);
    expect(context.write).not.toHaveBeenCalled();
    close();
    expect((await callAssistantTool(context, "get_document", {})).content[0]).toMatchObject({ text: expect.stringContaining("tab has closed") });
  });
  it("executes all read and chemistry tools against the pinned context", async () => {
    const { context, molecule } = testContext();
    for (const [name, input] of [
      ["get_document", {}], ["get_selection", {}], ["get_structure", { objectId: molecule.id, format: "smiles" }],
      ["get_structure", { objectId: molecule.id, format: "molfile" }], ["name_to_structure", { name: "ethane" }],
      ["validate_smiles", { smiles: "CC" }], ["structure_to_name", { objectId: molecule.id }]
    ] as const) expect((await callAssistantTool(context, name, input)).isError).not.toBe(true);
    expect(context.write).not.toHaveBeenCalled();
    expect((await callAssistantTool(context, "structure_to_name", { objectId: molecule.id })).structuredContent).toMatchObject({ status: "engineNotInstalled" });
  });
  it("returns a PNG MCP image and enforces dimensions, actual type and encoded size", async () => {
    const { context } = testContext();
    const rendered = await callAssistantTool(context, "render", { target: "document" });
    expect(rendered.isError).not.toBe(true);
    expect(rendered.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(context.render).toHaveBeenCalledWith(expect.stringContaining("<svg"), expect.objectContaining({ maxDimensionPx: 1568 }));
    context.render = async () => ({ bytes: new Uint8Array(4 * 1024 * 1024 + 1), width: 100, height: 100 });
    expect((await callAssistantTool(context, "render", { target: "document" })).isError).toBe(true);
    context.render = async () => ({ bytes: new Uint8Array(), width: 4000, height: 100 });
    expect((await callAssistantTool(context, "render", { target: "document" })).isError).toBe(true);
    expect((await callAssistantTool(context, "render", { target: "objects" })).isError).toBe(true);
    context.render = async () => ({ bytes: Uint8Array.of(1, 2, 3), width: 100, height: 100 });
    expect((await callAssistantTool(context, "render", { target: "document" })).isError).toBe(true);
    const largePng = new Uint8Array(3 * 1024 * 1024 + 1);
    largePng.set([137, 80, 78, 71, 13, 10, 26, 10]);
    context.render = async () => ({ bytes: largePng, width: 100, height: 100 });
    expect((await callAssistantTool(context, "render", { target: "document" })).content[0]).toMatchObject({ text: expect.stringContaining("Encoded PNG") });
  });
  it("prevents late writes after a timeout", async () => {
    vi.useFakeTimers();
    const { context } = testContext();
    let finish!: () => void;
    context.chemistry.structureFromSmiles = async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { available: true, built: true, object: context.getDocument()!.pages[0]!.objects[0]! };
    };
    const pending = callAssistantTool(context, "insert_structures", { items: [{ kind: "molecule", smiles: "CC" }] });
    await vi.advanceTimersByTimeAsync(60_001);
    expect((await pending).isError).toBe(true);
    finish();
    await vi.runAllTimersAsync();
    expect(context.write).not.toHaveBeenCalled();
  });
});
