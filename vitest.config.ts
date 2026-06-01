import { defineConfig } from "vitest/config";

const workspacePackage = (path: string) => new URL(path, import.meta.url).pathname;

export default defineConfig({
  resolve: {
    alias: {
      "@chemdraft/shortcut-engine": workspacePackage("./packages/shortcut-engine/src/index.ts")
    }
  },
  test: {
    environment: "node",
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts", "examples/plugins/**/*.test.ts"]
  }
});
