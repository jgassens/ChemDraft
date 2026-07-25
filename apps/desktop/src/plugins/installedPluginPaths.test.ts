import { describe, expect, it } from "vitest";

import {
  assertInstalledPluginStagedPath,
  installedPluginStagedBaseUrl,
  installedPluginStagingDir,
  installedPluginUpdateStagingDir
} from "./installedPluginPaths";

describe("installed plugin paths", () => {
  it("serves legacy and checksum-addressed package directories from the app origin", () => {
    const checksum = "a".repeat(64);
    expect(installedPluginStagingDir("org.chemdraft.nmr.predictor")).toBe(
      "installed-plugins/org.chemdraft.nmr.predictor"
    );
    expect(installedPluginUpdateStagingDir(checksum)).toBe(`installed-plugins/packages/${checksum}`);
    expect(installedPluginStagedBaseUrl(`installed-plugins/packages/${checksum}`, "tauri://localhost")).toBe(
      `tauri://localhost/installed-plugins/packages/${checksum}/`
    );
  });

  it("refuses unsafe ids, paths outside the install root, and malformed checksums", () => {
    expect(() => installedPluginStagingDir("../../escape")).toThrow(/unsafe/i);
    expect(() => installedPluginStagingDir("packages")).toThrow(/unsafe/i);
    expect(() => installedPluginStagingDir("PACKAGES")).toThrow(/unsafe/i);
    expect(() => installedPluginUpdateStagingDir("not-a-checksum")).toThrow(/SHA-256/i);
    expect(() => assertInstalledPluginStagedPath("../elsewhere")).toThrow(/unsafe/i);
    expect(() => assertInstalledPluginStagedPath("installed-plugins/../elsewhere")).toThrow(/unsafe/i);
    expect(() => assertInstalledPluginStagedPath("installed-plugins/packages")).toThrow(/unsafe/i);
    expect(() => assertInstalledPluginStagedPath("installed-plugins/PACKAGES")).toThrow(/unsafe/i);
    expect(() => assertInstalledPluginStagedPath("installed-plugins/packages/not-a-checksum")).toThrow(/unsafe/i);
    expect(() => installedPluginStagedBaseUrl("installed-plugins/plugin\\escape", "tauri://localhost")).toThrow(
      /unsafe/i
    );
  });
});
