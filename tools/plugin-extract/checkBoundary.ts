import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The plugin SDK: the ONLY `@chemdraft/*` package an extractable plugin's runtime source may import.
 * Everything a plugin needs (manifest, contributions, command context, panel reports, selection
 * snapshot, analysis records, permissions, and the re-exported document types) is surfaced here.
 * Reaching into any other core package (`chem-core`, `plugin-host`, `ocl-adapter`, …) couples the
 * plugin to ChemDraft internals and breaks standalone extraction (M33).
 */
export const PLUGIN_SDK_PACKAGE = "@chemdraft/plugin-api";

export interface BoundaryViolation {
  /** Plugin-root-relative path of the offending file. */
  file: string;
  /** The disallowed `@chemdraft/*` specifier it imported. */
  specifier: string;
}

// Any quoted `@chemdraft/<pkg>` token. Plugin source only quotes such tokens in import/export/require
// specifiers; unquoted mentions (e.g. a doc comment naming the package) are correctly ignored.
const CHEMDRAFT_SPECIFIER = /["'`](@chemdraft\/[a-z0-9-]+)["'`]/g;

/** Runtime source files of a plugin: every `.ts`/`.tsx` under `src/` except tests. Tests are excluded
 * because they never ship in the extraction and may legitimately use the host to drive the plugin. */
export function listRuntimeSourceFiles(pluginRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "tests" || entry === "__tests__") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        out.push(full);
      }
    }
  };
  walk(join(pluginRoot, "src"));
  return out;
}

/** Every `@chemdraft/*` specifier the plugin's runtime source imports that is not the SDK package. */
export function checkPluginBoundary(pluginRoot: string, sdkPackage: string = PLUGIN_SDK_PACKAGE): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  for (const file of listRuntimeSourceFiles(pluginRoot)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(CHEMDRAFT_SPECIFIER)) {
      if (match[1] !== sdkPackage) {
        violations.push({ file: file.slice(pluginRoot.length + 1), specifier: match[1] });
      }
    }
  }
  return violations;
}
