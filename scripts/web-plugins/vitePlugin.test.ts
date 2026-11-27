import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { assertNoWebPluginsDir } from "../desktop-tauri.mjs";
import { resolveWebPluginRequest, resolveWebPluginsDir, webPluginsVitePlugins } from "./vitePlugin";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stagedDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "web-plugins-vite-"));
  dirs.push(dir);
  writeFileSync(join(dir, "index.json"), JSON.stringify({ version: 1, plugins: [] }));
  mkdirSync(join(dir, "org.example.p", "assets"), { recursive: true });
  writeFileSync(join(dir, "org.example.p", "manifest.json"), "{}");
  writeFileSync(join(dir, "org.example.p", "assets", "w.js"), "export {};");
  mkdirSync(join(dir, ".staging-org.example.p-1-abcd"), { recursive: true });
  writeFileSync(join(dir, ".staging-org.example.p-1-abcd", "manifest.json"), "{}");
  return dir;
}

describe("webPluginsVitePlugins", () => {
  it("adds no middleware and no copy when CHEMDRAFT_WEB_PLUGINS_DIR is unset or empty", () => {
    expect(webPluginsVitePlugins({})).toEqual([]);
    expect(webPluginsVitePlugins({ CHEMDRAFT_WEB_PLUGINS_DIR: "" })).toEqual([]);
    expect(webPluginsVitePlugins({ CHEMDRAFT_WEB_PLUGINS_DIR: "  " })).toEqual([]);
  });

  it("fails loudly when the variable is set inside a Tauri build", () => {
    const dir = stagedDir();
    expect(() => webPluginsVitePlugins({ CHEMDRAFT_WEB_PLUGINS_DIR: dir, TAURI_ENV_PLATFORM: "darwin" }))
      .toThrow(/set inside a Tauri build/);
  });

  it("fails loudly when the variable names a directory with no staged index", () => {
    const empty = mkdtempSync(join(tmpdir(), "web-plugins-empty-"));
    dirs.push(empty);
    expect(() => resolveWebPluginsDir({ CHEMDRAFT_WEB_PLUGINS_DIR: empty })).toThrow(/has no index\.json/);
  });

  it("serves in dev and copies on build, without hidden staging directories", () => {
    const dir = stagedDir();
    const plugins = webPluginsVitePlugins({ CHEMDRAFT_WEB_PLUGINS_DIR: dir });
    expect(plugins.map((plugin) => [plugin.name, plugin.apply])).toEqual([
      ["chemdraft-serve-web-plugins", "serve"],
      ["chemdraft-copy-web-plugins", "build"]
    ]);

    const outDir = mkdtempSync(join(tmpdir(), "web-plugins-dist-"));
    dirs.push(outDir);
    const writeBundle = plugins[1].writeBundle as (options: { dir?: string }) => void;
    writeBundle.call({}, { dir: outDir });
    expect(readFileSync(join(outDir, "web-plugins", "index.json"), "utf8")).toContain('"version":1');
    expect(existsSync(join(outDir, "web-plugins", "org.example.p", "assets", "w.js"))).toBe(true);
    expect(existsSync(join(outDir, "web-plugins", ".staging-org.example.p-1-abcd"))).toBe(false);

    const use = vi.fn();
    (plugins[0].configureServer as (server: unknown) => void)({ middlewares: { use } });
    const middleware = use.mock.calls[0][0] as (req: { url: string }, res: Record<string, unknown>, next: () => void) => void;
    const response = { statusCode: 200, headers: {} as Record<string, string>, body: undefined as unknown,
      setHeader(name: string, value: string) { this.headers[name] = value; }, end(body: unknown) { this.body = body; } };
    middleware({ url: "/web-plugins/org.example.p/assets/w.js" }, response, () => { throw new Error("not passed on"); });
    expect(response.statusCode).toBe(200);
    expect(response.headers["Content-Type"]).toBe("text/javascript");
    expect(response.headers["Content-Security-Policy"]).toContain("default-src 'none'");
    const next = vi.fn();
    middleware({ url: "/src/main.tsx" }, response, next);
    expect(next).toHaveBeenCalled();
  });
});

describe("resolveWebPluginRequest", () => {
  it("serves the index and plugin files, and refuses traversal and hidden directories", () => {
    const dir = stagedDir();
    expect(resolveWebPluginRequest(dir, "/web-plugins/index.json")).toEqual({ file: join(dir, "index.json") });
    expect(resolveWebPluginRequest(dir, "/web-plugins/org.example.p/manifest.json?v=1")).toEqual({
      file: join(dir, "org.example.p", "manifest.json")
    });
    expect(resolveWebPluginRequest(dir, "/web-plugins/org.example.p/../../secret")).toEqual({ status: 403 });
    expect(resolveWebPluginRequest(dir, "/web-plugins/org.example.p/%2e%2e/%2e%2e/secret")).toEqual({ status: 403 });
    expect(resolveWebPluginRequest(dir, "/web-plugins/.staging-org.example.p-1-abcd/manifest.json")).toEqual({ status: 403 });
    expect(resolveWebPluginRequest(dir, "/web-plugins/org.example.p/missing.js")).toEqual({ status: 404 });
    expect(resolveWebPluginRequest(dir, "/web-plugins/org.example.p/assets")).toEqual({ status: 404 });
  });
});

describe("desktop-tauri guard", () => {
  it("refuses any Tauri run with CHEMDRAFT_WEB_PLUGINS_DIR set", () => {
    expect(() => assertNoWebPluginsDir({ CHEMDRAFT_WEB_PLUGINS_DIR: "/tmp/x" })).toThrow(/browser build only/);
    expect(() => assertNoWebPluginsDir({})).not.toThrow();
    expect(() => assertNoWebPluginsDir({ CHEMDRAFT_WEB_PLUGINS_DIR: "" })).not.toThrow();
  });
});
