/**
 * Serve or ship a staged preloaded-plugins directory with the **browser build** (opt-in).
 *
 * Only when `CHEMDRAFT_WEB_PLUGINS_DIR` names a directory written by `scripts/stage-web-plugins.mjs`:
 *
 *  - `vite` (dev) answers `/web-plugins/…` from it, same-origin, with the installed-plugin path refusal
 *    and worker CSP (like the `/installed-plugins/` middleware in vite.config.ts);
 *  - `vite build` copies it to `<outDir>/web-plugins/`.
 *
 * Unset (or empty), this returns no plugins: nothing is served and nothing is copied. Inside a Tauri
 * build (`tauri dev` / `tauri build` set `TAURI_ENV_*` for their before-commands) a set variable is an
 * error, so a desktop package can never ship preloaded web plugins.
 */
import { cpSync, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  INSTALLED_PLUGIN_URL_PREFIX,
  INSTALLED_PLUGIN_WORKER_CSP,
  installedPluginContentType,
  resolveInstalledPluginAssetSegments
} from "../../apps/desktop/src/plugins/installedPluginAssetPath";

export const WEB_PLUGINS_DIR_ENV = "CHEMDRAFT_WEB_PLUGINS_DIR";
export const WEB_PLUGINS_URL_PREFIX = "/web-plugins/";
export const WEB_PLUGINS_OUT_SUBDIR = "web-plugins";
const INDEX_FILE = "index.json";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The slice of Vite's `Plugin` these use, stated structurally: `vite` resolves only from
 * apps/desktop, not from scripts/, and the root type check covers this file through vite.config.ts.
 */
type Middleware = (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => void;
export interface WebPluginsVitePlugin {
  name: string;
  apply: "serve" | "build";
  configureServer?: (server: { middlewares: { use(handler: Middleware): unknown } }) => void;
  writeBundle?: (options: { dir?: string }) => void;
}

/** True when Vite is running as a Tauri before-command (`tauri dev` / `tauri build`). */
export function isTauriBuildEnv(env: Env): boolean {
  return Object.keys(env).some((key) => key.startsWith("TAURI_ENV_") && env[key] !== undefined && env[key] !== "");
}

/**
 * Resolve and check the opt-in. Returns `undefined` when the variable is unset; throws when it is set
 * inside a Tauri build or names something that is not a staged directory.
 */
export function resolveWebPluginsDir(env: Env, cwd: string = process.cwd()): string | undefined {
  const value = env[WEB_PLUGINS_DIR_ENV];
  if (value === undefined || value.trim() === "") return undefined;
  if (isTauriBuildEnv(env)) {
    throw new Error(
      `${WEB_PLUGINS_DIR_ENV} is set inside a Tauri build. Preloaded web plugins are for the browser build ` +
        "only; the desktop app installs plugins itself. Unset it and run the Tauri build again."
    );
  }
  const dir = resolve(cwd, value);
  if (!existsSync(join(dir, INDEX_FILE))) {
    throw new Error(
      `${WEB_PLUGINS_DIR_ENV}=${value} has no ${INDEX_FILE}. Stage a plugin first: ` +
        "node scripts/stage-web-plugins.mjs <plugin.zip>"
    );
  }
  return dir;
}

/** Map a `/web-plugins/…` request to a file inside `root`, or a status code to refuse it with. */
export function resolveWebPluginRequest(root: string, url: string): { file: string } | { status: 403 | 404 } {
  const path = url.split("?")[0] ?? "";
  if (!path.startsWith(WEB_PLUGINS_URL_PREFIX)) return { status: 404 };
  const rest = path.slice(WEB_PLUGINS_URL_PREFIX.length);
  let segments: readonly string[] | undefined;
  if (rest === INDEX_FILE) {
    segments = [INDEX_FILE];
  } else {
    // Same refusal rules as an installed plugin's assets (`<plugin-dir>/<file…>`, no `..`, no `\`, no
    // NUL, percent-decoded first), applied by the shared, tested function.
    segments = resolveInstalledPluginAssetSegments(`${INSTALLED_PLUGIN_URL_PREFIX}${rest}`);
    // Staging temp directories are hidden; never serve them.
    if (segments?.[0]?.startsWith(".")) segments = undefined;
  }
  if (!segments) return { status: 403 };
  const file = join(root, ...segments);
  const inside = relative(root, file);
  if (!inside || inside.startsWith("..") || isAbsolute(inside) || !existsSync(file) || !statSync(file).isFile()) {
    return { status: 404 };
  }
  // A symlink inside the staged directory must not reach outside it.
  const realInside = relative(realpathSync(root), realpathSync(file));
  if (realInside.startsWith("..") || isAbsolute(realInside)) return { status: 403 };
  return { file };
}

/** The Vite plugins for `CHEMDRAFT_WEB_PLUGINS_DIR`; an empty list when it is unset. */
export function webPluginsVitePlugins(env: Env = process.env, cwd: string = process.cwd()): WebPluginsVitePlugin[] {
  const root = resolveWebPluginsDir(env, cwd);
  if (root === undefined) return [];
  return [
    {
      name: "chemdraft-serve-web-plugins",
      apply: "serve",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = request.url ?? "";
          if (!url.split("?")[0]?.startsWith(WEB_PLUGINS_URL_PREFIX)) return next();
          const resolved = resolveWebPluginRequest(root, url);
          if ("status" in resolved) {
            response.statusCode = resolved.status;
            response.end(resolved.status === 403 ? "Unsafe preloaded plugin path" : "Preloaded plugin asset not found");
            return;
          }
          response.setHeader("Content-Type", installedPluginContentType(resolved.file));
          response.setHeader("Cache-Control", "no-cache");
          response.setHeader("Content-Security-Policy", INSTALLED_PLUGIN_WORKER_CSP);
          response.end(readFileSync(resolved.file));
        });
      }
    },
    {
      name: "chemdraft-copy-web-plugins",
      apply: "build",
      writeBundle(options) {
        if (!options.dir) return;
        cpSync(root, join(options.dir, WEB_PLUGINS_OUT_SUBDIR), {
          recursive: true,
          // Leftover staging temp directories (hidden) are not part of the staged set.
          filter: (source) => !relative(root, source).split(/[\\/]/).some((segment) => segment.startsWith("."))
        });
      }
    }
  ];
}
