/**
 * Extract a bundled ChemDraft plugin into a standalone, host-agnostic source-distribution zip.
 *
 *   pnpm plugin:extract -- <plugin-dir> [--out dist/plugins]
 *
 * The command fails closed when the plugin crosses the SDK boundary, has no explicit license, or
 * contains uncommitted files. A successful archive therefore has a meaningful source commit and
 * carries the terms under which its contents may be distributed.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { checkPluginBoundary, PLUGIN_SDK_PACKAGE } from "./checkBoundary";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

interface PluginPackageJson {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  exports?: unknown;
}

export interface ExtractPluginOptions {
  pluginRoot: string;
  outDir?: string;
  repoRoot?: string;
}

export interface ExtractionResult {
  packageName: string;
  version: string;
  sourceCommit: string;
  sdkVersion: string;
  zipPath: string;
  checksumPath: string;
  sha256: string;
}

export class PluginExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginExtractionError";
  }
}

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
}

/** Resolve symlinked existing ancestors too (macOS exposes `/var` as `/private/var`). */
function canonicalPath(path: string): string {
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

function readPluginGitState(pluginRoot: string): { sourceCommit: string; repository: string } {
  let repository: string;
  let sourceCommit: string;
  try {
    repository = realpathSync(run("git", ["rev-parse", "--show-toplevel"], pluginRoot));
    sourceCommit = run("git", ["rev-parse", "HEAD"], pluginRoot);
  } catch {
    throw new PluginExtractionError("plugin must belong to a Git repository so source provenance can be recorded");
  }

  const pathspec = relative(repository, realpathSync(pluginRoot)) || ".";
  const status = run("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", pathspec], repository);
  if (status) {
    throw new PluginExtractionError(
      `plugin has uncommitted or untracked files; commit or clean them before extracting:\n${status}`
    );
  }
  return { sourceCommit, repository };
}

function sdkVersionFrom(repoRoot: string): string {
  const source = readFileSync(join(repoRoot, "packages/plugin-api/src/index.ts"), "utf8");
  const match = source.match(/PluginApiVersion\s*=\s*"([^"]+)"/);
  if (!match) throw new PluginExtractionError("could not read PluginApiVersion from plugin-api");
  return match[1];
}

function findLicense(pluginRoot: string): string {
  for (const candidate of ["LICENSE", "LICENSE.md"]) {
    if (existsSync(join(pluginRoot, candidate))) return candidate;
  }
  throw new PluginExtractionError(
    "plugin has no LICENSE or LICENSE.md; refusing to create a distributable archive without explicit terms"
  );
}

function externalDependencies(dependencies: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dependencies ?? {}).filter(([name]) => !name.startsWith("@chemdraft/"))
  );
}

function assertSafeDistributionPaths(pluginRoot: string, staging: string, zipPath: string): void {
  const resolvedPlugin = resolve(pluginRoot);
  const resolvedStaging = resolve(staging);
  const stagingToPlugin = relative(resolvedStaging, resolvedPlugin);
  if (
    resolvedStaging === resolvedPlugin ||
    stagingToPlugin === "" ||
    (!stagingToPlugin.startsWith(`..${sep}`) && stagingToPlugin !== "..")
  ) {
    throw new PluginExtractionError("output staging directory must not be the plugin directory or one of its parents");
  }
  if (resolve(zipPath) === resolvedPlugin) {
    throw new PluginExtractionError("output archive path collides with the plugin directory");
  }
}

export function extractPlugin(options: ExtractPluginOptions): ExtractionResult {
  const repoRoot = resolve(options.repoRoot ?? repositoryRoot);
  const pluginRoot = realpathSync(resolve(options.pluginRoot));
  const outDir = canonicalPath(options.outDir ?? join(repoRoot, "dist/plugins"));

  const violations = checkPluginBoundary(pluginRoot);
  if (violations.length > 0) {
    const details = violations.map((violation) => `${violation.file} imports ${violation.specifier}`).join("\n");
    throw new PluginExtractionError(
      `plugin imports outside the SDK (${PLUGIN_SDK_PACKAGE}); refusing to extract:\n${details}`
    );
  }

  const licenseFile = findLicense(pluginRoot);
  const { sourceCommit } = readPluginGitState(pluginRoot);
  const pkg = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8")) as PluginPackageJson;
  if (typeof pkg.name !== "string" || pkg.name.length === 0) {
    throw new PluginExtractionError("plugin package.json must contain a non-empty name");
  }
  if (typeof pkg.version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(pkg.version)) {
    throw new PluginExtractionError("plugin package.json must contain a filename-safe version");
  }

  const name = basename(pluginRoot);
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(name)) {
    throw new PluginExtractionError("plugin directory name must be filename-safe");
  }

  const sdkVersion = sdkVersionFrom(repoRoot);
  const staging = join(outDir, name);
  const zipPath = join(outDir, `${name}-${pkg.version}.zip`);
  const checksumPath = `${zipPath}.sha256`;
  assertSafeDistributionPaths(pluginRoot, staging, zipPath);

  const extractedPkg = {
    name: pkg.name,
    version: pkg.version,
    private: false,
    type: "module",
    exports: pkg.exports ?? { ".": { types: "./src/index.ts", default: "./src/index.ts" } },
    dependencies: externalDependencies(pkg.dependencies),
    optionalDependencies: externalDependencies(pkg.optionalDependencies),
    peerDependencies: {
      ...externalDependencies(pkg.peerDependencies),
      [PLUGIN_SDK_PACKAGE]: `^${sdkVersion}`
    },
    chemdraftPlugin: {
      sdk: PLUGIN_SDK_PACKAGE,
      sdkVersion,
      sourceCommit,
      sourceTree: "clean",
      licenseFile
    }
  };

  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  cpSync(join(pluginRoot, "src"), join(staging, "src"), {
    recursive: true,
    filter: (source) => !/[/\\](tests|__tests__)([/\\]|$)/.test(source) && !/\.test\.tsx?$/.test(source)
  });
  for (const doc of ["README.md", "THIRD_PARTY_NOTICES.md", licenseFile]) {
    if (existsSync(join(pluginRoot, doc))) cpSync(join(pluginRoot, doc), join(staging, doc));
  }
  writeFileSync(join(staging, "package.json"), `${JSON.stringify(extractedPkg, null, 2)}\n`);
  writeFileSync(
    join(staging, "EXTRACTED.md"),
    [
      `# ${pkg.name} — extracted plugin distribution`,
      "",
      `- Source commit: \`${sourceCommit}\` (plugin tree verified clean)`,
      `- Plugin SDK: \`${PLUGIN_SDK_PACKAGE}\` peer \`^${sdkVersion}\``,
      `- License terms: \`${licenseFile}\` (included in this archive)`,
      `- Extracted: ${new Date().toISOString()}`,
      "",
      "This is a **source** distribution. The host bundles the TypeScript in `src/` the same way the",
      "ChemDraft desktop does. The plugin imports only the SDK; to host it, merge the core-enablement",
      "surface described in `docs/plugin-architecture/CORE-ENABLEMENT.md` and register the plugin in",
      "your host's `registerBundledPlugins` equivalent.",
      "",
      "The archive SHA-256 is recorded in the adjacent `.zip.sha256` sidecar.",
      ""
    ].join("\n")
  );

  mkdirSync(outDir, { recursive: true });
  rmSync(zipPath, { force: true });
  rmSync(checksumPath, { force: true });
  execFileSync("zip", ["-X", "-r", "-q", zipPath, name], { cwd: outDir });
  const sha256 = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
  writeFileSync(checksumPath, `${sha256}  ${basename(zipPath)}\n`);

  return {
    packageName: pkg.name,
    version: pkg.version,
    sourceCommit,
    sdkVersion,
    zipPath,
    checksumPath,
    sha256
  };
}

export function parseCliArgs(args: string[]): ExtractPluginOptions {
  const remaining = args[0] === "--" ? args.slice(1) : [...args];
  const outIndex = remaining.indexOf("--out");
  let outDir: string | undefined;
  if (outIndex >= 0) {
    const value = remaining[outIndex + 1];
    if (!value || value.startsWith("--")) {
      throw new PluginExtractionError("--out requires a directory");
    }
    outDir = value;
    remaining.splice(outIndex, 2);
  }
  if (remaining.length !== 1) {
    throw new PluginExtractionError("usage: pnpm plugin:extract -- <plugin-dir> [--out dist/plugins]");
  }
  return { pluginRoot: remaining[0], outDir };
}

function runCli(): void {
  try {
    const result = extractPlugin(parseCliArgs(process.argv.slice(2)));
    console.log(`extracted ${result.packageName}@${result.version}`);
    console.log(`  boundary : clean (only ${PLUGIN_SDK_PACKAGE})`);
    console.log(`  source   : ${result.sourceCommit} (clean)`);
    console.log(`  sdk peer : ^${result.sdkVersion}`);
    console.log(`  zip      : ${result.zipPath}`);
    console.log(`  sha256   : ${result.sha256}`);
    console.log(`  sidecar  : ${result.checksumPath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`extract-plugin: ${message}`);
    process.exitCode = 1;
  }
}

const invokedModule = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedModule === import.meta.url) runCli();
