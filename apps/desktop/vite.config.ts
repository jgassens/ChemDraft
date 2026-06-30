import { execSync } from "node:child_process";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const workspacePackage = (path: string) => new URL(path, import.meta.url).pathname;
const gitStampCommandOptions = {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
  timeout: 750
} as const;

// Computed once per `vite build` / `vite dev` start, so the on-screen stamp always reflects
// the actual source that was bundled. Format: "YYYY-MM-DD HH:MM:SS <shortSha>[+dirty]".
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
  return `${when} ${sha}${dirty}`;
}

export default defineConfig({
  plugins: [react({
    babel: {
      browserslistConfigFile: false
    }
  })],
  define: {
    __BUILD_STAMP__: JSON.stringify(buildStamp())
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
      "@chemdraft/toolset-registry": workspacePackage("../../packages/toolset-registry/src/index.ts"),
      "@chemdraft/shortcut-engine": workspacePackage("../../packages/shortcut-engine/src/index.ts"),
      "@chemdraft/viewport-engine": workspacePackage("../../packages/viewport-engine/src/index.ts")
    }
  }
});
