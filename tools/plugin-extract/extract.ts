/**
 * Extract a bundled ChemDraft plugin into a standalone, host-agnostic **source distribution** zip.
 *
 *   npx tsx tools/plugin-extract/extract.ts <plugin-dir> [--out dist/plugins]
 *   # e.g. npx tsx tools/plugin-extract/extract.ts examples/plugins/nmr-predictor
 *
 * ChemDraft consumes plugins as TypeScript source (the desktop's Vite build transpiles them), so the
 * extraction is a source snapshot — not a prebuilt bundle. The zip contains the plugin's runtime
 * `src/`, a package.json whose only `@chemdraft/*` dependency is the pinned plugin SDK, its docs, and
 * an EXTRACTED.md provenance file. A host installs it by adding the package and registering it (see
 * docs/plugin-architecture/CORE-ENABLEMENT.md).
 *
 * The script REFUSES to package a plugin whose runtime source imports anything outside the SDK
 * (@chemdraft/plugin-api) — the same guarantee tools/plugin-extract/boundary.test.ts enforces in CI.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkPluginBoundary, PLUGIN_SDK_PACKAGE } from "./checkBoundary";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function fail(message: string): never {
  console.error(`extract-plugin: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 ? resolve(args.splice(outIndex, 2)[1] ?? "") : join(repoRoot, "dist/plugins");
const pluginArg = args[0];
if (!pluginArg) {
  fail("usage: extract-plugin <plugin-dir> [--out dist/plugins]");
}
const pluginRoot = resolve(pluginArg);

// 1. Boundary gate — never package a plugin coupled to ChemDraft internals.
const violations = checkPluginBoundary(pluginRoot);
if (violations.length > 0) {
  for (const violation of violations) {
    console.error(`  ${violation.file} imports ${violation.specifier}`);
  }
  fail(`plugin imports outside the SDK (${PLUGIN_SDK_PACKAGE}); refusing to extract.`);
}

// 2. Resolve identity + the SDK contract version to pin against.
const pkg = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8")) as {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  exports?: unknown;
};
const sdkVersion = (() => {
  const source = readFileSync(join(repoRoot, "packages/plugin-api/src/index.ts"), "utf8");
  const match = source.match(/PluginApiVersion\s*=\s*"([^"]+)"/);
  return match ? match[1] : fail("could not read PluginApiVersion from plugin-api");
})();
const gitSha = (() => {
  try {
    return execFileSync("git", ["-C", repoRoot, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();

// 3. Rewrite dependencies: the SDK becomes a pinned semver a host resolves from the core-enablement
// merge; other `@chemdraft/*` deps are dropped (the boundary gate guarantees none are used); external
// deps (openchemlib, zod, …) pass through unchanged.
const rewrittenDeps: Record<string, string> = {};
for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
  if (name === PLUGIN_SDK_PACKAGE) {
    rewrittenDeps[name] = `^${sdkVersion}`;
  } else if (!name.startsWith("@chemdraft/")) {
    rewrittenDeps[name] = range;
  }
}
const extractedPkg = {
  name: pkg.name,
  version: pkg.version,
  private: false,
  type: "module",
  exports: pkg.exports ?? { ".": { types: "./src/index.ts", default: "./src/index.ts" } },
  dependencies: rewrittenDeps,
  peerDependencies: { [PLUGIN_SDK_PACKAGE]: `^${sdkVersion}` },
  chemdraftPlugin: { sdk: PLUGIN_SDK_PACKAGE, sdkVersion, sourceCommit: gitSha }
};

// 4. Stage the distribution: runtime src (no tests) + docs + rewritten manifest + provenance.
const name = basename(pluginRoot);
const staging = join(outDir, name);
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
cpSync(join(pluginRoot, "src"), join(staging, "src"), {
  recursive: true,
  filter: (src) => !/[/\\](tests|__tests__)([/\\]|$)/.test(src) && !/\.test\.tsx?$/.test(src)
});
for (const doc of ["README.md", "THIRD_PARTY_NOTICES.md", "LICENSE", "LICENSE.md"]) {
  try {
    cpSync(join(pluginRoot, doc), join(staging, doc));
  } catch {
    // optional file absent — skip
  }
}
writeFileSync(join(staging, "package.json"), `${JSON.stringify(extractedPkg, null, 2)}\n`);
writeFileSync(
  join(staging, "EXTRACTED.md"),
  [
    `# ${pkg.name} — extracted plugin distribution`,
    "",
    `- Source: ChemDraft monorepo, commit \`${gitSha}\`, plugin \`${name}\``,
    `- Plugin SDK: \`${PLUGIN_SDK_PACKAGE}\` pinned to \`^${sdkVersion}\` (the \`apiVersion\` a host must satisfy)`,
    `- Extracted: ${new Date().toISOString()}`,
    "",
    "This is a **source** distribution. The host bundles the TypeScript in `src/` the same way the",
    "ChemDraft desktop does. The plugin imports only the SDK; to host it, merge the core-enablement",
    "surface described in `docs/plugin-architecture/CORE-ENABLEMENT.md` and register the plugin in",
    "your host's `registerBundledPlugins` equivalent.",
    ""
  ].join("\n")
);

// 5. Zip the staging dir (deterministic file order via -X; provenance travels in EXTRACTED.md).
mkdirSync(outDir, { recursive: true });
const zipPath = join(outDir, `${name}-${pkg.version}.zip`);
rmSync(zipPath, { force: true });
execFileSync("zip", ["-X", "-r", "-q", zipPath, name], { cwd: outDir });
const sha256 = createHash("sha256").update(readFileSync(zipPath)).digest("hex");

console.log(`extracted ${pkg.name}@${pkg.version}`);
console.log(`  boundary: clean (only ${PLUGIN_SDK_PACKAGE})`);
console.log(`  sdk pin : ^${sdkVersion}  source: ${gitSha}`);
console.log(`  zip     : ${zipPath}`);
console.log(`  sha256  : ${sha256}`);
