import { beforeEach, describe, expect, it, vi } from "vitest";
import { PluginApiVersion } from "@chemdraft/plugin-api";

import { createZipFixture, sidecarFor } from "../testSupport/zipFixture";
import { pickPluginPackage } from "./pickPluginPackage";

const mocks = vi.hoisted(() => ({ open: vi.fn(), invoke: vi.fn(), fs: vi.fn() }));
vi.mock("../nativeFileDialog", () => ({ open: mocks.open }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
// Regression: sibling existence/read attempts via the webview are forbidden, even when the ZIP was
// chosen. The native command must read both files without extending those filesystem permissions.
vi.mock("@tauri-apps/plugin-fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/plugin-fs")>(),
  readFile: mocks.fs,
  readTextFile: mocks.fs,
  exists: mocks.fs
}));

async function packageBytes() {
  return createZipFixture([
    { path: "manifest.json", content: JSON.stringify({
      id: "org.chemdraft.mass-fragment-demo",
      name: "Mass Fragment Demo",
      version: "0.0.0",
      apiVersion: `^${PluginApiVersion}`,
      entry: "entry.js",
      permissions: [],
      chemdraftPackage: {
        sdk: "@chemdraft/plugin-api",
        sdkVersion: PluginApiVersion,
        sourceCommit: "0fd3eceec674f207fe2651fe7a19f6438a55fb17",
        sourceTree: "clean",
        licenseFile: "LICENSE",
        packagedAt: "2026-10-14T12:00:00.000Z"
      }
    }) },
    { path: "entry.js", content: "export const plugin = {};" }
  ]);
}

function binaryResponse(zip: Uint8Array, sidecar?: string): ArrayBuffer {
  const checksum = new TextEncoder().encode(sidecar ?? "");
  const bytes = new Uint8Array(4 + checksum.length + zip.length);
  new DataView(bytes.buffer).setUint32(0, checksum.length, true);
  bytes.set(checksum, 4);
  bytes.set(zip, 4 + checksum.length);
  return bytes.buffer;
}

describe("pickPluginPackage native sibling checksum flow", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.fs.mockRejectedValue(new Error("forbidden path: mass-fragment-demo-0.0.0.zip.sha256"));
  });

  it.each([
    "C:\\Users\\chemist\\Downloads\\mass-fragment-demo-0.0.0.zip",
    "/Volumes/Plugins/mass-fragment-demo-0.0.0.zip"
  ])("inspects a chosen package with sibling checksum and no webview sibling access: %s", async (path) => {
    const zip = await packageBytes();
    mocks.open.mockResolvedValue(path);
    mocks.invoke.mockResolvedValue(binaryResponse(zip, await sidecarFor(zip)));

    const picked = await pickPluginPackage();

    expect(picked).toMatchObject({ sourcePath: path, checksumVerified: true,
      inspection: { manifest: { name: "Mass Fragment Demo", version: "0.0.0" } } });
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("read_plugin_package", { zipPath: path });
    expect(mocks.fs).not.toHaveBeenCalled();
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ multiple: false, directory: false,
      filters: [{ name: "ChemDraft plugin package", extensions: ["zip"] }] }));
  });

  it("installs a package without a sibling checksum and reports it unverified", async () => {
    mocks.open.mockResolvedValue("/chosen/plugin.zip");
    mocks.invoke.mockResolvedValue(binaryResponse(await packageBytes()));
    expect(await pickPluginPackage()).toMatchObject({ checksumVerified: false,
      inspection: { manifest: { name: "Mass Fragment Demo" } } });
    expect(mocks.fs).not.toHaveBeenCalled();
  });

  it.each([new ArrayBuffer(3), new Uint8Array([1, 16, 0, 0]).buffer])(
    "refuses malformed binary framing", async (response) => {
      mocks.open.mockResolvedValue("/chosen/plugin.zip");
      mocks.invoke.mockResolvedValue(response);
      await expect(pickPluginPackage()).rejects.toThrow(/binary response/);
    }
  );

  it("cancellation reads nothing", async () => {
    mocks.open.mockResolvedValue(null);
    expect(await pickPluginPackage()).toBeUndefined();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.fs).not.toHaveBeenCalled();
  });

  it.each([
    "Cannot open Plugin package checksum: Permission denied",
    "Plugin package checksum does not contain a SHA-256 digest",
    "Plugin package checksum exceeds the 4096-byte limit",
    "Plugin package does not match its .sha256 checksum",
    "Plugin package checksum must be a regular file, not a symlink or reparse point",
    "Plugin package checksum names a different file",
    "Plugin package path was not granted by the native file dialog"
  ])("propagates native refusal: %s", async (message) => {
    mocks.open.mockResolvedValue("/chosen/plugin.zip");
    mocks.invoke.mockRejectedValue(message);
    await expect(pickPluginPackage()).rejects.toBe(message);
    expect(mocks.fs).not.toHaveBeenCalled();
  });

  it("still independently rejects mismatched checksums returned by native code", async () => {
    mocks.open.mockResolvedValue("/chosen/plugin.zip");
    mocks.invoke.mockResolvedValue(binaryResponse(await packageBytes(), "0".repeat(64)));
    await expect(pickPluginPackage()).rejects.toThrow(/does not match its .sha256 checksum/);
  });

  it("still independently rejects malformed checksums returned by native code", async () => {
    mocks.open.mockResolvedValue("/chosen/plugin.zip");
    mocks.invoke.mockResolvedValue(binaryResponse(await packageBytes(), "not a digest"));
    await expect(pickPluginPackage()).rejects.toThrow(/SHA-256/);
  });

  it("keeps manifest and API validation after native reading", async () => {
    mocks.open.mockResolvedValue("/chosen/plugin.zip");
    const zip = await packageBytes();
    mocks.invoke.mockResolvedValue(binaryResponse(zip, await sidecarFor(zip)));
    await expect(pickPluginPackage({ hostApiVersion: "0.2.0" })).rejects.toThrow(/requires ChemDraft plugin API/);
  });
});
