import { execSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react-swc";
import { defineConfig, type Plugin } from "vite";

// fileURLToPath (not URL.pathname) so a checkout path containing spaces — e.g. a git worktree at
// ".../chemdraw-structure inspector" — decodes to a real filesystem path instead of a "%20" one
// that ENOENTs at build time.
const workspacePackage = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const optionalRealpath = (path: string): string | undefined => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};
const workspaceRoot = workspacePackage("../..");
const dependencyRoots = [
  optionalRealpath(workspacePackage("../../node_modules"))
].filter((path): path is string => path !== undefined && path !== workspaceRoot);
const gitStampCommandOptions = {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
  timeout: 750
} as const;

// Which worktree/branch this build came from. With several ChemDraft worktrees checked out at once
// (all building an app named "ChemDraft"), the on-screen stamp is the only thing telling them apart,
// so the worktree name goes FIRST. Prefer the label run-app exports (single source of truth), else
// derive it from git here so a bare `vite build`/`vite dev` still stamps it. See AGENTS.md.
function worktreeLabel(): string {
  const fromEnv = process.env.CHEMDRAFT_WORKTREE_LABEL?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    const toplevel = execSync("git rev-parse --show-toplevel", gitStampCommandOptions).trim();
    const base = toplevel.split("/").pop() ?? "";
    let branch = "";
    try {
      branch = execSync("git rev-parse --abbrev-ref HEAD", gitStampCommandOptions).trim();
    } catch {
      // Detached HEAD or no branch — the directory name alone still disambiguates.
    }
    return branch && base ? `${base} [${branch}]` : base;
  } catch {
    return "";
  }
}

// Computed once per `vite build` / `vite dev` start, so the on-screen stamp always reflects
// the actual source that was bundled. Format: "<worktree [branch]> · YYYY-MM-DD HH:MM:SS <shortSha>[+dirty]".
function buildStamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const when =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  let sha = "nogit";
  let dirty = "";
  try {
    sha = execSync("git rev-parse --short HEAD", gitStampCommandOptions).trim();
    dirty = execSync("git status --porcelain", gitStampCommandOptions).trim().length > 0 ? "+dirty" : "";
  } catch {
    // Not a git checkout, git unavailable, or a damaged shared object store. Keep dev startup moving.
  }
  const label = worktreeLabel();
  return `${label ? `${label} · ` : ""}${when} ${sha}${dirty}`;
}

/**
 * Serve staged plugin packages in `tauri dev` (M36).
 *
 * In a *release* build the app's own `tauri://localhost` handler serves both the document and any staged
 * package (`src-tauri/src/installed_plugins.rs`). In **dev** it cannot: Tauri points the webview
 * straight at `devUrl`, so the document's origin is this Vite server and `tauri://` is never consulted.
 * Since a package must be same-origin with the document (report 0030), whichever server owns the
 * document must own `/installed-plugins/` too — so in dev, that is this middleware.
 *
 * It mirrors the Rust handler's contract exactly: same URL prefix, same app-data root, same refusal of
 * anything that is not a plain relative path inside it. Without it, installs would work in the shipped
 * app and mysteriously 404 under `./run-app --dev`.
 */
function serveInstalledPluginsInDev(): Plugin {
  const urlPrefix = "/installed-plugins/";
  // Mirrors `installed_plugins::installed_plugins_root` and `tauri.conf.json`'s identifier.
  const root = join(homedir(), "Library", "Application Support", "org.chemdraft.desktop", "installed-plugins");
  const contentTypes: Record<string, string> = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".css": "text/css",
    ".map": "application/json"
  };

  return {
    name: "chemdraft-serve-installed-plugins",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = (request.url ?? "").split("?")[0];
        if (!url.startsWith(urlPrefix)) {
          return next();
        }

        const relative = decodeURIComponent(url.slice(urlPrefix.length));
        const segments = relative.split("/");
        // Refuse traversal rather than normalizing it, exactly as the Rust handler does.
        if (segments.length < 2 || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
          response.statusCode = 403;
          response.end("Unsafe staged plugin path");
          return;
        }

        const file = join(root, ...segments);
        if (!file.startsWith(root + "/") || !existsSync(file)) {
          response.statusCode = 404;
          response.end("Staged plugin asset not found");
          return;
        }

        const extension = file.slice(file.lastIndexOf("."));
        response.setHeader("Content-Type", contentTypes[extension] ?? "application/octet-stream");
        response.setHeader("Cache-Control", "no-cache");
        response.end(readFileSync(file));
      });
    }
  };
}

export default defineConfig({
  // SWC React plugin (replaces the Babel one): no 500KB code-generator deopt on the large
  // MainWindow.tsx, and much faster transforms in both dev HMR and production builds.
  plugins: [react(), serveInstalledPluginsInDev()],
  // ES-module workers are required now that a plugin's *execution* runs in a per-plugin Web Worker
  // (ADR-0029, M34): those workers either spawn a nested worker (the NMR plugin worker starts its own
  // OpenChemLib worker) or use dynamic import() (mass analysis, the NMR in-thread fallback), and both
  // force code-splitting *inside* the worker bundle — which Rollup rejects under the default "iife"
  // worker format. Every worker is already instantiated with { type: "module" }, so "es" is the correct
  // and compatible output format.
  worker: {
    format: "es"
  },
  define: {
    __BUILD_STAMP__: JSON.stringify(buildStamp()),
    __WORKTREE_LABEL__: JSON.stringify(worktreeLabel())
  },
  resolve: {
    alias: {
      "@chemdraft/chem-core": workspacePackage("../../packages/chem-core/src/index.ts"),
      "@chemdraft/art-engine": workspacePackage("../../packages/art-engine/src/index.ts"),
      "@chemdraft/ocl-adapter": workspacePackage("../../packages/ocl-adapter/src/index.ts"),
      "@chemdraft/chemistry-adapter": workspacePackage("../../packages/chemistry-adapter/src/index.ts"),
      "@chemdraft/cdx-compat": workspacePackage("../../packages/cdx-compat/src/index.ts"),
      "@chemdraft/engine3d-api": workspacePackage("../../packages/engine3d-api/src/index.ts"),
      "@chemdraft/export-engine/pdf": workspacePackage("../../packages/export-engine/src/pdf.ts"),
      "@chemdraft/export-engine": workspacePackage("../../packages/export-engine/src/index.ts"),
      "@chemdraft/layout-engine": workspacePackage("../../packages/layout-engine/src/index.ts"),
      "@chemdraft/style-compat": workspacePackage("../../packages/style-compat/src/index.ts"),
      "@chemdraft/toolset-registry": workspacePackage("../../packages/toolset-registry/src/index.ts"),
      "@chemdraft/shortcut-engine": workspacePackage("../../packages/shortcut-engine/src/index.ts"),
      "@chemdraft/viewport-engine": workspacePackage("../../packages/viewport-engine/src/index.ts")
    }
  },
  server: {
    fs: {
      allow: [
        workspaceRoot,
        ...dependencyRoots
      ]
    }
  }
});
