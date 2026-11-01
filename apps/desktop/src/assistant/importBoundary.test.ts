import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));
const allowedPackages = new Set([
  "@chemdraft/document-workflow-core", "@chemdraft/plugin-host", "@chemdraft/plugin-api",
  "@chemdraft/chem-core", "@chemdraft/layout-engine", "zod/v4"
]);
const specifiers = (source: string) => [...source.matchAll(
  /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bvi\.(?:mock|doMock|importActual)\s*\(\s*)["']([^"']+)["']/g
)].map(match => match[1]!);
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(dir, entry.name);
    if (entry.name === "node_modules") return [];
    return entry.isDirectory() ? files(path) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}
function allowed(file: string, specifier: string) {
  if (allowedPackages.has(specifier)) return true;
  if (!specifier.startsWith(".")) return false;
  const target = resolve(dirname(file), specifier);
  return target.startsWith(root + sep) || target === resolve(root, "../plugins/reservedObjectIds") ||
    target === resolve(root, "../documentWorkflow"); // SVG export only, asserted below
}
describe("assistant import boundary", () => {
  it("recognizes static, export, side-effect, require, dynamic and mocked imports", () => {
    expect(specifiers('import "bad"; export * from "bad"; require("bad"); import("bad"); vi.mock("bad");')).toEqual(Array(5).fill("bad"));
    expect(allowed(resolve(root, "tools/read.ts"), "../../../MainWindow")).toBe(false);
    expect(allowed(resolve(root, "writeBuilder.ts"), "@chemdraft/rdkit-adapter")).toBe(false);
  });
  it("keeps engines, state, native calls, and private app workflows out of tools", () => {
    // The transport controller and transaction are separate layers with their own native/state
    // dependencies. Guard the tool layer and everything added beneath tools/.
    const entrypoints = new Set(["assistantTools.ts", "AssistantToolContext.ts", "documentSummary.ts", "placement.ts", "writeBuilder.ts"]);
    const sources = files(root).filter(file => !file.includes(".test.") && !file.endsWith(`${sep}testContext.ts`) &&
      (entrypoints.has(relative(root, file)) || file.startsWith(resolve(root, "tools") + sep)));
    expect(sources.length).toBeGreaterThan(7);
    const errors: string[] = [];
    for (const file of sources) {
      const source = readFileSync(file, "utf8");
      for (const specifier of specifiers(source)) {
        if (!allowed(file, specifier)) errors.push(`${relative(root, file)} imports ${specifier}`);
      }
      if (/\b(?:import|require)\s*\(\s*[^"'\s]/.test(source)) errors.push(`${relative(root, file)} has a nonliteral module load`);
      if (source.includes('import("../../documentWorkflow")')) {
        expect(source).toContain('const { exportPhase4Svg } = await import("../../documentWorkflow")');
      } else expect(source).not.toMatch(/from\s+["'].*documentWorkflow/);
    }
    expect(errors).toEqual([]);
  });
});
