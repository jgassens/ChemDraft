import { readFileSync } from "node:fs";
import type { PluginManifest } from "@chemdraft/plugin-api";
import { describe, expect, it, vi } from "vitest";

import { createZipFixture, tamperByte } from "../testSupport/zipFixture";
import type { InstalledPluginCatalogEntry } from "./installPluginPackage";
import { DEFAULT_PLUGIN_PACKAGE_ARCHIVE_LIMITS, sha256Hex } from "./pluginPackageArchive";
import {
  checkForPluginUpdates,
  GITHUB_RELEASE_ASSET_HOST,
  GITHUB_RELEASE_ASSET_PATH_PREFIX,
  isNetworkDownloadFailure,
  isOfficialPluginExperimental,
  OFFICIAL_PLUGIN_CATALOG,
  prepareOfficialPluginInstall,
  preparePluginUpdate,
  redactUrl,
  redactUrls,
  type PluginUpdateOffer
} from "./pluginUpdates";

const PLUGIN_ID = "org.chemdraft.nmr.predictor";
const API_URL = "https://api.github.com/repos/jgassens/ChemDraft-NMR-Plugin/releases/latest";

function manifest(version: string, id = PLUGIN_ID): PluginManifest {
  return {
    id,
    name: "NMR Shift Predictor",
    version,
    apiVersion: "^0.1.0",
    entry: "entry.js",
    permissions: [],
    contributes: {
      commands: [],
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
    }
  };
}

function installedEntry(version: string, id = PLUGIN_ID): InstalledPluginCatalogEntry {
  return {
    record: {
      id,
      version,
      name: "NMR Shift Predictor",
      stagedPath: `installed-plugins/${id}`,
      sourceChecksum: "a".repeat(64),
      installedAt: "2026-07-24T12:00:00.000Z"
    },
    manifest: manifest(version, id),
    descriptor: undefined
  };
}

async function pluginPackage(version: string, id = PLUGIN_ID): Promise<Uint8Array> {
  return createZipFixture([
    {
      path: "manifest.json",
      content: JSON.stringify({
        ...manifest(version, id),
        chemdraftPackage: {
          sdk: "@chemdraft/plugin-api",
          sdkVersion: "0.1.0",
          sourceCommit: "eed188881f5c74e3e44683bd6f5ce60e18d5f559",
          sourceTree: "clean",
          licenseFile: "LICENSE",
          packagedAt: "2026-07-25T12:00:00.000Z"
        }
      })
    },
    { path: "entry.js", content: "export const ready = true;" },
    { path: "LICENSE", content: "MIT code; bundled database separately licensed." }
  ]);
}

async function releaseDocument(
  version: string,
  zip: Uint8Array,
  overrides: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const packageName = `nmr-predictor-${version}.zip`;
  const packageUrl =
    `https://github.com/jgassens/ChemDraft-NMR-Plugin/releases/download/v${version}/${packageName}`;
  return {
    tag_name: `v${version}`,
    html_url: `https://github.com/jgassens/ChemDraft-NMR-Plugin/releases/tag/v${version}`,
    published_at: "2026-07-25T13:44:21Z",
    draft: false,
    prerelease: false,
    assets: [
      {
        name: packageName,
        browser_download_url: packageUrl,
        size: zip.byteLength,
        digest: `sha256:${await sha256Hex(zip)}`
      },
      {
        name: `${packageName}.sha256`,
        browser_download_url: `${packageUrl}.sha256`,
        size: 90,
        digest: `sha256:${"b".repeat(64)}`
      }
    ],
    ...overrides
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("host-managed plugin update catalog", () => {
  const signedUrl = "https://release-assets.githubusercontent.com/github-production-release-asset/1/package?sig=secret-signature&jwt=secret-token#fragment";
  const rawFailure = `error sending request for url (${signedUrl})`;

  it.each(["zip", "sidecar", "zip redirect", "sidecar redirect"])("diagnoses a rejected %s fetch using the requested host", async (stage) => {
    const zip = await pluginPackage("0.1.0");
    const release = await releaseDocument("0.1.0", zip);
    const diagnosedMessage = `Couldn't reach ${stage.includes("redirect") ? GITHUB_RELEASE_ASSET_HOST : "github.com"}: the server's security certificate isn't trusted.`;
    const invoke = vi.fn(async () => ({
      category: "certificate_untrusted",
      message: diagnosedMessage,
      logDetail: `nested cause: ${signedUrl}`
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fetch = vi.fn(async (url: string) => {
        if (url === API_URL) return jsonResponse(release);
        const targeted = stage.startsWith("sidecar") ? url.endsWith(".sha256") : url.endsWith(".zip");
        if (url === signedUrl || (targeted && !stage.includes("redirect"))) throw new Error(rawFailure);
        if (targeted) return new Response(null, { status: 302, headers: { location: signedUrl } });
        return new Response(zip.slice().buffer);
      });
      await expect(prepareOfficialPluginInstall(PLUGIN_ID, { fetch, invoke })).rejects.toThrow(diagnosedMessage);
      expect(invoke).toHaveBeenCalledWith("diagnose_download_host", { host: stage.includes("redirect") ? GITHUB_RELEASE_ASSET_HOST : "github.com" });
      expect(warn).toHaveBeenCalledWith(
        `Download transport failure for ${stage.includes("redirect") ? GITHUB_RELEASE_ASSET_HOST : "github.com"}: error sending request for url (https://release-assets.githubusercontent.com/github-production-release-asset/1/package)`
      );
      const logs = warn.mock.calls.flat().join(" ");
      for (const secret of ["?", "sig=", "jwt=", "secret-token", "secret-signature"]) expect(logs).not.toContain(secret);
    } finally { warn.mockRestore(); }
  });

  it("diagnoses update-check transport failures without exposing the rejected error", async () => {
    const message = "Couldn't reach api.github.com: the name could not be found.";
    const invoke = vi.fn(async () => ({ category: "dns", message, logDetail: rawFailure }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await checkForPluginUpdates([installedEntry("0.0.9")], {
        fetch: async () => { throw new Error(rawFailure); }, invoke
      });
      expect(result[0]).toMatchObject({ status: "failed", message });
      expect(invoke).toHaveBeenCalledExactlyOnceWith("diagnose_download_host", { host: "api.github.com" });
      expect(warn.mock.calls.flat().join(" ")).not.toMatch(/\?|sig=|jwt=|secret-token|secret-signature/);
    } finally { warn.mockRestore(); }
  });

  it.each(["zip", "sidecar", "zip redirect", "sidecar redirect"])("explains an interrupted %s body and redacts its logged cause", async (stage) => {
    const zip = await pluginPackage("0.1.0");
    const release = await releaseDocument("0.1.0", zip);
    const host = stage.includes("redirect") ? GITHUB_RELEASE_ASSET_HOST : "github.com";
    const message = `Couldn't reach ${host}: the connection was interrupted during the download; try again.`;
    const invoke = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fetch = async (url: string) => {
        if (url === API_URL) return jsonResponse(release);
        const targeted = stage.startsWith("sidecar") ? url.endsWith(".sha256") : url.endsWith(".zip");
        if (targeted && stage.includes("redirect")) {
          return new Response(null, { status: 302, headers: { location: signedUrl } });
        }
        if (targeted || url === signedUrl) {
          let reads = 0;
          return new Response(new ReadableStream<Uint8Array>({
            pull(controller) {
              if (reads++ === 0) controller.enqueue(new Uint8Array([1, 2]));
              // Even timeout/abort-looking text is a read failure unless our signal was aborted.
              else controller.error(new Error(`AbortError: timed out reading ${signedUrl})jwt=secret-token`));
            }
          }));
        }
        return new Response(zip.slice().buffer);
      };
      await expect(prepareOfficialPluginInstall(PLUGIN_ID, { fetch, invoke })).rejects.toThrow(message);
      expect(isNetworkDownloadFailure(message)).toBe(true);
      expect(invoke).not.toHaveBeenCalled();
      const logs = warn.mock.calls.flat().join(" ");
      expect(logs).toContain(`Download body failure for ${host}: AbortError: timed out reading https://`);
      expect(logs).not.toMatch(/\?|sig=|jwt=|secret-token|secret-signature|fragment/);
    } finally { warn.mockRestore(); }
  });

  it.each(["zip", "sidecar"])("preserves our timeout message while reading the %s body", async (stage) => {
    const zip = await pluginPackage("0.1.0");
    const release = await releaseDocument("0.1.0", zip);
    const invoke = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const pending = prepareOfficialPluginInstall(PLUGIN_ID, {
        invoke,
        fetch: async (url, init) => {
          if (url === API_URL) return jsonResponse(release);
          const targeted = stage === "sidecar" ? url.endsWith(".sha256") : url.endsWith(".zip");
          if (!targeted) return new Response(zip.slice().buffer);
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2]));
              init?.signal?.addEventListener("abort", () => controller.error(new Error(rawFailure)));
            }
          }));
        }
      });
      const expected = stage === "zip"
        ? "Downloading NMR Shift Predictor 0.1.0 timed out after 120 seconds."
        : "Downloading the NMR Shift Predictor 0.1.0 checksum timed out after 20 seconds.";
      const assertion = expect(pending).rejects.toThrow(expected);
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
      expect(invoke).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); warn.mockRestore(); }
  });

  it.each([true, false])("uses a safe fallback if diagnosis fails (reachable=%s)", async (reachable) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await checkForPluginUpdates([installedEntry("0.0.9")], {
        fetch: async () => { throw new Error(rawFailure); },
        invoke: async () => {
          if (!reachable) throw new Error(rawFailure);
          return { category: "reachable", message: null, logDetail: "" };
        }
      });
      expect(result[0]).toMatchObject({ status: "failed", message: reachable
        ? "Couldn't reach api.github.com: the connection was dropped or interrupted; try again."
        : "Couldn't reach api.github.com: the connection failed." });
      expect(JSON.stringify(result)).not.toMatch(/\?|sig=|jwt=|secret-token/);
      expect(warn.mock.calls.flat().join(" ")).not.toMatch(/\?|sig=|jwt=|secret-token/);
    } finally { warn.mockRestore(); }
  });

  it("preserves HTTP status errors without diagnosing a transport failure", async () => {
    const invoke = vi.fn();
    const result = await checkForPluginUpdates([installedEntry("0.0.9")], {
      fetch: async () => new Response(null, { status: 503, statusText: "Service Unavailable" }), invoke
    });
    expect(result[0]).toMatchObject({ status: "failed", message: "Checking NMR Shift Predictor releases failed with HTTP 503 Service Unavailable." });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("preserves our abort timeout message without running diagnosis", async () => {
    vi.useFakeTimers();
    const invoke = vi.fn();
    try {
      const pending = checkForPluginUpdates([installedEntry("0.0.9")], {
        fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error(rawFailure)));
        }), invoke
      });
      await vi.advanceTimersByTimeAsync(20_000);
      expect((await pending)[0]).toMatchObject({ status: "failed", message: "Checking NMR Shift Predictor releases timed out after 20 seconds." });
      expect(invoke).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("redacts credentials, queries and fragments from every URL in text", () => {
    expect(redactUrl("https://user:password@github.com/path?sig=secret#fragment")).toBe("https://github.com/path");
    expect(redactUrl("not a URL?sig=secret")).toBe("[redacted URL]");
    const clean = redactUrls(`outer (${signedUrl}); inner HTTP://user:password@github.com/path?jwt=secret-token`);
    expect(clean).toContain("https://release-assets.githubusercontent.com/github-production-release-asset/1/package");
    expect(clean).not.toMatch(/\?|sig=|jwt=|secret-token|password|fragment/);
  });

  it.each([
    "https://user:password@github.com/path?sig=secret'jwt=secret",
    'https://github.com/path?sig=secret"jwt=secret',
    "https://github.com/path?sig=secret`jwt=secret",
    "https://github.com/path?sig=secret,jwt=secret",
    "https://github.com/path?sig=secret)jwt=secret",
    "https://github.com/path?sig=%29%22%60secret%23jwt%3Dsecret",
    "HTTPS://github.com/path#secret)jwt=secret?sig=secret",
    "https://[invalid/path?sig=secret)jwt=secret",
    "https://[invalid/path#secret`jwt=secret",
    "https://[invalid]/path?sig=secret)jwt=secret"
  ])("redacts the entire sensitive suffix even with unusual delimiters: %s", (url) => {
    const expected = url.includes("[invalid") ? "[redacted URL]" : "https://github.com/path";
    expect(redactUrl(url)).toBe(expected);
    expect(redactUrls(`outer ${url} next`)).toBe(`outer ${expected} next`);
  });

  it.each([")", ".", ",", ")).,"])("preserves trailing URL punctuation: %s", (suffix) => {
    for (const query of ["", "?sig=secret"]) {
      expect(redactUrls(`request https://github.com/path${query}${suffix} client`))
        .toBe(`request https://github.com/path${suffix} client`);
    }
  });

  it("redacts query text on both sides of an internal closing parenthesis", () => {
    expect(redactUrls("request https://github.com/path?sig=ab)cd client"))
      .toBe("request https://github.com/path client");
  });

  it("compiles the complete official plugin catalog into the host", () => {
    expect(OFFICIAL_PLUGIN_CATALOG).toEqual([
      {
        pluginId: "org.chemdraft.naming.orthonym",
        displayName: "Name from Structure (Orthonym)",
        description: "Name the selected structure. Every name shown was read back by OPSIN as exactly the drawn structure. Installing it also downloads the local naming engine and its dependencies.",
        repository: "jgassens/ChemDraft-Orthonym-Plugin",
        assetStem: "orthonym-naming",
        requiresEngine: "structureNaming"
      },
      {
        pluginId: "org.chemdraft.nmr.predictor",
        displayName: "NMR Shift Predictor",
        description: "¹H/¹³C shift prediction from NMRShiftDB2-derived statistics.",
        repository: "jgassens/ChemDraft-NMR-Plugin",
        assetStem: "nmr-predictor"
      },
      {
        pluginId: "org.chemdraft.opsin.nameToStructure",
        displayName: "Name to Structure (OPSIN)",
        description: "Type a systematic chemical name and insert its structure.",
        repository: "jgassens/ChemDraft-OPSIN-Plugin",
        assetStem: "opsin-name-to-structure"
      },
      {
        pluginId: "org.chemdraft.ocsr.molscribe",
        displayName: "Structure from Image (MolScribe)",
        description:
          "Recognize a drawn structure from an image or screenshot. Installing it also downloads the local MolScribe model and its dependencies.",
        repository: "jgassens/ChemDraft-MolScribe-Plugin",
        assetStem: "molscribe-ocsr",
        requiresEngine: "structureRecognition",
        experimental: true
      }
    ]);
  });

  it("checks only allowlisted installed plugins and reports up-to-date without downloading", async () => {
    const zip = await pluginPackage("0.1.0");
    const fetch = vi.fn(async (url: string, _init?: RequestInit & { maxRedirections?: number }) => {
      expect(url).toBe(API_URL);
      return jsonResponse(await releaseDocument("0.1.0", zip));
    });

    const results = await checkForPluginUpdates(
      [installedEntry("0.1.0"), installedEntry("1.0.0", "org.example.untrusted")],
      { fetch }
    );

    expect(results).toEqual([
      {
        status: "upToDate",
        pluginId: PLUGIN_ID,
        installedVersion: "0.1.0",
        latestVersion: "0.1.0"
      },
      {
        status: "unsupported",
        pluginId: "org.example.untrusted",
        installedVersion: "1.0.0"
      }
    ]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ maxRedirections: 0 });
  });

  it("does not treat inherited object-property plugin ids as trusted catalog entries", async () => {
    const fetch = vi.fn();
    const results = await checkForPluginUpdates(
      ["constructor", "toString", "__proto__"].map((id) => installedEntry("1.0.0", id)),
      { fetch }
    );

    expect(results).toEqual(
      ["constructor", "toString", "__proto__"].map((pluginId) => ({
        status: "unsupported",
        pluginId,
        installedVersion: "1.0.0"
      }))
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("offers a strictly newer exact NMR release and fails closed on a foreign asset URL", async () => {
    const zip = await pluginPackage("0.1.0");
    const valid = await checkForPluginUpdates([installedEntry("0.0.9")], {
      fetch: async () => jsonResponse(await releaseDocument("0.1.0", zip))
    });
    expect(valid[0]).toMatchObject({
      status: "available",
      latestVersion: "0.1.0",
      offer: {
        pluginId: PLUGIN_ID,
        installedVersion: "0.0.9",
        sourceChecksum: await sha256Hex(zip)
      }
    });

    const release = await releaseDocument("0.1.0", zip);
    const assets = release.assets as Record<string, unknown>[];
    assets[0] = { ...assets[0], browser_download_url: "https://example.com/nmr-predictor-0.1.0.zip" };
    const refused = await checkForPluginUpdates([installedEntry("0.0.9")], {
      fetch: async () => jsonResponse(release)
    });
    expect(refused[0]).toMatchObject({ status: "failed" });
    expect(refused[0]?.status === "failed" ? refused[0].message : "").toMatch(/trusted.*release path/i);
  });

  it("accepts stable build metadata but does not offer prerelease tags", async () => {
    const stableZip = await pluginPackage("0.1.0+mac-arm64");
    const stable = await checkForPluginUpdates([installedEntry("0.0.9")], {
      fetch: async () => jsonResponse(await releaseDocument("0.1.0+mac-arm64", stableZip))
    });
    expect(stable[0]).toMatchObject({ status: "available", latestVersion: "0.1.0+mac-arm64" });

    const prereleaseZip = await pluginPackage("0.1.0-rc.1");
    const prerelease = await checkForPluginUpdates([installedEntry("0.0.9")], {
      fetch: async () => jsonResponse(await releaseDocument("0.1.0-rc.1", prereleaseZip))
    });
    expect(prerelease[0]).toMatchObject({ status: "failed" });
    expect(prerelease[0]?.status === "failed" ? prerelease[0].message : "").toMatch(/prerelease/i);
  });

  it("downloads, checksum-verifies, and inspects an offer without installing it", async () => {
    const zip = await pluginPackage("0.1.0");
    const checked = await checkForPluginUpdates([installedEntry("0.0.9")], {
      fetch: async () => jsonResponse(await releaseDocument("0.1.0", zip))
    });
    const offer = checked[0]?.status === "available" ? checked[0].offer : undefined;
    expect(offer).toBeDefined();

    const assetUrl =
      "https://release-assets.githubusercontent.com/github-production-release-asset/1/asset" +
      "?response-content-disposition=nmr-predictor-0.1.0.zip";
    const sidecarUrl = `${offer!.packageUrl}.sha256`;
    const fetch = vi.fn(async (url: string, _init?: RequestInit & { maxRedirections?: number }) => {
      if (url === offer!.packageUrl) {
        return new Response(null, { status: 302, headers: { location: assetUrl } });
      }
      if (url === sidecarUrl) {
        return new Response(`${offer!.sourceChecksum}  ${offer!.packageName}\n`, { status: 200 });
      }
      expect(url).toBe(assetUrl);
      return new Response(zip.slice().buffer, {
        status: 200,
        headers: { "content-length": String(zip.byteLength) }
      });
    });
    const prepared = await preparePluginUpdate(offer!, {
      fetch
    });

    expect(prepared.inspection.manifest).toMatchObject({ id: PLUGIN_ID, version: "0.1.0" });
    expect(prepared.inspection.sourceChecksum).toBe(offer!.sourceChecksum);
    expect(prepared.checksumVerified).toBe(true);
    // Package request, its validated redirect, then the published sidecar.
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.map((call) => call[0])).toContain(sidecarUrl);
    expect(fetch.mock.calls.every((call) => call[1]?.maxRedirections === 0)).toBe(true);
  });

  it("prepares an official catalog install through the same verified release path", async () => {
    const zip = await pluginPackage("0.1.0");
    const release = await releaseDocument("0.1.0", zip);
    const checksum = await sha256Hex(zip);
    const fetch = vi.fn(async (url: string) => {
      if (url === API_URL) return jsonResponse(release);
      if (url.endsWith(".sha256")) {
        return new Response(`${checksum}  nmr-predictor-0.1.0.zip\n`, { status: 200 });
      }
      return new Response(zip.slice().buffer, { status: 200 });
    });

    const prepared = await prepareOfficialPluginInstall(PLUGIN_ID, { fetch });

    expect(prepared).toMatchObject({
      pluginId: PLUGIN_ID,
      checksumVerified: true,
      inspection: { manifest: { id: PLUGIN_ID, version: "0.1.0" } }
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each(["org.chemdraft.opsin.nameToStructure", "org.chemdraft.ocsr.molscribe"])(
    "reports an official catalog entry with no release explicitly (%s)",
    async (pluginId) => {
      await expect(
        prepareOfficialPluginInstall(pluginId, {
          fetch: async () => new Response(null, { status: 404, statusText: "Not Found" })
        })
      ).rejects.toThrow("No release published yet");
    }
  );

  it("keeps the trusted redirect host in step with the capability scope", async () => {
    // The module refuses a redirect that misses these strings, and the capability scope refuses the
    // follow-up request that misses them. If GitHub moves the host again, both must move together
    // or every update dies with a misleading "did not target GitHub's trusted release-asset host".
    const capability = JSON.parse(
      readFileSync(new URL("../../src-tauri/capabilities/plugin-updates.json", import.meta.url), "utf8")
    ) as { permissions: Array<{ identifier: string; allow?: Array<{ url: string }> }> };
    const allowed = capability.permissions
      .filter((permission) => permission.identifier === "http:default")
      .flatMap((permission) => permission.allow ?? [])
      .map((entry) => entry.url);

    expect(allowed).toContain(
      `https://${GITHUB_RELEASE_ASSET_HOST}${GITHUB_RELEASE_ASSET_PATH_PREFIX}*`
    );

    // Match real URLs against the real patterns. The previous version of this test asserted only
    // that the `.zip` pattern existed, which is why a missing `.zip.sha256` entry shipped: Tauri
    // compiles these with URLPattern, whose pathname match is exact, so `…zip` does not cover
    // `…zip.sha256` and every update died after downloading the package.
    const isAllowed = (url: string) =>
      allowed.some((pattern) => new URLPattern(pattern).test(url));

    for (const entry of OFFICIAL_PLUGIN_CATALOG) {
      const apiUrl = `https://api.github.com/repos/${entry.repository}/releases/latest`;
      const packageUrl =
        `https://github.com/${entry.repository}/releases/download/v0.1.0/` +
        `${entry.assetStem}-0.1.0.zip`;
      expect(isAllowed(apiUrl), `${entry.pluginId} release API`).toBe(true);
      expect(isAllowed(packageUrl), `${entry.pluginId} package`).toBe(true);
      expect(isAllowed(`${packageUrl}.sha256`), `${entry.pluginId} checksum`).toBe(true);
    }
    expect(
      isAllowed(`https://${GITHUB_RELEASE_ASSET_HOST}${GITHUB_RELEASE_ASSET_PATH_PREFIX}1/asset?x=1`)
    ).toBe(true);

    // And nothing outside the catalog is reachable.
    expect(isAllowed("https://example.com/nmr-predictor-0.1.0.zip")).toBe(false);
    expect(
      isAllowed("https://github.com/attacker/ChemDraft-NMR-Plugin/releases/download/v1/nmr-predictor-1.zip")
    ).toBe(false);
  });

  it("requires the published sidecar to agree with the release asset digest", async () => {
    const zip = await pluginPackage("0.1.0");
    const checked = await checkForPluginUpdates([installedEntry("0.0.9")], {
      fetch: async () => jsonResponse(await releaseDocument("0.1.0", zip))
    });
    const offer = checked[0]?.status === "available" ? checked[0].offer : undefined;
    const serve = (sidecarBody: string) => async (url: string) =>
      url.endsWith(".sha256")
        ? new Response(sidecarBody, { status: 200 })
        : new Response(zip.slice().buffer, { status: 200 });

    await expect(
      preparePluginUpdate(offer!, { fetch: serve(`${"c".repeat(64)}  nmr-predictor-0.1.0.zip\n`) })
    ).rejects.toThrow(/checksum does not match/i);

    await expect(
      preparePluginUpdate(offer!, { fetch: serve("not a shasum file") })
    ).rejects.toThrow(/not in shasum format/i);

    // Windows publishers emit uppercase digests; the archive still verifies.
    const upper = await preparePluginUpdate(offer!, {
      fetch: serve(`${offer!.sourceChecksum.toUpperCase()} *nmr-predictor-0.1.0.zip\r\n`)
    });
    expect(upper.checksumVerified).toBe(true);

    // An oversized sidecar is refused while streaming, not after buffering.
    await expect(
      preparePluginUpdate(offer!, { fetch: serve("a".repeat(8192)) })
    ).rejects.toThrow(/limit/i);
  });

  it("refuses corrupted bytes and a package whose manifest id does not match the trusted offer", async () => {
    const zip = await pluginPackage("0.1.0");
    const checksum = await sha256Hex(zip);
    const offer: PluginUpdateOffer = {
      pluginId: PLUGIN_ID,
      pluginName: "NMR Shift Predictor",
      installedVersion: "0.0.9",
      version: "0.1.0",
      releaseUrl: "https://github.com/jgassens/ChemDraft-NMR-Plugin/releases/tag/v0.1.0",
      packageUrl:
        "https://github.com/jgassens/ChemDraft-NMR-Plugin/releases/download/v0.1.0/nmr-predictor-0.1.0.zip",
      packageName: "nmr-predictor-0.1.0.zip",
      sourceChecksum: checksum,
      compressedBytes: zip.byteLength,
      publishedAt: "2026-07-25T13:44:21Z"
    };

    // A sidecar that matches the offer, but tampered archive bytes: the archive must still fail.
    await expect(
      preparePluginUpdate(offer, {
        fetch: async (url) =>
          url.endsWith(".sha256")
            ? new Response(`${checksum}  ${offer.packageName}\n`, { status: 200 })
            : new Response(tamperByte(zip, 45).slice().buffer, { status: 200 })
      })
    ).rejects.toThrow(/checksum/i);

    const wrongPlugin = await pluginPackage("0.1.0", "org.example.impostor");
    const wrongChecksum = await sha256Hex(wrongPlugin);
    const wrongOffer = { ...offer, sourceChecksum: wrongChecksum };
    await expect(
      preparePluginUpdate(wrongOffer, {
        fetch: async (url) =>
          url.endsWith(".sha256")
            ? new Response(`${wrongChecksum}  ${offer.packageName}\n`, { status: 200 })
            : new Response(wrongPlugin.slice().buffer, { status: 200 })
      })
    ).rejects.toThrow(/declares plugin id/i);
  });

  it("refuses redirects outside GitHub's release-asset host and bounds a body with no Content-Length", async () => {
    const zip = await pluginPackage("0.1.0");
    const checked = await checkForPluginUpdates([installedEntry("0.0.9")], {
      fetch: async () => jsonResponse(await releaseDocument("0.1.0", zip))
    });
    const offer = checked[0]?.status === "available" ? checked[0].offer : undefined;
    expect(offer).toBeDefined();

    const cancel = vi.fn();
    await expect(
      preparePluginUpdate(offer!, {
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel
            }),
            {
              status: 302,
              headers: { location: "https://example.com/foreign.zip" }
            }
          )
      })
    ).rejects.toThrow(/trusted release-asset host/i);
    expect(cancel).toHaveBeenCalledOnce();

    const tooLarge = new Uint8Array(DEFAULT_PLUGIN_PACKAGE_ARCHIVE_LIMITS.maxCompressedBytes + 1);
    await expect(
      preparePluginUpdate(offer!, {
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(tooLarge);
                controller.close();
              }
            }),
            { status: 200 }
          )
      })
    ).rejects.toThrow(/exceeded.*limit/i);
  });
});

describe("isOfficialPluginExperimental", () => {
  it("is true only for the MolScribe OCSR catalog entry", () => {
    expect(isOfficialPluginExperimental("org.chemdraft.ocsr.molscribe")).toBe(true);
    expect(isOfficialPluginExperimental("org.chemdraft.nmr.predictor")).toBe(false);
    expect(isOfficialPluginExperimental("org.chemdraft.opsin.nameToStructure")).toBe(false);
    expect(isOfficialPluginExperimental("org.chemdraft.unknown.plugin")).toBe(false);
  });

  it("matches the flag recorded on the catalog entry itself", () => {
    const molscribe = OFFICIAL_PLUGIN_CATALOG.find((entry) => entry.pluginId === "org.chemdraft.ocsr.molscribe");
    expect(molscribe?.experimental).toBe(true);
  });
});
