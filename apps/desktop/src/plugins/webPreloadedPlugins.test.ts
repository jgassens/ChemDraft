/**
 * Preloaded web plugins: discovery, refusal of bad packages, and that a Tauri host ignores the feature.
 * Drives the real loader, the real `loadPackagedPlugin`, the real worker-bridge handshake and a real
 * desktop runtime; only `fetch` (the static server) and the worker (Node has no DOM Worker) are fakes.
 */
import {
  PLUGIN_WORKER_PROTOCOL_VERSION,
  type PluginManifest,
  type PluginWorkerHandle
} from "@chemdraft/plugin-api";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { createPluginRuntime, type DesktopPluginRuntime } from "./createPluginRuntime";
import { INSTALLED_PLUGIN_WORKER_CSP } from "./installedPluginAssetPath";
import { loadWebPreloadedPlugins, parseWebPluginsIndex, WebPluginsIndexError } from "./webPreloadedPlugins";

const BASE = "http://127.0.0.1:5173/web-plugins/";

function manifestDocument(id: string, overrides: Partial<PluginManifest> = {}): Record<string, unknown> {
  const suffix = id.split(".").pop();
  return {
    id,
    name: `Preloaded ${suffix}`,
    version: "1.0.0",
    apiVersion: "^0.1.0",
    description: "A preloaded web plugin fixture.",
    entry: "entry.js",
    permissions: ["ui.menu"],
    contributes: {
      commands: [{ id: `plugin.${suffix}.run`, title: "Run", requiredPermissions: [], enabled: true }],
      menus: [],
      panels: [],
      toolbarButtons: [],
      toolsets: [],
      inspectors: [],
      templates: [],
      importers: [],
      exporters: [],
      analyzers: [],
      transformers: [],
      recognizers: []
    },
    ...overrides,
    chemdraftPackage: {
      sdk: "@chemdraft/plugin-api",
      sdkVersion: "0.1.28",
      sourceCommit: "0fd3eceec674f207fe2651fe7a19f6438a55fb17",
      sourceTree: "clean",
      licenseFile: "LICENSE",
      packagedAt: "2026-11-27T00:00:00.000Z"
    }
  };
}

/**
 * A static server: path -> JSON body (or a status). Records every request. A plugin's `entry.js` is
 * served even when unlisted, and every response carries `csp(path)` as its Content-Security-Policy
 * (the worker policy by default, as the dev server sends it; `null` for none).
 */
function fakeServer(
  files: Record<string, unknown | { status: number }>,
  contentType = "application/json",
  csp: (path: string) => string | null = () => INSTALLED_PLUGIN_WORKER_CSP
) {
  const requests: string[] = [];
  const fetch = vi.fn(async (input: string) => {
    const path = new URL(input).pathname;
    requests.push(path);
    const body = files[path] ?? (path.endsWith("/entry.js") ? "export {};" : undefined);
    const status = body === undefined ? 404 : typeof body === "object" && body !== null && "status" in body ? (body as { status: number }).status : 200;
    const headers = new Headers({ "content-type": path.endsWith(".js") ? "text/javascript" : contentType });
    const policy = csp(path);
    if (policy !== null) headers.set("content-security-policy", policy);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers,
      json: async () => body,
      text: async () => JSON.stringify(body)
    } as unknown as Response;
  });
  return { fetch, requests };
}

function fakeWorker(options: { apiVersion?: string; silent?: boolean } = {}): PluginWorkerHandle {
  const listeners = new Set<(event: { data: unknown }) => void>();
  return {
    postMessage: () => undefined,
    terminate: () => listeners.clear(),
    addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
      if (type !== "message") return;
      listeners.add(listener);
      if (!options.silent) {
        queueMicrotask(() =>
          listener({ data: { kind: "ready", protocolVersion: PLUGIN_WORKER_PROTOCOL_VERSION, apiVersion: options.apiVersion ?? "^0.1.0" } })
        );
      }
    },
    removeEventListener: (_type: string, listener: (event: { data: unknown }) => void) => listeners.delete(listener)
  } as unknown as PluginWorkerHandle;
}

function createRuntime(): DesktopPluginRuntime {
  return createPluginRuntime({ getActiveDocument: () => undefined, getSelection: () => ({ objectIds: [], molecules: [] }) });
}

const record = (id: string, version = "1.0.0") => ({ id, version, dir: id, sha256: "a".repeat(64) });

describe("loadWebPreloadedPlugins", () => {
  it("does nothing, without fetching, on a Tauri host", async () => {
    const server = fakeServer({ "/web-plugins/index.json": { version: 1, plugins: [record("org.example.good")] } });
    const result = await loadWebPreloadedPlugins({ runtime: createRuntime(), tauriHost: true, baseUrl: BASE, fetch: server.fetch });
    expect(result).toEqual({ loaded: [], failures: [] });
    expect(server.fetch).not.toHaveBeenCalled();
  });

  it("treats an absent index (404) as no preloaded plugins, silently", async () => {
    const server = fakeServer({});
    const result = await loadWebPreloadedPlugins({ runtime: createRuntime(), tauriHost: false, baseUrl: BASE, fetch: server.fetch });
    expect(result).toEqual({ loaded: [], failures: [] });
    expect(server.requests).toEqual(["/web-plugins/index.json"]);
  });

  it("treats an HTML fallback page as no index, and a network error as none", async () => {
    const html = fakeServer({ "/web-plugins/index.json": "<!doctype html>" }, "text/html");
    expect(await loadWebPreloadedPlugins({ runtime: createRuntime(), tauriHost: false, baseUrl: BASE, fetch: html.fetch }))
      .toEqual({ loaded: [], failures: [] });
    const offline = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    expect(await loadWebPreloadedPlugins({ runtime: createRuntime(), tauriHost: false, baseUrl: BASE, fetch: offline }))
      .toEqual({ loaded: [], failures: [] });
  });

  it("registers a good plugin and reports a bad one without blocking it", async () => {
    const runtime = createRuntime();
    const server = fakeServer({
      "/web-plugins/index.json": { version: 1, plugins: [record("org.example.broken"), record("org.example.good")] },
      "/web-plugins/org.example.broken/manifest.json": { id: "org.example.broken", entry: 3 },
      "/web-plugins/org.example.good/manifest.json": manifestDocument("org.example.good")
    });
    const entryUrls: string[] = [];
    const result = await loadWebPreloadedPlugins({
      runtime,
      tauriHost: false,
      baseUrl: BASE,
      fetch: server.fetch,
      createWorker: (entryUrl) => {
        entryUrls.push(entryUrl.href);
        return fakeWorker();
      }
    });

    expect(result.loaded.map((entry) => entry.record.id)).toEqual(["org.example.good"]);
    expect(runtime.host.getPlugin("org.example.good")).toBeDefined();
    // Loaded from its real same-origin directory, so the package's relative references resolve.
    expect(entryUrls).toEqual(["http://127.0.0.1:5173/web-plugins/org.example.good/entry.js"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].id).toBe("org.example.broken");
    expect(result.failures[0].message).toMatch(/Preloaded plugin "org\.example\.broken" could not be loaded: its manifest\.json is not valid/);
    expect(runtime.host.getPlugin("org.example.broken")).toBeUndefined();
  });

  it("applies the install gates: apiVersion, unavailable permissions, id mismatch, handshake", async () => {
    const runtime = createRuntime();
    const server = fakeServer({
      "/web-plugins/index.json": {
        version: 1,
        plugins: [record("org.example.future"), record("org.example.net"), record("org.example.liar"), record("org.example.silent")]
      },
      "/web-plugins/org.example.future/manifest.json": manifestDocument("org.example.future", { apiVersion: "^9.0.0" }),
      "/web-plugins/org.example.net/manifest.json": manifestDocument("org.example.net", { permissions: ["network.fetch"] }),
      "/web-plugins/org.example.liar/manifest.json": manifestDocument("org.example.other"),
      "/web-plugins/org.example.silent/manifest.json": manifestDocument("org.example.silent")
    });
    const result = await loadWebPreloadedPlugins({
      runtime,
      tauriHost: false,
      baseUrl: BASE,
      fetch: server.fetch,
      createWorker: (entryUrl) => fakeWorker({ apiVersion: entryUrl.href.includes("silent") ? "^9.0.0" : "^0.1.0" })
    });
    expect(result.loaded).toEqual([]);
    const byId = Object.fromEntries(result.failures.map((failure) => [failure.id, failure.message]));
    expect(byId["org.example.future"]).toMatch(/requires ChemDraft plugin API "\^9\.0\.0"/);
    expect(byId["org.example.net"]).toMatch(/network\.fetch.*reserved and unavailable/);
    expect(byId["org.example.liar"]).toMatch(/declares "org\.example\.other"/);
    // The worker's own handshake is the authority even when the manifest looked compatible.
    expect(byId["org.example.silent"]).toBeDefined();
    for (const id of Object.keys(byId)) expect(runtime.host.getPlugin(id)).toBeUndefined();
  });

  it("lists a disabled plugin without registering or starting it", async () => {
    const runtime = createRuntime();
    const server = fakeServer({
      "/web-plugins/index.json": { version: 1, plugins: [record("org.example.good")] },
      "/web-plugins/org.example.good/manifest.json": manifestDocument("org.example.good")
    });
    const createWorker = vi.fn(() => fakeWorker());
    const result = await loadWebPreloadedPlugins({
      runtime, tauriHost: false, baseUrl: BASE, fetch: server.fetch, createWorker, disabledIds: new Set(["org.example.good"])
    });
    expect(result.loaded.map((entry) => entry.record.id)).toEqual(["org.example.good"]);
    expect(runtime.host.getPlugin("org.example.good")).toBeUndefined();
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("refuses, before creating its worker, a plugin whose entry script has no worker CSP (a bare static host)", async () => {
    const runtime = createRuntime();
    const server = fakeServer(
      {
        "/web-plugins/index.json": { version: 1, plugins: [record("org.example.bare"), record("org.example.good")] },
        "/web-plugins/org.example.bare/manifest.json": manifestDocument("org.example.bare"),
        "/web-plugins/org.example.good/manifest.json": manifestDocument("org.example.good")
      },
      "application/json",
      (path) => (path.startsWith("/web-plugins/org.example.bare/") ? null : INSTALLED_PLUGIN_WORKER_CSP)
    );
    const createWorker = vi.fn(() => fakeWorker());
    const result = await loadWebPreloadedPlugins({ runtime, tauriHost: false, baseUrl: BASE, fetch: server.fetch, createWorker });

    expect(server.requests).toContain("/web-plugins/org.example.bare/entry.js");
    expect(result.loaded.map((entry) => entry.record.id)).toEqual(["org.example.good"]);
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(runtime.host.getPlugin("org.example.bare")).toBeUndefined();
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].message).toBe(
      'Preloaded plugin "org.example.bare" could not be loaded: its entry script /web-plugins/org.example.bare/entry.js ' +
        "has no Content-Security-Policy header, so its worker would not be confined to its network permissions. " +
        `Configure the host to send "Content-Security-Policy: ${INSTALLED_PLUGIN_WORKER_CSP}" on /web-plugins/* ` +
        '(see "Running a plugin in the web build" in AUTHORING.md; vite build writes a _headers file for Netlify and Cloudflare Pages).'
    );
  });

  it("refuses a plugin whose entry CSP is weaker than the worker policy, a disabled one included", async () => {
    const runtime = createRuntime();
    const server = fakeServer(
      {
        "/web-plugins/index.json": { version: 1, plugins: [record("org.example.open"), record("org.example.off")] },
        "/web-plugins/org.example.open/manifest.json": manifestDocument("org.example.open"),
        "/web-plugins/org.example.off/manifest.json": manifestDocument("org.example.off")
      },
      "application/json",
      () => "default-src 'none'; script-src 'self'; connect-src *"
    );
    const createWorker = vi.fn(() => fakeWorker());
    const result = await loadWebPreloadedPlugins({
      runtime, tauriHost: false, baseUrl: BASE, fetch: server.fetch, createWorker, disabledIds: new Set(["org.example.off"])
    });
    expect(result.loaded).toEqual([]);
    expect(createWorker).not.toHaveBeenCalled();
    const byId = Object.fromEntries(result.failures.map((failure) => [failure.id, failure.message]));
    expect(byId["org.example.open"]).toMatch(/has a Content-Security-Policy weaker than the plugin worker policy \(connect-src allows \*\)/);
    expect(byId["org.example.off"]).toMatch(/connect-src allows \*/);
  });

  it("reports an unreadable index instead of guessing", async () => {
    const server = fakeServer({ "/web-plugins/index.json": { version: 2, plugins: [] } });
    const result = await loadWebPreloadedPlugins({ runtime: createRuntime(), tauriHost: false, baseUrl: BASE, fetch: server.fetch });
    expect(result.loaded).toEqual([]);
    expect(result.failures[0].message).toMatch(/index\.json has version 2/);
  });
});

describe("parseWebPluginsIndex", () => {
  it("refuses a directory that is not one safe path segment", () => {
    for (const dir of ["../escape", "a/b", ".hidden", "index.json", ""]) {
      expect(() => parseWebPluginsIndex({ version: 1, plugins: [{ id: "x", version: "1", dir, sha256: "a" }] }))
        .toThrow(WebPluginsIndexError);
    }
  });
});
