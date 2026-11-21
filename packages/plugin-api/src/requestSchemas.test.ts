import { describe, expect, it, vi } from "vitest";
import {
  PluginApplyRequestPatchResultSchema, PluginApplyRequestPatchSchema, PluginInspectStructureResultSchema,
  PluginOpenToolSessionSchema, PluginPlanLayoutSchema, PluginPlanStyleSchema,
  PluginReadRequestResultSchema, PluginReadRequestSchema, PluginRenderRegionResultSchema,
  PluginRenderRegionSchema, PluginRequestContextResultSchema, PluginRequestLimits,
  PluginRequestPatchSchema, PluginRingsResultSchema, PluginToolCallSchema, PluginToolDefinitionSchema, requestValidationCode
} from "./index";

const requestId = "request";
const pageId = "page";
const request = { requestId, pageId };
const bounds = { x: 0, y: 0, width: 10, height: 10 };
const target = { kind: "region", bounds };
const tool = { name: "draw", description: "Draw a shape", inputSchema: { type: "object" } };
const move = { op: "moveObject", objectId: "m1", x: 0, y: 1 };
const molecule = { id: "m1", type: "molecule", x: 0, y: 0, width: 5, height: 5, atoms: [], bonds: [] };
const add = { op: "addObject", pageId, object: molecule };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=";

describe("request tool schema bounds", () => {
  it("enforces a strict JSON Schema subset and the existing individual name, description and schema limits", () => {
    expect(PluginToolDefinitionSchema.safeParse({ ...tool, inputSchema: {
      type: "object", additionalProperties: false, required: ["parts"], properties: {
        parts: { type: "array", minItems: 1, maxItems: 4, items: {
          type: "object", properties: { angle: { type: "number", minimum: 0, maximum: 360 } }
        } },
        text: { type: "string", minLength: 1, maxLength: 10, enum: ["hello"] },
        visible: { type: "boolean" },
        x: { type: "integer" },
        y: { type: "null" }
      }
    } }).success).toBe(true);
    for (const schema of [
      { type: "object", $ref: "#foo" }, { type: "array", items: { type: "number" } },
      { type: "object", required: ["missing"] }, { type: "object", additionalProperties: { type: "string" } },
      { type: "object", properties: { point: { type: "array" } } },
      { type: "object", properties: { point: { type: "number", minimum: 2, maximum: 1 } } },
      { type: "object", properties: { point: { type: "string", pattern: "^a" } } },
      { type: "object", enum: ["é".repeat(PluginRequestLimits.schemaBytes / 2)] }
    ]) {
      expect(PluginToolDefinitionSchema.safeParse({ ...tool, inputSchema: schema }).success).toBe(false);
    }
    expect(PluginToolDefinitionSchema.safeParse({ ...tool, name: "x".repeat(49) }).success).toBe(false);
    expect(PluginToolDefinitionSchema.safeParse({ ...tool, description: "x".repeat(1001) }).success).toBe(false);
  });

  it("caps catalog size and names across providers, including aggregate UTF-8 bytes", () => {
    const catalog = (count: number) => Array.from({ length: count }, (_, index) => ({ ...tool, name: `tool_${index}` }));
    expect(PluginOpenToolSessionSchema.safeParse({ requestId, definitions: catalog(32) }).success).toBe(true);
    expect(PluginOpenToolSessionSchema.safeParse({ requestId, definitions: catalog(33) }).success).toBe(false);
    expect(PluginOpenToolSessionSchema.safeParse({ requestId, definitions: catalog(32), hostTools: ["old"] }).success).toBe(false);
    expect(PluginOpenToolSessionSchema.safeParse({ requestId, definitions: [tool], hostTools: [tool.name] }).success).toBe(false);
    const tooManyBytes = catalog(16).map(definition => ({ ...definition, inputSchema: {
      type: "object", properties: { text: { type: "string", enum: ["é".repeat(4_500)] } }
    } }));
    expect(tooManyBytes.every(definition => PluginToolDefinitionSchema.safeParse(definition).success)).toBe(true);
    const reply = PluginOpenToolSessionSchema.safeParse({ requestId, definitions: tooManyBytes });
    expect(reply.success ? undefined : requestValidationCode(reply.error)).toBe("limit");
  });

  it("refuses deep JSON, accessors, cyclic data, dangerous keys, sparse arrays and nonfinite numbers", () => {
    const call = { requestId, sessionId: "session", name: "draw" };
    const tooDeep = Array.from({ length: PluginRequestLimits.jsonDepth }, () => 0)
      .reduce<unknown>(nested => ({ nested }), null);
    const cyclic: { child?: unknown } = {};
    cyclic.child = cyclic;
    let readThen = false;
    const getter = Object.defineProperty({}, "then", { enumerable: true, get() { readThen = true; return undefined; } });
    for (const body of [tooDeep, cyclic, getter, { nested: NaN }, { array: Array(2) },
      JSON.parse('{"nested":{"__proto__":{"poison":true}}}'), new Date(), { value: undefined }]) {
      expect(PluginToolCallSchema.safeParse({ ...call, input: body }).success).toBe(false);
    }
    expect(PluginToolCallSchema.safeParse(getter).success).toBe(false);
    expect(readThen).toBe(false);
  });

  it("validates flat scoped patch operations, indexed insertions, expectations and preconditions", () => {
    const expected = { kind: "insertion", opIndex: 1, sourceSmiles: "C" };
    const valid = { requestId, patch: { op: "batch", patches: [move, add] }, expectedStructures: [expected],
      preconditions: [{ kind: "objectRevision", pageId, objectId: "anchor", token: "rev" },
        { kind: "pageAtLeast", pageId, width: 100, height: 100 }] };
    expect(PluginApplyRequestPatchSchema.safeParse(valid).success).toBe(true);
    expect(PluginApplyRequestPatchSchema.safeParse({ ...valid, expectedStructures: [{ ...expected, opIndex: 0 }] }).success).toBe(false);
    expect(PluginApplyRequestPatchSchema.safeParse({ ...valid, expectedStructures: [expected, expected] }).success).toBe(false);
    expect(PluginApplyRequestPatchSchema.safeParse({ ...valid, preconditions: [{ ...valid.preconditions[0], scope: true }] }).success).toBe(false);
    for (const badPatch of [{ op: "batch", patches: [valid.patch] }, { op: "batch", patches: Array(257).fill(move) },
      { ...move, pageId }, { op: "setSelection", objectIds: [] }, { ...add, object: { ...molecule, atoms: Array(2501).fill({}) } }]) {
      expect(PluginApplyRequestPatchSchema.safeParse({ requestId, patch: badPatch }).success).toBe(false);
    }
    for (const code of ["stale", "scope", "chemistry", "cancelled", "limit", "unsupported", "interrupted", "busy"]) {
      expect(PluginApplyRequestPatchResultSchema.safeParse({ ok: false, error: { code, message: "Refused" } }).success).toBe(true);
    }
  });

  it("bounds pinned reads and inspection", () => {
    expect(PluginReadRequestSchema.safeParse({ ...request, objectIds: Array.from({ length: 65 }, (_, i) => `m${i}`) }).success).toBe(false);
    expect(PluginRequestContextResultSchema.safeParse({ ok: true, value: {
      requestId, documentKey: "doc", pages: Array(257).fill({ pageId, width: 10, height: 10, revision: "r" }),
      insertions: [], selection: [], objectRevisions: []
    } }).success).toBe(false);
    expect(PluginInspectStructureResultSchema.safeParse({ ok: true, value: {
      source: { format: "smiles", structure: "C" }, canonicalIsomericSmiles: "C", heavyAtoms: 501, warnings: []
    } }).success).toBe(false);
  });

  it("rejects oversized collections within the JSON budget before copying their entries", () => {
    const trackTraversal = <T>(entries: T[]) => {
      const ownKeys = vi.fn(() => Reflect.ownKeys(entries));
      return { entries: new Proxy(entries, { ownKeys }), ownKeys };
    };
    const patches = trackTraversal(Array.from({ length: PluginRequestLimits.patches + 1 }, () => move));
    const definitions = Array.from({ length: PluginRequestLimits.definitions + 1 }, (_, index) => ({
      ...tool, name: `tool_${index}`
    }));
    const catalog = trackTraversal(definitions);
    const mixedCatalog = trackTraversal(definitions.slice(1));
    const filter = trackTraversal(Array.from({ length: 10_000 }, (_, index) => `object_${index}`));
    const objectTarget = { kind: "objects", objectIds: filter.entries };
    const atoms = trackTraversal(Array.from({ length: PluginRequestLimits.atomsPerMolecule + 1 }, () => ({})));
    const preconditions = trackTraversal(Array.from({ length: PluginRequestLimits.patches + 1 },
      () => ({ kind: "pageAtLeast", pageId, width: 10, height: 10 })));
    const schemaEnum = trackTraversal(Array.from({ length: 129 }, (_, index) => `value_${index}`));
    const definition = { ...tool, inputSchema: { type: "object", properties: {
      list: { type: "array", items: { type: "string", enum: schemaEnum.entries } }
    } } };
    const objects = trackTraversal(Array.from({ length: PluginRequestLimits.readObjects + 1 }, () => ({
      object: molecule, revision: "r"
    })));
    const patch = { op: "batch", patches: patches.entries };
    for (const [schema, value] of [
      [PluginRequestPatchSchema, patch],
      [PluginRequestPatchSchema, { op: "batch", patches: [{ ...add, object: { ...molecule, atoms: atoms.entries } }] }],
      [PluginReadRequestSchema, { ...request, objectIds: filter.entries }],
      [PluginApplyRequestPatchSchema, { requestId, patch }],
      [PluginApplyRequestPatchSchema, { requestId, patch: move, preconditions: preconditions.entries }],
      [PluginRenderRegionSchema, { ...request, target, preview: patch, widthPx: 1, heightPx: 1 }],
      [PluginRenderRegionSchema, { ...request, target: objectTarget, widthPx: 1, heightPx: 1 }],
      [PluginPlanLayoutSchema, { ...request, spec: { kind: "grid", objectIds: filter.entries,
        anchor: { x: 0, y: 0 }, columns: 1, columnGap: 10, rowGap: 10 } }],
      [PluginPlanStyleSchema, { ...request, objectIds: filter.entries, targetBondLength: 22 }],
      [PluginOpenToolSessionSchema, { requestId, definitions: catalog.entries }],
      [PluginOpenToolSessionSchema, { requestId, definitions: mixedCatalog.entries, hostTools: ["extra"] }],
      [PluginOpenToolSessionSchema, { requestId, definitions: [definition] }],
      [PluginToolDefinitionSchema, definition],
      [PluginReadRequestResultSchema, { ok: true, value: { pageId, revision: "r", objects: objects.entries } }]
    ] as const) {
      const result = schema.safeParse(value);
      expect(result.success ? undefined : requestValidationCode(result.error)).toBe("limit");
    }
    for (const collection of [patches, catalog, mixedCatalog, objects, filter, atoms, preconditions, schemaEnum]) {
      expect(collection.ownKeys.mock.calls).toHaveLength(0);
    }
  });

  it.each(["field", "length"] as const)("reuses the captured collection when a proxy changes its %s descriptor", descriptor => {
    const oversized = Array.from({ length: PluginRequestLimits.patches + 1 }, () => move);
    const ownKeys = vi.fn(() => Reflect.ownKeys(oversized));
    const replacement = new Proxy(oversized, { ownKeys });
    const short = [move];
    const lengthDescriptor = vi.fn(() => Reflect.getOwnPropertyDescriptor(short, "length")!);
    const entries = new Proxy(short, {
      getOwnPropertyDescriptor: (target, key) => key === "length"
        ? lengthDescriptor() : Reflect.getOwnPropertyDescriptor(target, key)
    });
    if (descriptor === "length") {
      lengthDescriptor.mockReturnValueOnce(Reflect.getOwnPropertyDescriptor(short, "length")!)
        .mockReturnValue({ ...Reflect.getOwnPropertyDescriptor(short, "length")!, value: oversized.length });
    }
    const patch = { op: "batch", patches: entries };
    const patchesDescriptor = vi.fn(() => Reflect.getOwnPropertyDescriptor(patch, "patches")!);
    if (descriptor === "field") {
      patchesDescriptor.mockReturnValueOnce(Reflect.getOwnPropertyDescriptor(patch, "patches")!)
        .mockReturnValue({ ...Reflect.getOwnPropertyDescriptor(patch, "patches")!, value: replacement });
    }
    const input = new Proxy(patch, {
      getOwnPropertyDescriptor: (target, key) => key === "patches"
        ? patchesDescriptor() : Reflect.getOwnPropertyDescriptor(target, key)
    });
    expect(PluginRequestPatchSchema.safeParse(input)).toEqual({
      success: true, data: { op: "batch", patches: [move] }
    });
    expect(patchesDescriptor).toHaveBeenCalledTimes(1);
    expect(lengthDescriptor).toHaveBeenCalledTimes(1);
    expect(ownKeys).not.toHaveBeenCalled();
  });

  it("validates PNG dimensions, envelopes and header before delivering results", () => {
    expect(PluginRenderRegionSchema.safeParse({ ...request, target, widthPx: 2048, heightPx: 2048 }).success).toBe(true);
    const oversized = PluginRenderRegionSchema.safeParse({ ...request, target, widthPx: 2048, heightPx: 2049 });
    expect(oversized.success ? undefined : requestValidationCode(oversized.error)).toBe("limit");
    const output = { bounds, widthPx: 1, heightPx: 1, mimeType: "image/png", base64: png, warnings: [] };
    expect(PluginRenderRegionResultSchema.safeParse({ ok: true, value: output }).success).toBe(true);
    for (const bad of [{ ...output, widthPx: 2 }, { ...output, base64: png.slice(0, 24) },
      { ...output, base64: "A".repeat(4 * Math.ceil(PluginRequestLimits.pngBytes / 3) + 4) }]) {
      expect(PluginRenderRegionResultSchema.safeParse({ ok: true, value: bad }).success).toBe(false);
    }
  });

  it("preserves long drawable face keys and keeps chemical ring membership distinct", () => {
    const bondIds = ["ab", "bc", "ca"].map(id => id.padEnd(100, "_"));
    const ring = { atomIds: ["a", "b", "c"], bondIds };
    const key = bondIds.join("|");
    const value = { representation: "drawable", revision: "r", warnings: [], rings: [{ ...ring, key }] };
    expect(PluginRingsResultSchema.safeParse({ ok: true, value }).success).toBe(true);
    expect(PluginRingsResultSchema.safeParse({ ok: true, value: { ...value, representation: "chemical" } }).success).toBe(false);
    expect(PluginRingsResultSchema.safeParse({ ok: true,
      value: { ...value, representation: "chemical", rings: [ring] } }).success).toBe(true);
  });
});
