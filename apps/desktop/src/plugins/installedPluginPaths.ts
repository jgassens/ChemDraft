/**
 * Where an installed plugin package lives on disk, and the URL it is served from (M36, ADR-0029 §6 as
 * amended).
 *
 * These constants are one half of a contract whose other half is Rust: `installed_plugins.rs` resolves
 * {@link INSTALLED_PLUGINS_URL_PREFIX} on the app's **own** `tauri://localhost` origin to
 * {@link INSTALLED_PLUGINS_DIR} under the app-data directory. They are stated once here, and mirrored
 * there with a comment pointing back, because a silent drift between the two would surface as the
 * single most confusing failure this feature can produce: the plugin's `ready` handshake succeeds and
 * only a real prediction fails, because the nested worker chunk 404s (report 0030).
 *
 * Same-origin is not a style choice. M35 measured that a packaged plugin loads only from a real,
 * co-located, same-origin URL — a blob has no siblings, and a worker script cannot be cross-origin — so
 * the staged package must be reachable from the very origin that serves the document.
 */

/** Reserved path prefix on the app's own origin. Mirrored in `src-tauri/src/installed_plugins.rs`. */
export const INSTALLED_PLUGINS_URL_PREFIX = "/installed-plugins/";

/** Directory under the app-data dir holding staged packages. Mirrored in `installed_plugins.rs`. */
export const INSTALLED_PLUGINS_DIR = "installed-plugins";

/**
 * Install records file, app-data relative.
 *
 * Deliberately a sibling of the staging directory rather than a file inside it: the staging root then
 * contains nothing but plugin directories, so a plugin id can never collide with the records file.
 */
export const INSTALLED_PLUGINS_RECORD_FILE = "installed-plugins.json";

/** Host-owned namespace for immutable, checksum-addressed replacement packages. */
const INSTALLED_PLUGIN_UPDATE_DIR = "packages";

/** Parent of every checksum-addressed package directory, and the only sweepable subtree. */
export function installedPluginPackagesRoot(): string {
  return `${INSTALLED_PLUGINS_DIR}/${INSTALLED_PLUGIN_UPDATE_DIR}`;
}

/** App-data-relative directory holding one plugin's staged package. */
export function installedPluginStagingDir(pluginId: string): string {
  if (
    pluginId.length === 0 ||
    pluginId === "." ||
    pluginId === ".." ||
    pluginId.toLowerCase() === INSTALLED_PLUGIN_UPDATE_DIR ||
    /[/\\\0]/.test(pluginId)
  ) {
    throw new Error(`Refusing unsafe installed-plugin id "${pluginId}" for a staging directory.`);
  }
  return `${INSTALLED_PLUGINS_DIR}/${pluginId}`;
}

/**
 * Immutable, content-addressed directory for a replacement package.
 *
 * The id is deliberately absent from this path: manifest ids are plugin-controlled strings, while
 * the checksum has already been validated as lowercase SHA-256. Keeping an update at its final URL
 * from the first worker handshake also means nested workers and data assets never observe a move.
 */
export function installedPluginUpdateStagingDir(sourceChecksum: string): string {
  if (!/^[0-9a-f]{64}$/.test(sourceChecksum)) {
    throw new Error("An installed plugin update path requires a lowercase SHA-256 checksum.");
  }
  return `${INSTALLED_PLUGINS_DIR}/${INSTALLED_PLUGIN_UPDATE_DIR}/${sourceChecksum}`;
}

/**
 * Directory URL a staged package is served from, on the app's own origin.
 *
 * Absolute-path (not relative) so it resolves identically no matter which document URL is current, and
 * with a trailing slash so the package's own `base: "./"` relative references (`entry.js`,
 * `assets/nmrWorker-*.js`) resolve as siblings rather than replacing the last path segment.
 */
export function installedPluginBaseUrl(pluginId: string, origin: string): string {
  return new URL(`${INSTALLED_PLUGINS_URL_PREFIX}${encodeURIComponent(pluginId)}/`, origin).toString();
}

/** Directory URL for an install record's exact immutable package path. */
export function installedPluginStagedBaseUrl(stagedPath: string, origin: string): string {
  const safePath = assertInstalledPluginStagedPath(stagedPath);
  const segments = safePath.split("/");
  const relative = segments.slice(1).map(encodeURIComponent).join("/");
  return new URL(`${INSTALLED_PLUGINS_URL_PREFIX}${relative}/`, origin).toString();
}

/** Refuse a catalog path that is not a plain descendant of the installed-plugin root. */
export function assertInstalledPluginStagedPath(stagedPath: string): string {
  const segments = stagedPath.split("/");
  const hasUnsafeSegment = segments
    .slice(1)
    .some((segment) => segment === "" || segment === "." || segment === ".." || /[\\\0]/.test(segment));
  const isLegacyPluginPath =
    segments.length === 2 &&
    segments[1]!.toLowerCase() !== INSTALLED_PLUGIN_UPDATE_DIR;
  const isChecksumAddressedUpdatePath =
    segments.length === 3 &&
    segments[1] === INSTALLED_PLUGIN_UPDATE_DIR &&
    /^[0-9a-f]{64}$/.test(segments[2]!);

  if (
    segments[0] !== INSTALLED_PLUGINS_DIR ||
    hasUnsafeSegment ||
    (!isLegacyPluginPath && !isChecksumAddressedUpdatePath)
  ) {
    throw new Error(`Refusing unsafe installed-plugin staging path "${stagedPath}".`);
  }
  return stagedPath;
}
