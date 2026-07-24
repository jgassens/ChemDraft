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
import { describe, expect, it } from "vitest";

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
  uninstallPlugin
} from "./installPluginPackage";
import { PluginPackageError, PluginPackageErrorCodes } from "./pluginPackageArchive";
import type { PluginStagingFs } from "./pluginStagingFs";

const PLUGIN_ID = "org.chemdraft.test.installable";
const COMMAND_ID = "plugin.installable.run";

/** In-memory {@link PluginStagingFs}. Records writes so staging can be asserted, including its absence. */
class MemoryStagingFs implements PluginStagingFs {
  readonly files = new Map<string, Uint8Array>();

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
  async removeDir(path: string): Promise<void> {
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
