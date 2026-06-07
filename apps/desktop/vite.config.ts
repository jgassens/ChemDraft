import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const workspacePackage = (path: string) => new URL(path, import.meta.url).pathname;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@chemdraft/chem-core": workspacePackage("../../packages/chem-core/src/index.ts"),
      "@chemdraft/cdx-compat": workspacePackage("../../packages/cdx-compat/src/index.ts"),
      "@chemdraft/export-engine": workspacePackage("../../packages/export-engine/src/index.ts"),
      "@chemdraft/layout-engine": workspacePackage("../../packages/layout-engine/src/index.ts"),
      "@chemdraft/toolset-registry": workspacePackage("../../packages/toolset-registry/src/index.ts"),
      "@chemdraft/shortcut-engine": workspacePackage("../../packages/shortcut-engine/src/index.ts"),
      "@chemdraft/viewport-engine": workspacePackage("../../packages/viewport-engine/src/index.ts")
    }
  }
});
