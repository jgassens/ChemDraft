import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
import { runtimeMethods } from "./runtimeBrokerProtocol";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

it("keeps the owner out of the main window's static module graph and starts it only from the lazy native host route", () => {
  const seen = new Set<string>();
  function visit(path: string) {
    if (seen.has(path)) return;
    seen.add(path);
    const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    for (const statement of file.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      if (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.every(element => element.isTypeOnly)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith(".")) continue;
      const base = resolve(dirname(path), specifier);
      const dependency = [base + ".ts", base + ".tsx", resolve(base, "index.ts"), resolve(base, "index.tsx")].find(existsSync);
      if (dependency) visit(dependency);
    }
  }
  visit(fileURLToPath(new URL("../MainWindow.tsx", import.meta.url)));
  expect([...seen].filter(path => /\/(?:pluginRuntimeOwner|localPluginRuntime|runtimeHostSession|usePluginRuntime)\.[^.]+$/.test(path))).toEqual([]);
  const hook = source("./usePluginRuntimeView.ts");
  expect(hook).toContain('isTauriHost() ? runtimeDocumentSession(providers) : browserSession(providers)');
  expect(hook).toContain('isTauriHost() ? undefined : await import("./localPluginRuntime")');
  expect(source("./runtimeDocumentSession.ts")).not.toMatch(/createPluginRuntime|createPluginRuntimeOwner|RuntimeBrokerHost/);
  expect(source("./runtimeHostSession.ts")).toContain("await registry.ready;");
  expect(source("./runtimeHostSession.ts").indexOf("await registry.ready;")).toBeLessThan(source("./runtimeHostSession.ts").indexOf("const owner = createOwner("));
  const app = source("../App.tsx");
  expect(app.indexOf("if (isRuntimeHostRoute())")).toBeLessThan(app.indexOf("const dialog = dialogRoute()"));
  expect(app).toContain('lazy(() => import("./plugins/RuntimeHostWindow")');
});

it("starts the shared hidden native configuration in release builds and keeps failures out of drawing startup", () => {
  const rust = source("../../src-tauri/src/runtime_broker.rs");
  const config = rust.split("fn runtime_window_config()")[1]!.split("pub(crate) fn create_runtime_window")[0]!;
  for (const flag of ["focus: false", "focusable: false", "visible: false", "skip_taskbar: true"]) expect(config).toContain(flag);
  expect(config).toContain('label: HOST.into()');
  expect(config).toContain('"/?window=runtime"');
  expect(config).not.toMatch(/parent:|#\[cfg/);
  const builder = rust.split("pub(crate) fn create_runtime_window")[1]!;
  expect(builder).not.toMatch(/debug_assertions|CHEMDRAFT_RUNTIME_HOST_WINDOW|\.set_menu\(|\.register\(|\.show\(/);
  const lib = source("../../src-tauri/src/lib.rs");
  expect(lib).toContain("if let Err(error) = runtime_broker::create_runtime_window(app)");
  const setup = lib.slice(lib.indexOf("let naming = app.state::<naming_engine::NamingEngineState>()"));
  expect(setup.indexOf("runtime_broker::create_runtime_window(app)")).toBeLessThan(setup.indexOf("if let Err(error) = ensure_main_window_visible(app)"));
});

it("keeps every native method direction in step with the typed protocol", () => {
  const rust = source("../../src-tauri/src/runtime_broker.rs");
  const directions = rust.split("let runtime_destination = match method {")[1]!.split('_ => return Err("Unknown runtime broker method.")')[0]!;
  const native = new Map<string, string>();
  for (const match of directions.matchAll(/((?:\s*\|?\s*"[A-Za-z]+")+)\s*=>\s*(true|false)/g)) {
    for (const name of match[1]!.matchAll(/"([A-Za-z]+)"/g)) native.set(name[1]!, match[2] === "true" ? "runtime" : "document");
  }
  expect(Object.fromEntries(native)).toEqual(Object.fromEntries(Object.entries(runtimeMethods).map(([method, contract]) => [method, contract.destination])));
  expect(rust).toContain('if kind == "runtimeView"');
  expect(rust).toContain('target != Some(document)');
});

it("gives the host only controller, scoped storage and fixed-release grants while pickers stay document-owned", () => {
  const grant = JSON.parse(source("../../src-tauri/capabilities/runtime-host-services.json"));
  expect(grant.windows).toEqual(["runtime"]);
  const ids: string[] = grant.permissions.map((p: string | { identifier: string }) => typeof p === "string" ? p : p.identifier);
  expect(ids).not.toContain("core:default");
  expect(ids.filter(id => /core:window:|core:webview:|core:event:allow-emit|dialog:|clipboard|document-session|toolset-window|quit-after|suspend-toolset/.test(id))).toEqual([]);
  for (const controller of ["naming-engine", "ocsr-engine", "external-tools", "assistant-mcp", "plugin-updates"]) {
    const existing = JSON.parse(source(`../../src-tauri/capabilities/${controller}.json`));
    for (const permission of existing.permissions) expect(grant.permissions).toContainEqual(permission);
  }
  for (const permission of grant.permissions) {
    if (typeof permission !== "object" || !permission.identifier.startsWith("fs:")) continue;
    for (const rule of permission.allow) expect(rule.path).toMatch(/^\$APPDATA\/installed-plugins(?:\.json(?:\.tmp)?|\/\*\*)?$/);
  }
  expect(ids).toContain("fs:allow-read-file");
  expect(ids).toContain("fs:allow-stat");
  expect(source("./runtimeDocumentSession.ts")).toContain('broker.handle("chooseRuntimeFile"');
  const packageReader = source("../../src-tauri/src/plugin_package.rs");
  expect(packageReader).toContain('window.label() != "runtime"');
  expect(packageReader).toContain("app.fs_scope().is_allowed(path)");
  expect(packageReader).toContain("if !is_allowed(&zip)");
});
