import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const workspacePackage = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  define: {
    __BUILD_STAMP__: JSON.stringify("test")
  },
  resolve: {
    alias: {
      "@chemdraft/chem-core": workspacePackage("./packages/chem-core/src/index.ts"),
      "@chemdraft/art-engine": workspacePackage("./packages/art-engine/src/index.ts"),
      "@chemdraft/ocl-adapter": workspacePackage("./packages/ocl-adapter/src/index.ts"),
      "@chemdraft/chemistry-adapter": workspacePackage("./packages/chemistry-adapter/src/index.ts"),
      "@chemdraft/cdx-compat": workspacePackage("./packages/cdx-compat/src/index.ts"),
      "@chemdraft/engine3d-api": workspacePackage("./packages/engine3d-api/src/index.ts"),
      "@chemdraft/fixtures": workspacePackage("./packages/fixtures/src/index.ts"),
      "@chemdraft/style-compat": workspacePackage("./packages/style-compat/src/index.ts"),
      "@chemdraft/shortcut-engine": workspacePackage("./packages/shortcut-engine/src/index.ts")
    }
  },
  test: {
    environment: "node",
    include: [
      "apps/**/*.test.ts",
      "packages/**/*.test.ts",
      "examples/plugins/**/*.test.ts",
      "tools/**/*.test.ts"
    ]
  }
});
