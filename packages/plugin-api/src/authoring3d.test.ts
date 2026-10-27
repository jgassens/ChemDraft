import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

it("type-checks the actual AUTHORING 3D insertion example against the public API", () => {
  const guide = readFileSync(new URL("../../../docs/plugin-architecture/AUTHORING.md", import.meta.url), "utf8");
  const section = guide.slice(guide.indexOf("Use this sequence for a genuine host"));
  const snippet = section.split("```ts\n")[1]?.split("```")[0];
  expect(snippet).toBeTruthy();
  const filename = fileURLToPath(new URL("./authoring3d.virtual.ts", import.meta.url));
  const source = `import type { PluginCommandContext, Plugin3DModel } from "./index";
    declare function moveComponent(model: Plugin3DModel, index: number, delta: { x: number; y: number; z: number }): Plugin3DModel;
    export async function example(context: PluginCommandContext, hostSmiles: string, guestSmiles: string) {
      ${snippet}
    }`;
  const config = ts.readConfigFile(fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)), ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, fileURLToPath(new URL("../../../", import.meta.url)));
  const host = ts.createCompilerHost(options);
  const getSource = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version, onError, create) => name === filename
    ? ts.createSourceFile(name, source, version, true) : getSource(name, version, onError, create);
  const program = ts.createProgram([filename], { ...options, noEmit: true }, host);
  const diagnostics = program.getSemanticDiagnostics(program.getSourceFile(filename));
  expect(diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
});
