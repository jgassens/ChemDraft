import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkPluginBoundary,
  DYNAMIC_MODULE_SPECIFIER,
  listModuleSpecifiers,
  listRuntimeSourceFiles,
  PLUGIN_SDK_PACKAGE
} from "./checkBoundary";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const pluginDir = (name: string): string => `${repoRoot}examples/plugins/${name}`;
const temporaryPlugins: string[] = [];

afterEach(() => {
  for (const root of temporaryPlugins.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryPlugin(source: string): string {
  const root = mkdtempSync(join(tmpdir(), "chemdraft-boundary-"));
  temporaryPlugins.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/index.ts"), source);
  return root;
}

/** Plugins that are contracted to depend only on the plugin SDK and are therefore extractable (M33). */
const EXTRACTABLE_PLUGINS = ["nmr-predictor", "mass-fragment-demo"];

describe("plugin import boundary", () => {
  it.each(EXTRACTABLE_PLUGINS)(`%s runtime source imports only ${PLUGIN_SDK_PACKAGE}`, (name) => {
    expect(checkPluginBoundary(pluginDir(name))).toEqual([]);
  });

  it("is not vacuously passing — it scans real source files", () => {
    const files = listRuntimeSourceFiles(pluginDir("nmr-predictor"));
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((file) => file.endsWith(".ts"))).toBe(true);
    // The known self-referential doc comment in index.ts must NOT be read as an import violation.
    expect(checkPluginBoundary(pluginDir("nmr-predictor"))).toEqual([]);
  });

  it("catches a disallowed core import when the SDK is narrowed to nothing", () => {
    // Feeding an impossible SDK package proves the checker actually flags @chemdraft/* imports
    // rather than silently returning [] (a guard that can't fail is worthless).
    const violations = checkPluginBoundary(pluginDir("nmr-predictor"), "@chemdraft/__none__");
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((violation) => violation.specifier === PLUGIN_SDK_PACKAGE)).toBe(true);
  });

  it("reads module syntax rather than treating arbitrary quoted diagnostics as imports", () => {
    expect(
      listModuleSpecifiers(`
        import type { PluginManifest } from "@chemdraft/plugin-api";
        import "zod";
        export { value } from "./local";
        const diagnostic = "@chemdraft/chem-core";
      `)
    ).toEqual(["@chemdraft/plugin-api", "zod", "./local"]);
  });

  it("rejects ChemDraft package subpaths across static, dynamic, export, and require syntax", () => {
    const root = temporaryPlugin(`
      import value from "@chemdraft/plugin-host/internal";
      export { schema } from "@chemdraft/chem-core/schemas";
      const lazy = import("@chemdraft/ocl-adapter/private");
      const legacy = require("@chemdraft/plugin-host");
      import sdkInternal = require("@chemdraft/plugin-api/internal");
      void value; void lazy; void legacy; void sdkInternal;
    `);

    expect(checkPluginBoundary(root).map((violation) => violation.specifier)).toEqual([
      "@chemdraft/plugin-host/internal",
      "@chemdraft/chem-core/schemas",
      "@chemdraft/ocl-adapter/private",
      "@chemdraft/plugin-host",
      "@chemdraft/plugin-api/internal"
    ]);
  });

  it("rejects relative imports that escape the plugin package", () => {
    const root = temporaryPlugin(`import "../../packages/plugin-host/src/index";`);
    expect(checkPluginBoundary(root)).toEqual([
      { file: "src/index.ts", specifier: "../../packages/plugin-host/src/index" }
    ]);
  });

  it("rejects computed dynamic imports because their package boundary cannot be proven", () => {
    const root = temporaryPlugin(`
      const packageName = "@chemdraft/plugin-host";
      const loaded = import(packageName);
      void loaded;
    `);
    expect(checkPluginBoundary(root)).toEqual([
      { file: "src/index.ts", specifier: DYNAMIC_MODULE_SPECIFIER }
    ]);
  });

  it("allows the public SDK root, npm packages, and plugin-local relative imports", () => {
    const root = temporaryPlugin(`
      import type { PluginManifest } from "@chemdraft/plugin-api";
      import { z } from "zod";
      import { local } from "./local";
      const diagnostic = "@chemdraft/plugin-host/internal";
      void z; void local;
    `);
    expect(checkPluginBoundary(root)).toEqual([]);
  });

  it("documents molscribe-ocsr as a pre-SDK canary that reaches into chem-core (not extractable)", () => {
    // molscribe predates the plugin SDK and imports a chem-core type directly. It is intentionally
    // excluded from EXTRACTABLE_PLUGINS. This assertion records the exception and will trip if the
    // import changes, forcing a deliberate re-evaluation (fix molscribe, or update this record).
    const specifiers = checkPluginBoundary(pluginDir("molscribe-ocsr")).map((violation) => violation.specifier);
    expect(specifiers).toContain("@chemdraft/chem-core");
  });
});
