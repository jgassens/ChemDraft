/**
 * Choose a plugin package from disk and describe it (M36).
 *
 * The native-picker half of install, kept apart from {@link installPluginPackage} so the orchestration
 * stays testable without a file dialog, and so the UI can *show* what a package declares before any of
 * it is staged.
 *
 * Per ADR-0029 section 4, the exact adjacent `<archive>.sha256` is optional: absence is not
 * suspicious and never blocks an install. Native code reads the chosen archive and that one sibling
 * without granting the webview sibling access. The checksum is integrity-only, and a present one
 * must verify. Every entry is proven against the archive's own CRC-32, with or without a sidecar.
 */

import { open } from "../nativeFileDialog";
import { invoke } from "@tauri-apps/api/core";

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

  const response = await invoke<ArrayBuffer>("read_plugin_package", { zipPath: selection });
  // Native framing: u32 little-endian UTF-8 checksum length (zero = absent), checksum, ZIP.
  if (!(response instanceof ArrayBuffer) || response.byteLength < 4) {
    throw new Error("Plugin package binary response is missing its checksum header.");
  }
  const checksumLength = new DataView(response).getUint32(0, true);
  if (checksumLength > 4096 || checksumLength > response.byteLength - 4) {
    throw new Error("Plugin package binary response has an invalid checksum length.");
  }
  const sidecar = checksumLength === 0 ? undefined : new TextDecoder("utf-8", { fatal: true })
    .decode(new Uint8Array(response, 4, checksumLength));
  const zipBytes = new Uint8Array(response, 4 + checksumLength);

  const inspection = await inspectPluginPackage({
    zipBytes,
    sidecar,
    hostApiVersion: options.hostApiVersion
  });

  return { inspection, sourcePath: selection, checksumVerified: sidecar !== undefined };
}
