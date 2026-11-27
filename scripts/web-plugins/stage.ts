/**
 * Stage released plugin packages for the browser build (see `apps/desktop/src/plugins/webPreloadedPlugins.ts`).
 *
 *   node scripts/stage-web-plugins.mjs <plugin.zip> [...more zips] [--out <dir>]
 *   pnpm --filter @chemdraft/desktop stage:web-plugins -- <plugin.zip> [--out <dir>]
 *
 * Each zip must have its `<zip>.sha256` sidecar beside it. Every package runs the same fail-closed
 * gates an install runs, through the same code (`inspectPluginPackage`): sidecar checksum, per-entry
 * CRC-32, size and entry-count limits, path-traversal refusal, manifest schema, entry present,
 * `apiVersion` compatibility. Staging adds its own preflight: no two entries that would collide on disk
 * (one path a file and another's directory, or two paths equal up to letter case), and no plugin id equal
 * up to letter case to another one being staged or already in the index (they would share a directory on
 * the case-insensitive filesystems of macOS and Windows). Only when **every** zip passes is anything
 * written.
 *
 * Writing is all-or-nothing across the whole set: every plugin is unpacked into a hidden temporary
 * sibling first, then each `<out>/<pluginId>/` is swapped in by rename (never written in place) and
 * `<out>/index.json` is rewritten atomically last. If any step fails, every directory already swapped is
 * put back and the index is left as it was.
 *
 * The default output, `apps/desktop/.web-plugins/`, is gitignored: a preloaded plugin's code and data
 * never enter this repository.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_PLUGIN_PACKAGE_ARCHIVE_LIMITS,
  PluginPackageError,
  PluginPackageErrorCodes
} from "../../apps/desktop/src/plugins/pluginPackageArchive";
import {
  PluginInstallError,
  PluginInstallErrorCodes,
  inspectPluginPackage,
  type PluginPackageInspection
} from "../../apps/desktop/src/plugins/pluginPackageInspection";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_WEB_PLUGINS_OUT_DIR = join(REPO_ROOT, "apps", "desktop", ".web-plugins");
export const WEB_PLUGINS_INDEX_FILE = "index.json";
export const WEB_PLUGINS_INDEX_VERSION = 1;

/** Mirrors `isSafeWebPluginDirName` in webPreloadedPlugins.ts: one segment, not hidden, not the index. */
const SAFE_DIR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function isSafeWebPluginDirName(name: string): boolean {
  return SAFE_DIR_PATTERN.test(name) && !name.endsWith(".") && name.toLowerCase() !== WEB_PLUGINS_INDEX_FILE;
}

export interface WebPluginIndexEntry {
  id: string;
  version: string;
  dir: string;
  sha256: string;
}

export interface WebPluginIndex {
  version: typeof WEB_PLUGINS_INDEX_VERSION;
  plugins: WebPluginIndexEntry[];
}

/** A refusal that names the zip and the gate it failed. */
export class WebPluginStageError extends Error {
  constructor(
    readonly zipPath: string,
    readonly gate: string,
    detail: string
  ) {
    super(`${zipPath}: ${gate} gate failed: ${detail}`);
    this.name = "WebPluginStageError";
  }
}

const GATE_BY_CODE: Readonly<Record<string, string>> = {
  [PluginPackageErrorCodes.ChecksumMismatch]: "sha256",
  [PluginPackageErrorCodes.DigestUnavailable]: "sha256",
  [PluginPackageErrorCodes.CorruptEntry]: "CRC",
  [PluginPackageErrorCodes.UnsafeEntryPath]: "path traversal",
  [PluginPackageErrorCodes.ResourceLimitExceeded]: "size limit",
  [PluginPackageErrorCodes.MalformedArchive]: "archive",
  [PluginPackageErrorCodes.UnsupportedArchive]: "archive",
  [PluginInstallErrorCodes.ManifestMissing]: "manifest",
  [PluginInstallErrorCodes.ManifestInvalid]: "manifest",
  [PluginInstallErrorCodes.EntryMissing]: "manifest entry",
  [PluginInstallErrorCodes.IncompatibleApiVersion]: "apiVersion"
};

function gateError(zipPath: string, cause: unknown): WebPluginStageError {
  if (cause instanceof WebPluginStageError) return cause;
  if (cause instanceof PluginPackageError || cause instanceof PluginInstallError) {
    return new WebPluginStageError(zipPath, GATE_BY_CODE[cause.code] ?? "package", cause.message);
  }
  return new WebPluginStageError(zipPath, "package", cause instanceof Error ? cause.message : String(cause));
}

export interface InspectedWebPlugin {
  zipPath: string;
  inspection: PluginPackageInspection;
}

/** Run every install gate on one zip. Nothing is written. */
export async function inspectWebPluginZip(zipPath: string, options: { hostApiVersion?: string } = {}): Promise<InspectedWebPlugin> {
  let size: number;
  try {
    size = statSync(zipPath).size;
  } catch (cause) {
    throw new WebPluginStageError(zipPath, "read", `cannot read the zip (${(cause as NodeJS.ErrnoException).code ?? String(cause)}).`);
  }
  // Refuse before reading a huge file into memory; the archive reader re-checks the same limit.
  if (size > DEFAULT_PLUGIN_PACKAGE_ARCHIVE_LIMITS.maxCompressedBytes) {
    throw new WebPluginStageError(
      zipPath,
      "size limit",
      `the zip is ${size} bytes, exceeding ChemDraft's ${DEFAULT_PLUGIN_PACKAGE_ARCHIVE_LIMITS.maxCompressedBytes}-byte package limit.`
    );
  }
  const sidecarPath = `${zipPath}.sha256`;
  if (!existsSync(sidecarPath)) {
    throw new WebPluginStageError(zipPath, "sha256", `no ${sidecarPath} beside it. Download the release's .zip.sha256 too.`);
  }
  const zipBytes = new Uint8Array(readFileSync(zipPath));
  const sidecar = readFileSync(sidecarPath, "utf8");

  let inspection: PluginPackageInspection;
  try {
    inspection = await inspectPluginPackage({ zipBytes, sidecar, hostApiVersion: options.hostApiVersion });
  } catch (cause) {
    throw gateError(zipPath, cause);
  }

  const id = inspection.manifest.id;
  if (!isSafeWebPluginDirName(id)) {
    throw new WebPluginStageError(zipPath, "manifest", `plugin id "${id}" cannot be used as a directory name.`);
  }
  // The archive reader refuses traversal; also refuse two entries that would land on one file on a
  // case-insensitive filesystem (macOS, Windows), where the second would silently overwrite the first.
  const seen = new Set<string>();
  for (const entry of inspection.entries) {
    const key = entry.path.toLowerCase();
    if (seen.has(key)) {
      throw new WebPluginStageError(zipPath, "path traversal", `two entries resolve to the same file "${entry.path}".`);
    }
    seen.add(key);
  }
  // A file cannot also be a directory another entry is written beneath ("x" and "x/y", or "X" and
  // "x/y" on a case-insensitive filesystem). Refused here so the write phase never meets it.
  const directories = new Map<string, string>();
  for (const entry of inspection.entries) {
    const segments = entry.path.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      const key = segments.slice(0, length).join("/").toLowerCase();
      if (!directories.has(key)) directories.set(key, entry.path);
    }
  }
  for (const entry of inspection.entries) {
    const child = directories.get(entry.path.toLowerCase());
    if (child !== undefined) {
      throw new WebPluginStageError(
        zipPath,
        "file collision",
        `"${entry.path}" is a file, but "${child}" needs a directory at the same path.`
      );
    }
  }
  return { zipPath, inspection };
}

function readIndex(outDir: string): WebPluginIndex {
  const indexPath = join(outDir, WEB_PLUGINS_INDEX_FILE);
  if (!existsSync(indexPath)) return { version: WEB_PLUGINS_INDEX_VERSION, plugins: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(indexPath, "utf8"));
  } catch {
    parsed = undefined;
  }
  const candidate = parsed as Partial<WebPluginIndex> | undefined;
  if (!candidate || candidate.version !== WEB_PLUGINS_INDEX_VERSION || !Array.isArray(candidate.plugins)) {
    throw new Error(
      `${indexPath} exists but is not a version-${WEB_PLUGINS_INDEX_VERSION} staging index. ` +
        "Remove it, or pass --out with a different directory."
    );
  }
  return { version: WEB_PLUGINS_INDEX_VERSION, plugins: candidate.plugins.filter((entry) => isSafeWebPluginDirName(entry?.dir ?? "")) };
}

function uniqueSibling(outDir: string, label: string): string {
  return join(outDir, `.${label}-${process.pid}-${randomBytes(4).toString("hex")}`);
}

/** Unpack one inspected package into `dir`, which must not exist yet. */
function writePackageFiles(dir: string, { zipPath, inspection }: InspectedWebPlugin): void {
  mkdirSync(dir);
  for (const entry of inspection.entries) {
    const file = join(dir, ...entry.path.split("/"));
    // Restate the traversal guarantee at the boundary that writes, separator-agnostically.
    const inside = relative(dir, file);
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) {
      throw new WebPluginStageError(zipPath, "path traversal", `refusing to write "${entry.path}" outside the plugin directory.`);
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, entry.bytes);
  }
}

function writeIndex(outDir: string, index: WebPluginIndex): void {
  const indexPath = join(outDir, WEB_PLUGINS_INDEX_FILE);
  const temp = uniqueSibling(outDir, "index");
  try {
    writeFileSync(temp, `${JSON.stringify(index, null, 2)}\n`);
    renameSync(temp, indexPath);
  } finally {
    rmSync(temp, { force: true });
  }
}

interface PlannedSwap {
  id: string;
  target: string;
  temp: string;
  /** Where the previous copy was moved aside, once it has been. */
  old?: string;
  /** True once the new copy is at `target`. */
  placed: boolean;
}

/** Undo every swap, newest first. Returns a description of anything that could not be restored. */
function rollBack(swaps: readonly PlannedSwap[]): string[] {
  const stranded: string[] = [];
  for (const swap of [...swaps].reverse()) {
    try {
      if (swap.placed) rmSync(swap.target, { recursive: true, force: true });
      if (swap.old !== undefined) renameSync(swap.old, swap.target);
    } catch (cause) {
      stranded.push(
        swap.old !== undefined
          ? `${swap.id}: the previous copy is at ${swap.old} (${messageOf(cause)}); move it back to ${swap.target}`
          : `${swap.id}: ${swap.target} could not be removed (${messageOf(cause)})`
      );
    }
  }
  return stranded;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Write every plugin and the index as one unit: unpack all into temporary siblings, swap them in, write
 * the index. Any failure puts back every directory already swapped and leaves the index untouched.
 */
function commitStaging(outDir: string, plugins: readonly InspectedWebPlugin[], index: WebPluginIndex): void {
  const swaps: PlannedSwap[] = plugins.map((plugin) => {
    const id = plugin.inspection.manifest.id;
    return { id, target: join(outDir, id), temp: uniqueSibling(outDir, `staging-${id}`), placed: false };
  });
  const moved: PlannedSwap[] = [];
  let committed = false;
  try {
    plugins.forEach((plugin, i) => writePackageFiles(swaps[i].temp, plugin));
    for (const swap of swaps) {
      moved.push(swap);
      // Two renames: a directory cannot be renamed over a non-empty one on Windows.
      if (existsSync(swap.target)) {
        const old = uniqueSibling(outDir, `old-${swap.id}`);
        renameSync(swap.target, old);
        swap.old = old;
      }
      renameSync(swap.temp, swap.target);
      swap.placed = true;
    }
    writeIndex(outDir, index);
    committed = true;
  } catch (cause) {
    const stranded = rollBack(moved);
    if (stranded.length > 0) {
      throw new Error(`${messageOf(cause)}. Rolling back also failed, so fix these by hand: ${stranded.join("; ")}.`, { cause });
    }
    throw cause;
  } finally {
    for (const swap of swaps) {
      // Best effort: a leftover hidden sibling is never served, copied, or read as a plugin.
      try {
        rmSync(swap.temp, { recursive: true, force: true });
        if (committed && swap.old !== undefined) rmSync(swap.old, { recursive: true, force: true });
      } catch {
        // Ignored; see above.
      }
    }
  }
}

export interface StageWebPluginsResult {
  outDir: string;
  staged: WebPluginIndexEntry[];
  index: WebPluginIndex;
}

/**
 * Inspect every zip, then (only if all pass) stage them and update the index. Throws an
 * `AggregateError` of {@link WebPluginStageError}s when any zip is refused.
 */
export async function stageWebPlugins(
  zipPaths: readonly string[],
  options: { outDir?: string; hostApiVersion?: string } = {}
): Promise<StageWebPluginsResult> {
  if (zipPaths.length === 0) throw new Error("No plugin zip given.");
  const outDir = resolve(options.outDir ?? DEFAULT_WEB_PLUGINS_OUT_DIR);

  const inspected: InspectedWebPlugin[] = [];
  const errors: WebPluginStageError[] = [];
  for (const zipPath of zipPaths) {
    try {
      inspected.push(await inspectWebPluginZip(zipPath, options));
    } catch (cause) {
      errors.push(gateError(zipPath, cause));
    }
  }
  // Plugin ids become directory names, so ids equal up to letter case would share one directory on a
  // case-insensitive filesystem (macOS, Windows). Compare case-folded, among the incoming set and
  // against what is already staged.
  const index = readIndex(outDir);
  const ids = new Map<string, { id: string; zipPath: string }>();
  for (const { zipPath, inspection } of inspected) {
    const id = inspection.manifest.id;
    const folded = id.toLowerCase();
    const earlier = ids.get(folded);
    if (earlier?.id === id) {
      errors.push(new WebPluginStageError(zipPath, "duplicate id", `"${id}" is also in ${earlier.zipPath}.`));
    } else if (earlier) {
      errors.push(
        new WebPluginStageError(
          zipPath,
          "id case collision",
          `"${id}" differs only in letter case from "${earlier.id}" in ${earlier.zipPath}; on a case-insensitive ` +
            "filesystem (macOS, Windows) they would share one directory."
        )
      );
    } else {
      ids.set(folded, { id, zipPath });
    }
    const existing = index.plugins.find(
      (entry) => entry.id !== id && (entry.id.toLowerCase() === folded || entry.dir.toLowerCase() === folded)
    );
    if (existing) {
      errors.push(
        new WebPluginStageError(
          zipPath,
          "id case collision",
          `"${id}" differs only in letter case from the already staged "${existing.id}" (${join(outDir, existing.dir)}); ` +
            "on a case-insensitive filesystem (macOS, Windows) they would share one directory. Stage it under the " +
            `same id, or remove "${existing.id}" from ${join(outDir, WEB_PLUGINS_INDEX_FILE)} and its directory first.`
        )
      );
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, errors.map((error) => error.message).join("\n"));
  }

  const staged: WebPluginIndexEntry[] = inspected.map(({ inspection: { manifest, sourceChecksum } }) => ({
    id: manifest.id,
    version: manifest.version,
    dir: manifest.id,
    sha256: sourceChecksum
  }));
  const stagedIds = new Set(staged.map((entry) => entry.id));
  const next: WebPluginIndex = {
    version: WEB_PLUGINS_INDEX_VERSION,
    plugins: [...index.plugins.filter((entry) => !stagedIds.has(entry.id)), ...staged].sort((a, b) => a.id.localeCompare(b.id))
  };
  mkdirSync(outDir, { recursive: true });
  commitStaging(outDir, inspected, next);
  return { outDir, staged, index: next };
}

const USAGE = "Usage: node scripts/stage-web-plugins.mjs <plugin.zip> [...more zips] [--out <dir>]";

/** CLI entry. Returns the exit code: 0 staged, 1 a package was refused, 2 bad arguments. */
export async function main(
  argv: readonly string[],
  io: { cwd?: string; log?: (line: string) => void; error?: (line: string) => void } = {}
): Promise<number> {
  const cwd = io.cwd ?? process.cwd();
  const log = io.log ?? ((line: string) => console.log(line));
  const error = io.error ?? ((line: string) => console.error(line));
  const zips: string[] = [];
  let outDir: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      log(USAGE);
      return 0;
    }
    if (arg === "--out") {
      const value = argv[i + 1];
      if (!value) {
        error(`--out needs a directory.\n${USAGE}`);
        return 2;
      }
      outDir = resolve(cwd, value);
      i += 1;
      continue;
    }
    if (arg.startsWith("--out=")) {
      outDir = resolve(cwd, arg.slice("--out=".length));
      continue;
    }
    if (arg.startsWith("-")) {
      error(`Unknown option ${arg}.\n${USAGE}`);
      return 2;
    }
    zips.push(resolve(cwd, arg));
  }
  if (zips.length === 0) {
    error(USAGE);
    return 2;
  }
  try {
    const result = await stageWebPlugins(zips, { outDir });
    for (const entry of result.staged) {
      log(`Staged ${entry.id} ${entry.version} -> ${join(result.outDir, entry.dir)}`);
    }
    log(`Index: ${join(result.outDir, WEB_PLUGINS_INDEX_FILE)} (${result.index.plugins.length} plugin(s))`);
    return 0;
  } catch (cause) {
    const refused = cause instanceof AggregateError;
    for (const failure of refused ? cause.errors : [cause]) {
      error(`stage-web-plugins: ${failure instanceof Error ? failure.message : String(failure)}`);
    }
    // A refusal happens before anything is written. Any other error came from the filesystem while
    // writing, and the whole set was rolled back (the message says so if rolling back failed too).
    error(refused ? "Nothing was staged." : "Staging stopped; every staged plugin and the index were left as they were.");
    return 1;
  }
}
