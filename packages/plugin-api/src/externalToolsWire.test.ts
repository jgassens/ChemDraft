import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PluginExternalToolConsentListSchema,
  PluginExternalToolRunErrorSchema,
  PluginExternalToolRunHandleSchema,
  PluginExternalToolRunPollSchema,
  PluginExternalToolRunRequestSchema,
  PluginExternalToolSignInResultSchema,
  PluginExternalToolStatusSchema
} from "./index";

const fixtureDir = fileURLToPath(new URL("../../../apps/desktop/src/externalTools/__fixtures__/wire/", import.meta.url));
const schemas = {
  status: PluginExternalToolStatusSchema,
  poll: PluginExternalToolRunPollSchema,
  "run-handle": PluginExternalToolRunHandleSchema,
  "run-error": PluginExternalToolRunErrorSchema,
  "sign-in": PluginExternalToolSignInResultSchema,
  "consent-list": PluginExternalToolConsentListSchema
};

describe("external tools serde/Zod wire parity", () => {
  const fixtures = readdirSync(fixtureDir).filter((name) => name.endsWith(".json")).sort();
  it("contains Rust fixtures for every response type", () => {
    for (const prefix of Object.keys(schemas)) expect(fixtures.some((name) => name.startsWith(prefix))).toBe(true);
  });
  for (const name of fixtures) {
    it(`parses Rust's ${name} without stripping any fields`, () => {
      const entry = Object.entries(schemas).find(([prefix]) => name === `${prefix}.json` || name.startsWith(`${prefix}-`));
      expect(entry, `No schema for ${name}`).toBeDefined();
      const value: unknown = JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));
      expect(entry![1].parse(value)).toEqual(value);
    });
  }

  it("allows a run with no MCP session in PR A", () => {
    const request = { tool: "codex", conversationId: "conversation_1", prompt: "draw water", systemPrompt: "help" };
    expect(PluginExternalToolRunRequestSchema.parse(request)).toEqual(request);
    expect(PluginExternalToolRunRequestSchema.parse({ ...request, mcpSessionId: "" }).mcpSessionId).toBe("");
  });
});
