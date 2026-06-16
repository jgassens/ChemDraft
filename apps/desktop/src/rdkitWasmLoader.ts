/**
 * Registers the custom RDKit MinimalLib WASM (vendored — see
 * packages/rdkit-adapter/vendor/BUILD.md) as the RDKit module loader, so the conformer
 * worker can embed with ETKDGv3 (the fast Spin 3D engine).
 *
 * The vendored glue is a UMD Emscripten module that declares `var initRDKitModule` (no ESM
 * syntax). We inline its source via Vite's `?raw` and evaluate it in a fresh function scope
 * to obtain that factory — a module worker can't `importScripts`, and CSP is `null` in this
 * app so eval-class loading is allowed. The factory is called with an explicit `locateFile`
 * pointing at the hashed `.wasm` asset URL Vite emits via `?url`.
 */
import { setRdkitModuleLoader, type RdkitMinimalModule } from "@chemdraft/rdkit-adapter";
import rdkitGlueSource from "../node_modules/@chemdraft/rdkit-adapter/vendor/RDKit_minimal.js?raw";
import rdkitWasmUrl from "../node_modules/@chemdraft/rdkit-adapter/vendor/RDKit_minimal.wasm?url";

type RdkitFactory = (opts: { locateFile: (file: string) => string }) => Promise<RdkitMinimalModule>;

let registered = false;

export function registerRdkitWasmLoader(): void {
  if (registered) return;
  registered = true;
  setRdkitModuleLoader(async (): Promise<RdkitMinimalModule> => {
    // The UMD glue declares `var initRDKitModule`; run it in a fresh function scope and
    // return that factory. `module`/`exports`/`define` are undefined here, so the glue's
    // CJS/AMD footer branches are skipped.
    const factory = new Function(`${rdkitGlueSource}\n;return initRDKitModule;`)() as RdkitFactory;
    return factory({ locateFile: (file) => (file.endsWith(".wasm") ? rdkitWasmUrl : file) });
  });
}
