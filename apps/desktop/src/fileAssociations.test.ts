import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Association { ext: string[]; rank?: string; role?: string; contentTypes?: string[] }
function associations(filename: string): Association[] {
  return JSON.parse(readFileSync(new URL(`../src-tauri/${filename}`, import.meta.url), "utf8")).bundle.fileAssociations;
}

describe("desktop file associations", () => {
  it("registers binary CDX as an Alternate editor on macOS", () => {
    expect(associations("tauri.conf.json").find(entry => entry.ext.includes("cdx"))).toMatchObject({
      rank: "Alternate", role: "Editor", contentTypes: ["com.cambridgesoft.chemdraw.cdx", "public.data"]
    });
  });
  it("replaces the macOS associations on Windows and claims only .chemdraft", () => {
    const extensions = associations("tauri.windows.conf.json").flatMap(entry => entry.ext);
    expect(extensions).toEqual(["chemdraft"]);
    expect(extensions).not.toContain("cdx");
    expect(extensions).not.toContain("cdxml");
  });
});
