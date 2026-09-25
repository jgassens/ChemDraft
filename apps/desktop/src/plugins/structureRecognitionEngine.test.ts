import { describe, expect, it, vi } from "vitest";

import {
  TauriStructureRecognitionEngine,
  type ProgressChannel,
  type StructureRecognitionInstallProgress
} from "./structureRecognitionEngine";

describe("TauriStructureRecognitionEngine", () => {
  it("uses the exact status, cancel, and uninstall commands", async () => {
    const status = { state: "notInstalled" as const, requiredDiskBytes: 10, freeDiskBytes: 20 };
    // Rust's ocsr_engine_cancel_install returns `()`, which Tauri delivers as null.
    const invoke = vi.fn(async (command: string) => (command === "ocsr_engine_cancel_install" ? null : status));
    const engine = new TauriStructureRecognitionEngine(
      invoke as unknown as ConstructorParameters<typeof TauriStructureRecognitionEngine>[0]
    );

    await expect(engine.status()).resolves.toEqual(status);
    await expect(engine.cancelInstall()).resolves.toBeUndefined();
    await expect(engine.uninstall()).resolves.toEqual(status);
    expect(invoke.mock.calls).toEqual([
      ["ocsr_engine_status"],
      ["ocsr_engine_cancel_install"],
      ["ocsr_engine_uninstall"]
    ]);
  });

  it("passes progress through a Channel under the exact onProgress argument", async () => {
    let channel: ProgressChannel<StructureRecognitionInstallProgress> | undefined;
    const createChannel = vi.fn(<T>(): ProgressChannel<T> => {
      channel = { onmessage: () => undefined } as ProgressChannel<StructureRecognitionInstallProgress>;
      return channel as ProgressChannel<T>;
    });
    const installed = { state: "installed" as const, requiredDiskBytes: 10, freeDiskBytes: 20 };
    const invoke = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      (args?.onProgress as ProgressChannel<StructureRecognitionInstallProgress>).onmessage({
        phase: "downloadingModel",
        message: "Downloading model",
        bytesDone: 5,
        bytesTotal: 10
      });
      return installed;
    });
    const progress = vi.fn();
    const engine = new TauriStructureRecognitionEngine(
      invoke as unknown as ConstructorParameters<typeof TauriStructureRecognitionEngine>[0],
      createChannel
    );

    await expect(engine.install(progress)).resolves.toEqual(installed);
    expect(invoke).toHaveBeenCalledWith("ocsr_engine_install", { onProgress: channel });
    expect(progress).toHaveBeenCalledWith({
      phase: "downloadingModel",
      message: "Downloading model",
      bytesDone: 5,
      bytesTotal: 10
    });
  });

  it("forwards install rejections without changing their stable code", async () => {
    const error = { code: "checksumMismatch", message: "Model checksum did not match." };
    const invoke = vi.fn(async () => Promise.reject(error));
    const engine = new TauriStructureRecognitionEngine(
      invoke as unknown as ConstructorParameters<typeof TauriStructureRecognitionEngine>[0],
      <T>() => ({ onmessage: (_message: T) => undefined })
    );
    await expect(engine.install(() => undefined)).rejects.toEqual(error);
  });

  it("base64-encodes bytes and preserves every recognition outcome", async () => {
    const outcomes = [
      { status: "notInstalled" as const },
      { status: "failed" as const, code: "busy" as const, message: "Busy" },
      {
        status: "recognized" as const,
        smiles: "C",
        molfile: "mol",
        confidence: null,
        atoms: [],
        bonds: [],
        agreement: { runs: 15, agreeing: 10, invalidRuns: 3, scalesPx: [760, 800, 840, 880, 900, 920, 960, 1000, 1040, 1080, 1100, 1120, 1160, 1200, 1240] },
        elapsedMs: 12,
        engine: { name: "MolScribe" as const, molscribeCommit: "abc", modelSha256: "d".repeat(64) }
      }
    ];
    const invoke = vi.fn(async () => outcomes.shift()!);
    const engine = new TauriStructureRecognitionEngine(
      invoke as unknown as ConstructorParameters<typeof TauriStructureRecognitionEngine>[0]
    );

    await expect(engine.recognizeImage({ mediaType: "image/png", bytes: new Uint8Array([0, 1, 255]) })).resolves.toEqual({
      status: "notInstalled"
    });
    await expect(engine.recognizeImage({ mediaType: "image/png", bytes: new Uint8Array([0, 1, 255]) })).resolves.toMatchObject({
      status: "failed",
      code: "busy"
    });
    await expect(engine.recognizeImage({ mediaType: "image/png", bytes: new Uint8Array([0, 1, 255]) })).resolves.toMatchObject({
      status: "recognized",
      confidence: null,
      agreement: { runs: 15, agreeing: 10, invalidRuns: 3, scalesPx: [760, 800, 840, 880, 900, 920, 960, 1000, 1040, 1080, 1100, 1120, 1160, 1200, 1240] }
    });
    expect(invoke).toHaveBeenCalledWith("ocsr_recognize_image", {
      mediaType: "image/png",
      bytesBase64: "AAH/"
    });
  });
});
