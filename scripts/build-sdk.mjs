// Bundling build for the two publishable SDK packages (ADR-0031 / M40).
//
// tsup was the first choice, but its `.d.ts` layer crashes on Node v26 (`renderChunk` TypeError), so the
// build is split across the two tools the repo already trusts:
//   - esbuild bundles the runtime JS (fast, single native binary).
//   - rollup + rollup-plugin-dts bundle the `.d.ts`, INLINING chem-core's types.
//
// chem-core is never a runtime dependency of either published package: for `plugin-api` its use is
// type-only (esbuild erases it; the dts inlines it), and for `plugin-host` its runtime (`applyPatch`) is
// bundled in via an esbuild alias while the shared `ChemDraftDocument` type is kept canonical by taking
// it from `@chemdraft/plugin-api` (external) rather than re-inlining a second copy.
//
// Usage: node scripts/build-sdk.mjs <plugin-api|plugin-host>
import { build as esbuild } from "esbuild";
import { rollup } from "rollup";
import { dts } from "rollup-plugin-dts";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chemCoreSrc = join(root, "packages/chem-core/src/index.ts");

const CONFIGS = {
  "plugin-api": {
    // chem-core is type-only here → esbuild erases the import entirely; only zod stays external.
    jsExternal: ["zod"],
    jsAlias: {},
    // The dts must INLINE chem-core's ChemDraftDocument/DocumentPatch → resolve it via paths, keep it
    // non-external. zod stays external.
    dtsExternal: ["zod"],
    dtsPaths: { "@chemdraft/chem-core": [chemCoreSrc] }
  },
  "plugin-host": {
    // Bundle the chem-core runtime (aliased to source); keep the SDK peer and zod external.
    jsExternal: ["@chemdraft/plugin-api", "zod"],
    jsAlias: { "@chemdraft/chem-core": chemCoreSrc },
    // Inline chem-core's ApplyPatchOptions; @chemdraft/plugin-api (incl. the canonical ChemDraftDocument)
    // and zod remain external imports.
    dtsExternal: ["@chemdraft/plugin-api", "zod"],
    dtsPaths: { "@chemdraft/chem-core": [chemCoreSrc] }
  }
};

const pkg = process.argv[2];
const cfg = CONFIGS[pkg];
if (!cfg) {
  console.error(`build-sdk: unknown package "${pkg}". Expected one of: ${Object.keys(CONFIGS).join(", ")}`);
  process.exit(1);
}

const pkgDir = join(root, "packages", pkg);
const entry = join(pkgDir, "src/index.ts");
const distDir = join(pkgDir, "dist");

async function run() {
  await rm(distDir, { recursive: true, force: true });

  // --- Runtime JS (esbuild) ---------------------------------------------------------------------
  await esbuild({
    entryPoints: [entry],
    outfile: join(distDir, "index.js"),
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: cfg.jsExternal,
    alias: cfg.jsAlias,
    legalComments: "none"
  });

  // --- Bundled declarations (rollup + rollup-plugin-dts) -----------------------------------------
  const bundle = await rollup({
    input: entry,
    external: (id) => cfg.dtsExternal.includes(id),
    plugins: [
      dts({
        respectExternal: false,
        compilerOptions: {
          baseUrl: root,
          paths: cfg.dtsPaths
        }
      })
    ]
  });
  await bundle.write({ file: join(distDir, "index.d.ts"), format: "es" });
  await bundle.close();

  console.log(`build-sdk: built @chemdraft/${pkg} → dist/index.js + dist/index.d.ts`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
