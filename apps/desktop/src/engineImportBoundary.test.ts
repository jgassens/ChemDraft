import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const engines = new Set(["openchemlib", "@chemdraft/ocl-adapter"]);

function runtimeEngineImports(source: string, allowDynamicImport = false): string[] {
  const file = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: string[] = [];
  const check = (node: ts.Node) => {
    let specifier: ts.Expression | undefined;
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typesOnly = clause?.isTypeOnly || (!clause?.name && bindings && ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 && bindings.elements.every(binding => binding.isTypeOnly));
      if (!typesOnly) specifier = node.moduleSpecifier;
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
      const typesOnly = node.exportClause && ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.length > 0 && node.exportClause.elements.every(binding => binding.isTypeOnly);
      if (!typesOnly) specifier = node.moduleSpecifier;
    } else if (ts.isCallExpression(node) && ((!allowDynamicImport && node.expression.kind === ts.SyntaxKind.ImportKeyword) ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      specifier = node.arguments[0];
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
      specifier = node.moduleReference.expression;
    }
    if (specifier && ts.isStringLiteralLike(specifier) && [...engines].some(engine =>
      specifier.text === engine || specifier.text.startsWith(`${engine}/`))) {
      violations.push(specifier.text);
    }
    ts.forEachChild(node, check);
  };
  check(file);
  return violations;
}

describe("startup document/interaction engine boundary", () => {
  it("recognizes runtime imports while allowing type-only references", () => {
    expect(runtimeEngineImports(`
      import type { Reader } from "@chemdraft/ocl-adapter";
      import { type Molecule } from "openchemlib";
      type Module = typeof import("@chemdraft/ocl-adapter");
    `)).toEqual([]);
    expect(runtimeEngineImports(`
      import { Molecule } from "openchemlib";
      import "@chemdraft/ocl-adapter";
      const engine = import("@chemdraft/ocl-adapter");
      const other = require("openchemlib");
      export { reader } from "@chemdraft/ocl-adapter";
    `)).toHaveLength(5);
  });

  it("keeps document workflow and non-test interaction files free of runtime engine imports", () => {
    const root = new URL("./", import.meta.url);
    const files = ["documentWorkflow.ts", ...readdirSync(new URL("interaction/", root), { recursive: true })
      .filter((name): name is string => typeof name === "string" && /\.[cm]?[jt]sx?$/.test(name) &&
        !/\.(test|spec)\.[cm]?[jt]sx?$/.test(name))
      .map(name => `interaction/${name}`)];
    for (const name of files) {
      const file = new URL(name, root);
      expect(runtimeEngineImports(readFileSync(file, "utf8")), fileURLToPath(file)).toEqual([]);
    }
  });

  it("allows lazy engine imports in MainWindow while rejecting static runtime imports", () => {
    expect(runtimeEngineImports(`
      import type { Reader } from "@chemdraft/ocl-adapter";
      const engine = await import("@chemdraft/ocl-adapter");
      const ocl = await import("openchemlib");
    `, true)).toEqual([]);
    expect(runtimeEngineImports(`
      import { Molecule } from "openchemlib";
      import "@chemdraft/ocl-adapter";
      import { reader } from "@chemdraft/ocl-adapter/stereo";
      export { reader } from "@chemdraft/ocl-adapter";
      const engine = require("openchemlib");
    `, true)).toHaveLength(5);
    const file = new URL("./MainWindow.tsx", import.meta.url);
    expect(runtimeEngineImports(readFileSync(file, "utf8"), true), fileURLToPath(file)).toEqual([]);
  });
});
