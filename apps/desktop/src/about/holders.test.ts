import { describe, expect, it } from "vitest";
import { buildAboutProvenance } from "./buildProvenance";
import { AND_OTHERS, SEE_LICENSE, cargoAuthors, committedHolders, holderKey, manifestPeople, resolveHolders, resolvePlatforms } from "./holders";

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

  it("tags every committed entry with the platforms that ship it", () => {
    for (const [key, entry] of Object.entries(committedHolders)) {
      expect(entry.platforms, key + " (run node scripts/generate-about-holders.mjs)").toBeDefined();
      if (entry.platforms !== "all") {
        expect(entry.platforms!.length, key).toBeGreaterThan(0);
        expect(entry.platforms!.length, key).toBeLessThan(3);
      }
    }
    expect(Object.values(committedHolders).some(entry => entry.platforms !== "all")).toBe(true);
  });

  it("ships a component wherever any of its packages ships", () => {
    const table = {
      [holderKey("cargo", "linux-crate", "1.0.0")]: { holders: ["A"], from: "license file" as const, platforms: ["linux" as const] },
      [holderKey("cargo", "windows-crate", "1.0.0")]: { holders: ["B"], from: "license file" as const, platforms: ["windows" as const] },
      [holderKey("npm", "web-package", "1.0.0")]: { holders: ["C"], from: "license file" as const, platforms: "all" as const },
      [holderKey("npm", "untagged", "1.0.0")]: { holders: ["D"], from: "license file" as const }
    };
    const library = (kind: "npm" | "cargo", name: string) => ({ kind, name, versions: ["1.0.0"] });
    expect(resolvePlatforms([library("cargo", "linux-crate")], table)).toEqual(["linux"]);
    expect(resolvePlatforms([library("cargo", "linux-crate"), library("cargo", "windows-crate")], table)).toEqual(["windows", "linux"]);
    expect(resolvePlatforms([library("cargo", "linux-crate"), library("npm", "web-package")], table)).toBe("all");
    expect(resolvePlatforms([library("npm", "untagged")], table)).toBe("all");
    expect(resolvePlatforms([], table)).toBe("all");
  });
});
