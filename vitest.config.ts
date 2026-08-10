import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const workspacePackage = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  define: {
    __BUILD_STAMP__: JSON.stringify("test"),
    __WORKTREE_LABEL__: JSON.stringify("test")
  },
  resolve: {
    alias: {
      "@chemdraft/analysis-core": workspacePackage("./packages/analysis-core/src/index.ts"),
      "@chemdraft/chem-core": workspacePackage("./packages/chem-core/src/index.ts"),
      "@chemdraft/art-engine": workspacePackage("./packages/art-engine/src/index.ts"),
      "@chemdraft/ocl-adapter": workspacePackage("./packages/ocl-adapter/src/index.ts"),
      "@chemdraft/chemistry-adapter": workspacePackage("./packages/chemistry-adapter/src/index.ts"),
      // Mapped explicitly like every sibling. These resolved through the pnpm symlink instead, which
      // works right up until it does not — and left the only two workspace entries in the repo whose
      // resolution took a different path from all the others.
      //
      // SUBPATH FIRST. Vite alias keys are matched as PREFIXES in order, so listing the bare package
      // above `/testing` makes it win and rewrite `@chemdraft/isospec-adapter/testing` to
      // `…/src/index.ts/testing`, which resolves to nothing. Twenty-three suites went red on exactly
      // that before this comment existed.
      "@chemdraft/isospec-adapter/testing": workspacePackage("./packages/isospec-adapter/src/testing.ts"),
      "@chemdraft/isospec-adapter": workspacePackage("./packages/isospec-adapter/src/index.ts"),
      "@chemdraft/cdx-compat": workspacePackage("./packages/cdx-compat/src/index.ts"),
      "@chemdraft/engine3d-api": workspacePackage("./packages/engine3d-api/src/index.ts"),
      "@chemdraft/export-engine/pdf": workspacePackage("./packages/export-engine/src/pdf.ts"),
      "@chemdraft/export-engine": workspacePackage("./packages/export-engine/src/index.ts"),
      "@chemdraft/fixtures": workspacePackage("./packages/fixtures/src/index.ts"),
      "@chemdraft/layout-engine/testing": workspacePackage("./packages/layout-engine/src/testing.ts"),
      "@chemdraft/layout-engine": workspacePackage("./packages/layout-engine/src/index.ts"),
      "@chemdraft/plugin-api": workspacePackage("./packages/plugin-api/src/index.ts"),
      "@chemdraft/plugin-host": workspacePackage("./packages/plugin-host/src/index.ts"),
      "@chemdraft/style-compat": workspacePackage("./packages/style-compat/src/index.ts"),
      "@chemdraft/shortcut-engine": workspacePackage("./packages/shortcut-engine/src/index.ts"),
      "@chemdraft/toolset-registry": workspacePackage("./packages/toolset-registry/src/index.ts"),
      "@chemdraft/viewport-engine": workspacePackage("./packages/viewport-engine/src/index.ts")
    }
  },
  test: {
    environment: "node",
    include: [
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx",
      "packages/**/*.test.ts",
      "examples/plugins/**/*.test.ts",
      "tools/**/*.test.ts"
    ]
  }
});
