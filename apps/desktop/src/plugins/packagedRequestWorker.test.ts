import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { Resvg } from "@resvg/resvg-js";
import { applyPatch, createEmptyDocument, DocumentObjectSchema, TextObjectSchema } from "@chemdraft/chem-core";
import { createSmilesMolecule } from "@chemdraft/document-workflow-core";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import { AssistantCapabilityPermissions, PluginApiVersion, type PluginWorkerHandle } from "@chemdraft/plugin-api";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createZipFixture, sidecarFor } from "../testSupport/zipFixture";
import { setDocumentCustomPageSize } from "../documentWorkflow";
import { planRequestPageFit } from "../pageEnlargement";
import { AssistantTransactions } from "../assistant/assistantTransaction";
import { createPluginRuntime } from "./createPluginRuntime";
import { inspectPluginPackage } from "./installPluginPackage";
import { loadPackagedPlugin } from "./loadPackagedPlugin";
import { createRequestHistory } from "./requestWrites/requestHistory";
import { manifest } from "./__fixtures__/requestWorkerManifest";
import type { McpBridgeRequest, McpBridgeResponse } from "./toolSessions/transport";

vi.mock("../nativeRasterExport", async importOriginal => ({
  ...await importOriginal<typeof import("../nativeRasterExport")>(),
  rasterizeSvgNative: async (svg: string) => {
    const rendered = new Resvg(svg).render();
    return { bytes: rendered.asPng(), width: rendered.width, height: rendered.height, warnings: [] };
  }
}));

const bootstrap = new URL("data:text/javascript," + encodeURIComponent(`
  import { parentPort, workerData } from "node:worker_threads";
  globalThis.postMessage = message => parentPort.postMessage(message);
  globalThis.addEventListener = (type, listener) => {
    if (type === "message") parentPort.on("message", data => listener({ data }));
  };
  await import(workerData);
`));
let directory: string;
let packagedManifest: unknown;
const workers: Worker[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "chemdraft-request-worker-"));
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./__fixtures__/requestWorker.ts", import.meta.url))],
    bundle: true, format: "esm", platform: "browser", target: "es2022", write: false
  });
  packagedManifest = { ...manifest, chemdraftPackage: { sdk: "@chemdraft/plugin-api", sdkVersion: PluginApiVersion,
    sourceCommit: "0000000000000000000000000000000000000000", sourceTree: "clean", licenseFile: "LICENSE",
    packagedAt: "2026-11-19T00:00:00.000Z" } };
  const zip = await createZipFixture([
    { path: "manifest.json", content: JSON.stringify(packagedManifest) },
    { path: "entry.js", content: bundle.outputFiles[0]!.contents },
    { path: "LICENSE", content: "MIT" }
  ]);
  const inspected = await inspectPluginPackage({ zipBytes: zip, sidecar: await sidecarFor(zip, "captions.zip") });
  for (const { path, bytes } of inspected.entries) await writeFile(join(directory, path), bytes);
  await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
}, 20_000);

afterAll(async () => {
  await Promise.all(workers.map(worker => worker.terminate()));
  if (directory) await rm(directory, { recursive: true, force: true });
});

// This test runs the inspected bundle in a Node worker via a file URL. The manual stress
// checklist covers installed worker loading in native WKWebView and WebView2.
function loadWorker() {
  return loadPackagedPlugin({ manifest: packagedManifest, baseUrl: new URL("./", pathToFileURL(join(directory, "entry.js"))) }, {
    createWorker: url => {
      const worker = new Worker(bootstrap, { workerData: url.href });
      workers.push(worker);
      return {
        addEventListener(type: string, listener: (event: unknown) => void) {
          if (type === "message") worker.on("message", data => listener({ data }));
          else worker.on(type, listener);
        },
        postMessage: message => worker.postMessage(message),
        terminate: () => { void worker.terminate(); }
      } as PluginWorkerHandle;
    }
  });
}

it("matches get_document, get_selection, get_structure and render on a mixed drawing, and preserves placement margins", async () => {
  const blank = setDocumentCustomPageSize(createEmptyDocument({ title: "Captions" }), { width: 120, height: 60, unit: "css-px" });
  const pageId = blank.pages[0]!.id;
  const captionIds = ["first", "second"];
  let pinned = applyPatch(blank, { op: "batch", patches: captionIds.map((id, index) => ({ op: "addObject", pageId,
    object: TextObjectSchema.parse({ id, type: "text", text: id, x: 10 + index * 40, y: 10, width: 25, height: 15 }) })) });
  const molecule = createSmilesMolecule(blank, { x: 40, y: 30 }, depictSmiles2D("CCO"), "CCO");
  const arrow = DocumentObjectSchema.parse({ id: "arrow", type: "reaction-arrow", arrowKind: "forward",
    x: 60, y: 32, width: 35, height: 5, start: { kind: "point", point: { x: 60, y: 32 } },
    end: { kind: "point", point: { x: 95, y: 32 } } });
  pinned = applyPatch(pinned, { op: "batch", patches: [
    { op: "addObject", pageId, object: molecule }, { op: "addObject", pageId, object: arrow },
    { op: "setSelection", pageId, objectIds: [...captionIds, molecule.id] }
  ] });
  let activeKey = "caption-document";
  const other = createEmptyDocument({ title: "Other document" });
  const commit = vi.fn();
  const closed = vi.fn();
  const onEdit = () => () => {};
  const transactions = new AssistantTransactions({
    read: () => pinned, onUserEdit: onEdit, push: () => {}, amend: () => {}, select: () => {}, undo: () => false
  });
  let listener: ((request: McpBridgeRequest) => void) | undefined;
  const responses = new Map<string, (response: McpBridgeResponse) => void>();
  const prompt = vi.fn(async () => "enlarge" as const);
  const runtime = createPluginRuntime({
    getActiveDocument: () => activeKey === "caption-document" ? pinned : other,
    getActiveDocumentKey: () => activeKey,
    getActiveDocumentTab: () => ({ id: activeKey }),
    captureRequestDocument: () => activeKey === "caption-document"
      ? { key: activeKey, read: () => pinned } : { key: activeKey, read: () => other },
    getAssistantDocument: () => pinned,
    assistantTransactions: () => transactions,
    requestPageSpace: { plan: planRequestPageFit, confirm: prompt },
    openRequestHistory: (document, label) => createRequestHistory(document, {
      run: async apply => apply(), onEdit,
      commit: (after, text, amend, guard) => { guard(after); pinned = after; commit(text, amend); }
    }, label),
    assistantMcpEngine: {
      open: async (_plugin, bridge) => { listener = bridge; return { sessionId: "caption-tools", serverName: "chemdraft" }; },
      status: async () => ({ listening: true, sessionCount: 1 }),
      close: async id => { closed(id); },
      respond: async (_id, requestId, response) => { responses.get(requestId)?.(response); responses.delete(requestId); }
    }
  });
  const descriptor = loadWorker();
  const legacyPlugin = { id: "org.test.captionRead", name: "Caption read", version: "1.0.0", apiVersion: "^0.1.25",
    entry: "entry.js", permissions: [...AssistantCapabilityPermissions] };
  runtime.registerPlugin(legacyPlugin);
  let toolsCommand: Promise<unknown> | undefined;
  try {
    const request = await runtime.assistant.beginRequest(legacyPlugin, { prompt: "Read captions" });
    const legacyRead = (name: string, input: Record<string, unknown> = {}) => runtime.assistant.callTool(legacyPlugin, { name, input });
    const doc = await legacyRead("get_document");
    const selection = await legacyRead("get_selection");
    const structureInput = { objectId: molecule.id, format: "smiles" };
    const renderInput = { target: "document", background: "transparent" };
    const structure = await legacyRead("get_structure", structureInput);
    const render = await legacyRead("render", renderInput);
    await runtime.assistant.endRequest(legacyPlugin, request);
    expect(doc.structuredContent).toMatchObject({ title: "Captions", counts: { text: 2, molecule: 1, "reaction-arrow": 1 } });
    expect(selection.structuredContent?.objects).toHaveLength(3);
    expect(structure.structuredContent).toMatchObject({ structure: "CCO" });
    expect(render.content[0]).toMatchObject({ type: "image", data: expect.stringMatching(/^iVBOR/) });
    runtime.notifyActiveDocumentChanged(activeKey);
    runtime.registerPlugin(descriptor.manifest, descriptor.options);
    expect(await runtime.invokeCommand("plugin.requestWorker.events")).toEqual([{ documentKey: activeKey, sequence: 1 }]);

    const call = (name: string, args: object = {}) => new Promise<McpBridgeResponse>(resolve => {
      const requestId = crypto.randomUUID();
      responses.set(requestId, resolve);
      listener!({ sessionId: "caption-tools", requestId, method: "tools/call", params: { name, arguments: args } });
    });
    toolsCommand = runtime.invokeCommand("plugin.requestWorker.openTools");
    await vi.waitFor(() => expect(listener).toBeTypeOf("function"));
    expect(await call("get_document")).toHaveProperty("result.structuredContent", doc.structuredContent);
    expect(await call("get_selection")).toHaveProperty("result.structuredContent", selection.structuredContent);
    expect(await call("get_structure", structureInput)).toHaveProperty("result.structuredContent", structure.structuredContent);
    expect(await call("render", renderInput)).toEqual({ result: render });
    await runtime.invokeCommand("plugin.requestWorker.finishTools");
    await toolsCommand;
    expect(closed).toHaveBeenCalledWith("caption-tools");

    // Change the active document while the worker is waiting for page consent.
    prompt.mockImplementationOnce(async () => {
      activeKey = "other-document";
      runtime.notifyActiveDocumentChanged(activeKey);
      return "enlarge";
    });
    const result = await runtime.invokeCommand("plugin.requestWorker.arrange");
    expect(result).toMatchObject({ context: { documentKey: "caption-document" }, objectIds: captionIds,
      decision: "enlarge", receipt: { touched: captionIds.map(objectId => ({ pageId, objectId })), insertions: [] },
      png: { mimeType: "image/png", widthPx: 120, heightPx: 40, base64: expect.stringMatching(/^iVBOR/) } });
    expect(pinned.pages[0]!.height).toBeGreaterThan(60);
    expect(other.pages[0]!.objects).toHaveLength(0);
    expect(commit.mock.calls).toEqual([["Arrange captions", false]]);
    expect(prompt).toHaveBeenCalledOnce();
    runtime.notifyActiveDocumentChanged(activeKey);
    runtime.notifyActiveDocumentChanged(null);
    expect(await runtime.invokeCommand("plugin.requestWorker.events")).toEqual([
      { documentKey: "caption-document", sequence: 1 }, { documentKey: activeKey, sequence: 2 }, { documentKey: null, sequence: 3 }
    ]);

    // The compatibility write published in a request session uses the same prompt and history.
    activeKey = "caption-document";
    runtime.notifyActiveDocumentChanged(activeKey);
    listener = undefined;
    toolsCommand = runtime.invokeCommand("plugin.requestWorker.openTools");
    await vi.waitFor(() => expect(listener).toBeTypeOf("function"));
    await expect(call("insert_text", { text: "W".repeat(150) })).resolves.toMatchObject({ result: { structuredContent: {
      objectIds: [expect.any(String)]
    } } });
    expect(pinned.pages[0]!.height).toBe(1500);
    runtime.host.closeRequestsForDocument(activeKey);
    expect(closed).toHaveBeenCalledTimes(2);
    await runtime.invokeCommand("plugin.requestWorker.finishTools");
    await expect(toolsCommand).resolves.toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls.at(-1)).toEqual(["Caption tools", false]);
  } finally {
    if (runtime.host.getPlugin(descriptor.manifest.id)) runtime.unregisterPlugin(descriptor.manifest.id);
    descriptor.deactivate?.();
    transactions.dispose();
    await toolsCommand?.catch(() => {}); // Teardown also ends an open command if a parity assertion failed.
  }
}, 20_000);
