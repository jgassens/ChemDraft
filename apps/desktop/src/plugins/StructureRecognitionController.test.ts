import type { PluginProvidedImage, PluginRecognitionResult } from "@chemdraft/plugin-api";
import { describe, expect, it, vi } from "vitest";

import { StructureRecognitionController } from "./StructureRecognitionController";
import type {
  StructureRecognitionEngine,
  StructureRecognitionEngineStatus,
  StructureRecognitionInstallProgress,
  StructureRecognitionOutcome,
  StructureRecognitionProgress
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
    expect(engine.recognizeImage).toHaveBeenCalledWith({ mediaType: "image/png", bytes: image.bytes }, expect.any(Function));
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let step = 0; step < 12; step += 1) await Promise.resolve();
}

const checkingEngine: StructureRecognitionEngineStatus = {
  ...notInstalled,
  state: "installing",
  engineCheck: true,
  progress: { phase: "verifying", message: "Checking the installed recognition engine." },
  installElapsedMs: 2_000
};

/** An installed engine whose recognition the test drives by hand: progress, then the answer. */
function drivenSetup(options: { statuses?: StructureRecognitionEngineStatus[]; followIntervalMs?: number } = {}) {
  const calls: Array<{
    report: (progress: StructureRecognitionProgress) => void;
    answer: (outcome: StructureRecognitionOutcome) => void;
  }> = [];
  const statuses = [...(options.statuses ?? [])];
  const engine: StructureRecognitionEngine = {
    status: vi.fn(async () => statuses.shift() ?? installed),
    install: vi.fn(async () => installed),
    cancelInstall: vi.fn(async () => undefined),
    uninstall: vi.fn(async () => notInstalled),
    recognizeImage: vi.fn((_input, onProgress) => {
      const answer = deferred<StructureRecognitionOutcome>();
      calls.push({ report: (progress) => onProgress?.(progress), answer: answer.resolve });
      return answer.promise;
    }),
    cancelRecognition: vi.fn(async () => {
      // Like the host: the running call then answers `cancelled`.
      calls.at(-1)?.answer({ status: "cancelled" });
    })
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
  const preparing = deferred<PluginRecognitionResult>();
  const prepare = vi.fn(() => preparing.promise);
  const controller = new StructureRecognitionController(engine, prepare, {
    now: () => 5_000,
    followIntervalMs: options.followIntervalMs ?? 500
  });
  controller.attachInstallPresenter();
  return { controller, engine, calls, prepare, prepared, finishPreparing: () => preparing.resolve(prepared) };
}

const plugin = { id: "org.chemdraft.ocsr.molscribe", name: "MolScribe OCSR" };

describe("StructureRecognitionController recognition progress", () => {
  it("reports each stage, in order, from the moment the image is handed over until the result", async () => {
    const { controller, calls, prepare, prepared, finishPreparing } = drivenSetup();
    // What the indicator would render after each notification, repeats collapsed: listeners also
    // hear general notifications, which leave the snapshot unchanged.
    const seen: string[] = [];
    controller.subscribeActivity(() => {
      const activity = controller.getActiveRecognition();
      const label = activity
        ? `${activity.stage}${activity.reading ? ` ${activity.reading.run}/${activity.reading.runsPlanned}` : ""}`
        : "none";
      if (seen.at(-1) !== label) seen.push(label);
    });

    const pending = controller.recognize(plugin, image, new AbortController().signal);
    // Visible at once, before the engine has even been asked for its status.
    expect(controller.getActiveRecognition()).toEqual({
      id: expect.any(Number),
      pluginId: plugin.id,
      pluginName: "MolScribe OCSR",
      stage: "checking",
      startedAt: 5_000
    });
    await flush();
    expect(calls).toHaveLength(1);

    calls[0].report({ stage: "starting" });
    expect(controller.getActiveRecognition()?.stage).toBe("starting");
    for (let run = 1; run <= 5; run += 1) calls[0].report({ stage: "reading", run, runsPlanned: 5 });
    expect(controller.getActiveRecognition()?.reading).toEqual({ run: 5, runsPlanned: 5 });
    // The first pass disagreed: the vote widens to fifteen readings.
    calls[0].report({ stage: "reading", run: 6, runsPlanned: 15 });
    expect(controller.getActiveRecognition()).toMatchObject({ stage: "reading", reading: { run: 6, runsPlanned: 15 } });

    calls[0].answer(recognized);
    await flush();
    expect(prepare).toHaveBeenCalledOnce();
    expect(controller.getActiveRecognition()).toMatchObject({ stage: "validating" });
    expect(controller.getActiveRecognition()?.reading).toBeUndefined();

    finishPreparing();
    await expect(pending).resolves.toEqual(prepared);
    expect(controller.getActiveRecognition()).toBeUndefined();
    expect(seen).toEqual([
      "checking",
      "starting",
      "reading 1/5",
      "reading 2/5",
      "reading 3/5",
      "reading 4/5",
      "reading 5/5",
      "reading 6/15",
      "validating",
      "none"
    ]);
  });

  it("keeps the same snapshot object until something changes", async () => {
    const { controller, calls } = drivenSetup();
    void controller.recognize(plugin, image, new AbortController().signal);
    await flush();
    const first = controller.getActiveRecognition();
    expect(controller.getActiveRecognition()).toBe(first);
    calls[0].report({ stage: "reading", run: 1, runsPlanned: 5 });
    expect(controller.getActiveRecognition()).not.toBe(first);
  });

  it("ignores a reading count that makes no sense instead of showing it", async () => {
    const { controller, calls } = drivenSetup();
    void controller.recognize(plugin, image, new AbortController().signal);
    await flush();
    calls[0].report({ stage: "reading", run: 7, runsPlanned: 5 });
    expect(controller.getActiveRecognition()).toMatchObject({ stage: "reading" });
    expect(controller.getActiveRecognition()?.reading).toBeUndefined();
  });

  it("Cancel settles the plugin's request as cancelled at once and stops the engine", async () => {
    const { controller, engine, calls, prepare } = drivenSetup();
    const pending = controller.recognize(plugin, image, new AbortController().signal);
    await flush();
    calls[0].report({ stage: "reading", run: 2, runsPlanned: 5 });

    controller.cancelRecognition(controller.getActiveRecognition()!.id);
    // The indicator goes at once, without waiting for the engine.
    expect(controller.getActiveRecognition()).toBeUndefined();
    await expect(pending).resolves.toEqual({ status: "cancelled" });
    expect(engine.cancelRecognition).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
    // A late reading from the cancelled call changes nothing.
    calls[0].report({ stage: "reading", run: 3, runsPlanned: 5 });
    expect(controller.getActiveRecognition()).toBeUndefined();
  });

  it("Cancel for a recognition that already ended does nothing", async () => {
    const { controller, engine, calls, finishPreparing } = drivenSetup();
    const pending = controller.recognize(plugin, image, new AbortController().signal);
    const id = controller.getActiveRecognition()!.id;
    await flush();
    calls[0].answer(recognized);
    finishPreparing();
    await pending;
    controller.cancelRecognition(id);
    expect(engine.cancelRecognition).not.toHaveBeenCalled();
  });

  it("an engine that answers cancelled (stopped elsewhere) is a silent cancel for the plugin", async () => {
    const { controller, calls } = drivenSetup();
    const pending = controller.recognize(plugin, image, new AbortController().signal);
    await flush();
    calls[0].answer({ status: "cancelled" });
    await expect(pending).resolves.toEqual({ status: "cancelled" });
    expect(controller.getActiveRecognition()).toBeUndefined();
  });

  it("the indicator disappears when recognition fails", async () => {
    const { controller, calls } = drivenSetup();
    const pending = controller.recognize(plugin, image, new AbortController().signal);
    await flush();
    calls[0].answer({ status: "failed", code: "recognitionFailed", message: "No structure found." });
    await expect(pending).resolves.toMatchObject({ status: "failed", code: "recognitionFailed" });
    expect(controller.getActiveRecognition()).toBeUndefined();
  });

  it("an abandoned invocation stops the engine the same way Cancel does", async () => {
    const { controller, engine } = drivenSetup();
    const invocation = new AbortController();
    const pending = controller.recognize(plugin, image, invocation.signal);
    await flush();
    invocation.abort();
    await expect(pending).resolves.toEqual({ status: "cancelled" });
    expect(engine.cancelRecognition).toHaveBeenCalledOnce();
    expect(controller.getActiveRecognition()).toBeUndefined();
  });

  it("an engine that cannot cancel is simply no longer waited for", async () => {
    const { controller, engine } = drivenSetup();
    delete (engine as { cancelRecognition?: unknown }).cancelRecognition;
    const pending = controller.recognize(plugin, image, new AbortController().signal);
    await flush();
    controller.cancelRecognition(controller.getActiveRecognition()!.id);
    await expect(pending).resolves.toEqual({ status: "cancelled" });
  });

  it("refuses a second recognition while one runs, without disturbing the first", async () => {
    const { controller, calls } = drivenSetup();
    void controller.recognize(plugin, image, new AbortController().signal);
    await flush();
    const first = controller.getActiveRecognition();
    await expect(controller.recognize(plugin, image, new AbortController().signal)).resolves.toMatchObject({
      status: "failed",
      code: "busy"
    });
    expect(controller.getActiveRecognition()).toBe(first);
    expect(calls).toHaveLength(1);
  });

  it("a recognition after a cancel waits for the cancelled engine call to end before starting", async () => {
    const { controller, engine, calls } = drivenSetup();
    // This engine's cancel does not answer the call at once.
    vi.mocked(engine.cancelRecognition!).mockImplementation(async () => undefined);
    const first = controller.recognize(plugin, image, new AbortController().signal);
    await flush();
    controller.cancelRecognition(controller.getActiveRecognition()!.id);
    await expect(first).resolves.toEqual({ status: "cancelled" });

    void controller.recognize(plugin, image, new AbortController().signal);
    await flush();
    expect(calls).toHaveLength(1);
    expect(controller.getActiveRecognition()?.stage).toBe("checking");
    calls[0].answer({ status: "cancelled" });
    await flush();
    expect(calls).toHaveLength(2);
  });

  it("hides behind the install dialog, and returns when the install finishes", async () => {
    const { controller, calls } = drivenSetup({ statuses: [notInstalled] });
    void controller.recognize(plugin, image, new AbortController().signal);
    await flush();
    const open = controller.getOpenInstall();
    expect(open).toBeDefined();
    expect(controller.getActiveRecognition()).toBeUndefined();

    await controller.install(open!.id);
    await flush();
    expect(controller.getOpenInstall()).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(controller.getActiveRecognition()).toMatchObject({ pluginName: "MolScribe OCSR", stage: "checking" });
  });

  it("waits for the one-time engine check under the indicator instead of opening the install dialog", async () => {
    vi.useFakeTimers();
    try {
      const { controller, engine, calls } = drivenSetup({ statuses: [checkingEngine, checkingEngine, installed] });
      void controller.recognize(plugin, image, new AbortController().signal);
      await flush();
      expect(controller.getOpenInstall()).toBeUndefined();
      expect(controller.getActiveRecognition()?.stage).toBe("checking");
      expect(calls).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(500);
      expect(controller.getActiveRecognition()?.stage).toBe("checking");
      await vi.advanceTimersByTimeAsync(500);
      await flush();
      expect(calls).toHaveLength(1);
      expect(engine.install).not.toHaveBeenCalled();
      calls[0].report({ stage: "starting" });
      expect(controller.getActiveRecognition()?.stage).toBe("starting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Cancel during the one-time check stops waiting but leaves the check to finish", async () => {
    vi.useFakeTimers();
    try {
      const { controller, engine, calls } = drivenSetup({
        statuses: [checkingEngine, checkingEngine, checkingEngine, installed]
      });
      const pending = controller.recognize(plugin, image, new AbortController().signal);
      await flush();
      controller.cancelRecognition(controller.getActiveRecognition()!.id);
      await expect(pending).resolves.toEqual({ status: "cancelled" });
      expect(controller.getActiveRecognition()).toBeUndefined();
      // Neither the check nor any recognition was told to stop: nothing was recognizing yet.
      expect(engine.cancelInstall).not.toHaveBeenCalled();
      expect(engine.cancelRecognition).not.toHaveBeenCalled();
      expect(controller.getInstallRun()?.running).toBe(true);

      // The check still reaches its own answer, and the next recognition goes straight to work.
      await vi.advanceTimersByTimeAsync(1_500);
      await flush();
      expect(controller.getInstallRun()).toBeUndefined();
      expect(controller.getStatus()?.state).toBe("installed");
      void controller.recognize(plugin, image, new AbortController().signal);
      await flush();
      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an engine check that finds the engine out of date opens the install dialog as before", async () => {
    vi.useFakeTimers();
    try {
      const broken: StructureRecognitionEngineStatus = {
        ...notInstalled,
        state: "broken",
        detail: "The recognition engine needs to be updated."
      };
      const { controller, calls } = drivenSetup({ statuses: [checkingEngine, broken, broken] });
      void controller.recognize(plugin, image, new AbortController().signal);
      await flush();
      await vi.advanceTimersByTimeAsync(500);
      await flush();
      expect(controller.getOpenInstall()).toMatchObject({ status: { state: "broken" } });
      expect(controller.getActiveRecognition()).toBeUndefined();
      expect(calls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
