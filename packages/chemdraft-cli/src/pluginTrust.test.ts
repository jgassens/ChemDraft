import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CLI_REFUSED_PLUGIN_PERMISSIONS,
  DEFAULT_TRUSTED_PLUGINS_PATH,
  PluginTrustError,
  loadTrustedPlugin,
  readTrustedPlugins,
  resolveDefaultTrustedPluginsPath,
  type TrustedPluginRequest
} from "./pluginTrust";

const PLUGIN_ID = "org.chemdraft.nmr.predictor";

let root: string;
let counter = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "chemdraft-plugin-trust-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

interface FakePlugin {
  dir: string;
  /** Written by src/manifest.ts when it is imported. */
  manifestMarker: string;
  /** Written by src/index.ts when it is imported. */
  entryMarker: string;
}

function manifestSource(marker: string, overrides: Record<string, unknown> = {}): string {
  const manifest = {
    id: PLUGIN_ID,
    name: "Fake NMR plugin",
    version: "0.0.0",
    apiVersion: "^0.1.0",
    entry: "src/index.ts",
    permissions: ["selection.read", "analysis.write"],
    ...overrides
  };
  return [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(marker)}, "manifest ran");`,
    `export const nmrPredictorManifest = ${JSON.stringify(manifest)};`
  ].join("\n");
}

function entrySource(marker: string): string {
  return [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(marker)}, "entry ran");`,
    'export const loadedFrom = "fake plugin";'
  ].join("\n");
}

/** A tiny fake plugin whose manifest and entry each leave a marker file when they execute. */
async function fakePlugin(options: { manifest?: Record<string, unknown>; manifestSource?: string } = {}): Promise<FakePlugin> {
  const dir = join(root, `plugin-${++counter}`);
  await mkdir(join(dir, "src"), { recursive: true });
  const manifestMarker = join(root, `plugin-${counter}.manifest-ran`);
  const entryMarker = join(root, `plugin-${counter}.entry-ran`);
  await writeFile(
    join(dir, "src", "manifest.ts"),
    options.manifestSource ?? manifestSource(manifestMarker, options.manifest)
  );
  await writeFile(join(dir, "src", "index.ts"), entrySource(entryMarker));
  return { dir, manifestMarker, entryMarker };
}

async function trustFile(entries: unknown, name = `trust-${++counter}.json`): Promise<string> {
  const path = join(root, name);
  await writeFile(path, typeof entries === "string" ? entries : JSON.stringify(entries));
  return path;
}

function trusting(...dirs: string[]): { version: 1; trustedPlugins: { id: string; dir: string }[] } {
  return { version: 1, trustedPlugins: dirs.map((dir) => ({ id: PLUGIN_ID, dir })) };
}

function request(pluginDir: string, configPath: string): TrustedPluginRequest {
  return {
    pluginId: PLUGIN_ID,
    pluginDir,
    entryFile: join("src", "index.ts"),
    manifestFile: join("src", "manifest.ts"),
    manifestExport: "nmrPredictorManifest",
    configPath
  };
}

function expectNothingRan(plugin: FakePlugin): void {
  expect(existsSync(plugin.manifestMarker)).toBe(false);
  expect(existsSync(plugin.entryMarker)).toBe(false);
}

describe("plugin allow-list", () => {
  it("refuses an untrusted directory without executing any of its files", async () => {
    const trusted = await fakePlugin();
    const untrusted = await fakePlugin();
    const config = await trustFile(trusting(trusted.dir));
    const attempt = loadTrustedPlugin(request(untrusted.dir, config));
    await expect(attempt).rejects.toThrow(PluginTrustError);
    await expect(attempt).rejects.toThrow(config);
    await expect(attempt).rejects.toThrow(realpathSync(untrusted.dir));
    // The message hands the owner the exact entry to add.
    await expect(attempt).rejects.toThrow(JSON.stringify({ id: PLUGIN_ID, dir: realpathSync(untrusted.dir) }));
    expectNothingRan(untrusted);
  });

  it("refuses when the trust file is missing, naming its path", async () => {
    const plugin = await fakePlugin();
    const missing = join(root, "no-such-dir", "trusted-plugins.json");
    const attempt = loadTrustedPlugin(request(plugin.dir, missing));
    await expect(attempt).rejects.toThrow(missing);
    await expect(attempt).rejects.toThrow(/does not exist/);
    expect(existsSync(missing)).toBe(false);
    expectNothingRan(plugin);
  });

  it("refuses a malformed trust file, naming it", async () => {
    const plugin = await fakePlugin();
    const cases: unknown[] = [
      "{ not json",
      { version: 2, trustedPlugins: [] },
      { trustedPlugins: [] },
      { version: 1, trustedPlugins: {} },
      { version: 1, trustedPlugins: [], extra: true },
      { version: 1, trustedPlugins: [{ id: PLUGIN_ID, dir: "relative/path" }] },
      { version: 1, trustedPlugins: [{ id: "", dir: plugin.dir }] },
      { version: 1, trustedPlugins: [{ id: PLUGIN_ID, dir: plugin.dir, trust: "all" }] },
      [{ id: PLUGIN_ID, dir: plugin.dir }]
    ];
    for (const contents of cases) {
      const config = await trustFile(contents);
      expect(() => readTrustedPlugins(config)).toThrow(PluginTrustError);
      expect(() => readTrustedPlugins(config)).toThrow(config);
      await expect(loadTrustedPlugin(request(plugin.dir, config))).rejects.toThrow(config);
    }
    expectNothingRan(plugin);
  });

  it("refuses a listed directory trusted under a different id", async () => {
    const plugin = await fakePlugin();
    const config = await trustFile({ version: 1, trustedPlugins: [{ id: "org.example.other", dir: plugin.dir }] });
    await expect(loadTrustedPlugin(request(plugin.dir, config))).rejects.toThrow(/not listed/);
    expectNothingRan(plugin);
  });

  it("accepts a trusted directory reached through a symlink, and a symlinked trust entry", async () => {
    const plugin = await fakePlugin();
    const link = join(root, `link-${++counter}`);
    await symlink(plugin.dir, link);

    const viaLink = await loadTrustedPlugin(request(link, await trustFile(trusting(plugin.dir))));
    expect(viaLink.location.dir).toBe(realpathSync(plugin.dir));
    expect(viaLink.module.loadedFrom).toBe("fake plugin");

    const listedAsLink = await loadTrustedPlugin(request(plugin.dir, await trustFile(trusting(link))));
    expect(listedAsLink.location.entryPath).toBe(realpathSync(join(plugin.dir, "src", "index.ts")));
  });

  it("refuses an entry symlinked outside the trusted directory without executing it", async () => {
    const plugin = await fakePlugin();
    const outsideDir = join(root, `outside-${++counter}`);
    await mkdir(outsideDir);
    const outsideMarker = join(root, `outside-${counter}.entry-ran`);
    const outsideEntry = join(outsideDir, "index.ts");
    await writeFile(outsideEntry, entrySource(outsideMarker));
    await rm(join(plugin.dir, "src", "index.ts"));
    await symlink(outsideEntry, join(plugin.dir, "src", "index.ts"));

    const attempt = loadTrustedPlugin(request(plugin.dir, await trustFile(trusting(plugin.dir))));
    await expect(attempt).rejects.toThrow(/outside the trusted directory/);
    expect(existsSync(outsideMarker)).toBe(false);
    expectNothingRan(plugin);
  });

  it("refuses a manifest symlinked outside the trusted directory without executing it", async () => {
    const plugin = await fakePlugin();
    const outsideDir = join(root, `outside-${++counter}`);
    await mkdir(outsideDir);
    const outsideManifest = join(outsideDir, "manifest.ts");
    await writeFile(outsideManifest, manifestSource(plugin.manifestMarker));
    await rm(join(plugin.dir, "src", "manifest.ts"));
    await symlink(outsideManifest, join(plugin.dir, "src", "manifest.ts"));

    await expect(loadTrustedPlugin(request(plugin.dir, await trustFile(trusting(plugin.dir)))))
      .rejects.toThrow(/outside the trusted directory/);
    expectNothingRan(plugin);
  });
});

describe("plugin manifest and permissions", () => {
  it("refuses a manifest with the wrong id before the entry executes", async () => {
    const plugin = await fakePlugin({ manifest: { id: "org.example.impostor" } });
    await expect(loadTrustedPlugin(request(plugin.dir, await trustFile(trusting(plugin.dir)))))
      .rejects.toThrow(/org\.example\.impostor/);
    expect(existsSync(plugin.manifestMarker)).toBe(true);
    expect(existsSync(plugin.entryMarker)).toBe(false);
  });

  it("refuses a manifest declaring native.execute before the entry executes", async () => {
    const plugin = await fakePlugin({ manifest: { permissions: ["selection.read", "native.execute"] } });
    await expect(loadTrustedPlugin(request(plugin.dir, await trustFile(trusting(plugin.dir)))))
      .rejects.toThrow(/native\.execute/);
    expect(existsSync(plugin.entryMarker)).toBe(false);
  });

  it("refuses every permission on the refused list", async () => {
    for (const permission of CLI_REFUSED_PLUGIN_PERMISSIONS) {
      const plugin = await fakePlugin({ manifest: { permissions: [permission] } });
      await expect(loadTrustedPlugin(request(plugin.dir, await trustFile(trusting(plugin.dir)))))
        .rejects.toThrow(permission);
      expect(existsSync(plugin.entryMarker)).toBe(false);
    }
  });

  it("refuses a manifest that plugin-host validation rejects", async () => {
    const plugin = await fakePlugin({ manifest: { permissions: ["no.such.permission"] } });
    await expect(loadTrustedPlugin(request(plugin.dir, await trustFile(trusting(plugin.dir)))))
      .rejects.toThrow(/is invalid/);
    expect(existsSync(plugin.entryMarker)).toBe(false);
  });

  it("refuses a manifest module without the expected export", async () => {
    const plugin = await fakePlugin({ manifestSource: "export const somethingElse = {};" });
    await expect(loadTrustedPlugin(request(plugin.dir, await trustFile(trusting(plugin.dir)))))
      .rejects.toThrow(/does not export nmrPredictorManifest/);
    expect(existsSync(plugin.entryMarker)).toBe(false);
  });

  it("loads a trusted plugin with a valid manifest", async () => {
    const plugin = await fakePlugin();
    const loaded = await loadTrustedPlugin(request(plugin.dir, await trustFile(trusting(plugin.dir))));
    expect(loaded.manifest.id).toBe(PLUGIN_ID);
    expect(loaded.manifest.permissions).toEqual(["selection.read", "analysis.write"]);
    expect(loaded.module.loadedFrom).toBe("fake plugin");
    expect(existsSync(plugin.manifestMarker)).toBe(true);
    expect(existsSync(plugin.entryMarker)).toBe(true);
  });
});

describe("default trust file location", () => {
  it("is derived from the OS account home, ignores a HOME/USERPROFILE hijack, and never trusts a trust file planted there", async () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const before = resolveDefaultTrustedPluginsPath();
    try {
      const attackerHome = await mkdtemp(join(root, "attacker-home-"));
      const attackerPlugin = await fakePlugin();
      await mkdir(join(attackerHome, ".config", "chemdraft"), { recursive: true });
      await writeFile(
        join(attackerHome, ".config", "chemdraft", "trusted-plugins.json"),
        JSON.stringify(trusting(attackerPlugin.dir))
      );

      process.env.HOME = attackerHome;
      process.env.USERPROFILE = attackerHome;

      const after = resolveDefaultTrustedPluginsPath();
      expect(after).toBe(before);
      expect(after).toBe(DEFAULT_TRUSTED_PLUGINS_PATH);
      expect(after).not.toBe(join(attackerHome, ".config", "chemdraft", "trusted-plugins.json"));

      // Whether or not a real trust file exists at the account's actual default location, it was
      // never written to list attackerPlugin, so loading through it must refuse.
      await expect(loadTrustedPlugin(request(attackerPlugin.dir, after))).rejects.toThrow(PluginTrustError);
      expectNothingRan(attackerPlugin);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it("fails closed, without throwing at the caller's usual message shape, when the account home lookup throws", () => {
    const lookup = (): { homedir: string } => {
      throw new Error("no passwd entry for this uid");
    };
    expect(() => resolveDefaultTrustedPluginsPath(lookup)).toThrow(PluginTrustError);
    expect(() => resolveDefaultTrustedPluginsPath(lookup)).toThrow(/account home/i);
    expect(() => resolveDefaultTrustedPluginsPath(lookup)).toThrow(/no passwd entry for this uid/);
  });

  it("fails closed when the account home lookup returns an empty homedir, never falling back", () => {
    const lookup = (): { homedir: string } => ({ homedir: "" });
    expect(() => resolveDefaultTrustedPluginsPath(lookup)).toThrow(PluginTrustError);
    expect(() => resolveDefaultTrustedPluginsPath(lookup)).toThrow(/account home/i);
  });
});
