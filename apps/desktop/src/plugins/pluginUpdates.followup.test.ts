import { describe, expect, it, vi } from "vitest";
import { checkForPluginUpdates, parsePluginReleaseRequirements, incompatibleReleaseMessage, PluginReleaseMetadataUnavailableError, prepareOfficialPluginInstall } from "./pluginUpdates";
import type { InstalledPluginCatalogEntry } from "./installPluginPackage";
import { PluginManifestSchema } from "@chemdraft/plugin-api";
import { createZipFixture } from "../testSupport/zipFixture";
import { sha256Hex } from "./pluginPackageArchive";

const id = "org.chemdraft.nmr.predictor";
const repo = "jgassens/ChemDraft-NMR-Plugin";
const latestUrl = `https://api.github.com/repos/${repo}/releases/latest`;
const listUrl = `https://api.github.com/repos/${repo}/releases?per_page=20`;
const body = "ChemDraft-Plugin-API: ^0.1.0";
const incompatible = "ChemDraft-Plugin-API: ^0.1.99\nChemDraft-Min-App: 1.9.0";
const manifest = (version: string) => PluginManifestSchema.parse({
  id, name: "NMR Shift Predictor", version, apiVersion: "^0.1.0", entry: "entry.js", permissions: []
});
const entry = (version = "0.1.0"): InstalledPluginCatalogEntry => ({
  record: { id, version, name: "NMR Shift Predictor", sourceChecksum: "a".repeat(64),
    stagedPath: `installed-plugins/${id}`, installedAt: "2026-11-10T00:00:00Z" },
  manifest: manifest(version), descriptor: undefined
});
const packageUrl = (version: string) => `https://github.com/${repo}/releases/download/v${version}/nmr-predictor-${version}.zip`;
async function fixture() {
  const zip = await createZipFixture([
    { path: "manifest.json", content: JSON.stringify({ ...manifest("0.2.0"), chemdraftPackage: {
      sdk: "@chemdraft/plugin-api", sdkVersion: "0.1.0", sourceCommit: "a".repeat(40),
      sourceTree: "clean", licenseFile: "LICENSE", packagedAt: "2026-11-10T00:00:00Z"
    } }) },
    { path: "entry.js", content: "export const ready = true;" }, { path: "LICENSE", content: "MIT" }
  ]);
  const digest = await sha256Hex(zip);
  const release = (version: string, overrides: Record<string, unknown> = {}) => ({
    tag_name: `v${version}`, html_url: `https://github.com/${repo}/releases/tag/v${version}`,
    published_at: "2026-11-10T00:00:00Z", draft: false, prerelease: false, body,
    assets: [
      { name: `nmr-predictor-${version}.zip`, browser_download_url: packageUrl(version), size: zip.length, digest: `sha256:${digest}` },
      { name: `nmr-predictor-${version}.zip.sha256`, browser_download_url: `${packageUrl(version)}.sha256`, size: 90 }
    ], ...overrides
  });
  return { zip, digest, release };
}
const json = (value: unknown) => new Response(JSON.stringify(value));

describe("plugin updater review regressions", () => {
  it.each(["1.2.0-rc.1", "1.2.0+build.1", "1." + "2".repeat(63) + ".0"])(
    "ignores a non-release or oversized Min-App marker: %s", min => {
      expect(incompatibleReleaseMessage({ body: `ChemDraft-Plugin-API: ^0.1.99\nChemDraft-Min-App: ${min}` }))
        .toBe("Needs a newer ChemDraft");
    }
  );
  it("caps both marker values at 64 characters", () => {
    const api = "^0.1.99+" + "a".repeat(56);
    expect(api).toHaveLength(64);
    expect(parsePluginReleaseRequirements(`ChemDraft-Plugin-API: ${api}`).apiVersion).toBe(api);
    expect(parsePluginReleaseRequirements(`ChemDraft-Plugin-API: ${api}a`).apiVersion).toBeUndefined();
    const min = "1." + "2".repeat(60) + ".0";
    expect(min).toHaveLength(64);
    expect(parsePluginReleaseRequirements(`ChemDraft-Min-App: ${min}`).minAppVersion).toBe(min);
    expect(parsePluginReleaseRequirements(`ChemDraft-Min-App: ${min}0`).minAppVersion).toBeUndefined();
  });
  it.each([new TypeError("offline"), "url not allowed on the configured scope"])(
    "logs metadata fetch rejections, including allowlist denials", async cause => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await checkForPluginUpdates([entry()], { fetch: async () => { throw cause; } });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("api.github.com"));
        expect(warn.mock.calls.flat().join(" ")).toMatch(/TypeError|allowlist/);
      } finally { warn.mockRestore(); }
    }
  );
  it("ends a metadata timeout even when the transport does not settle after abort", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async () => new Promise<Response>(() => {}));
      const pending = checkForPluginUpdates([entry()], { fetch });
      await vi.advanceTimersByTimeAsync(20_000);
      expect((await pending)[0]?.status).toBe("unavailable");
      expect(fetch).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it("handles a future API minor bump without asking the user to upgrade", () => {
    expect(incompatibleReleaseMessage({ body: "ChemDraft-Plugin-API: ^0.1.25\nChemDraft-Min-App: 1.2.0" }, "0.2.0"))
      .toBe("Not yet available for this ChemDraft version");
  });
  it.each(["0.1.24", "^0.0.25", "~0.0.25"])("does not tell a newer host to upgrade for %s", async api => {
    const { release } = await fixture();
    const fetch = vi.fn(async (url: string) => json(url === latestUrl
      ? release("0.4.0", { body: `ChemDraft-Plugin-API: ${api}\nChemDraft-Min-App: 1.0.0` }) : []));
    expect((await checkForPluginUpdates([entry()], { fetch }))[0]).toMatchObject({
      status: "incompatible", message: "Not yet available for this ChemDraft version"
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([latestUrl, listUrl]);
  });

  it.each(["0.4.0", "0.5.0"])("keeps installed %s up to date before checking markers/assets", async version => {
    const { release } = await fixture();
    const fetch = vi.fn(async () => json(release("0.4.0", { body: incompatible, assets: [] })));
    expect((await checkForPluginUpdates([entry(version)], { fetch }))[0]).toMatchObject({ status: "upToDate" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([true, false])("selects a newer installed update with marked priority (%s)", async marked => {
    const { release } = await fixture();
    const releases = [null, release("0.4.0", { body: "unknown" }), release("0.6.0", { draft: true }),
      release("0.7.0-rc.1"), release("0.8.0", { prerelease: true }), release("0.1.0"),
      release("0.2.0", { body: marked ? body : "unknown" })];
    const fetch = vi.fn(async (url: string) => json(url === latestUrl ? release("0.5.0", { body: incompatible }) : releases));
    expect((await checkForPluginUpdates([entry()], { fetch }))[0]).toMatchObject({
      status: "available", latestVersion: marked ? "0.2.0" : "0.4.0"
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([latestUrl, listUrl]);
  });

  it("never downgrades or offers the installed version as a fallback", async () => {
    const { release } = await fixture();
    const fetch = async (url: string) => json(url === latestUrl ? release("0.5.0", { body: incompatible })
      : [release("0.1.0"), release("0.2.0")]);
    expect((await checkForPluginUpdates([entry("0.2.0")], { fetch }))[0]?.status).toBe("incompatible");
  });

  it.each([[], [null], [{ name: "nmr-predictor-0.4.0.zip", browser_download_url: "https://example.com/foreign.zip" },
    { name: "nmr-predictor-0.4.0.zip.sha256" }]].map(assets => ({ assets })))("skips unusable fallback assets $assets", async ({ assets }) => {
    const { release, zip, digest } = await fixture();
    const fetch = vi.fn(async (url: string) => {
      if (url === latestUrl) return json(release("0.5.0", { body: incompatible }));
      if (url === listUrl) return json([release("0.4.0", { assets }), release("0.2.0")]);
      if (url.endsWith(".sha256")) return new Response(`${digest}  nmr-predictor-0.2.0.zip\n`);
      return new Response(zip.slice().buffer);
    });
    expect((await checkForPluginUpdates([entry()], { fetch }))[0]).toMatchObject({ status: "available", latestVersion: "0.2.0" });
    expect((await prepareOfficialPluginInstall(id, { fetch })).inspection.manifest.version).toBe("0.2.0");
    expect(fetch.mock.calls.some(([url]) => url.includes("/v0.4.0/"))).toBe(false);
  });

  it("keeps the existing asset error if every fallback is unusable", async () => {
    const { release } = await fixture();
    const fetch = async (url: string) => json(url === latestUrl ? release("0.5.0", { body: incompatible })
      : [release("0.4.0", { assets: [] })]);
    await expect(prepareOfficialPluginInstall(id, { fetch })).rejects.toThrow(
      'Plugin release v0.4.0 must contain both "nmr-predictor-0.4.0.zip" and "nmr-predictor-0.4.0.zip.sha256".'
    );
    expect((await checkForPluginUpdates([entry()], { fetch }))[0]?.status).toBe("failed");
  });

  for (const failure of ["403", "429", "network", "timeout"]) {
    it(`reports an unavailable fresh install when latest metadata has ${failure}`, async () => {
      vi.useFakeTimers();
      try {
        const invoke = vi.fn();
        const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
          if (failure === "network") throw new TypeError("offline");
          if (failure === "timeout") return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          });
          return new Response(null, { status: Number(failure), headers: { "x-ratelimit-remaining": "0" } });
        });
        const pending = prepareOfficialPluginInstall(id, { fetch, invoke }).catch(error => error);
        await vi.advanceTimersByTimeAsync(20_000);
        // No version/assets means there is nothing to download; report inline without diagnosis.
        expect(await pending).toBeInstanceOf(PluginReleaseMetadataUnavailableError);
        expect((await pending).message).toBe("Couldn't reach GitHub to download the plugin. Try again later.");
        expect(fetch).toHaveBeenCalledExactlyOnceWith(latestUrl, expect.any(Object));
        expect(invoke).not.toHaveBeenCalled();
      } finally { vi.useRealTimers(); }
    });
    for (const endpoint of ["latest", "list"]) {
      it(`preserves fallback for ${endpoint} ${failure} with one attempt`, async () => {
        vi.useFakeTimers();
        try {
          const { release } = await fixture();
          const invoke = vi.fn();
          const fetch = vi.fn(async (url: string, init?: RequestInit) => {
            if (endpoint === "list" && url === latestUrl) return json(release("0.5.0", { body: incompatible }));
            if (failure === "network") throw new TypeError("offline");
            if (failure === "timeout") return new Promise<Response>((_, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            });
            return new Response(null, { status: Number(failure), headers: { "x-ratelimit-remaining": "0" } });
          });
          const pending = checkForPluginUpdates([entry()], { fetch, invoke });
          await vi.advanceTimersByTimeAsync(20_000);
          expect((await pending)[0]).toMatchObject(endpoint === "list"
            ? { status: "available", latestVersion: "0.5.0", metadataUnavailable: true } : { status: "unavailable" });
          expect(fetch).toHaveBeenCalledTimes(endpoint === "list" ? 2 : 1);
          expect(invoke).not.toHaveBeenCalled();
        } finally { vi.useRealTimers(); }
      });
    }
    it(`falls back to the latest install by version on list ${failure}`, async () => {
      vi.useFakeTimers();
      try {
        const { release, zip, digest } = await fixture();
        const invoke = vi.fn();
        const fetch = vi.fn(async (url: string, init?: RequestInit) => {
          if (url === latestUrl) return json(release("0.2.0", { body: incompatible }));
          if (url === listUrl) {
            if (failure === "network") throw new TypeError("offline");
            if (failure === "timeout") return new Promise<Response>((_, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            });
            return new Response(null, { status: Number(failure), headers: { "x-ratelimit-remaining": "0" } });
          }
          return url.endsWith(".sha256") ? new Response(`${digest}  nmr-predictor-0.2.0.zip\n`)
            : new Response(zip.slice().buffer);
        });
        const checked = prepareOfficialPluginInstall(id, { fetch, invoke }).then(value => ({ value }), error => ({ error }));
        await vi.advanceTimersByTimeAsync(20_000);
        expect(await checked).toMatchObject({ value: {
          selectionMessage: expect.stringContaining("Couldn't reach GitHub"),
          inspection: { manifest: { version: "0.2.0" } }
        } });
        expect(fetch.mock.calls.filter(([url]) => url === listUrl)).toHaveLength(1);
        expect(invoke).not.toHaveBeenCalled();
      } finally { vi.useRealTimers(); }
    });
  }
});
