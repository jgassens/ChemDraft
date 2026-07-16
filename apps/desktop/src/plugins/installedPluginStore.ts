/**
 * The record of what is installed (M36, ADR-0029 §6).
 *
 * One JSON file in the app-data directory, alongside the staging root, listing every installed plugin:
 * id, version, staged path, and the source archive's checksum.
 *
 * ## Why a file and not localStorage
 *
 * M32's *disabled-plugin* preference lives in localStorage, and this could have too. It does not, for a
 * reason worth stating: localStorage is **origin-keyed**, while the thing these records describe — the
 * staged bytes — lives on **disk**. Keeping the index next to the bytes means the two cannot be
 * separated by anything that happens to the origin, and it keeps "what is installed" answerable from the
 * filesystem alone. The two stores coexist by design and are read independently: an installed plugin can
 * be disabled exactly like a bundled one, and the disabled-id set is the only thing that decides it.
 *
 * The store is deliberately tolerant on read and strict on write. A malformed or partially-written
 * records file must never prevent the app from starting, so unreadable records are dropped rather than
 * thrown; a plugin whose record survives but whose staged directory does not is reported as missing so
 * the manager can say so honestly rather than failing to load it in the background.
 */

import { INSTALLED_PLUGINS_RECORD_FILE, installedPluginStagingDir } from "./installedPluginPaths";
import type { PluginStagingFs } from "./pluginStagingFs";

/** What was installed, and where its bytes went. */
export interface InstalledPluginRecord {
  /** Manifest id. Also the staging directory name and the URL segment it is served from. */
  id: string;
  /** Manifest version at install time — the installed bytes' version, not the latest available. */
  version: string;
  /** Display name at install time, so the manager can list a plugin without unpacking it. */
  name: string;
  /** App-data-relative staging directory. Derivable from `id`, but recorded so a future layout change
   *  can relocate packages without orphaning the ones already installed. */
  stagedPath: string;
  /** SHA-256 of the source archive. Provenance/integrity only, never a trust gate (ADR-0029 §4). */
  sourceChecksum: string;
  /** ISO-8601 install time. */
  installedAt: string;
}

interface RecordsDocument {
  version: 1;
  plugins: InstalledPluginRecord[];
}

const RECORDS_VERSION = 1;

/** Read the install records. Never throws: a broken file is treated as "nothing installed". */
export async function loadInstalledPluginRecords(fs: PluginStagingFs): Promise<readonly InstalledPluginRecord[]> {
  let raw: string | undefined;
  try {
    raw = await fs.readTextFile(INSTALLED_PLUGINS_RECORD_FILE);
  } catch {
    // No app-data dir, an unreadable file, a denied scope: startup must survive all of it.
    return [];
  }
  if (!raw) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") {
      return [];
    }
    const plugins = (parsed as Partial<RecordsDocument>).plugins;
    if (!Array.isArray(plugins)) {
      return [];
    }
    return plugins.filter(isInstalledPluginRecord);
  } catch {
    return [];
  }
}

/** Persist the records, ordered by id so the file stays stable and diffable. */
export async function saveInstalledPluginRecords(
  fs: PluginStagingFs,
  records: readonly InstalledPluginRecord[]
): Promise<void> {
  const document: RecordsDocument = {
    version: RECORDS_VERSION,
    plugins: [...records].sort((left, right) => left.id.localeCompare(right.id))
  };
  await fs.writeTextFile(INSTALLED_PLUGINS_RECORD_FILE, `${JSON.stringify(document, null, 2)}\n`);
}

/** Add or replace a record, keyed by id. */
export async function upsertInstalledPluginRecord(
  fs: PluginStagingFs,
  record: InstalledPluginRecord
): Promise<readonly InstalledPluginRecord[]> {
  const existing = await loadInstalledPluginRecords(fs);
  const next = [...existing.filter((candidate) => candidate.id !== record.id), record];
  await saveInstalledPluginRecords(fs, next);
  return next;
}

/** Forget a record. Returns the remaining records. */
export async function removeInstalledPluginRecord(
  fs: PluginStagingFs,
  pluginId: string
): Promise<readonly InstalledPluginRecord[]> {
  const existing = await loadInstalledPluginRecords(fs);
  const next = existing.filter((candidate) => candidate.id !== pluginId);
  await saveInstalledPluginRecords(fs, next);
  return next;
}

/** Build the record for a freshly staged package. */
export function createInstalledPluginRecord(options: {
  id: string;
  version: string;
  name: string;
  sourceChecksum: string;
  installedAt?: Date;
}): InstalledPluginRecord {
  return {
    id: options.id,
    version: options.version,
    name: options.name,
    stagedPath: installedPluginStagingDir(options.id),
    sourceChecksum: options.sourceChecksum,
    installedAt: (options.installedAt ?? new Date()).toISOString()
  };
}

function isInstalledPluginRecord(candidate: unknown): candidate is InstalledPluginRecord {
  if (candidate === null || typeof candidate !== "object") {
    return false;
  }
  const record = candidate as Partial<InstalledPluginRecord>;
  return (
    isNonEmptyString(record.id) &&
    isNonEmptyString(record.version) &&
    isNonEmptyString(record.name) &&
    isNonEmptyString(record.stagedPath) &&
    isNonEmptyString(record.sourceChecksum) &&
    isNonEmptyString(record.installedAt)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
