/**
 * Preloaded plugins for the **browser build** only.
 *
 * The browser build has no staging filesystem, so it cannot install a package (see
 * `usePluginRuntime`). Whoever builds or serves it can instead *preload* released packages: they are
 * staged with `scripts/stage-web-plugins.mjs` (the same checksum, CRC, manifest, size and
 * path-traversal gates an install runs) and served same-origin at `/web-plugins/` by the Vite dev
 * middleware or copied into `dist/web-plugins/` by `vite build`, only when `CHEMDRAFT_WEB_PLUGINS_DIR`
 * is set. Nothing about a preloaded plugin is in this repository: its code and data live in the
 * staged directory alone.
 *
 * At startup, after the bundled plugins have registered, this module reads `/web-plugins/index.json`
 * and loads each listed package through {@link loadPackagedPlugin} from its real same-origin directory
 * (so the package's relative references resolve, exactly as for an installed package). Each one then
 * passes the same gates as an installed plugin before it is registered: the packaged-manifest schema,
 * the `apiVersion` check, the refusal of desktop-unavailable permissions, and the worker's `ready`
 * handshake. One broken package is reported and skipped; it never blocks startup or the others.
 *
 * One gate is particular to the web: a worker's CSP comes from its own script response, and that header
 * ({@link INSTALLED_PLUGIN_WORKER_CSP}) is the plugin's network boundary. The desktop app and the Vite
 * dev server always send it; a static host sends only what it was configured to. So before a package's
 * worker is created, its entry script is fetched and the package is refused unless the response carries
 * a policy at least as strict (`evaluateWorkerCsp`). A host without the header fails closed, with a
 * message naming the header to add.
 *
 * A Tauri host never runs this: the desktop app installs packages properly, and the desktop build never
 * contains `/web-plugins/` (the Vite plugin refuses to run inside a Tauri build with the variable set).
 * Plugin storage on the web stays in memory, as it is for every plugin in the browser build.
 */

import {
  PluginApiVersion,
  isPluginApiVersionCompatible,
  parsePackagedPluginManifest,
  type PackagedPluginManifest,
  type PluginManifest,
  type PluginWorkerHandle
} from "@chemdraft/plugin-api";

import { getUnavailableDesktopPluginPermissions, type DesktopPluginRuntime } from "./createPluginRuntime";
import { INSTALLED_PLUGIN_WORKER_CSP } from "./installedPluginAssetPath";
import { loadPackagedPlugin, packagedPluginEntryUrl, type PackagedPluginDescriptor } from "./loadPackagedPlugin";
import { isTauriHost } from "./pluginStagingFs";
import type { BundledPluginDescriptor } from "./registerBundledPlugins";
import { describeWorkerCspFailure, evaluateWorkerCsp } from "./workerCspPolicy";

/** URL path the preloaded packages are served under, relative to the app's base URL. */
export const WEB_PLUGINS_PATH = "web-plugins/";
/** Index written by the staging script beside the per-plugin directories. */
export const WEB_PLUGINS_INDEX_FILE = "index.json";
export const WEB_PLUGINS_INDEX_VERSION = 1;

/** A plugin directory name: one safe path segment, never hidden, never the index file. */
const SAFE_DIR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeWebPluginDirName(name: string): boolean {
  return (
    SAFE_DIR_PATTERN.test(name) &&
    !name.endsWith(".") &&
    name.toLowerCase() !== WEB_PLUGINS_INDEX_FILE
  );
}

/** One entry of `index.json`, as the staging script writes it. */
export interface WebPreloadedPluginRecord {
  id: string;
  version: string;
  /** Directory under `/web-plugins/`; the staging script uses the plugin id. */
  dir: string;
  /** SHA-256 of the released zip that was staged. Descriptive: the zip was verified at staging time. */
  sha256: string;
}

export interface WebPreloadedPluginEntry {
  record: WebPreloadedPluginRecord;
  manifest: PluginManifest;
  /** Absent only when the plugin is listed but could not be made loadable. */
  descriptor: PackagedPluginDescriptor | undefined;
}

export interface WebPreloadedPluginFailure {
  /** The plugin id from the index, or the index itself when the whole file is unusable. */
  id: string;
  message: string;
}

export interface WebPreloadedPluginsResult {
  loaded: readonly WebPreloadedPluginEntry[];
  failures: readonly WebPreloadedPluginFailure[];
}

export class WebPluginsIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebPluginsIndexError";
  }
}

/** Validate the staged index. Throws a specific {@link WebPluginsIndexError} for anything unexpected. */
export function parseWebPluginsIndex(candidate: unknown): WebPreloadedPluginRecord[] {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new WebPluginsIndexError("index.json is not a JSON object.");
  }
  const { version, plugins } = candidate as { version?: unknown; plugins?: unknown };
  if (version !== WEB_PLUGINS_INDEX_VERSION) {
    throw new WebPluginsIndexError(
      `index.json has version ${JSON.stringify(version)}; this build reads version ${WEB_PLUGINS_INDEX_VERSION}. Re-stage the plugins.`
    );
  }
  if (!Array.isArray(plugins)) {
    throw new WebPluginsIndexError('index.json has no "plugins" array.');
  }
  return plugins.map((entry, index) => {
    const record = entry as Partial<Record<keyof WebPreloadedPluginRecord, unknown>> | null;
    const field = (name: keyof WebPreloadedPluginRecord): string => {
      const value = record?.[name];
      if (typeof value !== "string" || value.length === 0) {
        throw new WebPluginsIndexError(`index.json plugins[${index}] has no "${name}" string.`);
      }
      return value;
    };
    const parsed = { id: field("id"), version: field("version"), dir: field("dir"), sha256: field("sha256") };
    if (!isSafeWebPluginDirName(parsed.dir)) {
      throw new WebPluginsIndexError(
        `index.json plugins[${index}] ("${parsed.id}") names the directory "${parsed.dir}", which is not a single safe path segment.`
      );
    }
    return parsed;
  });
}

type FetchLike = (
  input: string,
  init?: RequestInit
) => Promise<Pick<Response, "ok" | "status" | "headers" | "json" | "text"> & { body?: ReadableStream<Uint8Array> | null }>;

export interface LoadWebPreloadedPluginsOptions {
  runtime: DesktopPluginRuntime;
  /** Defaults to detection. A Tauri host returns immediately without fetching anything. */
  tauriHost?: boolean;
  /** Directory URL the packages are served from. Defaults to `web-plugins/` under the app's base URL. */
  baseUrl?: string | URL;
  fetch?: FetchLike;
  hostApiVersion?: string;
  createWorker?: (entryUrl: URL) => PluginWorkerHandle;
  /** The user's disabled preference: listed and toggleable, but not registered or handshaken. */
  disabledIds?: ReadonlySet<string>;
  /** Bundled plugins a preloaded package may take the id of, exactly as an install does. */
  replacements?: readonly BundledPluginDescriptor[];
  signal?: AbortSignal;
}

const EMPTY_RESULT: WebPreloadedPluginsResult = Object.freeze({ loaded: [], failures: [] });

/** `web-plugins/` resolved against the app's base URL (`/` unless the build sets another base). */
export function defaultWebPluginsBaseUrl(): URL | undefined {
  if (typeof window === "undefined" || !window.location?.href) return undefined;
  const origin = window.location.origin;
  if (!origin || origin === "null") return undefined;
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
  return new URL(WEB_PLUGINS_PATH, new URL(base, window.location.href));
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Discover and register the preloaded packages. Never throws: an absent index means no preloaded
 * plugins, and every other problem comes back as a failure with a specific message.
 */
export async function loadWebPreloadedPlugins(options: LoadWebPreloadedPluginsOptions): Promise<WebPreloadedPluginsResult> {
  if (options.tauriHost ?? isTauriHost()) return EMPTY_RESULT;
  const fetchImpl: FetchLike | undefined = options.fetch ?? (typeof fetch === "function" ? fetch.bind(globalThis) : undefined);
  const baseUrlInput = options.baseUrl ?? defaultWebPluginsBaseUrl();
  if (!fetchImpl || baseUrlInput === undefined) return EMPTY_RESULT;
  const baseUrl = new URL(baseUrlInput.toString());
  if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname = `${baseUrl.pathname}/`;
  const indexUrl = new URL(WEB_PLUGINS_INDEX_FILE, baseUrl);

  let response;
  try {
    response = await fetchImpl(indexUrl.href, { cache: "no-cache", signal: options.signal });
  } catch {
    // No server answering at all (an aborted startup, a file:// page): nothing was preloaded.
    return EMPTY_RESULT;
  }
  if (response.status === 404) return EMPTY_RESULT;
  if (!response.ok) {
    return {
      loaded: [],
      failures: [{ id: WEB_PLUGINS_INDEX_FILE, message: `Preloaded web plugins could not be read: ${indexUrl.pathname} answered HTTP ${response.status}.` }]
    };
  }
  // A static host or SPA fallback may answer any unknown path with the app's HTML. Only a JSON
  // response is an index; anything else means no plugins were preloaded.
  const contentType = response.headers.get("content-type") ?? "";
  if (!/json/i.test(contentType)) return EMPTY_RESULT;

  let records: WebPreloadedPluginRecord[];
  try {
    records = parseWebPluginsIndex(await response.json());
  } catch (cause) {
    return {
      loaded: [],
      failures: [{ id: WEB_PLUGINS_INDEX_FILE, message: `Preloaded web plugins were not loaded: ${messageOf(cause)}` }]
    };
  }

  const loaded: WebPreloadedPluginEntry[] = [];
  const failures: WebPreloadedPluginFailure[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (options.signal?.aborted) break;
    if (seen.has(record.id)) {
      failures.push({ id: record.id, message: `Preloaded plugin "${record.id}" is listed twice in index.json; only the first was loaded.` });
      continue;
    }
    seen.add(record.id);
    let descriptor: PackagedPluginDescriptor | undefined;
    try {
      const result = await loadOne(record, baseUrl, fetchImpl, options);
      descriptor = result.descriptor;
      if (options.signal?.aborted) {
        descriptor?.deactivate?.();
        break;
      }
      loaded.push(result);
    } catch (cause) {
      descriptor?.deactivate?.();
      failures.push({ id: record.id, message: `Preloaded plugin "${record.id}" could not be loaded: ${messageOf(cause)}` });
    }
  }
  return { loaded, failures };
}

async function loadOne(
  record: WebPreloadedPluginRecord,
  baseUrl: URL,
  fetchImpl: FetchLike,
  options: LoadWebPreloadedPluginsOptions
): Promise<WebPreloadedPluginEntry> {
  const { runtime, hostApiVersion = PluginApiVersion } = options;
  const packageUrl = new URL(`${record.dir}/`, baseUrl);
  const manifestUrl = new URL("manifest.json", packageUrl);
  const response = await fetchImpl(manifestUrl.href, { cache: "no-cache", signal: options.signal });
  if (!response.ok) {
    throw new Error(`its manifest.json was not served (${manifestUrl.pathname} answered HTTP ${response.status}). Re-stage it.`);
  }
  let document: unknown;
  try {
    document = await response.json();
  } catch (cause) {
    throw new Error(`its manifest.json is not JSON: ${messageOf(cause)}`);
  }

  let packaged: PackagedPluginManifest;
  try {
    packaged = parsePackagedPluginManifest(document);
  } catch (cause) {
    throw new Error(`its manifest.json is not valid: ${messageOf(cause)}`);
  }
  const { manifest } = packaged;
  if (manifest.id !== record.id) {
    throw new Error(`index.json lists "${record.id}" but its manifest declares "${manifest.id}". Re-stage it.`);
  }
  if (manifest.version !== record.version) {
    throw new Error(`index.json lists version ${record.version} but its manifest declares ${manifest.version}. Re-stage it.`);
  }
  // Courtesy check for a clear message; the worker handshake below is the authority.
  if (!isPluginApiVersionCompatible(manifest.apiVersion, hostApiVersion)) {
    throw new Error(`it requires ChemDraft plugin API "${manifest.apiVersion}", but this build provides ${hostApiVersion}.`);
  }
  const unavailable = getUnavailableDesktopPluginPermissions(manifest);
  if (unavailable.length > 0) {
    throw new Error(
      `it declares ${unavailable.join(", ")}, but ${unavailable.length === 1 ? "that permission is" : "those permissions are"} ` +
        "reserved and unavailable in this ChemDraft build."
    );
  }

  const replaces = options.replacements?.find((candidate) => candidate.manifest.id === record.id);
  if (!replaces && runtime.host.getPlugin(record.id)) {
    throw new Error("a plugin with that id is already registered.");
  }

  // Before any worker exists (a disabled plugin included, since enabling it later starts this same
  // descriptor), prove the host confines it.
  const entryUrl = packagedPluginEntryUrl({ baseUrl: packageUrl, manifest: document }, packaged);
  await assertEntryWorkerCsp(entryUrl, baseUrl, fetchImpl, options.signal);

  const descriptor = loadPackagedPlugin(
    { baseUrl: packageUrl, manifest: document },
    { hostApiVersion, createWorker: options.createWorker }
  );
  try {
    if (!options.disabledIds?.has(record.id)) {
      await descriptor.bridge.whenReady();
      if (options.signal?.aborted) return { record, manifest: descriptor.manifest, descriptor };
      // Through the runtime, like an install: a bundled copy of the same id is replaced only once the
      // preloaded package's handshake has passed, and its worker is torn down after the swap commits.
      runtime.replacePlugin(record.id, descriptor.manifest, descriptor.options);
      replaces?.deactivate?.();
    }
    return { record, manifest: descriptor.manifest, descriptor };
  } catch (cause) {
    descriptor.deactivate?.();
    throw cause;
  }
}

/**
 * Fetch the entry script the worker will load and refuse the package unless that response carries a
 * Content-Security-Policy at least as strict as {@link INSTALLED_PLUGIN_WORKER_CSP}.
 */
async function assertEntryWorkerCsp(
  entryUrl: URL,
  baseUrl: URL,
  fetchImpl: FetchLike,
  signal: AbortSignal | undefined
): Promise<void> {
  const response = await fetchImpl(entryUrl.href, { cache: "no-cache", signal });
  // Only the headers matter; do not download the whole entry twice.
  void response.body?.cancel().catch(() => undefined);
  if (!response.ok) {
    throw new Error(`its entry script was not served (${entryUrl.pathname} answered HTTP ${response.status}). Re-stage it.`);
  }
  const verdict = evaluateWorkerCsp(response.headers.get("content-security-policy"));
  if (!verdict.ok) {
    throw new Error(
      `its entry script ${entryUrl.pathname} ${describeWorkerCspFailure(verdict)}, so its worker would not be ` +
        `confined to its network permissions. Configure the host to send "Content-Security-Policy: ${INSTALLED_PLUGIN_WORKER_CSP}" ` +
        `on ${baseUrl.pathname}* ` +
        '(see "Running a plugin in the web build" in AUTHORING.md; vite build writes a _headers file for Netlify and Cloudflare Pages).'
    );
  }
}
