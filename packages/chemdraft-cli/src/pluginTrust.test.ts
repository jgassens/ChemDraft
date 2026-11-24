import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, open, realpath, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  CLI_REFUSED_PLUGIN_PERMISSIONS,
  DEFAULT_TRUSTED_PLUGINS_PATH,
  PluginTrustError,
  loadTrustedPlugin,
  readTrustedPlugins,
  resolveDefaultTrustedPluginsPath,
  type TrustedPluginRequest
} from "./pluginTrust";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, open: vi.fn(fs.open), realpath: vi.fn(fs.realpath) };
});

const PLUGIN_ID = "org.chemdraft.nmr.predictor";

/**
 * Windows refuses file symlinks (EPERM) without Developer Mode or elevation. Directory links use a
 * junction there, which needs neither, so only the two file-symlink cases depend on this probe.
 */
const canSymlinkFiles = (() => {
  const probe = mkdtempSync(join(tmpdir(), "chemdraft-symlink-probe-"));
  try {
    writeFileSync(join(probe, "target"), "");
    symlinkSync(join(probe, "target"), join(probe, "link"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();
const directoryLinkType = process.platform === "win32" ? "junction" : "dir";

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
    const untrusted = await fakePlugin({ manifest: { permissions: ["model.load"] } });
    const config = await trustFile(trusting(trusted.dir));
    const attempt = loadTrustedPlugin(request(untrusted.dir, config));
    await expect(attempt).rejects.toThrow(PluginTrustError);
    await expect(attempt).rejects.toThrow(config);
    await expect(attempt).rejects.toThrow(realpathSync.native(untrusted.dir));
    // The message hands the owner the exact entry to add.
    await expect(attempt).rejects.toThrow(JSON.stringify({ id: PLUGIN_ID, dir: realpathSync.native(untrusted.dir) }));
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
    await symlink(plugin.dir, link, directoryLinkType);

    const viaLink = await loadTrustedPlugin(request(link, await trustFile(trusting(plugin.dir))));
    expect(viaLink.location.dir).toBe(realpathSync.native(plugin.dir));
    expect(viaLink.module.loadedFrom).toBe("fake plugin");

    const listedAsLink = await loadTrustedPlugin(request(plugin.dir, await trustFile(trusting(link))));
    expect(listedAsLink.location.entryPath).toBe(realpathSync.native(join(plugin.dir, "src", "index.ts")));
  });

  it.skipIf(!canSymlinkFiles)("refuses an entry symlinked outside the trusted directory without executing it", async () => {
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

  it.skipIf(!canSymlinkFiles)("refuses a manifest symlinked outside the trusted directory without executing it", async () => {
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

  it("refuses model.download even when the trusted plugin also declares model.load", async () => {
    const plugin = await fakePlugin({ manifest: { permissions: ["model.load", "model.download"] } });
    await expect(loadTrustedPlugin(request(plugin.dir, await trustFile(trusting(plugin.dir)))))
      .rejects.toThrow(/declares model\.download, which the ChemDraft CLI does not grant/);
    expect(existsSync(plugin.entryMarker)).toBe(false);
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
    expect(loaded.readBundledModel).toBeUndefined();
    expect(loaded.module.loadedFrom).toBe("fake plugin");
    expect(existsSync(plugin.manifestMarker)).toBe(true);
    expect(existsSync(plugin.entryMarker)).toBe(true);
  });
});

describe("bundled model reads", () => {
  const modelLimit = 256 * 1024 * 1024;

  afterEach(() => {
    vi.mocked(open).mockReset();
    vi.mocked(realpath).mockReset();
  });

  async function loadModelPlugin() {
    const plugin = await fakePlugin({ manifest: { permissions: ["model.load"] } });
    const loaded = await loadTrustedPlugin(request(plugin.dir, await trustFile(trusting(plugin.dir))));
    expect(loaded.module.loadedFrom).toBe("fake plugin");
    expect(loaded.readBundledModel).toBeTypeOf("function");
    return { dir: plugin.dir, readModel: loaded.readBundledModel! };
  }

  it("reads model bytes from the trusted checkout, including a symlink within it", async () => {
    const { dir, readModel } = await loadModelPlugin();
    await mkdir(join(dir, "models"));
    const bytes = Buffer.from([0, 1, 255]);
    await writeFile(join(dir, "models", "weights.bin"), bytes);
    await symlink(join(dir, "models"), join(dir, "internal-link"), directoryLinkType);

    expect(await readModel(join("models", "weights.bin"))).toEqual(bytes);
    expect(await readModel(join(dir, "internal-link", "weights.bin"))).toEqual(bytes);
  });

  it("refuses a parent directory replaced by an outside link after realpath", async () => {
    const { dir, readModel } = await loadModelPlugin();
    const models = join(dir, "models");
    const neighbor = `${dir}-other`;
    await mkdir(models);
    await mkdir(neighbor);
    await writeFile(join(models, "weights.bin"), "bundled model");
    await writeFile(join(neighbor, "weights.bin"), "outside model");

    vi.mocked(realpath).mockImplementationOnce(async (path) => {
      const resolved = realpathSync.native(path);
      await rename(models, join(dir, "original-models"));
      await symlink(neighbor, models, directoryLinkType);
      return resolved;
    });

    const requested = join("models", "weights.bin");
    await expect(readModel(requested)).rejects.toThrow(/weights\.bin.*model path changed during verification/);
  });

  it("refuses when the opened file has a different identity from the checked path", async () => {
    const { dir, readModel } = await loadModelPlugin();
    const { open: openFile } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const outsideModel = `${dir}-outside.bin`;
    await writeFile(join(dir, "weights.bin"), "bundled model");
    await writeFile(outsideModel, "outside model");
    vi.mocked(open).mockImplementationOnce((_path, flags) => openFile(outsideModel, flags));

    await expect(readModel("weights.bin")).rejects.toThrow(/weights\.bin.*identity could not be verified/);
  });

  it("refuses a model above the size limit before reading", async () => {
    const { dir, readModel } = await loadModelPlugin();
    const { open: openFile } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const modelPath = join(dir, "oversized.bin");
    await writeFile(modelPath, "");
    await truncate(modelPath, modelLimit + 1);
    vi.mocked(open).mockImplementationOnce(async (path, flags) => {
      const handle = await openFile(path, flags);
      vi.spyOn(handle, "createReadStream").mockImplementation(() => {
        throw new Error("An oversized file should be refused before starting a read.");
      });
      return handle;
    });

    await expect(readModel("oversized.bin")).rejects.toThrow(/oversized\.bin.*268435456 bytes \(256 MiB\)/);
  });

  it("refuses a model that grows beyond the size limit after the handle's size check", async () => {
    const { dir, readModel } = await loadModelPlugin();
    const { open: openFile } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const modelPath = join(dir, "growing.bin");
    await writeFile(modelPath, "bundled model");
    vi.mocked(open).mockImplementationOnce(async (path, flags) => {
      const handle = await openFile(path, flags);
      const createReadStream = handle.createReadStream.bind(handle);
      vi.spyOn(handle, "createReadStream").mockImplementation((options) => {
        truncateSync(modelPath, modelLimit + 1);
        return createReadStream(options);
      });
      return handle;
    });

    await expect(readModel("growing.bin")).rejects.toThrow(/growing\.bin.*268435456 bytes \(256 MiB\)/);
  });

  it("uses filesystem casing to distinguish a spelling alias from a sibling directory", async () => {
    const { dir, readModel } = await loadModelPlugin();
    await writeFile(join(dir, "weights.bin"), "bundled model");
    const alternateDir = join(dirname(dir), basename(dir).toUpperCase());
    const alternatePath = join(alternateDir, "weights.bin");
    if (existsSync(alternateDir)) {
      expect(Buffer.from(await readModel(alternatePath)).toString()).toBe("bundled model");
    } else {
      await mkdir(alternateDir);
      await writeFile(alternatePath, "outside model");
      await expect(readModel(alternatePath)).rejects.toThrow("inside the trusted plugin directory");
    }
  });

  it("refuses relative, absolute and symlink paths to another directory, plus URLs", async () => {
    const { dir, readModel } = await loadModelPlugin();
    const neighbor = `${dir}-other`;
    await mkdir(neighbor);
    const outsideModel = join(neighbor, "weights.bin");
    await writeFile(outsideModel, "outside model");
    await symlink(neighbor, join(dir, "external-link"), directoryLinkType);

    for (const modelPath of [
      relative(dir, outsideModel),
      outsideModel,
      join("external-link", "weights.bin"),
      "https://example.invalid/weights.bin",
      "file:///weights.bin"
    ]) {
      const attempt = readModel(modelPath);
      await expect(attempt).rejects.toThrow(JSON.stringify(modelPath));
      await expect(attempt).rejects.toThrow("model.load only reads bundled files inside the trusted plugin directory");
    }
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
