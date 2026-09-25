import type { PluginProvidedImage, PluginRecognitionResult } from "@chemdraft/plugin-api";
import { describe, expect, it, vi } from "vitest";

import { StructureRecognitionController } from "./StructureRecognitionController";
import type {
  StructureRecognitionEngine,
  StructureRecognitionEngineStatus,
  StructureRecognitionInstallProgress,
  StructureRecognitionOutcome
} from "./structureRecognitionEngine";

const installed: StructureRecognitionEngineStatus = {
  state: "installed",
  installed: {
    uvVersion: "0.8.0",
    pythonVersion: "3.12.8",
    molscribeCommit: "abc123",
    modelSha256: "a".repeat(64),
    installedAt: "2026-09-24T00:00:00.000Z",
    diskBytes: 2 * 1024 ** 3
  },
  requiredDiskBytes: 2 * 1024 ** 3,
  freeDiskBytes: 8 * 1024 ** 3
};

const notInstalled: StructureRecognitionEngineStatus = {
  state: "notInstalled",
  requiredDiskBytes: 2 * 1024 ** 3,
  freeDiskBytes: 8 * 1024 ** 3
};

const image: PluginProvidedImage = {
  mediaType: "image/png",
  bytes: new Uint8Array([137, 80, 78, 71]),
  width: 640,
  height: 480,
  source: "file",
  fileName: "structure.png"
};

const recognized: Extract<StructureRecognitionOutcome, { status: "recognized" }> = {
  status: "recognized",
  smiles: "C",
  molfile: "mol",
  confidence: 0.92,
  atoms: [{ index: 0, symbol: "C", x: 0, y: 0, confidence: 0.91 }],
  bonds: [],
  agreement: { runs: 5, agreeing: 5, invalidRuns: 0, scalesPx: [800, 900, 1000, 1100, 1200] },
  elapsedMs: 120,
  engine: { name: "MolScribe", molscribeCommit: "abc123", modelSha256: "a".repeat(64) }
};

// Like Rust's `ocsr_engine_cancel_install`, which returns `()`, the fakes' cancelInstall resolves to nothing.
function setup(initial: StructureRecognitionEngineStatus = installed) {
  const engine: StructureRecognitionEngine = {
    status: vi.fn(async () => initial),
    install: vi.fn(async (onProgress) => {
      onProgress({ phase: "downloadingModel", message: "Downloading…", bytesDone: 2, bytesTotal: 4 });
      return installed;
    }),
    cancelInstall: vi.fn(async () => undefined),
    uninstall: vi.fn(async () => notInstalled),
    recognizeImage: vi.fn(async () => recognized)
  };
  const prepared: PluginRecognitionResult = {
    status: "recognized",
    result: {
      sourceImageRef: "data:image/png;base64,iVBORw==",
      proposedMolfile: "mol",
      confidence: 0.92,
      atomConfidence: [],
      bondConfidence: [],
      warnings: []
    }
  };
  const prepare = vi.fn(async () => prepared);
  const controller = new StructureRecognitionController(engine, prepare);
  // Stands in for MainWindow's install dialog; tests without one construct the controller directly.
  const detachPresenter = controller.attachInstallPresenter();
  return { controller, engine, prepare, prepared, detachPresenter };
}

describe("StructureRecognitionController", () => {
  it("recognizes immediately through an installed engine", async () => {
    const { controller, engine, prepare, prepared } = setup();

    await expect(
      controller.recognize({ id: "plugin", name: "Plugin" }, image, new AbortController().signal)
    ).resolves.toEqual(prepared);
    expect(engine.recognizeImage).toHaveBeenCalledWith({ mediaType: "image/png", bytes: image.bytes });
    expect(prepare).toHaveBeenCalledWith(recognized, image);
  });

  it("opens the host installer, relays progress, then continues recognition", async () => {
    const { controller, engine, prepared } = setup(notInstalled);
    const listener = vi.fn();
    controller.subscribe(listener);
    const pending = controller.recognize(
      { id: "org.chemdraft.ocsr.molscribe", name: "MolScribe OCSR" },
      image,
      new AbortController().signal
    );
    await Promise.resolve();
    await Promise.resolve();

    const open = controller.getOpenInstall();
    expect(open).toMatchObject({ pluginName: "MolScribe OCSR", installing: false });
    await controller.install(open!.id);

    await expect(pending).resolves.toEqual(prepared);
    expect(engine.install).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalled();
    expect(controller.getOpenInstall()).toBeUndefined();
  });

  it("returns engineNotInstalled when the user declines without invoking recognition", async () => {
    const { controller, engine } = setup(notInstalled);
    const pending = controller.recognize(
      { id: "org.chemdraft.ocsr.molscribe", name: "MolScribe OCSR" },
      image,
      new AbortController().signal
    );
    await Promise.resolve();
    await Promise.resolve();
    controller.decline(controller.getOpenInstall()!.id);

    await expect(pending).resolves.toEqual({ status: "engineNotInstalled" });
    expect(engine.recognizeImage).not.toHaveBeenCalled();
  });

  it("passes native recognition failures through without preparing a proposal", async () => {
    const { controller, engine, prepare } = setup();
    vi.mocked(engine.recognizeImage).mockResolvedValueOnce({
      status: "failed",
      code: "invalidImage",
      message: "The file was not a decodable image."
    });

    await expect(
      controller.recognize({ id: "plugin", name: "Plugin" }, image, new AbortController().signal)
    ).resolves.toEqual({
      status: "failed",
      code: "invalidImage",
      message: "The file was not a decodable image."
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("cancels an in-flight install through the engine and reports cancelled, not engineNotInstalled", async () => {
    const { controller, engine } = setup(notInstalled);
    vi.mocked(engine.install).mockImplementationOnce(
      () => new Promise(() => undefined) // the native install never finishes on its own
    );
    const pending = controller.recognize({ id: "p", name: "P" }, image, new AbortController().signal);
    await Promise.resolve();
    await Promise.resolve();
    const id = controller.getOpenInstall()!.id;
    void controller.install(id);
    expect(controller.getOpenInstall()?.installing).toBe(true);

    await controller.cancel(id);
    await expect(pending).resolves.toEqual({ status: "cancelled" });
    expect(engine.cancelInstall).toHaveBeenCalledOnce();
    expect(engine.recognizeImage).not.toHaveBeenCalled();
  });

  it("keeps the installer open with a plain error when the install fails", async () => {
    const { controller, engine } = setup(notInstalled);
    vi.mocked(engine.install).mockRejectedValueOnce({ code: "insufficientDisk", message: "Need 2 GB." });
    void controller.recognize({ id: "p", name: "P" }, image, new AbortController().signal);
    await Promise.resolve();
    await Promise.resolve();
    const id = controller.getOpenInstall()!.id;

    await controller.install(id);
    expect(controller.getOpenInstall()).toMatchObject({
      installing: false,
      error: { code: "insufficientDisk", message: "Need 2 GB." }
    });
    controller.decline(id);
    expect(controller.getOpenInstall()).toBeUndefined();
  });

  it("closes the installer when the command invocation is abandoned", async () => {
    const { controller } = setup(notInstalled);
    const abort = new AbortController();
    const pending = controller.recognize({ id: "p", name: "P" }, image, abort.signal);
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getOpenInstall()).toBeDefined();
    abort.abort();
    await expect(pending).resolves.toEqual({ status: "cancelled" });
    expect(controller.getOpenInstall()).toBeUndefined();
  });

  it("reports cancelled when the user cancels the install dialog before installing", async () => {
    const { controller, engine } = setup(notInstalled);
    const pending = controller.recognize({ id: "p", name: "P" }, image, new AbortController().signal);
    await Promise.resolve();
    await Promise.resolve();
    await controller.cancel(controller.getOpenInstall()!.id);

    await expect(pending).resolves.toEqual({ status: "cancelled" });
    expect(engine.cancelInstall).not.toHaveBeenCalled();
    expect(engine.recognizeImage).not.toHaveBeenCalled();
  });

  it("reports cancelled for an invocation abandoned before recognition starts", async () => {
    const { controller, engine } = setup();
    const abort = new AbortController();
    abort.abort();
    await expect(controller.recognize({ id: "p", name: "P" }, image, abort.signal)).resolves.toEqual({
      status: "cancelled"
    });
    expect(engine.status).not.toHaveBeenCalled();
  });

  it("reports engineNotInstalled, not cancelled, when an install fails and the user then closes the dialog", async () => {
    const { controller, engine } = setup(notInstalled);
    vi.mocked(engine.install).mockRejectedValueOnce({ code: "network", message: "Offline." });
    const pending = controller.recognize({ id: "p", name: "P" }, image, new AbortController().signal);
    await Promise.resolve();
    await Promise.resolve();
    const id = controller.getOpenInstall()!.id;
    await controller.install(id);
    controller.decline(id);

    await expect(pending).resolves.toEqual({ status: "engineNotInstalled" });
  });

  it("reports engineNotInstalled at once when no install dialog is attached, instead of waiting forever", async () => {
    const engine: StructureRecognitionEngine = {
      status: vi.fn(async () => notInstalled),
      install: vi.fn(async () => installed),
      cancelInstall: vi.fn(async () => undefined),
      uninstall: vi.fn(async () => notInstalled),
      recognizeImage: vi.fn(async () => recognized)
    };
    const controller = new StructureRecognitionController(engine, vi.fn());

    await expect(
      controller.recognize({ id: "p", name: "P" }, image, new AbortController().signal)
    ).resolves.toEqual({ status: "engineNotInstalled" });
    await expect(controller.manageInstall({ id: "p", name: "P" })).resolves.toBe(false);
    expect(controller.getOpenInstall()).toBeUndefined();
    expect(engine.install).not.toHaveBeenCalled();
    expect(engine.recognizeImage).not.toHaveBeenCalled();
  });

  it("settles an open install request when its dialog host goes away", async () => {
    const { controller, engine, detachPresenter } = setup(notInstalled);
    const pending = controller.recognize({ id: "p", name: "P" }, image, new AbortController().signal);
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getOpenInstall()).toBeDefined();

    detachPresenter();
    detachPresenter(); // idempotent: a second detach must not drive the count negative

    await expect(pending).resolves.toEqual({ status: "engineNotInstalled" });
    expect(controller.getOpenInstall()).toBeUndefined();
    expect(engine.recognizeImage).not.toHaveBeenCalled();
    await expect(
      controller.recognize({ id: "p", name: "P" }, image, new AbortController().signal)
    ).resolves.toEqual({ status: "engineNotInstalled" });
  });

  it("follows a host-owned install it did not start, with the host's progress snapshot, until it ends", async () => {
    vi.useFakeTimers();
    try {
      const installing: StructureRecognitionEngineStatus = {
        ...notInstalled,
        state: "installing",
        progress: { phase: "installingPackages", message: "m", bytesDone: 400, bytesTotal: 1200, estimated: true },
        installElapsedMs: 90_000
      };
      const statuses = [installing, installing, installed];
      const engine: StructureRecognitionEngine = {
        status: vi.fn(async () => statuses.shift() ?? installed),
        install: vi.fn(async () => installed),
        cancelInstall: vi.fn(async () => undefined),
        uninstall: vi.fn(async () => notInstalled),
        recognizeImage: vi.fn(async () => recognized)
      };
      const controller = new StructureRecognitionController(engine, vi.fn(), {
        now: () => 1_000_000,
        followIntervalMs: 500
      });

      await controller.refreshStatus();
      expect(controller.getInstallRun()).toEqual({
        running: true,
        startedAt: 1_000_000 - 90_000,
        phaseStartedAt: 1_000_000,
        progress: installing.progress
      });
      // Joining never starts a second native install.
      const joined = controller.installEngine();
      expect(engine.install).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);
      expect(controller.getInstallRun()?.running).toBe(true);
      await vi.advanceTimersByTimeAsync(500);
      await expect(joined).resolves.toBe(true);
      expect(controller.getInstallRun()).toBeUndefined();
      expect(controller.getStatus()?.state).toBe("installed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a failed direct install on the run, and a retry starts a fresh one", async () => {
    const { controller, engine } = setup(notInstalled);
    vi.mocked(engine.install).mockRejectedValueOnce({ code: "network", message: "offline" });

    await expect(controller.installEngine()).resolves.toBe(false);
    expect(controller.getInstallRun()).toMatchObject({
      running: false,
      error: { code: "network", message: "offline" }
    });

    await expect(controller.installEngine()).resolves.toBe(true);
    expect(engine.install).toHaveBeenCalledTimes(2);
    expect(controller.getInstallRun()).toBeUndefined();
  });

  it("shows a first-use dialog on an install already running, and continues when it finishes", async () => {
    const { controller, engine, prepared } = setup(notInstalled);
    let finish!: (status: StructureRecognitionEngineStatus) => void;
    let report!: (progress: StructureRecognitionInstallProgress) => void;
    vi.mocked(engine.install).mockImplementationOnce(
      (onProgress) =>
        new Promise((resolve) => {
          report = onProgress;
          finish = resolve;
        })
    );
    const running = controller.installEngine();
    report({ phase: "downloadingModel", message: "m", bytesDone: 1, bytesTotal: 4 });
    vi.mocked(engine.status).mockResolvedValue({ ...notInstalled, state: "installing" });

    const pending = controller.recognize({ id: "p", name: "P" }, image, new AbortController().signal);
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getOpenInstall()).toMatchObject({
      installing: true,
      progress: { phase: "downloadingModel", bytesDone: 1, bytesTotal: 4 }
    });

    finish(installed);
    await running;
    await expect(pending).resolves.toEqual(prepared);
    expect(engine.install).toHaveBeenCalledOnce();
    expect(controller.getOpenInstall()).toBeUndefined();
  });

  it("never stores the cancel command's empty reply as the engine status", async () => {
    const { controller, engine } = setup(notInstalled);
    // Exactly what Tauri hands back for a `()` command.
    vi.mocked(engine.cancelInstall).mockResolvedValue(null as unknown as void);
    let fail!: (error: unknown) => void;
    vi.mocked(engine.install).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        })
    );
    const listener = vi.fn(() => {
      // Whatever the UI reads on every notification must be a status or nothing — never null.
      expect(controller.getStatus()).not.toBeNull();
    });
    controller.subscribe(listener);
    const pending = controller.recognize({ id: "p", name: "P" }, image, new AbortController().signal);
    await Promise.resolve();
    await Promise.resolve();
    const id = controller.getOpenInstall()!.id;
    void controller.install(id);

    await controller.cancel(id);
    await expect(pending).resolves.toEqual({ status: "cancelled" });
    expect(engine.cancelInstall).toHaveBeenCalledOnce();
    expect(controller.getStatus()).toEqual(notInstalled);

    // The host's own rejection ends the run, and the status is refreshed through status().
    fail({ code: "cancelled", message: "Installation was cancelled." });
    await vi.waitFor(() => expect(controller.getInstallRun()?.running).toBe(false));
    expect(controller.getInstallRun()?.error?.code).toBe("cancelled");
    expect(controller.getStatus()).toEqual(notInstalled);
    expect(listener).toHaveBeenCalled();
  });

  it("cancels the running install from the plugin manager without taking a status from the reply", async () => {
    const { controller, engine } = setup(notInstalled);
    vi.mocked(engine.cancelInstall).mockResolvedValue(null as unknown as void);
    vi.mocked(engine.install).mockImplementationOnce(() => new Promise(() => undefined));
    await controller.refreshStatus();
    void controller.installEngine();

    await controller.cancelEngineInstall();
    expect(engine.cancelInstall).toHaveBeenCalledOnce();
    expect(controller.getStatus()).toEqual(notInstalled);
  });

  describe("a dialog that joined an install started elsewhere", () => {
    async function joinedDialog(signal = new AbortController().signal) {
      const context = setup(notInstalled);
      const { controller, engine } = context;
      let finish!: (status: StructureRecognitionEngineStatus) => void;
      vi.mocked(engine.install).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
      // The user started the install from Add or Remove Plugins.
      const running = controller.installEngine();
      vi.mocked(engine.status).mockResolvedValue({ ...notInstalled, state: "installing" });
      const pending = controller.recognize({ id: "p", name: "P" }, image, signal);
      await Promise.resolve();
      await Promise.resolve();
      expect(controller.getOpenInstall()).toMatchObject({ installing: true, ownsInstall: false });
      return { ...context, running, pending, finish: (status: StructureRecognitionEngineStatus) => finish(status) };
    }

    it("settles as cancelled when closed, and leaves the shared install running", async () => {
      const { controller, engine, pending, running, finish } = await joinedDialog();

      await controller.cancel(controller.getOpenInstall()!.id);
      await expect(pending).resolves.toEqual({ status: "cancelled" });
      expect(engine.cancelInstall).not.toHaveBeenCalled();
      expect(controller.getInstallRun()?.running).toBe(true);

      finish(installed);
      await expect(running).resolves.toBe(true);
    });

    it("settles as cancelled when its invocation is abandoned, and leaves the shared install running", async () => {
      const abort = new AbortController();
      const { controller, engine, pending } = await joinedDialog(abort.signal);

      abort.abort();
      await expect(pending).resolves.toEqual({ status: "cancelled" });
      expect(controller.getOpenInstall()).toBeUndefined();
      expect(engine.cancelInstall).not.toHaveBeenCalled();
      expect(controller.getInstallRun()?.running).toBe(true);
    });

    it("still lets Cancel install in the plugin manager stop it", async () => {
      const { controller, engine } = await joinedDialog();
      await controller.cancelEngineInstall();
      expect(engine.cancelInstall).toHaveBeenCalledOnce();
    });
  });

  it("marks a dialog whose own Install started the run as owning it", async () => {
    const { controller, engine } = setup(notInstalled);
    vi.mocked(engine.install).mockImplementationOnce(() => new Promise(() => undefined));
    void controller.recognize({ id: "p", name: "P" }, image, new AbortController().signal);
    await Promise.resolve();
    await Promise.resolve();
    const id = controller.getOpenInstall()!.id;
    expect(controller.getOpenInstall()?.ownsInstall).toBe(false);
    void controller.install(id);
    expect(controller.getOpenInstall()).toMatchObject({ installing: true, ownsInstall: true });
  });

  it("leaves an owned install running when only the invocation is abandoned", async () => {
    const { controller, engine } = setup(notInstalled);
    vi.mocked(engine.install).mockImplementationOnce(() => new Promise(() => undefined));
    const abort = new AbortController();
    const pending = controller.recognize({ id: "p", name: "P" }, image, abort.signal);
    await Promise.resolve();
    await Promise.resolve();
    void controller.install(controller.getOpenInstall()!.id);

    abort.abort();
    await expect(pending).resolves.toEqual({ status: "cancelled" });
    // Only an explicit Cancel stops an install; it stays visible in Add or Remove Plugins.
    expect(engine.cancelInstall).not.toHaveBeenCalled();
    expect(controller.getInstallRun()?.running).toBe(true);
  });

  it("reports an unsupported engine as failed/unsupported without opening an install dialog", async () => {
    const detail = "The recognition engine needs a Mac with Apple silicon.";
    const { controller, engine } = setup({ ...notInstalled, state: "unsupported", detail });
    const listener = vi.fn();
    controller.subscribe(listener);

    await expect(
      controller.recognize({ id: "p", name: "P" }, image, new AbortController().signal)
    ).resolves.toEqual({ status: "failed", code: "unsupported", message: detail });
    expect(controller.getOpenInstall()).toBeUndefined();
    expect(engine.install).not.toHaveBeenCalled();
    expect(engine.recognizeImage).not.toHaveBeenCalled();
  });

  it("reports failed/unsupported when the install itself finds the computer unsupported", async () => {
    const { controller, engine } = setup(notInstalled);
    vi.mocked(engine.install).mockRejectedValueOnce({ code: "unsupported", message: "Intel Macs are not supported." });
    const pending = controller.recognize({ id: "p", name: "P" }, image, new AbortController().signal);
    await Promise.resolve();
    await Promise.resolve();
    const id = controller.getOpenInstall()!.id;
    await controller.install(id);
    expect(controller.getOpenInstall()?.status.state).toBe("unsupported");
    controller.decline(id);

    await expect(pending).resolves.toEqual({
      status: "failed",
      code: "unsupported",
      message: "Intel Macs are not supported."
    });
  });
});
