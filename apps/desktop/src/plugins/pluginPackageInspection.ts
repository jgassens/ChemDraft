/**
 * Read, verify and describe a built plugin package without touching disk or the runtime (M36).
 *
 * Split out of `installPluginPackage.ts` so the same fail-closed gates can run outside the app: the
 * web-build staging script (`scripts/stage-web-plugins.mjs`) imports this module under Node. Keep it
 * free of runtime, Tauri, React and worker imports — only `@chemdraft/plugin-api` and the archive
 * reader — or that script stops loading. `installPluginPackage.ts` re-exports everything here.
 */

import {
  PluginApiVersion,
  isPluginApiVersionCompatible,
  parsePackagedPluginManifest,
  type PackagedPluginProvenance,
  type PluginManifest
} from "@chemdraft/plugin-api";

import { readPluginPackageArchive, sha256Hex, verifyPackageChecksum, type PluginPackageEntry } from "./pluginPackageArchive";

/** Stable codes for the install-level failures (the archive's own codes live in the archive module). */
export const PluginInstallErrorCodes = {
  ManifestMissing: "PLUGIN_INSTALL_MANIFEST_MISSING",
  ManifestInvalid: "PLUGIN_INSTALL_MANIFEST_INVALID",
  EntryMissing: "PLUGIN_INSTALL_ENTRY_MISSING",
  IncompatibleApiVersion: "PLUGIN_INSTALL_INCOMPATIBLE_API_VERSION",
  DuplicateId: "PLUGIN_INSTALL_DUPLICATE_ID",
  LoadFailed: "PLUGIN_INSTALL_LOAD_FAILED",
  UpdateIdMismatch: "PLUGIN_UPDATE_ID_MISMATCH",
  UpdateVersionNotNewer: "PLUGIN_UPDATE_VERSION_NOT_NEWER",
  UpdateStateChanged: "PLUGIN_UPDATE_STATE_CHANGED",
  UpdateFailed: "PLUGIN_UPDATE_FAILED",
  UninstallStorageDeleteFailed: "PLUGIN_UNINSTALL_STORAGE_DELETE_FAILED",
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
