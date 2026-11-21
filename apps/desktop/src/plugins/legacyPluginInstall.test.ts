import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { applyPatch, createEmptyDocument, TextObjectSchema } from "@chemdraft/chem-core";
import { PLUGIN_WORKER_PROTOCOL_VERSION, type PluginWorkerHandle } from "@chemdraft/plugin-api";
import { expect, it } from "vitest";
import { commandId, manifest, panelId } from "../../../../examples/plugins/request-tools-legacy-fixture/src/index";
import { createCommittedPluginCopy, removeCommittedPluginCopy } from "../../../../tools/plugin-package/committedCopy";
import { packagePlugin } from "../../../../tools/plugin-package/package";
import { createPluginRuntime } from "./createPluginRuntime";
import { inspectPluginPackage, installPluginPackage, type InstalledPlugin } from "./installPluginPackage";
import { loadInstalledPluginRecords } from "./installedPluginStore";
import type { PluginStagingFs } from "./pluginStagingFs";
import { buildPluginSelectionSnapshot } from "./selectionSnapshot";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const fixtureRoot = join(repoRoot, "examples", "plugins", "request-tools-legacy-fixture");

const workerBootstrap = new URL("data:text/javascript," + encodeURIComponent(`
  import { parentPort, workerData } from "node:worker_threads";
  globalThis.postMessage = message => parentPort.postMessage(message);
  globalThis.addEventListener = (type, listener) => {
    if (type === "message") parentPort.on("message", data => listener({ data }));
  };
  await import(workerData);
`));

function stagingFs(root: string): PluginStagingFs {
  async function stage(path: string, content: string | Uint8Array) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return {
    writeFile: stage,
    writeTextFile: stage,
    async readTextFile(path) {
      const file = join(root, path);
      return existsSync(file) ? readFile(file, "utf8") : undefined;
    },
    rename: (from, to) => rename(join(root, from), join(root, to)),
    removeDir: path => rm(join(root, path), { recursive: true, force: true }),
    async readDirNames(path) {
      const dir = join(root, path);
      if (!existsSync(dir)) return [];
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
    },
    async mkdir(path) { await mkdir(join(root, path), { recursive: true }); },
    async exists(path) { return existsSync(join(root, path)); }
  };
}

it("installs the packaged API 0.1.25 worker, runs its legacy commands and refuses the 0.1.26 opt-ins", async () => {
  const blank = createEmptyDocument({ title: "First document" });
  const pageId = blank.pages[0]!.id;
  const text = TextObjectSchema.parse({ id: "caption", type: "text", text: "Caption", x: 10, y: 10, width: 80, height: 20 });
  let document = applyPatch(blank, { op: "batch", patches: [
    { op: "addObject", pageId, object: text },
    { op: "setSelection", pageId, objectIds: [text.id] }
  ] });
  const runtime = createPluginRuntime({
    getActiveDocument: () => document,
    getSelection: () => buildPluginSelectionSnapshot(document),
    defaultPanelSurface: "inApp"
  });
  const copy = createCommittedPluginCopy(fixtureRoot, "chemdraft-legacy-plugin-");
  const appData = join(copy.caseRoot, "app-data");
  const fs = stagingFs(appData);
  const workerMessages: unknown[] = [];
  const hostMessages: unknown[] = [];
  let worker: Worker | undefined;
  let installed: InstalledPlugin | undefined;

  // Adapt the browser's worker and staging ports to Node. The worker imports the entry from
  // the install directory populated by installPluginPackage from the verified ZIP.
  function createWorker(url: URL): PluginWorkerHandle {
    const file = join(appData, ...url.pathname.slice(1).split("/").map(decodeURIComponent));
    const thread = new Worker(workerBootstrap, { workerData: pathToFileURL(file).href });
    worker = thread;
    return {
      addEventListener(...[type, listener]:
        | ["message", (event: { data: unknown }) => void]
        | ["error" | "messageerror", (event: unknown) => void]
      ) {
        if (type === "message") thread.on("message", data => {
          workerMessages.push(data);
          listener({ data });
        });
        else thread.on(type, listener);
      },
      postMessage(message) {
        hostMessages.push(message);
        thread.postMessage(message);
      },
      terminate() { void thread.terminate(); }
    };
  }

  try {
    const packaged = await packagePlugin({ pluginRoot: copy.pluginRoot, outDir: join(copy.caseRoot, "out"), repoRoot });
    const inspection = await inspectPluginPackage({
      zipBytes: await readFile(packaged.zipPath),
      sidecar: await readFile(packaged.checksumPath, "utf8")
    });
    expect(inspection.manifest.apiVersion).toBe("^0.1.25");
    expect(inspection.sourceChecksum).toBe(packaged.sha256);
    await fs.writeTextFile("package.json", JSON.stringify({ type: "module" }));
    runtime.notifyActiveDocumentChanged("first");
    installed = await installPluginPackage({ runtime, fs, inspection, origin: "http://tauri.localhost", createWorker });
    expect(workerMessages).toContainEqual({
      kind: "ready",
      protocolVersion: PLUGIN_WORKER_PROTOCOL_VERSION,
      apiVersion: "^0.1.25",
      hasAssistantToolHandler: false,
      features: { requestCapabilities: true, toolCalls: true, activeDocumentChanged: true }
    });
    expect(await loadInstalledPluginRecords(fs)).toEqual([installed.record]);
    expect(runtime.host.getPlugin(manifest.id)?.manifest).toEqual(inspection.manifest);
    await expect(runtime.invokeCommand(commandId("readDocument"))).resolves.toEqual({ title: "First document" });
    await expect(runtime.invokeCommand(commandId("readSelection"))).resolves.toEqual({ objectIds: [text.id] });
    expect(runtime.panels.getOpenPanel()).toMatchObject({
      pluginId: manifest.id, panelId,
      report: { sections: [{ kind: "text", body: JSON.stringify({ objectIds: [text.id] }, null, 2) }] }
    });

    await expect(runtime.invokeCommand(commandId("beginRequest"))).resolves.toMatchObject({
      ok: false, error: { code: "unsupported" }
    });
    expect(workerMessages).toContainEqual(expect.objectContaining({
      kind: "capabilityRequest", namespace: "requests", method: "begin"
    }));
    expect(installed.descriptor.bridge.hasToolHandler()).toBe(false);
    const context = runtime.host.createCommandContext(manifest.id);
    await expect(installed.descriptor.bridge.invokeTool(
      context,
      { requestId: "request", sessionId: "session", name: "lookup", input: {} },
      new AbortController().signal
    )).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(hostMessages).not.toContainEqual(expect.objectContaining({ kind: "invokeTool" }));

    document = createEmptyDocument({ title: "Second document" });
    runtime.notifyActiveDocumentChanged("second");
    // The worker's startup opt-in is its subscription. Only the host sees the delivery result.
    await expect(installed.descriptor.bridge.notifyActiveDocumentChanged({ documentKey: "second", sequence: 2 }))
      .resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
    await expect(runtime.invokeCommand(commandId("events"))).resolves.toEqual({ receivedEvents: 0 });
    expect(hostMessages).not.toContainEqual(expect.objectContaining({ kind: "activeDocumentChanged" }));
    await expect(runtime.invokeCommand(commandId("readDocument"))).resolves.toEqual({ title: "Second document" });
    await expect(runtime.invokeCommand(commandId("readSelection"))).resolves.toEqual({ objectIds: [] });
  } finally {
    if (installed) {
      runtime.unregisterPlugin(installed.record.id);
      installed.descriptor.deactivate?.();
    }
    await worker?.terminate();
    removeCommittedPluginCopy(copy);
  }
}, 60_000);
