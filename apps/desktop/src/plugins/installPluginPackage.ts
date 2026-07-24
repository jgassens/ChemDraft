/**
 * Install and uninstall a built plugin package (M36, ADR-0029 §6 as amended).
 *
 * ```text
 * pick zip ─▶ verify .sha256 + every entry's CRC ─▶ parse manifest ─▶ (UI displays permissions)
 *          ─▶ stage into app data ─▶ load from the app's OWN origin ─▶ handshake ─▶ register ─▶ record
 * ```
 *
 * ## Two ideas carry this module
 *
 * **1. Install proves the plugin runs before claiming it is installed.** Staging bytes is not installing:
 * a package can be perfectly well-formed on disk and still be unloadable (an incompatible `apiVersion`,
 * a protocol mismatch, an entry that throws on import). So install *awaits the worker handshake* and
 * rolls the staging directory back if anything fails. "Never half-loading" (the M36 acceptance
 * criterion) is not a promise about care; it is this rollback.
 *
 * **2. Every failure is fail-closed and loud.** Checksum mismatch, malformed/missing manifest, version
 * incompatibility, duplicate id, and traversal entries each refuse the install with a message that says
 * what was wrong. None of them leaves state behind.
 *
 * ## Permissive for capabilities this build actually implements, per ADR-0029 §3
 *
 * Available declared permissions are **auto-granted and merely displayed**. There is no consent gate here
 * and no signature check anywhere: the checksum is integrity only. A reserved permission with no safe
 * desktop broker is rejected rather than advertised as granted. The host still builds the capability
 * context strictly from the manifest, so an undeclared capability is simply never available to the worker
 * — that is enforcement by construction rather than by prompting.
 */

import {
  PluginApiVersion,
  isPluginApiVersionCompatible,
  parsePackagedPluginManifest,
  type PackagedPluginProvenance,
  type PluginManifest
} from "@chemdraft/plugin-api";

import {
  getUnavailableDesktopPluginPermissions,
  type DesktopPluginRuntime
} from "./createPluginRuntime";
import { installedPluginBaseUrl, installedPluginStagingDir } from "./installedPluginPaths";
import {
  createInstalledPluginRecord,
  loadInstalledPluginRecords,
  removeInstalledPluginRecord,
  upsertInstalledPluginRecord,
  type InstalledPluginRecord
} from "./installedPluginStore";
import { loadPackagedPlugin, type PackagedPluginDescriptor } from "./loadPackagedPlugin";
import type { BundledPluginDescriptor } from "./registerBundledPlugins";
import {
  PluginPackageError,
  PluginPackageErrorCodes,
  readPluginPackageArchive,
  sha256Hex,
  verifyPackageChecksum,
  type PluginPackageEntry
} from "./pluginPackageArchive";
import type { PluginStagingFs } from "./pluginStagingFs";

/** Stable codes for the install-level failures (the archive's own codes live in the archive module). */
export const PluginInstallErrorCodes = {
  ManifestMissing: "PLUGIN_INSTALL_MANIFEST_MISSING",
  ManifestInvalid: "PLUGIN_INSTALL_MANIFEST_INVALID",
  EntryMissing: "PLUGIN_INSTALL_ENTRY_MISSING",
  IncompatibleApiVersion: "PLUGIN_INSTALL_INCOMPATIBLE_API_VERSION",
  DuplicateId: "PLUGIN_INSTALL_DUPLICATE_ID",
  LoadFailed: "PLUGIN_INSTALL_LOAD_FAILED",
  Unsupported: "PLUGIN_INSTALL_UNSUPPORTED"
} as const;

export type PluginInstallErrorCode = (typeof PluginInstallErrorCodes)[keyof typeof PluginInstallErrorCodes];

export class PluginInstallError extends Error {
  readonly code: PluginInstallErrorCode;

  constructor(code: PluginInstallErrorCode, message: string) {
    super(message);
    this.name = "PluginInstallError";
    this.code = code;
  }
}

/**
 * What a package says about itself, proven readable but not yet staged.
 *
 * This is the value the install UI renders: it exists as a distinct step so the user can be *shown* the
 * plugin's name, version, description and declared permissions. Displaying them is the whole of ADR-0029
 * §3's transparency requirement — there is no accept/deny gate to attach to it.
 */
export interface PluginPackageInspection {
  manifest: PluginManifest;
  provenance: PackagedPluginProvenance;
  /** SHA-256 of the archive itself. */
  sourceChecksum: string;
  entries: readonly PluginPackageEntry[];
  /** Total unpacked size, for display. */
  unpackedBytes: number;
}

export const PACKAGE_MANIFEST_FILE = "manifest.json";

/**
 * Read, verify and describe a package without touching disk.
 *
 * Ordering matters and is deliberate: integrity is proven **before** the manifest is believed, and the
 * manifest is validated **before** anything is staged. A package that fails here has cost nothing.
 */
export async function inspectPluginPackage(options: {
  zipBytes: Uint8Array;
  /** Contents of the adjacent `.sha256`, when the picker found one. Integrity only (ADR-0029 §4). */
  sidecar?: string;
  hostApiVersion?: string;
}): Promise<PluginPackageInspection> {
  const { zipBytes, sidecar, hostApiVersion = PluginApiVersion } = options;

  // 1. Integrity. The sidecar covers the whole archive when present; `readPluginPackageArchive` then
  //    proves every entry against the archive's own CRC-32 regardless of whether a sidecar existed.
  if (sidecar !== undefined) {
    await verifyPackageChecksum(zipBytes, sidecar);
  }
  const sourceChecksum = await sha256Hex(zipBytes);
  const entries = await readPluginPackageArchive(zipBytes);

  // 2. The manifest, held to exactly the schema a bundled plugin faces.
  const manifestEntry = entries.find((entry) => entry.path === PACKAGE_MANIFEST_FILE);
  if (!manifestEntry) {
    throw new PluginInstallError(
      PluginInstallErrorCodes.ManifestMissing,
      `This package contains no ${PACKAGE_MANIFEST_FILE}, so it is not a ChemDraft plugin package.`
    );
  }

  let packaged;
  try {
    packaged = parsePackagedPluginManifest(JSON.parse(new TextDecoder().decode(manifestEntry.bytes)));
  } catch (cause: unknown) {
    throw new PluginInstallError(
      PluginInstallErrorCodes.ManifestInvalid,
      `This package's ${PACKAGE_MANIFEST_FILE} is not valid: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }

  // 3. The entry the manifest points at must actually be in the package.
  if (!entries.some((entry) => entry.path === packaged.manifest.entry)) {
    throw new PluginInstallError(
      PluginInstallErrorCodes.EntryMissing,
      `This package's manifest names "${packaged.manifest.entry}" as its entry point, but the package does ` +
        "not contain that file."
    );
  }

  // 4. Version compatibility, checked up front for a clear message and to avoid staging megabytes we are
  //    going to reject. The worker handshake re-checks this at load and is the authority — a manifest
  //    can claim anything, so this is the courtesy, not the guarantee.
  if (!isPluginApiVersionCompatible(packaged.manifest.apiVersion, hostApiVersion)) {
    throw new PluginInstallError(
      PluginInstallErrorCodes.IncompatibleApiVersion,
      `This plugin requires ChemDraft plugin API "${packaged.manifest.apiVersion}", but this build provides ` +
        `${hostApiVersion}. Refusing to install it.`
    );
  }

  return {
    manifest: packaged.manifest,
    provenance: packaged.provenance,
    sourceChecksum,
    entries,
    unpackedBytes: entries.reduce((total, entry) => total + entry.bytes.byteLength, 0)
  };
}

export interface InstallPluginPackageOptions {
  runtime: DesktopPluginRuntime;
  fs: PluginStagingFs;
  inspection: PluginPackageInspection;
  /** Origin the staged package is served from — the app's own. Defaults to the document's origin. */
  origin?: string;
  hostApiVersion?: string;
  /** Injectable for tests; production uses `loadPackagedPlugin`'s real module Worker. */
  createWorker?: (entryUrl: URL) => import("@chemdraft/plugin-api").PluginWorkerHandle;
  installedAt?: Date;
  /** Existing bundled descriptor with the same id, restored if the replacement transaction fails. */
  replaces?: BundledPluginDescriptor;
}

export interface InstalledPlugin {
  record: InstalledPluginRecord;
  descriptor: PackagedPluginDescriptor;
}

/**
 * Stage, load, register and record a package.
 *
 * Every step after staging is guarded by a rollback: if the plugin cannot load, the staging directory is
 * removed and no record is written, so a failed install is indistinguishable from one that never
 * happened.
 */
export async function installPluginPackage(options: InstallPluginPackageOptions): Promise<InstalledPlugin> {
  const { runtime, fs, inspection, hostApiVersion = PluginApiVersion, createWorker, installedAt } = options;
  const pluginId = inspection.manifest.id;

  assertInstallPermissionsAvailable(inspection.manifest);
  await assertInstallable(fs, pluginId);

  const stagingDir = installedPluginStagingDir(pluginId);
  // A reinstall of a *failed* install could leave a partial directory behind; start from nothing so the
  // staged tree always corresponds to exactly one package.
  await fs.removeDir(stagingDir);

  let descriptor: PackagedPluginDescriptor | undefined;
  let replacementRegistered = false;
  try {
    for (const entry of inspection.entries) {
      // `safeEntryPath` already refused traversal at read time. This is not that check repeated: it is
      // the guarantee restated at the boundary that actually writes, so a future caller that unpacks by
      // some other route cannot quietly lose it.
      await fs.writeFile(`${stagingDir}/${assertStagedPath(entry.path)}`, entry.bytes);
    }

    descriptor = await loadAndRegisterInstalledPlugin({
      runtime,
      manifest: inspection.manifest,
      origin: options.origin,
      hostApiVersion,
      createWorker,
      replaces: options.replaces
    });
    replacementRegistered = true;

    const record = createInstalledPluginRecord({
      id: pluginId,
      version: inspection.manifest.version,
      name: inspection.manifest.name,
      sourceChecksum: inspection.sourceChecksum,
      installedAt
    });
    await upsertInstalledPluginRecord(fs, record);
    return { record, descriptor };
  } catch (cause: unknown) {
    // Roll back to "never installed": drop the staged bytes and any registration we managed to make.
    await safelyRemove(fs, stagingDir);
    descriptor?.deactivate?.();
    try {
      if (replacementRegistered && runtime.host.getPlugin(pluginId)) {
        runtime.unregisterPlugin(pluginId);
      }
      if (replacementRegistered && options.replaces) {
        options.replaces.activate?.();
        runtime.registerPlugin(options.replaces.manifest, options.replaces.options);
      }
    } catch (rollbackFailure: unknown) {
      // Rollback itself failed, so the bundled plugin this install replaced is now registered
      // nowhere and silently disappears until the next reload. Nothing here can repair that, but it
      // must not be invisible: surface it alongside the install error being thrown below.
      runtime.panels.reportDiagnostic(
        "installed-plugin-rollback-failed",
        `Restoring the bundled plugin "${pluginId}" after a failed install did not succeed; it is unavailable until the app is reloaded: ${
          rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure)
        }`
      );
    }
    throw asInstallError(cause, pluginId);
  }
}

/**
 * Build a descriptor for an already-staged package, pointed at the app's own origin.
 *
 * Cheap and synchronous: the bridge creates its worker lazily, so a plugin that is merely *listed* — or
 * installed but disabled — costs nothing until something actually runs it. This is why a disabled
 * install can still be re-enabled: its descriptor (and therefore its real command handlers) exists all
 * along, and only the host registration comes and goes.
 */
function buildInstalledDescriptor(options: {
  manifest: PluginManifest;
  origin?: string;
  hostApiVersion: string;
  createWorker?: (entryUrl: URL) => import("@chemdraft/plugin-api").PluginWorkerHandle;
}): PackagedPluginDescriptor {
  const { manifest, hostApiVersion, createWorker } = options;
  const origin = options.origin ?? defaultOrigin();
  if (!origin) {
    throw new PluginInstallError(
      PluginInstallErrorCodes.Unsupported,
      "This environment has no document origin, so a staged plugin package cannot be served to a worker."
    );
  }

  return loadPackagedPlugin(
    {
      baseUrl: installedPluginBaseUrl(manifest.id, origin),
      // Re-serialized rather than passed through: `loadPackagedPlugin` re-parses, so the manifest that
      // governs the load is the package's own document, not a value this module could have edited.
      manifest: JSON.parse(JSON.stringify(toPackagedDocument(manifest, options)))
    },
    { hostApiVersion, createWorker }
  );
}

/**
 * Load an already-staged package from the app's own origin and register it.
 *
 * The `whenReady()` await is the load-bearing line: it forces M34's `ready` handshake now, so an
 * `apiVersion`/protocol-incompatible package fails *here* — before the plugin is registered and before
 * its commands ever reach a menu — instead of at first invocation.
 */
async function loadAndRegisterInstalledPlugin(options: {
  runtime: DesktopPluginRuntime;
  manifest: PluginManifest;
  origin?: string;
  hostApiVersion: string;
  createWorker?: (entryUrl: URL) => import("@chemdraft/plugin-api").PluginWorkerHandle;
  replaces?: BundledPluginDescriptor;
}): Promise<PackagedPluginDescriptor> {
  const descriptor = buildInstalledDescriptor(options);
  try {
    await descriptor.bridge.whenReady();
    registerReplacing(options.runtime, descriptor, options.replaces);
    return descriptor;
  } catch (error) {
    descriptor.deactivate?.();
    throw error;
  }
}

/**
 * Register a plugin, replacing any existing registration of the same id.
 *
 * That existing registration is the **bundled** copy: a package is built from a plugin whose id it
 * keeps, so installing `mass-fragment-demo-0.0.0.zip` on a build that already bundles the mass
 * analyzer is the normal case, not an error. The host keys plugins by id and refuses a duplicate
 * registration, so the installed copy takes the id over — and {@link uninstallPlugin} hands it back.
 *
 * The handshake has already passed by the time this runs, so the bundled copy is only dropped once the
 * replacement is known to work.
 */
function registerReplacing(
  runtime: DesktopPluginRuntime,
  descriptor: PackagedPluginDescriptor,
  replaces?: BundledPluginDescriptor
): void {
  // Through the runtime (not the bare host), so an installed plugin's toolset contributions are
  // staged — ui.toolbar gate, duplicate rejection, whole-plugin rollback — like any other plugin's.
  runtime.replacePlugin(descriptor.manifest.id, descriptor.manifest, descriptor.options);
  // Only tear the old worker down after the new registration has committed. `replacePlugin` restores
  // the previous registration if staging the replacement throws, so this ordering is the transaction.
  replaces?.deactivate?.();
}

/** Reload every recorded install at startup. */
export async function loadInstalledPlugins(options: {
  runtime: DesktopPluginRuntime;
  fs: PluginStagingFs;
  origin?: string;
  hostApiVersion?: string;
  disabledIds?: ReadonlySet<string>;
  createWorker?: (entryUrl: URL) => import("@chemdraft/plugin-api").PluginWorkerHandle;
  replacements?: readonly BundledPluginDescriptor[];
  signal?: AbortSignal;
}): Promise<{
  installed: readonly InstalledPluginCatalogEntry[];
  failures: readonly InstalledPluginFailure[];
}> {
  const { runtime, fs, hostApiVersion = PluginApiVersion, disabledIds = new Set<string>(), createWorker } = options;
  const records = await loadInstalledPluginRecords(fs);

  const installed: InstalledPluginCatalogEntry[] = [];
  const failures: InstalledPluginFailure[] = [];

  for (const record of records) {
    if (options.signal?.aborted) break;
    let descriptor: PackagedPluginDescriptor | undefined;
    let manifest: PluginManifest | undefined;
    try {
      manifest = await readStagedManifest(fs, record);
      const unavailablePermissions = getUnavailableDesktopPluginPermissions(manifest);
      if (unavailablePermissions.length > 0) {
        // Keep an older install visible and uninstallable, but never spawn or register its worker. This
        // is the migration-safe form of fail-closed: the package is not silently orphaned on disk.
        installed.push({ record, manifest, descriptor: undefined });
        failures.push({ record, message: unavailablePermissionMessage(manifest.id, unavailablePermissions) });
        continue;
      }
      // The descriptor is always built — it is lazy, so this spawns no worker — and only the *enabled*
      // ones are registered and handshaken. That is what keeps a disabled install listed and genuinely
      // re-enableable (the M32 rule, which installs inherit): re-enabling registers the descriptor's
      // real command handlers rather than an empty set.
      descriptor = buildInstalledDescriptor({
        manifest,
        origin: options.origin,
        hostApiVersion,
        createWorker
      });
      if (!disabledIds.has(record.id)) {
        await descriptor.bridge.whenReady();
        if (options.signal?.aborted) {
          descriptor.deactivate?.();
          break;
        }
        // Replaces the bundled copy of the same id, which `registerBundledPlugins` already registered
        // during synchronous startup — installs are reloaded afterwards and win.
        registerReplacing(
          runtime,
          descriptor,
          options.replacements?.find((candidate) => candidate.manifest.id === record.id)
        );
      }
      installed.push({ record, manifest, descriptor });
    } catch (cause: unknown) {
      descriptor?.deactivate?.();
      // One broken install must not stop the others, or the app, from starting.
      failures.push({ record, message: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  return { installed, failures };
}

function assertInstallPermissionsAvailable(manifest: PluginManifest): void {
  const unavailablePermissions = getUnavailableDesktopPluginPermissions(manifest);
  if (unavailablePermissions.length === 0) return;
  throw new PluginInstallError(
    PluginInstallErrorCodes.Unsupported,
    unavailablePermissionMessage(manifest.id, unavailablePermissions)
  );
}

function unavailablePermissionMessage(pluginId: string, permissions: readonly string[]): string {
  return (
    `Plugin "${pluginId}" declares ${permissions.join(", ")}, but ${
      permissions.length === 1 ? "that permission is" : "those permissions are"
    } reserved and unavailable in this ChemDraft build. The package was not loaded.`
  );
}

/** An installed plugin in the manager's catalog, whether currently enabled or not. */
export interface InstalledPluginCatalogEntry {
  record: InstalledPluginRecord;
  manifest: PluginManifest;
  /** Always present for a loadable install; its worker is spawned lazily on first use. */
  descriptor: PackagedPluginDescriptor | undefined;
}

export interface InstalledPluginFailure {
  record: InstalledPluginRecord;
  message: string;
}

/**
 * Uninstall: terminate, remove, unregister, forget.
 *
 * `bridge.terminate()` is M34's teardown, used rather than reinvented — it stops the worker thread
 * outright, so no capability call, panel push or late command result can arrive afterwards. The panel is
 * closed first, while the plugin is still registered, so its `onPanelClosed` hook can abort in-flight
 * work (the same ordering `applyEnabledPlugins` relies on for disable).
 */
export async function uninstallPlugin(options: {
  runtime: DesktopPluginRuntime;
  fs: PluginStagingFs;
  pluginId: string;
  descriptor?: PackagedPluginDescriptor;
  /** The bundled plugin this install replaced, if any — re-registered once the install is gone. */
  restores?: BundledPluginDescriptor;
  /** Honored when restoring: a bundled plugin the user disabled must not come back enabled. */
  disabledIds?: ReadonlySet<string>;
}): Promise<void> {
  const { runtime, fs, pluginId, descriptor, restores, disabledIds } = options;

  if (runtime.panels.getOpenPanel()?.pluginId === pluginId) {
    runtime.panels.closePanel();
  }
  for (const detached of runtime.panels.getDetachedPanels()) {
    if (detached.pluginId === pluginId) {
      runtime.panels.closeDetachedPanel(detached.pluginId, detached.panelId);
    }
  }
  descriptor?.deactivate?.();
  if (runtime.host.getPlugin(pluginId)) {
    runtime.unregisterPlugin(pluginId);
  }
  await fs.removeDir(installedPluginStagingDir(pluginId));
  await removeInstalledPluginRecord(fs, pluginId);

  // Hand the id back to the bundled copy the install had taken it from, so uninstalling a package
  // built from a bundled plugin returns the build to its shipped state rather than losing the plugin.
  if (restores && !disabledIds?.has(pluginId)) {
    restores.activate?.();
    runtime.registerPlugin(restores.manifest, restores.options);
  }
}

/**
 * Refuse a second copy of an id that is already installed.
 *
 * Note what this deliberately does *not* refuse: an id that is also **bundled**. A packaged plugin
 * legitimately shares its id with the compiled-in copy it was built from — `mass-fragment-demo-0.0.0.zip`
 * and this build's bundled mass analyzer are both `org.chemdraft.mass.fragment` — so refusing that
 * would make a package built from a bundled plugin uninstallable. Instead the install **replaces** the
 * bundled registration for as long as it is installed (see {@link installPluginPackage}), and uninstall
 * restores it.
 */
async function assertInstallable(fs: PluginStagingFs, pluginId: string): Promise<void> {
  const records = await loadInstalledPluginRecords(fs);
  const existing = records.find((record) => record.id === pluginId);
  if (existing) {
    throw new PluginInstallError(
      PluginInstallErrorCodes.DuplicateId,
      `"${pluginId}" is already installed (version ${existing.version}). Uninstall it first, then install ` +
        "this package."
    );
  }
}

async function readStagedManifest(fs: PluginStagingFs, record: InstalledPluginRecord): Promise<PluginManifest> {
  const raw = await fs.readTextFile(`${record.stagedPath}/${PACKAGE_MANIFEST_FILE}`);
  if (!raw) {
    throw new PluginInstallError(
      PluginInstallErrorCodes.ManifestMissing,
      `The staged files for "${record.id}" are missing or incomplete (no ${PACKAGE_MANIFEST_FILE}). ` +
        "Uninstall and reinstall it."
    );
  }
  return parsePackagedPluginManifest(JSON.parse(raw)).manifest;
}

/**
 * The manifest document `loadPackagedPlugin` re-parses.
 *
 * `PluginManifest` alone would fail its schema — a packaged manifest must carry a `chemdraftPackage`
 * block — so provenance is reattached here. It is descriptive only; nothing gates on it (ADR-0029 §4).
 */
function toPackagedDocument(manifest: PluginManifest, options: { hostApiVersion: string }): unknown {
  return {
    ...manifest,
    chemdraftPackage: {
      sdk: "@chemdraft/plugin-api",
      sdkVersion: options.hostApiVersion,
      sourceCommit: "staged",
      sourceTree: "clean",
      licenseFile: "LICENSE",
      packagedAt: new Date(0).toISOString()
    }
  };
}

/** Restate the traversal guarantee at the boundary that writes. */
function assertStagedPath(path: string): string {
  const segments = path.split("/");
  if (path.startsWith("/") || segments.some((segment) => segment === ".." || segment === "")) {
    throw new PluginPackageError(
      PluginPackageErrorCodes.UnsafeEntryPath,
      `Refusing to stage "${path}": it would write outside the plugin's directory.`
    );
  }
  return path;
}

async function safelyRemove(fs: PluginStagingFs, path: string): Promise<void> {
  try {
    await fs.removeDir(path);
  } catch {
    // The install already failed; a cleanup failure must not mask the real cause.
  }
}

function asInstallError(cause: unknown, pluginId: string): Error {
  if (cause instanceof PluginInstallError || cause instanceof PluginPackageError) {
    return cause;
  }
  return new PluginInstallError(
    PluginInstallErrorCodes.LoadFailed,
    `"${pluginId}" could not be loaded from its package, so it was not installed: ` +
      `${cause instanceof Error ? cause.message : String(cause)}`
  );
}

function defaultOrigin(): string | undefined {
  if (typeof window === "undefined" || !window.location?.origin || window.location.origin === "null") {
    return undefined;
  }
  return window.location.origin;
}
