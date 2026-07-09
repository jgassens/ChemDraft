/// <reference types="vite/client" />

// Injected at build time by vite/vitest `define` (see vite.config.ts buildStamp()).
declare const __BUILD_STAMP__: string;
// Worktree/branch label (e.g. "chemdraw-toolbars [refactor/toolbars]") — set as the window/tab title
// so builds from different worktrees are distinguishable. Empty outside a git checkout.
declare const __WORKTREE_LABEL__: string;

declare module "node:fs" {
  export function readFileSync(path: URL | string, encoding: string): string;
}

declare module "node:child_process" {
  export function execSync(command: string, options?: { encoding?: string }): string;
}

declare module "raphael" {
  const Raphael: unknown;
  export default Raphael;
}
