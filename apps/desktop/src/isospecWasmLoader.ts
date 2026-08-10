/**
 * Registers the vendored IsoSpec WASM (see packages/isospec-adapter/vendor/BUILD.md) as the isotope
 * engine, so the analysis worker can compute isotope envelopes.
 *
 * Mirrors `rdkitWasmLoader.ts` exactly, and for the same reasons: the glue is a UMD Emscripten module
 * declaring `var initIsoSpecModule` with no ESM syntax, so it is inlined via Vite's `?raw` and
 * evaluated in a fresh function scope to obtain the factory. The `.wasm` comes from `?url`, and the
 * bytes are fetched up front because `WebAssembly.instantiateStreaming` rejects in the packaged Tauri
 * build where the asset protocol serves no `application/wasm` Content-Type.
 *
 * At 234 KB this is a thirtieth of the RDKit artifact, and `ensureIsoSpec` memoises, so a session pays
 * for it once and only if something asks for an envelope.
 */
import { setIsoSpecModuleLoader, type IsoSpecModule } from "@chemdraft/isospec-adapter";
import isospecGlueSource from "../node_modules/@chemdraft/isospec-adapter/vendor/IsoSpec.js?raw";
import isospecWasmUrl from "../node_modules/@chemdraft/isospec-adapter/vendor/IsoSpec.wasm?url";

type IsoSpecFactory = (opts: {
  locateFile: (file: string) => string;
  wasmBinary?: Uint8Array;
}) => Promise<IsoSpecModule>;

let registered = false;

export function registerIsoSpecWasmLoader(): void {
  if (registered) return;
  registered = true;
  setIsoSpecModuleLoader(async (): Promise<IsoSpecModule> => {
    const factory = new Function(`${isospecGlueSource}\n;return initIsoSpecModule;`)() as IsoSpecFactory;
    const locateFile = (file: string): string => (file.endsWith(".wasm") ? isospecWasmUrl : file);
    try {
      const response = await fetch(isospecWasmUrl);
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
