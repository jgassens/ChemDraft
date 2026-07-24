/**
 * Build a ChemDraft plugin into its **installable package** — the zip a user downloads and the app
 * installs (ADR-0029 §5, M35).
 *
 *   pnpm plugin:package -- <plugin-dir> [--out dist/plugin-packages] [--entry src/workerEntry.ts]
 *
 * This is the *built* distribution. It stands alongside `plugin:extract` (ADR-0028), which remains the
 * **source** distribution for hosts that compose plugins at build time; ADR-0029 reverses ADR-0028 §3
 * only for the installer path. Both tools share the same fail-closed gates (see `../plugin-extract/gates`):
 * SDK boundary clean, Git tree clean, `LICENSE` present.
 *
 * What comes out:
 *
 *   <name>-<version>/            (staged, then zipped flat)
 *   ├── manifest.json            id/name/version/apiVersion/permissions/contributions + built entry
 *   │                            filename + provenance — everything a host needs, no monorepo required
 *   ├── entry.js                 the built ES-module worker entry; calls runPluginWorker()
 *   ├── assets/…, *.js, *.json   whatever chunks/assets the plugin needs, CO-LOCATED
 *   └── LICENSE                  verbatim from the plugin
 *   + <name>-<version>.zip.sha256  integrity only — never a trust gate (ADR-0029 §4)
 *
 * Two build settings are load-bearing rather than stylistic:
 *
 *  - **`worker.format: "es"`** — the default `iife` cannot code-split a worker bundle, and these plugins
 *    force splitting (the NMR plugin spawns a nested OpenChemLib worker; mass analysis uses dynamic
 *    `import()`). This mirrors `apps/desktop/vite.config.ts` (an M34 finding).
 *  - **`base: "./"`** — the decisive one for a *relocatable* package. Under the app's own build
 *    (`base: "/"`) Vite emits absolute references like `new Worker(new URL("/assets/nmrWorker-*.js",
 *    import.meta.url))`, which would resolve against the origin root and miss a package installed
 *    anywhere else. With a relative base every reference becomes
 *    `new URL("assets/nmrWorker-*.js", import.meta.url)` — resolved against the *importing module's own
 *    URL* — so the package works from whatever directory a host stages it into, provided its files stay
 *    co-located and are served from a real (non-blob) URL. See reports/0030 for the evidence.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

// By path, not by package specifier: `tools/` is repo tooling rather than a workspace package, so it has
// no node_modules of its own to resolve `@chemdraft/plugin-api` through. The sibling extractor already
// reaches into this same file by path to read `PluginApiVersion`.
import {
  createPackagedPluginManifestDocument,
  PACKAGED_PLUGIN_MANIFEST_FILE,
  PluginManifestSchema,
  type PluginManifest
} from "../../packages/plugin-api/src/index";
import { isRuntimeSourcePath, PLUGIN_SDK_PACKAGE } from "../plugin-extract/checkBoundary";
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
} from "../plugin-extract/gates";

/** Worker entry a plugin ships to be packageable, relative to its root. */
export const DEFAULT_WORKER_ENTRY = join("src", "workerEntry.ts");
/** Filename of the built worker entry inside the package; recorded as the manifest's `entry`. */
export const PACKAGE_ENTRY_FILENAME = "entry.js";
/** Default output directory — deliberately distinct from `plugin:extract`'s `dist/plugins`. */
export const DEFAULT_OUT_DIR = join("dist", "plugin-packages");

export class PluginPackagingError extends PluginGateError {
  constructor(message: string) {
    super(message);
    this.name = "PluginPackagingError";
  }
}

const gateError = (message: string): PluginGateError => new PluginPackagingError(message);

export interface PackagePluginOptions {
  pluginRoot: string;
  outDir?: string;
  repoRoot?: string;
  /** Worker entry override. Defaults to the plugin's own `src/workerEntry.ts`. */
  entry?: string;
}

export interface PackagedFile {
  /** Package-relative path, POSIX-separated. */
  path: string;
  bytes: number;
}

export interface PackagePluginResult {
  pluginId: string;
  packageName: string;
  version: string;
  sourceCommit: string;
  sdkVersion: string;
  entryFile: string;
  /** Every file in the package, sorted by descending size. */
  files: readonly PackagedFile[];
  /** Total unpacked size. */
  totalBytes: number;
  stagingDir: string;
  zipPath: string;
  zipBytes: number;
  checksumPath: string;
  sha256: string;
}

/**
 * The slice of Vite this tool drives. Vite is not a dependency of the workspace root, so it is resolved
 * from `apps/desktop` (which owns the app's build) and typed structurally here — the unsafe boundary is
 * contained in {@link loadVite} and nothing untyped escapes it.
 */
interface ViteModule {
  version: string;
  build: (config: ViteInlineConfig) => Promise<unknown>;
}

interface ViteInlineConfig {
  configFile: false;
  root: string;
  base: string;
  logLevel: "silent" | "error" | "warn" | "info";
  worker: { format: "es" };
  build: {
    outDir: string;
    emptyOutDir: boolean;
    target: string;
    minify: boolean;
    modulePreload: boolean;
    reportCompressedSize: boolean;
    chunkSizeWarningLimit: number;
    rollupOptions: {
      input: string;
      output: {
        format: "es";
        entryFileNames: string;
        chunkFileNames: string;
        assetFileNames: string;
      };
    };
  };
}

async function loadVite(repoRoot: string): Promise<ViteModule> {
  const requireFromDesktop = createRequire(join(repoRoot, "apps/desktop/package.json"));
  let vitePath: string;
  try {
    vitePath = requireFromDesktop.resolve("vite");
  } catch {
    throw new PluginPackagingError(
      "could not resolve vite from apps/desktop; run `pnpm install` before packaging a plugin"
    );
  }
  return (await import(pathToFileURL(vitePath).href)) as ViteModule;
}

/** The worker entry to bundle: an explicit plugin-relative path, else `src/workerEntry.ts`. */
function resolveWorkerEntry(pluginRoot: string, entry: string | undefined): string {
  const requested = entry ?? DEFAULT_WORKER_ENTRY;
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(pluginRoot, requested);
  if (!existsSync(candidate)) {
    if (entry) throw new PluginPackagingError(`worker entry "${entry}" does not exist`);
  } else {
    const realEntry = realpathSync(candidate);
    if (!contains(join(pluginRoot, "src"), realEntry)) {
      throw new PluginPackagingError("worker entry must be a file inside the plugin's src directory");
    }
    if (!isRuntimeSourcePath(realEntry)) {
      throw new PluginPackagingError(
        "worker entry must use a supported JavaScript or TypeScript extension (.js, .jsx, .mjs, .cjs, .ts, .tsx, .mts, or .cts)"
      );
    }
    return realEntry;
  }

  throw new PluginPackagingError(
    `plugin has no ${DEFAULT_WORKER_ENTRY}, so there is nothing to run in a worker.\n` +
      "A packageable plugin ships a worker entry that calls runPluginWorker() from " +
      `${PLUGIN_SDK_PACKAGE} with its manifest and command handlers — only the plugin knows how to wire ` +
      "its own runtime. Add one, or pass --entry <file> to bundle a different entry."
  );
}

/**
 * The plugin's manifest, read from its own source rather than hand-copied into the tool: import the
 * plugin's index and take the single export that validates as a {@link PluginManifest}. Anything else is
 * ambiguous and refused rather than guessed at.
 */
async function discoverManifest(pluginRoot: string): Promise<PluginManifest> {
  const indexPath = join(pluginRoot, "src", "index.ts");
  if (!existsSync(indexPath)) {
    throw new PluginPackagingError("plugin has no src/index.ts to read its manifest from");
  }

  let exports: Record<string, unknown>;
  try {
    exports = (await import(/* @vite-ignore */ pathToFileURL(indexPath).href)) as Record<string, unknown>;
  } catch (error) {
    throw new PluginPackagingError(
      `could not import the plugin's src/index.ts to read its manifest: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const found = Object.entries(exports).filter(([, value]) => PluginManifestSchema.safeParse(value).success);
  if (found.length === 0) {
    throw new PluginPackagingError("plugin's src/index.ts exports no valid PluginManifest");
  }
  if (found.length > 1) {
    throw new PluginPackagingError(
      `plugin's src/index.ts exports ${found.length} valid PluginManifests (${found
        .map(([name]) => name)
        .join(", ")}); expected exactly one`
    );
  }
  return PluginManifestSchema.parse(found[0][1]);
}

/** Whether `inner` is `outer` or sits underneath it. */
function contains(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Keep staging and the plugin strictly apart, in both directions. Staging is emptied before the build,
 * so a staging directory that *contained* the plugin would delete the source being packaged; and a
 * staging directory *inside* the plugin would spray build output into the plugin's own tree — which the
 * clean-tree gate would then (rightly) refuse on the next run.
 */
function assertSafePackagePaths(pluginRoot: string, staging: string, zipPath: string): void {
  const resolvedPlugin = resolve(pluginRoot);
  const resolvedStaging = resolve(staging);
  if (contains(resolvedStaging, resolvedPlugin)) {
    throw new PluginPackagingError("output staging directory must not be the plugin directory or one of its parents");
  }
  if (contains(resolvedPlugin, resolvedStaging)) {
    throw new PluginPackagingError("output directory must not be inside the plugin directory");
  }
  if (contains(resolvedPlugin, resolve(zipPath))) {
    throw new PluginPackagingError("output archive path must not be inside the plugin directory");
  }
}

/** Every file under `dir`, as package-relative POSIX paths with sizes, largest first. */
function collectFiles(dir: string, prefix = ""): PackagedFile[] {
  const files: PackagedFile[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...collectFiles(full, `${prefix}${entry}/`));
    } else {
      files.push({ path: `${prefix}${entry}`, bytes: stat.size });
    }
  }
  return files.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
}

export async function packagePlugin(options: PackagePluginOptions): Promise<PackagePluginResult> {
  const repoRoot = resolve(options.repoRoot ?? repositoryRoot);
  const sourcePluginRoot = realpathSync(resolve(options.pluginRoot));
  const outDir = canonicalPath(options.outDir ?? join(repoRoot, DEFAULT_OUT_DIR));

  // Resolve only the plugin-relative name here. The committed snapshot below is where existence,
  // extension, symlink, and SDK-boundary checks become authoritative.
  const requestedEntry = options.entry ?? DEFAULT_WORKER_ENTRY;
  const sourceEntry = isAbsolute(requestedEntry)
    ? resolve(requestedEntry)
    : resolve(sourcePluginRoot, requestedEntry);
  if (!contains(join(sourcePluginRoot, "src"), sourceEntry)) {
    throw new PluginPackagingError("worker entry must be a file inside the plugin's src directory");
  }
  const entryRelativeToPlugin = relative(sourcePluginRoot, sourceEntry);

  const gitState = readPluginGitState(sourcePluginRoot, gateError);
  const snapshot = createPluginSourceSnapshot(gitState, gateError);
  try {
    // Dependencies are intentionally the one live, ignored input: package managers install
    // node_modules as a symlink forest, and Vite bundles only dependencies reached by committed
    // source. The directory itself is never copied to staging or the zip.
    const liveDependencies = join(sourcePluginRoot, "node_modules");
    const snapshotDependencies = join(snapshot.pluginRoot, "node_modules");
    if (existsSync(liveDependencies) && !existsSync(snapshotDependencies)) {
      symlinkSync(realpathSync(liveDependencies), snapshotDependencies, "dir");
    }
    return await packageCommittedPlugin(
      snapshot.pluginRoot,
      sourcePluginRoot,
      repoRoot,
      outDir,
      gitState.sourceCommit,
      options.entry === undefined ? undefined : entryRelativeToPlugin
    );
  } finally {
    snapshot.dispose();
  }
}

async function packageCommittedPlugin(
  pluginRoot: string,
  sourcePluginRoot: string,
  repoRoot: string,
  outDir: string,
  sourceCommit: string,
  entryRelativeToPlugin: string | undefined
): Promise<PackagePluginResult> {
  // --- Fail-closed gates, identical to plugin:extract's (ADR-0028 §4) -----------------------------
  assertPluginBoundary(pluginRoot, gateError);
  const licenseFile = findLicense(pluginRoot, gateError);
  const pkg = readPluginPackageJson(pluginRoot, gateError);
  const name = distributionName(sourcePluginRoot, gateError);
  const sdkVersion = sdkVersionFrom(repoRoot, gateError);

  const workerEntry = resolveWorkerEntry(pluginRoot, entryRelativeToPlugin);
  const manifest = await discoverManifest(pluginRoot);

  const staging = join(outDir, `${name}-${pkg.version}`);
  const zipPath = join(outDir, `${name}-${pkg.version}.zip`);
  const checksumPath = `${zipPath}.sha256`;
  assertSafePackagePaths(sourcePluginRoot, staging, zipPath);

  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  const vite = await loadVite(repoRoot);
  await vite.build({
    configFile: false,
    root: repoRoot,
    // Relative base: every emitted reference resolves against the importing module's own URL, so the
    // package is relocatable. See this file's header.
    base: "./",
    logLevel: "silent",
    // ES-module workers: the default iife cannot code-split a worker bundle (M34).
    worker: { format: "es" },
    build: {
      outDir: staging,
      emptyOutDir: true,
      target: "esnext",
      minify: true,
      modulePreload: false,
      reportCompressedSize: false,
      chunkSizeWarningLimit: Number.MAX_SAFE_INTEGER,
      rollupOptions: {
        input: workerEntry,
        output: {
          format: "es",
          entryFileNames: PACKAGE_ENTRY_FILENAME,
          chunkFileNames: "[name]-[hash].js",
          assetFileNames: "[name]-[hash][extname]"
        }
      }
    }
  });

  if (!existsSync(join(staging, PACKAGE_ENTRY_FILENAME))) {
    throw new PluginPackagingError(`the build produced no ${PACKAGE_ENTRY_FILENAME}; the worker entry may be empty`);
  }

  // manifest.json: everything a host needs to identify, permission, and load the plugin — with `entry`
  // repointed at the file we just built, and provenance mirroring EXTRACTED.md.
  const manifestDocument = createPackagedPluginManifestDocument(
    { ...manifest, entry: PACKAGE_ENTRY_FILENAME },
    {
      sdk: PLUGIN_SDK_PACKAGE,
      sdkVersion,
      sourceCommit,
      sourceTree: "clean",
      licenseFile,
      packagedAt: new Date().toISOString()
    }
  );
  writeFileSync(join(staging, PACKAGED_PLUGIN_MANIFEST_FILE), `${JSON.stringify(manifestDocument, null, 2)}\n`);
  cpSync(join(pluginRoot, licenseFile), join(staging, licenseFile));

  mkdirSync(outDir, { recursive: true });
  rmSync(zipPath, { force: true });
  rmSync(checksumPath, { force: true });
  // Flat archive (no wrapping directory): a host unpacks it straight into the plugin's staged directory,
  // where the co-location that makes relative asset URLs resolve is exactly what must be preserved.
  execFileSync("zip", ["-X", "-r", "-q", zipPath, ...readdirSync(staging).sort()], { cwd: staging });

  const zipBytes = statSync(zipPath).size;
  const sha256 = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
  writeFileSync(checksumPath, `${sha256}  ${name}-${pkg.version}.zip\n`);

  const files = collectFiles(staging);
  return {
    pluginId: manifest.id,
    packageName: pkg.name,
    version: pkg.version,
    sourceCommit,
    sdkVersion,
    entryFile: PACKAGE_ENTRY_FILENAME,
    files,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    stagingDir: staging,
    zipPath,
    zipBytes,
    checksumPath,
    sha256
  };
}

export function parseCliArgs(args: string[]): PackagePluginOptions {
  const remaining = args[0] === "--" ? args.slice(1) : [...args];
  const takeFlag = (flag: string): string | undefined => {
    const index = remaining.indexOf(flag);
    if (index < 0) return undefined;
    const value = remaining[index + 1];
    if (!value || value.startsWith("--")) {
      throw new PluginPackagingError(`${flag} requires a value`);
    }
    remaining.splice(index, 2);
    return value;
  };

  const outDir = takeFlag("--out");
  const entry = takeFlag("--entry");
  if (remaining.length !== 1) {
    throw new PluginPackagingError(
      "usage: pnpm plugin:package -- <plugin-dir> [--out dist/plugin-packages] [--entry src/workerEntry.ts]"
    );
  }
  return { pluginRoot: remaining[0], outDir, entry };
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

async function runCli(): Promise<void> {
  try {
    const result = await packagePlugin(parseCliArgs(process.argv.slice(2)));
    console.log(`packaged ${result.packageName}@${result.version} (${result.pluginId})`);
    console.log(`  boundary : clean (only ${PLUGIN_SDK_PACKAGE})`);
    console.log(`  source   : ${result.sourceCommit} (clean)`);
    console.log(`  sdk      : ${result.sdkVersion}`);
    console.log(`  entry    : ${result.entryFile}`);
    console.log(`  layout   : ${result.files.length} files, ${formatBytes(result.totalBytes)} unpacked`);
    for (const file of result.files) {
      console.log(`    ${formatBytes(file.bytes).padStart(9)}  ${file.path}`);
    }
    console.log(`  zip      : ${result.zipPath} (${formatBytes(result.zipBytes)})`);
    console.log(`  sha256   : ${result.sha256}`);
    console.log(`  sidecar  : ${result.checksumPath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`package-plugin: ${message}`);
    process.exitCode = 1;
  }
}

const invokedModule = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedModule === import.meta.url) await runCli();
