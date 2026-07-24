/**
 * Parity tests for the staged-plugin serving contract.
 *
 * The same contract is implemented twice — `installed_plugins.rs` in the shipped app, and the Vite
 * dev middleware in `vite.config.ts` — and only the Rust side had tests. A traversal that the dev
 * server accepted but the packaged app refused (or a CSP that drifted between them) would mean the
 * boundary is only real in one of the two builds developers actually run.
 *
 * The hostile inputs below mirror the cases in `installed_plugins.rs`'s own test module.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  INSTALLED_PLUGIN_URL_PREFIX,
  INSTALLED_PLUGIN_WORKER_CSP,
  installedPluginContentType,
  resolveInstalledPluginAssetSegments
} from "./installedPluginAssetPath";

const rustSource = readFileSync(
  fileURLToPath(new URL("../../src-tauri/src/installed_plugins.rs", import.meta.url)),
  "utf8"
);

describe("staged plugin asset paths", () => {
  it("accepts an ordinary <plugin-id>/<file> request", () => {
    expect(resolveInstalledPluginAssetSegments(`${INSTALLED_PLUGIN_URL_PREFIX}org.demo/entry.js`)).toEqual([
      "org.demo",
      "entry.js"
    ]);
    expect(resolveInstalledPluginAssetSegments(`${INSTALLED_PLUGIN_URL_PREFIX}org.demo/assets/worker.js?v=2`)).toEqual([
      "org.demo",
      "assets",
      "worker.js"
    ]);
  });

  it("refuses every traversal shape the Rust handler refuses", () => {
    for (const hostile of [
      "../../../../etc/passwd",
      "plugin/../../etc/passwd",
      "plugin/../../../Library/Preferences/com.apple.finder.plist",
      "/etc/passwd",
      "plugin/./entry.js",
      "plugin//entry.js",
      "..\\..\\Windows\\System32\\evil.dll"
    ]) {
      expect(
        resolveInstalledPluginAssetSegments(`${INSTALLED_PLUGIN_URL_PREFIX}${hostile}`),
        hostile
      ).toBeUndefined();
    }
  });

  // The decisive ordering bug: decoding *after* the traversal check would let `%2e%2e%2f` through as
  // an opaque segment and only become `../` when it reached the filesystem.
  it("percent-decodes before refusing, so an encoded traversal cannot smuggle through", () => {
    for (const hostile of ["plugin/%2e%2e%2fetc/passwd", "%2e%2e%2f%2e%2e%2fetc/passwd", "%2fetc%2fpasswd"]) {
      expect(
        resolveInstalledPluginAssetSegments(`${INSTALLED_PLUGIN_URL_PREFIX}${hostile}`),
        hostile
      ).toBeUndefined();
    }
  });

  it("refuses a NUL byte, a malformed escape, and a bare plugin id with no file", () => {
    expect(resolveInstalledPluginAssetSegments(`${INSTALLED_PLUGIN_URL_PREFIX}plugin/entry%00.js`)).toBeUndefined();
    expect(resolveInstalledPluginAssetSegments(`${INSTALLED_PLUGIN_URL_PREFIX}plugin/%zz`)).toBeUndefined();
    expect(resolveInstalledPluginAssetSegments(`${INSTALLED_PLUGIN_URL_PREFIX}org.demo`)).toBeUndefined();
    expect(resolveInstalledPluginAssetSegments(`${INSTALLED_PLUGIN_URL_PREFIX}`)).toBeUndefined();
  });

  it("ignores URLs outside the staged-plugin prefix", () => {
    expect(resolveInstalledPluginAssetSegments("/src/main.tsx")).toBeUndefined();
    expect(resolveInstalledPluginAssetSegments("/installed-plugins")).toBeUndefined();
  });

  it("serves known types and falls back to a non-executable octet-stream", () => {
    expect(installedPluginContentType("/root/org.demo/entry.js")).toBe("text/javascript");
    expect(installedPluginContentType("/root/org.demo/model.wasm")).toBe("application/wasm");
    expect(installedPluginContentType("/root/org.demo/manifest.json")).toBe("application/json");
    expect(installedPluginContentType("/root/org.demo/README")).toBe("application/octet-stream");
    expect(installedPluginContentType("/root/org.demo/page.html")).toBe("application/octet-stream");
  });

  // A worker's CSP comes from its own response, so a drift here silently re-grants installed plugins
  // the ambient network access the manifest boundary is supposed to deny.
  it("keeps the worker CSP byte-identical to the Rust constant", () => {
    const rustCsp = /INSTALLED_PLUGIN_WORKER_CSP: &str = "([^"]+)"/.exec(rustSource)?.[1];
    expect(rustCsp, "could not find the Rust CSP constant to compare against").toBeDefined();
    expect(INSTALLED_PLUGIN_WORKER_CSP).toBe(rustCsp);
  });

  it("keeps the URL prefix aligned with the Rust handler", () => {
    expect(rustSource).toContain(INSTALLED_PLUGIN_URL_PREFIX.replace(/^\/|\/$/g, ""));
  });
});
