import { PluginImageMaxBytes } from "@chemdraft/plugin-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn(), stat: vi.fn() }));
vi.mock("./pluginStagingFs", () => ({ isTauriHost: () => true }));

import { open } from "@tauri-apps/plugin-dialog";
import { readFile, stat } from "@tauri-apps/plugin-fs";

import { fileImageSourceProvider, ImageSourceError } from "./ImageSourceProvider";

// A 3×2 PNG header: signature, then the IHDR chunk carrying width and height.
const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 3, 0, 0, 0, 2, 8, 6,
  0, 0, 0
]);

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
});
