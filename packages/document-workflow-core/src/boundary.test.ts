import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// This package exists so the headless CLI can build documents without loading the desktop app. It
// stays useful only while it stays pure: no desktop source, no UI framework, no Tauri, and no
// plugin or 3D-engine runtime. See README.md.

const packageSrc = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageSrc, "../../..");
const appsRoot = join(repoRoot, "apps");
const thisFile = fileURLToPath(import.meta.url);

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];

const FORBIDDEN_PACKAGES = [
  "react",
  "react-dom",
  "@tauri-apps",
  "@chemdraft/desktop",
  "@chemdraft/plugin-api",
  "@chemdraft/plugin-host",
  "@chemdraft/engine3d-api"
];

// README.md / AGENTS.md §6.28: these packages may only be reached for their types.
const TYPE_ONLY_PACKAGES = ["@chemdraft/export-engine", "@chemdraft/rdkit-adapter"];

// Every form that makes a file load another module: static `import ... from`, a side-effect
// `import "x"`, `export ... from`/`export * from`, dynamic `import("x")`, and `require("x")`
// (which also covers `import x = require("x")`, since it contains a `require(...)` call).
const SPECIFIER_PATTERN =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;

function extractSpecifiers(source: string): string[] {
  return [...source.matchAll(SPECIFIER_PATTERN)].map((match) => match[1]!);
}

function forbiddenReason(file: string, specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const target = resolve(dirname(file), specifier);
    return target === appsRoot || target.startsWith(appsRoot + sep) ? "desktop app source" : undefined;
  }
  const blocked = FORBIDDEN_PACKAGES.find((name) => specifier === name || specifier.startsWith(`${name}/`));
  return blocked ? `forbidden package ${blocked}` : undefined;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext)) ? [path] : [];
  });
}

// A dynamic `import(...)` or `require(...)` whose argument is not a string literal cannot be
// checked statically by this scan, and this package has no reason to need one (README.md: no
// engine loading — the caller resolves and passes in whatever it needs).
const DYNAMIC_CALL_PATTERN = /\b(?:import|require)\s*\(\s*(["'`]?)/g;

function nonLiteralDynamicCalls(source: string): number {
  let count = 0;
  for (const match of source.matchAll(DYNAMIC_CALL_PATTERN)) {
    if (match[1] !== '"' && match[1] !== "'") count++;
  }
  return count;
}

function typeOnlyPackage(specifier: string): string | undefined {
  return TYPE_ONLY_PACKAGES.find((name) => specifier === name || specifier.startsWith(`${name}/`));
}

// import/export declarations naming a type-only package: the whole statement, or every named
// binding, must be `type`.
const IMPORT_DECLARATION_PATTERN =
  /\b(?:import|export)\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/g;
const SIDE_EFFECT_IMPORT_PATTERN = /\bimport\s+["']([^"']+)["']/g;
// `typeof import("x")` is a type position and always allowed; a bare `import("x")` or
// `require("x")` loads the module at runtime and is not.
const DYNAMIC_OR_REQUIRE_PATTERN =
  /\btypeof\s+import\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

function typeOnlyViolations(source: string): string[] {
  const violations: string[] = [];

  for (const match of source.matchAll(IMPORT_DECLARATION_PATTERN)) {
    const [, typeKeyword, clause, specifier] = match;
    const pkg = typeOnlyPackage(specifier!);
    if (!pkg || typeKeyword) continue;
    const named = clause!.trim().match(/^\{([^}]*)\}$/);
    const bindings = named ? named[1]!.split(",").map((b) => b.trim()).filter(Boolean) : null;
    if (!bindings || bindings.some((binding) => !binding.startsWith("type "))) {
      violations.push(`value import of type-only package ${specifier} (${clause!.trim()})`);
    }
  }

  for (const match of source.matchAll(SIDE_EFFECT_IMPORT_PATTERN)) {
    const pkg = typeOnlyPackage(match[1]!);
    if (pkg) violations.push(`side-effect import of type-only package ${match[1]}`);
  }

  for (const match of source.matchAll(DYNAMIC_OR_REQUIRE_PATTERN)) {
    const [, typeofSpecifier, dynamicSpecifier, requireSpecifier] = match;
    const specifier = typeofSpecifier ?? dynamicSpecifier ?? requireSpecifier;
    if (!specifier || typeofSpecifier) continue;
    const pkg = typeOnlyPackage(specifier);
    if (pkg) {
      violations.push(
        `runtime ${requireSpecifier ? "require" : "import"}() of type-only package ${specifier}`
      );
    }
  }

  return violations;
}

const packageJsonPath = join(packageSrc, "..", "package.json");

function declaredDependencyNames(): string[] {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(pkg.dependencies ?? {});
}

function undeclaredPackageSpecifier(specifier: string, declared: string[]): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return undefined;
  if (specifier.startsWith("node:")) return undefined;
  const declaredMatch = declared.some(
    (name) => specifier === name || specifier.startsWith(`${name}/`)
  );
  return declaredMatch ? undefined : specifier;
}

describe("document-workflow-core purity", () => {
  it("recognises every specifier form it scans for", () => {
    const source = [
      'import { a } from "pkg-static";',
      'import "pkg-side-effect";',
      'export { b } from "pkg-export";',
      'export * from "pkg-export-star";',
      'const c = await import("pkg-dynamic");',
      'require("pkg-require");',
      'import d = require("pkg-import-equals");'
    ].join("\n");
    expect(new Set(extractSpecifiers(source))).toEqual(
      new Set([
        "pkg-static",
        "pkg-side-effect",
        "pkg-export",
        "pkg-export-star",
        "pkg-dynamic",
        "pkg-require",
        "pkg-import-equals"
      ])
    );
  });

  it("flags desktop, UI, Tauri, and plugin-runtime imports", () => {
    const file = join(packageSrc, "example.ts");
    const reasons = [
      "../../../apps/desktop/src/documentWorkflow",
      "react",
      "react-dom/client",
      "@tauri-apps/api/core",
      "@chemdraft/plugin-host",
      "@chemdraft/chem-core",
      "./shared"
    ].map((specifier) => forbiddenReason(file, specifier));
    expect(reasons.filter(Boolean)).toHaveLength(5);
  });

  it("rejects a dynamic import()/require() whose argument is not a string literal", () => {
    expect(nonLiteralDynamicCalls("const m = await import(path);")).toBe(1);
    expect(nonLiteralDynamicCalls("const m = require(moduleName);")).toBe(1);
    expect(nonLiteralDynamicCalls('const m = await import("@chemdraft/rdkit-adapter");')).toBe(0);
    expect(nonLiteralDynamicCalls('const m = require("pkg");')).toBe(0);
  });

  it("requires @chemdraft/export-engine and @chemdraft/rdkit-adapter to stay type-only", () => {
    expect(typeOnlyViolations('import type { X } from "@chemdraft/export-engine";')).toEqual([]);
    expect(typeOnlyViolations('export type { X } from "@chemdraft/rdkit-adapter";')).toEqual([]);
    expect(typeOnlyViolations('import { type X } from "@chemdraft/rdkit-adapter";')).toEqual([]);
    expect(
      typeOnlyViolations('type T = typeof import("@chemdraft/rdkit-adapter/identifiers");')
    ).toEqual([]);
    expect(typeOnlyViolations('import { X } from "@chemdraft/rdkit-adapter";')).toHaveLength(1);
    expect(typeOnlyViolations('import Default from "@chemdraft/export-engine";')).toHaveLength(1);
    expect(typeOnlyViolations('import "@chemdraft/rdkit-adapter";')).toHaveLength(1);
    expect(typeOnlyViolations('const m = await import("@chemdraft/rdkit-adapter");')).toHaveLength(1);
    expect(typeOnlyViolations('const m = require("@chemdraft/export-engine");')).toHaveLength(1);
  });

  it("imports nothing from apps/, React, Tauri, or the plugin and 3D runtimes", () => {
    const files = sourceFiles(packageSrc).filter((file) => file !== thisFile);
    expect(files.length).toBeGreaterThan(5);

    const violations = files.flatMap((file) =>
      extractSpecifiers(readFileSync(file, "utf8")).flatMap((specifier) => {
        const reason = forbiddenReason(file, specifier);
        return reason ? [`${relative(repoRoot, file)} imports ${specifier} (${reason})`] : [];
      })
    );
    expect(violations).toEqual([]);
  });

  it("only ever imports @chemdraft/export-engine and @chemdraft/rdkit-adapter for types", () => {
    const files = sourceFiles(packageSrc).filter((file) => file !== thisFile);
    const violations = files.flatMap((file) =>
      typeOnlyViolations(readFileSync(file, "utf8")).map(
        (reason) => `${relative(repoRoot, file)}: ${reason}`
      )
    );
    expect(violations).toEqual([]);
  });

  it("never calls a dynamic import()/require() with a non-literal argument", () => {
    const files = sourceFiles(packageSrc).filter((file) => file !== thisFile);
    const violations = files.flatMap((file) => {
      const count = nonLiteralDynamicCalls(readFileSync(file, "utf8"));
      return count > 0
        ? [`${relative(repoRoot, file)} has ${count} non-literal dynamic import()/require() call(s)`]
        : [];
    });
    expect(violations).toEqual([]);
  });

  it("only imports package.json dependencies or Node builtins", () => {
    const declared = declaredDependencyNames();
    expect(declared.length).toBeGreaterThan(0);

    const files = sourceFiles(packageSrc).filter((file) => file !== thisFile);
    const violations = files.flatMap((file) =>
      extractSpecifiers(readFileSync(file, "utf8")).flatMap((specifier) => {
        const undeclared = undeclaredPackageSpecifier(specifier, declared);
        return undeclared
          ? [`${relative(repoRoot, file)} imports ${undeclared} (not in package.json dependencies)`]
          : [];
      })
    );
    expect(violations).toEqual([]);
  });
});
