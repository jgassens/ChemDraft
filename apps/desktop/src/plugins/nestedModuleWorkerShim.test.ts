import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginWorkerBootstrapUrl } from "./pluginWorkerBootstrap";
import { defaultPluginWorkerFactories } from "./registerBundledPlugins";
import { installNestedModuleWorkerShim } from "./workers/nestedModuleWorkerShim.js";

const entry = "http://tauri.localhost/installed-plugins/org.test/entry.js";

function harness(href = entry) {
  const blobs: Blob[] = [];
  const revokeObjectURL = vi.fn();
  class NativeWorker extends EventTarget {
    onmessage = null;
    onerror = null;
    postMessage() {}
    terminate() {}
    constructor(readonly url: string | URL, readonly options?: WorkerOptions) {
      super();
      if (options?.name === "throw") throw new Error("constructor refused");
    }
  }
  const scope = {
    location: { href } as Location,
    Worker: NativeWorker as unknown as typeof Worker,
    Blob,
    URL: Object.assign(class extends URL {}, {
      createObjectURL: vi.fn((blob: Blob) => {
        blobs.push(blob);
        return "blob:http://tauri.localhost/wrapper";
      }),
      revokeObjectURL
    })
  };
  return { scope, NativeWorker, blobs, revokeObjectURL };
}

afterEach(() => vi.unstubAllGlobals());

describe("Windows nested module workers", () => {
  it.each(["macos", "linux", "web"] as const)("leaves %s constructors unchanged", (platform) => {
    const { scope, NativeWorker } = harness();
    installNestedModuleWorkerShim(platform, scope);
    expect(scope.Worker).toBe(NativeWorker);
  });

  it.each(["tauri://localhost/entry.js", "http://localhost:5173/entry.js", "https://example.org/entry.js"])(
    "leaves the web build and other origins unchanged: %s", (href) => {
      const { scope, NativeWorker } = harness(href);
      installNestedModuleWorkerShim("windows", scope);
      expect(scope.Worker).toBe(NativeWorker);
    }
  );

  it("defaults to platform detection inside a worker", () => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    const { scope, NativeWorker } = harness();
    installNestedModuleWorkerShim(undefined, scope);
    expect(scope.Worker).not.toBe(NativeWorker);
  });

  it.each([
    ["./classic.js", undefined],
    ["./classic.js", { type: "classic" }],
    ["https://external.example/worker.js", { type: "module" }],
    ["http://tauri.localhost:123/worker.js", { type: "module" }],
    ["data:text/javascript,postMessage(1)", { type: "module" }],
    ["blob:http://tauri.localhost/other", { type: "module" }],
    ["http://user:secret@tauri.localhost/worker.js", { type: "module" }],
    ["http://[invalid", { type: "module" }]
  ] as const)("passes unsupported URL/options directly to native: %s %j", (url, options) => {
    const { scope, blobs } = harness();
    installNestedModuleWorkerShim("windows", scope);
    const worker = new scope.Worker(url, options) as unknown as { url: string; options: WorkerOptions };
    expect(worker.url).toBe(url);
    expect(worker.options).toBe(options);
    expect(blobs).toHaveLength(0);
  });

  it.each(["assets/nmrWorker.js", new URL("assets/nmrWorker.js", entry)])(
    "imports the absolute module URL and preserves native identity, events, methods and options: %s", async (url) => {
      const { scope, NativeWorker, blobs, revokeObjectURL } = harness();
      installNestedModuleWorkerShim("windows", scope);
      const options: WorkerOptions = { type: "module", name: "nmr", credentials: "include" };
      const worker = new scope.Worker(url, options) as unknown as InstanceType<typeof NativeWorker>;
      expect(worker).toBeInstanceOf(NativeWorker);
      expect(worker).toBeInstanceOf(scope.Worker);
      expect(worker.options).toBe(options);
      expect(worker.postMessage).toBe(NativeWorker.prototype.postMessage);
      expect(worker.terminate).toBe(NativeWorker.prototype.terminate);
      const onmessage = vi.fn();
      worker.addEventListener("message", onmessage);
      worker.dispatchEvent(new MessageEvent("message", { data: "prediction" }));
      expect(onmessage).toHaveBeenCalledOnce();
      expect(worker.url).toBe("blob:http://tauri.localhost/wrapper");
      expect(blobs[0]?.type).toBe("text/javascript");
      expect(await blobs[0]!.text()).toBe(
        'import "http://tauri.localhost/installed-plugins/org.test/assets/nmrWorker.js"; URL.revokeObjectURL(import.meta.url);'
      );
      expect(revokeObjectURL).not.toHaveBeenCalled();
      worker.dispatchEvent(new Event("error"));
      expect(revokeObjectURL).toHaveBeenCalledWith(worker.url);
    }
  );

  it("escapes module specifiers as data and releases blobs on synchronous failure", async () => {
    const { scope, blobs, revokeObjectURL } = harness();
    installNestedModuleWorkerShim("windows", scope);
    expect(() => new scope.Worker("./worker.js", { type: "module", name: "throw" })).toThrow("constructor refused");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:http://tauri.localhost/wrapper");
    new scope.Worker('./worker.js?x=";evil()', { type: "module" });
    expect(await blobs[1]!.text()).toContain(JSON.stringify(new URL('./worker.js?x=";evil()', entry).href));
  });
});

describe("plugin worker bootstrap", () => {
  it.each([
    ["windows", "http://tauri.localhost", "windowsMassFragmentPluginWorker.ts"],
    ["macos", "tauri://localhost", "/massFragmentPluginWorker.ts"],
    ["macos", "http://tauri.localhost", "/massFragmentPluginWorker.ts"],
    ["windows", "http://localhost:5173", "/massFragmentPluginWorker.ts"]
  ] as const)("selects the bundled entry for %s on %s", (platform, origin, suffix) => {
    const { scope } = harness();
    vi.stubGlobal("Worker", scope.Worker);
    vi.stubGlobal("location", { origin });
    const factory = defaultPluginWorkerFactories(platform).values().next().value!;
    const worker = factory() as unknown as { url: URL; options: WorkerOptions };
    expect(worker.url.pathname.endsWith(suffix)).toBe(true);
    expect(worker.options).toEqual({ type: "module" });
  });

  it("selects only Windows custom-origin entries and preserves original query parameters", () => {
    const url = new URL(`${entry}?version=2`);
    expect(pluginWorkerBootstrapUrl(url, "windows").href).toBe(`${url.href}&__chemdraft_worker_bootstrap=windows`);
    expect(url.search).toBe("?version=2");
    expect(pluginWorkerBootstrapUrl(url, "macos")).toBe(url);
    for (const href of ["tauri://localhost/plugin.js", "http://localhost:5173/plugin.js"]) {
      const other = new URL(href);
      expect(pluginWorkerBootstrapUrl(other, "windows")).toBe(other);
    }
  });

  it("installs before importing plugin code in both native and bundled bootstraps", () => {
    const rust = readFileSync(new URL("../../src-tauri/src/installed_plugins.rs", import.meta.url), "utf8");
    const bootstrap = rust.slice(rust.indexOf("fn installed_plugin_bootstrap()"));
    expect(bootstrap).toContain("installNestedModuleWorkerShim('windows')");
    expect(bootstrap).toContain("await import(entry.href)");
    expect(bootstrap.indexOf("installNestedModuleWorkerShim('windows')")).toBeLessThan(bootstrap.indexOf("await import(entry.href)"));
    expect(bootstrap).toContain('include_str!("../../src/plugins/workers/nestedModuleWorkerShim.js")');
    expect(bootstrap).toContain("entry.searchParams.delete('__chemdraft_worker_bootstrap')");
    const bundled = readFileSync(new URL("./workers/windowsMassFragmentPluginWorker.ts", import.meta.url), "utf8");
    expect(bundled).toContain('installNestedModuleWorkerShim("windows");');
    expect(bundled).toContain('await import("./massFragmentPluginWorker")');
    expect(bundled.indexOf('installNestedModuleWorkerShim("windows");')).toBeLessThan(bundled.indexOf('await import("./massFragmentPluginWorker")'));
  });

  it("wraps a worker created during bundled plugin module evaluation", async () => {
    const { scope, NativeWorker, blobs } = harness();
    vi.stubGlobal("navigator", { platform: "Win32" });
    vi.stubGlobal("location", scope.location);
    vi.stubGlobal("Worker", scope.Worker);
    vi.stubGlobal("URL", scope.URL);
    const runPluginWorker = vi.fn();
    vi.doMock("@chemdraft/plugin-api", () => ({ runPluginWorker }));
    vi.doMock("@chemdraft/plugin-mass-fragment", () => {
      const nested = new Worker(new URL("./assets/nmrWorker.js", entry), { type: "module" });
      expect(nested).toBeInstanceOf(NativeWorker);
      expect(blobs).toHaveLength(1);
      return { massFragmentManifest: {}, createMassRegistration: () => ({ commandHandlers: {} }) };
    });
    try {
      await import("./workers/windowsMassFragmentPluginWorker");
      expect(runPluginWorker).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock("@chemdraft/plugin-api");
      vi.doUnmock("@chemdraft/plugin-mass-fragment");
    }
  });
});
