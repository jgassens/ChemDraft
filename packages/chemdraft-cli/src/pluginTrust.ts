import { existsSync, readFileSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { validateTrustedPluginManifest } from "@chemdraft/plugin-host";

/**
 * Trust gate for plugin code the headless CLI (and the MCP server, which runs the same commands in a
 * long-lived process) loads from a directory outside this workspace.
 *
 * A plugin directory can be chosen by an environment variable, so the directory alone must never
 * decide whether its code runs. Two checks stand in front of the import:
 *
 * A. Allow-list. The directory must be listed, under the plugin's id, in a trust file the owner
 *    edits by hand (`~/.config/chemdraft/trusted-plugins.json`). This runs before any file from the
 *    directory is imported and is what actually bounds which code executes. The file's location is
 *    a function parameter, never an environment variable: whoever can point the CLI at a plugin
 *    directory must not also be able to point it at an allow-list of their choosing. For the same
 *    reason its default is resolved from the OS account database (`os.userInfo().homedir`), never
 *    from `os.homedir()`/`HOME`/`USERPROFILE` — those read the environment, and whoever can set
 *    `CHEMDRAFT_NMR_PLUGIN_DIR` could otherwise also set `HOME` and point the CLI at an allow-list of
 *    their own choosing. If the account's home cannot be determined, there is no default: every
 *    plugin directory is refused rather than falling back to the environment. Nothing in this module
 *    creates or edits the trust file.
 * B. Manifest and permissions. Only after A passes, the plugin's manifest module is imported and
 *    validated through `@chemdraft/plugin-host`; its id must match, and it must not declare a
 *    permission the CLI refuses to grant. Only then is the plugin entry imported.
 */

export class PluginTrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginTrustError";
  }
}

/** The subset of `os.userInfo()`'s return value the default trust-path lookup needs. */
export interface AccountHomeInfo {
  homedir: string;
}

/** A lookup for the effective OS account's home directory. Defaults to `node:os`'s `userInfo`. */
export type AccountHomeLookup = () => AccountHomeInfo;

/**
 * Resolves the plugin trust file's default location from the OS account database — POSIX: the
 * passwd entry for the effective uid; Windows: the profile-directory lookup — never from
 * `os.homedir()`, `HOME`, or `USERPROFILE`. `lookup` is a seam for tests; real callers should never
 * pass it.
 *
 * Fails closed: throws {@link PluginTrustError}, and never falls back to the environment, if the
 * account's home directory cannot be determined (the lookup throws, or returns an empty homedir).
 */
export function resolveDefaultTrustedPluginsPath(lookup: AccountHomeLookup = userInfo): string {
  let info: AccountHomeInfo;
  try {
    info = lookup();
  } catch (error) {
    throw new PluginTrustError(
      `Could not determine the ChemDraft plugin trust file's default location: the OS account home ` +
        `directory lookup failed (${(error as Error).message}). Refusing to fall back to HOME/USERPROFILE for ` +
        "it; pass an explicit trust file path instead."
    );
  }
  if (!info.homedir) {
    throw new PluginTrustError(
      "Could not determine the ChemDraft plugin trust file's default location: the OS account home " +
        "directory lookup returned no home directory. Refusing to fall back to HOME/USERPROFILE for it; " +
        "pass an explicit trust file path instead."
    );
  }
  return join(info.homedir, ".config", "chemdraft", "trusted-plugins.json");
}

/** Set at import time when {@link resolveDefaultTrustedPluginsPath} fails; see its use below. */
let defaultTrustedPluginsPathError: PluginTrustError | undefined;

function resolveDefaultTrustedPluginsPathAtImport(): string {
  try {
    return resolveDefaultTrustedPluginsPath();
  } catch (error) {
    defaultTrustedPluginsPathError = error as PluginTrustError;
    // Never HOME/USERPROFILE: an empty string is not a directory either lookup could point at, and
    // readTrustedPlugins/resolveTrustedPlugin re-throw defaultTrustedPluginsPathError before this
    // value is ever used as a real path.
    return "";
  }
}

export const DEFAULT_TRUSTED_PLUGINS_PATH: string = resolveDefaultTrustedPluginsPathAtImport();

const TRUST_FILE_VERSION = 1;

type PluginManifest = ReturnType<typeof validateTrustedPluginManifest>;
type PluginPermission = PluginManifest["permissions"][number];

/**
 * Permissions the headless CLI never grants a plugin: the dangerous set of AGENTS.md §7, plus the
 * file, clipboard, and image access §16 forbids without an explicit grant. The CLI has no way for a
 * user to make that grant, so a manifest declaring any of these is refused outright.
 *
 * This checks what the plugin DECLARES, not what its code does. A plugin loaded in-process runs
 * with the full privileges of this process whatever its manifest says; the allow-list is what
 * bounds execution, and this check only refuses plugins that openly ask for more than the CLI
 * gives.
 */
export const CLI_REFUSED_PLUGIN_PERMISSIONS = [
  "document.write",
  "filesystem.read",
  "filesystem.write",
  "network.fetch",
  "native.execute",
  "model.load",
  "model.download",
  "clipboard.read",
  "clipboard.write",
  "image.read"
] as const satisfies readonly PluginPermission[];

export interface TrustedPluginEntry {
  id: string;
  dir: string;
}

export interface TrustedPluginRequest {
  /** The plugin id the caller expects; the allow-list entry and the manifest must both carry it. */
  pluginId: string;
  /** The directory the caller wants to load from (may be relative, contain symlinks, etc.). */
  pluginDir: string;
  /** Plugin entry, relative to the plugin directory. */
  entryFile: string;
  /** Manifest module, relative to the plugin directory. */
  manifestFile: string;
  /** Named export of the manifest module that holds the manifest. */
  manifestExport: string;
  /** Trust file location; defaults to {@link DEFAULT_TRUSTED_PLUGINS_PATH}. */
  configPath?: string;
}

/** A plugin that passed the allow-list: every path is a realpath inside the trusted directory. */
export interface TrustedPluginLocation {
  pluginId: string;
  configPath: string;
  dir: string;
  entryPath: string;
  manifestPath: string;
  manifestExport: string;
}

function describe(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "an array" : typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], where: string, configPath: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new PluginTrustError(
      `Plugin trust file ${configPath} is invalid: ${where} has unknown key(s) ${unknown.map((key) => `"${key}"`).join(", ")}.`
    );
  }
}

/** Read and strictly validate the trust file. Throws {@link PluginTrustError} naming the file. */
export function readTrustedPlugins(configPath: string = DEFAULT_TRUSTED_PLUGINS_PATH): TrustedPluginEntry[] {
  if (configPath === DEFAULT_TRUSTED_PLUGINS_PATH && defaultTrustedPluginsPathError !== undefined) {
    throw defaultTrustedPluginsPathError;
  }
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    throw new PluginTrustError(`Plugin trust file ${configPath} could not be read: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PluginTrustError(`Plugin trust file ${configPath} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isRecord(parsed)) {
    throw new PluginTrustError(`Plugin trust file ${configPath} is invalid: expected a JSON object, found ${describe(parsed)}.`);
  }
  if (parsed.version !== TRUST_FILE_VERSION) {
    throw new PluginTrustError(
      `Plugin trust file ${configPath} has unsupported version ${JSON.stringify(parsed.version)}; expected ${TRUST_FILE_VERSION}.`
    );
  }
  rejectUnknownKeys(parsed, ["version", "trustedPlugins"], "the top level", configPath);
  if (!Array.isArray(parsed.trustedPlugins)) {
    throw new PluginTrustError(
      `Plugin trust file ${configPath} is invalid: "trustedPlugins" must be an array, found ${describe(parsed.trustedPlugins)}.`
    );
  }
  return parsed.trustedPlugins.map((entry: unknown, index) => {
    const where = `trustedPlugins[${index}]`;
    if (!isRecord(entry)) {
      throw new PluginTrustError(`Plugin trust file ${configPath} is invalid: ${where} must be an object, found ${describe(entry)}.`);
    }
    rejectUnknownKeys(entry, ["id", "dir"], where, configPath);
    if (typeof entry.id !== "string" || entry.id.trim() === "") {
      throw new PluginTrustError(`Plugin trust file ${configPath} is invalid: ${where}.id must be a non-empty string.`);
    }
    if (typeof entry.dir !== "string" || !isAbsolute(entry.dir)) {
      throw new PluginTrustError(`Plugin trust file ${configPath} is invalid: ${where}.dir must be an absolute path.`);
    }
    return { id: entry.id, dir: entry.dir };
  });
}

function trustInstructions(configPath: string, pluginId: string, dir: string, exists: boolean): string {
  const entry = JSON.stringify({ id: pluginId, dir });
  return exists
    ? `To trust it, add this entry to "trustedPlugins" in ${configPath}:\n  ${entry}`
    : `To trust it, create ${configPath} containing:\n  {"version":${TRUST_FILE_VERSION},"trustedPlugins":[${entry}]}`;
}

function realpathOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function isInside(parent: string, child: string): boolean {
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function realpathInside(dir: string, relativeFile: string, role: string): string {
  const requested = join(dir, relativeFile);
  const real = realpathOrUndefined(requested);
  if (real === undefined) {
    throw new PluginTrustError(`Trusted plugin directory ${dir} has no ${role} at ${requested}.`);
  }
  if (!isInside(dir, real)) {
    throw new PluginTrustError(
      `Refusing to load plugin ${role} ${requested}: it resolves to ${real}, which is outside the trusted directory ${dir}.`
    );
  }
  return real;
}

/**
 * Check A — the allow-list. Imports nothing. Returns realpaths for the directory, entry, and
 * manifest, each verified to lie inside a directory the trust file lists under `pluginId`.
 */
export function resolveTrustedPlugin(request: TrustedPluginRequest): TrustedPluginLocation {
  const configPath = request.configPath ?? DEFAULT_TRUSTED_PLUGINS_PATH;
  if (configPath === DEFAULT_TRUSTED_PLUGINS_PATH && defaultTrustedPluginsPathError !== undefined) {
    throw defaultTrustedPluginsPathError;
  }
  const dir = realpathOrUndefined(request.pluginDir);
  if (dir === undefined) {
    throw new PluginTrustError(`Plugin directory ${request.pluginDir} does not exist.`);
  }
  const notTrusted = `Refusing to load plugin "${request.pluginId}" from ${dir}: that directory is not listed in the plugin trust file ${configPath}. ChemDraft only runs plugin code from directories the owner has listed there; choosing a directory with an environment variable is not enough.`;
  if (!existsSync(configPath)) {
    throw new PluginTrustError(`${notTrusted} (The trust file does not exist.)\n${trustInstructions(configPath, request.pluginId, dir, false)}`);
  }
  const trusted = readTrustedPlugins(configPath).some((entry) =>
    entry.id === request.pluginId && realpathOrUndefined(entry.dir) === dir
  );
  if (!trusted) {
    throw new PluginTrustError(`${notTrusted}\n${trustInstructions(configPath, request.pluginId, dir, true)}`);
  }
  return {
    pluginId: request.pluginId,
    configPath,
    dir,
    entryPath: realpathInside(dir, request.entryFile, "entry"),
    manifestPath: realpathInside(dir, request.manifestFile, "manifest"),
    manifestExport: request.manifestExport
  };
}

/**
 * Check B — import only the manifest module of an allow-listed plugin, validate it through
 * `@chemdraft/plugin-host`, and refuse a mismatched id or any permission the CLI does not grant.
 */
export async function loadTrustedManifest(location: TrustedPluginLocation): Promise<PluginManifest> {
  const module = await import(pathToFileURL(location.manifestPath).href) as Record<string, unknown>;
  if (!(location.manifestExport in module) || module[location.manifestExport] === undefined) {
    throw new PluginTrustError(
      `Plugin manifest ${location.manifestPath} does not export ${location.manifestExport}.`
    );
  }
  let manifest: PluginManifest;
  try {
    manifest = validateTrustedPluginManifest(module[location.manifestExport]);
  } catch (error) {
    throw new PluginTrustError(`Plugin manifest ${location.manifestPath} is invalid: ${(error as Error).message}`);
  }
  if (manifest.id !== location.pluginId) {
    throw new PluginTrustError(
      `Plugin manifest ${location.manifestPath} declares id "${manifest.id}", but "${location.pluginId}" was expected and trusted.`
    );
  }
  const refused = manifest.permissions.filter((permission) =>
    (CLI_REFUSED_PLUGIN_PERMISSIONS as readonly string[]).includes(permission)
  );
  if (refused.length > 0) {
    throw new PluginTrustError(
      `Refusing to load plugin "${manifest.id}": its manifest declares ${refused.join(", ")}, which the ChemDraft CLI does not grant.`
    );
  }
  return manifest;
}

/**
 * A, then B, then the entry import. Nothing from the plugin directory is imported until the
 * allow-list has passed, and the entry is not imported until the manifest has.
 */
export async function loadTrustedPlugin(
  request: TrustedPluginRequest
): Promise<{ location: TrustedPluginLocation; manifest: PluginManifest; module: Record<string, unknown> }> {
  const location = resolveTrustedPlugin(request);
  return importVerifiedPlugin(location);
}

/** B and the entry import for a location that has already passed {@link resolveTrustedPlugin}. */
export async function importVerifiedPlugin(
  location: TrustedPluginLocation
): Promise<{ location: TrustedPluginLocation; manifest: PluginManifest; module: Record<string, unknown> }> {
  const manifest = await loadTrustedManifest(location);
  // The realpath is imported, not the requested path, so the file checked is the file loaded.
  const module = await import(pathToFileURL(location.entryPath).href) as Record<string, unknown>;
  return { location, manifest, module };
}
