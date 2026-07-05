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

type RdkitFactory = (opts: {
  locateFile: (file: string) => string;
  /** Pre-fetched wasm bytes; when present Emscripten skips its own fetch + instantiateStreaming. */
  wasmBinary?: Uint8Array;
}) => Promise<RdkitMinimalModule>;

let registered = false;

export function registerRdkitWasmLoader(): void {
  if (registered) return;
  registered = true;
  setRdkitModuleLoader(async (): Promise<RdkitMinimalModule> => {
    // The UMD glue declares `var initRDKitModule`; run it in a fresh function scope and
    // return that factory. `module`/`exports`/`define` are undefined here, so the glue's
    // CJS/AMD footer branches are skipped.
    const factory = new Function(`${rdkitGlueSource}\n;return initRDKitModule;`)() as RdkitFactory;
    const locateFile = (file: string): string => (file.endsWith(".wasm") ? rdkitWasmUrl : file);
    // Prefer handing Emscripten the wasm bytes directly via `wasmBinary`. In the packaged Tauri
    // build the conformer worker fetches this over Tauri's custom asset protocol, where
    // `WebAssembly.instantiateStreaming` can reject because the response lacks an
    // `application/wasm` Content-Type (WKWebView enforces this; Chromium dev over http does not),
    // and the glue's streaming→ArrayBuffer fallback has proven unreliable there. Fetching the
    // bytes ourselves and passing them in skips streaming entirely. If the fetch itself fails we
    // fall through to the glue's own loading path, so this never makes loading worse.
    try {
      const response = await fetch(rdkitWasmUrl);
      if (response.ok) {
        const wasmBinary = new Uint8Array(await response.arrayBuffer());
        return await factory({ wasmBinary, locateFile });
      }
    } catch {
      /* fall through to the glue's built-in fetch/streaming path */
    }
    return factory({ locateFile });
  });
}
