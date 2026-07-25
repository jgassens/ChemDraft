import { describe, expect, it } from "vitest";

import {
  comparePluginVersions,
  isPluginPrereleaseVersion,
  pluginVersionFromReleaseTag
} from "./pluginVersion";

describe("plugin Semantic Versions", () => {
  it("orders major, minor, patch, and prerelease versions", () => {
    expect(comparePluginVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(comparePluginVersions("1.2.0", "1.1.99")).toBeGreaterThan(0);
    expect(comparePluginVersions("1.2.4", "1.2.3")).toBeGreaterThan(0);
    expect(comparePluginVersions("1.2.3", "1.2.3")).toBe(0);
    expect(comparePluginVersions("1.2.3-beta.2", "1.2.3-beta.11")).toBeLessThan(0);
    expect(comparePluginVersions("1.2.3", "1.2.3-rc.1")).toBeGreaterThan(0);
  });

  it("compares arbitrary-length numeric identifiers without precision loss", () => {
    const smaller = "90071992547409929999999999999999999999999999999999";
    const larger = "90071992547409930000000000000000000000000000000000";

    expect(comparePluginVersions(`${larger}.0.0`, `${smaller}.0.0`)).toBeGreaterThan(0);
    expect(comparePluginVersions(`${smaller}.0.0`, `${larger}.0.0`)).toBeLessThan(0);
    expect(comparePluginVersions(`${larger}.0.0`, `${larger}.0.0`)).toBe(0);
    expect(
      comparePluginVersions(`1.0.0-alpha.${larger}`, `1.0.0-alpha.${smaller}`)
    ).toBeGreaterThan(0);
  });

  it("uses Semantic Version ASCII ordering for nonnumeric prerelease identifiers", () => {
    expect(comparePluginVersions("1.0.0-alpha", "1.0.0-Beta")).toBeGreaterThan(0);
  });

  it("distinguishes prerelease identifiers from stable build metadata", () => {
    expect(isPluginPrereleaseVersion("1.2.3-rc.1+mac-arm64")).toBe(true);
    expect(isPluginPrereleaseVersion("1.2.3+mac-arm64")).toBe(false);
    expect(isPluginPrereleaseVersion("1.2.3")).toBe(false);
  });

  it("accepts stable GitHub v-tags and rejects malformed versions", () => {
    expect(pluginVersionFromReleaseTag("v0.1.0")).toBe("0.1.0");
    expect(() => pluginVersionFromReleaseTag("0.1.0")).toThrow(/start with "v"/i);
    expect(() => comparePluginVersions("01.0.0", "1.0.0")).toThrow(/Semantic Version/i);
    expect(() => comparePluginVersions("1.0.0-01", "1.0.0-1")).toThrow(/leading zero/i);
  });
});
