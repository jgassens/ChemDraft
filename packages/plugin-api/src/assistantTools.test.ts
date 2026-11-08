import { describe, expect, it } from "vitest";
import { PluginAssistantExtraToolSchema, PluginAssistantToolResultSchema } from "./index";

const tool = { name: "lookup_record", description: "Look up a record" };
describe("extra assistant tool boundary", () => {
  it("accepts exactly 16 KiB of UTF-8 JSON, and refuses the next byte", () => {
    const overhead = new TextEncoder().encode(JSON.stringify({ description: "" })).byteLength;
    const inputSchema = { description: "x".repeat(16_384 - overhead) };
    expect(PluginAssistantExtraToolSchema.safeParse({ ...tool, inputSchema }).success).toBe(true);
    expect(PluginAssistantExtraToolSchema.safeParse({ ...tool, inputSchema: { description: `${inputSchema.description}x` } }).success).toBe(false);
  });
  it("accepts JSON Schemas with many small enum entries and ordinary property names", () => {
    const inputSchema = { type: "object", properties: { constructor: { enum: Array(4_500).fill("") } } };
    expect(PluginAssistantExtraToolSchema.safeParse({ ...tool, inputSchema }).success).toBe(true);
  });
  it("rejects cycles, functions, non-finite values and accessors without executing them", () => {
    let accessed = false;
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    for (const inputSchema of [cyclic, { unsupported: () => {} }, { minimum: Infinity },
      { get type() { accessed = true; return "object"; } }]) {
      expect(PluginAssistantExtraToolSchema.safeParse({ ...tool, inputSchema }).success).toBe(false);
    }
    expect(accessed).toBe(false);
  });
  it("requires a JSON Schema object and validates returned tool content", () => {
    for (const inputSchema of [null, [], true, "schema"]) {
      expect(PluginAssistantExtraToolSchema.safeParse({ ...tool, inputSchema }).success).toBe(false);
    }
    expect(PluginAssistantToolResultSchema.safeParse({ content: [{ type: "text", text: 42 }] }).success).toBe(false);
    expect(PluginAssistantToolResultSchema.safeParse({ content: [{ type: "text", text: "found" }], structuredContent: { count: 1 } }).success).toBe(true);
  });
});
