/**
 * Choose a plugin package from disk and describe it (M36).
 *
 * The native-picker half of install, kept apart from {@link installPluginPackage} so the orchestration
 * stays testable without a file dialog, and so the UI can *show* what a package declares before any of
 * it is staged.
 *
 * The `.sha256` sidecar is read when it sits next to the archive, as `plugin:package` writes it. It is
 * **optional and integrity-only** (ADR-0029 §4): its absence is not suspicious and never blocks an
 * install, because every entry is proven against the archive's own CRC-32 regardless. Nothing here
 * establishes authenticity, and nothing here is a trust gate.
 */

import { open } from "@tauri-apps/plugin-dialog";
import { readFile, readTextFile, exists } from "@tauri-apps/plugin-fs";

import { inspectPluginPackage, type PluginPackageInspection } from "./installPluginPackage";

/** A package the user picked, described and ready to install. */
export interface PickedPluginPackage {
  inspection: PluginPackageInspection;
  /** Absolute path the archive was read from, for display. */
  sourcePath: string;
  /** Whether a `.sha256` sidecar was found and verified. */
  checksumVerified: boolean;
}

/**
 * Show the native picker, then read and verify whatever was chosen.
 *
 * @returns `undefined` when the user cancelled — which is not an error and must not be reported as one.
 */
export async function pickPluginPackage(options: { hostApiVersion?: string } = {}): Promise<PickedPluginPackage | undefined> {
  const selection = await open({
    multiple: false,
    directory: false,
    title: "Install ChemDraft plugin package",
    filters: [{ name: "ChemDraft plugin package", extensions: ["zip"] }]
  });
  if (typeof selection !== "string") {
    return undefined;
  }

  const zipBytes = await readFile(selection);
  const sidecarPath = `${selection}.sha256`;
  const sidecar = (await exists(sidecarPath)) ? await readTextFile(sidecarPath) : undefined;

  const inspection = await inspectPluginPackage({
    zipBytes,
    sidecar,
    hostApiVersion: options.hostApiVersion
  });

  return { inspection, sourcePath: selection, checksumVerified: sidecar !== undefined };
}
