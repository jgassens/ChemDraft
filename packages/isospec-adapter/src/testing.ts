import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { setIsoSpecModuleLoader, type IsoSpecModule } from "./index";

/**
 * Point the adapter at the real IsoSpec WASM build under `vendor/`. Node-only.
 *
 * The glue is evaluated in a fresh function scope rather than `require()`d: the package is
 * `"type": "module"`, so Node would treat the vendored `.js` as ESM and its `module.exports =` would
 * never run. Same trap the RDKit loader documents.
 */
export function installRealIsoSpecModuleLoader(): void {
  const glueUrl = new URL("../vendor/IsoSpec.js", import.meta.url);
  const wasmUrl = new URL("../vendor/IsoSpec.wasm", import.meta.url);
  const glueSource = readFileSync(glueUrl, "utf8");
  const wasmBinary = new Uint8Array(readFileSync(wasmUrl));
  const factory = new Function("require", "__dirname", `${glueSource}\n;return initIsoSpecModule;`)(
    createRequire(import.meta.url),
    dirname(fileURLToPath(glueUrl))
  ) as (options: { locateFile: (file: string) => string; wasmBinary: Uint8Array }) => Promise<IsoSpecModule>;
  setIsoSpecModuleLoader(() =>
    factory({
      locateFile: () => fileURLToPath(wasmUrl),
      wasmBinary
    })
  );
}
