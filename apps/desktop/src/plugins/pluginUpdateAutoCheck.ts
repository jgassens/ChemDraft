import { AUTO_CHECK_DELAY_MS, AUTO_CHECK_INTERVAL_MS, autoCheckDue } from "../appUpdates";
import type { InstalledPluginCatalogEntry } from "./installPluginPackage";
import { OFFICIAL_PLUGIN_CATALOG, type PluginUpdateCheckResult } from "./pluginUpdates";

export const LAST_PLUGIN_CHECK_KEY = "chemdraft.pluginUpdates.lastCheckedAt.v1";
export const ANNOUNCED_PLUGIN_VERSIONS_KEY = "chemdraft.pluginUpdates.announcedVersions.v1";
type UpdateStorage = Pick<Storage, "getItem" | "setItem">;

export interface CachedPluginUpdateResults {
  catalogKey: string;
  results: readonly PluginUpdateCheckResult[];
}

/** Bind offers to the installed bytes, not just the plugin version. */
export function installedPluginCatalogKey(installedPlugins: readonly InstalledPluginCatalogEntry[]): string {
  return JSON.stringify(
    installedPlugins.map(({ record }) => ({
      id: record.id, version: record.version, sourceChecksum: record.sourceChecksum,
      stagedPath: record.stagedPath, installedAt: record.installedAt
    })).sort((left, right) => left.id.localeCompare(right.id))
  );
}

export function hasOfficialInstalledPlugin(installed: readonly InstalledPluginCatalogEntry[]): boolean {
  return installed.some(entry => OFFICIAL_PLUGIN_CATALOG.some(source => source.pluginId === entry.record.id));
}

export function readLastPluginCheck(storage: UpdateStorage | undefined): number | undefined {
  try {
    const value = storage?.getItem(LAST_PLUGIN_CHECK_KEY);
    return value ? Number(value) : undefined;
  } catch { return undefined; }
}

function readAnnouncements(storage: UpdateStorage | undefined): Set<string> {
  try {
    const value: unknown = JSON.parse(storage?.getItem(ANNOUNCED_PLUGIN_VERSIONS_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch { return new Set(); }
}

interface PluginUpdateCheckerDeps {
  check(installed: readonly InstalledPluginCatalogEntry[]): Promise<readonly PluginUpdateCheckResult[]>;
  onResults(cache: CachedPluginUpdateResults): void;
  setStatus(text: string): void;
  storage: UpdateStorage | undefined;
  now?: () => number;
  log?: (message: string, error: unknown) => void;
}

/** One network check at a time, shared by the manager and the quiet daily check. No install path. */
export function createPluginUpdateChecker(deps: PluginUpdateCheckerDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? console.warn;
  const announced = readAnnouncements(deps.storage);
  let lastAttempt: number | undefined;
  let running: { catalogKey: string; promise: Promise<readonly PluginUpdateCheckResult[]> } | undefined;

  const check = (installed: readonly InstalledPluginCatalogEntry[]): Promise<readonly PluginUpdateCheckResult[]> => {
    const catalogKey = installedPluginCatalogKey(installed);
    if (running) {
      if (running.catalogKey === catalogKey) return running.promise;
      return running.promise.catch(() => undefined).then(() => check(installed));
    }
    const promise = Promise.resolve().then(() => deps.check(installed)).then(results => {
      // A failed/unsupported source is not an answer. Manual successful checks count too.
      if (results.some(result => result.status === "available" || result.status === "upToDate")) {
        try { deps.storage?.setItem(LAST_PLUGIN_CHECK_KEY, String(now())); }
        catch { /* An unavailable store only causes another check next launch. */ }
      }
      // Automatic failures stay out of the UI; the manager retains manual failures locally.
      deps.onResults({ catalogKey, results: results.filter(result => result.status !== "failed") });
      return results;
    }).finally(() => { running = undefined; });
    running = { catalogKey, promise };
    return promise;
  };

  const automatic = async (context: {
    isDesktop: boolean;
    enabled: boolean;
    catalogReady: boolean;
    installed: readonly InstalledPluginCatalogEntry[];
  }): Promise<void> => {
    if (!context.isDesktop || !context.enabled || !context.catalogReady || !hasOfficialInstalledPlugin(context.installed)) return;
    const at = now();
    if (!autoCheckDue(readLastPluginCheck(deps.storage), at) || !autoCheckDue(lastAttempt, at)) return;
    // Also bound retries in this session if all sources fail or persistence is unavailable.
    lastAttempt = at;
    try {
      const results = await check(context.installed);
      const messages: string[] = [];
      for (const result of results) {
        if (result.status === "failed") log(`Automatic plugin update check failed (${result.pluginId}):`, result.message);
        if (result.status !== "available") continue;
        const key = `${result.pluginId}@${result.latestVersion}`;
        if (announced.has(key)) continue;
        announced.add(key);
        messages.push(`${result.offer.pluginName} ${result.latestVersion} is available`);
      }
      if (messages.length) {
        try { deps.storage?.setItem(ANNOUNCED_PLUGIN_VERSIONS_KEY, JSON.stringify([...announced])); }
        catch { /* The in-memory set still prevents repeat notices in this session. */ }
        deps.setStatus(`${messages.join("; ")} — Plugins ▸ Plugin Updates Available…`);
      }
    } catch (error) {
      log("Automatic plugin update check failed:", error);
    }
  };

  return { check, automatic };
}

/** Start after catalog readiness; long-running sessions also check daily. Cleanup cancels both timers. */
export function schedulePluginUpdateAutoCheck(run: () => Promise<void>): () => void {
  let daily: ReturnType<typeof setInterval> | undefined;
  const launch = setTimeout(() => {
    void run();
    daily = setInterval(() => { void run(); }, AUTO_CHECK_INTERVAL_MS);
  }, AUTO_CHECK_DELAY_MS);
  return () => { clearTimeout(launch); clearInterval(daily); };
}
