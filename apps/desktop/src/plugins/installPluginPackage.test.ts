/**
 * M36 acceptance: install, uninstall, persistence, and every fail-closed path (ADR-0029 §6 as amended).
 *
 * These drive the real installer, the real {@link PluginWorkerBridge} handshake, a real `PluginHost`, and
 * the real archive reader over an in-memory staging filesystem. Two things are stood in for, both
 * deliberately:
 *
 *  - **the staging filesystem**, because the real one is Tauri's — the whole reason it is a port;
 *  - **the worker**, because Node has no DOM `Worker`. The fake speaks the real protocol, so the
 *    handshake it answers is the real handshake.
 *
 * What these tests therefore cannot prove is the part that only a browser engine can answer: that the
 * staged package actually resolves from the app's own origin, nested worker and all. That is not left to
 * inference — it was driven by hand in the running app; see the report for the fetch-log evidence.
 */
import {
  PLUGIN_WORKER_PROTOCOL_VERSION,
  PluginApiVersion,
  type PluginManifest,
  type PluginWorkerHandle
} from "@chemdraft/plugin-api";
import { describe, expect, it, vi } from "vitest";

import { createZipFixture, sidecarFor, tamperByte } from "../testSupport/zipFixture";
import { createPluginRuntime, type DesktopPluginRuntime } from "./createPluginRuntime";
import { INSTALLED_PLUGINS_RECORD_FILE } from "./installedPluginPaths";
import {
  createInstalledPluginRecord,
  loadInstalledPluginRecords,
  saveInstalledPluginRecords
} from "./installedPluginStore";
import {
  PluginInstallError,
  PluginInstallErrorCodes,
  inspectPluginPackage,
  installPluginPackage,
  loadInstalledPlugins,
  pruneOrphanedPluginPackages,
  uninstallPlugin,
  updateInstalledPluginPackage
} from "./installPluginPackage";
import { PluginPackageError, PluginPackageErrorCodes } from "./pluginPackageArchive";
import type { PluginStagingFs } from "./pluginStagingFs";

const PLUGIN_ID = "org.chemdraft.test.installable";
const COMMAND_ID = "plugin.installable.run";

/** In-memory {@link PluginStagingFs}. Records writes so staging can be asserted, including its absence. */
class MemoryStagingFs implements PluginStagingFs {
  readonly files = new Map<string, Uint8Array>();
  failNextRename = false;
  readonly refusedRemovals = new Set<string>();

  async writeFile(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, bytes.slice());
  }
  async readTextFile(path: string): Promise<string | undefined> {
    const bytes = this.files.get(path);
    return bytes ? new TextDecoder().decode(bytes) : undefined;
  }
  async writeTextFile(path: string, text: string): Promise<void> {
    this.files.set(path, new TextEncoder().encode(text));
  }
  async rename(oldPath: string, newPath: string): Promise<void> {
    if (this.failNextRename) {
      this.failNextRename = false;
      throw new Error("Simulated atomic catalog commit failure");
    }
    const bytes = this.files.get(oldPath);
    if (!bytes) {
      throw new Error(`Missing source path ${oldPath}`);
    }
    this.files.set(newPath, bytes);
    this.files.delete(oldPath);
  }
  async readDirNames(path: string): Promise<readonly string[]> {
    const prefix = `${path}/`;
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf("/");
      // Only directories: a file directly inside `path` has no further separator.
      if (slash > 0) names.add(rest.slice(0, slash));
    }
    return [...names];
  }
  async removeDir(path: string): Promise<void> {
    if (this.refusedRemovals.has(path)) {
      throw new Error(`Simulated cleanup failure for ${path}`);
    }
    for (const key of [...this.files.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) {
        this.files.delete(key);
      }
    }
  }
  async mkdir(): Promise<void> {}
  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || [...this.files.keys()].some((key) => key.startsWith(`${path}/`));
  }

  pathsUnder(prefix: string): string[] {
    return [...this.files.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}

function manifestDocument(overrides: Partial<PluginManifest> = {}): Record<string, unknown> {
  const manifest: PluginManifest = {
    id: PLUGIN_ID,
    name: "Installable Test Plugin",
    version: "2.0.1",
    apiVersion: "^0.1.0",
    description: "A package used to verify runtime install and uninstall.",
    entry: "entry.js",
    permissions: ["ui.menu", "ui.panel"],
    contributes: {
      commands: [{ id: COMMAND_ID, title: "Run Installable", requiredPermissions: [], enabled: true }],
      menus: [
        {
          id: "menu.installable.run",
          title: "Run Installable",
          commandId: COMMAND_ID,
          location: "analyze",
          requiredPermissions: ["ui.menu"]
        }
      ],
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
    ...overrides
  };
  return {
    ...manifest,
    chemdraftPackage: {
      sdk: "@chemdraft/plugin-api",
      sdkVersion: "0.1.0",
      sourceCommit: "0fd3eceec674f207fe2651fe7a19f6438a55fb17",
      sourceTree: "clean",
      licenseFile: "LICENSE",
      packagedAt: "2026-07-16T14:07:19.768Z"
    }
  };
}

/** Build a realistic package: manifest + entry + a sibling the entry would resolve relatively. */
async function createPackage(
  options: { manifest?: unknown; omitManifest?: boolean; omitEntry?: boolean; extraEntries?: { path: string; content: string }[] } = {}
): Promise<Uint8Array> {
  const entries = [
    ...(options.omitManifest ? [] : [{ path: "manifest.json", content: JSON.stringify(options.manifest ?? manifestDocument()) }]),
    ...(options.omitEntry ? [] : [{ path: "entry.js", content: "export const entry = true;" }]),
    { path: "assets/worker.js", content: "export const nested = true;" },
    { path: "LICENSE", content: "Not finalized." },
    ...(options.extraEntries ?? [])
  ];
  return createZipFixture(entries);
}

interface FakeWorkerOptions {
  protocolVersion?: number;
  apiVersion?: string;
  /** Never send `ready`, to simulate an entry that fails to start. */
  silent?: boolean;
}

/**
 * A worker that speaks just enough of the real protocol to complete (or fail) the real handshake, and to
 * settle a command so an invocation can be traced back to *which* copy of a plugin is live.
 */
function createFakeWorker(options: FakeWorkerOptions = {}): { handle: PluginWorkerHandle; terminated: () => boolean } {
  let terminated = false;
  const listeners = new Map<string, Set<(event: { data: unknown }) => void>>();
  const emit = (data: unknown): void => {
    if (terminated) return;
    for (const listener of listeners.get("message") ?? []) {
      listener({ data });
    }
  };

  const handle: PluginWorkerHandle = {
    postMessage: (message: unknown) => {
      const request = message as { kind?: string; commandRequestId?: number };
      if (request.kind === "invokeCommand") {
        queueMicrotask(() =>
          emit({ kind: "commandSettled", commandRequestId: request.commandRequestId, ok: true, value: { from: "installed" } })
        );
      }
    },
    terminate: () => {
      terminated = true;
    },
    addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
      if (type === "message" && !options.silent) {
        queueMicrotask(() => {
          if (terminated) return;
          listener({
            data: {
              kind: "ready",
              protocolVersion: options.protocolVersion ?? PLUGIN_WORKER_PROTOCOL_VERSION,
              apiVersion: options.apiVersion ?? "^0.1.0"
            }
          });
        });
      }
    },
    removeEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
      listeners.get(type)?.delete(listener);
    }
  } as unknown as PluginWorkerHandle;

  return { handle, terminated: () => terminated };
}

function createRuntime(): DesktopPluginRuntime {
  return createPluginRuntime({
    getActiveDocument: () => undefined,
    getSelection: () => ({ objectIds: [], molecules: [] })
  });
}

const ORIGIN = "tauri://localhost";

async function installFixture(
  options: {
    fs?: MemoryStagingFs;
    runtime?: DesktopPluginRuntime;
    zip?: Uint8Array;
    worker?: FakeWorkerOptions;
    replaces?: ReturnType<typeof bundledCopy>;
  } = {}
) {
  const fs = options.fs ?? new MemoryStagingFs();
  const runtime = options.runtime ?? createRuntime();
  const zip = options.zip ?? (await createPackage());
  const inspection = await inspectPluginPackage({ zipBytes: zip, sidecar: await sidecarFor(zip) });
  const worker = createFakeWorker(options.worker);
  const result = await installPluginPackage({
    runtime,
    fs,
    inspection,
    origin: ORIGIN,
    createWorker: () => worker.handle,
    replaces: options.replaces as never
  });
  return { fs, runtime, result, worker };
}

async function updateInspection(
  version = "2.1.0",
  overrides: Partial<PluginManifest> = {}
): Promise<Awaited<ReturnType<typeof inspectPluginPackage>>> {
  const zip = await createPackage({
    manifest: manifestDocument({ version, ...overrides })
  });
  return inspectPluginPackage({ zipBytes: zip, sidecar: await sidecarFor(zip) });
}

function installedCatalogEntry(result: Awaited<ReturnType<typeof installPluginPackage>>) {
  return {
    record: result.record,
    manifest: result.descriptor.manifest,
    descriptor: result.descriptor
  };
}

/** A stand-in for the compiled-in copy a package is normally built from — same id, different handler.
 *  Its manifest carries no `chemdraftPackage` block: that provenance belongs to a *package*, and a
 *  bundled manifest is held to the strict schema that rejects it. */
function bundledCopy(): { manifest: PluginManifest; options: { commandHandlers: Record<string, () => Promise<unknown>> } } {
  const { chemdraftPackage: _provenance, ...manifest } = manifestDocument();
  return {
    manifest: JSON.parse(JSON.stringify(manifest)) as PluginManifest,
    options: { commandHandlers: { [COMMAND_ID]: async () => ({ ok: true, from: "bundled" }) } }
  };
}

describe("inspectPluginPackage", () => {
  it("describes what the package declares, so the UI can display it before anything is staged", async () => {
    const zip = await createPackage();

    const inspection = await inspectPluginPackage({ zipBytes: zip, sidecar: await sidecarFor(zip) });

    expect(inspection.manifest.id).toBe(PLUGIN_ID);
    expect(inspection.manifest.name).toBe("Installable Test Plugin");
    expect(inspection.manifest.version).toBe("2.0.1");
    expect(inspection.manifest.description).toBe("A package used to verify runtime install and uninstall.");
    // Criterion 2: the declared permissions are what the install UI displays.
    expect(inspection.manifest.permissions).toEqual(["ui.menu", "ui.panel"]);
    expect(inspection.provenance.sourceCommit).toBe("0fd3eceec674f207fe2651fe7a19f6438a55fb17");
    expect(inspection.sourceChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(inspection.unpackedBytes).toBeGreaterThan(0);
  });

  it("installs happily with no sidecar — it is optional and integrity-only", async () => {
    const zip = await createPackage();
    await expect(inspectPluginPackage({ zipBytes: zip })).resolves.toMatchObject({ manifest: { id: PLUGIN_ID } });
  });

  // Criterion 3
  it("refuses a tampered package whose sidecar no longer matches", async () => {
    const zip = await createPackage();
    const sidecar = await sidecarFor(zip);
    await expect(inspectPluginPackage({ zipBytes: tamperByte(zip, 45), sidecar })).rejects.toThrow(PluginPackageError);
  });

  it("refuses a package with no manifest.json", async () => {
    const zip = await createPackage({ omitManifest: true });
    await expect(inspectPluginPackage({ zipBytes: zip })).rejects.toMatchObject({
      code: PluginInstallErrorCodes.ManifestMissing
    });
  });

  it("refuses a malformed manifest, and one that fails the same schema a bundled plugin faces", async () => {
    const notJson = await createZipFixture([{ path: "manifest.json", content: "{ this is not json" }]);
    await expect(inspectPluginPackage({ zipBytes: notJson })).rejects.toMatchObject({
      code: PluginInstallErrorCodes.ManifestInvalid
    });

    // No provenance block: valid JSON, valid-ish manifest, still not a package.
    const noProvenance = await createZipFixture([{ path: "manifest.json", content: JSON.stringify({ id: PLUGIN_ID }) }]);
    await expect(inspectPluginPackage({ zipBytes: noProvenance })).rejects.toMatchObject({
      code: PluginInstallErrorCodes.ManifestInvalid
    });

    // A contribution requiring a permission the manifest never declared — a cross-field rule the
    // packaged path must not be able to smuggle past.
    const undeclared = await createPackage({
      manifest: manifestDocument({ permissions: ["ui.panel"] })
    });
    await expect(inspectPluginPackage({ zipBytes: undeclared })).rejects.toMatchObject({
      code: PluginInstallErrorCodes.ManifestInvalid
    });
  });

  it("refuses a manifest pointing at an entry the package does not contain", async () => {
    const zip = await createPackage({ omitEntry: true });
    await expect(inspectPluginPackage({ zipBytes: zip })).rejects.toMatchObject({
      code: PluginInstallErrorCodes.EntryMissing
    });
  });

  // Criterion 4 (cheap half: refused before a byte is staged).
  it("refuses an apiVersion-incompatible package up front", async () => {
    const zip = await createPackage({ manifest: manifestDocument({ apiVersion: "^9.0.0" }) });
    const error = await inspectPluginPackage({ zipBytes: zip }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PluginInstallError);
    expect((error as PluginInstallError).code).toBe(PluginInstallErrorCodes.IncompatibleApiVersion);
    expect((error as Error).message).toContain("^9.0.0");
  });
});

describe("installPluginPackage", () => {
  it("stages every file, loads the plugin, registers it, and records the install", async () => {
    const { fs, runtime, result } = await installFixture();

    // Staged flat, co-located — the layout the package's relative references depend on.
    expect(fs.pathsUnder(`installed-plugins/${PLUGIN_ID}/`)).toEqual([
      `installed-plugins/${PLUGIN_ID}/LICENSE`,
      `installed-plugins/${PLUGIN_ID}/assets/worker.js`,
      `installed-plugins/${PLUGIN_ID}/entry.js`,
      `installed-plugins/${PLUGIN_ID}/manifest.json`
    ]);

    // Registered live: its command and menu contribution are now real.
    expect(runtime.host.getPlugin(PLUGIN_ID)).toBeDefined();
    expect(runtime.host.commands.has(COMMAND_ID)).toBe(true);
    expect(runtime.host.listMenuContributions().some((menu) => menu.contribution.commandId === COMMAND_ID)).toBe(true);

    // Served from the app's own origin, under the reserved prefix, with a trailing slash so the
    // package's siblings resolve.
    expect(result.descriptor.entryUrl.toString()).toBe(`tauri://localhost/installed-plugins/${PLUGIN_ID}/entry.js`);

    expect(result.record).toMatchObject({
      id: PLUGIN_ID,
      version: "2.0.1",
      name: "Installable Test Plugin",
      stagedPath: `installed-plugins/${PLUGIN_ID}`
    });
    expect(result.record.sourceChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(await loadInstalledPluginRecords(fs)).toHaveLength(1);
  });

  it("auto-grants supported declared permissions with no consent gate", async () => {
    const { runtime } = await installFixture();

    // ADR-0029 §3: nothing was asked, and the manifest's permissions are simply in force.
    const registered = runtime.host.getPlugin(PLUGIN_ID);
    expect(registered?.manifest.permissions).toEqual(["ui.menu", "ui.panel"]);
  });

  it("refuses network.fetch before staging or starting a worker", async () => {
    const fs = new MemoryStagingFs();
    const runtime = createRuntime();
    const zip = await createPackage({ manifest: manifestDocument({ permissions: ["ui.menu", "network.fetch"] }) });
    const inspection = await inspectPluginPackage({ zipBytes: zip });
    let workerStarts = 0;

    await expect(
      installPluginPackage({
        runtime,
        fs,
        inspection,
        origin: ORIGIN,
        createWorker: () => {
          workerStarts += 1;
          return createFakeWorker().handle;
        }
      })
    ).rejects.toMatchObject({ code: PluginInstallErrorCodes.Unsupported });

    expect(workerStarts).toBe(0);
    expect(fs.pathsUnder(`installed-plugins/${PLUGIN_ID}/`)).toEqual([]);
    expect(runtime.host.getPlugin(PLUGIN_ID)).toBeUndefined();
    expect(runtime.host.hasPermission(PLUGIN_ID, "network.fetch")).toBe(false);
  });

  it("keeps a legacy network-fetch install visible for removal without loading its worker", async () => {
    const fs = new MemoryStagingFs();
    const runtime = createRuntime();
    const record = createInstalledPluginRecord({
      id: PLUGIN_ID,
      version: "2.0.1",
      name: "Legacy Network Plugin",
      sourceChecksum: "a".repeat(64),
      installedAt: new Date("2026-07-16T00:00:00.000Z")
    });
    await saveInstalledPluginRecords(fs, [record]);
    await fs.writeTextFile(
      `${record.stagedPath}/manifest.json`,
      JSON.stringify(manifestDocument({ permissions: ["ui.menu", "network.fetch"] }))
    );
    let workerStarts = 0;

    const loaded = await loadInstalledPlugins({
      runtime,
      fs,
      origin: ORIGIN,
      createWorker: () => {
        workerStarts += 1;
        return createFakeWorker().handle;
      }
    });

    expect(workerStarts).toBe(0);
    expect(loaded.installed).toHaveLength(1);
    expect(loaded.installed[0]?.descriptor).toBeUndefined();
    expect(loaded.failures[0]?.message).toMatch(/network\.fetch.*unavailable/i);
    expect(runtime.host.getPlugin(PLUGIN_ID)).toBeUndefined();
  });

  // Criterion 4 (the real half): a package that passes inspection but cannot load must not half-install.
  it("fails loudly and rolls back when the worker's protocol version is incompatible", async () => {
    const fs = new MemoryStagingFs();
    const runtime = createRuntime();

    await expect(installFixture({ fs, runtime, worker: { protocolVersion: 99 } })).rejects.toThrow(/protocol/i);

    // Nothing staged, nothing registered, nothing recorded: indistinguishable from never having tried.
    expect(fs.pathsUnder(`installed-plugins/${PLUGIN_ID}/`)).toEqual([]);
    expect(runtime.host.getPlugin(PLUGIN_ID)).toBeUndefined();
    expect(await loadInstalledPluginRecords(fs)).toEqual([]);
  });

  it("fails loudly and rolls back when the worker's apiVersion contradicts its manifest", async () => {
    const fs = new MemoryStagingFs();
    const runtime = createRuntime();

    // The manifest claimed ^0.1.0 and passed inspection; the worker then announces something else.
    await expect(installFixture({ fs, runtime, worker: { apiVersion: "^9.9.9" } })).rejects.toThrow();

    expect(fs.pathsUnder(`installed-plugins/${PLUGIN_ID}/`)).toEqual([]);
    expect(runtime.host.getPlugin(PLUGIN_ID)).toBeUndefined();
    expect(await loadInstalledPluginRecords(fs)).toEqual([]);
  });

  it("refuses installing the same id twice", async () => {
    const { fs, runtime } = await installFixture();

    const second = await installFixture({ fs, runtime }).catch((cause: unknown) => cause);
    expect(second).toBeInstanceOf(PluginInstallError);
    expect((second as PluginInstallError).code).toBe(PluginInstallErrorCodes.DuplicateId);
    expect((second as Error).message).toContain("already installed");

    // The first install is untouched by the refusal.
    expect(await loadInstalledPluginRecords(fs)).toHaveLength(1);
    expect(runtime.host.getPlugin(PLUGIN_ID)).toBeDefined();
  });

  /**
   * A package keeps the id of the plugin it was built from, so installing `mass-fragment-demo-0.0.0.zip`
   * on a build that already bundles the mass analyzer is the ordinary case — both are
   * `org.chemdraft.mass.fragment`. The install therefore *replaces* the bundled registration rather than
   * being refused, and uninstall gives the id back.
   */
  it("replaces a bundled plugin of the same id, and restores it on uninstall", async () => {
    const runtime = createRuntime();
    let deactivations = 0;
    let activations = 0;
    const bundled = {
      ...bundledCopy(),
      deactivate: () => {
        deactivations += 1;
      },
      activate: () => {
        activations += 1;
      }
    };
    runtime.host.registerPlugin(bundled.manifest, bundled.options);

    const { fs, result } = await installFixture({ runtime, replaces: bundled });

    // The installed copy now owns the id: invoking the command reaches the *packaged* plugin's worker,
    // not the bundled handler. One registration, not two.
    expect(runtime.host.listPlugins().filter((manifest) => manifest.id === PLUGIN_ID)).toHaveLength(1);
    expect(deactivations).toBe(1);
    await expect(runtime.host.invokeCommand(COMMAND_ID)).resolves.toMatchObject({ from: "installed" });

    await uninstallPlugin({
      runtime,
      fs,
      pluginId: PLUGIN_ID,
      descriptor: result.descriptor,
      restores: bundled as never
    });

    // The bundled copy is back and live again — the build returns to its shipped state.
    expect(runtime.host.getPlugin(PLUGIN_ID)).toBeDefined();
    expect(activations).toBe(1);
    await expect(runtime.host.invokeCommand(COMMAND_ID)).resolves.toMatchObject({ from: "bundled" });
  });

  it("does not resurrect a bundled plugin the user had disabled", async () => {
    const runtime = createRuntime();
    const bundled = bundledCopy();
    const { fs, result } = await installFixture({ runtime });

    await uninstallPlugin({
      runtime,
      fs,
      pluginId: PLUGIN_ID,
      descriptor: result.descriptor,
      restores: bundled as never,
      disabledIds: new Set([PLUGIN_ID])
    });

    expect(runtime.host.getPlugin(PLUGIN_ID)).toBeUndefined();
  });

  // Criterion 7
  it("cannot be made to write outside the staging directory", async () => {
    const zip = await createPackage({ extraEntries: [{ path: "../../../../evil.js", content: "pwned" }] });

    const error = await inspectPluginPackage({ zipBytes: zip }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PluginPackageError);
    expect((error as PluginPackageError).code).toBe(PluginPackageErrorCodes.UnsafeEntryPath);
  });

  it("replaces a partial staging directory left by an earlier failure", async () => {
    const fs = new MemoryStagingFs();
    // Debris from a previous, failed attempt.
    await fs.writeFile(`installed-plugins/${PLUGIN_ID}/stale.js`, new TextEncoder().encode("stale"));

    await installFixture({ fs });

    expect(fs.pathsUnder(`installed-plugins/${PLUGIN_ID}/`)).not.toContain(`installed-plugins/${PLUGIN_ID}/stale.js`);
  });

  it("reserves the checksum-addressed packages namespace before removing any staged bytes", async () => {
    const fs = new MemoryStagingFs();
    const sentinelPath = "installed-plugins/packages/existing-update/entry.js";
    await fs.writeFile(sentinelPath, new TextEncoder().encode("keep"));
    const zip = await createPackage({ manifest: manifestDocument({ id: "packages" }) });
    const inspection = await inspectPluginPackage({ zipBytes: zip, sidecar: await sidecarFor(zip) });

    await expect(
      installPluginPackage({
        runtime: createRuntime(),
        fs,
        inspection,
        origin: ORIGIN,
        createWorker: () => createFakeWorker().handle
      })
    ).rejects.toThrow(/unsafe installed-plugin id/i);

    expect(fs.files.has(sentinelPath)).toBe(true);
  });
});

describe("updateInstalledPluginPackage", () => {
  it("handshakes at an immutable path, swaps the enabled runtime, records it, then removes the old package", async () => {
    const { fs, runtime, result: installed, worker: oldWorker } = await installFixture();
    const inspection = await updateInspection();
    const candidateWorker = createFakeWorker();

    const updated = await updateInstalledPluginPackage({
      runtime,
      fs,
      current: installedCatalogEntry(installed),
      inspection,
      disabled: false,
      origin: ORIGIN,
      createWorker: () => candidateWorker.handle
    });

    expect(updated.record).toMatchObject({
      id: PLUGIN_ID,
      version: "2.1.0",
      sourceChecksum: inspection.sourceChecksum
    });
    expect(updated.record.stagedPath).toBe(`installed-plugins/packages/${inspection.sourceChecksum}`);
    expect(updated.descriptor.entryUrl.toString()).toBe(
      `tauri://localhost/installed-plugins/packages/${inspection.sourceChecksum}/entry.js`
    );
    expect(fs.pathsUnder(`${installed.record.stagedPath}/`)).toEqual([]);
    expect(fs.pathsUnder(`${updated.record.stagedPath}/`)).toContain(`${updated.record.stagedPath}/manifest.json`);
    expect(oldWorker.terminated()).toBe(true);
    expect(candidateWorker.terminated()).toBe(false);
    expect(runtime.host.getPlugin(PLUGIN_ID)?.manifest.version).toBe("2.1.0");
    expect(await loadInstalledPluginRecords(fs)).toEqual([updated.record]);
  });

  it("keeps the old runtime, record, and files when the candidate handshake fails", async () => {
    const { fs, runtime, result: installed, worker: oldWorker } = await installFixture();
    const inspection = await updateInspection();
    const candidateWorker = createFakeWorker({ protocolVersion: 99 });

    await expect(
      updateInstalledPluginPackage({
        runtime,
        fs,
        current: installedCatalogEntry(installed),
        inspection,
        disabled: false,
        origin: ORIGIN,
        createWorker: () => candidateWorker.handle
      })
    ).rejects.toThrow(/kept the installed version/i);

    expect(runtime.host.getPlugin(PLUGIN_ID)?.manifest.version).toBe("2.0.1");
    expect(oldWorker.terminated()).toBe(false);
    expect(candidateWorker.terminated()).toBe(true);
    expect(await loadInstalledPluginRecords(fs)).toEqual([installed.record]);
    expect(fs.pathsUnder(`${installed.record.stagedPath}/`)).toContain(`${installed.record.stagedPath}/manifest.json`);
    expect(fs.pathsUnder("installed-plugins/packages/")).toEqual([]);
  });

  it("refuses a different plugin id and a same or older version before staging", async () => {
    const { fs, runtime, result: installed } = await installFixture();
    const wrongId = await updateInspection("2.1.0", { id: "org.chemdraft.other" });
    const sameVersion = await updateInspection("2.0.1");

    await expect(
      updateInstalledPluginPackage({
        runtime,
        fs,
        current: installedCatalogEntry(installed),
        inspection: wrongId,
        disabled: false,
        origin: ORIGIN,
        createWorker: () => createFakeWorker().handle
      })
    ).rejects.toMatchObject({ code: PluginInstallErrorCodes.UpdateIdMismatch });
    await expect(
      updateInstalledPluginPackage({
        runtime,
        fs,
        current: installedCatalogEntry(installed),
        inspection: sameVersion,
        disabled: false,
        origin: ORIGIN,
        createWorker: () => createFakeWorker().handle
      })
    ).rejects.toMatchObject({ code: PluginInstallErrorCodes.UpdateVersionNotNewer });

    expect(fs.pathsUnder("installed-plugins/packages/")).toEqual([]);
    expect(await loadInstalledPluginRecords(fs)).toEqual([installed.record]);
  });

  it.each(["packages", "PACKAGES"])(
    "refuses to stage beneath a legacy reserved-path record named %s",
    async (reservedId) => {
      const { fs, runtime, result: installed } = await installFixture();
      const inspection = await updateInspection();
      await saveInstalledPluginRecords(fs, [
        installed.record,
        {
          ...installed.record,
          id: reservedId,
          name: "Legacy reserved-path collision",
          stagedPath: `installed-plugins/${reservedId}`
        }
      ]);

      await expect(
        updateInstalledPluginPackage({
          runtime,
          fs,
          current: installedCatalogEntry(installed),
          inspection,
          disabled: false,
          origin: ORIGIN,
          createWorker: () => createFakeWorker().handle
        })
      ).rejects.toMatchObject({ code: PluginInstallErrorCodes.UpdateStateChanged });

      expect(runtime.host.getPlugin(PLUGIN_ID)?.manifest.version).toBe("2.0.1");
      expect(fs.pathsUnder("installed-plugins/packages/")).toEqual([]);
    }
  );

  it("restores the still-live old runtime when the atomic record commit fails", async () => {
    const { fs, runtime, result: installed, worker: oldWorker } = await installFixture();
    const inspection = await updateInspection();
    const candidateWorker = createFakeWorker();
    fs.failNextRename = true;

    await expect(
      updateInstalledPluginPackage({
        runtime,
        fs,
        current: installedCatalogEntry(installed),
        inspection,
        disabled: false,
        origin: ORIGIN,
        createWorker: () => candidateWorker.handle
      })
    ).rejects.toThrow(/kept the installed version/i);

    expect(runtime.host.getPlugin(PLUGIN_ID)?.manifest.version).toBe("2.0.1");
    expect(oldWorker.terminated()).toBe(false);
    expect(candidateWorker.terminated()).toBe(true);
    expect(await loadInstalledPluginRecords(fs)).toEqual([installed.record]);
    expect(fs.pathsUnder("installed-plugins/packages/")).toEqual([]);
  });

  it("preserves disabled state, but leaves the updated descriptor re-enableable", async () => {
    const { fs, runtime, result: installed } = await installFixture();
    runtime.unregisterPlugin(PLUGIN_ID);
    installed.descriptor.deactivate?.();
    const inspection = await updateInspection();
    const workers: ReturnType<typeof createFakeWorker>[] = [];

    const updated = await updateInstalledPluginPackage({
      runtime,
      fs,
      current: installedCatalogEntry(installed),
      inspection,
      disabled: true,
      origin: ORIGIN,
      createWorker: () => {
        const worker = createFakeWorker();
        workers.push(worker);
        return worker.handle;
      }
    });

    expect(runtime.host.getPlugin(PLUGIN_ID)).toBeUndefined();
    expect(workers).toHaveLength(1);
    expect(workers[0]?.terminated()).toBe(true);
    expect((await loadInstalledPluginRecords(fs))[0]?.version).toBe("2.1.0");

    updated.descriptor.activate?.();
    runtime.registerPlugin(updated.descriptor.manifest, updated.descriptor.options);
    await expect(runtime.host.invokeCommand(COMMAND_ID)).resolves.toMatchObject({ from: "installed" });
    expect(workers).toHaveLength(2);
    expect(runtime.host.getPlugin(PLUGIN_ID)?.manifest.version).toBe("2.1.0");
  });

  it("commits successfully and reports a diagnostic when old-directory cleanup fails", async () => {
    const { fs, runtime, result: installed } = await installFixture();
    const inspection = await updateInspection();
    fs.refusedRemovals.add(installed.record.stagedPath);

    const updated = await updateInstalledPluginPackage({
      runtime,
      fs,
      current: installedCatalogEntry(installed),
      inspection,
      disabled: false,
      origin: ORIGIN,
      createWorker: () => createFakeWorker().handle
    });

    expect(updated.record.version).toBe("2.1.0");
    expect(await loadInstalledPluginRecords(fs)).toEqual([updated.record]);
    expect(runtime.panels.getDiagnostics().at(-1)).toMatchObject({
      code: "installed-plugin-update-cleanup-failed"
    });
  });

  it("keeps the committed package when post-commit reporting itself fails", async () => {
    const { fs, runtime, result: installed } = await installFixture();
    const inspection = await updateInspection();
    // Force the cleanup handler to run, then make the diagnostic channel throw from inside it. The
    // record already names the new directory at that point, so escaping to the failure path would
    // delete the live payload and leave the catalog pointing at nothing.
    fs.refusedRemovals.add(installed.record.stagedPath);
    vi.spyOn(runtime.panels, "reportDiagnostic").mockImplementation(() => {
      throw new Error("Diagnostic channel unavailable");
    });

    const updated = await updateInstalledPluginPackage({
      runtime,
      fs,
      current: installedCatalogEntry(installed),
      inspection,
      disabled: false,
      origin: ORIGIN,
      createWorker: () => createFakeWorker().handle
    });

    expect(updated.record.version).toBe("2.1.0");
    expect(await loadInstalledPluginRecords(fs)).toEqual([updated.record]);
    expect(fs.pathsUnder(`${updated.record.stagedPath}/`).length).toBeGreaterThan(0);
    expect(runtime.host.getPlugin(PLUGIN_ID)?.manifest.version).toBe("2.1.0");
    vi.restoreAllMocks();
  });

  it("refuses to update when the catalog cannot be read, before staging anything", async () => {
    const { fs, runtime, result: installed } = await installFixture();
    const inspection = await updateInspection();
    // A catalog this build cannot parse cannot be rewritten without dropping the records it could
    // not read. Failing here beats failing after the runtime has already been swapped.
    await fs.writeTextFile(INSTALLED_PLUGINS_RECORD_FILE, "{ truncated");

    await expect(
      updateInstalledPluginPackage({
        runtime,
        fs,
        current: installedCatalogEntry(installed),
        inspection,
        disabled: false,
        origin: ORIGIN,
        createWorker: () => createFakeWorker().handle
      })
    ).rejects.toThrow(/catalog could not be read/i);

    expect(runtime.host.getPlugin(PLUGIN_ID)?.manifest.version).toBe(installed.record.version);
    expect(fs.pathsUnder(`installed-plugins/packages/${inspection.sourceChecksum}/`)).toEqual([]);
  });
});

describe("uninstallPlugin path validation", () => {
  it("forgets a record whose recorded path is unsafe, without deleting anything", async () => {
    const { fs, runtime, result: installed, worker } = await installFixture();
    const removeDir = vi.spyOn(fs, "removeDir");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // An id like "packages" collides with the update namespace; older builds could install it, and
    // the path validator rejects it. Refusing the whole uninstall on that basis is what makes the
    // entry unremovable: the catalog keeps resurrecting a plugin the user asked to remove, with no
    // path out from the UI. So the record goes, and only the file deletion is skipped.
    await uninstallPlugin({
      runtime,
      fs,
      pluginId: PLUGIN_ID,
      record: { stagedPath: "installed-plugins/packages" },
      descriptor: installed.descriptor
    });

    expect(await loadInstalledPluginRecords(fs)).toEqual([]);
    expect(runtime.host.getPlugin(PLUGIN_ID)).toBeUndefined();
    expect(worker.terminated()).toBe(true);
    // Critically, the rejected path is never handed to removeDir — that namespace holds every other
    // plugin's package directory.
    expect(removeDir).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();

    removeDir.mockRestore();
    warn.mockRestore();
  });

  it("forgets the record even when the package directory cannot be deleted", async () => {
    const { fs, runtime, result: installed, worker } = await installFixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.refusedRemovals.add(installed.record.stagedPath);

    // A locked file or a denied scope must not strand the record either; the next launch's orphan
    // sweep retries the directory once nothing points at it.
    await uninstallPlugin({
      runtime,
      fs,
      pluginId: PLUGIN_ID,
      record: installed.record,
      descriptor: installed.descriptor
    });

    expect(await loadInstalledPluginRecords(fs)).toEqual([]);
    expect(runtime.host.getPlugin(PLUGIN_ID)).toBeUndefined();
    expect(worker.terminated()).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("pruneOrphanedPluginPackages", () => {
  const liveRecord = (stagedPath: string) => ({
    id: "org.example.live",
    version: "1.0.0",
    name: "Live",
    stagedPath,
    sourceChecksum: "a".repeat(64),
    installedAt: "2026-07-25T12:00:00.000Z"
  });

  async function treeWithBoth(): Promise<{ fs: MemoryStagingFs; live: string; orphan: string }> {
    const fs = new MemoryStagingFs();
    const live = `installed-plugins/packages/${"a".repeat(64)}`;
    const orphan = `installed-plugins/packages/${"b".repeat(64)}`;
    await fs.writeTextFile(`${live}/manifest.json`, "{}");
    await fs.writeTextFile(`${orphan}/manifest.json`, "{}");
    // A legacy per-id install and the catalog file live outside the swept subtree.
    await fs.writeTextFile("installed-plugins/org.example.legacy/manifest.json", "{}");
    return { fs, live, orphan };
  }

  it("removes only checksum-addressed directories no record points at", async () => {
    const { fs, live, orphan } = await treeWithBoth();

    const removed = await pruneOrphanedPluginPackages(fs, {
      status: "loaded",
      records: [liveRecord(live)]
    });

    expect(removed).toEqual([orphan]);
    expect(fs.pathsUnder(`${live}/`)).toContain(`${live}/manifest.json`);
    expect(fs.pathsUnder(`${orphan}/`)).toEqual([]);
    expect(fs.pathsUnder("installed-plugins/org.example.legacy/")).toHaveLength(1);
  });

  it("refuses to delete anything when the catalog could not be trusted", async () => {
    const { fs, live, orphan } = await treeWithBoth();

    // loadInstalledPluginRecords reports an unreadable, truncated, or partially-invalid catalog as
    // "no records". Sweeping on that would destroy a healthy install's payload.
    const removed = await pruneOrphanedPluginPackages(fs, { status: "unreadable", records: [] });

    expect(removed).toEqual([]);
    expect(fs.pathsUnder(`${live}/`)).toHaveLength(1);
    expect(fs.pathsUnder(`${orphan}/`)).toHaveLength(1);
  });

  it("sweeps a genuinely absent catalog and tolerates stored-path drift", async () => {
    const { fs, live, orphan } = await treeWithBoth();
    expect(await pruneOrphanedPluginPackages(fs, { status: "absent", records: [] }))
      .toEqual(expect.arrayContaining([live, orphan]));

    const drifted = await treeWithBoth();
    // A trailing separator must not make a live directory look orphaned.
    expect(await pruneOrphanedPluginPackages(drifted.fs, {
      status: "loaded",
      records: [liveRecord(`${drifted.live}/`)]
    })).toEqual([drifted.orphan]);
    expect(drifted.fs.pathsUnder(`${drifted.live}/`)).toHaveLength(1);
  });

  it("sweeps nothing when a record points at the packages root or above it", async () => {
    // An older build could install an id that resolves to the packages root itself. Such a record
    // names no single child, so every child looks orphaned — and the sweep would delete the whole
    // subtree, including that record's own payload.
    for (const path of ["installed-plugins/packages", "installed-plugins/packages/", "installed-plugins"]) {
      const { fs, live, orphan } = await treeWithBoth();
      expect(await pruneOrphanedPluginPackages(fs, { status: "loaded", records: [liveRecord(path)] })).toEqual([]);
      expect(fs.pathsUnder(`${live}/`)).toHaveLength(1);
      expect(fs.pathsUnder(`${orphan}/`)).toHaveLength(1);
    }
  });

  it("keeps a directory alive for a record nested below it, and matches case-insensitively", async () => {
    const nested = await treeWithBoth();
    // A record pointing inside a package directory still makes that directory live.
    expect(
      await pruneOrphanedPluginPackages(nested.fs, {
        status: "loaded",
        records: [liveRecord(`${nested.live}/inner`)]
      })
    ).toEqual([nested.orphan]);
    expect(nested.fs.pathsUnder(`${nested.live}/`)).toHaveLength(1);

    const cased = await treeWithBoth();
    // The record and the directory listing can disagree in case on the case-insensitive filesystems
    // this ships on; a missed match here deletes a live payload.
    expect(
      await pruneOrphanedPluginPackages(cased.fs, {
        status: "loaded",
        records: [liveRecord(cased.live.toUpperCase())]
      })
    ).toEqual([cased.orphan]);
    expect(cased.fs.pathsUnder(`${cased.live}/`)).toHaveLength(1);
  });

  it("never throws when a directory resists removal", async () => {
    const fs = new MemoryStagingFs();
    const stubborn = `installed-plugins/packages/${"c".repeat(64)}`;
    await fs.writeTextFile(`${stubborn}/manifest.json`, "{}");
    fs.refusedRemovals.add(stubborn);

    await expect(pruneOrphanedPluginPackages(fs, { status: "absent", records: [] })).resolves.toEqual([]);
    expect(fs.pathsUnder(`${stubborn}/`)).toHaveLength(1);
  });
});

describe("uninstallPlugin", () => {
  // Criterion 5
  it("terminates the worker, unregisters, deletes the staged files, and forgets the record", async () => {
    const { fs, runtime, result, worker } = await installFixture();
    expect(runtime.host.getPlugin(PLUGIN_ID)).toBeDefined();

    await uninstallPlugin({ runtime, fs, pluginId: PLUGIN_ID, descriptor: result.descriptor });

    expect(worker.terminated()).toBe(true);
    expect(runtime.host.getPlugin(PLUGIN_ID)).toBeUndefined();
    expect(runtime.host.commands.has(COMMAND_ID)).toBe(false);
    expect(runtime.host.listMenuContributions().some((menu) => menu.contribution.commandId === COMMAND_ID)).toBe(false);
    expect(fs.pathsUnder(`installed-plugins/${PLUGIN_ID}/`)).toEqual([]);
    expect(await loadInstalledPluginRecords(fs)).toEqual([]);
  });

  it("leaves the terminated bridge inert, so nothing can arrive from the plugin afterwards", async () => {
    const { fs, runtime, result } = await installFixture();

    await uninstallPlugin({ runtime, fs, pluginId: PLUGIN_ID, descriptor: result.descriptor });

    // M34's teardown contract, restated at the uninstall boundary: no further invocation is possible.
    await expect(result.descriptor.bridge.invokeCommand(COMMAND_ID, {} as never)).rejects.toThrow(/terminated/i);
  });

  it("is safe when the plugin is already disabled (not registered)", async () => {
    const { fs, runtime, result } = await installFixture();
    runtime.host.unregisterPlugin(PLUGIN_ID);

    await expect(
      uninstallPlugin({ runtime, fs, pluginId: PLUGIN_ID, descriptor: result.descriptor })
    ).resolves.toBeUndefined();
    expect(await loadInstalledPluginRecords(fs)).toEqual([]);
  });

  it("removes the exact checksum-addressed directory recorded by an updated install", async () => {
    const { fs, runtime, result: installed } = await installFixture();
    const inspection = await updateInspection();
    const updated = await updateInstalledPluginPackage({
      runtime,
      fs,
      current: installedCatalogEntry(installed),
      inspection,
      disabled: false,
      origin: ORIGIN,
      createWorker: () => createFakeWorker().handle
    });

    await uninstallPlugin({
      runtime,
      fs,
      pluginId: PLUGIN_ID,
      record: updated.record,
      descriptor: updated.descriptor
    });

    expect(fs.pathsUnder(`${updated.record.stagedPath}/`)).toEqual([]);
    expect(await loadInstalledPluginRecords(fs)).toEqual([]);
  });
});

describe("loadInstalledPlugins (persistence across restart)", () => {
  // Criterion 6
  it("reloads and re-registers an install into a fresh runtime", async () => {
    const { fs } = await installFixture();

    // A "restart": brand-new runtime, same staged files and records.
    const restarted = createRuntime();
    const { installed, failures } = await loadInstalledPlugins({
      runtime: restarted,
      fs,
      origin: ORIGIN,
      createWorker: () => createFakeWorker().handle
    });

    expect(failures).toEqual([]);
    expect(installed).toHaveLength(1);
    expect(installed[0].record.id).toBe(PLUGIN_ID);
    expect(installed[0].manifest.name).toBe("Installable Test Plugin");
    expect(restarted.host.getPlugin(PLUGIN_ID)).toBeDefined();
    expect(restarted.host.commands.has(COMMAND_ID)).toBe(true);
  });

  it("reloads a checksum-addressed updated package from the record's exact path", async () => {
    const { fs, runtime, result: installed } = await installFixture();
    const inspection = await updateInspection();
    const updated = await updateInstalledPluginPackage({
      runtime,
      fs,
      current: installedCatalogEntry(installed),
      inspection,
      disabled: false,
      origin: ORIGIN,
      createWorker: () => createFakeWorker().handle
    });
    const restarted = createRuntime();

    const { installed: reloaded, failures } = await loadInstalledPlugins({
      runtime: restarted,
      fs,
      origin: ORIGIN,
      createWorker: () => createFakeWorker().handle
    });

    expect(failures).toEqual([]);
    expect(reloaded[0]?.record).toEqual(updated.record);
    expect(reloaded[0]?.descriptor?.entryUrl.toString()).toBe(
      `tauri://localhost/installed-plugins/packages/${inspection.sourceChecksum}/entry.js`
    );
    expect(restarted.host.getPlugin(PLUGIN_ID)?.manifest.version).toBe("2.1.0");
  });

  it("keeps an installed-but-disabled plugin listed and re-enableable, without spawning its worker", async () => {
    const { fs } = await installFixture();
    const restarted = createRuntime();
    let workersCreated = 0;

    const { installed } = await loadInstalledPlugins({
      runtime: restarted,
      fs,
      origin: ORIGIN,
      disabledIds: new Set([PLUGIN_ID]),
      createWorker: () => {
        workersCreated += 1;
        return createFakeWorker().handle;
      }
    });

    // Listed, but not live — and it cost nothing to list.
    expect(installed).toHaveLength(1);
    expect(restarted.host.getPlugin(PLUGIN_ID)).toBeUndefined();
    expect(workersCreated).toBe(0);

    // Re-enableable *with its real handlers*: the descriptor existed all along.
    const descriptor = installed[0].descriptor;
    expect(descriptor).toBeDefined();
    expect(Object.keys(descriptor!.options.commandHandlers ?? {})).toEqual([COMMAND_ID]);
    restarted.host.registerPlugin(descriptor!.manifest, descriptor!.options);
    expect(restarted.host.getPlugin(PLUGIN_ID)).toBeDefined();
  });

  it("reports a broken install instead of throwing, so one bad plugin cannot stop startup", async () => {
    const { fs } = await installFixture();
    // The staged files vanished (a manual delete, a failed sync) but the record survives.
    await fs.removeDir(`installed-plugins/${PLUGIN_ID}`);

    const restarted = createRuntime();
    const { installed, failures } = await loadInstalledPlugins({
      runtime: restarted,
      fs,
      origin: ORIGIN,
      createWorker: () => createFakeWorker().handle
    });

    expect(installed).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0].record.id).toBe(PLUGIN_ID);
    expect(failures[0].message).toMatch(/missing or incomplete/i);
  });

  it("treats a corrupt or absent records file as 'nothing installed' rather than failing to start", async () => {
    const fs = new MemoryStagingFs();
    expect(await loadInstalledPluginRecords(fs)).toEqual([]);

    await fs.writeTextFile(INSTALLED_PLUGINS_RECORD_FILE, "{ not json");
    expect(await loadInstalledPluginRecords(fs)).toEqual([]);

    await fs.writeTextFile(INSTALLED_PLUGINS_RECORD_FILE, JSON.stringify({ version: 1, plugins: [{ id: "x" }] }));
    expect(await loadInstalledPluginRecords(fs)).toEqual([]);
  });

  it("keeps installs and the disabled-id preference as independent stores", async () => {
    const { fs } = await installFixture();

    // The records file knows nothing about enablement; that is localStorage's job (M32).
    const raw = await fs.readTextFile(INSTALLED_PLUGINS_RECORD_FILE);
    expect(raw).toBeDefined();
    expect(raw).not.toContain("disabled");
    expect(JSON.parse(raw!).plugins[0]).toMatchObject({ id: PLUGIN_ID, version: "2.0.1" });
  });
});
