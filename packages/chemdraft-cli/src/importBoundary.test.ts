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

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];

// Static import/export, side-effect import, `export * from`, dynamic import(), require()
// (which also covers `import x = require("x")`), and vitest's module loaders — every form that
// makes a file load another module.
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

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext)) ? [path] : [];
  });
}

// A dynamic `import(...)` or `require(...)` whose argument is not a string literal cannot be
// checked statically by this scan. It is allowed only for a file named below, with a reason.
const DYNAMIC_CALL_PATTERN = /\b(?:import|require)\s*\(\s*(["'`]?)/g;

function nonLiteralDynamicCalls(source: string): number {
  let count = 0;
  for (const match of source.matchAll(DYNAMIC_CALL_PATTERN)) {
    if (match[1] !== '"' && match[1] !== "'") count++;
  }
  return count;
}

// Confirmed by grep (`\bimport\s*\(|\brequire\s*\(` over the scanned roots): every other dynamic
// import()/require() call in these packages already takes a string literal.
const NON_LITERAL_DYNAMIC_IMPORT_ALLOWLIST: Record<string, string> = {
  "packages/chemdraft-cli/src/pluginTrust.ts":
    "loads a plugin's manifest and entry module from a realpath-checked filesystem path chosen at runtime (trusted plugin loading)",
  "packages/chemdraft-cli/src/commands/nmr.ts":
    "loads OpenChemLib's entry file, resolved via require.resolve at runtime, so the engine loads lazily (AGENTS.md §15)",
  "packages/chemdraft-cli/src/commands/stereo.ts":
    "loads OpenChemLib's entry file, resolved via require.resolve at runtime, so the engine loads lazily (AGENTS.md §15)"
};

describe("headless import boundary", () => {
  it("recognises every specifier form it guards against", () => {
    const file = join(repoRoot, "packages/chemdraft-cli/src/commands/example.ts");
    const source = [
      'import { a } from "../../../../apps/desktop/src/documentWorkflow";',
      'export { b } from "../../../../apps/desktop/src/moleculeSmiles";',
      'export * from "../../../../apps/desktop/src/everything";',
      'import "../../../../apps/desktop/src/sideEffect";',
      'const c = await import("../../../../apps/desktop/src/lazy");',
      'require("../../../../apps/desktop/src/required");',
      'import f = require("../../../../apps/desktop/src/importEquals");',
      'vi.mock("../../../../apps/desktop/src/mocked");',
      'import { d } from "@chemdraft/document-workflow-core";',
      'import { e } from "../document";'
    ].join("\n");
    const offending = moduleSpecifiers(source).filter((specifier) => reachesIntoApps(file, specifier));
    expect(offending).toHaveLength(8);
  });

  it("keeps packages/chemdraft-cli and packages/chemdraft-mcp free of imports from apps/", () => {
    // This file is skipped: its self-test above spells out the imports it forbids.
    const files = scannedRoots
      .flatMap((root) => sourceFiles(join(repoRoot, root)))
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

  it("rejects a dynamic import()/require() whose argument is not a string literal", () => {
    expect(nonLiteralDynamicCalls("const m = await import(path);")).toBe(1);
    expect(nonLiteralDynamicCalls("const m = require(moduleName);")).toBe(1);
    expect(nonLiteralDynamicCalls('const m = await import("jsdom");')).toBe(0);
    expect(nonLiteralDynamicCalls('const m = require("pkg");')).toBe(0);
  });

  it("allows a non-literal dynamic import()/require() only in the declared allow-list", () => {
    const files = scannedRoots
      .flatMap((root) => sourceFiles(join(repoRoot, root)))
      .filter((file) => file !== thisFile);

    const violations: string[] = [];
    const seenAllowlisted = new Set<string>();

    for (const file of files) {
      const relPath = relative(repoRoot, file).split(sep).join("/");
      const count = nonLiteralDynamicCalls(readFileSync(file, "utf8"));
      if (count === 0) continue;
      if (relPath in NON_LITERAL_DYNAMIC_IMPORT_ALLOWLIST) {
        seenAllowlisted.add(relPath);
        continue;
      }
      violations.push(
        `${relPath} has ${count} non-literal dynamic import()/require() call(s) and is not in the allow-list`
      );
    }
    expect(violations).toEqual([]);

    // An allow-list entry for a file that no longer needs it is a stale exception.
    const stale = Object.keys(NON_LITERAL_DYNAMIC_IMPORT_ALLOWLIST).filter(
      (relPath) => !seenAllowlisted.has(relPath)
    );
    expect(stale).toEqual([]);
  });
});
