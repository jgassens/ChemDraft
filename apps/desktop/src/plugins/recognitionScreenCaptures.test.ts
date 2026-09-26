import { describe, expect, it, vi } from "vitest";

import { retainRecognitionScreenCapture, revealRecognitionScreenCaptures } from "./recognitionScreenCaptures";

const capture = {
  mediaType: "image/png" as const,
  bytes: new Uint8Array([137, 80, 78, 71]),
  width: 2,
  height: 2,
  source: "screenRegion" as const
};

describe("recognition screen captures", () => {
  it("hands the native host the capture's exact bytes to keep", async () => {
    const invokeCommand = vi.fn(async () => "/app-data/recognition-sources/screen-capture-1.png") as never;
    await expect(retainRecognitionScreenCapture(capture, invokeCommand)).resolves.toBe(
      "/app-data/recognition-sources/screen-capture-1.png"
    );
    expect(invokeCommand).toHaveBeenCalledWith("retain_recognition_screen_capture", { bytesBase64: "iVBORw==" });
  });

  it("never copies an image file the user chose", async () => {
    const invokeCommand = vi.fn() as never;
    await expect(
      retainRecognitionScreenCapture({ ...capture, source: "file", fileName: "a.png" }, invokeCommand)
    ).rejects.toThrow(/already on disk/);
    expect(invokeCommand).not.toHaveBeenCalled();
  });

  it("reveals the folder through the native host", async () => {
    const invokeCommand = vi.fn(async () => undefined) as never;
    await revealRecognitionScreenCaptures(invokeCommand);
    expect(invokeCommand).toHaveBeenCalledWith("reveal_recognition_screen_captures");
  });
});
