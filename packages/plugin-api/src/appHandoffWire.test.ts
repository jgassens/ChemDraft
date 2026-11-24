import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PluginAddConnectionPointsRequestSchema, PluginAppHandoffSchemas, PluginHostIdentitySchema, type PluginSelectedMolecule } from "./index";

const fixtureDir = fileURLToPath(new URL("../../../apps/desktop/src/appHandoff/__fixtures__/wire/", import.meta.url));
const fixtureSchemas = [
  ["choose-app", PluginAppHandoffSchemas.chooseApp],
  ["status", PluginAppHandoffSchemas.status],
  ["send-file", PluginAppHandoffSchemas.sendFile],
  ["run-companion", PluginAppHandoffSchemas.runCompanion]
] as const;
const selectedAtomsSchema: z.ZodType<Pick<PluginSelectedMolecule, "objectId" | "selectedAtomIds">> = z.object({
  objectId: z.string(),
  selectedAtomIds: z.array(z.string()).optional()
}).strict();
const workerFixtures: Record<string, z.ZodTypeAny> = {
  "mark-connection-points-request.json": PluginAddConnectionPointsRequestSchema,
  "command-host-identity.json": PluginHostIdentitySchema,
  "selection-atoms.json": selectedAtomsSchema,
  "selection-atoms-empty.json": selectedAtomsSchema,
  "selection-atoms-legacy.json": selectedAtomsSchema
};

describe("app handoff serde/Zod wire parity", () => {
  const fixtures = existsSync(fixtureDir) ? readdirSync(fixtureDir).filter(name => name.endsWith(".json")).sort() : [];
  if (fixtures.length === 0) {
    it("reports that Rust app handoff wire fixtures are not present yet", () => {
      console.info("Rust app handoff wire fixtures are not present yet. Task 1C adds them.");
      expect(fixtures).toHaveLength(0);
    });
  }
  for (const name of fixtures) {
    it(`parses Rust's ${name} without stripping any fields`, () => {
      const value: unknown = JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));
      const workerSchema = workerFixtures[name];
      if (workerSchema) {
        expect(workerSchema.parse(value)).toEqual(value);
        return;
      }
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
