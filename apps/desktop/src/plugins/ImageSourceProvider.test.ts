import { PluginImageMaxBytes, PluginImageMaxDimension } from "@chemdraft/plugin-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn(), stat: vi.fn() }));
vi.mock("./pluginStagingFs", () => ({ isTauriHost: () => true }));

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile, stat } from "@tauri-apps/plugin-fs";

import { fileImageSourceProvider, ImageSourceError, screenRegionImageSourceProvider } from "./ImageSourceProvider";

// A 3×2 PNG header: signature, then the IHDR chunk carrying width and height.
const png = pngHeader(3, 2);

function pngHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 0, 0, 0, 0, 0, 8,
    6, 0, 0, 0
  ]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe("fileImageSourceProvider", () => {
  beforeEach(() => {
    vi.mocked(open).mockReset().mockResolvedValue("/Users/me/Pictures/huge.png");
    vi.mocked(readFile).mockReset().mockResolvedValue(png);
    vi.mocked(stat).mockReset();
  });

  it("refuses an oversized file from its size alone, without reading it", async () => {
    vi.mocked(stat).mockResolvedValue({ size: PluginImageMaxBytes + 1 } as Awaited<ReturnType<typeof stat>>);

    const acquired = fileImageSourceProvider.acquire(new AbortController().signal);
    await expect(acquired).rejects.toBeInstanceOf(ImageSourceError);
    await expect(acquired).rejects.toThrow(/at most 26214400 bytes \(25 MB\)/);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("reads a file whose measured size is within the limit", async () => {
    vi.mocked(stat).mockResolvedValue({ size: png.byteLength } as Awaited<ReturnType<typeof stat>>);

    await expect(fileImageSourceProvider.acquire(new AbortController().signal)).resolves.toMatchObject({
      mediaType: "image/png",
      width: 3,
      height: 2,
      source: "file",
      fileName: "huge.png"
    });
    expect(stat).toHaveBeenCalledWith("/Users/me/Pictures/huge.png");
  });

  it("still enforces the limit after reading when the size cannot be measured first", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(stat).mockRejectedValue(new Error("fs.stat not allowed"));
    vi.mocked(readFile).mockResolvedValue(new Uint8Array(PluginImageMaxBytes + 1));

    await expect(fileImageSourceProvider.acquire(new AbortController().signal)).rejects.toThrow(
      /images must be at most/
    );
  });

  it("refuses an image wider or taller than the per-side limit, so the user can pick another", async () => {
    vi.mocked(stat).mockResolvedValue({ size: 29 } as Awaited<ReturnType<typeof stat>>);
    vi.mocked(readFile).mockResolvedValue(pngHeader(PluginImageMaxDimension + 1, 10));

    const acquired = fileImageSourceProvider.acquire(new AbortController().signal);
    await expect(acquired).rejects.toBeInstanceOf(ImageSourceError);
    await expect(acquired).rejects.toThrow(/8193 × 10 pixels; images must be at most 8192 pixels on each side/);
  });

  it("refuses an image with a zero dimension", async () => {
    vi.mocked(stat).mockResolvedValue({ size: 29 } as Awaited<ReturnType<typeof stat>>);
    vi.mocked(readFile).mockResolvedValue(pngHeader(0, 10));

    await expect(fileImageSourceProvider.acquire(new AbortController().signal)).rejects.toThrow(
      /has no usable width and height/
    );
  });

  it("accepts an image exactly at the per-side limit", async () => {
    vi.mocked(stat).mockResolvedValue({ size: 29 } as Awaited<ReturnType<typeof stat>>);
    vi.mocked(readFile).mockResolvedValue(pngHeader(PluginImageMaxDimension, PluginImageMaxDimension));

    await expect(fileImageSourceProvider.acquire(new AbortController().signal)).resolves.toMatchObject({
      width: PluginImageMaxDimension,
      height: PluginImageMaxDimension
    });
  });
});

describe("screenRegionImageSourceProvider", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("refuses a capture taller than the per-side limit", async () => {
    vi.mocked(invoke).mockResolvedValue({ status: "captured", bytes: [1, 2, 3], width: 10, height: 9000 });

    const acquired = screenRegionImageSourceProvider.acquire(new AbortController().signal);
    await expect(acquired).rejects.toBeInstanceOf(ImageSourceError);
    await expect(acquired).rejects.toThrow(/captured region is 10 × 9000 pixels/);
  });

  it("refuses a capture larger than the byte limit", async () => {
    vi.mocked(invoke).mockResolvedValue({
      status: "captured",
      bytes: new Array<number>(PluginImageMaxBytes + 1).fill(0),
      width: 10,
      height: 10
    });

    await expect(screenRegionImageSourceProvider.acquire(new AbortController().signal)).rejects.toThrow(
      /images must be at most 26214400 bytes/
    );
  });

  it("returns a capture within the limits", async () => {
    vi.mocked(invoke).mockResolvedValue({ status: "captured", bytes: [1, 2, 3], width: 10, height: 20 });

    await expect(screenRegionImageSourceProvider.acquire(new AbortController().signal)).resolves.toMatchObject({
      mediaType: "image/png",
      width: 10,
      height: 20,
      source: "screenRegion"
    });
  });
});
