/**
 * The fail-closed gates every ChemDraft plugin distribution must pass, shared by both distribution
 * tools (ADR-0028 §4, ADR-0029 §5):
 *
 *   - `plugin:extract` — the **source**-distribution zip (ADR-0028), for hosts that compose plugins
 *     at build time;
 *   - `plugin:package` — the **built**, installable package (ADR-0029/M35), the zip a user downloads.
 *
 * Both refuse to emit an artifact unless the plugin (1) stays inside the SDK boundary, (2) has a
 * committed, clean source tree so its recorded provenance commit actually describes its contents, and
 * (3) carries explicit license terms. These live here rather than in either tool so the two cannot
 * drift into disagreeing about what a distributable plugin is.
 *
 * The gates are integrity/provenance checks, not a trust decision: ADR-0029 is deliberately permissive,
 * and nothing here adjudicates whether a plugin *should* be trusted.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkPluginBoundary, PLUGIN_SDK_PACKAGE } from "./checkBoundary";

/** Repository root, resolved from this file's location (`tools/plugin-extract/`). */
export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

/** A distribution gate refused the plugin. Subclassed per tool so each reports in its own vocabulary. */
export class PluginGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginGateError";
  }
}

export interface PluginPackageJson {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  exports?: unknown;
}

export function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
}

/** Resolve symlinked existing ancestors too (macOS exposes `/var` as `/private/var`). */
export function canonicalPath(path: string): string {
  let existing = resolve(path);
  const missingSegments: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missingSegments.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync(existing), ...missingSegments);
}

/**
 * Gate 1 — the SDK boundary (ADR-0028 §1). A plugin's shipped runtime source may import only
 * `@chemdraft/plugin-api`. Refusing here is what keeps a distributed plugin loadable outside this
 * monorepo at all: a reach into `chem-core`/`plugin-host`/… would simply not resolve in a host that
 * has only the SDK.
 */
export function assertPluginBoundary(pluginRoot: string, error: (message: string) => PluginGateError): void {
  const violations = checkPluginBoundary(pluginRoot);
  if (violations.length > 0) {
    const details = violations.map((violation) => `${violation.file} imports ${violation.specifier}`).join("\n");
    throw error(`plugin imports outside the SDK (${PLUGIN_SDK_PACKAGE}); refusing to build a distribution:\n${details}`);
  }
}

/**
 * Gate 2 — provenance. The plugin must live in Git with a clean tree, so the commit recorded in the
 * artifact genuinely identifies the source that produced it. A dirty tree would attach a commit that
 * does not describe the shipped bytes, which is worse than no provenance at all.
 */
export function readPluginGitState(
  pluginRoot: string,
  error: (message: string) => PluginGateError
): { sourceCommit: string; repository: string } {
  let repository: string;
  let sourceCommit: string;
  try {
    repository = realpathSync(run("git", ["rev-parse", "--show-toplevel"], pluginRoot));
    sourceCommit = run("git", ["rev-parse", "HEAD"], pluginRoot);
  } catch {
    throw error("plugin must belong to a Git repository so source provenance can be recorded");
  }

  const pathspec = relative(repository, realpathSync(pluginRoot)) || ".";
  const status = run("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", pathspec], repository);
  if (status) {
    throw error(`plugin has uncommitted or untracked files; commit or clean them before distributing:\n${status}`);
  }
  return { sourceCommit, repository };
}

/** Gate 3 — explicit terms. Never build a distributable whose recipient cannot know what they may do
 *  with it. (The file's *contents* are the project owner's call; this only requires that it exists.) */
export function findLicense(pluginRoot: string, error: (message: string) => PluginGateError): string {
  for (const candidate of ["LICENSE", "LICENSE.md"]) {
    if (existsSync(join(pluginRoot, candidate))) return candidate;
  }
  throw error("plugin has no LICENSE or LICENSE.md; refusing to create a distributable archive without explicit terms");
}

/** The SDK version a distribution records as its peer/host requirement. */
export function sdkVersionFrom(repoRoot: string, error: (message: string) => PluginGateError): string {
  const source = readFileSync(join(repoRoot, "packages/plugin-api/src/index.ts"), "utf8");
  const match = source.match(/PluginApiVersion\s*=\s*"([^"]+)"/);
  if (!match) throw error("could not read PluginApiVersion from plugin-api");
  return match[1];
}

/** The plugin's `package.json`, with the identity fields both tools put into filenames validated. */
export function readPluginPackageJson(pluginRoot: string, error: (message: string) => PluginGateError): PluginPackageJson {
  const pkg = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8")) as PluginPackageJson;
  if (typeof pkg.name !== "string" || pkg.name.length === 0) {
    throw error("plugin package.json must contain a non-empty name");
  }
  if (typeof pkg.version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(pkg.version)) {
    throw error("plugin package.json must contain a filename-safe version");
  }
  return pkg;
}

/** The distribution's base filename, taken from the plugin directory and validated as filename-safe. */
export function distributionName(pluginRoot: string, error: (message: string) => PluginGateError): string {
  const name = basename(pluginRoot);
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(name)) {
    throw error("plugin directory name must be filename-safe");
  }
  return name;
}
