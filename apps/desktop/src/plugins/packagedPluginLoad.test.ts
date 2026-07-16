/**
 * M35 acceptance (ADR-0029 §5): a plugin **loaded from its built package** behaves identically to the
 * statically-bundled path.
 *
 * This is deliberately an integration test rather than a mocked one — it runs the real
 * `pnpm plugin:package` pipeline over the real mass-fragment plugin's source (through the real
 * fail-closed gates), then loads the resulting artifact's `entry.js` in a real worker thread and drives
 * it through the real {@link PluginWorkerBridge} and a real `PluginHost`. Nothing about the plugin is
 * stubbed; the only stand-in is the *kind* of worker, because Node has no DOM `Worker`.
 *
 * The Node worker is a faithful stand-in for this purpose: `runPluginWorker` talks to an *endpoint*
 * (`postMessage` + `addEventListener("message")`), and the bootstrap below gives a Node worker thread
 * exactly that surface, so the built bundle runs unmodified. What it deliberately does NOT prove is URL
 * resolution inside a browser engine — nested `new Worker(new URL(..., import.meta.url))` and asset
 * fetches. That question was answered separately, in a real WKWebView driving a real NMR prediction from
 * the real built package; see reports/0030 for the verdict and its consequences for M36/M37.
 */
import { PluginApiVersion } from "@chemdraft/plugin-api";
import { createMassRegistration, massAnalyzeCommandId, massFragmentManifest } from "@chemdraft/plugin-mass-fragment";
import { PluginHost } from "@chemdraft/plugin-host";
import type { PluginPanelReport, PluginSelectionSnapshot, PluginWorkerHandle } from "@chemdraft/plugin-api";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker as NodeWorker } from "node:worker_threads";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createCommittedPluginCopy,
  removeCommittedPluginCopy,
  type CommittedPluginCopy
} from "../../../../tools/plugin-package/committedCopy";
import { packagePlugin, type PackagePluginResult } from "../../../../tools/plugin-package/package";
import { loadPackagedPlugin, PackagedPluginLoadError, packagedPluginEntryUrl } from "./loadPackagedPlugin";

const repoRoot = new URL("../../../../", import.meta.url).pathname;
const massPluginRoot = join(repoRoot, "examples/plugins/mass-fragment-demo");

/**
 * Give a Node worker thread the Web Worker global surface `runPluginWorker` binds to, then import the
 * package's built entry unmodified. This is the whole adapter — evidence that the built artifact needs
 * nothing but a standard worker endpoint.
 */
const NODE_WORKER_BOOTSTRAP = `
import { parentPort, workerData } from "node:worker_threads";
globalThis.postMessage = (message) => parentPort.postMessage(message);
globalThis.addEventListener = (type, listener) => {
  if (type === "message") parentPort.on("message", (data) => listener({ data }));
};
globalThis.removeEventListener = () => {};
await import(workerData.entryUrl);
`;

const BENZENE: PluginSelectionSnapshot = {
  objectIds: ["m1"],
  molecules: [
    {
      objectId: "m1",
      documentId: "doc1",
      pageId: "p1",
      structureFormat: "smiles",
      structure: "c1ccccc1",
      sourceFingerprint: "fp-benzene"
    }
  ]
};

function makeHost(): { host: PluginHost; reports: { panelId: string; report: PluginPanelReport }[] } {
  const reports: { panelId: string; report: PluginPanelReport }[] = [];
  const host = new PluginHost({
    getSelection: () => BENZENE,
    showPanelReport: (_pluginId, panelId, report) => {
      reports.push({ panelId, report });
    },
    now: () => "2020-01-01T00:00:00.000Z",
    createId: () => "record-fixed-id"
  });
  return { host, reports };
}

let copy: CommittedPluginCopy;
let packaged: PackagePluginResult;
let bootstrapPath: string;
const liveWorkers: NodeWorker[] = [];

function nodeWorkerFactory(entryUrl: URL): PluginWorkerHandle {
  const worker = new NodeWorker(bootstrapPath, { workerData: { entryUrl: entryUrl.href } });
  liveWorkers.push(worker);
  return {
    addEventListener(type: string, listener: unknown): void {
      if (type === "message") {
        worker.on("message", (data: unknown) => (listener as (event: { data: unknown }) => void)({ data }));
      } else if (type === "error" || type === "messageerror") {
        worker.on("error", listener as (error: unknown) => void);
      }
    },
    postMessage(message: unknown): void {
      worker.postMessage(message);
    },
    terminate(): void {
      void worker.terminate();
    }
  } as unknown as PluginWorkerHandle;
}

beforeAll(async () => {
  // The gates require a committed tree; package a committed copy of the real plugin source so the test
  // does not depend on the developer's working tree being clean.
  copy = createCommittedPluginCopy(massPluginRoot, "chemdraft-m35-load-");
  packaged = await packagePlugin({
    pluginRoot: copy.pluginRoot,
    outDir: join(copy.caseRoot, "out"),
    repoRoot
  });
  bootstrapPath = join(copy.caseRoot, "nodeWorkerBootstrap.mjs");
  writeFileSync(bootstrapPath, NODE_WORKER_BOOTSTRAP);
}, 180_000);

afterAll(async () => {
  await Promise.all(liveWorkers.map((worker) => worker.terminate()));
  if (copy) removeCommittedPluginCopy(copy);
});

function packageLocation(): { baseUrl: URL; manifest: unknown } {
  return {
    baseUrl: pathToFileURL(`${packaged.stagingDir}/`),
    manifest: JSON.parse(readFileSync(join(packaged.stagingDir, "manifest.json"), "utf8"))
  };
}

describe("built plugin package — M35 load path", () => {
  it("packages the real plugin into manifest.json + a built ES-module entry + LICENSE, with a matching checksum", () => {
    const paths = packaged.files.map((file) => file.path);
    expect(paths).toContain("manifest.json");
    expect(paths).toContain("entry.js");
    expect(paths).toContain("LICENSE");
    expect(packaged.entryFile).toBe("entry.js");

    // The entry is a real ES module (import/export syntax survives) and self-contained: no bare
    // specifier survives the bundle, so the package needs nothing from this monorepo to load.
    const entry = readFileSync(join(packaged.stagingDir, "entry.js"), "utf8");
    expect(entry).toMatch(/\bimport\s*\(|\bimport\s*[{*"']|\bexport\b/);
    expect(entry).not.toMatch(/from\s*["']@chemdraft\//);
    expect(entry).not.toMatch(/from\s*["'](?!\.)[a-z@]/i);

    // The checksum sidecar describes the zip that was actually written.
    const sidecar = readFileSync(packaged.checksumPath, "utf8");
    expect(sidecar).toBe(`${packaged.sha256}  ${"mass-fragment-demo"}-0.0.0.zip\n`);
  });

  it("manifest.json alone identifies, permissions, and locates the plugin — no monorepo paths", () => {
    const document = JSON.parse(readFileSync(join(packaged.stagingDir, "manifest.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(document).toMatchObject({
      id: massFragmentManifest.id,
      name: massFragmentManifest.name,
      version: massFragmentManifest.version,
      apiVersion: massFragmentManifest.apiVersion,
      permissions: massFragmentManifest.permissions,
      entry: "entry.js"
    });
    expect(document.contributes).toEqual(massFragmentManifest.contributes);
    expect(document.chemdraftPackage).toMatchObject({
      sdk: "@chemdraft/plugin-api",
      sdkVersion: PluginApiVersion,
      sourceCommit: copy.sourceCommit,
      sourceTree: "clean",
      licenseFile: "LICENSE"
    });
    expect(JSON.stringify(document)).not.toContain(repoRoot);
  });

  it("loaded from its built package, the plugin writes the same analysis record and renders the same report as the statically-bundled path", async () => {
    const inProcess = makeHost();
    inProcess.host.registerPlugin(massFragmentManifest, {
      commandHandlers: createMassRegistration().commandHandlers
    });
    const inProcessResult = await inProcess.host.invokeCommand(massAnalyzeCommandId);

    const viaPackage = makeHost();
    const descriptor = loadPackagedPlugin(packageLocation(), { createWorker: nodeWorkerFactory });
    viaPackage.host.registerPlugin(descriptor.manifest, descriptor.options);
    const packagedResult = await viaPackage.host.invokeCommand(massAnalyzeCommandId);

    expect(packagedResult).toEqual(inProcessResult);
    expect(viaPackage.host.listAnalysis()).toEqual(inProcess.host.listAnalysis());
    expect(viaPackage.host.listAnalysis()).toHaveLength(1);
    expect(viaPackage.reports).toEqual(inProcess.reports);
    expect(viaPackage.reports.length).toBeGreaterThan(0);

    descriptor.bridge.terminate();
  }, 60_000);

  it("registers the packaged manifest through the host, so its declared permissions gate it exactly as a bundled plugin's would", () => {
    const descriptor = loadPackagedPlugin(packageLocation(), { createWorker: nodeWorkerFactory });
    expect(descriptor.manifest).toEqual({ ...massFragmentManifest, entry: "entry.js" });
    expect(descriptor.provenance.sourceCommit).toBe(copy.sourceCommit);
    // The delegating handlers are built for exactly the contributed commands — same as the bundled path.
    expect(Object.keys(descriptor.options.commandHandlers ?? {})).toEqual([massAnalyzeCommandId]);
    descriptor.bridge.terminate();
  });

  it("resolves the entry against the package directory, so co-located chunks and assets resolve", () => {
    const location = packageLocation();
    expect(packagedPluginEntryUrl(location, { manifest: { entry: "entry.js" }, provenance: {} } as never).href).toBe(
      new URL("entry.js", location.baseUrl).href
    );
    // A base without a trailing slash must not swallow the last path segment.
    const noSlash = { baseUrl: "file:///tmp/pkg", manifest: location.manifest };
    expect(packagedPluginEntryUrl(noSlash, { manifest: { entry: "entry.js" }, provenance: {} } as never).href).toBe(
      "file:///tmp/pkg/entry.js"
    );
  });

  it("refuses a blob: base loudly — a multi-file package has no siblings there (the M35 constraint, surfaced not hidden)", () => {
    const location = { baseUrl: "blob:http://localhost/9c1f-uuid", manifest: packageLocation().manifest };
    expect(() => loadPackagedPlugin(location, { createWorker: nodeWorkerFactory })).toThrow(PackagedPluginLoadError);
    expect(() => loadPackagedPlugin(location, { createWorker: nodeWorkerFactory })).toThrow(/no sibling files/);
  });

  it("rejects a manifest.json that is not a valid packaged manifest", () => {
    expect(() => loadPackagedPlugin({ baseUrl: "file:///tmp/pkg/", manifest: { id: "x" } })).toThrow(
      /chemdraftPackage/
    );
    const withoutProvenance = { ...massFragmentManifest };
    expect(() => loadPackagedPlugin({ baseUrl: "file:///tmp/pkg/", manifest: withoutProvenance })).toThrow(
      /chemdraftPackage/
    );
  });
});
