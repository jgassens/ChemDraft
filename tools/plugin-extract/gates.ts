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
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
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
 * Refuse links and other non-regular filesystem objects in the committed distribution snapshot. The
 * live checkout's `node_modules` is deliberately added only after this gate for package dependency
 * resolution; it is never copied wholesale. A committed link could make `zip` dereference a local
 * secret, so there is no safe distributable interpretation of it.
 */
export function assertRegularDistributionTree(
  pluginRoot: string,
  error: (message: string) => PluginGateError
): void {
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (dir === pluginRoot && entry.name === ".git") {
        continue;
      }
      const full = join(dir, entry.name);
      const pluginRelative = relative(pluginRoot, full);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        throw error(`plugin contains a symbolic link, which cannot be distributed safely: ${pluginRelative}`);
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (!stat.isFile()) {
        throw error(`plugin contains a non-regular filesystem entry, which cannot be distributed safely: ${pluginRelative}`);
      }
    }
  };

  walk(pluginRoot);
}

/**
 * Gate 2 — provenance. The plugin must live in Git with a clean tree, so the commit recorded in the
 * artifact genuinely identifies the source that produced it. A dirty tree would attach a commit that
 * does not describe the shipped bytes, which is worse than no provenance at all.
 */
export function readPluginGitState(
  pluginRoot: string,
  error: (message: string) => PluginGateError
): { sourceCommit: string; repository: string; pathspec: string } {
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

  return { sourceCommit, repository, pathspec };
}

export interface PluginSourceSnapshot {
  /** Plugin root containing only bytes materialized from `sourceCommit`. */
  pluginRoot: string;
  /** Remove the private temporary archive and checkout. Safe to call more than once. */
  dispose(): void;
}

/**
 * Materialize exactly the committed plugin tree, excluding every ignored file by construction.
 *
 * Distribution must not recursively copy the live checkout after recording `sourceCommit`: ignored
 * files are invisible to Git's clean-tree status and could otherwise leak secrets or silently change a
 * Vite bundle. `git archive` gives both tools the committed bytes themselves. The package tool may add
 * a temporary `node_modules` link afterward solely for dependency resolution; that tree is never
 * copied wholesale into either artifact.
 */
export function createPluginSourceSnapshot(
  state: { sourceCommit: string; repository: string; pathspec: string },
  error: (message: string) => PluginGateError
): PluginSourceSnapshot {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "chemdraft-plugin-source-"));
  const archivePath = join(temporaryRoot, "source.tar");
  const archivePrefix = "committed/";
  try {
    execFileSync(
      "git",
      [
        "archive",
        "--format=tar",
        `--prefix=${archivePrefix}`,
        `--output=${archivePath}`,
        state.sourceCommit,
        "--",
        state.pathspec
      ],
      { cwd: state.repository, stdio: ["ignore", "ignore", "pipe"] }
    );
    execFileSync("tar", ["-xf", archivePath, "-C", temporaryRoot], {
      stdio: ["ignore", "ignore", "pipe"]
    });

    const archivedPluginRoot = join(
      temporaryRoot,
      archivePrefix,
      state.pathspec === "." ? "" : state.pathspec
    );
    if (!existsSync(archivedPluginRoot)) {
      throw error("the recorded commit contains no plugin files at the requested path");
    }
    // A sparse checkout may omit a committed link from the live tree that was inspected above; the
    // commit snapshot is the final authority, so vet the materialized distribution tree as well.
    assertRegularDistributionTree(archivedPluginRoot, error);
    return {
      pluginRoot: realpathSync(archivedPluginRoot),
      dispose: () => rmSync(temporaryRoot, { recursive: true, force: true })
    };
  } catch (cause: unknown) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    if (cause instanceof PluginGateError) throw cause;
    throw error(
      `could not materialize the plugin's committed source tree: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }
}

/** Gate 3 — explicit terms. Never build a distributable whose recipient cannot know what they may do
 *  with it. (The file's *contents* are the project owner's call; this only requires that it exists.) */
export function findLicense(pluginRoot: string, error: (message: string) => PluginGateError): string {
  for (const candidate of ["LICENSE", "LICENSE.md"]) {
    if (existsSync(join(pluginRoot, candidate))) return candidate;
  }
  throw error("plugin has no LICENSE or LICENSE.md; refusing to create a distributable archive without explicit terms");
}

/**
 * Directories and extensions that mean "this package ships a dataset".
 *
 * Deliberately narrow. A gate that fired on `.json` would fire on every config in every plugin and be
 * switched off within a week; one that fires on nothing is decoration. These are the shapes a bundled
 * corpus actually takes. A plugin shipping data some other way is still required to declare it — the
 * rule is AGENTS.md §8c — this only catches the common case mechanically.
 */
// "database" was missing while "db" was present — the most natural spelling of the very thing this
// gate exists to catch. Also "fixtures" and "labels", which are what a chemistry plugin actually calls
// a shipped corpus.
const DATA_DIRECTORY_NAMES = new Set([
  "data",
  "datasets",
  "database",
  "databases",
  "db",
  "corpus",
  "corpora",
  "fixtures",
  "labels"
]);
const DATA_FILE_EXTENSIONS = new Set([".csv", ".tsv", ".sqlite", ".sqlite3", ".db", ".parquet", ".arrow"]);
/** Source that happens to live under a data directory. Not a shipped dataset. */
const CODE_FILE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".map", ".md"]);

/** One dataset a plugin ships under terms other than its code licence. */
export interface PluginDataLicense {
  /** What the dataset is, e.g. "nmrshiftdb2-derived 13C shift corpus". */
  name: string;
  /** Its terms, e.g. "nmrshiftdb2 Database License (ODbL-derived)". Free text on purpose: real data
   *  licences frequently have no SPDX identifier, and demanding one would invite a wrong one. */
  license: string;
  /** Where the full terms live — a path inside the package, or a URL. */
  noticeFile?: string;
}

/** Shipped files that look like a bundled dataset, relative to the plugin root. */
export function findBundledDataPaths(pluginRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, insideDataDir: boolean): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
      const full = join(dir, entry);
      // `lstatSync`, so a symlink is inspected rather than followed. `statSync` followed them: a
      // BROKEN symlink crashed the gate with a raw ENOENT instead of a licence verdict, and a
      // symlinked directory could recurse without bound or walk clean outside the plugin root. A
      // symlink is never itself a data file, so skipping is both safe and the honest reading —
      // `assertRegularDistributionTree` is what rejects them, and it should stay the one that does.
      const stats = lstatSync(full);
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        walk(full, insideDataDir || DATA_DIRECTORY_NAMES.has(entry.toLowerCase()));
      } else if (
        // Inside a data directory, only files that look like data. `src/data/parser.ts` is source
        // that happens to live under `data/`, and flagging it taught readers to ignore the gate.
        (insideDataDir && !CODE_FILE_EXTENSIONS.has(extname(entry).toLowerCase())) ||
        DATA_FILE_EXTENSIONS.has(extname(entry).toLowerCase())
      ) {
        out.push(relative(pluginRoot, full));
      }
    }
  };
  walk(pluginRoot, false);
  return out;
}

/**
 * Gate 4 — a bundled dataset may not hide under the code licence (AGENTS.md §8c).
 *
 * The nmrshiftdb2 case is why this exists: a plugin whose code is MIT can ship a database carrying
 * share-alike and attribution obligations the MIT grant does not reach, and a package labelled only
 * "MIT" then tells its recipient something false. The gate is mechanical and therefore modest — it
 * cannot judge whether declared terms are *correct*, only that data is not shipped in silence.
 */
export function assertBundledDataLicensed(
  pluginRoot: string,
  error: (message: string) => PluginGateError
): void {
  const dataPaths = findBundledDataPaths(pluginRoot);
  if (dataPaths.length === 0) return;

  let declared: PluginDataLicense[] = [];
  try {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8")) as {
      dataLicenses?: PluginDataLicense[];
    };
    declared = manifest.dataLicenses ?? [];
  } catch {
    declared = [];
  }

  if (declared.length === 0) {
    const sample = dataPaths.slice(0, 5).join(", ");
    const more = dataPaths.length > 5 ? `, and ${dataPaths.length - 5} more` : "";
    throw error(
      `plugin bundles data (${sample}${more}) but package.json declares no "dataLicenses". A dataset is ` +
        'not covered by the code licence; declare each one as { name, license } (AGENTS.md §8c).'
    );
  }

  const incomplete = declared.filter((entry) => !entry?.name?.trim() || !entry?.license?.trim());
  if (incomplete.length > 0) {
    throw error(`every "dataLicenses" entry needs a non-empty name and license; ${incomplete.length} does not.`);
  }

  // A declared `noticeFile` that is not in the package is an attribution promise the distribution
  // cannot keep — the manifest says "the terms are in this file" and the file ships nowhere. Checked
  // here because this gate is the only thing that reads the field at all.
  const missingNotices = declared
    .map((entry) => entry?.noticeFile?.trim())
    .filter((path): path is string => Boolean(path))
    .filter((path) => !existsSync(join(pluginRoot, path)));
  if (missingNotices.length > 0) {
    throw error(
      `"dataLicenses" names a noticeFile that is not in the package: ${missingNotices.join(", ")}. ` +
        "The attribution it promises would not reach anyone the plugin is distributed to."
    );
  }
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
