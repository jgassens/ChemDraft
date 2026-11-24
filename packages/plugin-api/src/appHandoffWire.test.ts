import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PluginAppHandoffSchemas } from "./index";

const fixtureDir = fileURLToPath(new URL("../../../apps/desktop/src/appHandoff/__fixtures__/wire/", import.meta.url));
const fixtureSchemas = [
  ["choose-app", PluginAppHandoffSchemas.chooseApp],
  ["status", PluginAppHandoffSchemas.status],
  ["send-file", PluginAppHandoffSchemas.sendFile],
  ["run-companion", PluginAppHandoffSchemas.runCompanion]
] as const;
describe("app handoff serde/Zod wire parity", () => {
  // Private dialog snapshots use the desktop dialog schema, tested in dialogProtocol.test.ts.
  const fixtures = readdirSync(fixtureDir).filter(name => name.endsWith(".json") && !name.startsWith("dialog-")).sort();
  it("includes the native result for a completed build that could not open", () => {
    expect(fixtures).toContain("run-companion-done-unopened.json");
  });
  for (const name of fixtures) {
    it(`parses Rust's ${name} without stripping any fields`, () => {
      const value: unknown = JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));
      // Use <method>-request[-<case>].json for inputs and <method>[-<case>].json for results.
      const stem = name.slice(0, -".json".length).replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`).replaceAll("_", "-");
      const match = fixtureSchemas.find(([method]) => stem === method || stem.startsWith(`${method}-`));
      if (!match) throw new Error(`No app handoff schema for ${name}.`);
      const [method, schemas] = match;
      const schema = /^-request(?:-|$)/u.test(stem.slice(method.length)) ? schemas.request : schemas.result;
      expect(schema.parse(value)).toEqual(value);
    });
  }
});
