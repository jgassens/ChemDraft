import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { checkPluginBoundary, listRuntimeSourceFiles, PLUGIN_SDK_PACKAGE } from "./checkBoundary";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const pluginDir = (name: string): string => `${repoRoot}examples/plugins/${name}`;

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

  it("documents molscribe-ocsr as a pre-SDK canary that reaches into chem-core (not extractable)", () => {
    // molscribe predates the plugin SDK and imports a chem-core type directly. It is intentionally
    // excluded from EXTRACTABLE_PLUGINS. This assertion records the exception and will trip if the
    // import changes, forcing a deliberate re-evaluation (fix molscribe, or update this record).
    const specifiers = checkPluginBoundary(pluginDir("molscribe-ocsr")).map((violation) => violation.specifier);
    expect(specifiers).toContain("@chemdraft/chem-core");
  });
});
