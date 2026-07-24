/**
 * The staged-plugin asset contract shared by the two servers that implement it.
 *
 * Installed plugin assets are served by `installed_plugins.rs` in the shipped app and by a Vite dev
 * middleware under `./run-app --dev`. Both must refuse exactly the same paths and send exactly the
 * same worker CSP: a dev-only gap would mean traversal is testable in one build and not the other,
 * and a CSP drift would silently hand development workers ambient network access the packaged app
 * denies. The decision lives here, as pure data, so both callers share it and a test can pin it.
 *
 * This is the *second* line of defense. The archive reader (`pluginPackageArchive.ts`) already
 * refuses unsafe entry paths at install time; this refuses them again at serve time, because the
 * staging directory is on disk and a path arriving over the URL is not necessarily one we wrote.
 */

/** URL prefix both servers answer on. */
export const INSTALLED_PLUGIN_URL_PREFIX = "/installed-plugins/";

/**
 * CSP applied to every staged plugin response. Must stay byte-identical to
 * `installed_plugins::INSTALLED_PLUGIN_WORKER_CSP`. A worker's CSP comes from its own script
 * response rather than the creating page, so this header is what keeps an installed plugin's worker
 * from using ambient fetch/XHR to bypass the manifest's declared network boundary.
 */
export const INSTALLED_PLUGIN_WORKER_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'";

export const INSTALLED_PLUGIN_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".css": "text/css",
  ".map": "application/json"
};

/**
 * Resolve a request URL to the path segments beneath the staging root, or `undefined` when the
 * request must be refused (HTTP 403).
 *
 * Refusal — never normalization — is the rule, matching `installed_plugins::safe_relative_path`:
 * a `..` is rejected rather than resolved away, so there is no second parser whose idea of
 * "normalized" could disagree with the filesystem's. Percent-decoding happens *before* the check so
 * `%2e%2e%2f` cannot smuggle a traversal past it. At least two segments are required because a
 * staged asset is always `<plugin-id>/<file>`.
 */
export function resolveInstalledPluginAssetSegments(url: string): readonly string[] | undefined {
  const path = url.split("?")[0] ?? "";
  if (!path.startsWith(INSTALLED_PLUGIN_URL_PREFIX)) {
    return undefined;
  }

  let relative: string;
  try {
    relative = decodeURIComponent(path.slice(INSTALLED_PLUGIN_URL_PREFIX.length));
  } catch {
    return undefined; // malformed percent-encoding is a refusal, not a pass-through
  }

  if (relative.includes("\0") || relative.includes("\\")) {
    return undefined;
  }
  const segments = relative.split("/");
  if (segments.length < 2) {
    return undefined;
  }
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return undefined;
  }
  return segments;
}

/** Content type for a staged asset, defaulting to a non-executable octet-stream. */
export function installedPluginContentType(file: string): string {
  const extension = file.slice(file.lastIndexOf("."));
  return INSTALLED_PLUGIN_CONTENT_TYPES[extension] ?? "application/octet-stream";
}
