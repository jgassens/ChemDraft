import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The headless CLI and the MCP server must never reach into the desktop app. They used to import
// apps/desktop/src/documentWorkflow.ts by relative path, which made every headless command depend
// on a 20,000-line desktop module: one desktop-only import added there would break them all. The
// shared document-building code now lives in @chemdraft/document-workflow-core; this test keeps it
// that way.

const thisFile = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(thisFile), "../../..");
const appsRoot = join(repoRoot, "apps");
const scannedRoots = ["packages/chemdraft-cli/src", "packages/chemdraft-mcp/src"];

// Static import/export, side-effect import, dynamic import(), require(), and vitest's module
// loaders — every form that makes a file load another module.
const SPECIFIER_PATTERN =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bvi\.(?:mock|doMock|importActual)\s*\(\s*)["']([^"']+)["']/g;

function moduleSpecifiers(source: string): string[] {
  return [...source.matchAll(SPECIFIER_PATTERN)].map((match) => match[1]!);
}

function reachesIntoApps(file: string, specifier: string): boolean {
  if (specifier === "@chemdraft/desktop" || specifier.startsWith("@chemdraft/desktop/")) return true;
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return false;
  const target = resolve(dirname(file), specifier);
  return target === appsRoot || target.startsWith(appsRoot + sep);
}

function typeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : typeScriptFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("headless import boundary", () => {
  it("recognises every specifier form it guards against", () => {
    const file = join(repoRoot, "packages/chemdraft-cli/src/commands/example.ts");
    const source = [
      'import { a } from "../../../../apps/desktop/src/documentWorkflow";',
      'export { b } from "../../../../apps/desktop/src/moleculeSmiles";',
      'import "../../../../apps/desktop/src/sideEffect";',
      'const c = await import("../../../../apps/desktop/src/lazy");',
      'vi.mock("../../../../apps/desktop/src/mocked");',
      'import { d } from "@chemdraft/document-workflow-core";',
      'import { e } from "../document";'
    ].join("\n");
    const offending = moduleSpecifiers(source).filter((specifier) => reachesIntoApps(file, specifier));
    expect(offending).toHaveLength(5);
  });

  it("keeps packages/chemdraft-cli and packages/chemdraft-mcp free of imports from apps/", () => {
    // This file is skipped: its self-test above spells out the imports it forbids.
    const files = scannedRoots
      .flatMap((root) => typeScriptFiles(join(repoRoot, root)))
      .filter((file) => file !== thisFile);
    // A scan that finds nothing proves nothing.
    expect(files.length).toBeGreaterThan(20);

    const violations = files.flatMap((file) =>
      moduleSpecifiers(readFileSync(file, "utf8"))
        .filter((specifier) => reachesIntoApps(file, specifier))
        .map((specifier) => `${relative(repoRoot, file)} imports ${specifier}`)
    );
    expect(violations).toEqual([]);
  });
});
