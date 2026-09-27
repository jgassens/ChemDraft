import { describe, expect, it, vi } from "vitest";

import * as recognitionScreenCaptures from "./recognitionScreenCaptures";

describe("recognition screen captures", () => {
  it("reveals the folder through the native host", async () => {
    const invokeCommand = vi.fn(async () => undefined) as never;
    await recognitionScreenCaptures.revealRecognitionScreenCaptures(invokeCommand);
    expect(invokeCommand).toHaveBeenCalledWith("reveal_recognition_screen_captures");
  });

  it("offers no way to copy a capture after the fact: the capture command saves it when taken", () => {
    expect(Object.keys(recognitionScreenCaptures)).toEqual(["revealRecognitionScreenCaptures"]);
  });
});
