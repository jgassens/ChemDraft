import { describe, expect, it } from "vitest";
import { buildAboutProvenance } from "./buildProvenance";
import { AND_OTHERS, SEE_LICENSE, cargoAuthors, committedHolders, holderKey, manifestPeople, resolveHolders } from "./holders";

describe("committed holder data", () => {
  it("has an entry, holders or 'see license', for every shipped package version", () => {
    const { libraries } = buildAboutProvenance();
    expect(libraries.length).toBeGreaterThan(0);
    for (const library of libraries) {
      expect(library.versions.length, library.name).toBeGreaterThan(0);
      for (const version of library.versions) {
        const entry = committedHolders[holderKey(library.kind, library.name, version)];
        expect(entry, library.kind + " " + library.name + "@" + version + " (run node scripts/generate-about-holders.mjs)").toBeDefined();
        expect(entry!.holders.length).toBeGreaterThan(0);
        if (entry!.holders.includes(SEE_LICENSE)) expect(entry!.holders).toEqual([SEE_LICENSE]);
      }
    }
  });

  it("matches only the exact locked version, never another version of the package", () => {
    const table = {
      [holderKey("npm", "pkg", "1.0.0")]: { holders: ["Copyright (c) Old Holder"], from: "license file" as const },
      [holderKey("npm", "other", "2.0.0")]: { holders: ["Copyright (c) Other Holder"], from: "license file" as const }
    };
    expect(resolveHolders([], [{ kind: "npm", name: "pkg", versions: ["1.0.0"] }], table)).toEqual(["Copyright (c) Old Holder"]);
    expect(resolveHolders([], [{ kind: "npm", name: "pkg", versions: ["2.0.0"] }], table)).toEqual([SEE_LICENSE]);
    expect(resolveHolders([], [{ kind: "cargo", name: "pkg", versions: ["1.0.0"] }], table)).toEqual([SEE_LICENSE]);
    expect(resolveHolders(["NOTICE Holder"], [{ kind: "npm", name: "pkg", versions: ["1.0.0"] }], table)).toEqual(["NOTICE Holder"]);
  });

  it("says so when metadata authors are cut to five", () => {
    const people = ["A", "B", "C", "D", "E"];
    expect(manifestPeople({ author: "A", contributors: people.slice(1).map(name => ({ name })) })).toEqual(people);
    expect(manifestPeople({ author: "A", contributors: [..."BCDEF"].map(name => ({ name })) })).toEqual([...people, AND_OTHERS]);
    expect(cargoAuthors('authors = ["A", "B", "C", "D", "E"]')).toEqual(people);
    expect(cargoAuthors('authors = ["A <a@x.org>", "B", "C", "D", "E", "F", "A"]')).toEqual([...people, AND_OTHERS]);
  });
});
