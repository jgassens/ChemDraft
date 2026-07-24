import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import ts from "typescript";

/**
 * The plugin SDK: the ONLY `@chemdraft/*` package an extractable plugin's runtime source may import.
 * Everything a plugin needs (manifest, contributions, command context, panel reports, selection
 * snapshot, analysis records, permissions, and the re-exported document types) is surfaced here.
 * Reaching into any other core package (`chem-core`, `plugin-host`, `ocl-adapter`, …) couples the
 * plugin to ChemDraft internals and breaks standalone extraction (M33/M34).
 */
export const PLUGIN_SDK_PACKAGE = "@chemdraft/plugin-api";
export const DYNAMIC_MODULE_SPECIFIER = "<dynamic module specifier>";

export interface BoundaryViolation {
  /** Plugin-root-relative path of the offending file. */
  file: string;
  /** The disallowed module specifier. */
  specifier: string;
}

/** Every JavaScript/TypeScript source extension Vite accepts without an additional language plugin. */
export const RUNTIME_SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);

export function isRuntimeSourcePath(path: string): boolean {
  return RUNTIME_SOURCE_EXTENSIONS.has(extname(path).toLowerCase());
}

export function isRuntimeTestSourcePath(path: string): boolean {
  return /\.test\.(?:[cm]?[jt]s|[jt]sx)$/i.test(path);
}

function stringLiteralText(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

/**
 * Read actual module specifiers from TypeScript syntax. This deliberately does not scan arbitrary
 * quoted text: a diagnostic string that mentions `@chemdraft/chem-core` is not an import, while a
 * static import, re-export, `require()`, or dynamic `import()` is.
 */
export function listModuleSpecifiers(sourceText: string, fileName = "plugin.ts"): string[] {
  const extension = extname(fileName).toLowerCase();
  let scriptKind = ts.ScriptKind.TS;
  if (extension === ".tsx") scriptKind = ts.ScriptKind.TSX;
  else if (extension === ".jsx") scriptKind = ts.ScriptKind.JSX;
  else if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    scriptKind = ts.ScriptKind.JS;
  }
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = stringLiteralText(node.moduleSpecifier);
      if (specifier) specifiers.push(specifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const specifier = stringLiteralText(node.moduleReference.expression);
      if (specifier) specifiers.push(specifier);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        const specifier = stringLiteralText(node.arguments[0]);
        specifiers.push(specifier ?? DYNAMIC_MODULE_SPECIFIER);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}

/** Runtime JS/TS source files under `src/`, except tests. Tests are excluded because they never ship
 * in the extraction and may legitimately use the host to drive the plugin. */
export function listRuntimeSourceFiles(pluginRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry === "tests" || entry === "__tests__") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (isRuntimeSourcePath(entry) && !isRuntimeTestSourcePath(entry)) {
        out.push(full);
      }
    }
  };
  walk(join(pluginRoot, "src"));
  return out;
}

function escapesPluginSource(file: string, pluginRoot: string, specifier: string): boolean {
  if (isAbsolute(specifier) || specifier.startsWith("file:")) return true;
  if (!specifier.startsWith(".")) return false;

  const target = resolve(dirname(file), specifier);
  const fromSource = relative(resolve(pluginRoot, "src"), target);
  return fromSource === ".." || fromSource.startsWith(`..${sep}`) || isAbsolute(fromSource);
}

/**
 * Every non-portable module specifier in a plugin's shipped runtime source.
 *
 * Allowed:
 * - exactly `@chemdraft/plugin-api`;
 * - ordinary npm packages;
 * - relative imports that stay inside the plugin's shipped `src/` tree.
 *
 * Rejected:
 * - every other `@chemdraft/*` package, including subpaths;
 * - SDK subpaths (only the public package root is a contract);
 * - relative/absolute/file imports that escape the plugin package.
 */
export function checkPluginBoundary(pluginRoot: string, sdkPackage: string = PLUGIN_SDK_PACKAGE): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  for (const file of listRuntimeSourceFiles(pluginRoot)) {
    const sourceText = readFileSync(file, "utf8");
    for (const specifier of listModuleSpecifiers(sourceText, file)) {
      const isDisallowedChemDraftImport = specifier.startsWith("@chemdraft/") && specifier !== sdkPackage;
      if (
        specifier === DYNAMIC_MODULE_SPECIFIER ||
        isDisallowedChemDraftImport ||
        escapesPluginSource(file, pluginRoot, specifier)
      ) {
        violations.push({ file: relative(pluginRoot, file), specifier });
      }
    }
  }
  return violations;
}
