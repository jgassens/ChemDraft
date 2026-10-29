import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { rollup, type OutputBundle } from "rollup";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { assertWorkerEntriesAreNotImported, assertWorkerEntriesStartSynchronously, workerChunksGuard, workerRuntimeChunks } from "./workerChunks";

/** Real Rollup code splitting, without chemistry engines or a second app build in every test run. */
async function bundleFixture(manual: boolean, guard: boolean, entry = 'import "runtime";', runtime?: string) {
  const modules: Record<string, string> = {
    entry,
    runtime: runtime ?? 'import { shared } from "shared"; globalThis.workerReady = shared; globalThis.addEventListener("message", async () => { globalThis.result = await import("lazy"); });',
    shared: 'export const shared = Math.random();',
    lazy: 'import { shared } from "shared"; export const result = shared;'
  };
  const build = await rollup({ input: "entry", preserveEntrySignatures: false,
    plugins: [{ name: "virtual-worker-fixture", resolveId: id => id in modules ? id : null,
      load: id => modules[id] }, ...(guard ? [workerChunksGuard()] : [])] });
  try { return await build.generate({ format: "es", entryFileNames: "assets/[name]-[hash].js", chunkFileNames: "assets/[name]-[hash].js",
    ...(manual ? { manualChunks: workerRuntimeChunks(), onlyExplicitManualChunks: true } : {}) }); }
  finally { await build.close(); }
}

describe("production worker chunk boundary", () => {
  it("reproduces Rollup exporting shared dependencies from a worker entry and rejects it", async () => {
    const output = await bundleFixture(false, false);
    const bundle = Object.fromEntries(output.output.map(chunk => [chunk.fileName, chunk])) as OutputBundle;
    expect(() => assertWorkerEntriesAreNotImported(bundle)).toThrow(/static import of worker entry/);
    await expect(bundleFixture(false, true)).rejects.toThrow(/static import of worker entry/);
  });

  it("uses static startup imports, keeps shared bindings in a runtime chunk and leaves engines lazy", async () => {
    const output = await bundleFixture(true, true);
    const chunks = output.output.filter(item => item.type === "chunk");
    const entry = chunks.find(chunk => chunk.isEntry)!;
    const runtime = chunks.find(chunk => chunk.name === "worker-runtime")!;
    const lazy = chunks.find(chunk => chunk.name === "lazy")!;
    expect(entry.exports).toEqual([]);
    expect(entry.imports).toEqual([runtime.fileName]);
    expect(entry.dynamicImports).toEqual([]);
    expect(lazy.imports).toEqual([runtime.fileName]);
    expect(runtime.dynamicImports).toEqual([lazy.fileName]);
    expect(output.output.some(item => item.type === "asset" && item.fileName === "worker-chunks/entry.json")).toBe(true);
  });

  it("also rejects dynamic imports of an entry", async () => {
    const output = await bundleFixture(true, false);
    const bundle = Object.fromEntries(output.output.map(chunk => [chunk.fileName, chunk])) as OutputBundle;
    const chunks = output.output.filter(item => item.type === "chunk");
    chunks.find(chunk => !chunk.isEntry)!.dynamicImports.push(chunks.find(chunk => chunk.isEntry)!.fileName);
    expect(() => assertWorkerEntriesAreNotImported(bundle)).toThrow(/dynamic import of worker entry/);
  });

  it.each([
    'await import("runtime");',
    'import "runtime"; await Promise.resolve();',
    'import "runtime"; for await (const item of []) { globalThis.item = item; }',
    'import("runtime");'
  ])("rejects asynchronous entry evaluation: %s", async entry => {
    const output = await bundleFixture(true, false, entry);
    const bundle = Object.fromEntries(output.output.map(chunk => [chunk.fileName, chunk])) as OutputBundle;
    expect(() => assertWorkerEntriesStartSynchronously(bundle)).toThrow(/top-level (await|dynamic import)/);
    await expect(bundleFixture(true, true, entry)).rejects.toThrow(/top-level (await|dynamic import)/);
  });

  it("also rejects top-level await in a statically imported runtime", async () => {
    await expect(bundleFixture(true, true, undefined,
      'await Promise.resolve(); globalThis.addEventListener("message", () => {});'))
      .rejects.toThrow(/worker-runtime.*top-level await/);
  });

  it("does not confuse comments/strings or async handlers with top-level await", async () => {
    await expect(bundleFixture(true, true, 'import "runtime"; globalThis.note = "await import(ignored)"; /* await */'))
      .resolves.toBeDefined();
  });

  it("runs in every Vite production worker build, including the existing CI build step", () => {
    expect(readFileSync("apps/desktop/vite.config.ts", "utf8"))
      .toMatch(/plugins:\s*\(\)\s*=>\s*\[workerChunksGuard\(\)\]/);
    expect(readFileSync("apps/desktop/vite.config.ts", "utf8"))
      .toMatch(/manualChunks:\s*workerRuntimeChunks\(\)/);
  });
});

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) return ["node_modules", "dist"].includes(entry.name) ? [] : sources(file);
    return entry.isFile() && /\.(?:[cm]?ts|tsx|[cm]?js)$/.test(file) && !/\.test\./.test(file) ? [file] : [];
  });
}

it("audits every desktop/package module-worker URL/?worker import and forbids runtime imports of entries", () => {
  const files = [...sources("apps/desktop/src"), ...sources("packages")];
  const entries = new Set<string>();
  const imports: { importer: string; imported: string }[] = [];
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const add = (specifier: string) => {
      if (specifier.includes("?worker")) entries.add(resolve(dirname(file), specifier.split("?")[0]));
      else if (specifier.startsWith(".")) imports.push({ importer: file, imported: resolve(dirname(file), specifier).replace(/\.(?:ts|js)$/, "") });
    };
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text);
      if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) add(node.arguments[0].text);
      if (ts.isNewExpression(node) && node.expression.getText(source) === "Worker") {
        const url = node.arguments?.[0];
        const options = node.arguments?.[1];
        const moduleWorker = options && ts.isObjectLiteralExpression(options) && options.properties.some(property =>
          ts.isPropertyAssignment(property) && property.name.getText(source) === "type" &&
          ts.isStringLiteral(property.initializer) && property.initializer.text === "module");
        // Node worker_threads transports use execArgv/workerData, not browser module-worker options.
        if (moduleWorker && url && ts.isNewExpression(url) && url.expression.getText(source) === "URL" && url.arguments?.[0] && ts.isStringLiteral(url.arguments[0])) {
          entries.add(resolve(dirname(file), url.arguments[0].text));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect([...entries].map(file => relative(resolve("apps/desktop/src"), file).replaceAll("\\", "/")).sort()).toEqual([
    "analysisWorker.ts", "conformerWorker.ts", "depiction2d/identityWorker.ts", "depiction2d/worker.ts",
    "plugins/workers/massFragmentPluginWorker.ts", "plugins/workers/windowsMassFragmentPluginWorker.ts"
  ]);
  for (const entry of entries) {
    expect(readFileSync(entry, "utf8")).toContain("recordWorkerEntryEvaluation(");
    expect(imports.filter(edge => edge.imported === entry.replace(/\.ts$/, "")), entry).toEqual([]);
  }
  // The Node perf harness bundles without splitting, so it cannot create a worker-entry back edge.
  expect(readFileSync("apps/desktop/src/chemistry3d/perfWorker.ts", "utf8")).toContain("recordWorkerEntryEvaluation(");
});
