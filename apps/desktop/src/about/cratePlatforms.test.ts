import { describe, expect, it } from "vitest";
import {
  evaluateCfg, platformTag, reachByPlatform, readCargoLock, readDependencyDeclarations, splitTomlKey, targetMatches
} from "./cratePlatforms";

describe("cfg evaluation", () => {
  it("matches the operating system, family and vendor of each shipped platform", () => {
    expect(evaluateCfg('target_os = "linux"', "linux")).toBe(true);
    expect(evaluateCfg('target_os = "linux"', "macos")).toBe(false);
    expect(evaluateCfg("windows", "windows")).toBe(true);
    expect(evaluateCfg("windows", "macos")).toBe(false);
    expect(evaluateCfg("unix", "macos")).toBe(true);
    expect(evaluateCfg("unix", "linux")).toBe(true);
    expect(evaluateCfg("unix", "windows")).toBe(false);
    expect(evaluateCfg('target_vendor = "apple"', "macos")).toBe(true);
    expect(evaluateCfg('target_env = "msvc"', "windows")).toBe(true);
  });

  it("evaluates all, any and not, with the architectures ChemDraft ships", () => {
    const expression = 'not(any(target_os = "macos", target_os = "ios", target_os = "android"))';
    expect(evaluateCfg(expression, "macos")).toBe(false);
    expect(evaluateCfg(expression, "windows")).toBe(true);
    expect(evaluateCfg(expression, "linux")).toBe(true);
    expect(evaluateCfg('all(unix, not(target_os = "macos"))', "linux")).toBe(true);
    expect(evaluateCfg('all(unix, not(target_os = "macos"))', "macos")).toBe(false);
    expect(evaluateCfg('target_arch = "wasm32"', "linux")).toBe(false);
    expect(evaluateCfg('target_arch = "aarch64"', "macos")).toBe(true);
  });

  it("treats a custom RUSTFLAGS cfg as unset and refuses an unknown target_ name", () => {
    expect(evaluateCfg('all(target_os = "uefi", getrandom_backend = "efi_rng")', "windows")).toBe(false);
    expect(evaluateCfg("not(tokio_unstable)", "linux")).toBe(true);
    expect(() => evaluateCfg('target_made_up = "x"', "linux")).toThrow(/Unsupported cfg predicate/);
  });

  it("reads a target spec given as cfg(...) or as a triple", () => {
    expect(targetMatches("cfg(windows)", "windows")).toBe(true);
    expect(targetMatches("x86_64-pc-windows-msvc", "windows")).toBe(true);
    expect(targetMatches("x86_64-pc-windows-msvc", "macos")).toBe(false);
    expect(targetMatches("aarch64-apple-darwin", "macos")).toBe(true);
    expect(targetMatches("x86_64-unknown-linux-gnu", "linux")).toBe(true);
  });
});

describe("Cargo.toml dependency sections", () => {
  it("splits dotted keys with quoted segments", () => {
    expect(splitTomlKey("target.'cfg(target_os = \"linux\")'.dependencies.zbus"))
      .toEqual(["target", 'cfg(target_os = "linux")', "dependencies", "zbus"]);
    expect(splitTomlKey('target."cfg(not(target_arch = \\"wasm32\\"))".dependencies.rustls-native-certs'))
      .toEqual(["target", 'cfg(not(target_arch = "wasm32"))', "dependencies", "rustls-native-certs"]);
  });

  it("records plain, target-specific, table-form, renamed, build and dev dependencies", () => {
    const declarations = readDependencyDeclarations([
      "[package]", 'name = "demo"', "",
      "[dependencies]", 'serde = "1"', 'tokio = { version = "1", features = [', '  "net",', "] }",
      'alias = { version = "1", package = "real-name" }', "",
      "[target.'cfg(target_os = \"linux\")'.dependencies]", 'zbus = "5"', "",
      "[target.'cfg(windows)'.dependencies.windows-sys]", 'version = "0.61"', "",
      "[target.'cfg(unix)'.dependencies.renamed-table]", 'version = "1"', 'package = "libc"', "",
      "[build-dependencies]", 'cc = "1"', "",
      "[dev-dependencies]", 'tempfile = "3"', "",
      "[features]", 'default = []'
    ].join("\n"));
    expect(declarations.get("serde")).toEqual([{ kind: "normal" }]);
    expect(declarations.get("tokio")).toEqual([{ kind: "normal" }]);
    expect(declarations.get("real-name")).toEqual([{ kind: "normal" }]);
    expect(declarations.get("zbus")).toEqual([{ kind: "normal", target: 'cfg(target_os = "linux")' }]);
    expect(declarations.get("windows-sys")).toEqual([{ kind: "normal", target: "cfg(windows)" }]);
    expect(declarations.get("libc")).toEqual([{ kind: "normal", target: "cfg(unix)" }]);
    expect(declarations.get("cc")).toEqual([{ kind: "build" }]);
    expect(declarations.get("tempfile")).toEqual([{ kind: "dev" }]);
    expect(declarations.has("default")).toBe(false);
    expect(declarations.has("features")).toBe(false);
  });
});

describe("platform reach through Cargo.lock", () => {
  const lock = readCargoLock([
    "[[package]]", 'name = "app"', 'version = "1.0.0"', 'dependencies = [', ' "common",', ' "linux-direct",', ' "mid",', ' "win-direct",', ']', "",
    "[[package]]", 'name = "common"', 'version = "1.0.0"', "",
    "[[package]]", 'name = "linux-direct"', 'version = "1.0.0"', "",
    "[[package]]", 'name = "win-direct"', 'version = "1.0.0"', "",
    "[[package]]", 'name = "mid"', 'version = "2.0.0"', 'dependencies = [', ' "mac-only",', ' "build-only",', ' "common",', ' "undeclared",', ']', "",
    "[[package]]", 'name = "mac-only"', 'version = "3.0.0"', "",
    "[[package]]", 'name = "build-only"', 'version = "1.0.0"', "",
    "[[package]]", 'name = "undeclared"', 'version = "1.0.0"', ""
  ].join("\n"));
  const manifests: Record<string, string> = {
    "app@1.0.0": [
      "[dependencies]", 'common = "1"', 'mid = "2"', "",
      "[target.'cfg(target_os = \"linux\")'.dependencies]", 'linux-direct = "1"', "",
      "[target.'cfg(windows)'.dependencies]", 'win-direct = "1"'
    ].join("\n"),
    "mid@2.0.0": [
      "[dependencies]", 'common = "1"', "",
      "[target.'cfg(target_os = \"macos\")'.dependencies]", 'mac-only = "3"', "",
      "[build-dependencies]", 'build-only = "1"'
    ].join("\n")
  };

  it("reaches a crate on a platform only through an active edge, and skips build-only crates", () => {
    const reach = reachByPlatform(lock, "app@1.0.0", pkg => manifests[pkg.id]);
    const tag = (id: string) => platformTag(reach.platforms.get(id));
    expect(tag("app@1.0.0")).toBe("all");
    expect(tag("common@1.0.0")).toBe("all");
    expect(tag("linux-direct@1.0.0")).toEqual(["linux"]);
    expect(tag("win-direct@1.0.0")).toEqual(["windows"]);
    expect(tag("mac-only@3.0.0")).toEqual(["macos"]);
    expect(platformTag(reach.platforms.get("build-only@1.0.0"))).toEqual([]);
  });

  it("keeps an edge it cannot filter, and says so", () => {
    const reach = reachByPlatform(lock, "app@1.0.0", pkg => manifests[pkg.id]);
    expect(platformTag(reach.platforms.get("undeclared@1.0.0"))).toBe("all");
    expect(reach.unfiltered).toContain("mid@2.0.0 -> undeclared");
    const noManifest = reachByPlatform(lock, "app@1.0.0", pkg => pkg.id === "app@1.0.0" ? manifests[pkg.id] : undefined);
    expect(noManifest.unfiltered).toContain("mid@2.0.0 (no Cargo.toml)");
    expect(platformTag(noManifest.platforms.get("mac-only@3.0.0"))).toBe("all");
  });

  it("orders a platform list macos, windows, linux, and calls three of three 'all'", () => {
    expect(platformTag(new Set(["linux", "macos"] as const))).toEqual(["macos", "linux"]);
    expect(platformTag(new Set(["linux", "macos", "windows"] as const))).toBe("all");
    expect(platformTag(undefined)).toEqual([]);
  });
});
