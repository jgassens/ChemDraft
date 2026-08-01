import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cdxmlFixtureDescriptors, cdxmlFixtures } from "./index";

const cdxmlDirectory = fileURLToPath(new URL("../cdxml/", import.meta.url));

const diskFixtureNames = readdirSync(cdxmlDirectory)
  .filter((name) => name.endsWith(".cdxml"))
  .sort();

const inlinedFixtureNames = Object.keys(cdxmlFixtures).sort();

function readDiskFixture(name: string): string {
  return readFileSync(`${cdxmlDirectory}${name}`, "utf8");
}

describe("cdxml fixture parity", () => {
  it("reads the on-disk fixtures", () => {
    expect(diskFixtureNames.length).toBeGreaterThan(0);
  });

  it("exposes exactly the fixtures that exist on disk", () => {
    expect(inlinedFixtureNames).toEqual(diskFixtureNames);
  });

  for (const name of diskFixtureNames) {
    it(`keeps ${name} identical on disk and in cdxmlFixtures`, () => {
      expect(cdxmlFixtures[name]).toBe(readDiskFixture(name));
    });
  }

  it("points every descriptor at a fixture that exists", () => {
    const descriptorNames = cdxmlFixtureDescriptors
      .map((descriptor) => descriptor.path.replace(/^packages\/fixtures\/cdxml\//, ""))
      .sort();

    expect(descriptorNames).toEqual(diskFixtureNames);
  });
});
