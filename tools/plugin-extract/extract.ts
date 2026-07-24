/**
 * Extract a bundled ChemDraft plugin into a standalone, host-agnostic **source**-distribution zip.
 *
 *   pnpm plugin:extract -- <plugin-dir> [--out dist/plugins]
 *
 * The command fails closed when the plugin crosses the SDK boundary, has no explicit license, or
 * contains uncommitted files. A successful archive therefore has a meaningful source commit and
 * carries the terms under which its contents may be distributed. Those gates are shared with the
 * built-package tool — see `./gates`.
 *
 * This is ADR-0028's artifact, for hosts that compose plugins **at build time**: the recipient bundles
 * the TypeScript in `src/` the way the ChemDraft desktop does. ADR-0029 §5 reverses ADR-0028 §3 only for
 * the *installer* path, and adds `pnpm plugin:package` (`tools/plugin-package/`) alongside this tool —
 * it emits the **built**, installable package a user downloads and the app loads into a Worker. Both
 * remain supported; neither replaces the other.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { isRuntimeTestSourcePath, PLUGIN_SDK_PACKAGE } from "./checkBoundary";
import {
  assertPluginBoundary,
  canonicalPath,
  createPluginSourceSnapshot,
  distributionName,
  findLicense,
  PluginGateError,
  readPluginGitState,
  readPluginPackageJson,
  repositoryRoot,
  sdkVersionFrom
} from "./gates";

export { repositoryRoot };

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

/** A gate (or an extraction-specific check) refused to build the source distribution. */
export class PluginExtractionError extends PluginGateError {
  constructor(message: string) {
    super(message);
    this.name = "PluginExtractionError";
  }
}

const gateError = (message: string): PluginGateError => new PluginExtractionError(message);

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
  const sourcePluginRoot = realpathSync(resolve(options.pluginRoot));
  const outDir = canonicalPath(options.outDir ?? join(repoRoot, "dist/plugins"));

  const gitState = readPluginGitState(sourcePluginRoot, gateError);
  const snapshot = createPluginSourceSnapshot(gitState, gateError);
  try {
    return extractCommittedPlugin(snapshot.pluginRoot, sourcePluginRoot, repoRoot, outDir, gitState.sourceCommit);
  } finally {
    snapshot.dispose();
  }
}

function extractCommittedPlugin(
  pluginRoot: string,
  sourcePluginRoot: string,
  repoRoot: string,
  outDir: string,
  sourceCommit: string
): ExtractionResult {
  assertPluginBoundary(pluginRoot, gateError);
  const licenseFile = findLicense(pluginRoot, gateError);
  const pkg = readPluginPackageJson(pluginRoot, gateError);
  const name = distributionName(sourcePluginRoot, gateError);
  const sdkVersion = sdkVersionFrom(repoRoot, gateError);
  const staging = join(outDir, name);
  const zipPath = join(outDir, `${name}-${pkg.version}.zip`);
  const checksumPath = `${zipPath}.sha256`;
  assertSafeDistributionPaths(sourcePluginRoot, staging, zipPath);

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
    filter: (source) => !/[/\\](tests|__tests__)([/\\]|$)/.test(source) && !isRuntimeTestSourcePath(source)
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
