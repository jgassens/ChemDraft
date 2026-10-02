// What the Node launchers (dev.mjs, desktop-tauri.mjs) share with run-app: the worktree label every
// build carries (AGENTS.md §21.1), the per-worktree dev identifier that keeps a branch build from
// impersonating the stable app (§21.2), and a PATH edit that survives Windows' env-var casing.
import { spawnSync } from "node:child_process";
import { basename, delimiter } from "node:path";
import { STABLE_BUNDLE_ID } from "./app-data-root.mjs";

export const DEV_PRODUCT_NAME = "ChemDraft (dev)";

export function git(rootDir, ...args) {
  const result = spawnSync("git", ["-C", rootDir, ...args], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

// Same slug rule as run-app's RUN_APP_WORKTREE_SLUG.
export function worktreeSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function worktreeIdentity(rootDir) {
  const branch = git(rootDir, "rev-parse", "--abbrev-ref", "HEAD");
  const folder = basename(rootDir);
  return {
    branch,
    label: `${folder}${branch ? ` [${branch}]` : ""}`,
    devBundleId: `${STABLE_BUNDLE_ID}.dev.${worktreeSlug(folder) || "worktree"}`
  };
}

// Prepend `dir` to the search path in a copied environment. Windows names the variable `Path`, and a
// `{ ...process.env }` copy is an ordinary case-sensitive object: assigning `env.PATH` there adds a
// second key holding only `dir`, and the child sees whichever of the two the runtime keeps — which
// can drop the whole original search path (git, node, the MSVC tools).
export function prependToPath(env, dir) {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  env[key] = env[key] ? `${dir}${delimiter}${env[key]}` : dir;
  return env;
}
