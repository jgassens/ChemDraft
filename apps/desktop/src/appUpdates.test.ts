import { describe, expect, it, vi } from "vitest";
import {
  AUTO_CHECK_INTERVAL_MS,
  LAST_AUTO_CHECK_STORAGE_KEY,
  STABLE_APP_IDENTIFIER,
  appUpdateChecksAllowed,
  appUpdatesSupported,
  autoCheckDue,
  downloadProgressLabel,
  readLastAutoCheck,
  runUpdateFlow,
  updatePromptText,
  writeLastAutoCheck,
  type AvailableUpdate,
  type UpdateDownloadEvent,
  type UpdateFlowDeps
} from "./appUpdates";

const released = { isDesktop: true, platform: "windows", identifier: STABLE_APP_IDENTIFIER, isDevServer: false };

describe("which builds check for updates", () => {
  it("offers the channel on Windows desktop only", () => {
    expect(appUpdatesSupported({ isDesktop: true, platform: "windows" })).toBe(true);
    expect(appUpdatesSupported({ isDesktop: true, platform: "macos" })).toBe(false); // Sparkle's job
    expect(appUpdatesSupported({ isDesktop: true, platform: "linux" })).toBe(false);
    expect(appUpdatesSupported({ isDesktop: false, platform: "windows" })).toBe(false);
  });

  it("lets only the released build check — never a branch build or a dev session", () => {
    expect(appUpdateChecksAllowed(released)).toBe(true);
    expect(appUpdateChecksAllowed({ ...released, identifier: "org.chemdraft.desktop.dev.chemdraft" })).toBe(false);
    expect(appUpdateChecksAllowed({ ...released, identifier: undefined })).toBe(false);
    expect(appUpdateChecksAllowed({ ...released, isDevServer: true })).toBe(false);
    expect(appUpdateChecksAllowed({ ...released, platform: "macos" })).toBe(false);
  });
});

describe("automatic check cadence", () => {
  const now = 1_800_000_000_000;

  it("checks when never checked, and again once the interval has passed", () => {
    expect(autoCheckDue(undefined, now)).toBe(true);
    expect(autoCheckDue(now - AUTO_CHECK_INTERVAL_MS + 1, now)).toBe(false);
    expect(autoCheckDue(now - AUTO_CHECK_INTERVAL_MS, now)).toBe(true);
  });

  it("does not let a future or corrupt timestamp suppress checks", () => {
    expect(autoCheckDue(now + 60_000, now)).toBe(true);
    expect(autoCheckDue(Number.NaN, now)).toBe(true);
  });

  it("round-trips the last check through storage and survives storage that throws", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
    writeLastAutoCheck(storage, now);
    expect(values.get(LAST_AUTO_CHECK_STORAGE_KEY)).toBe(String(now));
    expect(readLastAutoCheck(storage)).toBe(now);

    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      }
    };
    expect(readLastAutoCheck(broken)).toBeUndefined();
    expect(() => writeLastAutoCheck(broken, now)).not.toThrow();
    expect(readLastAutoCheck(undefined)).toBeUndefined();
  });
});

describe("prompt and progress text", () => {
  it("names both versions and includes release notes when present", () => {
    const text = updatePromptText({ version: "0.3.6", currentVersion: "0.3.5", body: "Faster export." });
    expect(text).toContain("ChemDraft 0.3.6 is available — you have 0.3.5.");
    expect(text).toContain("Faster export.");
    expect(text).toContain("saves your document");
    expect(updatePromptText({ version: "0.3.6", currentVersion: "0.3.5", body: "  " })).not.toContain("\n\n\n");
  });

  it("reports percent when the size is known, and megabytes when it is not", () => {
    expect(downloadProgressLabel("0.3.6", 5 * 1024 * 1024, 20 * 1024 * 1024)).toBe(
      "Downloading ChemDraft 0.3.6: 25% (5.0 of 20.0 MB)"
    );
    expect(downloadProgressLabel("0.3.6", 3 * 1024 * 1024, undefined)).toBe("Downloading ChemDraft 0.3.6: 3.0 MB");
    expect(downloadProgressLabel("0.3.6", 30, 20)).toContain("100%");
  });
});

function fakeUpdate(overrides: Partial<AvailableUpdate> = {}): AvailableUpdate & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    version: "0.3.6",
    currentVersion: "0.3.5",
    body: "Notes",
    download: vi.fn(async (onEvent?: (event: UpdateDownloadEvent) => void) => {
      calls.push("download");
      onEvent?.({ event: "Started", data: { contentLength: 200 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 100 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 100 } });
      onEvent?.({ event: "Finished" });
    }),
    install: vi.fn(async () => {
      calls.push("install");
    }),
    close: vi.fn(async () => {
      calls.push("close");
    }),
    ...overrides
  };
}

function deps(overrides: Partial<UpdateFlowDeps> = {}, order: string[] = []): UpdateFlowDeps {
  return {
    check: vi.fn(async () => null),
    confirm: vi.fn(async () => true),
    message: vi.fn(async () => undefined),
    setStatus: vi.fn(),
    flushSession: vi.fn(async () => {
      order.push("flush");
    }),
    ...overrides
  };
}

describe("runUpdateFlow", () => {
  it("says so on a manual check with nothing new, and stays silent on an automatic one", async () => {
    const manual = deps();
    expect(await runUpdateFlow("manual", manual)).toBe("up-to-date");
    expect(manual.message).toHaveBeenCalledWith("You're running the latest version of ChemDraft.", expect.anything());

    const automatic = deps();
    expect(await runUpdateFlow("automatic", automatic)).toBe("up-to-date");
    expect(automatic.message).not.toHaveBeenCalled();
  });

  it("reports a failed manual check, and keeps an offline launch check quiet", async () => {
    const offline = () => Promise.reject(new Error("offline"));
    const manual = deps({ check: vi.fn(offline) });
    expect(await runUpdateFlow("manual", manual)).toBe("check-failed");
    expect(manual.message).toHaveBeenCalledWith("Could not check for updates: offline", expect.objectContaining({ kind: "error" }));

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const automatic = deps({ check: vi.fn(offline) });
    expect(await runUpdateFlow("automatic", automatic)).toBe("check-failed");
    expect(automatic.message).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("never installs without asking, and releases the update when declined", async () => {
    const update = fakeUpdate();
    const declined = deps({ check: vi.fn(async () => update), confirm: vi.fn(async () => false) });
    expect(await runUpdateFlow("automatic", declined)).toBe("declined");
    expect(update.calls).toEqual(["close"]);
    expect(declined.flushSession).not.toHaveBeenCalled();
  });

  it("downloads, then saves the document, then installs — in that order", async () => {
    const order: string[] = [];
    const update = fakeUpdate();
    update.download = vi.fn(async (onEvent) => {
      order.push("download");
      onEvent?.({ event: "Started", data: { contentLength: 200 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 100 } });
    });
    update.install = vi.fn(async () => {
      order.push("install");
    });
    const flow = deps({ check: vi.fn(async () => update) }, order);
    expect(await runUpdateFlow("manual", flow)).toBe("installing");
    expect(order).toEqual(["download", "flush", "install"]);
    expect(flow.setStatus).toHaveBeenCalledWith("Downloading ChemDraft 0.3.6: 50% (0.0 of 0.0 MB)");
  });

  it("does not install when the document could not be saved", async () => {
    const update = fakeUpdate();
    const flow = deps({
      check: vi.fn(async () => update),
      flushSession: vi.fn(() => Promise.reject(new Error("disk full")))
    });
    expect(await runUpdateFlow("manual", flow)).toBe("install-failed");
    expect(update.install).not.toHaveBeenCalled();
    expect(flow.message).toHaveBeenCalledWith(
      "ChemDraft 0.3.6 could not be installed: disk full",
      expect.objectContaining({ kind: "error" })
    );
  });

  it("reports a failed download or signature check and leaves the app running", async () => {
    const update = fakeUpdate({
      download: vi.fn(() => Promise.reject(new Error("signature verification failed")))
    });
    const flow = deps({ check: vi.fn(async () => update) });
    expect(await runUpdateFlow("automatic", flow)).toBe("install-failed");
    expect(flow.flushSession).not.toHaveBeenCalled();
    expect(update.install).not.toHaveBeenCalled();
    expect(flow.message).toHaveBeenCalledWith(expect.stringContaining("signature verification failed"), expect.anything());
  });
});
