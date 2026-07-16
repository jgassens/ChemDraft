import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";

// fileURLToPath (not URL.pathname) so a checkout path containing spaces — e.g. a git worktree at
// ".../chemdraw-structure inspector" — decodes to a real filesystem path instead of a "%20" one
// that ENOENTs at build time.
const workspacePackage = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const gitStampCommandOptions = {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
  timeout: 750
} as const;

// Prefer run-app's single source of truth. Bare Vite commands still derive the checkout label so
// every on-screen build stamp leads with "<worktree> [<branch>]".
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
      // Detached HEAD or no branch: the worktree directory still distinguishes the build.
    }
    return branch && base ? `${base} [${branch}]` : base;
  } catch {
    return "";
  }
}

// Computed once per `vite build` / `vite dev` start, so the on-screen stamp always reflects
// the actual source that was bundled. Format:
// "<worktree [branch]> · YYYY-MM-DD HH:MM:SS <shortSha>[+dirty]".
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

export default defineConfig({
  // SWC React plugin (replaces the Babel one): no 500KB code-generator deopt on the large
  // MainWindow.tsx, and much faster transforms in both dev HMR and production builds.
  plugins: [react()],
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
  }
});
