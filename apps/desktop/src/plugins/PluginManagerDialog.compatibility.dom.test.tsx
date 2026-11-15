// @vitest-environment jsdom

import { PluginManifestSchema } from "@chemdraft/plugin-api";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryStorage } from "../testSupport/memoryStorage";
import { createPluginRuntime } from "./createPluginRuntime";
import type { InstalledPluginCatalogEntry } from "./installPluginPackage";
import { PluginManagerDialog } from "./PluginManagerDialog";
import { checkForPluginUpdates, PluginReleaseMetadataUnavailableError } from "./pluginUpdates";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pluginId = "org.chemdraft.nmr.predictor";
const repository = "jgassens/ChemDraft-NMR-Plugin";
const apiUrl = `https://api.github.com/repos/${repository}/releases/latest`;
const packageUrl = `https://github.com/${repository}/releases/download/v0.2.0/nmr-predictor-0.2.0.zip`;
const installed: InstalledPluginCatalogEntry = {
  record: {
    id: pluginId, name: "NMR Shift Predictor", version: "0.1.0",
    sourceChecksum: "a".repeat(64), stagedPath: `installed-plugins/${pluginId}`,
    installedAt: "2026-11-10T00:00:00Z"
  },
  manifest: PluginManifestSchema.parse({
    id: pluginId, name: "NMR Shift Predictor", version: "0.1.0", apiVersion: "^0.1.0",
    entry: "entry.js", permissions: []
  }),
  descriptor: undefined
};

let root: Root | undefined;
let container: HTMLElement | undefined;
const originalLocalStorage = Object.getOwnPropertyDescriptor(window, "localStorage");

beforeEach(() => {
  Object.defineProperty(window, "localStorage", { configurable: true, value: new MemoryStorage() });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  if (originalLocalStorage) Object.defineProperty(window, "localStorage", originalLocalStorage);
});

async function showCheckedRelease(body: string, installedVersion = "0.1.0") {
  const entry = { ...installed, record: { ...installed.record, version: installedVersion } };
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url === apiUrl ? {
    tag_name: "v0.2.0",
    html_url: `https://github.com/${repository}/releases/tag/v0.2.0`,
    published_at: "2026-11-10T00:00:00Z",
    draft: false,
    prerelease: false,
    body,
    assets: [
      { name: "nmr-predictor-0.2.0.zip", browser_download_url: packageUrl, size: 100, digest: `sha256:${"b".repeat(64)}` },
      { name: "nmr-predictor-0.2.0.zip.sha256", browser_download_url: `${packageUrl}.sha256`, size: 90 }
    ]
  } : []), { status: 200, headers: { "content-type": "application/json" } }));
  const prepare = vi.fn();
  const update = vi.fn();
  const runtime = createPluginRuntime({ getActiveDocument: () => undefined });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(PluginManagerDialog, {
    runtime,
    bundledPlugins: [],
    installedPlugins: [entry],
    onClose: vi.fn(),
    onCheckPluginUpdates: () => checkForPluginUpdates([entry], { fetch }),
    onPreparePluginUpdate: prepare,
    onPrepareOfficialPluginInstall: async () => { throw new PluginReleaseMetadataUnavailableError("metadata unavailable"); },
    onInstallPackage: vi.fn(),
    onUpdatePlugin: update
  })));
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[data-action="check-plugin-updates"]')!.click();
  });
  return { fetch, prepare, update };
}

describe("plugin manager release compatibility", () => {
  it.each([
    ["ChemDraft-Plugin-API: ^0.1.99\nChemDraft-Min-App: 1.9.0", "Needs ChemDraft 1.9.0 or later"],
    ["ChemDraft-Plugin-API: ^0.1.99", "Needs a newer ChemDraft"]
  ])("shows the host requirement and hides Review update for %s", async (body, message) => {
    const { fetch, prepare, update } = await showCheckedRelease(body);

    expect.soft(document.body.textContent).toContain(message);
    expect.soft(document.querySelector('[data-update-status="available"]')).toBeNull();
    expect.soft(document.querySelector('[data-action="review-plugin-update"]')).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([apiUrl, `https://api.github.com/repos/${repository}/releases?per_page=20`]);
  });

  it("does not ask a newer host to upgrade in either the row or summary", async () => {
    await showCheckedRelease("ChemDraft-Plugin-API: 0.1.24\nChemDraft-Min-App: 1.0.0");
    expect(document.body.textContent).toContain("Not yet available for this ChemDraft version");
    expect(document.body.textContent).not.toMatch(/needs a newer ChemDraft|Needs ChemDraft/);
    expect(document.querySelector('[data-action="review-plugin-update"]')).toBeNull();
  });

  it.each(["0.2.0", "0.3.0"])("shows normal Up to date for installed %s despite markers", async version => {
    const { fetch } = await showCheckedRelease("ChemDraft-Plugin-API: ^0.1.99", version);
    expect(document.querySelector('[data-update-status="up-to-date"]')?.textContent).toContain("Up to date");
    expect(document.body.textContent).not.toContain("Needs a newer ChemDraft");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps the previous version offer with inline feedback when latest metadata becomes unavailable", async () => {
    const { fetch } = await showCheckedRelease("Older release with no markers.");
    fetch.mockImplementation(async () => new Response(null, { status: 429 }));
    await act(async () => document.querySelector<HTMLButtonElement>('[data-action="check-plugin-updates"]')!.click());
    expect(document.querySelector('[data-update-status="available"]')?.textContent).toContain("Version 0.2.0 is available.");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/failed/i);
    expect(document.body.textContent).toContain("Couldn't reach GitHub to check for plugin updates. Try again later.");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps first-check and fresh-install metadata outages out of error dialogs", async () => {
    const { fetch } = await showCheckedRelease("Older release with no markers.", "0.2.0");
    fetch.mockImplementation(async () => new Response(null, { status: 429 }));
    await act(async () => document.querySelector<HTMLButtonElement>('[data-action="check-plugin-updates"]')!.click());
    const install = document.querySelector<HTMLButtonElement>('[data-action="install-official-plugin"]');
    expect(install).not.toBeNull();
    expect(install!.disabled).toBe(false);
    await act(async () => install!.click());
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/failed/i);
    expect(document.body.textContent).not.toContain("metadata unavailable");
    expect(document.body.textContent).toContain("Couldn't reach GitHub to download the plugin. Try again later.");
  });

  it("shows Review update metadata outages inline", async () => {
    const { prepare } = await showCheckedRelease("Older release with no markers.");
    prepare.mockRejectedValue(new PluginReleaseMetadataUnavailableError());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-action="review-plugin-update"]')!.click());
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).toContain("Couldn't reach GitHub to check for plugin updates. Try again later.");
  });

  it("shows a releases-list outage inline while offering the latest version fallback", async () => {
    const { fetch } = await showCheckedRelease("Older release with no markers.");
    const latest = await fetch(apiUrl);
    const release = await latest.json();
    release.body = "ChemDraft-Plugin-API: ^0.1.99";
    fetch.mockImplementation(async url => url === apiUrl
      ? new Response(JSON.stringify(release)) : new Response(null, { status: 429 }));
    await act(async () => document.querySelector<HTMLButtonElement>('[data-action="check-plugin-updates"]')!.click());
    expect(document.querySelector('[data-update-status="available"]')?.textContent).toContain("Version 0.2.0 is available.");
    expect(document.body.textContent).toContain("Couldn't reach GitHub to check for plugin updates. Try again later.");
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it.each(["Older release with no markers.", "ChemDraft-Plugin-API: ^0.1.0"])(
    "keeps the normal offer and Review update action for %s", async (body) => {
      const { fetch, prepare, update } = await showCheckedRelease(body);

      expect(document.querySelector('[data-update-status="available"]')?.textContent)
        .toContain("Version 0.2.0 is available.");
      const review = document.querySelector<HTMLButtonElement>('[data-action="review-plugin-update"]');
      expect(review?.textContent).toBe("Review update…");
      expect(review?.disabled).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([apiUrl]);
    }
  );
});
