import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginManifestSchema } from "@chemdraft/plugin-api";
import { AUTO_CHECK_DELAY_MS, AUTO_CHECK_INTERVAL_MS } from "../appUpdates";
import { MemoryStorage } from "../testSupport/memoryStorage";
import type { InstalledPluginCatalogEntry } from "./installPluginPackage";
import type { PluginUpdateCheckResult, PluginUpdateOffer } from "./pluginUpdates";
import {
  ANNOUNCED_PLUGIN_VERSIONS_KEY, LAST_PLUGIN_CHECK_KEY, LAST_PLUGIN_RESULTS_KEY, createPluginUpdateChecker,
  installedPluginCatalogKey, nextPluginUpdateAutoCheckDelay, readCachedPluginUpdateResults, schedulePluginUpdateAutoCheck
} from "./pluginUpdateAutoCheck";

const pluginId = "org.chemdraft.nmr.predictor";
const installed: readonly InstalledPluginCatalogEntry[] = [{
  record: {
    id: pluginId, name: "NMR Shift Predictor", version: "0.1.0", sourceChecksum: "a".repeat(64),
    stagedPath: `installed-plugins/${pluginId}`, installedAt: "2026-10-30T00:00:00Z"
  },
  manifest: PluginManifestSchema.parse({
    id: pluginId, name: "NMR Shift Predictor", version: "0.1.0", apiVersion: "^0.1.0",
    entry: "dist/plugin.js", permissions: []
  }),
  descriptor: undefined
}];
const context = { isDesktop: true, enabled: true, catalogReady: true, installed };
const offer: PluginUpdateOffer = {
  pluginId, pluginName: "NMR Shift Predictor", installedVersion: "0.1.0", version: "0.2.0",
  releaseUrl: "https://github.com/jgassens/ChemDraft-NMR-Plugin/releases/tag/v0.2.0",
  packageUrl: "https://github.com/jgassens/ChemDraft-NMR-Plugin/releases/download/v0.2.0/nmr-predictor-0.2.0.zip",
  packageName: "nmr-predictor-0.2.0.zip", sourceChecksum: "b".repeat(64), compressedBytes: 100,
  publishedAt: "2026-10-30T00:00:00Z"
};
const available: PluginUpdateCheckResult = {
  status: "available", pluginId, installedVersion: "0.1.0", latestVersion: "0.2.0", offer
};
const upToDate: PluginUpdateCheckResult = {
  status: "upToDate", pluginId, installedVersion: "0.1.0", latestVersion: "0.1.0"
};
const failed: PluginUpdateCheckResult = {
  status: "failed", pluginId, installedVersion: "0.1.0", message: "Offline"
};
const unsupported: PluginUpdateCheckResult = { status: "unsupported", pluginId: "org.example.local", installedVersion: "1.0.0" };

function setup(results: readonly PluginUpdateCheckResult[] = [available], storage = new MemoryStorage()) {
  let at = 1_000_000_000;
  const deps = {
    storage, check: vi.fn(async () => results), onResults: vi.fn(), setStatus: vi.fn(), log: vi.fn(), now: () => at
  };
  const saveSuccess = (checkedAt = at) => {
    storage.setItem(LAST_PLUGIN_CHECK_KEY, String(checkedAt));
    storage.setItem(LAST_PLUGIN_RESULTS_KEY, JSON.stringify({ catalogKey: installedPluginCatalogKey(installed), checkedAt, results: [upToDate] }));
  };
  return { deps, checker: createPluginUpdateChecker(deps), saveSuccess, advance: (ms: number) => { at += ms; } };
}

afterEach(() => vi.useRealTimers());

describe("daily official-plugin checks", () => {
  it.each(["manual", "automatic"])("persists successful %s results with their catalog and check time, replacing older results", async mode => {
    const { checker, deps, advance } = setup([available, failed, unsupported]);
    const run = () => mode === "manual" ? checker.check(installed) : checker.automatic(context);
    await run();
    expect(JSON.parse(deps.storage.getItem(LAST_PLUGIN_RESULTS_KEY)!)).toEqual({
      catalogKey: installedPluginCatalogKey(installed), checkedAt: deps.now(), results: [available, unsupported]
    });
    expect(deps.storage.getItem(LAST_PLUGIN_CHECK_KEY)).toBe(String(deps.now()));
    advance(AUTO_CHECK_INTERVAL_MS);
    deps.check.mockResolvedValue([upToDate]);
    await run();
    expect(JSON.parse(deps.storage.getItem(LAST_PLUGIN_RESULTS_KEY)!)).toEqual({
      catalogKey: installedPluginCatalogKey(installed), checkedAt: deps.now(), results: [upToDate]
    });
  });

  it("does not persist failed checks or overwrite the last successful stored results", async () => {
    const { checker, deps } = setup([upToDate]);
    await checker.check(installed);
    const saved = deps.storage.getItem(LAST_PLUGIN_RESULTS_KEY);
    deps.check.mockResolvedValue([failed, unsupported]);
    await checker.check(installed);
    expect(deps.storage.getItem(LAST_PLUGIN_RESULTS_KEY)).toBe(saved);
  });

  it("restores a recent matching cache through onResults on the second launch without a network check", async () => {
    const { checker, deps, advance } = setup([upToDate]);
    await checker.check(installed);
    const cache = { catalogKey: installedPluginCatalogKey(installed), checkedAt: deps.now(), results: [upToDate] };
    advance(1000);
    deps.onResults.mockClear();
    deps.check.mockClear();
    const nextLaunch = createPluginUpdateChecker(deps);
    nextLaunch.restore(installed);
    await nextLaunch.automatic(context);
    expect(deps.onResults).toHaveBeenCalledExactlyOnceWith(cache);
    expect(deps.check).not.toHaveBeenCalled();
  });

  it("checks after the startup delay when an older build saved only a recent timestamp", async () => {
    vi.useFakeTimers();
    const { checker, deps } = setup();
    deps.storage.setItem(LAST_PLUGIN_CHECK_KEY, String(deps.now() - 60 * 60 * 1000));
    checker.restore(installed);
    expect(deps.onResults).not.toHaveBeenCalled();
    expect(checker.nextAutomaticCheckDelay(installed)).toBe(AUTO_CHECK_DELAY_MS);
    const stop = schedulePluginUpdateAutoCheck(() => checker.automatic(context), () => checker.nextAutomaticCheckDelay(installed));
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_DELAY_MS - 1);
    expect(deps.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.check).toHaveBeenCalledExactlyOnceWith(installed);
    const cache = { catalogKey: installedPluginCatalogKey(installed), checkedAt: deps.now(), results: [available] };
    expect(JSON.parse(deps.storage.getItem(LAST_PLUGIN_RESULTS_KEY)!)).toEqual(cache);
    expect(deps.onResults).toHaveBeenCalledExactlyOnceWith(cache);
    stop();
  });

  it("checks a changed catalog despite a recent successful check of another plugin set", async () => {
    const { checker, deps, saveSuccess } = setup();
    saveSuccess();
    const changed = [{ ...installed[0]!, record: { ...installed[0]!.record, version: "0.2.0" } }];
    expect(checker.nextAutomaticCheckDelay(changed)).toBe(AUTO_CHECK_DELAY_MS);
    await checker.automatic({ ...context, installed: changed });
    expect(deps.check).toHaveBeenCalledExactlyOnceWith(changed);
  });

  it.each(["{", "{}", JSON.stringify([upToDate]), JSON.stringify({ results: [upToDate] })])(
    "checks despite a recent timestamp when saved results are malformed or old format: %s", async value => {
      const { checker, deps, saveSuccess } = setup();
      saveSuccess();
      deps.storage.setItem(LAST_PLUGIN_RESULTS_KEY, value);
      expect(checker.nextAutomaticCheckDelay(installed)).toBe(AUTO_CHECK_DELAY_MS);
      await checker.automatic(context);
      expect(deps.check).toHaveBeenCalledOnce();
    }
  );

  it("checks when cached results expire before a more recent check timestamp", async () => {
    const { checker, deps, saveSuccess, advance } = setup();
    saveSuccess(deps.now() - AUTO_CHECK_INTERVAL_MS + AUTO_CHECK_DELAY_MS);
    deps.storage.setItem(LAST_PLUGIN_CHECK_KEY, String(deps.now()));
    expect(checker.nextAutomaticCheckDelay(installed)).toBe(AUTO_CHECK_DELAY_MS);
    await checker.automatic(context);
    expect(deps.check).not.toHaveBeenCalled();
    advance(AUTO_CHECK_DELAY_MS);
    await checker.automatic(context);
    expect(deps.check).toHaveBeenCalledOnce();
  });

  it("bounds failed no-cache attempts per catalog for the interval, including after switching back", async () => {
    const { checker, deps, advance } = setup([failed]);
    deps.storage.setItem(LAST_PLUGIN_CHECK_KEY, String(deps.now() - 60 * 60 * 1000));
    await checker.automatic(context);
    expect(deps.storage.getItem(LAST_PLUGIN_RESULTS_KEY)).toBeNull();
    expect(checker.nextAutomaticCheckDelay(installed)).toBe(AUTO_CHECK_INTERVAL_MS);
    advance(AUTO_CHECK_INTERVAL_MS - 1);
    await checker.automatic(context);
    expect(deps.check).toHaveBeenCalledOnce();
    const changed = [{ ...installed[0]!, record: { ...installed[0]!.record, version: "0.2.0" } }];
    expect(checker.nextAutomaticCheckDelay(changed)).toBe(AUTO_CHECK_DELAY_MS);
    await checker.automatic({ ...context, installed: changed });
    await checker.automatic(context);
    expect(deps.check).toHaveBeenCalledTimes(2);
    advance(1);
    await checker.automatic(context);
    expect(deps.check).toHaveBeenCalledTimes(3);
  });

  it("loads only matching catalogs within the check interval", async () => {
    const { checker, deps } = setup();
    await checker.check(installed);
    const key = installedPluginCatalogKey(installed);
    expect(readCachedPluginUpdateResults(deps.storage, key, deps.now() + AUTO_CHECK_INTERVAL_MS - 1)?.results).toEqual([available]);
    expect(readCachedPluginUpdateResults(deps.storage, key, deps.now() + AUTO_CHECK_INTERVAL_MS)).toBeUndefined();
    expect(readCachedPluginUpdateResults(deps.storage, key, deps.now() - 1)).toBeUndefined();
    for (const patch of [{ version: "0.3.0" }, { sourceChecksum: "c".repeat(64) }, { installedAt: "later" }, { stagedPath: "replacement" }]) {
      const changedKey = installedPluginCatalogKey([{ ...installed[0]!, record: { ...installed[0]!.record, ...patch } }]);
      expect(readCachedPluginUpdateResults(deps.storage, changedKey, deps.now())).toBeUndefined();
    }
    expect(readCachedPluginUpdateResults(deps.storage, installedPluginCatalogKey([]), deps.now())).toBeUndefined();
  });

  it.each([
    "{", "null", "[]", "42", '"cache"', "{}",
    JSON.stringify({ catalogKey: installedPluginCatalogKey(installed), checkedAt: "1000000000", results: [upToDate] }),
    ...[null, {}, [null], [failed], [{ ...available, offer: null }], [{ ...available, offer: {} }],
      [{ ...upToDate, latestVersion: 1 }], [{ ...unsupported, installedVersion: null }],
      [{ ...available, offer: { ...offer, compressedBytes: "100" } }]
    ].map(results => JSON.stringify({ catalogKey: installedPluginCatalogKey(installed), checkedAt: 1_000_000_000, results }))
  ])("ignores malformed or wrong-shape stored results: %s", value => {
    const { deps } = setup();
    deps.storage.setItem(LAST_PLUGIN_RESULTS_KEY, value);
    expect(readCachedPluginUpdateResults(deps.storage, installedPluginCatalogKey(installed), deps.now())).toBeUndefined();
  });

  it("ignores storage read and write failures while publishing fresh results", async () => {
    const { deps } = setup();
    vi.spyOn(deps.storage, "getItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    vi.spyOn(deps.storage, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    const checker = createPluginUpdateChecker(deps);
    expect(readCachedPluginUpdateResults(deps.storage, installedPluginCatalogKey(installed), deps.now())).toBeUndefined();
    checker.restore(installed);
    expect(deps.onResults).not.toHaveBeenCalled();
    await checker.automatic(context);
    expect(deps.onResults).toHaveBeenCalledWith({
      catalogKey: installedPluginCatalogKey(installed), checkedAt: deps.now(), results: [available]
    });
  });

  it.each(["macos", "windows"])("delays the desktop check on %s by 15 seconds and checks again daily", async () => {
    vi.useFakeTimers();
    const { checker, deps, advance } = setup();
    const stop = schedulePluginUpdateAutoCheck(() => checker.automatic(context), () => checker.nextAutomaticCheckDelay(installed));
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_DELAY_MS - 1);
    expect(deps.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.check).toHaveBeenCalledOnce();
    advance(AUTO_CHECK_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_INTERVAL_MS);
    expect(deps.check).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_INTERVAL_MS);
    expect(deps.check).toHaveBeenCalledTimes(2);
  });

  it("cancels the launch request when disabled or unmounted before the delay", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    schedulePluginUpdateAutoCheck(run, () => AUTO_CHECK_DELAY_MS)();
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_DELAY_MS);
    expect(run).not.toHaveBeenCalled();
  });

  it("schedules a recent persisted success at its due time after a skipped launch attempt", async () => {
    vi.useFakeTimers();
    const { checker, deps, advance, saveSuccess } = setup();
    const remaining = 60 * 60 * 1000;
    saveSuccess(deps.now() - AUTO_CHECK_INTERVAL_MS + remaining);
    await checker.automatic(context);
    expect(deps.check).not.toHaveBeenCalled();
    const stop = schedulePluginUpdateAutoCheck(() => checker.automatic(context), () => checker.nextAutomaticCheckDelay(installed));
    advance(remaining - 1);
    await vi.advanceTimersByTimeAsync(remaining - 1);
    expect(deps.check).not.toHaveBeenCalled();
    advance(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.check).toHaveBeenCalledOnce();
    stop();
  });

  it("does not postpone the due time when the effect reschedules", async () => {
    vi.useFakeTimers();
    const { checker, deps, advance, saveSuccess } = setup();
    const remaining = 60 * 60 * 1000;
    saveSuccess(deps.now() - AUTO_CHECK_INTERVAL_MS + remaining);
    const schedule = () => schedulePluginUpdateAutoCheck(() => checker.automatic(context), () => checker.nextAutomaticCheckDelay(installed));
    const stop = schedule();
    advance(remaining / 2);
    await vi.advanceTimersByTimeAsync(remaining / 2);
    stop();
    const stopAgain = schedule();
    advance(remaining / 2);
    await vi.advanceTimersByTimeAsync(remaining / 2);
    expect(deps.check).toHaveBeenCalledOnce();
    stopAgain();
  });

  it("recomputes the deadline after a skipped timer attempt", async () => {
    vi.useFakeTimers();
    const { checker, deps, advance, saveSuccess } = setup();
    const stop = schedulePluginUpdateAutoCheck(() => checker.automatic(context), () => checker.nextAutomaticCheckDelay(installed));
    // Another successful check changes the deadline while the launch timer is pending.
    saveSuccess();
    advance(AUTO_CHECK_DELAY_MS);
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_DELAY_MS);
    expect(deps.check).not.toHaveBeenCalled();
    advance(AUTO_CHECK_INTERVAL_MS - AUTO_CHECK_DELAY_MS);
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_INTERVAL_MS - AUTO_CHECK_DELAY_MS);
    expect(deps.check).toHaveBeenCalledOnce();
    stop();
  });

  it("bounds the next delay by both the last success and the in-session attempt", () => {
    const now = 1_000_000_000;
    expect(nextPluginUpdateAutoCheckDelay(now, now - 1000, now - 500)).toBe(AUTO_CHECK_INTERVAL_MS - 500);
    for (const invalid of [undefined, NaN, now + 1, now - AUTO_CHECK_INTERVAL_MS]) {
      expect(nextPluginUpdateAutoCheckDelay(now, invalid, undefined)).toBe(AUTO_CHECK_DELAY_MS);
    }
  });

  it("does not rearm the timer when unmounted during a request", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const stop = schedulePluginUpdateAutoCheck(run, () => AUTO_CHECK_DELAY_MS);
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_DELAY_MS);
    stop();
    finish();
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_INTERVAL_MS);
    expect(run).toHaveBeenCalledOnce();
  });

  it.each([
    { enabled: false }, { isDesktop: false }, { catalogReady: false }, { installed: [] },
    { installed: [{ ...installed[0]!, record: { ...installed[0]!.record, id: "org.example.local" } }] }
  ])("makes no automatic request when ineligible: %j", async overrides => {
    const { checker, deps } = setup();
    await checker.automatic({ ...context, ...overrides });
    expect(deps.check).not.toHaveBeenCalled();
    expect(deps.setStatus).not.toHaveBeenCalled();
  });

  it("keeps the manual check available when the preference is off", async () => {
    const { checker, deps } = setup();
    await checker.automatic({ ...context, enabled: false });
    await expect(checker.check(installed)).resolves.toEqual([available]);
    expect(deps.check).toHaveBeenCalledOnce();
  });

  it.each([undefined, "NaN", "1000000001", String(1_000_000_000 - AUTO_CHECK_INTERVAL_MS)])(
    "is due with missing, invalid, future or day-old timestamp %s", async value => {
      const { checker, deps } = setup();
      if (value !== undefined) deps.storage.setItem(LAST_PLUGIN_CHECK_KEY, value);
      await checker.automatic(context);
      expect(deps.check).toHaveBeenCalledOnce();
    }
  );

  it("skips checks for a recent success, then becomes due at 24 hours", async () => {
    const { checker, deps, advance, saveSuccess } = setup();
    saveSuccess();
    expect(checker.nextAutomaticCheckDelay(installed)).toBe(AUTO_CHECK_INTERVAL_MS);
    await checker.automatic(context);
    advance(AUTO_CHECK_INTERVAL_MS - 1);
    await checker.automatic(context);
    expect(deps.check).not.toHaveBeenCalled();
    advance(1);
    await checker.automatic(context);
    expect(deps.check).toHaveBeenCalledOnce();
  });

  it.each([[available], [upToDate], [failed, upToDate]])("records a timestamp only when a source answers: %j", async (...results) => {
    const { checker, deps } = setup(results);
    await checker.automatic(context);
    expect(deps.storage.getItem(LAST_PLUGIN_CHECK_KEY)).toBe(String(deps.now()));
  });

  it.each([[failed], [failed, unsupported], [unsupported], []])("does not record an unanswered check: %j", async (...results) => {
    const { checker, deps } = setup(results);
    await checker.automatic(context);
    expect(deps.storage.getItem(LAST_PLUGIN_CHECK_KEY)).toBeNull();
    expect(deps.storage.getItem(LAST_PLUGIN_RESULTS_KEY)).toBeNull();
    expect(deps.setStatus).not.toHaveBeenCalled();
    await checker.automatic(context);
    expect(deps.check).toHaveBeenCalledOnce();
  });

  it("logs automatic source failures without caching failures or showing status text", async () => {
    const { checker, deps } = setup([failed]);
    await checker.automatic(context);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining(pluginId), "Offline");
    expect(deps.onResults).toHaveBeenCalledWith({ catalogKey: installedPluginCatalogKey(installed), checkedAt: deps.now(), results: [] });
    expect(deps.setStatus).not.toHaveBeenCalled();
  });

  it("catches unexpected failures silently, while manual checks still reject", async () => {
    const { checker, deps } = setup();
    deps.check.mockRejectedValue(new Error("Offline"));
    await checker.automatic(context);
    expect(deps.log).toHaveBeenCalled();
    expect(deps.setStatus).not.toHaveBeenCalled();
    expect(deps.storage.getItem(LAST_PLUGIN_CHECK_KEY)).toBeNull();
    await expect(checker.check(installed)).rejects.toThrow("Offline");
  });

  it("shares one in-flight request with manual checks and publishes one complete cache", async () => {
    const { checker, deps } = setup();
    let resolve!: (results: readonly PluginUpdateCheckResult[]) => void;
    deps.check.mockImplementation(() => new Promise(done => { resolve = done; }));
    const automatic = checker.automatic(context);
    const manual = checker.check(installed);
    expect(checker.check(installed)).toBe(manual);
    await Promise.resolve();
    expect(deps.check).toHaveBeenCalledOnce();
    resolve([available, failed]);
    await automatic;
    await expect(manual).resolves.toEqual([available, failed]);
    expect(deps.onResults).toHaveBeenCalledOnce();
    expect(deps.onResults).toHaveBeenCalledWith({ catalogKey: installedPluginCatalogKey(installed), checkedAt: deps.now(), results: [available] });
  });

  it("makes no automatic request after opting out while queued behind a different-catalog manual check", async () => {
    const { checker, deps } = setup();
    let resolve!: (results: readonly PluginUpdateCheckResult[]) => void;
    deps.check.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const otherCatalog = [{ ...installed[0]!, record: { ...installed[0]!.record, version: "0.0.1" } }];
    const manual = checker.check(otherCatalog);
    await Promise.resolve();
    let enabled = true;
    const automatic = checker.automatic(context, () => enabled);
    enabled = false;
    resolve([upToDate]);
    await manual;
    await automatic;
    expect(deps.check).toHaveBeenCalledOnce();
    expect(deps.check).toHaveBeenCalledWith(otherCatalog);
    expect(deps.onResults).toHaveBeenCalledOnce();
    expect(deps.setStatus).not.toHaveBeenCalled();
  });

  it("runs manual B after queued automatic B is cancelled while catalog A is still running", async () => {
    const { checker, deps } = setup();
    let resolveA!: (results: readonly PluginUpdateCheckResult[]) => void;
    let resolveB!: (results: readonly PluginUpdateCheckResult[]) => void;
    deps.check.mockImplementationOnce(() => new Promise(done => { resolveA = done; }));
    deps.check.mockImplementationOnce(() => new Promise(done => { resolveB = done; }));
    const catalogA = [{ ...installed[0]!, record: { ...installed[0]!.record, version: "0.0.1" } }];
    const manualA = checker.check(catalogA);
    await Promise.resolve();
    let enabled = true;
    const automaticB = checker.automatic(context, () => enabled);
    enabled = false;
    const manualB = checker.check(installed);
    expect(deps.check).toHaveBeenCalledOnce();
    resolveA([]);
    await manualA;
    await automaticB;
    expect(deps.storage.getItem(LAST_PLUGIN_CHECK_KEY)).toBeNull();
    expect(deps.onResults).toHaveBeenCalledOnce();
    expect(deps.onResults).toHaveBeenCalledWith({ catalogKey: installedPluginCatalogKey(catalogA), checkedAt: deps.now(), results: [] });
    expect(deps.setStatus).not.toHaveBeenCalled();
    expect(deps.check).toHaveBeenCalledTimes(2);
    expect(deps.check).toHaveBeenLastCalledWith(installed);
    resolveB([available]);
    await expect(manualB).resolves.toEqual([available]);
    expect(deps.storage.getItem(LAST_PLUGIN_CHECK_KEY)).toBe(String(deps.now()));
    expect(deps.onResults).toHaveBeenCalledTimes(2);
    expect(deps.onResults).toHaveBeenLastCalledWith({ catalogKey: installedPluginCatalogKey(installed), checkedAt: deps.now(), results: [available] });
  });

  it("remembers each plugin@version across launches and announces a newer version again", async () => {
    const { checker, deps, advance } = setup();
    await checker.automatic(context);
    expect(deps.setStatus).toHaveBeenCalledWith("NMR Shift Predictor 0.2.0 is available — Plugins ▸ Plugin Updates Available…");
    expect(JSON.parse(deps.storage.getItem(ANNOUNCED_PLUGIN_VERSIONS_KEY)!)).toEqual([`${pluginId}@0.2.0`]);
    advance(AUTO_CHECK_INTERVAL_MS);
    const nextLaunch = createPluginUpdateChecker(deps);
    await nextLaunch.automatic(context);
    expect(deps.setStatus).toHaveBeenCalledOnce();
    advance(AUTO_CHECK_INTERVAL_MS);
    deps.check.mockResolvedValue([{ ...available, latestVersion: "0.3.0", offer: { ...offer, version: "0.3.0" } }]);
    await nextLaunch.automatic(context);
    expect(deps.setStatus).toHaveBeenCalledTimes(2);
    expect(deps.setStatus).toHaveBeenLastCalledWith(expect.stringContaining("0.3.0 is available"));
  });

  it("binds cached offers to the full installed catalog fingerprint", () => {
    for (const patch of [{ version: "0.3.0" }, { sourceChecksum: "c".repeat(64) }, { installedAt: "later" }, { stagedPath: "replacement" }]) {
      expect(installedPluginCatalogKey([{ ...installed[0]!, record: { ...installed[0]!.record, ...patch } }]))
        .not.toBe(installedPluginCatalogKey(installed));
    }
  });
});
