import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import { collectCommandSignatures, commandSignatures, signatureSnapshot } from "./commandSignatures";
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.[jt]sx?$/.test(path) && !/\.(test|spec)\./.test(path) ? [path] : [];
  });
}
const diagnostic = /\b(?:\w*(?:perf|probe)\w*|NativeOpen|ForwardInput)\b/i;
function contaminatedCalls(text: string) {
  const source = ts.createSourceFile("surface.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const errors: string[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isCallExpression(node) && /(?:^|\.)invoke$/.test(node.expression.getText(source))) {
      const command = node.arguments[0];
      if (command && ts.isStringLiteral(command) && !command.text.startsWith("perf_log_")) {
        if (node.arguments.slice(1).some(arg => diagnostic.test(arg.getText(source)))
          || node.typeArguments?.some(arg => diagnostic.test(arg.getText(source)))) errors.push(node.getText(source));
        if (["toggle_preferences_window", "toggle_spin3d_debugger_window"].includes(command.text)
          && (node.arguments.length !== 1 || node.typeArguments?.length)) errors.push(node.getText(source));
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return errors;
}
it("pins every non-perf Rust command to the checked-in snapshot without Git history", () => {
  const current = collectCommandSignatures();
  expect(current).toEqual(JSON.parse(readFileSync(signatureSnapshot, "utf8")));
  expect(current.length).toBeGreaterThan(100);
  expect(current.some(signature => signature.file === "dialog_windows.rs" && signature.name === "dialog_open")).toBe(true);
  expect(current.some(signature => signature.file === "export.rs")).toBe(true);
  expect(current.some(signature => signature.file.includes("/"))).toBe(true);
  for (const signature of current) {
    expect([signature.name, signature.generics, signature.parameters, signature.returnType].join(" "), `${signature.file}: ${signature.name}`).not.toMatch(diagnostic);
  }
});
it("scans names, multiline parameters and return types, including commands with perf names outside perf_log.rs", () => {
  expect(commandSignatures(`#[tauri::command]
pub(crate) async fn perf_leak(
    input: Option<ProbeInput>,
) -> Result<ProbeResult, String> {}`)).toEqual([{
    name: "perf_leak", async: true, generics: "", parameters: "input: Option<ProbeInput>,", returnType: "Result<ProbeResult, String>"
  }]);
  expect(() => commandSignatures("#[tauri::command]\nnot_a_function")).toThrow("Cannot scan");
  expect(commandSignatures(`#[tauri::command(
    rename_all = "snake_case"
)]
pub fn generic<R: Runtime>(callback: fn(u32) -> u32) -> Result<(), String> {}`)).toEqual([{
    name: "generic", async: false, generics: "<R: Runtime>", parameters: "callback: fn(u32) -> u32", returnType: "Result<(), String>"
  }]);
});
it("keeps diagnostic identifiers out of all non-perf invoke call arguments and return types", () => {
  expect(sourceFiles("apps/desktop/src").flatMap(file => contaminatedCalls(readFileSync(file, "utf8")).map(call => `${file}: ${call}`))).toEqual([]);
});
it.each([
  'invoke("toggle_preferences_window", { perfOpen: open })',
  'invoke<boolean>("toggle_spin3d_debugger_window")',
  'invoke("route_toolset_command", { commandId, perfOrigin })',
  'invoke<NativeOpen>("open_toolset_window", { request })'
])("rejects an app IPC contaminated by diagnostics: %s", source => {
  expect(contaminatedCalls(source).length).toBeGreaterThan(0);
});
