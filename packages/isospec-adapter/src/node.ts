import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  setIsoSpecModuleLoader,
  type IsoSpecModule,
  type IsoSpecModuleLoader
} from "./index";

let realLoader: IsoSpecModuleLoader | undefined;

function cachedRealLoader(): IsoSpecModuleLoader {
  if (realLoader) return realLoader;

  const glueUrl = new URL("../vendor/IsoSpec.js", import.meta.url);
  const wasmUrl = new URL("../vendor/IsoSpec.wasm", import.meta.url);
  const glueSource = readFileSync(glueUrl, "utf8");
  const wasmBinary = new Uint8Array(readFileSync(wasmUrl));
  const factory = new Function("require", "__dirname", `${glueSource}\n;return initIsoSpecModule;`)(
    createRequire(import.meta.url),
    dirname(fileURLToPath(glueUrl))
  ) as (options: {
    locateFile: (file: string) => string;
    wasmBinary: Uint8Array;
  }) => Promise<IsoSpecModule>;

  realLoader = () => factory({
    locateFile: () => fileURLToPath(wasmUrl),
    wasmBinary
  });
  return realLoader;
}

/** Install the vendored IsoSpec WASM loader for Node.js. */
export function installNodeIsoSpecModuleLoader(): void {
  setIsoSpecModuleLoader(cachedRealLoader());
}
