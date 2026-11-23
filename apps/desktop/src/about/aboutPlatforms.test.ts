import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { componentsForPlatform, shipsOnPlatform } from "./aboutPlatforms";
import { buildAboutProvenance } from "./buildProvenance";
import { readDependencyDeclarations, targetMatches } from "./cratePlatforms";
import { committedHolders, holderKey } from "./holders";
import { ABOUT_PLATFORMS, type AboutPlatform } from "./provenanceTypes";

describe("About components by platform", () => {
  const { components, libraries } = buildAboutProvenance();
  const namesFor = (platform: AboutPlatform) => componentsForPlatform(components, platform).map(component => component.name);
  const has = (platform: AboutPlatform, crate: string) =>
    namesFor(platform).some(name => name === crate || name.startsWith(crate + " "));

  it("lists no Linux-only or Windows-only crate on macOS", () => {
    for (const crate of ["zbus", "webkit2gtk", "futures-lite", "gtk", "openssl-probe", "windows-sys", "schannel", "tauri-plugin-single-instance"]) {
      expect(has("macos", crate), crate).toBe(false);
    }
    for (const crate of ["objc2", "objc2-app-kit", "block2", "security-framework", "tauri-plugin-sparkle-updater"]) {
      expect(has("macos", crate), crate).toBe(true);
    }
  });

  it("lists the Windows crates on Windows and not the Linux or macOS ones", () => {
    for (const crate of ["windows-sys", "schannel", "tauri-plugin-single-instance", "tauri-plugin-updater"]) {
      expect(has("windows", crate), crate).toBe(true);
    }
    for (const crate of ["zbus", "webkit2gtk", "futures-lite", "gtk", "objc2", "block2", "security-framework", "tauri-plugin-sparkle-updater"]) {
      expect(has("windows", crate), crate).toBe(false);
    }
  });

  it("lists the Linux crates on Linux and not the Windows or macOS ones", () => {
    for (const crate of ["zbus", "webkit2gtk", "futures-lite", "gtk", "openssl-probe", "tauri-plugin-single-instance"]) {
      expect(has("linux", crate), crate).toBe(true);
    }
    for (const crate of ["windows-sys", "schannel", "objc2", "block2", "security-framework", "tauri-plugin-sparkle-updater"]) {
      expect(has("linux", crate), crate).toBe(false);
    }
  });

  it("shows components shared by every platform on all three", () => {
    const shared = components.filter(component => component.platforms === "all");
    expect(shared.length).toBeGreaterThan(components.length / 2);
    for (const name of ["react", "tauri", "serde", "tokio", "RDKit MinimalLib WASM (vendored)"]) {
      expect(shared.some(component => component.name === name || component.name.startsWith(name + " ")), name).toBe(true);
    }
    for (const platform of ABOUT_PLATFORMS) {
      const shown = new Set(namesFor(platform));
      for (const component of shared) expect(shown.has(component.name), platform + " " + component.name).toBe(true);
    }
  });

  it("hides a component from a platform only when its tag leaves that platform out", () => {
    for (const platform of ABOUT_PLATFORMS) {
      const shown = new Set(namesFor(platform));
      for (const component of components) {
        const tagged = component.platforms === undefined || component.platforms === "all" || component.platforms.includes(platform);
        expect(shown.has(component.name), platform + " " + component.name).toBe(tagged);
      }
    }
    expect(shipsOnPlatform({}, "windows")).toBe(true);
    expect(shipsOnPlatform({ platforms: ["linux"] }, "macos")).toBe(false);
  });

  it("detects the platform when none is passed", () => {
    // The default is detection (navigator.platform), exactly as in keyboardShortcuts.ts.
    const detected = componentsForPlatform(components);
    expect(detected.length).toBeGreaterThan(0);
    expect(detected.length).toBeLessThanOrEqual(components.length);
  });

  it("keeps every library of the dependency inventory in the committed table, tagged", () => {
    for (const library of libraries) {
      for (const version of library.versions) {
        const entry = committedHolders[holderKey(library.kind, library.name, version)];
        expect(entry?.platforms, library.name + "@" + version + " (run node scripts/generate-about-holders.mjs)").toBeDefined();
      }
    }
  });

  it("tags each direct Rust dependency as its Cargo.toml target section says", () => {
    const manifest = readFileSync(new URL("../../src-tauri/Cargo.toml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const declarations = readDependencyDeclarations(manifest);
    const direct = libraries.filter(library => library.kind === "cargo" && declarations.has(library.name));
    expect(direct.length).toBeGreaterThan(20);
    for (const library of direct) {
      const declared = declarations.get(library.name)!.filter(declaration => declaration.kind === "normal");
      const sectionPlatforms = ABOUT_PLATFORMS.filter(platform =>
        declared.some(declaration => !declaration.target || targetMatches(declaration.target, platform)));
      for (const version of library.versions) {
        const tag = committedHolders[holderKey("cargo", library.name, version)]!.platforms!;
        const committed = tag === "all" ? [...ABOUT_PLATFORMS] : tag;
        // A crate the app declares for one platform may still reach another through a dependency (libc,
        // dirs), so the tag may be wider than the app's own section, never narrower.
        for (const platform of sectionPlatforms) expect(committed, library.name + " on " + platform).toContain(platform);
      }
    }
    // The crates the app itself restricts to one platform stay restricted.
    for (const [crate, platforms] of [["zbus", ["linux"]], ["webkit2gtk", ["linux"]], ["futures-lite", ["linux"]], ["gtk", ["linux"]],
      ["windows-sys", ["windows"]], ["block2", ["macos"]], ["objc2", ["macos"]]] as const) {
      const library = libraries.find(item => item.kind === "cargo" && item.name === crate)!;
      expect(committedHolders[holderKey("cargo", crate, library.versions[0]!)]!.platforms, crate).toEqual(platforms);
    }
  });
});
