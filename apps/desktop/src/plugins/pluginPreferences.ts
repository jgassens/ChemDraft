const DISABLED_PLUGIN_IDS_STORAGE_KEY = "chemdraft.plugins.disabled";

/** Load the bundled-plugin ids the user disabled. Storage is best-effort: SSR, blocked storage,
 * malformed JSON, and stale values all fall back safely instead of preventing app startup. */
export function loadDisabledPluginIds(): Set<string> {
  if (typeof window === "undefined") {
    return new Set();
  }
  try {
    const raw = window.localStorage?.getItem(DISABLED_PLUGIN_IDS_STORAGE_KEY);
    if (!raw) {
      return new Set();
    }

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return new Set();
    }

    return new Set(parsed.filter((value): value is string => typeof value === "string" && value.length > 0));
  } catch {
    return new Set();
  }
}

/** Persist disabled ids in deterministic order so the preference remains stable and inspectable. */
export function saveDisabledPluginIds(ids: ReadonlySet<string>): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const serialized = [...ids].filter((id) => id.length > 0).sort();
    window.localStorage?.setItem(DISABLED_PLUGIN_IDS_STORAGE_KEY, JSON.stringify(serialized));
  } catch {
    // Persistence is best-effort (private browsing, disabled storage, quota errors).
  }
}
